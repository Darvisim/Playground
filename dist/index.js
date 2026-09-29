'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const API_LEVEL = '30';
const TERMUX_APK_URL = 'https://github.com/termux/termux-app/releases/download/v0.118.3/termux-app_v0.118.3+github-debug_universal.apk';
const SERIAL = 'emulator-5554';
const AVD_NAME = 'termux-ci';

function run(command, args, options = {}) {
  const capture = options.capture === true;
  const hasInput = options.input !== undefined;
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    input: options.input,
    stdio: capture
      ? ['ignore', 'pipe', 'pipe']
      : hasInput
        ? ['pipe', 'inherit', 'inherit']
        : 'inherit',
    timeout: options.timeout ?? 10 * 60 * 1000,
    env: process.env,
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = capture ? result.stderr : '';
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
        'test', '-x', '/data/data/com.termux/files/usr/bin/bash',
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

  const copy = spawnSync(adb, [
    '-s', serial,
    'shell', '-T', 'run-as', 'com.termux',
    'sh', '-c',
    `rm -rf '${remoteWorkspace}' && mkdir -p '${remoteWorkspace}' && cd '${remoteWorkspace}' && tar -x -f -`,
  ], {
    input: tar.stdout,
    stdio: ['pipe', 'inherit', 'inherit'],
    timeout: 2 * 60 * 1000,
  });

  if (copy.error) throw copy.error;
  if (copy.status !== 0) {
    throw new Error(`Could not sync the workspace into Termux: ${copy.stderr || 'unknown error'}`);
  }

  const chmod = spawnSync(adb, [
    '-s', serial,
    'shell', '-T', 'run-as', 'com.termux',
    'sh', '-c',
    `find '${remoteWorkspace}' -type f -perm /111 -exec chmod 755 {} +`,
  ], {
    stdio: 'inherit',
    timeout: 30_000,
  });

  if (chmod.error) throw chmod.error;
  if (chmod.status !== 0) {
    throw new Error('Could not restore executable permissions in the synced workspace.');
  }

  return remoteWorkspace;
}

async function main() {
  enableKvm();

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
  const systemImage = `system-images;android-${API_LEVEL};google_apis;${arch}`;

  run(sdkmanager, [`--sdk_root=${sdkRoot}`, '--licenses'], {
    input: 'y\n'.repeat(100),
  });
  run(sdkmanager, [
    `--sdk_root=${sdkRoot}`,
    'platform-tools',
    'emulator',
    `platforms;android-${API_LEVEL}`,
    systemImage,
  ]);

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

  run(adb, ['start-server']);

  const statePath = path.join(runnerTemp, 'termux-emulator-state.json');
  const emulatorLogPath = path.join(runnerTemp, 'termux-emulator.log');
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
  }));

  try {
    await waitForBoot(adb);
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
  fs.copyFileSync(sourceWrapper, termuxCommand);
  fs.chmodSync(termuxCommand, 0o755);

  fs.appendFileSync(process.env.GITHUB_PATH, `${binDirectory}${path.delimiter}`);
  fs.appendFileSync(
    process.env.GITHUB_ENV,
    `ANDROID_SERIAL=${SERIAL}\nTERMUX_ADB=${adb}\nTERMUX_WORKSPACE=${termuxWorkspace}\n`,
  );

  console.log(`Termux is ready on ${SERIAL}.`);
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
