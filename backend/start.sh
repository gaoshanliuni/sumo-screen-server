#!/usr/bin/env bash
set -Eeuo pipefail

log() {
  printf '[start.sh] %s\n' "$*"
}

switch_apt_mirror() {
  if ! command -v apt-get >/dev/null 2>&1; then
    return
  fi

  if [[ "$(id -u)" -ne 0 ]]; then
    log "skip apt mirror switch: root privileges are required"
    return
  fi

  local mirror_base="${APT_MIRROR_BASE:-https://mirrors.tuna.tsinghua.edu.cn}"
  local os_id=""
  local codename="bookworm"

  if [[ -f /etc/os-release ]]; then
    # shellcheck disable=SC1091
    . /etc/os-release
    os_id="${ID:-}"
    codename="${VERSION_CODENAME:-$codename}"
  fi

  if [[ "${os_id}" != "debian" && -n "${os_id}" ]]; then
    log "skip apt mirror switch: unsupported distro id=${os_id}"
    return
  fi

  local deb822_file="/etc/apt/sources.list.d/debian.sources"
  local legacy_file="/etc/apt/sources.list"

  if [[ -f "${deb822_file}" ]]; then
    if grep -q "${mirror_base}/debian" "${deb822_file}" 2>/dev/null && \
       grep -q "${mirror_base}/debian-security" "${deb822_file}" 2>/dev/null; then
      log "apt mirror already configured: ${mirror_base}"
      return
    fi

    cp "${deb822_file}" "${deb822_file}.bak.$(date +%s)" || true
    cat > "${deb822_file}" <<EOF
Types: deb
URIs: ${mirror_base}/debian
Suites: ${codename} ${codename}-updates
Components: main contrib non-free non-free-firmware
Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg

Types: deb
URIs: ${mirror_base}/debian-security
Suites: ${codename}-security
Components: main contrib non-free non-free-firmware
Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg
EOF
  else
    if [[ -f "${legacy_file}" ]] && \
       grep -q "${mirror_base}/debian" "${legacy_file}" 2>/dev/null && \
       grep -q "${mirror_base}/debian-security" "${legacy_file}" 2>/dev/null; then
      log "apt mirror already configured: ${mirror_base}"
      return
    fi

    cp "${legacy_file}" "${legacy_file}.bak.$(date +%s)" 2>/dev/null || true
    cat > "${legacy_file}" <<EOF
deb ${mirror_base}/debian ${codename} main contrib non-free non-free-firmware
deb ${mirror_base}/debian ${codename}-updates main contrib non-free non-free-firmware
deb ${mirror_base}/debian-security ${codename}-security main contrib non-free non-free-firmware
EOF
  fi

  log "apt mirror switched to ${mirror_base}"
}

APP_DIR=""
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "${SCRIPT_DIR}/package.json" ]]; then
  APP_DIR="${SCRIPT_DIR}"
elif [[ -f "/app/backend/package.json" ]]; then
  APP_DIR="/app/backend"
elif [[ -f "/app/package.json" ]]; then
  APP_DIR="/app"
else
  log "ERROR: cannot find package.json in ${SCRIPT_DIR}, /app/backend, or /app"
  exit 1
fi

cd "${APP_DIR}"
log "APP_DIR=${APP_DIR}"

has_shared_lib() {
  local lib_name="$1"

  if command -v ldconfig >/dev/null 2>&1; then
    if ldconfig -p 2>/dev/null | grep -Fq "${lib_name}"; then
      return 0
    fi
  fi

  if find /lib /usr/lib /usr/local/lib \
      \( -type f -o -type l \) \
      2>/dev/null | grep -Eq "/${lib_name}([./].*)?$"; then
    return 0
  fi

  return 1
}

has_required_runtime_libs() {
  local missing=0
  local lib
  local required_libs=(
    libnspr4.so
    libnss3.so
    libatk-1.0.so.0
    libatk-bridge-2.0.so.0
    libcups.so.2
    libdrm.so.2
    libxkbcommon.so.0
    libXcomposite.so.1
    libXdamage.so.1
    libXfixes.so.3
    libXrandr.so.2
    libgbm.so.1
    libasound.so.2
    libgtk-3.so.0
    libpango-1.0.so.0
    libcairo.so.2
    libatspi.so.0
    libX11.so.6
    libxcb.so.1
    libXext.so.6
    libXrender.so.1
  )

  for lib in "${required_libs[@]}"; do
    if ! has_shared_lib "${lib}"; then
      log "missing shared library: ${lib}"
      missing=1
    fi
  done

  [[ "${missing}" -eq 0 ]]
}

find_browser_bin() {
  find "${APP_DIR}/.local-browser" -type f \
    \( -name chrome -o -name chromium -o -name chromium-browser -o -name msedge -o -name microsoft-edge \) \
    -perm -111 2>/dev/null | head -n 1
}

browser_binary_is_usable() {
  local browser_bin="${1:-}"

  [[ -n "${browser_bin}" && -x "${browser_bin}" ]] || return 1

  if command -v ldd >/dev/null 2>&1; then
    if ldd "${browser_bin}" 2>/dev/null | grep -Fq 'not found'; then
      return 1
    fi
  fi

  return 0
}

ensure_system_packages() {
  local deps_marker=".pw_deps_ok_v3"
  local need_install=0
  local browser_bin=""

  if [[ -f "${deps_marker}" ]]; then
    if ! has_required_runtime_libs; then
      log "runtime dependency check failed; reinstalling system packages"
      need_install=1
    else
      browser_bin="$(find_browser_bin || true)"
      if [[ -n "${browser_bin}" ]] && ! browser_binary_is_usable "${browser_bin}"; then
        log "existing chromium has unresolved linked libraries; reinstalling system packages"
        need_install=1
      fi
    fi
  else
    need_install=1
  fi

  if [[ "${need_install}" -eq 0 ]]; then
    log "runtime dependency check passed"
    return
  fi

  rm -f "${deps_marker}"

  if [[ "$(id -u)" -ne 0 ]]; then
    log "ERROR: root privileges are required to install runtime system packages"
    exit 1
  fi

  log "installing runtime system packages"
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y \
      python3-venv python3-pip curl ca-certificates unzip \
      libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
      libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
      libgbm1 libasound2 libxshmfence1 libgtk-3-0 libpango-1.0-0 libcairo2 libatspi2.0-0 \
      libx11-6 libxcb1 libxext6 libxrender1 \
      fontconfig fonts-noto-cjk fonts-noto-core fonts-wqy-zenhei
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y \
      python3 python3-pip python3-virtualenv curl ca-certificates unzip \
      nspr nss atk at-spi2-atk at-spi2-core cups-libs libdrm libxkbcommon \
      libXcomposite libXdamage libXfixes libXrandr mesa-libgbm alsa-lib \
      gtk3 pango cairo at-spi2-core libX11 libX11-xcb libxcb libXext libXrender fontconfig
    dnf install -y google-noto-sans-cjk-ttc-fonts google-noto-cjk-fonts wqy-zenhei-fonts || true
  elif command -v yum >/dev/null 2>&1; then
    yum install -y \
      python3 python3-pip python3-virtualenv curl ca-certificates unzip \
      nspr nss atk at-spi2-atk at-spi2-core cups-libs libdrm libxkbcommon \
      libXcomposite libXdamage libXfixes libXrandr mesa-libgbm alsa-lib \
      gtk3 pango cairo at-spi2-core libX11 libX11-xcb libxcb libXext libXrender fontconfig
    yum install -y google-noto-sans-cjk-ttc-fonts google-noto-cjk-fonts wqy-zenhei-fonts || true
  else
    log "ERROR: unsupported package manager (need apt-get/dnf/yum)"
    exit 1
  fi

  command -v ldconfig >/dev/null 2>&1 && ldconfig || true
  fc-cache -f >/dev/null 2>&1 || true

  if ! has_required_runtime_libs; then
    log "runtime dependency validation still has missing items after install"
    log "dumping likely libXshmfence locations for diagnostics"
    find /lib /usr/lib /usr/local/lib -name 'libXshmfence.so*' 2>/dev/null || true
    log "ERROR: runtime dependency validation failed after install"
    exit 1
  fi

  touch "${deps_marker}"
}

hash_file_sha256() {
  local target="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "${target}" | awk '{print $1}'
    return
  fi
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "${target}" | awk '{print $1}'
    return
  fi
  python3 - <<'PY' "${target}"
import hashlib, pathlib, sys
p = pathlib.Path(sys.argv[1])
print(hashlib.sha256(p.read_bytes()).hexdigest())
PY
}

ensure_node_modules() {
  if [[ ! -f "node_modules/playwright-core/cli.js" ]]; then
    log "installing node modules"
    npm ci --omit=dev
  fi
}

ensure_python_venv() {
  if [[ ! -x ".venv/bin/python" ]]; then
    log "creating python venv"
    python3 -m venv .venv || python3 -m virtualenv .venv
  fi
}

ensure_ocr_requirements() {
  local req_file="tools/ocr/requirements.txt"
  if [[ ! -f "${req_file}" ]]; then
    log "ERROR: missing ${req_file}"
    exit 1
  fi

  local req_hash_file=".venv/.ocr_requirements.sha256"
  local new_hash
  new_hash="$(hash_file_sha256 "${req_file}")"
  local old_hash=""
  if [[ -f "${req_hash_file}" ]]; then
    old_hash="$(cat "${req_hash_file}" 2>/dev/null || true)"
  fi

  if [[ "${new_hash}" != "${old_hash}" ]]; then
    log "installing/updating OCR python dependencies"
    .venv/bin/python -m pip install --upgrade pip
    .venv/bin/python -m pip install -r "${req_file}"
    printf '%s' "${new_hash}" > "${req_hash_file}"
  fi
}

ensure_local_browser() {
  local browser_bin
  browser_bin="$(find_browser_bin || true)"

  if [[ -n "${browser_bin}" ]] && ! browser_binary_is_usable "${browser_bin}"; then
    log "existing chromium binary is broken or still missing linked libraries; reinstalling browser"
    rm -rf "${APP_DIR}/.local-browser"
    browser_bin=""
  fi

  if [[ -z "${browser_bin}" ]]; then
    log "installing playwright chromium to ${APP_DIR}/.local-browser"
    PLAYWRIGHT_BROWSERS_PATH="${APP_DIR}/.local-browser" node ./node_modules/playwright-core/cli.js install chromium
    browser_bin="$(find_browser_bin || true)"
  fi

  if [[ -z "${browser_bin}" ]]; then
    log "ERROR: chromium install failed"
    exit 1
  fi

  if ! browser_binary_is_usable "${browser_bin}"; then
    log "ERROR: chromium exists but linked libraries are still unresolved"
    if command -v ldd >/dev/null 2>&1; then
      ldd "${browser_bin}" || true
    fi
    exit 1
  fi

  export PLAYWRIGHT_BROWSERS_PATH="${APP_DIR}/.local-browser"
  export PLAYWRIGHT_CHROMIUM_PATH="${browser_bin}"
  export CHROME_PATH="${browser_bin}"
  export CHROME_BIN="${browser_bin}"
  log "chromium=${browser_bin}"
}

export_runtime_env() {
  export XIQUE_OCR_ENABLED="${XIQUE_OCR_ENABLED:-1}"
  export XIQUE_OCR_PYTHON_BIN="${XIQUE_OCR_PYTHON_BIN:-${APP_DIR}/.venv/bin/python}"
  export XIQUE_OCR_AUTO_SETUP="${XIQUE_OCR_AUTO_SETUP:-0}"
  export PAGE_RENDER_BROWSER_STRICT="${PAGE_RENDER_BROWSER_STRICT:-0}"
  export PAGE_RENDER_BROWSER_LAUNCH_TIMEOUT_MS="${PAGE_RENDER_BROWSER_LAUNCH_TIMEOUT_MS:-6000}"
  export PAGE_RENDER_BROWSER_TOTAL_TIMEOUT_MS="${PAGE_RENDER_BROWSER_TOTAL_TIMEOUT_MS:-12000}"
  export PAGE_RENDER_BROWSER_MAX_CANDIDATES="${PAGE_RENDER_BROWSER_MAX_CANDIDATES:-1}"

  if [[ -z "${PUBLIC_ORIGIN:-}" ]]; then
    log "PUBLIC_ORIGIN is not set (recommended for HTTPS/WSS reverse proxy)"
  fi
}

switch_apt_mirror
ensure_system_packages
ensure_node_modules
ensure_python_venv
ensure_ocr_requirements
ensure_local_browser
export_runtime_env

log "starting backend server"
exec npm run start