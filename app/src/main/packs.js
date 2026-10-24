'use strict';
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const { P, safeJoin, ensure, readJson, writeJson } = require('./paths');
const instances = require('./instances');
const modrinth = require('./modrinth');
const curseforge = require('./curseforge');

/** Find a marker file anywhere in the archive (packs are often zipped inside an extra folder). Returns its folder prefix. */
function findRoot(names, marker, test = () => true) {
  const hits = names.filter(n => (n === marker || n.endsWith('/' + marker)) && n.split('/').length <= 4 && test(n)).sort((a, b) => a.length - b.length);
  return hits.length ? hits[0].slice(0, hits[0].length - marker.length) : null;
}

/** A new in-memory zip with only the entries under `root`, with that prefix removed. */
function rebase(zip, root) {
  if (!root) return zip;
  const out = new AdmZip();
  for (const e of zip.getEntries()) {
    if (e.isDirectory || !e.entryName.startsWith(root)) continue;
    out.addFile(e.entryName.slice(root.length), e.getData());
  }
  return out;
}

/**
 * Import any supported archive: Modrinth .mrpack, CurseForge zip (Fabric/Forge/NeoForge), Prism/MultiMC
 * export, McLauncher export. Anything else that holds game files (mods/, config/ …) returns
 * { needsSetup } so the player can pick the version and loader.
 */
async function importFile(file, report = () => {}) {
  const zip = new AdmZip(file);
  const names = zip.getEntries().map(e => e.entryName);
  const withMissing = (inst) => ({ instance: inst, blocked: inst.missing || [] });
  let r;
  if ((r = findRoot(names, 'modrinth.index.json')) != null) return withMissing(await modrinth.importMrpack(rebase(zip, r), { report }));
  if ((r = findRoot(names, 'mmc-pack.json')) != null) return { instance: await importPrism(zip, r), blocked: [] };
  if ((r = findRoot(names, 'mcl-export.json')) != null && names.includes(r + 'instance.json')) return { instance: importOwn(zip, r), blocked: [] };
  const isCf = (n) => { try { const j = JSON.parse(zip.getEntry(n).getData().toString('utf8')); return !!(j.minecraft && j.files); } catch { return false; } };
  if ((r = findRoot(names, 'manifest.json', isCf)) != null) return curseforge.importZip(rebase(zip, r), { report });
  const game = guessGameRoot(names);
  if (game != null) return { needsSetup: true, source: { type: 'zip', path: file, root: game }, guess: guessFromZip(zip, game, path.basename(file).replace(/\.(zip|mrpack)$/i, '')) };
  throw new Error('This file has no modpack or game files McLauncher recognizes (.mrpack, CurseForge, Prism/MultiMC, or a zip with mods/config folders).');
}

const GAME_DIRS = ['mods', 'config', 'resourcepacks', 'shaderpacks', 'saves', 'options.txt'];
function guessGameRoot(names) {
  for (const prefix of ['', '.minecraft/', 'minecraft/']) if (names.some(n => GAME_DIRS.some(d => n.startsWith(prefix + d)))) return prefix;
  const first = names[0] && names[0].split('/')[0] + '/';
  if (first) for (const prefix of [first, first + '.minecraft/', first + 'minecraft/']) if (names.some(n => GAME_DIRS.some(d => n.startsWith(prefix + d)))) return prefix;
  return null;
}

/** Guess loader and Minecraft version from the mods inside. */
function guessFromJars(jarBuffers, name) {
  const guess = { name, loader: 'vanilla', mcVersion: '' };
  for (const buf of jarBuffers.slice(0, 40)) {
    try {
      const z = new AdmZip(buf);
      const fm = z.getEntry('fabric.mod.json');
      if (fm) {
        guess.loader = 'fabric';
        const j = JSON.parse(fm.getData().toString('utf8'));
        const dep = j.depends && j.depends.minecraft;
        const m = /(\d+\.\d+(?:\.\d+)?)/.exec(Array.isArray(dep) ? dep[0] : dep || '');
        if (m && !guess.mcVersion) guess.mcVersion = m[1];
        continue;
      }
      const nt = z.getEntry('META-INF/neoforge.mods.toml');
      const ft = z.getEntry('META-INF/mods.toml');
      const toml = (nt || ft) && (nt || ft).getData().toString('utf8');
      if (toml) {
        if (guess.loader === 'vanilla') guess.loader = nt ? 'neoforge' : 'forge';
        const m = /modId\s*=\s*"minecraft"[\s\S]*?versionRange\s*=\s*"\[?(\d+\.\d+(?:\.\d+)?)/.exec(toml);
        if (m && !guess.mcVersion) guess.mcVersion = m[1];
      }
    } catch {}
  }
  return guess;
}
function guessFromZip(zip, root, name) {
  const jars = zip.getEntries().filter(e => e.entryName.startsWith(root + 'mods/') && /\.jar$/i.test(e.entryName)).map(e => e.getData());
  return guessFromJars(jars, name);
}

/** Import a folder: a Prism/MultiMC instance, an unzipped modpack, or a plain .minecraft-style folder. */
async function importFolder(dir, report = () => {}) {
  const has = (p) => fs.existsSync(path.join(dir, p));
  const zipOf = () => { const z = new AdmZip(); z.addLocalFolder(dir); return z; };
  if (has('mmc-pack.json')) return { instance: await importPrism(zipOf(), ''), blocked: [] };
  if (has('modrinth.index.json')) { const inst = await modrinth.importMrpack(zipOf(), { report }); return { instance: inst, blocked: inst.missing || [] }; }
  if (has('manifest.json')) return curseforge.importZip(zipOf(), { report });
  for (const sub of ['', '.minecraft', 'minecraft']) {
    const base = path.join(dir, sub);
    if (GAME_DIRS.some(d => fs.existsSync(path.join(base, d)))) {
      const modsDir = path.join(base, 'mods');
      const jars = fs.existsSync(modsDir) ? fs.readdirSync(modsDir).filter(n => /\.jar$/i.test(n)).slice(0, 40).map(n => fs.readFileSync(path.join(modsDir, n))) : [];
      return { needsSetup: true, source: { type: 'dir', path: base }, guess: guessFromJars(jars, path.basename(dir)) };
    }
  }
  throw new Error('This folder has no modpack or game files McLauncher recognizes.');
}

/** Copy the game files of an unrecognized zip or folder into an instance the player just created. */
function importRawInto(instId, source) {
  const gd = instances.gameDir(instId);
  if (source.type === 'dir') {
    for (const n of fs.readdirSync(source.path)) fs.cpSync(path.join(source.path, n), path.join(gd, n), { recursive: true });
  } else {
    extractPrefix(new AdmZip(source.path), source.root || '', gd);
  }
  return instances.get(instId);
}

function commonRoot(names) {
  const first = names[0] || '';
  const i = first.indexOf('/');
  if (i < 0) return '';
  const r = first.slice(0, i + 1);
  return names.every(n => n.startsWith(r)) ? r : '';
}

function extractPrefix(zip, prefix, dest) {
  for (const e of zip.getEntries()) {
    if (e.isDirectory || !e.entryName.startsWith(prefix)) continue;
    const rel = e.entryName.slice(prefix.length);
    if (!rel) continue;
    const out = safeJoin(dest, rel);
    ensure(path.dirname(out));
    fs.writeFileSync(out, e.getData());
  }
}

function importOwn(zip, root) {
  const meta = JSON.parse(zip.getEntry(root + 'instance.json').getData().toString('utf8'));
  const inst = instances.create({ name: meta.name, mcVersion: meta.mcVersion, loader: meta.loader, loaderVersion: meta.loaderVersion, memory: meta.memory });
  const dir = instances.dirOf(inst.id);
  extractPrefix(zip, root + 'minecraft/', path.join(dir, 'minecraft'));
  const c = zip.getEntry(root + 'content.json');
  if (c) fs.writeFileSync(path.join(dir, 'content.json'), c.getData());
  const icon = zip.getEntries().find(e => e.entryName.startsWith(root + 'icon.'));
  if (icon) {
    const name = icon.entryName.slice(root.length);
    fs.writeFileSync(path.join(dir, name), icon.getData());
    const m = readJson(path.join(dir, 'instance.json'), {}); m.iconFile = name; writeJson(path.join(dir, 'instance.json'), m);
  }
  instances.update(inst.id, { jvmArgs: meta.jvmArgs || '' });
  return instances.get(inst.id);
}

async function importPrism(zip, root) {
  const pack = JSON.parse(zip.getEntry(root + 'mmc-pack.json').getData().toString('utf8'));
  const comp = (uid) => (pack.components || []).find(c => c.uid === uid);
  const mc = comp('net.minecraft');
  if (!mc) throw new Error('The Prism instance has no Minecraft version.');
  if (comp('org.quiltmc.quilt-loader')) throw new Error('This Prism instance uses Quilt. McLauncher supports Fabric, Forge, NeoForge and vanilla.');
  const fab = comp('net.fabricmc.fabric-loader');
  const fg = comp('net.minecraftforge');
  const neo = comp('net.neoforged');
  const forge = require('./forge');
  let loader = 'vanilla', loaderVersion = null;
  if (fab) { loader = 'fabric'; loaderVersion = fab.version; }
  else if (neo) { loader = 'neoforge'; loaderVersion = await forge.fullVersion('neoforge', mc.version, neo.version); }
  else if (fg) { loader = 'forge'; loaderVersion = await forge.fullVersion('forge', mc.version, fg.version); }
  let name = 'Imported instance';
  const cfg = zip.getEntry(root + 'instance.cfg');
  if (cfg) { const m = /^name=(.*)$/m.exec(cfg.getData().toString('utf8')); if (m) name = m[1].trim(); }
  const inst = instances.create({ name, mcVersion: mc.version, loader, loaderVersion });
  const names = zip.getEntries().map(e => e.entryName);
  const gamePrefix = names.some(n => n.startsWith(root + '.minecraft/')) ? root + '.minecraft/' : root + 'minecraft/';
  extractPrefix(zip, gamePrefix, instances.gameDir(inst.id));
  return instances.get(inst.id);
}

/** Plain zip export of the instance (re-importable by McLauncher). */
function exportZip(instId, outFile, { include }) {
  const inst = instances.get(instId);
  const dir = instances.dirOf(instId);
  const gd = instances.gameDir(instId);
  const zip = new AdmZip();
  const meta = { name: inst.name, mcVersion: inst.mcVersion, loader: inst.loader, loaderVersion: inst.loaderVersion, memory: inst.memory, jvmArgs: inst.jvmArgs };
  zip.addFile('instance.json', Buffer.from(JSON.stringify(meta, null, 2)));
  zip.addFile('mcl-export.json', Buffer.from(JSON.stringify({ format: 1, exported: new Date().toISOString() })));
  if (fs.existsSync(path.join(dir, 'content.json'))) zip.addLocalFile(path.join(dir, 'content.json'));
  if (inst.iconFile && fs.existsSync(path.join(dir, inst.iconFile))) zip.addLocalFile(path.join(dir, inst.iconFile));
  for (const rel of include) {
    const full = safeJoin(gd, rel);
    if (!fs.existsSync(full)) continue;
    if (fs.statSync(full).isDirectory()) zip.addLocalFolder(full, `minecraft/${rel}`);
    else zip.addLocalFile(full, path.posix.dirname(`minecraft/${rel}`));
  }
  zip.writeZip(outFile);
}

/** Top-level entries a user can choose to include in an export. */
function exportCandidates(instId) {
  const gd = instances.gameDir(instId);
  const skip = new Set(['logs', 'crash-reports', '.fabric', 'natives', 'downloads', '.cache', 'debug', 'command_history.txt', 'usercache.json', 'usernamecache.json']);
  const defaults = new Set(['mods', 'config', 'resourcepacks', 'shaderpacks', 'options.txt', 'defaultconfigs', 'kubejs']);
  return fs.readdirSync(gd).filter(n => !skip.has(n)).map(n => {
    const st = fs.statSync(path.join(gd, n));
    let count = null;
    if (st.isDirectory()) count = fs.readdirSync(path.join(gd, n)).length;
    return { name: n, isDir: st.isDirectory(), count, checked: defaults.has(n) };
  }).sort((a, b) => (b.isDir - a.isDir) || a.name.localeCompare(b.name));
}

module.exports = { importFolder, importRawInto, guessFromJars, importFile, exportZip, exportCandidates };
