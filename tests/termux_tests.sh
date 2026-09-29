#!/usr/bin/env bash
set -uo pipefail

test_dir="${TMPDIR:-$HOME}/termux-tests.$$"
mkdir -p "$test_dir"
trap 'rm -rf "$test_dir"' EXIT

test_names=()
test_pids=()
test_logs=()

run_test() {
  local name="$1"
  shift

  local index="${#test_names[@]}"
  local log="$test_dir/test-$index.log"

  test_names+=("$name")
  test_logs+=("$log")

  (
    set -e
    printf '%s\n' "--- $name ---"
    "$@"
  ) >"$log" 2>&1 &

  test_pids+=("$!")
}

test_termux_environment() {
  [[ "$PREFIX" == /data/data/com.termux/files/usr ]]
  [[ -x "$PREFIX/bin/bash" ]]
  [[ -d "$HOME" ]]
  [[ "$ANDROID_DATA" == /data ]]
  [[ "$ANDROID_ROOT" == /system ]]
  [[ "$LANG" == en_US.UTF-8 ]]
  [[ "$PATH" == "$PREFIX/bin" ]]
  [[ "$TMPDIR" == "$PREFIX/tmp" ]]
  [[ "$TZ" == UTC ]]
  [[ "$TERM" == xterm-256color ]]
  printf 'ANDROID_DATA=%s\nANDROID_ROOT=%s\nHOME=%s\nLANG=%s\nPATH=%s\nPREFIX=%s\nTMPDIR=%s\nTZ=%s\nTERM=%s\n' \
    "$ANDROID_DATA" "$ANDROID_ROOT" "$HOME" "$LANG" "$PATH" "$PREFIX" \
    "$TMPDIR" "$TZ" "$TERM"
}

test_bash_runtime() {
  [[ -n "${BASH_VERSION:-}" ]]
  bash --version | head -n 1
}

test_package_manager() {
  command -v pkg
  command -v apt
}

test_base64_round_trip() {
  local decoded
  decoded="$(printf 'termux-test' | base64 | base64 -d)"
  [[ "$decoded" == 'termux-test' ]]
  printf 'base64 round trip passed\n'
}

test_home_is_writable() {
  local marker="$HOME/.termux-test-$$"
  printf 'ok\n' > "$marker"
  [[ "$(cat "$marker")" == 'ok' ]]
  rm -f "$marker"
  printf 'Termux home is writable\n'
}

run_test 'Termux environment' test_termux_environment
run_test 'Bash runtime' test_bash_runtime
run_test 'Package manager commands' test_package_manager
run_test 'Base64 round trip' test_base64_round_trip
run_test 'Writable Termux home' test_home_is_writable

failed=0

for index in "${!test_pids[@]}"; do
  status=0
  wait "${test_pids[$index]}" || status=$?

  cat "${test_logs[$index]}"
  if (( status == 0 )); then
    printf 'PASS: %s\n\n' "${test_names[$index]}"
  else
    printf 'FAIL: %s (exit %s)\n\n' "${test_names[$index]}" "$status"
    failed=1
  fi
done

exit "$failed"
