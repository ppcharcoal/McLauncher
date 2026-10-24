'use strict';
/**
 * Modpack file integrity: remembers which files a modpack is made of, checks they are all present,
 * fetches missing ones from another source when possible, and helps the player add the rest by hand.
 */
const fs = require('fs');
const path = require('path');
const { readJson, writeJson, safeJoin } = require('./paths');
const { fetchJson, download, pool, hashFile } = require('./net');
const instances = require('./instances');

const MODRINTH = 'https://api.modrinth.com/v2';

function packFile(instId) { return path.join(instances.dirOf(instId), 'pack.json'); }

/** files: [{ path, sha1?, size?, title?, page?, urls?: [] }] */
function savePackFiles(instId, files) {
  writeJson(packFile(instId), { saved: new Date().toISOString(), files });
}
function packFiles(instId) { return (readJson(packFile(instId), { files: [] }).files) || []; }

function present(gd, f) {
  for (const p of [f.path, f.path + '.disabled']) {
    let full;
    try { full = safeJoin(gd, p); } catch { return true; }
    if (fs.existsSync(full)) return !f.size || fs.statSync(full).size === f.size;
  }
  return false;
}

/** Quick check: which pack files are missing (by existence and size). */
function verify(instId) {
  const gd = instances.gameDir(instId);
  const files = packFiles(instId);
  const missing = files.filter(f => !present(gd, f));
  return { total: files.length, missing: missing.map(describe) };
}

function describe(f) {
  return {
    path: f.path, title: f.title || path.basename(f.path), fileName: path.basename(f.path), folder: path.dirname(f.path),
    url: f.page || null, sha1: f.sha1 || null, size: f.size || null, canDownload: !!(f.urls && f.urls.length) || !!f.sha1,
  };
}

/** Try to fetch missing files: their own URLs first, then Modrinth by SHA-1. Returns what is still missing. */
async function repair(instId, report = () => {}) {
  const gd = instances.gameDir(instId);
  const files = packFiles(instId);
  const missing = files.filter(f => !present(gd, f));
  if (!missing.length) return { fixed: 0, missing: [] };
  let byHash = {};
  const hashes = missing.filter(f => f.sha1).map(f => f.sha1);
  if (hashes.length) {
    try {
      byHash = await fetchJson(`${MODRINTH}/version_files`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hashes, algorithm: 'sha1' }) });
    } catch {}
  }
  let fixed = 0;
  await pool(missing, 6, async (f) => {
    const dest = safeJoin(gd, f.path);
    const urls = [...(f.urls || [])];
    const v = f.sha1 && byHash[f.sha1];
    const alt = v && v.files.find(x => x.hashes && x.hashes.sha1 === f.sha1);
    if (alt) urls.push(alt.url);
    for (const url of urls) {
      try { await download(url, dest, { sha1: f.sha1, size: f.size }); fixed++; return; } catch {}
    }
  }, (d, t) => report('Fetching missing files', d / t));
  return { fixed, missing: files.filter(f => !present(gd, f)).map(describe) };
}

/** Place files the player downloaded by hand: match by SHA-1 or file name. */
async function addManual(instId, filePaths) {
  const gd = instances.gameDir(instId);
  const files = packFiles(instId);
  const missing = files.filter(f => !present(gd, f));
  const placed = [], unknown = [];
  for (const src of filePaths) {
    if (!fs.existsSync(src) || !fs.statSync(src).isFile()) continue;
    const name = path.basename(src);
    let match = missing.find(f => path.basename(f.path) === name);
    if (!match) {
      const sha1 = await hashFile(src, 'sha1');
      match = missing.find(f => f.sha1 === sha1);
    }
    if (match) {
      const dest = safeJoin(gd, match.path);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
      placed.push(match.path);
    } else if (/\.jar$/i.test(name)) {
      // Not part of the pack list (or the pack only knew its CurseForge id): it is a mod, so put it in mods.
      const dest = path.join(gd, 'mods', name);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
      placed.push(`mods/${name}`);
    } else unknown.push(name);
  }
  return { placed, unknown, ...verify(instId) };
}

/** Look in a folder (the Downloads folder by default) for missing files and move them into place. */
async function fromFolder(instId, dir) {
  if (!dir || !fs.existsSync(dir)) return { placed: [], ...verify(instId) };
  const gd = instances.gameDir(instId);
  const missing = packFiles(instId).filter(f => !present(gd, f));
  const wanted = new Map(missing.map(f => [path.basename(f.path), f]));
  const candidates = fs.readdirSync(dir).filter(n => wanted.has(n)).map(n => path.join(dir, n));
  const r = await addManual(instId, candidates);
  return r;
}

/** Stop tracking files the player decided to go without. */
function forget(instId, paths) {
  const set = new Set(paths);
  savePackFiles(instId, packFiles(instId).filter(f => !set.has(f.path)));
  return verify(instId);
}

module.exports = { forget, savePackFiles, packFiles, verify, repair, addManual, fromFolder };
