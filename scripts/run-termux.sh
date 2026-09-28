#!/usr/bin/env bash
set -euo pipefail

script_file="${1:?Termux shell requires a script file}"
if [[ ! -f "$script_file" ]]; then
  echo "Script file not found: $script_file" >&2
  exit 1
fi

adb_bin="${TERMUX_ADB:-${ADB:-adb}}"
serial="${ANDROID_SERIAL:-emulator-5554}"

"$adb_bin" -s "$serial" get-state >/dev/null

remote_command='
export PREFIX=/data/data/com.termux/files/usr
export HOME=/data/data/com.termux/files/home
export TMPDIR="$PREFIX/tmp"
export PATH="$PREFIX/bin:/system/bin"
export LD_LIBRARY_PATH="$PREFIX/lib"
export LD_PRELOAD="$PREFIX/lib/libtermux-exec.so"
export LANG=en_US.UTF-8
export TERM=xterm-256color
exec "$PREFIX/bin/bash" -s
'

"$adb_bin" -s "$serial" shell -T run-as com.termux /system/bin/sh -c "$remote_command" < "$script_file"
