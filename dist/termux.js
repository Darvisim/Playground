#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { pipeline } = require('node:stream/promises');

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
const hostWorkspace = config.hostWorkspace || process.env.GITHUB_WORKSPACE;
const hostEnvKeys = ['ANDROID_DATA', 'ANDROID_ROOT', 'HOME', 'PATH', 'PREFIX', 'TMPDIR'];

function hostEnvironment() {
  const env = { ...process.env };
  for (const name of hostEnvKeys) {
    const value = config.hostEnv?.[name];
    if (value === null || value === undefined) delete env[name];
    else env[name] = value;
  }
  return env;
}

function runAdb(args, options = {}) {
  return spawnSync(adb, args, { ...options, env: hostEnvironment() });
}

function waitForChild(child, name) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${name} failed${signal ? ` with signal ${signal}` : ` with exit code ${code}`}.`));
    });
  });
}

async function streamBetweenProcesses(source, destination, description) {
  const sourceStatus = waitForChild(source, `${description} source`);
  const destinationStatus = waitForChild(destination, `${description} destination`);

  try {
    await Promise.all([
      pipeline(source.stdout, destination.stdin),
      sourceStatus,
      destinationStatus,
    ]);
  } catch (error) {
    source.kill();
    destination.kill();
    throw error;
  }
}

function runAsTermux(args) {
  const result = runAdb([
    '-s', serial,
    'shell', '-T', 'run-as', 'com.termux',
    ...args,
  ], { stdio: ['ignore', 'ignore', 'inherit'] });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Termux workspace command failed: ${args.join(' ')}`);
  }
}

async function syncWorkspaceToTermux() {
  if (!hostWorkspace || !path.isAbsolute(hostWorkspace) || !fs.statSync(hostWorkspace).isDirectory()) {
    throw new Error(`Host workspace directory is unavailable: ${hostWorkspace || '(unset)'}`);
  }

  runAsTermux(['/system/bin/toybox', 'rm', '-rf', termuxWorkspace]);
  runAsTermux(['/system/bin/toybox', 'mkdir', '-p', termuxWorkspace]);

  const archive = spawn('tar', ['-C', hostWorkspace, '-cf', '-', '.'], {
    env: hostEnvironment(),
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const extract = spawn(adb, [
    '-s', serial,
    'shell', '-T', 'run-as', 'com.termux',
    '/system/bin/toybox', 'tar', '-x', '-f', '-', '-C', termuxWorkspace,
  ], {
    env: hostEnvironment(),
    stdio: ['pipe', 'ignore', 'inherit'],
  });

  await streamBetweenProcesses(archive, extract, 'Host-to-Termux workspace sync');
}

async function syncWorkspaceToHost() {
  const temporaryWorkspace = `${hostWorkspace}.termux-sync-${process.pid}`;
  fs.rmSync(temporaryWorkspace, { recursive: true, force: true });
  fs.mkdirSync(temporaryWorkspace, { recursive: true });

  const archive = spawn(adb, [
    '-s', serial,
    'shell', '-T', 'run-as', 'com.termux',
    '/system/bin/toybox', 'tar', '-c', '-f', '-', '-C', termuxWorkspace, '.',
  ], {
    env: hostEnvironment(),
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const extract = spawn('tar', ['-x', '-f', '-', '-C', temporaryWorkspace], {
    env: hostEnvironment(),
    stdio: ['pipe', 'ignore', 'inherit'],
  });

  try {
    await streamBetweenProcesses(archive, extract, 'Termux-to-host workspace sync');
    for (const entry of fs.readdirSync(hostWorkspace)) {
      fs.rmSync(path.join(hostWorkspace, entry), { recursive: true, force: true });
    }
    for (const entry of fs.readdirSync(temporaryWorkspace)) {
      fs.renameSync(
        path.join(temporaryWorkspace, entry),
        path.join(hostWorkspace, entry),
      );
    }
    fs.rmSync(temporaryWorkspace, { recursive: true, force: true });
  } catch (error) {
    fs.rmSync(temporaryWorkspace, { recursive: true, force: true });
    throw error;
  }
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

async function main() {
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

  await syncWorkspaceToTermux();

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

  await syncWorkspaceToHost();
  process.exitCode = result.status ?? 1;
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
