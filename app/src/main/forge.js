'use strict';
/**
 * Forge and NeoForge: version lists and client installation.
 *
 * Modern installers (Forge 1.13+, all NeoForge) ship an install_profile.json with libraries and
 * "processors" (small Java tools that patch the Minecraft jar). We run those processors ourselves,
 * the same way the official installer does for a client install. Legacy Forge (1.12.2 and older)
 * ships the finished version json and the Forge jar inside the installer; we just unpack them.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const AdmZip = require('adm-zip');
const { P, ensure, readJson, writeJson } = require('./paths');
const { fetchJson, rawFetch, download, pool, sha1File } = require('./net');
const mojang = require('./mojang');

const FORGE_MAVEN = 'https://maven.minecraftforge.net';
const NEO_MAVEN = 'https://maven.neoforged.net/releases';

// ---------- version lists ----------
let forgeMetaCache = null;
async function forgeMeta() {
  if (forgeMetaCache && Date.now() - forgeMetaCache.t < 10 * 60e3) return forgeMetaCache;
  let versions;
  try {
    versions = await fetchJson('https://files.minecraftforge.net/net/minecraftforge/forge/maven-metadata.json');
  } catch {
    // Fallback: the plain maven metadata
    const res = await rawFetch(`${FORGE_MAVEN}/net/minecraftforge/forge/maven-metadata.xml`);
    const xml = await res.text();
    versions = {};
    for (const m of xml.matchAll(/<version>([^<]+)<\/version>/g)) {
      const mc = m[1].split('-')[0];
      (versions[mc] = versions[mc] || []).push(m[1]);
    }
  }
  let promos = {};
  try { promos = (await fetchJson('https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json')).promos || {}; } catch {}
  forgeMetaCache = { t: Date.now(), versions, promos };
  return forgeMetaCache;
}

/** NeoForge version → Minecraft version. 21.1.x → 1.21.1, 21.0.x → 1.21, 26.1.0.x → 26.1 (new scheme). */
function neoToMc(v) {
  const parts = v.split('-')[0].split('.');
  const major = +parts[0], minor = +parts[1];
  if (major >= 25) {
    const patch = parts.length >= 4 ? +parts[2] : 0;
    return `${major}.${minor}${patch ? '.' + patch : ''}`;
  }
  return minor ? `1.${major}.${minor}` : `1.${major}`;
}

let neoCache = null;
async function neoMeta() {
  if (neoCache && Date.now() - neoCache.t < 10 * 60e3) return neoCache;
  const main = await fetchJson(`https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge`);
  let legacy = { versions: [] };
  try { legacy = await fetchJson(`https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/forge`); } catch {}
  const byMc = {};
  for (const v of main.versions || []) (byMc[neoToMc(v)] = byMc[neoToMc(v)] || []).push(v);
  for (const v of legacy.versions || []) { const mc = v.split('-')[0]; (byMc[mc] = byMc[mc] || []).push(v); }
  neoCache = { t: Date.now(), byMc };
  return neoCache;
}

/** Minecraft versions a loader supports. */
async function gameVersions(loader) {
  if (loader === 'forge') return Object.keys((await forgeMeta()).versions);
  return Object.keys((await neoMeta()).byMc);
}

/** Loader versions for a Minecraft version, newest first: [{ version, label, stable, recommended }]. */
async function loaderVersions(loader, mc) {
  if (loader === 'forge') {
    const meta = await forgeMeta();
    const rec = meta.promos[`${mc}-recommended`];
    const latest = meta.promos[`${mc}-latest`];
    return [...(meta.versions[mc] || [])].reverse().map(v => {
      const short = v.slice(mc.length + 1).replace(new RegExp(`-${mc.replace(/\./g, '\\.')}$`), '');
      return { version: v, label: short, stable: true, recommended: short === rec, latest: short === latest };
    });
  }
  const meta = await neoMeta();
  return [...(meta.byMc[mc] || [])].reverse().map(v => ({ version: v, label: v.replace(/^1\.20\.1-/, ''), stable: !/beta|alpha|rc/i.test(v), recommended: false }));
}

function installerUrl(loader, version) {
  if (loader === 'forge') return `${FORGE_MAVEN}/net/minecraftforge/forge/${version}/forge-${version}-installer.jar`;
  if (/^1\.20\.1-/.test(version)) return `${NEO_MAVEN}/net/neoforged/forge/${version}/forge-${version}-installer.jar`;
  return `${NEO_MAVEN}/net/neoforged/neoforge/${version}/neoforge-${version}-installer.jar`;
}

// ---------- install ----------
function markerFile(loader, version) { return path.join(P.versions, '.loaders', `${loader}-${version}.json`); }

/** Returns the installed version id, installing first if needed. */
async function ensureInstalled(loader, version, mcVersion, java, report) {
  const marker = readJson(markerFile(loader, version), null);
  if (marker && fs.existsSync(path.join(P.versions, marker.id, `${marker.id}.json`))) return marker.id;
  const label = loader === 'forge' ? 'Forge' : 'NeoForge';
  report(`Downloading ${label} installer`);
  const installer = path.join(ensure(path.join(P.cache, 'installers')), `${loader}-${version}-installer.jar`);
  await download(installerUrl(loader, version), installer);
  const zip = new AdmZip(installer);
  const profileEntry = zip.getEntry('install_profile.json');
  if (!profileEntry) throw new Error(`The ${label} installer has no install profile.`);
  const profile = JSON.parse(profileEntry.getData().toString('utf8'));
  let id;
  if (profile.versionInfo) id = await installLegacy(zip, profile, report);
  else id = await installModern(zip, installer, profile, mcVersion, java, label, report);
  writeJson(markerFile(loader, version), { id, installed: new Date().toISOString() });
  return id;
}

/** Forge 1.12.2 and older. */
async function installLegacy(zip, profile, report) {
  const info = profile.versionInfo;
  const id = info.id;
  writeJson(path.join(P.versions, id, `${id}.json`), info);
  // The Forge jar itself is packed inside the installer.
  const forgeLib = path.join(P.libraries, mojang.mavenPath(profile.install.path));
  const inner = zip.getEntry(profile.install.filePath);
  if (inner) { ensure(path.dirname(forgeLib)); fs.writeFileSync(forgeLib, inner.getData()); }
  report('Downloading Forge libraries');
  const plan = mojang.planLibraries({ libraries: info.libraries.filter(l => l.name !== profile.install.path) });
  const jobs = plan.jobs.filter(j => !fs.existsSync(j.dest));
  // Old Forge maven metadata has stale checksums for a few libraries; size/sha is not enforced here.
  await pool(jobs, 8, j => download(j.url, j.dest).catch(e => { throw new Error(`Could not download ${path.basename(j.dest)}: ${e.message}`); }),
    (d, t) => report('Downloading Forge libraries', d / t));
  return id;
}

function libPath(coord) { return path.join(P.libraries, mojang.mavenPath(coord)); }

/** Download (or extract from the installer) every library in a list of version-json libraries. */
async function fetchLibraries(zip, libs, label, report) {
  const jobs = [];
  for (const lib of libs || []) {
    const art = lib.downloads && lib.downloads.artifact;
    const rel = art && art.path ? art.path : mojang.mavenPath(lib.name);
    const dest = path.join(P.libraries, rel);
    if (fs.existsSync(dest) && (!art || !art.size || fs.statSync(dest).size === art.size)) continue;
    const packed = zip.getEntry(`maven/${rel}`);
    if (packed) { ensure(path.dirname(dest)); fs.writeFileSync(dest, packed.getData()); continue; }
    let url = art && art.url;
    if (!url && lib.url) url = lib.url.replace(/\/?$/, '/') + rel;
    if (!url) continue; // produced by a processor
    jobs.push({ url: mojang.fixMaven(url), dest, sha1: art && art.sha1, size: art && art.size });
  }
  await pool(jobs, 8, j => download(j.url, j.dest, { sha1: j.sha1, size: j.size }), (d, t) => report(`Downloading ${label} libraries`, d / t));
}

function mainClassOf(jar) {
  const mf = new AdmZip(jar).getEntry('META-INF/MANIFEST.MF');
  const m = mf && /^Main-Class:\s*(.+)$/m.exec(mf.getData().toString('utf8'));
  if (!m) throw new Error(`No Main-Class in ${path.basename(jar)}`);
  return m[1].trim();
}

function runJava(java, args, cwd, onLine) {
  return new Promise((resolve, reject) => {
    const p = spawn(java, args, { cwd, windowsHide: true });
    const tail = [];
    const feed = (c) => { for (const l of c.toString().split(/\r?\n/)) if (l.trim()) { tail.push(l); if (tail.length > 30) tail.shift(); onLine && onLine(l); } };
    p.stdout.on('data', feed); p.stderr.on('data', feed);
    p.on('error', reject);
    p.on('exit', code => code === 0 ? resolve() : reject(new Error(`Installer step failed (exit ${code}):\n${tail.slice(-12).join('\n')}`)));
  });
}

async function installModern(zip, installerPath, profile, mcVersion, java, label, report) {
  const versionEntry = zip.getEntry((profile.json || '/version.json').replace(/^\//, ''));
  const versionJson = JSON.parse(versionEntry.getData().toString('utf8'));
  const id = versionJson.id;

  // Libraries needed by the processors and by the game.
  await fetchLibraries(zip, profile.libraries, label, report);
  await fetchLibraries(zip, versionJson.libraries, label, report);

  // Vanilla client jar is an input of the processors.
  const vanilla = await mojang.getVanillaJson(mcVersion);
  const clientJar = await mojang.installClient(vanilla, report);

  const tmp = ensure(path.join(P.cache, 'installer-work', `${label}-${Date.now()}`));
  const data = {
    SIDE: 'client', MINECRAFT_JAR: clientJar, MINECRAFT_VERSION: mcVersion, ROOT: P.root,
    INSTALLER: installerPath, LIBRARY_DIR: P.libraries,
  };
  for (const [k, v] of Object.entries(profile.data || {})) {
    const val = v.client;
    if (val == null) continue;
    if (val.startsWith('[') && val.endsWith(']')) data[k] = libPath(val.slice(1, -1));
    else if (val.startsWith("'") && val.endsWith("'")) data[k] = val.slice(1, -1);
    else if (val.startsWith('/')) {
      const e = zip.getEntry(val.slice(1));
      const out = path.join(tmp, val.slice(1));
      ensure(path.dirname(out));
      if (e) fs.writeFileSync(out, e.getData());
      data[k] = out;
    } else data[k] = val;
  }
  const resolveArg = (a) => {
    if (a.startsWith('[') && a.endsWith(']')) return libPath(a.slice(1, -1));
    return a.replace(/\{([A-Z_]+)\}/g, (m, k) => (k in data ? data[k] : m));
  };

  const procs = (profile.processors || []).filter(p => !p.sides || p.sides.includes('client'));
  try {
    for (let i = 0; i < procs.length; i++) {
      const p = procs[i];
      // Skip a step whose outputs are already present and correct.
      if (p.outputs && Object.keys(p.outputs).length) {
        let ok = true;
        for (const [k, v] of Object.entries(p.outputs)) {
          const f = resolveArg(k), want = resolveArg(v).replace(/^'|'$/g, '');
          if (!fs.existsSync(f) || (await sha1File(f)) !== want) { ok = false; break; }
        }
        if (ok) continue;
      }
      report(`Installing ${label} (step ${i + 1} of ${procs.length})`, i / procs.length);
      const jar = libPath(p.jar);
      const cp = [jar, ...(p.classpath || []).map(libPath)].join(path.delimiter);
      const args = (p.args || []).map(resolveArg);
      await runJava(java, ['-cp', cp, mainClassOf(jar), ...args], P.root);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  writeJson(path.join(P.versions, id, `${id}.json`), versionJson);
  return id;
}

/** Turn a short loader version from a modpack ("47.2.0") into our full id ("1.20.1-47.2.0"). */
async function fullVersion(loader, mc, v) {
  if (loader === 'neoforge') return mc === '1.20.1' && !v.startsWith('1.20.1-') ? `1.20.1-${v}` : v;
  if (v.startsWith(mc + '-')) return v;
  try { const hit = (await loaderVersions('forge', mc)).find(x => x.label === v); if (hit) return hit.version; } catch {}
  return `${mc}-${v}`;
}
/** The short form modpack formats use. */
function shortVersion(loader, mc, v) {
  if (!v) return v;
  if (loader === 'neoforge') return v.replace(/^1\.20\.1-/, '');
  if (loader === 'forge') return v.startsWith(mc + '-') ? v.slice(mc.length + 1).replace(new RegExp(`-${mc.replace(/\./g, '\\.')}$`), '') : v;
  return v;
}

module.exports = { gameVersions, loaderVersions, ensureInstalled, neoToMc, installerUrl, fullVersion, shortVersion };
