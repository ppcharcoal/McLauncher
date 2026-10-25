'use strict';
const path = require('path');
const os = require('os');
const fs = require('fs');

// Linux: ~/.local/share/cairn   Windows: %APPDATA%\cairn
// Installs from before the rename (McLauncher) keep their existing folder, so nothing is lost.
const BASE = process.platform === 'win32'
  ? (process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'))
  : (process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'));
function pickRoot() {
  if (process.env.MCL_DATA_DIR) return process.env.MCL_DATA_DIR;
  const now = path.join(BASE, 'cairn');
  const old = path.join(BASE, 'mclauncher');
  if (!fs.existsSync(now) && fs.existsSync(path.join(old, 'instances'))) return old;
  return now;
}
const ROOT = pickRoot();

const P = {
  root: ROOT,
  versions: path.join(ROOT, 'versions'),
  libraries: path.join(ROOT, 'libraries'),
  assets: path.join(ROOT, 'assets'),
  runtime: path.join(ROOT, 'runtime'),
  instances: path.join(ROOT, 'instances'),
  cache: path.join(ROOT, 'cache'),
  logs: path.join(ROOT, 'logs'),
  settings: path.join(ROOT, 'settings.json'),
  accounts: path.join(ROOT, 'accounts.dat'),
};

function ensure(dir) { fs.mkdirSync(dir, { recursive: true }); return dir; }
for (const k of ['versions', 'libraries', 'assets', 'runtime', 'instances', 'cache', 'logs']) ensure(P[k]);

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, data) {
  ensure(path.dirname(file));
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

/** Resolve a relative path inside base; throws if it would escape (zip-slip / bad manifests). */
function safeJoin(base, rel) {
  const target = path.resolve(base, rel);
  const b = path.resolve(base);
  if (target !== b && !target.startsWith(b + path.sep)) throw new Error('Unsafe path: ' + rel);
  return target;
}

module.exports = { P, ensure, readJson, writeJson, safeJoin };
