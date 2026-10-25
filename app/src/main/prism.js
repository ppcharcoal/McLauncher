'use strict';
/**
 * Prism Launcher / MultiMC component instances.
 *
 * Packs like GT New Horizons (Java 17+) ship an mmc-pack.json whose components include custom
 * patches (patches/*.json) and launcher libraries (libraries/*.jar) that replace LWJGL, the main
 * class and JVM arguments. We keep those files and build the launch the way Prism does: each
 * component's JSON (its own patch, or Prism's metadata at meta.prismlauncher.org) is applied in
 * order on top of the previous ones.
 */
const fs = require('fs');
const path = require('path');
const { P, ensure, readJson, writeJson } = require('./paths');
const { fetchJson, download, pool } = require('./net');
const mojang = require('./mojang');
const instances = require('./instances');

const META = 'https://meta.prismlauncher.org/v1';
// Components Cairn can run natively. Anything else (or any custom patch) needs this engine.
const NATIVE_UIDS = new Set(['net.minecraft', 'org.lwjgl', 'org.lwjgl3', 'net.fabricmc.intermediary', 'net.fabricmc.fabric-loader', 'net.minecraftforge', 'net.neoforged']);

function dir(instId) { return path.join(instances.dirOf(instId), 'prism'); }

/** Does this Prism pack need the component engine? */
function needsEngine(pack, patchNames, hasLocalLibs) {
  const comps = (pack.components || []).filter(c => !c.disabled);
  if (patchNames.length || hasLocalLibs) return true;
  if (comps.some(c => !NATIVE_UIDS.has(c.uid))) return true;
  // LWJGL 3 on a version that normally uses LWJGL 2 (a replaced LWJGL) is custom too.
  const mc = comps.find(c => c.uid === 'net.minecraft');
  const old = mc && /^1\.(\d+)/.test(mc.version) && Number(/^1\.(\d+)/.exec(mc.version)[1]) <= 12;
  return !!(old && comps.some(c => c.uid === 'org.lwjgl3'));
}

/** Copy the pack's component files into the instance. `get(rel)` returns a Buffer or null; `list()` returns names. */
function store(instId, { packJson, patches, libraries }) {
  const d = ensure(dir(instId));
  fs.writeFileSync(path.join(d, 'mmc-pack.json'), packJson);
  if (patches.length) ensure(path.join(d, 'patches'));
  for (const [name, buf] of patches) fs.writeFileSync(path.join(d, 'patches', path.basename(name)), buf);
  if (libraries.length) ensure(path.join(d, 'libraries'));
  for (const [name, buf] of libraries) fs.writeFileSync(path.join(d, 'libraries', path.basename(name)), buf);
}

async function componentJson(instId, comp) {
  const local = path.join(dir(instId), 'patches', `${comp.uid}.json`);
  if (fs.existsSync(local)) return JSON.parse(fs.readFileSync(local, 'utf8'));
  const version = comp.version || comp.cachedVersion;
  if (!version) throw new Error(`The pack's component ${comp.cachedName || comp.uid} has no version.`);
  const cache = path.join(P.cache, 'prism-meta', comp.uid, `${version}.json`);
  const cached = readJson(cache, null);
  if (cached) return cached;
  const j = await fetchJson(`${META}/${encodeURIComponent(comp.uid)}/${encodeURIComponent(version)}.json`);
  writeJson(cache, j);
  return j;
}

const keyOf = (name) => mojang.libKey(name);

/** Apply components in order (Prism's LaunchProfile rules, simplified to what packs use). */
function merge(jsons) {
  const p = { mainClass: null, minecraftArguments: '', tweakers: [], jvmArgs: [], libraries: [], mavenFiles: [], mainJar: null, assetIndex: null, compatibleJavaMajors: null, compatibleJavaName: null, jarMods: [] };
  const addLib = (lib) => {
    const k = keyOf(lib.name);
    const i = p.libraries.findIndex(l => keyOf(l.name) === k);
    if (i >= 0) p.libraries[i] = lib; else p.libraries.push(lib);
  };
  for (const j of jsons) {
    if (j.mainClass) p.mainClass = j.mainClass;
    if (j.minecraftArguments) p.minecraftArguments = j.minecraftArguments;
    if (j['+minecraftArguments']) p.minecraftArguments += ' ' + j['+minecraftArguments'];
    if (j.tweakers) p.tweakers = [...j.tweakers];
    if (j['+tweakers']) p.tweakers.push(...j['+tweakers']);
    if (j['+jvmArgs']) p.jvmArgs.push(...j['+jvmArgs']);
    if (j.jvmArgs) p.jvmArgs.push(...j.jvmArgs);
    for (const l of j.libraries || []) addLib(l);
    for (const l of j['+libraries'] || []) addLib(l);
    for (const l of j['-libraries'] || []) { const k = keyOf(l.name); p.libraries = p.libraries.filter(x => keyOf(x.name) !== k); }
    for (const l of j.mavenFiles || []) p.mavenFiles.push(l);
    if (j.mainJar) p.mainJar = j.mainJar;
    if (j.assetIndex) p.assetIndex = j.assetIndex;
    if (j.compatibleJavaMajors) p.compatibleJavaMajors = j.compatibleJavaMajors;
    if (j.compatibleJavaName) p.compatibleJavaName = j.compatibleJavaName;
    if (j.jarMods && j.jarMods.length) p.jarMods.push(...j.jarMods);
  }
  return p;
}

/** Prism library → a library entry planLibraries() understands. Local libraries are copied into place. */
function normalizeLib(instId, lib) {
  const out = { ...lib };
  const rel = mojang.mavenPath(lib.name);
  if (lib['MMC-hint'] === 'local') {
    const name = path.basename(rel);
    const src = [path.join(dir(instId), 'libraries', name), path.join(instances.dirOf(instId), 'libraries', name)].find(f => fs.existsSync(f));
    if (!src) throw new Error(`The pack needs a library that is not in it: ${name}. Re-import the full pack.`);
    const dest = path.join(P.libraries, rel);
    if (!fs.existsSync(dest) || fs.statSync(dest).size !== fs.statSync(src).size) { ensure(path.dirname(dest)); fs.copyFileSync(src, dest); }
    out.downloads = { artifact: { path: rel, url: null } };
    delete out.url;
    return out;
  }
  if (lib['MMC-absoluteUrl']) { out.downloads = { artifact: { path: rel, url: lib['MMC-absoluteUrl'] } }; return out; }
  if (out.downloads && out.downloads.artifact && !out.downloads.artifact.path) out.downloads = { ...out.downloads, artifact: { ...out.downloads.artifact, path: rel } };
  if (out.downloads && out.downloads.classifiers) {
    const cls = {};
    for (const [k, v] of Object.entries(out.downloads.classifiers)) cls[k] = v.path ? v : { ...v, path: mojang.mavenPath(`${lib.name}:${k}`) };
    out.downloads = { ...out.downloads, classifiers: cls };
  }
  return out;
}

function readPack(instId) {
  const pack = readJson(path.join(dir(instId), 'mmc-pack.json'), null);
  if (!pack) throw new Error('This instance is missing its Prism component file (prism/mmc-pack.json). Re-import the pack.');
  return pack;
}

/** Summary for the UI: components with names and versions. */
function components(instId) {
  return (readPack(instId).components || []).map(c => ({ uid: c.uid, name: c.cachedName || c.uid, version: c.version || c.cachedVersion, disabled: !!c.disabled, custom: fs.existsSync(path.join(dir(instId), 'patches', `${c.uid}.json`)) }));
}

/**
 * Build the version for launch.prepare(): { java, version, clientJar, extraJvm, extraGame }.
 */
async function resolve(inst, settings, report) {
  const javaSel = require('./java');
  const comps = (readPack(inst.id).components || []).filter(c => !c.disabled);
  report('Reading pack components');
  const jsons = [];
  for (const c of comps) jsons.push(await componentJson(inst.id, c));
  const p = merge(jsons);
  if (!p.mainClass) throw new Error('The pack does not say how to start the game (no main class).');
  if (p.jarMods.length) throw new Error('This pack uses jar mods, which Cairn does not support yet.');

  // Java: the pack's compatible versions, unless the instance picks one.
  const majors = (p.compatibleJavaMajors || []).map(Number).filter(Boolean);
  const javaHint = { javaVersion: { component: p.compatibleJavaName || 'jre-legacy', majorVersion: majors[0] || 8 } };
  const java = await javaSel.resolve(inst, settings, javaHint, report, { compatibleMajors: majors });

  // Game jar
  let clientJar = null;
  if (p.mainJar && p.mainJar.downloads && p.mainJar.downloads.artifact) {
    const a = p.mainJar.downloads.artifact;
    clientJar = path.join(P.libraries, a.path || mojang.mavenPath(p.mainJar.name));
    report('Downloading Minecraft');
    await download(a.url, clientJar, { sha1: a.sha1, size: a.size });
  } else {
    const vanilla = await mojang.getVanillaJson(inst.mcVersion);
    clientJar = await mojang.installClient(vanilla, report);
  }

  // Files that must be downloaded but are not on the classpath (installers etc.)
  const extraFiles = p.mavenFiles.map(m => {
    const a = (m.downloads && m.downloads.artifact) || {};
    const rel = a.path || mojang.mavenPath(m.name);
    return { name: m.name, url: a.url || (m.url ? m.url.replace(/\/?$/, '/') + rel : null), dest: path.join(P.libraries, rel), sha1: a.sha1, size: a.size };
  }).filter(f => f.url);
  await pool(extraFiles.filter(f => !fs.existsSync(f.dest)), 6, f => download(f.url, f.dest, { sha1: f.sha1, size: f.size }), (d, t) => report('Downloading loader files', d / t));

  const libraries = p.libraries.map(l => normalizeLib(inst.id, l));
  const assetIndex = p.assetIndex || (await mojang.getVanillaJson(inst.mcVersion)).assetIndex;
  const version = { id: inst.mcVersion, mainClass: p.mainClass, minecraftArguments: p.minecraftArguments.trim(), libraries, assetIndex, assets: assetIndex.id };

  const extraJvm = [...p.jvmArgs];
  if (/forgewrapper/i.test(p.mainClass)) {
    const installer = extraFiles.find(f => /:installer$/.test(f.name));
    extraJvm.push(`-Dforgewrapper.librariesDir=${P.libraries}`, `-Dforgewrapper.minecraft=${clientJar}`);
    if (installer) extraJvm.push(`-Dforgewrapper.installer=${installer.dest}`);
  }
  const extraGame = p.tweakers.flatMap(t => ['--tweakClass', t]);
  return { java, version, clientJar, extraJvm, extraGame };
}

module.exports = { needsEngine, store, resolve, components, merge, NATIVE_UIDS };
