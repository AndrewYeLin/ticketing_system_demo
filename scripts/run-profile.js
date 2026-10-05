'use strict';

// Run one command with an explicit application profile. This avoids shell-specific
// `set VAR=...` syntax and, more importantly, prevents the local SQL command from
// inheriting the production .env file.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PROFILES = Object.freeze({
  // A developer may keep the local settings in the conventional `.env` file. Keep
  // `.env.local` as a fallback for existing checkouts, but never use `.env.sql-test`
  // for this profile.
  local: { envFiles: ['.env', '.env.local'], nodeEnv: 'development', storage: 'csv' },
  'sql-test': { envFile: '.env.sql-test', nodeEnv: 'development', storage: 'sql' },
});

const [profileName, targetName, ...args] = process.argv.slice(2);
const profile = PROFILES[profileName];
if (!profile || !targetName) {
  console.error('Usage: node scripts/run-profile.js <local|sql-test> <script> [args...]');
  process.exit(2);
}

const envFileName = profile.envFiles
  ? profile.envFiles.find((candidate) => fs.existsSync(path.join(ROOT, candidate)))
  : profile.envFile;
const envFile = envFileName ? path.join(ROOT, envFileName) : null;
if (!envFile) {
  const expected = profile.envFiles ? profile.envFiles.join(' or ') : profile.envFile;
  console.error(`Missing ${expected}. Copy the matching .example file and fill in its secrets.`);
  process.exit(2);
}

const target = path.resolve(ROOT, targetName);
const child = spawn(process.execPath, [target, ...args], {
  cwd: ROOT,
  env: {
    ...process.env,
    FRT_ENV_FILE: envFile,
    NODE_ENV: profile.nodeEnv,
    STORAGE: profile.storage,
  },
  stdio: 'inherit',
});

child.on('error', (error) => {
  console.error(`Could not start ${targetName}:`, error.message);
  process.exit(1);
});
child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`${targetName} exited on signal ${signal}`);
    process.exit(1);
  }
  process.exit(code == null ? 1 : code);
});
