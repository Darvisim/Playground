'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const API_LEVEL = '30';
const TERMUX_APK_URL = 'https://github.com/termux/termux-app/releases/download/v0.118.3/termux-app_v0.118.3+github-debug_universal.apk';
const SERIAL = 'emulator-5554';
const AVD_NAME = 'termux-ci';
const TERMUX_PREFIX = '/data/data/com.termux/files/usr';
const TERMUX_HOME = '/data/data/com.termux/files/home';
const HOST_ENV_KEYS = [
  'ANDROID_DATA', 'ANDROID_ROOT', 'HOME', 'PATH', 'PREFIX', 'TMPDIR',
];

function captureHostEnv() {
  return Object.fromEntries(
    HOST_ENV_KEYS.map((name) => [name, process.env[name] ?? null]),
  );
}

function logStatus(message) {
  console.log(`\u001b[1m${message}\u001b[0m`);
}

function run(command, args, options = {}) {
  const capture = options.capture === true;
  const hasInput = options.input !== undefined;
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    input: options.input,
    stdio: [hasInput ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    maxBuffer: options.maxBuffer ?? 32 * 1024 * 1024,
    timeout: options.timeout ?? 10 * 60 * 1000,
    env: process.env,
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    const output = [result.stderr, result.stdout].filter(Boolean).join('\n').trim();
    const detail = output
      ? output.split(/[\r\n]+/).filter(Boolean).slice(-20).join('\n')
      : '';
    throw new Error(
      `${command} exited with status ${result.status ?? 'unknown'}${detail ? `:\n${detail}` : ''}`,
    );
  }

  return capture ? result.stdout.trim() : '';
}

function findSdkRoot() {
  const candidates = [
    process.env.ANDROID_SDK_ROOT,
    process.env.ANDROID_HOME,
    '/usr/local/lib/android/sdk',
    '/opt/android-sdk',
  ].filter(Boolean);

  const root = candidates.find((candidate) =>
    fs.existsSync(path.join(candidate, 'platform-tools', 'adb')),
  );

  if (!root) throw new Error('Could not find the Android SDK on this runner.');
  return root;
}

function findSdkTool(sdkRoot, tool) {
  const commandLineTools = path.join(sdkRoot, 'cmdline-tools');
  const candidates = [path.join(commandLineTools, 'latest', 'bin', tool)];

  if (fs.existsSync(commandLineTools)) {
    const versions = fs.readdirSync(commandLineTools)
      .filter((name) => name !== 'latest')
      .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));

    for (const version of versions) {
      candidates.push(path.join(commandLineTools, version, 'bin', tool));
    }
  }

  const found = candidates.find(fs.existsSync);
  if (!found) throw new Error(`Could not find ${tool} under ${commandLineTools}.`);
  return found;
}

function enableKvm() {
  if (process.platform !== 'linux') {
    throw new Error('This action currently supports Linux GitHub runners only.');
  }

  const rule =
    'KERNEL=="kvm", GROUP="kvm", MODE="0666", OPTIONS+="static_node=kvm"\n';

  run('sudo', ['-n', 'tee', '/etc/udev/rules.d/99-kvm4all.rules'], {
    input: rule,
  });
  run('sudo', ['-n', 'udevadm', 'control', '--reload-rules']);
  run('sudo', ['-n', 'udevadm', 'trigger', '--name-match=kvm']);
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForBoot(adb) {
  run(adb, ['-s', SERIAL, 'wait-for-device'], { timeout: 12 * 60 * 1000 });

  for (let attempt = 0; attempt < 360; attempt += 1) {
    try {
      if (run(adb, ['-s', SERIAL, 'shell', 'getprop', 'sys.boot_completed'], {
        capture: true,
        timeout: 10_000,
      }) === '1') {
        return;
      }
    } catch {
      // The device may not be ready to answer shell commands yet.
    }
    await sleep(2_000);
  }

  throw new Error('Android emulator did not finish booting within 12 minutes.');
}

async function waitForTermux(adb) {
  run(adb, ['-s', SERIAL, 'shell', 'monkey', '-p', 'com.termux', '1'], {
    timeout: 30_000,
  });

  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      run(adb, [
        '-s', SERIAL, 'shell', 'run-as', 'com.termux',
        'test', '-x', '/data/data/com.termux/files/usr/bin/sh',
      ], { timeout: 10_000 });
      return;
    } catch {
      await sleep(2_000);
    }
  }

  run(adb, ['-s', SERIAL, 'logcat', '-d', '-t', '200'], {
    capture: true,
    timeout: 30_000,
  });
  throw new Error('Termux bootstrap did not finish in time.');
}

function syncWorkspaceToTermux(adb, serial, workspace) {
  if (!workspace || !fs.existsSync(workspace)) {
    return '/data/data/com.termux/files/home/workspace';
  }

  const remoteWorkspace = '/data/data/com.termux/files/home/workspace';

  const tar = spawnSync('tar', ['-C', workspace, '-cf', '-', '.'], {
    encoding: null,
    maxBuffer: 1024 * 1024 * 1024,
  });

  if (tar.error) throw tar.error;
  if (tar.status !== 0) {
    const stderr = tar.stderr ? tar.stderr.toString() : 'unknown error';
    throw new Error(`tar failed while packaging ${workspace}: ${stderr}`);
  }

  const runAs = (args, options = {}) => spawnSync(adb, [
    '-s', serial,
    'shell', '-T', 'run-as', 'com.termux',
    ...args,
  ], {
    stdio: options.input === undefined
      ? 'inherit'
      : ['pipe', 'inherit', 'inherit'],
    input: options.input,
    timeout: options.timeout ?? 30_000,
  });

  const remove = runAs(['/system/bin/toybox', 'rm', '-rf', remoteWorkspace]);
  if (remove.error) throw remove.error;
  if (remove.status !== 0) {
    throw new Error('Could not remove the previous Termux workspace.');
  }

  const mkdir = runAs(['/system/bin/toybox', 'mkdir', '-p', remoteWorkspace]);
  if (mkdir.error) throw mkdir.error;
  if (mkdir.status !== 0) {
    throw new Error('Could not create the Termux workspace directory.');
  }

  const copy = runAs([
    '/system/bin/toybox', 'tar', '-x', '-f', '-', '-C', remoteWorkspace,
  ], {
    input: tar.stdout,
    timeout: 2 * 60 * 1000,
  });

  if (copy.error) throw copy.error;
  if (copy.status !== 0) {
    throw new Error('Could not extract the workspace archive in Termux.');
  }

  return remoteWorkspace;
}

async function main() {
  logStatus('Setting up KVM...');
  enableKvm();
  console.log('KVM has been set up.');

  const runnerTemp = process.env.RUNNER_TEMP || os.tmpdir();
  const avdHome = path.join(runnerTemp, 'avd');
  fs.mkdirSync(avdHome, { recursive: true });
  process.env.ANDROID_AVD_HOME = avdHome;

  const sdkRoot = findSdkRoot();
  const sdkmanager = findSdkTool(sdkRoot, 'sdkmanager');
  const avdmanager = findSdkTool(sdkRoot, 'avdmanager');
  const adb = path.join(sdkRoot, 'platform-tools', 'adb');
  const emulator = path.join(sdkRoot, 'emulator', 'emulator');
  const arch = process.env.INPUT_ARCH || 'x86_64';
  const systemImage = `system-images;android-${API_LEVEL};default;${arch}`;

  logStatus('Accepting Android SDK licenses...');
  const licenseOutput = run(sdkmanager, [`--sdk_root=${sdkRoot}`, '--licenses'], {
    input: 'y\n'.repeat(100),
    capture: true,
  });
  const licenseTotal = licenseOutput.match(
    /\bof\s+(\d+)\s+SDK package licenses not accepted\b/i,
  )?.[1];
  console.log(licenseTotal
    ? `Accepted all ${licenseTotal} Android SDK licenses.`
    : 'All Android SDK licenses accepted.');

  logStatus('Installing Android SDK packages...');
  const sdkPackages = [
    'platform-tools',
    'emulator',
    `platforms;android-${API_LEVEL}`,
    systemImage,
  ];
  run(sdkmanager, [
    `--sdk_root=${sdkRoot}`,
    ...sdkPackages,
  ]);
  const installedOutput = run(sdkmanager, [
    `--sdk_root=${sdkRoot}`,
    '--list_installed',
  ], { capture: true });
  const installedPackages = new Set(
    installedOutput.split(/\r?\n/)
      .map((line) => line.match(/^\s*([^|]+?)\s*\|/))
      .filter(Boolean)
      .map((match) => match[1].trim()),
  );
  const missingPackages = sdkPackages.filter((name) => !installedPackages.has(name));
  if (missingPackages.length > 0) {
    throw new Error(`SDK packages were not installed: ${missingPackages.join(', ')}`);
  }
  console.log(`Installed ${sdkPackages.length}/${sdkPackages.length} Android SDK packages.`);

  const statePath = path.join(runnerTemp, 'termux-emulator-state.json');
  const emulatorLogPath = path.join(runnerTemp, 'termux-emulator.log');
  run(avdmanager, [
    'create', 'avd',
    '--force',
    '--name', AVD_NAME,
    '--package', systemImage,
    '--device', 'pixel_2',
  ], { input: 'no\n' });

  const avdConfig = path.join(avdHome, `${AVD_NAME}.ini`);
  if (!fs.existsSync(avdConfig)) {
    throw new Error(`AVD config was not created: ${avdConfig}`);
  }

  logStatus('Starting an Android device emulator...');
  run(adb, ['start-server']);

  const emulatorLogFd = fs.openSync(emulatorLogPath, 'a');
  const emulatorProcess = spawn(emulator, [
    '-avd', AVD_NAME,
    '-port', '5554',
    '-no-window',
    '-gpu', 'swiftshader_indirect',
    '-noaudio',
    '-no-boot-anim',
    '-no-snapshot',
    '-no-snapshot-save',
  ], {
    detached: true,
    stdio: ['ignore', emulatorLogFd, emulatorLogFd],
    env: process.env,
  });

  fs.closeSync(emulatorLogFd);

  await new Promise((resolve, reject) => {
    emulatorProcess.once('spawn', resolve);
    emulatorProcess.once('error', reject);
  });
  emulatorProcess.unref();

  fs.writeFileSync(statePath, JSON.stringify({
    pid: emulatorProcess.pid,
    serial: SERIAL,
    adb,
    hostEnv: captureHostEnv(),
  }));

  try {
    await waitForBoot(adb);
    console.log('Device emulator is active.');
  } catch (error) {
    console.error('--- emulator log (last 200 lines) ---');
    if (fs.existsSync(emulatorLogPath)) {
      console.error(
        fs.readFileSync(emulatorLogPath, 'utf8').split('\n').slice(-200).join('\n'),
      );
    }

    const devices = spawnSync(adb, ['devices', '-l'], {
      encoding: 'utf8',
      timeout: 10_000,
    });
    console.error('--- adb devices ---');
    console.error(devices.stdout || devices.stderr || '(no output)');

    throw error;
  }

  const apk = path.join(runnerTemp, 'termux-debug.apk');
  logStatus('Installing Termux...');
  run('curl', ['--fail', '--location', '--retry', '3', '--output', apk, TERMUX_APK_URL]);
  run(adb, ['-s', SERIAL, 'install', apk]);
  await waitForTermux(adb);

  const termuxWorkspace = syncWorkspaceToTermux(
    adb,
    SERIAL,
    process.env.GITHUB_WORKSPACE || process.cwd(),
  );

  const sourceWrapper = path.join(__dirname, 'termux.js');
  if (!fs.existsSync(sourceWrapper)) {
    throw new Error(`Termux shell wrapper not found: ${sourceWrapper}`);
  }

  const binDirectory = path.join(runnerTemp, 'termux-bin');
  fs.mkdirSync(binDirectory, { recursive: true });
  const termuxCommand = path.join(binDirectory, 'termux');
  const wrapperSource = fs.readFileSync(sourceWrapper, 'utf8')
    .replace(/^#![^\n]*\n/, `#!${process.execPath}\n`);
  fs.writeFileSync(termuxCommand, wrapperSource);
  fs.chmodSync(termuxCommand, 0o755);
  fs.writeFileSync(path.join(binDirectory, 'termux-config.json'), JSON.stringify({
    adb,
    serial: SERIAL,
    workspace: termuxWorkspace,
    hostEnv: captureHostEnv(),
  }));

  fs.appendFileSync(process.env.GITHUB_PATH, `${binDirectory}${path.delimiter}`);
  fs.appendFileSync(
    process.env.GITHUB_ENV,
    [
      'ANDROID_DATA=/data',
      'ANDROID_ROOT=/system',
      `HOME=${TERMUX_HOME}`,
      'LANG=en_US.UTF-8',
      `PATH=${TERMUX_PREFIX}/bin`,
      `PREFIX=${TERMUX_PREFIX}`,
      `TMPDIR=${TERMUX_PREFIX}/tmp`,
      'TZ=UTC',
      'TERM=xterm-256color',
      '',
    ].join('\n'),
  );
  console.log('Termux is setup and ready on device emulator.');
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
