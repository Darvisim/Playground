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

function processGroupExists(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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

    if (state.pid) {
      try {
        console.log(`Terminating remaining emulator processes (PID ${state.pid})...`);
        process.kill(-state.pid, 'SIGTERM');
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }

      for (let attempt = 0; attempt < 20 && processGroupExists(state.pid); attempt += 1) {
        await sleep(250);
      }

      if (processGroupExists(state.pid)) {
        try {
          console.log(`Force-stopping remaining emulator processes (PID ${state.pid})...`);
          process.kill(-state.pid, 'SIGKILL');
        } catch (error) {
          if (error.code !== 'ESRCH') throw error;
        }
      }
    }
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
