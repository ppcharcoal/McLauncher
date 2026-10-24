'use strict';
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const { P, ensure, readJson, writeJson } = require('./paths');
const { fetchJson, download, pool } = require('./net');

const MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const JAVA_ALL_URL = 'https://launchermeta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json';
const RESOURCES_URL = 'https://resources.download.minecraft.net';

let manifestCache = null;
async function getManifest(force = false) {
  const file = path.join(P.cache, 'version_manifest_v2.json');
  if (!force && manifestCache && Date.now() - manifestCache.t < 10 * 60e3) return manifestCache.data;
  try {
    const data = await fetchJson(MANIFEST_URL);
    writeJson(file, data);
    manifestCache = { t: Date.now(), data };
    return data;
  } catch (e) {
    const cached = readJson(file, null);
    if (cached) return cached;
    throw e;
  }
}

// ---------- rules / maven helpers (pure, unit-tested) ----------
const OS = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux';
const IS_WIN = OS === 'windows';
function archOk(osRule) {
  if (!osRule.arch) return true;
  if (osRule.arch === 'x86') return process.arch === 'ia32';
  if (osRule.arch === 'arm64') return process.arch === 'arm64';
  return true;
}
function rulesAllow(rules, features = {}) {
  if (!rules || !rules.length) return true;
  let allowed = false;
  for (const r of rules) {
    let match = true;
    if (r.os) {
      if (r.os.name && r.os.name !== OS) match = false;
      if (!archOk(r.os)) match = false;
    }
    if (r.features) {
      for (const [k, v] of Object.entries(r.features)) if (!!features[k] !== v) match = false;
    }
    if (match) allowed = r.action === 'allow';
  }
  return allowed;
}

function mavenPath(name) {
  const [coords, ext = 'jar'] = name.split('@');
  const parts = coords.split(':');
  const [group, artifact, version, classifier] = parts;
  const file = `${artifact}-${version}${classifier ? '-' + classifier : ''}.${ext}`;
  return [...group.split('.'), artifact, version, file].join('/');
}
function libKey(name) {
  const p = name.split('@')[0].split(':');
  return `${p[0]}:${p[1]}${p[3] ? ':' + p[3] : ''}`;
}
function nativeClassifierOk(classifier) {
  if (!classifier || !classifier.startsWith('natives-')) return true;
  if (!classifier.startsWith(`natives-${OS === 'osx' ? 'macos' : OS}`)) return false;
  const isArm = /arm64|aarch/.test(classifier);
  const isArm32 = /arm32/.test(classifier);
  const is32 = (/x86$/.test(classifier) && !/x86_64/.test(classifier)) || /-32$/.test(classifier);
  if (process.arch === 'ia32') return is32;
  if (process.arch === 'arm64') return isArm;
  if (process.arch === 'arm') return isArm32;
  return !isArm && !isArm32 && !is32;
}

/**
 * Turn a merged version json into download jobs + classpath + native jars.
 */
function planLibraries(version) {
  const jobs = [];
  const classpath = [];
  const nativeJars = [];
  const seen = new Set();
  for (const lib of version.libraries || []) {
    if (!rulesAllow(lib.rules)) continue;
    if (lib.clientreq === false) continue; // legacy Forge: server-only library
    const parts = lib.name.split(':');
    const classifier = parts[3];
    if (!nativeClassifierOk(classifier)) continue;
    const key = libKey(lib.name);
    // Legacy natives (pre-1.19): classifiers map
    if (lib.natives) {
      const nk = lib.natives[OS];
      if (nk) {
        const cls = nk.replace('${arch}', process.arch === 'ia32' ? '32' : '64');
        const art = lib.downloads && lib.downloads.classifiers && lib.downloads.classifiers[cls];
        if (art) {
          const dest = path.join(P.libraries, art.path);
          jobs.push({ url: art.url, dest, sha1: art.sha1, size: art.size });
          nativeJars.push({ file: dest, exclude: (lib.extract && lib.extract.exclude) || ['META-INF/'] });
        }
      }
      if (!(lib.downloads && lib.downloads.artifact)) continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    let art = lib.downloads && lib.downloads.artifact;
    if (!art) {
      const rel = mavenPath(lib.name);
      const base = fixMaven(lib.url || 'https://libraries.minecraft.net/').replace(/\/?$/, '/');
      art = { path: rel, url: base + rel, sha1: lib.sha1 || (lib.checksums && lib.checksums.length === 1 ? lib.checksums[0] : undefined), size: lib.size };
    }
    const dest = path.join(P.libraries, art.path);
    // Libraries with no URL are produced by the Forge/NeoForge installer; they are already on disk.
    if (art.url) jobs.push({ url: fixMaven(art.url), dest, sha1: art.sha1, size: art.size });
    classpath.push(dest);
    if (classifier && classifier.startsWith('natives-')) nativeJars.push({ file: dest, exclude: ['META-INF/'] });
  }
  return { jobs, classpath, nativeJars };
}

function fixMaven(url) {
  return url.replace(/^https?:\/\/files\.minecraftforge\.net\/maven\//, 'https://maven.minecraftforge.net/').replace(/^http:\/\//, 'https://');
}

// ---------- version install ----------
async function getVanillaJson(id) {
  const file = path.join(P.versions, id, `${id}.json`);
  const existing = readJson(file, null);
  if (existing) return existing;
  const manifest = await getManifest();
  const entry = manifest.versions.find(v => v.id === id);
  if (!entry) throw new Error(`Minecraft ${id} was not found in Mojang's version list.`);
  const json = await fetchJson(entry.url);
  writeJson(file, json);
  return json;
}

function mergeVersions(child, parent) {
  const merged = { ...parent, ...child };
  merged.id = child.id;
  merged.mainClass = child.mainClass || parent.mainClass;
  merged.libraries = [...(child.libraries || []), ...(parent.libraries || [])];
  if (parent.arguments || child.arguments) {
    merged.arguments = {
      game: [...((parent.arguments && parent.arguments.game) || []), ...((child.arguments && child.arguments.game) || [])],
      jvm: [...((parent.arguments && parent.arguments.jvm) || []), ...((child.arguments && child.arguments.jvm) || [])],
    };
  }
  if (child.minecraftArguments) merged.minecraftArguments = child.minecraftArguments;
  merged.downloads = parent.downloads;
  merged.assetIndex = parent.assetIndex;
  merged.assets = parent.assets;
  merged.javaVersion = parent.javaVersion || child.javaVersion;
  merged.clientId = parent.id;
  return merged;
}

async function installClient(vanilla, report) {
  const client = vanilla.downloads && vanilla.downloads.client;
  if (!client) throw new Error('This version has no client download.');
  const dest = path.join(P.versions, vanilla.id, `${vanilla.id}.jar`);
  report('Downloading Minecraft');
  await download(client.url, dest, { sha1: client.sha1, size: client.size });
  return dest;
}

async function installAssets(version, report) {
  const idx = version.assetIndex;
  const idxFile = path.join(P.assets, 'indexes', `${idx.id}.json`);
  await download(idx.url, idxFile, { sha1: idx.sha1, size: idx.size, verify: true });
  const index = readJson(idxFile, { objects: {} });
  const objects = Object.entries(index.objects || {});
  const seenHash = new Set();
  const jobs = objects.filter(([, o]) => !seenHash.has(o.hash) && seenHash.add(o.hash)).map(([name, o]) => ({
    name, hash: o.hash, size: o.size,
    dest: path.join(P.assets, 'objects', o.hash.slice(0, 2), o.hash),
  })).filter(j => !(fs.existsSync(j.dest) && fs.statSync(j.dest).size === j.size));
  if (jobs.length) {
    await pool(jobs, 16, j => download(`${RESOURCES_URL}/${j.hash.slice(0, 2)}/${j.hash}`, j.dest, { sha1: j.hash, size: j.size }),
      (d, t) => report(`Downloading assets`, d / t));
  }
  // Very old versions read assets from a flat folder.
  if (index.virtual || index.map_to_resources) {
    const virt = path.join(P.assets, 'virtual', idx.id);
    for (const [name, o] of objects) {
      const dest = path.join(virt, name);
      if (!fs.existsSync(dest)) { ensure(path.dirname(dest)); fs.copyFileSync(path.join(P.assets, 'objects', o.hash.slice(0, 2), o.hash), dest); }
    }
    return { virtualDir: virt, mapToResources: !!index.map_to_resources };
  }
  return {};
}

function extractNatives(nativeJars, dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  ensure(dir);
  for (const n of nativeJars) {
    if (!fs.existsSync(n.file)) continue;
    const zip = new AdmZip(n.file);
    for (const e of zip.getEntries()) {
      if (e.isDirectory) continue;
      if (n.exclude.some(x => e.entryName.startsWith(x))) continue;
      if (!(IS_WIN ? /\.dll$/i : /\.(so|so\.\d+)$/).test(e.entryName)) continue;
      fs.writeFileSync(path.join(dir, path.basename(e.entryName)), e.getData());
    }
  }
}

// ---------- Java runtime ----------
async function installJava(component, report) {
  let platform;
  if (IS_WIN) platform = { x64: 'windows-x64', ia32: 'windows-x86', arm64: 'windows-arm64' }[process.arch];
  else if (process.arch === 'arm64' || process.arch === 'arm') return null; // Mojang ships no Linux ARM runtime
  else platform = process.arch === 'ia32' ? 'linux-i386' : 'linux';
  if (!platform) return null;
  const dir = path.join(P.runtime, component);
  // javaw on Windows: no console window next to the game
  const java = path.join(dir, 'bin', IS_WIN ? 'javaw.exe' : 'java');
  const marker = path.join(dir, '.mcl-complete');
  if (fs.existsSync(java) && fs.existsSync(marker)) return java;
  report(`Downloading Java (${component})`);
  const all = await fetchJson(JAVA_ALL_URL);
  const list = (all[platform] || {})[component];
  if (!list || !list.length) return null;
  const manifest = await fetchJson(list[0].manifest.url);
  const entries = Object.entries(manifest.files);
  for (const [rel, f] of entries) if (f.type === 'directory') ensure(path.join(dir, rel));
  const files = entries.filter(([, f]) => f.type === 'file');
  await pool(files, 8, async ([rel, f]) => {
    const dest = path.join(dir, rel);
    await download(f.downloads.raw.url, dest, { sha1: f.downloads.raw.sha1, size: f.downloads.raw.size });
    if (f.executable && !IS_WIN) fs.chmodSync(dest, 0o755);
  }, (d, t) => report(`Downloading Java (${component})`, d / t));
  for (const [rel, f] of entries) {
    if (f.type !== 'link' || IS_WIN) continue;
    const dest = path.join(dir, rel);
    try { fs.rmSync(dest, { force: true }); fs.symlinkSync(f.target, dest); } catch {}
  }
  fs.writeFileSync(marker, new Date().toISOString());
  return java;
}

module.exports = {
  OS, fixMaven,
  getManifest, getVanillaJson, mergeVersions, installClient, installAssets, extractNatives, installJava,
  planLibraries, rulesAllow, mavenPath, libKey, nativeClassifierOk,
};
