'use strict';

// Minimal .env loader (no dependency). Reads KEY=VALUE lines from the project root
// .env into process.env without overriding already-set variables. FRT_ENV_FILE selects
// an explicit profile file for local commands; when it is set, a missing file is an
// error rather than silently falling back to a possibly production .env.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const configured = String(process.env.FRT_ENV_FILE || '').trim();
const file = configured
  ? (path.isAbsolute(configured) ? configured : path.join(root, configured))
  : path.join(root, '.env');
if (configured && !fs.existsSync(file)) {
  throw new Error(`FRT_ENV_FILE points to a missing file: ${file}`);
}
if (fs.existsSync(file)) {
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}

module.exports = {};
