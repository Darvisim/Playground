#!/usr/bin/env bash
set -euo pipefail

script_file="${1:?Termux shell requires a script file}"
if [[ ! -f "$script_file" ]]; then
  echo "Script file not found: $script_file" >&2
  exit 1
fi

adb_bin="${TERMUX_ADB:-${ADB:-adb}}"
serial="${ANDROID_SERIAL:-emulator-5554}"
prefix=/data/data/com.termux/files/usr
home=/data/data/com.termux/files/home

"$adb_bin" -s "$serial" get-state >/dev/null

ready=false
for attempt in $(seq 1 120); do
  if "$adb_bin" -s "$serial" shell -T run-as com.termux /system/bin/toybox test -x "$prefix/bin/bash" >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 2
done

if [ "$ready" != true ]; then
  echo "Termux Bash did not become available." >&2
  "$adb_bin" -s "$serial" logcat -d -t 200 >&2 || true
  exit 1
fi

"$adb_bin" -s "$serial" shell -T run-as com.termux \
  /system/bin/toybox env \
  "PREFIX=$prefix" \
  "HOME=$home" \
  "TMPDIR=$prefix/tmp" \
  "PATH=$prefix/bin:/system/bin" \
  "LD_LIBRARY_PATH=$prefix/lib" \
  "LD_PRELOAD=$prefix/lib/libtermux-exec.so" \
  "LANG=en_US.UTF-8" \
  "TERM=xterm-256color" \
  "$prefix/bin/bash" -s < "$script_file"
