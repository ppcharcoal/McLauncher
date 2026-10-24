'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { ensure } = require('./paths');

const VERSION = require('../../package.json').version;
const USER_AGENT = `ppcharcoal/McLauncher/${VERSION} (github.com/ppcharcoal/McLauncher)`;

let electronNet = null;
function useElectronNet(net) { electronNet = net; }

async function rawFetch(url, opts = {}) {
  const headers = { 'User-Agent': USER_AGENT, ...(opts.headers || {}) };
  const f = electronNet ? electronNet.fetch.bind(electronNet) : fetch;
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await f(url, { ...opts, headers });
      if (res.status === 429 || res.status >= 500 || (res.status === 403 && /curse\.tools/.test(url))) {
        lastErr = new Error(`HTTP ${res.status} for ${url}`);
        await sleep(1000 * (attempt + 1) ** 2);
        continue;
      }
      return res;
    } catch (e) {
      lastErr = e;
      await sleep(600 * (attempt + 1));
    }
  }
  throw lastErr;
}

async function fetchJson(url, opts = {}) {
  const res = await rawFetch(url, opts);
  if (!res.ok) {
    let body = '';
    try { body = (await res.text()).slice(0, 300); } catch {}
    const err = new Error(`HTTP ${res.status} for ${url}${body ? ': ' + body : ''}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

function sha1File(file) { return hashFile(file, 'sha1'); }
function hashFile(file, algo) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash(algo);
    fs.createReadStream(file).on('data', d => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

/**
 * Download url to dest. Skips if the file exists with the right size (and sha1 when `verify`).
 * Verifies sha1 of fresh downloads when given.
 */
async function download(url, dest, { sha1, size, verify = false } = {}) {
  if (fs.existsSync(dest)) {
    const st = fs.statSync(dest);
    const sizeOk = size == null || st.size === size;
    if (sizeOk && (!verify || !sha1 || (await sha1File(dest)) === sha1)) return false;
  }
  ensure(path.dirname(dest));
  const tmp = `${dest}.${process.pid}-${Math.random().toString(36).slice(2, 8)}.part`;
  const res = await rawFetch(url);
  if (!res.ok || !res.body) throw new Error(`Download failed (HTTP ${res.status}): ${url}`);
  try { await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp)); }
  catch (e) { fs.rmSync(tmp, { force: true }); throw e; }
  if (sha1) {
    const got = await sha1File(tmp);
    if (got !== sha1) { fs.rmSync(tmp, { force: true }); throw new Error(`Checksum mismatch for ${path.basename(dest)}`); }
  }
  fs.renameSync(tmp, dest);
  return true;
}

/** Run async jobs with limited concurrency, reporting progress (done, total). */
async function pool(items, limit, worker, onProgress) {
  let i = 0, done = 0;
  const total = items.length;
  const errors = [];
  async function run() {
    while (i < total) {
      const idx = i++;
      try { await worker(items[idx], idx); } catch (e) { errors.push(e); }
      done++;
      if (onProgress) onProgress(done, total);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, total) }, run));
  if (errors.length) throw errors[0];
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { useElectronNet, rawFetch, fetchJson, download, pool, sha1File, hashFile, USER_AGENT, VERSION };
