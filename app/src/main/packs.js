'use strict';
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const { P, safeJoin, ensure, readJson, writeJson } = require('./paths');
const instances = require('./instances');
const modrinth = require('./modrinth');
const curseforge = require('./curseforge');

/** Import any supported archive: .mrpack, CurseForge zip, McLauncher zip, Prism/MultiMC zip. */
async function importFile(file, report = () => {}) {
  const zip = new AdmZip(file);
  const names = zip.getEntries().map(e => e.entryName);
  if (names.includes('modrinth.index.json')) return { instance: await modrinth.importMrpack(zip, { report }), blocked: [] };
  if (names.includes('manifest.json')) return curseforge.importZip(zip, { report });
  const root = commonRoot(names);
  if (names.includes(root + 'instance.json') && names.includes(root + 'mcl-export.json')) return { instance: importOwn(zip, root), blocked: [] };
  if (names.includes(root + 'mmc-pack.json')) return { instance: await importPrism(zip, root), blocked: [] };
  throw new Error('This file is not a modpack McLauncher understands (.mrpack, CurseForge zip, Prism/MultiMC zip or McLauncher export).');
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

module.exports = { importFile, exportZip, exportCandidates };
