'use strict';
const fs = require('fs');
const path = require('path');
const { ensure, safeJoin, P } = require('./paths');
const { fetchJson, download, pool, hashFile } = require('./net');
const instances = require('./instances');

const API = 'https://api.modrinth.com/v2';
const q = (o) => new URLSearchParams(o).toString();

const KIND_FOLDER = { mod: 'mods', resourcepack: 'resourcepacks', shader: 'shaderpacks' };
const KIND_LOADERS = { mod: ['fabric'], resourcepack: ['minecraft'], shader: ['iris', 'optifine', 'canvas', 'vanilla'] };

function envFacets(env) {
  switch (env) {
    case 'client': return [['client_side:required', 'client_side:optional'], ['server_side:optional', 'server_side:unsupported']];
    case 'server': return [['server_side:required', 'server_side:optional'], ['client_side:optional', 'client_side:unsupported']];
    case 'both': return [['client_side:required'], ['server_side:required']];
    case 'library': return [['categories:library']];
    default: return [];
  }
}

function envLabel(client, server) {
  if (client === 'unsupported' && server !== 'unsupported') return 'server';
  if (server === 'unsupported' && client !== 'unsupported') return 'client';
  if (client === 'required' && server === 'required') return 'both';
  if (client === 'optional' && server === 'optional') return 'either';
  if (client === 'required') return 'client';
  if (server === 'required') return 'server';
  return 'unknown';
}

async function search({ query = '', type = 'mod', gameVersion = '', env = 'all', offset = 0, sort = 'relevance', limit = 20 }) {
  const facets = [[`project_type:${type}`]];
  if (type === 'mod' || type === 'modpack') facets.push(['categories:fabric']);
  if (gameVersion) facets.push([`versions:${gameVersion}`]);
  if (type === 'mod') facets.push(...envFacets(env));
  const res = await fetchJson(`${API}/search?${q({ query, facets: JSON.stringify(facets), index: sort, offset, limit })}`);
  return {
    total: res.total_hits,
    hits: res.hits.map(h => ({
      source: 'modrinth', id: h.project_id, slug: h.slug, title: h.title, description: h.description, author: h.author,
      icon: h.icon_url || null, downloads: h.downloads, follows: h.follows, categories: h.display_categories || h.categories || [],
      env: envLabel(h.client_side, h.server_side), isLibrary: (h.categories || []).includes('library'),
      gallery: h.featured_gallery || (h.gallery && h.gallery[0]) || null, type: h.project_type || type, updated: h.date_modified,
      url: `https://modrinth.com/${h.project_type || type}/${h.slug}`,
    })),
  };
}

async function project(id) {
  const p = await fetchJson(`${API}/project/${encodeURIComponent(id)}`);
  return {
    source: 'modrinth', id: p.id, slug: p.slug, title: p.title, description: p.description, body: p.body,
    icon: p.icon_url, gallery: (p.gallery || []).map(g => g.url), env: envLabel(p.client_side, p.server_side),
    isLibrary: (p.categories || []).includes('library'), categories: p.categories, downloads: p.downloads, type: p.project_type,
    url: `https://modrinth.com/${p.project_type}/${p.slug}`, gameVersions: p.game_versions, loaders: p.loaders,
  };
}

async function versions(id, { type = 'mod', gameVersion = '' } = {}) {
  const params = {};
  if (type === 'mod' || type === 'modpack') params.loaders = JSON.stringify(['fabric']);
  if (gameVersion) params.game_versions = JSON.stringify([gameVersion]);
  const list = await fetchJson(`${API}/project/${encodeURIComponent(id)}/version?${q(params)}`);
  return list.map(v => ({
    id: v.id, name: v.name, number: v.version_number, type: v.version_type, gameVersions: v.game_versions, loaders: v.loaders,
    date: v.date_published, files: v.files, dependencies: v.dependencies || [], projectId: v.project_id,
  }));
}

function primaryFile(v) { return v.files.find(f => f.primary) || v.files[0]; }

/** Install a Modrinth version into an instance, including required dependencies. */
async function installVersion(instId, version, kind, info = {}, seen = new Set(), report = () => {}) {
  const inst = instances.get(instId);
  const folder = KIND_FOLDER[kind];
  if (!folder) throw new Error('Unsupported content type ' + kind);
  const projectId = version.projectId || version.project_id;
  if (seen.has(projectId)) return [];
  seen.add(projectId);
  const installed = [];
  const file = primaryFile(version);
  const content = instances.readContent(instId);
  // remove an older file from the same project
  for (const [rel, e] of Object.entries(content.files)) {
    if (e.projectId === projectId && rel !== `${folder}/${file.filename}`) {
      for (const cand of [rel, rel + '.disabled']) { const full = path.join(instances.gameDir(instId), cand); if (fs.existsSync(full)) fs.rmSync(full, { recursive: true, force: true }); }
      delete content.files[rel];
    }
  }
  instances.writeContent(instId, content);
  const dest = safeJoin(path.join(instances.gameDir(instId), folder), file.filename);
  report(`Downloading ${info.title || file.filename}`);
  await download(file.url, dest, { sha1: file.hashes && file.hashes.sha1, size: file.size });
  let meta = info;
  if (!meta.title) { try { const p = await project(projectId); meta = { title: p.title, icon: p.icon, slug: p.slug, env: p.env }; } catch { meta = {}; } }
  instances.recordFile(instId, `${folder}/${file.filename}`, {
    source: 'modrinth', projectId, versionId: version.id, title: meta.title || file.filename, iconUrl: meta.icon || null, slug: meta.slug, env: meta.env, sha1: file.hashes && file.hashes.sha1,
  });
  installed.push(meta.title || file.filename);

  for (const dep of version.dependencies || []) {
    if (dep.dependency_type !== 'required') continue;
    const depProject = dep.project_id;
    const already = Object.values(instances.readContent(instId).files).some(e => e.projectId === depProject);
    if (already || seen.has(depProject)) continue;
    let depVersion = null;
    try {
      if (dep.version_id) {
        const v = await fetchJson(`${API}/version/${dep.version_id}`);
        depVersion = { ...v, projectId: v.project_id };
      } else if (depProject) {
        const list = await versions(depProject, { type: kind === 'mod' ? 'mod' : kind, gameVersion: inst.mcVersion });
        depVersion = list.find(v => v.type === 'release') || list[0];
      }
    } catch {}
    if (depVersion) installed.push(...await installVersion(instId, depVersion, kind, {}, seen, report));
  }
  return installed;
}

/** Install the newest compatible version of a project. */
async function installProject(instId, projectId, kind, info = {}, report) {
  const inst = instances.get(instId);
  const list = await versions(projectId, { type: kind, gameVersion: inst.mcVersion });
  let pick = list.find(v => v.type === 'release') || list[0];
  if (kind === 'shader') pick = list.find(v => v.loaders.includes('iris')) || pick;
  if (!pick) throw new Error(`No version of ${info.title || 'this project'} supports Minecraft ${inst.mcVersion}${kind === 'mod' ? ' with Fabric' : ''}.`);
  const out = await installVersion(instId, pick, kind, info, new Set(), report);
  if (kind === 'shader' && inst.loader === 'fabric') {
    const hasIris = Object.values(instances.readContent(instId).files).some(e => e.slug === 'iris' || e.projectId === 'YL57xq9U');
    if (!hasIris) {
      try { out.push(...await installProject(instId, 'iris', 'mod', { title: 'Iris Shaders', slug: 'iris' }, report)); } catch {}
    }
  }
  return out;
}

// ---------- identify local files by hash ----------
async function identify(hashes) {
  if (!hashes.length) return {};
  const out = {};
  for (let i = 0; i < hashes.length; i += 500) {
    const chunk = hashes.slice(i, i + 500);
    Object.assign(out, await fetchJson(`${API}/version_files`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hashes: chunk, algorithm: 'sha1' }),
    }));
  }
  return out;
}
async function projectsById(ids) {
  const out = {};
  for (let i = 0; i < ids.length; i += 200) {
    const list = await fetchJson(`${API}/projects?${q({ ids: JSON.stringify(ids.slice(i, i + 200)) })}`);
    for (const p of list) out[p.id] = p;
  }
  return out;
}

/** Fill the content index for files that came from anywhere (drag & drop, modpacks). */
async function identifyInstance(instId) {
  const gd = instances.gameDir(instId);
  const content = instances.readContent(instId);
  const files = [];
  for (const folder of ['mods', 'resourcepacks', 'shaderpacks']) {
    const dir = path.join(gd, folder);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      const full = path.join(dir, f);
      if (!fs.statSync(full).isFile()) continue;
      const rel = `${folder}/${f.replace(/\.disabled$/, '')}`;
      if (content.files[rel] && content.files[rel].projectId) continue;
      files.push({ rel, full });
    }
  }
  if (!files.length) return 0;
  await pool(files, 8, async f => { f.sha1 = await hashFile(f.full, 'sha1'); });
  const found = await identify(files.map(f => f.sha1));
  const pids = [...new Set(Object.values(found).map(v => v.project_id))];
  const projects = pids.length ? await projectsById(pids) : {};
  let n = 0;
  for (const f of files) {
    const v = found[f.sha1];
    if (!v) continue;
    const p = projects[v.project_id] || {};
    content.files[f.rel] = { ...(content.files[f.rel] || {}), source: (content.files[f.rel] || {}).source || 'modrinth', projectId: v.project_id, versionId: v.id, title: p.title || f.rel, iconUrl: p.icon_url || null, slug: p.slug, env: envLabel(p.client_side, p.server_side), sha1: f.sha1 };
    n++;
  }
  instances.writeContent(instId, content);
  return n;
}

/** Find newer versions for Modrinth content. Returns [{rel, title, current, latest(version)}]. */
async function checkUpdates(instId) {
  const inst = instances.get(instId);
  const gd = instances.gameDir(instId);
  const content = instances.readContent(instId);
  const byKind = { mods: [], resourcepacks: [], shaderpacks: [] };
  for (const [rel, e] of Object.entries(content.files)) {
    if (!e.projectId || e.source === 'curseforge') continue;
    const folder = rel.split('/')[0];
    if (!byKind[folder]) continue;
    const full = [path.join(gd, rel), path.join(gd, rel + '.disabled')].find(p => fs.existsSync(p));
    if (!full || fs.statSync(full).isDirectory()) continue;
    const sha1 = e.sha1 || await hashFile(full, 'sha1');
    byKind[folder].push({ rel, sha1, e });
  }
  const out = [];
  const loaders = { mods: ['fabric'], resourcepacks: ['minecraft'], shaderpacks: ['iris', 'optifine'] };
  for (const [folder, items] of Object.entries(byKind)) {
    if (!items.length) continue;
    const res = await fetchJson(`${API}/version_files/update`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hashes: items.map(i => i.sha1), algorithm: 'sha1', loaders: loaders[folder], game_versions: [inst.mcVersion] }),
    });
    for (const it of items) {
      const v = res[it.sha1];
      if (v && v.id !== it.e.versionId && primaryFile(v).hashes.sha1 !== it.sha1) {
        out.push({ rel: it.rel, kind: { mods: 'mod', resourcepacks: 'resourcepack', shaderpacks: 'shader' }[folder], title: it.e.title, icon: it.e.iconUrl, from: it.e.versionId, version: { ...v, projectId: v.project_id }, number: v.version_number });
      }
    }
  }
  return out;
}

// ---------- .mrpack ----------
async function readMrpackIndex(zip) {
  const e = zip.getEntry('modrinth.index.json');
  if (!e) throw new Error('Not a Modrinth modpack (modrinth.index.json missing).');
  return JSON.parse(e.getData().toString('utf8'));
}

async function importMrpack(zip, { name, iconUrl, source, report = () => {} } = {}) {
  const index = await readMrpackIndex(zip);
  const deps = index.dependencies || {};
  if (deps.forge || deps.neoforge) throw new Error('This modpack needs Forge/NeoForge. McLauncher supports Fabric and vanilla only.');
  if (deps['quilt-loader']) throw new Error('This modpack needs Quilt. McLauncher supports Fabric and vanilla only.');
  const inst = instances.create({
    name: name || index.name || 'Modpack', mcVersion: deps.minecraft,
    loader: deps['fabric-loader'] ? 'fabric' : 'vanilla', loaderVersion: deps['fabric-loader'] || null,
    source: source || { type: 'mrpack', name: index.name, version: index.versionId },
  });
  try {
    const gd = instances.gameDir(inst.id);
    const files = (index.files || []).filter(f => !f.env || f.env.client !== 'unsupported');
    await pool(files, 8, async f => {
      const dest = safeJoin(gd, f.path);
      let lastErr;
      for (const url of f.downloads || []) {
        try { await download(url, dest, { sha1: f.hashes && f.hashes.sha1, size: f.fileSize }); return; } catch (e) { lastErr = e; }
      }
      throw lastErr || new Error('No download for ' + f.path);
    }, (d, t) => report('Downloading modpack files', d / t));
    extractOverrides(zip, gd, ['overrides/', 'client-overrides/']);
    if (iconUrl) { try { await instances.setIcon(inst.id, { url: iconUrl }); } catch {} }
    report('Reading mod details');
    try { await identifyInstance(inst.id); } catch {}
    return instances.get(inst.id);
  } catch (e) {
    instances.remove(inst.id);
    throw e;
  }
}

function extractOverrides(zip, gd, prefixes) {
  for (const prefix of prefixes) {
    for (const e of zip.getEntries()) {
      if (!e.entryName.startsWith(prefix) || e.isDirectory) continue;
      const rel = e.entryName.slice(prefix.length);
      if (!rel) continue;
      const dest = safeJoin(gd, rel);
      ensure(path.dirname(dest));
      fs.writeFileSync(dest, e.getData());
    }
  }
}

async function installModpack(versionId, { title, icon, projectId, report = () => {} }) {
  const AdmZip = require('adm-zip');
  const v = await fetchJson(`${API}/version/${versionId}`);
  const file = primaryFile(v);
  const tmp = path.join(ensure(path.join(P.cache, 'packs')), file.filename);
  report('Downloading modpack');
  await download(file.url, tmp, { sha1: file.hashes.sha1, size: file.size });
  try {
    return await importMrpack(new AdmZip(tmp), { name: title, iconUrl: icon, report, source: { type: 'modrinth', projectId, versionId, version: v.version_number } });
  } finally { fs.rmSync(tmp, { force: true }); }
}

/** Export an instance as .mrpack. include = list of rel paths (files or folders) inside the game dir. */
async function exportMrpack(instId, outFile, { include, name, version = '1.0.0', summary = '' }, report = () => {}) {
  const AdmZip = require('adm-zip');
  const inst = instances.get(instId);
  const gd = instances.gameDir(instId);
  const all = [];
  const walk = (rel) => {
    const full = safeJoin(gd, rel);
    if (!fs.existsSync(full)) return;
    if (fs.statSync(full).isDirectory()) for (const f of fs.readdirSync(full)) walk(rel ? `${rel}/${f}` : f);
    else all.push({ rel, full });
  };
  for (const rel of include) walk(rel);
  const candidates = all.filter(f => /^(mods|resourcepacks|shaderpacks)\/[^/]+\.(jar|zip)$/i.test(f.rel));
  report('Hashing files');
  await pool(candidates, 8, async f => { f.sha1 = await hashFile(f.full, 'sha1'); f.sha512 = await hashFile(f.full, 'sha512'); });
  let found = {};
  try { report('Looking up files on Modrinth'); found = await identify(candidates.map(f => f.sha1)); } catch {}
  const pids = [...new Set(Object.values(found).map(v => v.project_id))];
  let projects = {};
  try { if (pids.length) projects = await projectsById(pids); } catch {}
  const zip = new AdmZip();
  const files = [];
  for (const f of all) {
    const v = f.sha1 && found[f.sha1];
    const vf = v && v.files.find(x => x.hashes.sha1 === f.sha1);
    if (vf) {
      const p = projects[v.project_id] || {};
      const isMod = f.rel.startsWith('mods/');
      files.push({
        path: f.rel, hashes: { sha1: f.sha1, sha512: f.sha512 },
        env: { client: 'required', server: isMod ? (p.server_side === 'unsupported' ? 'unsupported' : (p.server_side || 'required')) : 'unsupported' },
        downloads: [vf.url], fileSize: fs.statSync(f.full).size,
      });
    } else {
      zip.addLocalFile(f.full, path.posix.dirname(`overrides/${f.rel}`), path.basename(f.rel));
    }
  }
  const dependencies = { minecraft: inst.mcVersion };
  if (inst.loader === 'fabric' && inst.loaderVersion) dependencies['fabric-loader'] = inst.loaderVersion;
  const index = { formatVersion: 1, game: 'minecraft', versionId: version, name: name || inst.name, summary, files, dependencies };
  zip.addFile('modrinth.index.json', Buffer.from(JSON.stringify(index, null, 2)));
  report('Writing file');
  zip.writeZip(outFile);
  return { linked: files.length, bundled: all.length - files.length };
}

module.exports = {
  search, project, versions, installVersion, installProject, identifyInstance, checkUpdates,
  importMrpack, installModpack, exportMrpack, envFacets, envLabel, extractOverrides, KIND_FOLDER,
};
