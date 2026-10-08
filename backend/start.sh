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

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

resolve_app_dir() {
  if [[ -f "${SCRIPT_DIR}/package.json" ]]; then
    printf '%s\n' "${SCRIPT_DIR}"
    return 0
  fi

  if [[ -f "/app/backend/package.json" ]]; then
    printf '%s\n' "/app/backend"
    return 0
  fi

  if [[ -f "/app/package.json" ]]; then
    printf '%s\n' "/app"
    return 0
  fi

  printf '[start.sh] ERROR: cannot find package.json in %s, /app/backend, or /app\n' "${SCRIPT_DIR}" >&2
  return 1
}

APP_DIR="${START_SH_APP_DIR:-}"
if [[ -z "${APP_DIR}" ]]; then
  APP_DIR="$(resolve_app_dir)" || exit 1
fi

runtime_lib_package_specs() {
  cat <<'EOF'
libnspr4.so|libnspr4|nspr
libnss3.so|libnss3|nss
libatk-1.0.so.0|libatk1.0-0|atk
libatk-bridge-2.0.so.0|libatk-bridge2.0-0|at-spi2-atk
libcups.so.2|libcups2|cups-libs
libdrm.so.2|libdrm2|libdrm
libxkbcommon.so.0|libxkbcommon0|libxkbcommon
libXcomposite.so.1|libxcomposite1|libXcomposite
libXdamage.so.1|libxdamage1|libXdamage
libXfixes.so.3|libxfixes3|libXfixes
libXrandr.so.2|libxrandr2|libXrandr
libgbm.so.1|libgbm1|mesa-libgbm
libasound.so.2|libasound2|alsa-lib
libgtk-3.so.0|libgtk-3-0|gtk3
libpango-1.0.so.0|libpango-1.0-0|pango
libcairo.so.2|libcairo2|cairo
libatspi.so.0|libatspi2.0-0|at-spi2-core
libX11.so.6|libx11-6|libX11
libxcb.so.1|libxcb1|libxcb
libXext.so.6|libxext6|libXext
libXrender.so.1|libxrender1|libXrender
libXshmfence.so.1|libxshmfence1|libxshmfence
EOF
}

required_runtime_libs() {
  runtime_lib_package_specs | awk -F'|' '{print $1}'
}

runtime_lib_search_dirs() {
  local dirs=()
  local dir

  if [[ -n "${RUNTIME_LIB_SEARCH_DIRS:-}" ]]; then
    IFS=':' read -r -a dirs <<< "${RUNTIME_LIB_SEARCH_DIRS}"
  else
    dirs=(/lib /lib64 /usr/lib /usr/lib64 /usr/local/lib)
    if [[ -n "${APP_DIR:-}" ]]; then
      dirs+=("${APP_DIR}/.local-browser")
    fi
  fi

  for dir in "${dirs[@]}"; do
    if [[ -n "${dir}" && -d "${dir}" ]]; then
      printf '%s\n' "${dir}"
    fi
  done
}

ldconfig_has_shared_lib() {
  local lib_name="$1"

  if ! command -v ldconfig >/dev/null 2>&1; then
    return 1
  fi

  ldconfig -p 2>/dev/null | awk -v lib="${lib_name}" '$1 == lib { found = 1 } END { exit found ? 0 : 1 }'
}

find_shared_lib_file() {
  local lib_name="$1"
  local dirs=()
  local dir
  local found=""

  while IFS= read -r dir; do
    dirs+=("${dir}")
  done < <(runtime_lib_search_dirs)

  if [[ "${#dirs[@]}" -eq 0 ]]; then
    return 1
  fi

  found="$(
    find "${dirs[@]}" \
      \( -type f -o -type l \) \
      \( -name "${lib_name}" -o -name "${lib_name}.*" \) \
      -print -quit 2>/dev/null || true
  )"

  [[ -n "${found}" ]]
}

package_file_list_has_lib() {
  local lib_name="$1"
  local path
  local base

  while IFS= read -r path; do
    base="${path##*/}"
    if [[ "${base}" == "${lib_name}" || "${base}" == "${lib_name}".* ]]; then
      return 0
    fi
  done

  return 1
}

debian_package_has_shared_lib() {
  local pkg="$1"
  local lib_name="$2"

  if ! command -v dpkg-query >/dev/null 2>&1; then
    return 1
  fi

  if ! dpkg-query -W -f='${Status}' "${pkg}" 2>/dev/null | grep -q 'install ok installed'; then
    return 1
  fi

  dpkg-query -L "${pkg}" 2>/dev/null | package_file_list_has_lib "${lib_name}"
}

rpm_package_has_shared_lib() {
  local pkg="$1"
  local lib_name="$2"

  if ! command -v rpm >/dev/null 2>&1; then
    return 1
  fi

  if ! rpm -q "${pkg}" >/dev/null 2>&1; then
    return 1
  fi

  rpm -ql "${pkg}" 2>/dev/null | package_file_list_has_lib "${lib_name}"
}

package_has_shared_lib() {
  local lib_name="$1"
  local spec_lib
  local deb_pkg
  local rpm_pkg

  while IFS='|' read -r spec_lib deb_pkg rpm_pkg; do
    if [[ "${spec_lib}" != "${lib_name}" ]]; then
      continue
    fi

    if debian_package_has_shared_lib "${deb_pkg}" "${lib_name}"; then
      return 0
    fi

    if rpm_package_has_shared_lib "${rpm_pkg}" "${lib_name}"; then
      return 0
    fi

    return 1
  done < <(runtime_lib_package_specs)

  return 1
}

has_shared_lib() {
  local lib_name="$1"

  if ldconfig_has_shared_lib "${lib_name}"; then
    return 0
  fi

  if find_shared_lib_file "${lib_name}"; then
    return 0
  fi

  package_has_shared_lib "${lib_name}"
}

has_required_runtime_libs() {
  local missing=0
  local lib

  while IFS= read -r lib; do
    if ! has_shared_lib "${lib}"; then
      log "missing shared library: ${lib}"
      missing=1
    fi
  done < <(required_runtime_libs)

  [[ "${missing}" -eq 0 ]]
}

find_browser_bin() {
  if [[ ! -d "${APP_DIR}/.local-browser" ]]; then
    return 1
  fi

  find "${APP_DIR}/.local-browser" -type f \
    \( -name chrome -o -name chromium -o -name chromium-browser -o -name msedge -o -name microsoft-edge \) \
    -perm -111 2>/dev/null | head -n 1
}

browser_link_report() {
  local browser_bin="${1:-}"

  if [[ -z "${browser_bin}" || ! -x "${browser_bin}" ]]; then
    printf 'browser binary is missing or not executable: %s\n' "${browser_bin}"
    return 0
  fi

  if ! command -v ldd >/dev/null 2>&1; then
    return 0
  fi

  ldd "${browser_bin}" 2>&1 || true
}

browser_binary_is_usable() {
  local browser_bin="${1:-}"
  local ldd_output=""

  [[ -n "${browser_bin}" && -x "${browser_bin}" ]] || return 1

  if command -v ldd >/dev/null 2>&1; then
    ldd_output="$(ldd "${browser_bin}" 2>&1 || true)"
    if printf '%s\n' "${ldd_output}" | grep -Eq 'not found|No such file|not a dynamic executable'; then
      return 1
    fi
  fi

  return 0
}

runtime_dependency_validation_passes() {
  local browser_bin=""

  browser_bin="$(find_browser_bin || true)"
  if [[ -n "${browser_bin}" ]]; then
    browser_binary_is_usable "${browser_bin}"
    return
  fi

  has_required_runtime_libs
}

dump_runtime_dependency_diagnostics() {
  local browser_bin=""
  local dir
  local lib

  log "runtime dependency diagnostics: library search directories"
  while IFS= read -r dir; do
    log "  ${dir}"
  done < <(runtime_lib_search_dirs)

  browser_bin="$(find_browser_bin || true)"
  if [[ -n "${browser_bin}" ]]; then
    log "runtime dependency diagnostics: ldd ${browser_bin}"
    browser_link_report "${browser_bin}" | sed 's/^/[start.sh]   /' || true
  fi

  log "runtime dependency diagnostics: found required library candidates"
  while IFS= read -r lib; do
    while IFS= read -r dir; do
      find "${dir}" \( -type f -o -type l \) \
        \( -name "${lib}" -o -name "${lib}.*" \) \
        -print -quit 2>/dev/null || true
    done < <(runtime_lib_search_dirs)
  done < <(required_runtime_libs) | sed 's/^/[start.sh]   /' || true
}

ensure_system_packages() {
  local deps_marker=".pw_deps_ok_v4"
  local need_install=0

  if [[ -f "${deps_marker}" ]]; then
    if ! runtime_dependency_validation_passes; then
      log "runtime dependency check failed; reinstalling system packages"
      need_install=1
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
      gtk3 pango cairo at-spi2-core libX11 libX11-xcb libxcb libXext libXrender libxshmfence fontconfig
    dnf install -y google-noto-sans-cjk-ttc-fonts google-noto-cjk-fonts wqy-zenhei-fonts || true
  elif command -v yum >/dev/null 2>&1; then
    yum install -y \
      python3 python3-pip python3-virtualenv curl ca-certificates unzip \
      nspr nss atk at-spi2-atk at-spi2-core cups-libs libdrm libxkbcommon \
      libXcomposite libXdamage libXfixes libXrandr mesa-libgbm alsa-lib \
      gtk3 pango cairo at-spi2-core libX11 libX11-xcb libxcb libXext libXrender libxshmfence fontconfig
    yum install -y google-noto-sans-cjk-ttc-fonts google-noto-cjk-fonts wqy-zenhei-fonts || true
  else
    log "ERROR: unsupported package manager (need apt-get/dnf/yum)"
    exit 1
  fi

  command -v ldconfig >/dev/null 2>&1 && ldconfig || true
  fc-cache -f >/dev/null 2>&1 || true

  if ! runtime_dependency_validation_passes; then
    log "runtime dependency validation still has missing items after install"
    dump_runtime_dependency_diagnostics
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

asr_cloud_configured() {
  local azure_key="${AZURE_SPEECH_KEY:-${AZURE_SPEECH_API_KEY:-}}"
  [[ -n "${azure_key}" ]] && \
    [[ -n "${AZURE_SPEECH_REGION:-}" || -n "${AZURE_SPEECH_ENDPOINT:-}" ]]
}

asr_auto_setup_enabled() {
  [[ "${ASR_AUTO_SETUP:-1}" != "0" ]]
}

asr_setup_mode() {
  local mode
  mode="$(printf '%s' "${ASR_SETUP_MODE:-background}" | tr '[:upper:]' '[:lower:]')"
  case "${mode}" in
    foreground|sync|blocking)
      printf 'foreground'
      ;;
    skip|disabled|off|0)
      printf 'skip'
      ;;
    *)
      printf 'background'
      ;;
  esac
}

asr_requirements_need_install() {
  local req_file="tools/asr/requirements.txt"
  if [[ ! -f "${req_file}" ]]; then
    return 0
  fi

  local req_hash_file=".venv/.asr_requirements.sha256"
  local new_hash
  new_hash="$(hash_file_sha256 "${req_file}")"
  local old_hash=""
  if [[ -f "${req_hash_file}" ]]; then
    old_hash="$(cat "${req_hash_file}" 2>/dev/null || true)"
  fi
  [[ "${new_hash}" != "${old_hash}" ]]
}

ensure_asr_requirements() {
  if ! asr_auto_setup_enabled; then
    log "ASR auto setup disabled"
    return
  fi

  if asr_cloud_configured || [[ -n "${ASR_COMMAND:-}" || -n "${FASTER_WHISPER_COMMAND:-}" ]]; then
    log "ASR already configured; skip local faster-whisper setup"
    return
  fi

  local req_file="tools/asr/requirements.txt"
  if [[ ! -f "${req_file}" ]]; then
    log "ERROR: missing ${req_file}"
    exit 1
  fi

  local req_hash_file=".venv/.asr_requirements.sha256"
  local new_hash
  new_hash="$(hash_file_sha256 "${req_file}")"
  local old_hash=""
  if [[ -f "${req_hash_file}" ]]; then
    old_hash="$(cat "${req_hash_file}" 2>/dev/null || true)"
  fi

  if [[ "${new_hash}" != "${old_hash}" ]]; then
    log "installing/updating ASR python dependencies"
    .venv/bin/python -m pip install --upgrade pip
    .venv/bin/python -m pip install -r "${req_file}"
    printf '%s' "${new_hash}" > "${req_hash_file}"
  fi
}

ensure_asr_requirements_background() {
  if ! asr_auto_setup_enabled; then
    log "ASR auto setup disabled"
    return
  fi

  if asr_cloud_configured || [[ -n "${ASR_COMMAND:-}" || -n "${FASTER_WHISPER_COMMAND:-}" ]]; then
    log "ASR already configured; skip local faster-whisper setup"
    return
  fi

  local mode
  mode="$(asr_setup_mode)"
  if [[ "${mode}" == "skip" ]]; then
    log "ASR setup skipped by ASR_SETUP_MODE=${ASR_SETUP_MODE:-background}"
    return
  fi

  if [[ "${mode}" == "foreground" ]]; then
    ensure_asr_requirements
    return
  fi

  if ! asr_requirements_need_install; then
    log "ASR python dependencies already installed"
    return
  fi

  log "ASR python dependencies will install in background; backend startup will not wait"
  (
    set +e
    lock_dir=".venv/.asr_requirements.lock"
    if ! mkdir "${lock_dir}" 2>/dev/null; then
      log "ASR background setup already running"
      exit 0
    fi
    trap 'rmdir "${lock_dir}" 2>/dev/null || true' EXIT
    ensure_asr_requirements
    status=$?
    if [[ ${status} -eq 0 ]]; then
      log "ASR background setup complete"
    else
      log "ASR background setup failed status=${status}; backend remains available"
    fi
    exit ${status}
  ) &
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

  if asr_cloud_configured; then
    export ASR_PROVIDER="${ASR_PROVIDER:-azure_speech}"
    log "ASR provider=${ASR_PROVIDER} (cloud)"
  elif [[ -n "${ASR_COMMAND:-}" ]]; then
    export ASR_PROVIDER="${ASR_PROVIDER:-command}"
    log "ASR provider=${ASR_PROVIDER} (custom command)"
  elif asr_auto_setup_enabled; then
    export ASR_PROVIDER="${ASR_PROVIDER:-faster_whisper}"
    export ASR_TIMEOUT_MS="${ASR_TIMEOUT_MS:-120000}"
    export FASTER_WHISPER_COMMAND="${FASTER_WHISPER_COMMAND:-${APP_DIR}/.venv/bin/python}"
    if [[ -z "${FASTER_WHISPER_ARGS:-}" ]]; then
      export FASTER_WHISPER_ARGS="${APP_DIR}/tools/asr/faster_whisper_cli.py {file} --model {model} --language {language} --output_format {outputFormat} --output_dir {outputDir}"
    fi
    export FASTER_WHISPER_MODEL="${FASTER_WHISPER_MODEL:-small}"
    export FASTER_WHISPER_LANGUAGE="${FASTER_WHISPER_LANGUAGE:-zh}"
    export FASTER_WHISPER_OUTPUT_FORMAT="${FASTER_WHISPER_OUTPUT_FORMAT:-json}"
    export HF_HOME="${HF_HOME:-${APP_DIR}/runtime/huggingface}"
    log "ASR provider=${ASR_PROVIDER} (local faster-whisper, model=${FASTER_WHISPER_MODEL})"
  else
    log "ASR is not configured; voice upload will accept files but cannot transcribe real audio"
  fi

  if [[ -z "${PUBLIC_ORIGIN:-}" ]]; then
    log "PUBLIC_ORIGIN is not set (recommended for HTTPS/WSS reverse proxy)"
  fi
}

main() {
  cd "${APP_DIR}"
  log "APP_DIR=${APP_DIR}"

  switch_apt_mirror
  ensure_system_packages
  ensure_node_modules
  ensure_python_venv
  ensure_ocr_requirements
  ensure_asr_requirements_background
  ensure_local_browser
  export_runtime_env

  log "starting backend server"
  exec npm run start
}

if [[ "${START_SH_SOURCE_ONLY:-0}" != "1" ]]; then
  main "$@"
fi
