#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const scriptFile = process.argv[2];
const adb = process.env.TERMUX_ADB || process.env.ADB || 'adb';
const serial = process.env.ANDROID_SERIAL || 'emulator-5554';
const prefix = '/data/data/com.termux/files/usr';
const home = '/data/data/com.termux/files/home';

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (!scriptFile) fail('Usage: termux <script-file>');
if (!fs.existsSync(scriptFile)) fail(`Script file not found: ${scriptFile}`);

const device = spawnSync(adb, ['-s', serial, 'get-state'], {
  encoding: 'utf8',
  timeout: 15_000,
});

if (device.error) fail(`Could not contact the emulator: ${device.error.message}`);
if (device.status !== 0) fail(`Emulator ${serial} is not ready.`);

const bashCheck = spawnSync(adb, [
  '-s', serial,
  'shell', '-T', 'run-as', 'com.termux',
  '/system/bin/toybox', 'test', '-x', `${prefix}/bin/bash`,
], {
  stdio: 'ignore',
  timeout: 15_000,
});

if (bashCheck.error || bashCheck.status !== 0) {
  fail('Termux Bash is unavailable. Make sure Termux setup completed successfully.');
}

const remoteArgs = [
  '-s', serial,
  'shell', '-T', 'run-as', 'com.termux',
  '/system/bin/toybox', 'env',
  `PREFIX=${prefix}`,
  `HOME=${home}`,
  `TMPDIR=${prefix}/tmp`,
  `PATH=${prefix}/bin:/system/bin`,
  `LD_LIBRARY_PATH=${prefix}/lib`,
  `LD_PRELOAD=${prefix}/lib/libtermux-exec.so`,
  'LANG=en_US.UTF-8',
  'TERM=xterm-256color',
  `${prefix}/bin/bash`, '-s',
];

const result = spawnSync(adb, remoteArgs, {
  input: fs.readFileSync(scriptFile),
  stdio: ['pipe', 'inherit', 'inherit'],
});

if (result.error) fail(`Could not run the script in Termux: ${result.error.message}`);
if (result.signal) fail(`Termux shell terminated by signal ${result.signal}`);
process.exitCode = result.status ?? 1;
