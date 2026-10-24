'use strict';
const fs = require('fs');
const path = require('path');
const { P, ensure, safeJoin } = require('./paths');
const { fetchJson, download, pool } = require('./net');
const instances = require('./instances');

// Without a personal API key we use the public CurseForge proxy at curse.tools.
let apiKey = '';
function setKey(k) { apiKey = (k || '').trim(); }
function base() { return apiKey ? 'https://api.curseforge.com/v1' : 'https://api.curse.tools/v1/cf'; }
function headers(extra = {}) { return { Accept: 'application/json', ...(apiKey ? { 'x-api-key': apiKey } : {}), ...extra }; }
const get = (p) => fetchJson(base() + p, { headers: headers() });
const post = (p, body) => fetchJson(base() + p, { method: 'POST', headers: headers({ 'Content-Type': 'application/json' }), body: JSON.stringify(body) });

const GAME = 432;
const CLASS = { mod: 6, resourcepack: 12, shader: 6552, modpack: 4471 };
const CLASS_FOLDER = { 6: 'mods', 12: 'resourcepacks', 6552: 'shaderpacks' };
const KIND_FOLDER = { mod: 'mods', resourcepack: 'resourcepacks', shader: 'shaderpacks' };
const LIBRARY_CATEGORY = 421; // "API and Library"
const FABRIC = 4;
const SORT = { relevance: 2, downloads: 6, follows: 2, newest: 11, updated: 3 };

function sha1Of(file) { const h = (file.hashes || []).find(x => x.algo === 1); return h ? h.value : undefined; }
function pageUrl(mod, fileId) {
  const seg = { 6: 'mc-mods', 12: 'texture-packs', 6552: 'shaders', 4471: 'modpacks' }[mod.classId] || 'mc-mods';
  return `https://www.curseforge.com/minecraft/${seg}/${mod.slug}${fileId ? '/files/' + fileId : ''}`;
}

async function search({ query = '', type = 'mod', gameVersion = '', env = 'all', offset = 0, sort = 'relevance', limit = 20 }) {
  const params = { gameId: GAME, classId: CLASS[type], searchFilter: query, index: offset, pageSize: limit, sortField: SORT[sort] || 1, sortOrder: 'desc' };
  if (gameVersion) params.gameVersion = gameVersion;
  if (type === 'mod' || type === 'modpack') params.modLoaderType = FABRIC;
  if (type === 'mod' && env === 'library') params.categoryId = LIBRARY_CATEGORY;
  const res = await get('/mods/search?' + new URLSearchParams(params));
  return {
    total: Math.min(res.pagination.totalCount, 10000 - limit),
    hits: res.data.map(m => ({
      source: 'curseforge', id: String(m.id), slug: m.slug, title: m.name, description: m.summary,
      author: (m.authors && m.authors[0] && m.authors[0].name) || '', icon: m.logo && (m.logo.thumbnailUrl || m.logo.url),
      downloads: m.downloadCount, categories: (m.categories || []).map(c => c.name),
      isLibrary: (m.categories || []).some(c => c.id === LIBRARY_CATEGORY), env: 'unknown',
      gallery: m.screenshots && m.screenshots[0] ? m.screenshots[0].url : null, type, url: pageUrl(m), updated: m.dateModified,
    })),
  };
}

async function project(id) {
  const m = (await get(`/mods/${id}`)).data;
  let body = '';
  try { body = (await get(`/mods/${id}/description`)).data; } catch {}
  return {
    source: 'curseforge', id: String(m.id), slug: m.slug, title: m.name, description: m.summary, bodyHtml: body,
    icon: m.logo && m.logo.thumbnailUrl, gallery: (m.screenshots || []).map(s => s.url), downloads: m.downloadCount,
    categories: (m.categories || []).map(c => c.name), url: pageUrl(m), env: 'unknown',
    isLibrary: (m.categories || []).some(c => c.id === LIBRARY_CATEGORY),
  };
}

async function versions(id, { type = 'mod', gameVersion = '' } = {}) {
  const params = { pageSize: 50 };
  if (gameVersion) params.gameVersion = gameVersion;
  if (type === 'mod' || type === 'modpack') params.modLoaderType = FABRIC;
  const res = await get(`/mods/${id}/files?` + new URLSearchParams(params));
  return res.data.map(f => ({
    id: String(f.id), name: f.displayName, number: f.displayName, type: ['', 'release', 'beta', 'alpha'][f.releaseType] || 'release',
    gameVersions: f.gameVersions, date: f.fileDate, fileName: f.fileName, downloadUrl: f.downloadUrl, sha1: sha1Of(f), size: f.fileLength,
    dependencies: f.dependencies || [], projectId: String(f.modId),
  }));
}

class BlockedError extends Error {
  constructor(items) { super('Some files must be downloaded from the CurseForge website.'); this.blocked = items; }
}

async function installVersion(instId, v, kind, info = {}, seen = new Set(), report = () => {}) {
  const inst = instances.get(instId);
  if (seen.has(v.projectId)) return [];
  seen.add(v.projectId);
  const folder = KIND_FOLDER[kind];
  if (!v.downloadUrl) {
    let m = info.mod; try { m = m || (await get(`/mods/${v.projectId}`)).data; } catch {}
    throw new BlockedError([{ title: info.title || v.fileName, fileName: v.fileName, url: m ? pageUrl(m, v.id) : 'https://www.curseforge.com', folder }]);
  }
  const content = instances.readContent(instId);
  for (const [rel, e] of Object.entries(content.files)) {
    if (e.projectId === v.projectId && e.source === 'curseforge' && rel !== `${folder}/${v.fileName}`) {
      for (const cand of [rel, rel + '.disabled']) { const full = path.join(instances.gameDir(instId), cand); if (fs.existsSync(full)) fs.rmSync(full, { force: true, recursive: true }); }
      delete content.files[rel];
    }
  }
  instances.writeContent(instId, content);
  report(`Downloading ${info.title || v.fileName}`);
  await download(v.downloadUrl, safeJoin(path.join(instances.gameDir(instId), folder), v.fileName), { sha1: v.sha1, size: v.size });
  let title = info.title, icon = info.icon;
  if (!title) { try { const m = (await get(`/mods/${v.projectId}`)).data; title = m.name; icon = m.logo && m.logo.thumbnailUrl; } catch {} }
  instances.recordFile(instId, `${folder}/${v.fileName}`, { source: 'curseforge', projectId: v.projectId, versionId: v.id, title: title || v.fileName, iconUrl: icon || null, sha1: v.sha1 });
  const out = [title || v.fileName];
  if (folder === 'mods') { try { instances.dedupeMod(instId, v.fileName); } catch {} }
  for (const d of v.dependencies) {
    if (d.relationType !== 3) continue;
    const depId = String(d.modId);
    if (seen.has(depId) || Object.values(instances.readContent(instId).files).some(e => e.projectId === depId)) continue;
    const list = await versions(depId, { type: 'mod', gameVersion: inst.mcVersion });
    const pick = list.find(x => x.type !== 'alpha') || list[0];
    if (pick) out.push(...await installVersion(instId, pick, 'mod', {}, seen, report));
  }
  return out;
}

async function installProject(instId, projectId, kind, info = {}, report) {
  const inst = instances.get(instId);
  const list = await versions(projectId, { type: kind, gameVersion: inst.mcVersion });
  const pick = list.find(v => v.type !== 'alpha') || list[0];
  if (!pick) throw new Error(`No file of ${info.title || 'this project'} supports Minecraft ${inst.mcVersion}${kind === 'mod' ? ' with Fabric' : ''}.`);
  return installVersion(instId, pick, kind, info, new Set(), report);
}

/** Import a CurseForge modpack zip (manifest.json). Returns { instance, blocked }. */
async function importZip(zip, { name, iconUrl, source, report = () => {} } = {}) {
  const me = zip.getEntry('manifest.json');
  if (!me) throw new Error('Not a CurseForge modpack (manifest.json missing).');
  const manifest = JSON.parse(me.getData().toString('utf8'));
  const loaders = (manifest.minecraft && manifest.minecraft.modLoaders) || [];
  const primary = loaders.find(l => l.primary) || loaders[0];
  let loader = 'vanilla', loaderVersion = null;
  if (primary) {
    if (!primary.id.startsWith('fabric-')) throw new Error(`This modpack needs ${primary.id.split('-')[0]}. McLauncher supports Fabric and vanilla only.`);
    loader = 'fabric'; loaderVersion = primary.id.slice('fabric-'.length);
  }
  const inst = instances.create({ name: name || manifest.name || 'Modpack', mcVersion: manifest.minecraft.version, loader, loaderVersion, source: source || { type: 'curseforge-zip', name: manifest.name, version: manifest.version } });
  try {
    const gd = instances.gameDir(inst.id);
    const wanted = (manifest.files || []).filter(f => f.required !== false);
    report('Resolving modpack files');
    const fileMap = {}, modMap = {};
    if (apiKey) {
      for (let i = 0; i < wanted.length; i += 100) {
        const chunk = wanted.slice(i, i + 100);
        for (const f of (await post('/mods/files', { fileIds: chunk.map(x => x.fileID) })).data) fileMap[f.id] = f;
        for (const m of (await post('/mods', { modIds: chunk.map(x => x.projectID) })).data) modMap[m.id] = m;
      }
    } else {
      // The public proxy only allows GET requests, so look files up one by one.
      await pool(wanted, 6, async (w) => {
        const [f, m] = await Promise.all([get(`/mods/${w.projectID}/files/${w.fileID}`), get(`/mods/${w.projectID}`)]);
        fileMap[f.data.id] = f.data; modMap[m.data.id] = m.data;
      }, (d, t) => report('Resolving modpack files', d / t));
    }
    const blocked = [];
    const content = instances.readContent(inst.id);
    const jobs = [];
    for (const w of wanted) {
      const f = fileMap[w.fileID], m = modMap[w.projectID];
      if (!f) continue;
      const folder = (m && CLASS_FOLDER[m.classId]) || 'mods';
      if (!f.downloadUrl) { blocked.push({ title: m ? m.name : f.displayName, fileName: f.fileName, url: m ? pageUrl(m, f.id) : 'https://www.curseforge.com', folder }); continue; }
      jobs.push({ f, m, folder });
      content.files[`${folder}/${f.fileName}`] = { source: 'curseforge', projectId: String(w.projectID), versionId: String(f.id), title: m ? m.name : f.displayName, iconUrl: m && m.logo ? m.logo.thumbnailUrl : null, sha1: sha1Of(f) };
    }
    await pool(jobs, 8, j => download(j.f.downloadUrl, safeJoin(path.join(gd, j.folder), j.f.fileName), { sha1: sha1Of(j.f), size: j.f.fileLength }),
      (d, t) => report('Downloading modpack files', d / t));
    instances.writeContent(inst.id, content);
    const ov = (manifest.overrides || 'overrides').replace(/\/?$/, '/');
    require('./modrinth').extractOverrides(zip, gd, [ov]);
    if (iconUrl) { try { await instances.setIcon(inst.id, { url: iconUrl }); } catch {} }
    return { instance: instances.get(inst.id), blocked };
  } catch (e) {
    instances.remove(inst.id);
    throw e;
  }
}

async function installModpack(projectId, fileId, { title, icon, report = () => {} }) {
  const AdmZip = require('adm-zip');
  const f = (await get(`/mods/${projectId}/files/${fileId}`)).data;
  if (!f.downloadUrl) {
    const m = (await get(`/mods/${projectId}`)).data;
    throw new BlockedError([{ title: title || m.name, fileName: f.fileName, url: pageUrl(m, fileId), folder: 'modpack' }]);
  }
  const tmp = path.join(ensure(path.join(P.cache, 'packs')), f.fileName);
  report('Downloading modpack');
  await download(f.downloadUrl, tmp, { sha1: sha1Of(f), size: f.fileLength });
  try {
    return await importZip(new AdmZip(tmp), { name: title, iconUrl: icon, report, source: { type: 'curseforge', projectId: String(projectId), versionId: String(fileId), version: f.displayName } });
  } finally { fs.rmSync(tmp, { force: true }); }
}

module.exports = { setKey, search, project, versions, installVersion, installProject, importZip, installModpack, BlockedError };
