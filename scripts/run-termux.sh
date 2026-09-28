#!/usr/bin/env bash
set -euo pipefail

: "${TERMUX_APK_URL:?termux-apk-url input is empty or missing}"
: "${TERMUX_COMMAND:?command input is empty or missing}"

apk=/tmp/termux.apk
curl --fail --location "$TERMUX_APK_URL" --output "$apk"
adb install "$apk"
adb shell monkey -p com.termux 1 >/dev/null

prefix=/data/data/com.termux/files/usr
home=/data/data/com.termux/files/home
ready=false

for attempt in $(seq 1 120); do
  if adb shell run-as com.termux test -x "$prefix/bin/bash" >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 2
done

if [ "$ready" != true ]; then
  echo "Termux bootstrap did not finish in time."
  adb logcat -d -t 200 >&2 || true
  exit 1
fi

command_b64="$(printf '%s' "$TERMUX_COMMAND" | base64 | tr -d '\n')"

adb shell run-as com.termux /system/bin/sh -s <<EOF
set -e
export PREFIX=$prefix
export HOME=$home
export TMPDIR=$prefix/tmp
export PATH=$prefix/bin
export LD_LIBRARY_PATH=$prefix/lib
export LD_PRELOAD=$prefix/lib/libtermux-exec.so
export LANG=en_US.UTF-8
export TERM=xterm-256color
printf '%s' '$command_b64' | "\$PREFIX/bin/base64" -d | "\$PREFIX/bin/bash" -s
EOF
