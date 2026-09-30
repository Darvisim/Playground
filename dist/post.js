'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function run(command, args, hostEnv = {}) {
  const env = { ...process.env };
  for (const [name, value] of Object.entries(hostEnv)) {
    if (value === null || value === undefined) delete env[name];
    else env[name] = value;
  }

  return spawnSync(command, args, {
    stdio: 'ignore',
    timeout: 20_000,
    env,
  });
}

const runnerTemp = process.env.RUNNER_TEMP || os.tmpdir();
const statePath = path.join(runnerTemp, 'termux-emulator-state.json');

if (!fs.existsSync(statePath)) process.exit(0);

async function cleanup() {
  let adb;
  let hostEnv = {};
  try {
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    adb = state.adb;
    hostEnv = state.hostEnv || {};
    console.log('Stopping Android emulator device...');
    run(state.adb, ['-s', state.serial, 'emu', 'kill'], hostEnv);
  } catch (error) {
    console.warn(`Termux emulator cleanup warning: ${error.message}`);
  } finally {
    if (adb) {
      console.log('Stopping ADB server...');
      run(adb, ['kill-server'], hostEnv);
    }
    fs.rmSync(statePath, { force: true });
  }
}

cleanup();
