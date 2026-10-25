'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const AdmZip = require('adm-zip');
const { P, ensure, readJson, writeJson, safeJoin } = require('./paths');
const { download } = require('./net');

const FOLDERS = {
  mods: { dir: 'mods', match: n => /\.jar(\.disabled)?$/i.test(n) },
  resourcepacks: { dir: 'resourcepacks', match: (n, d) => d || /\.zip(\.disabled)?$/i.test(n) },
  shaderpacks: { dir: 'shaderpacks', match: (n, d) => d || /\.zip(\.disabled)?$/i.test(n) },
  saves: { dir: 'saves', match: (n, d) => d },
  screenshots: { dir: 'screenshots', match: n => /\.png$/i.test(n) },
};

function dirOf(id) { return safeJoin(P.instances, id); }
function gameDir(id) { return ensure(path.join(dirOf(id), 'minecraft')); }
function metaFile(id) { return path.join(dirOf(id), 'instance.json'); }
function contentFile(id) { return path.join(dirOf(id), 'content.json'); }

function slug(name) {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'instance';
  let id = base, n = 2;
  while (fs.existsSync(path.join(P.instances, id))) id = `${base}-${n++}`;
  return id;
}

function list() {
  const out = [];
  for (const id of fs.readdirSync(P.instances)) {
    const m = readJson(path.join(P.instances, id, 'instance.json'), null);
    if (m) out.push(withIcon({ ...m, id }));
  }
  return out.sort((a, b) => (b.lastPlayed || b.created || 0) - (a.lastPlayed || a.created || 0));
}
function withIcon(m) {
  if (m.iconFile && fs.existsSync(path.join(dirOf(m.id), m.iconFile))) {
    const st = fs.statSync(path.join(dirOf(m.id), m.iconFile));
    m.iconUrl = `mcl://instances/${encodeURIComponent(m.id)}/${encodeURIComponent(m.iconFile)}?v=${st.mtimeMs | 0}`;
  } else m.iconUrl = null;
  return m;
}
function get(id) {
  const m = readJson(metaFile(id), null);
  if (!m) throw new Error('Instance not found: ' + id);
  return withIcon({ ...m, id });
}

function create({ name, mcVersion, loader = 'fabric', loaderVersion = null, memory = 4096, source = null }) {
  if (!name || !mcVersion) throw new Error('Name and Minecraft version are required.');
  const id = slug(name);
  ensure(dirOf(id));
  const m = { id, name, mcVersion, loader, loaderVersion, memory, jvmArgs: '', javaPath: '', created: Date.now(), lastPlayed: 0, playTime: 0, source };
  writeJson(metaFile(id), m);
  for (const f of ['mods', 'resourcepacks', 'shaderpacks', 'saves']) ensure(path.join(gameDir(id), f));
  return get(id);
}

function update(id, patch) {
  const m = readJson(metaFile(id), null);
  if (!m) throw new Error('Instance not found');
  const allowed = ['name', 'mcVersion', 'loader', 'loaderVersion', 'memory', 'jvmArgs', 'javaPath', 'lastPlayed', 'playTime', 'width', 'height', 'source', 'nativeWayland', 'javaMajor', 'envVars', 'prism', 'components'];
  for (const k of allowed) if (k in patch) m[k] = patch[k];
  writeJson(metaFile(id), m);
  return get(id);
}

function remove(id, shell) {
  const d = dirOf(id);
  if (shell) return shell.trashItem(d).catch(() => fs.rmSync(d, { recursive: true, force: true }));
  fs.rmSync(d, { recursive: true, force: true });
}

function duplicate(id) {
  const src = get(id);
  const nid = slug(src.name + ' copy');
  fs.cpSync(dirOf(id), dirOf(nid), { recursive: true });
  return update(nid, { name: src.name + ' (copy)', lastPlayed: 0, playTime: 0 });
}

async function setIcon(id, { file, url }) {
  const d = dirOf(id);
  for (const f of fs.readdirSync(d)) if (/^icon\./.test(f)) fs.rmSync(path.join(d, f));
  let ext;
  if (file) {
    ext = (path.extname(file).toLowerCase() || '.png').replace('.jpeg', '.jpg');
    if (!['.png', '.jpg', '.webp', '.gif'].includes(ext)) throw new Error('Pick a PNG, JPG, WebP or GIF image.');
    fs.copyFileSync(file, path.join(d, 'icon' + ext));
  } else if (url) {
    ext = (path.extname(new URL(url).pathname).toLowerCase() || '.png').replace('.jpeg', '.jpg');
    if (!['.png', '.jpg', '.webp', '.gif'].includes(ext)) ext = '.png';
    await download(url, path.join(d, 'icon' + ext));
  } else {
    const m = readJson(metaFile(id), {}); delete m.iconFile; writeJson(metaFile(id), m); return get(id);
  }
  const m = readJson(metaFile(id), {});
  m.iconFile = 'icon' + ext;
  writeJson(metaFile(id), m);
  return get(id);
}

// ---------- content index (where each file came from) ----------
function readContent(id) { return readJson(contentFile(id), { files: {}, meta: {} }); }
function writeContent(id, c) { writeJson(contentFile(id), c); }
function recordFile(id, rel, info) {
  const c = readContent(id);
  c.files[rel] = info;
  writeContent(id, c);
}

function saveIcon(zip, entryPath, file) {
  const ie = entryPath && zip.getEntry(entryPath.replace(/^\//, ''));
  if (!ie) return null;
  const name = crypto.createHash('sha1').update(file).digest('hex').slice(0, 16) + '.png';
  fs.writeFileSync(path.join(ensure(path.join(P.cache, 'modicons')), name), ie.getData());
  return `mcl://cache/modicons/${name}`;
}

/** Read a string value `key = "..."` (or '...', or """...""") from a TOML snippet. */
function tomlStr(src, key) {
  const m = new RegExp(`^\\s*${key}\\s*=\\s*(?:"""([\\s\\S]*?)"""|"([^"]*)"|'([^']*)')`, 'm').exec(src);
  return m ? (m[1] ?? m[2] ?? m[3]) : null;
}

/** Read name/version/icon from a mod jar: Fabric (fabric.mod.json), Forge/NeoForge (mods.toml), legacy Forge (mcmod.info). */
function fabricMeta(file) {
  try {
    const zip = new AdmZip(file);
    const fe = zip.getEntry('fabric.mod.json');
    if (fe) {
      const j = JSON.parse(fe.getData().toString('utf8').replace(/^﻿/, ''));
      const iconPath = typeof j.icon === 'string' ? j.icon : (j.icon && Object.values(j.icon).pop());
      return { modId: j.id, title: j.name || j.id, version: j.version, description: j.description || '', icon: saveIcon(zip, iconPath, file), env: j.environment || '*', loader: 'fabric' };
    }
    const te = zip.getEntry('META-INF/neoforge.mods.toml') || zip.getEntry('META-INF/mods.toml');
    if (te) {
      const toml = te.getData().toString('utf8');
      const block = (toml.split(/^\s*\[\[mods\]\]\s*$/m)[1] || '').split(/^\s*\[/m)[0];
      let version = tomlStr(block, 'version');
      if (!version || version.includes('${')) {
        const mf = zip.getEntry('META-INF/MANIFEST.MF');
        const m = mf && /^Implementation-Version:\s*(.+)$/m.exec(mf.getData().toString('utf8'));
        version = m ? m[1].trim() : null;
      }
      const logo = tomlStr(block, 'logoFile') || tomlStr(toml, 'logoFile');
      return {
        modId: tomlStr(block, 'modId'), title: tomlStr(block, 'displayName') || tomlStr(block, 'modId'), version,
        description: (tomlStr(block, 'description') || '').trim(), icon: saveIcon(zip, logo, file), env: '*',
        loader: te.entryName.includes('neoforge') ? 'neoforge' : 'forge',
      };
    }
    const me = zip.getEntry('mcmod.info');
    if (me) {
      let j = JSON.parse(me.getData().toString('utf8').replace(/^﻿/, '').replace(/\n/g, ' '));
      if (j.modList) j = j.modList;
      const m = Array.isArray(j) ? j[0] : j;
      if (m) return { modId: m.modid, title: m.name || m.modid, version: m.version, description: m.description || '', icon: saveIcon(zip, m.logoFile, file), env: '*', loader: 'forge' };
    }
    return {};
  } catch { return {}; }
}

/** List one content folder (mods/resourcepacks/shaderpacks/saves/screenshots). */
function listContent(id, kind) {
  const spec = FOLDERS[kind];
  if (!spec) throw new Error('Unknown folder ' + kind);
  const dir = ensure(path.join(gameDir(id), spec.dir));
  const c = readContent(id);
  let dirty = false;
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const isDir = ent.isDirectory();
    if (!spec.match(ent.name, isDir)) continue;
    const full = path.join(dir, ent.name);
    const st = fs.statSync(full);
    const enabled = !ent.name.endsWith('.disabled');
    const baseName = ent.name.replace(/\.disabled$/, '');
    const rel = `${spec.dir}/${baseName}`;
    const item = { file: ent.name, rel, enabled, isDir, size: st.size, mtime: st.mtimeMs, title: baseName };
    const src = c.files[rel];
    if (src) Object.assign(item, { source: src.source, projectId: src.projectId, versionId: src.versionId, title: src.title || baseName, icon: src.iconUrl || null, slug: src.slug, env: src.env });
    if (kind === 'mods') {
      const key = `${baseName}|${st.size}|${st.mtimeMs | 0}`;
      let meta = c.meta[key];
      if (!meta) { meta = fabricMeta(full, id); c.meta[key] = meta; dirty = true; }
      item.modVersion = meta.version;
      item.description = meta.description;
      if (!src) { item.title = meta.title || baseName; item.icon = meta.icon || null; }
      else if (!item.icon) item.icon = meta.icon || null;
      if (meta.env && !item.env) item.env = meta.env;
    }
    if (kind === 'saves') {
      const icon = path.join(full, 'icon.png');
      if (fs.existsSync(icon)) item.icon = `mcl://instances/${encodeURIComponent(id)}/minecraft/saves/${encodeURIComponent(ent.name)}/icon.png?v=${st.mtimeMs | 0}`;
      const ld = path.join(full, 'level.dat');
      if (fs.existsSync(ld)) item.mtime = fs.statSync(ld).mtimeMs;
      item.size = null;
    }
    if (kind === 'screenshots') item.icon = `mcl://instances/${encodeURIComponent(id)}/minecraft/screenshots/${encodeURIComponent(ent.name)}`;
    out.push(item);
  }
  if (dirty) writeContent(id, c);
  return out.sort((a, b) => kind === 'saves' || kind === 'screenshots' ? b.mtime - a.mtime : a.title.localeCompare(b.title));
}

function toggleContent(id, kind, file) {
  const dir = path.join(gameDir(id), FOLDERS[kind].dir);
  const from = safeJoin(dir, file);
  const to = file.endsWith('.disabled') ? from.replace(/\.disabled$/, '') : from + '.disabled';
  fs.renameSync(from, to);
}

async function deleteContent(id, kind, file, shell) {
  const dir = path.join(gameDir(id), FOLDERS[kind].dir);
  const full = safeJoin(dir, file);
  try { await shell.trashItem(full); } catch { fs.rmSync(full, { recursive: true, force: true }); }
  const c = readContent(id);
  delete c.files[`${FOLDERS[kind].dir}/${file.replace(/\.disabled$/, '')}`];
  writeContent(id, c);
}

function addFiles(id, kind, files) {
  const dir = ensure(path.join(gameDir(id), FOLDERS[kind].dir));
  for (const f of files) {
    const st = fs.statSync(f);
    if (st.isDirectory()) fs.cpSync(f, path.join(dir, path.basename(f)), { recursive: true });
    else fs.copyFileSync(f, path.join(dir, path.basename(f)));
  }
}

/** Generic file browser inside the instance's game folder. */
function listDir(id, rel = '') {
  const base = gameDir(id);
  const dir = safeJoin(base, rel);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).map(e => {
    let st = null; try { st = fs.statSync(path.join(dir, e.name)); } catch {}
    return { name: e.name, isDir: e.isDirectory(), size: st ? st.size : 0, mtime: st ? st.mtimeMs : 0 };
  }).sort((a, b) => (b.isDir - a.isDir) || a.name.localeCompare(b.name));
}
function resolvePath(id, rel = '') { return safeJoin(gameDir(id), rel); }

/** After installing a mod, remove other jars that contain the same Fabric mod id (e.g. Fabric API from both sources). */
function dedupeMod(id, fileName) {
  const dir = path.join(gameDir(id), 'mods');
  const items = listContent(id, 'mods');
  const c = readContent(id);
  const meta = (it) => c.meta[`${it.file.replace(/\.disabled$/, '')}|${it.size}|${it.mtime | 0}`] || {};
  const added = items.find(it => it.file === fileName);
  if (!added || !meta(added).modId) return;
  for (const it of items) {
    if (it.file === fileName || meta(it).modId !== meta(added).modId) continue;
    fs.rmSync(path.join(dir, it.file), { force: true });
    delete c.files[it.rel];
  }
  writeContent(id, c);
}

module.exports = {
  dedupeMod,
  FOLDERS, list, get, create, update, remove, duplicate, setIcon, dirOf, gameDir,
  readContent, writeContent, recordFile, listContent, toggleContent, deleteContent, addFiles, listDir, resolvePath, slug, fabricMeta,
};
