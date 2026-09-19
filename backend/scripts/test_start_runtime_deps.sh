#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
START_SH_UNDER_TEST="${START_SH_UNDER_TEST:-${ROOT_DIR}/backend/start.sh}"

fail() {
  printf 'not ok - %s\n' "$*" >&2
  exit 1
}

pass() {
  printf 'ok - %s\n' "$*"
}

make_tmp_dir() {
  mktemp -d "${TMPDIR:-/tmp}/start-runtime-deps.XXXXXX"
}

TMP_ROOT="$(make_tmp_dir)"
cleanup() {
  rm -rf "${TMP_ROOT}"
}
trap cleanup EXIT

APP_FIXTURE="${TMP_ROOT}/app"
mkdir -p "${APP_FIXTURE}"
printf '{"name":"fixture"}\n' > "${APP_FIXTURE}/package.json"

START_SH_SOURCE_ONLY=1 START_SH_APP_DIR="${APP_FIXTURE}" source "${START_SH_UNDER_TEST}"

declare -F has_shared_lib >/dev/null || fail "has_shared_lib should be sourceable"
declare -F runtime_dependency_validation_passes >/dev/null || fail "runtime_dependency_validation_passes should be sourceable"
[[ "${APP_DIR}" == "${APP_FIXTURE}" ]] || fail "START_SH_APP_DIR should override APP_DIR"
pass "start.sh can be sourced without executing startup"

LIB_DIR="${TMP_ROOT}/libs"
MISSING_DIR="${TMP_ROOT}/missing-libs"
mkdir -p "${LIB_DIR}"
touch "${LIB_DIR}/libdemo-present.so.1"

RUNTIME_LIB_SEARCH_DIRS="${MISSING_DIR}:${LIB_DIR}" has_shared_lib "libdemo-present.so.1" \
  || fail "has_shared_lib should ignore missing search dirs when a later dir contains the library"
pass "has_shared_lib is stable when one search directory is absent"

FAKE_BIN="${TMP_ROOT}/fake-bin"
EMPTY_LIB_DIR="${TMP_ROOT}/empty-libs"
mkdir -p "${FAKE_BIN}" "${EMPTY_LIB_DIR}"
cat > "${FAKE_BIN}/ldconfig" <<'EOF'
#!/usr/bin/env sh
printf 'libdemo-exact.so.10 (libc6,x86-64) => /lib/libdemo-exact.so.10\n'
EOF
chmod +x "${FAKE_BIN}/ldconfig"

PATH="${FAKE_BIN}:${PATH}" RUNTIME_LIB_SEARCH_DIRS="${EMPTY_LIB_DIR}" has_shared_lib "libdemo-exact.so.1" \
  && fail "has_shared_lib should not treat libdemo-exact.so.10 as libdemo-exact.so.1"
pass "ldconfig matching is exact"

cat > "${FAKE_BIN}/dpkg-query" <<'EOF'
#!/usr/bin/env sh
if [ "$1" = "-W" ]; then
  printf 'install ok installed\n'
  exit 0
fi
if [ "$1" = "-L" ]; then
  printf '/usr/lib/x86_64-linux-gnu/libpkg-demo.so.0\n'
  exit 0
fi
exit 1
EOF
chmod +x "${FAKE_BIN}/dpkg-query"

PATH="${FAKE_BIN}:${PATH}" debian_package_has_shared_lib "fixture-pkg" "libpkg-demo.so.0" \
  || fail "debian package file list should satisfy shared library lookup"
pass "debian package file list lookup works"

mkdir -p "${APP_FIXTURE}/.local-browser/chrome-linux"
cat > "${APP_FIXTURE}/.local-browser/chrome-linux/chrome" <<'EOF'
#!/usr/bin/env sh
exit 0
EOF
chmod +x "${APP_FIXTURE}/.local-browser/chrome-linux/chrome"
cat > "${FAKE_BIN}/ldd" <<'EOF'
#!/usr/bin/env sh
printf 'linux-vdso.so.1 (0x00007ffd)\n'
printf 'libok.so.1 => /lib/libok.so.1 (0x00007f00)\n'
EOF
chmod +x "${FAKE_BIN}/ldd"

APP_DIR="${APP_FIXTURE}" PATH="${FAKE_BIN}:${PATH}" RUNTIME_LIB_SEARCH_DIRS="${EMPTY_LIB_DIR}" runtime_dependency_validation_passes \
  || fail "browser ldd success should satisfy runtime dependency validation"
pass "browser ldd validation can satisfy runtime dependency check"

printf 'all start runtime dependency tests passed\n'
