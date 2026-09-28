'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function run(command, args) {
  return spawnSync(command, args, {
    stdio: 'ignore',
    timeout: 20_000,
    env: process.env,
  });
}

const runnerTemp = process.env.RUNNER_TEMP || os.tmpdir();
const statePath = path.join(runnerTemp, 'termux-emulator-state.json');

if (!fs.existsSync(statePath)) process.exit(0);

try {
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  run(state.adb, ['-s', state.serial, 'emu', 'kill']);

  if (state.pid) {
    try {
      process.kill(-state.pid, 'SIGTERM');
    } catch {
      // The emulator may already have shut down.
    }
  }
} catch (error) {
  console.warn(`Termux emulator cleanup warning: ${error.message}`);
} finally {
  fs.rmSync(statePath, { force: true });
}
