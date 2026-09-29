#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const scriptFile = process.argv[2];
const configPath = path.join(__dirname, 'termux-config.json');
const config = fs.existsSync(configPath)
  ? JSON.parse(fs.readFileSync(configPath, 'utf8'))
  : {};
const adb = config.adb || process.env.TERMUX_ADB || process.env.ADB || 'adb';
const serial = config.serial || process.env.ANDROID_SERIAL || 'emulator-5554';
const prefix = '/data/data/com.termux/files/usr';
const home = '/data/data/com.termux/files/home';
const termuxWorkspace = config.workspace
  || process.env.TERMUX_WORKSPACE
  || path.posix.join(home, 'workspace');
const hostEnvKeys = ['ANDROID_DATA', 'ANDROID_ROOT', 'HOME', 'PATH', 'PREFIX', 'TMPDIR'];

function runAdb(args, options = {}) {
  const env = { ...process.env };
  for (const name of hostEnvKeys) {
    const value = config.hostEnv?.[name];
    if (value === null || value === undefined) delete env[name];
    else env[name] = value;
  }

  return spawnSync(adb, args, { ...options, env });
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (!scriptFile) fail('Usage: termux <script-file>');
if (!fs.existsSync(scriptFile)) fail(`Script file not found: ${scriptFile}`);

const device = runAdb(['-s', serial, 'get-state'], {
  encoding: 'utf8',
  timeout: 15_000,
});

if (device.error) fail(`Could not contact the emulator: ${device.error.message}`);
if (device.status !== 0) fail(`Emulator ${serial} is not ready.`);

const shellCheck = runAdb([
  '-s', serial,
  'shell', '-T', 'run-as', 'com.termux',
  '/system/bin/toybox', 'test', '-x', `${prefix}/bin/sh`,
], {
  stdio: 'ignore',
  timeout: 15_000,
});

if (shellCheck.error || shellCheck.status !== 0) {
  fail('Termux sh is unavailable. Make sure Termux setup completed successfully.');
}

const workspaceCheck = runAdb([
  '-s', serial,
  'shell', '-T', 'run-as', 'com.termux',
  'test', '-d', termuxWorkspace,
], {
  stdio: 'ignore',
  timeout: 15_000,
});

if (workspaceCheck.error || workspaceCheck.status !== 0) {
  fail(`The synced workspace is missing in Termux: ${termuxWorkspace}`);
}

const remoteArgs = [
  '-s', serial,
  'shell', '-T', 'run-as', 'com.termux',
  '/system/bin/toybox', 'env',
  'ANDROID_DATA=/data',
  'ANDROID_ROOT=/system',
  `PREFIX=${prefix}`,
  `HOME=${home}`,
  'LANG=en_US.UTF-8',
  `TMPDIR=${prefix}/tmp`,
  `PATH=${prefix}/bin`,
  'TZ=UTC',
  'TERM=xterm-256color',
  `LD_LIBRARY_PATH=${prefix}/lib`,
  `LD_PRELOAD=${prefix}/lib/libtermux-exec.so`,
  `${prefix}/bin/sh`, '-s',
];

const result = runAdb(remoteArgs, {
  input: Buffer.concat([
    Buffer.from(`cd '${termuxWorkspace}' || exit 1\n`),
    fs.readFileSync(scriptFile),
  ]),
  stdio: ['pipe', 'inherit', 'inherit'],
});

if (result.error) fail(`Could not run the script in Termux: ${result.error.message}`);
if (result.signal) fail(`Termux shell terminated by signal ${result.signal}`);
process.exitCode = result.status ?? 1;
