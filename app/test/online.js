'use strict';
// Online checks run in CI against the real Mojang, Fabric, Modrinth and CurseForge APIs.
// Leaves instances in $MCL_DATA_DIR for the Electron launch test that runs afterwards.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
if (!process.env.MCL_DATA_DIR) throw new Error('Set MCL_DATA_DIR');
const AdmZip = require('adm-zip');
const mojang = require('../src/main/mojang');
const fabric = require('../src/main/fabric');
const instances = require('../src/main/instances');
const modrinth = require('../src/main/modrinth');
const curseforge = require('../src/main/curseforge');
const packs = require('../src/main/packs');
const launch = require('../src/main/launch');
const forge = require('../src/main/forge');

const results = {};
const step = async (name, fn) => {
  const t = Date.now();
  try { const r = await fn(); results[name] = { ok: true, ms: Date.now() - t, info: r }; console.log(`ok - ${name} (${Date.now() - t} ms)`, r !== undefined ? JSON.stringify(r).slice(0, 300) : ''); }
  catch (e) { results[name] = { ok: false, error: e.stack }; console.log(`FAIL - ${name}\n${e.stack}`); }
};
const report = () => {};

(async () => {
  let latest, latestFabric;
  await step('mojang manifest', async () => {
    const m = await mojang.getManifest();
    latest = m.latest.release;
    return { latest, versions: m.versions.length };
  });
  await step('fabric supports a recent release', async () => {
    const games = new Set((await fabric.gameVersions()).map(v => v.version));
    const m = await mojang.getManifest();
    latestFabric = m.versions.find(v => v.type === 'release' && games.has(v.id)).id;
    const loaders = await fabric.loaderVersions(latestFabric);
    assert.ok(loaders.length);
    return { latestFabric, loader: loaders.find(l => l.stable).version };
  });

  // ---- instances that the Electron test launches ----
  const mk = async (name, mc) => {
    const loaders = await fabric.loaderVersions(mc);
    return instances.create({ name, mcVersion: mc, loader: 'fabric', loaderVersion: (loaders.find(l => l.stable) || loaders[0]).version, memory: 2048 });
  };
  let newest, old;
  await step('create fabric instances', async () => {
    newest = await mk('CI Newest', latestFabric);
    old = await mk('CI 1.21.1', '1.21.1');
    return [newest.id, old.id];
  });
  await step('modrinth: install fabric-api with deps (newest)', () => modrinth.installProject(newest.id, 'fabric-api', 'mod', {}, report));
  await step('modrinth: install fabric-api (1.21.1)', () => modrinth.installProject(old.id, 'fabric-api', 'mod', {}, report));
  await step('prepare game files (1.21.1)', async () => {
    const p = await launch.prepare(instances.get(old.id), { id: '0'.repeat(32), name: 'CiPlayer', mcToken: '0', offline: true }, { memory: 2048 }, (s, p) => {});
    assert.ok(fs.existsSync(p.java), 'java runtime missing: ' + p.java);
    return { java: p.java, args: p.args.length };
  });

  // ---- search filters ----
  for (const env of ['all', 'client', 'server', 'both', 'library']) {
    await step(`modrinth search env=${env}`, async () => {
      const r = await modrinth.search({ type: 'mod', gameVersion: '1.21.1', env });
      assert.ok(r.hits.length > 0, 'no hits');
      if (env === 'library') assert.ok(r.hits.every(h => h.isLibrary), 'non-library hit');
      if (env === 'client') assert.ok(r.hits.every(h => h.env !== 'server'), 'server hit in client filter');
      return { total: r.total, first: r.hits.slice(0, 3).map(h => `${h.title}[${h.env}${h.isLibrary ? ',lib' : ''}]`) };
    });
  }
  for (const type of ['resourcepack', 'shader', 'modpack']) {
    await step(`modrinth search ${type}`, async () => { const r = await modrinth.search({ type, gameVersion: '1.21.1' }); assert.ok(r.hits.length); return r.hits[0].title; });
  }
  await step('modrinth: sodium + resource pack + shader (auto Iris)', async () => {
    const a = await modrinth.installProject(old.id, 'sodium', 'mod', {}, report);
    const rp = (await modrinth.search({ type: 'resourcepack', gameVersion: '1.21.1', sort: 'downloads' })).hits[0];
    const b = await modrinth.installProject(old.id, rp.id, 'resourcepack', { title: rp.title }, report);
    const c = await modrinth.installProject(old.id, 'complementary-reimagined', 'shader', {}, report);
    const mods = instances.listContent(old.id, 'mods').map(m => m.title);
    assert.ok(mods.some(t => /iris/i.test(t)), 'iris not auto-installed: ' + mods);
    assert.strictEqual(instances.listContent(old.id, 'shaderpacks').length, 1);
    assert.strictEqual(instances.listContent(old.id, 'resourcepacks').length, 1);
    return { a, b, c, mods };
  });
  await step('modrinth: project details + versions', async () => {
    const p = await modrinth.project('sodium');
    const v = await modrinth.versions('sodium', { type: 'mod', gameVersion: '1.21.1' });
    assert.ok(p.body && v.length);
    return { title: p.title, env: p.env, versions: v.length };
  });
  await step('modrinth: update check runs', async () => (await modrinth.checkUpdates(old.id)).length);

  // ---- CurseForge (through the curse.tools proxy) ----
  let jeiFile;
  await step('curseforge search mods/library/resourcepack/shader/modpack', async () => {
    const out = {};
    for (const [type, env] of [['mod', 'all'], ['mod', 'library'], ['resourcepack', 'all'], ['shader', 'all'], ['modpack', 'all']]) {
      const r = await curseforge.search({ type, env, gameVersion: '1.21.1' });
      assert.ok(r.hits.length, `no CF hits for ${type}/${env}`);
      out[`${type}/${env}`] = r.hits[0].title;
    }
    return out;
  });
  await step('curseforge: install mod with dependencies', async () => {
    const r = await curseforge.search({ type: 'mod', query: 'Mod Menu', gameVersion: '1.21.1' });
    const hit = r.hits.find(h => /mod ?menu/i.test(h.title)) || r.hits[0];
    try {
      const installed = await curseforge.installProject(old.id, hit.id, 'mod', { title: hit.title }, report);
      const fapi = instances.listContent(old.id, 'mods').filter(m => /fabric api/i.test(m.title));
      assert.strictEqual(fapi.length, 1, 'Fabric API installed twice: ' + fapi.map(m => m.file));
      return { installed };
    } catch (e) {
      if (e.blocked) return { blocked: e.blocked };
      throw e;
    }
  });
  await step('curseforge: modpack zip import (manifest + POST lookups)', async () => {
    const vs = await curseforge.versions('238222', { type: 'mod', gameVersion: '1.21.1' }); // JEI
    jeiFile = vs.find(v => v.downloadUrl) || vs[0];
    const zip = new AdmZip();
    const loaders = await fabric.loaderVersions('1.21.1');
    zip.addFile('manifest.json', Buffer.from(JSON.stringify({ minecraft: { version: '1.21.1', modLoaders: [{ id: 'fabric-' + loaders[0].version, primary: true }] }, manifestType: 'minecraftModpack', name: 'CF Test', version: '1', files: [{ projectID: 238222, fileID: Number(jeiFile.id), required: true }], overrides: 'overrides' })));
    zip.addFile('overrides/config/test.txt', Buffer.from('hello'));
    const f = path.join(process.env.MCL_DATA_DIR, 'cf-test.zip');
    zip.writeZip(f);
    const r = await packs.importFile(f);
    const mods = instances.listContent(r.instance.id, 'mods');
    assert.ok(mods.length === 1 || r.blocked.length === 1);
    assert.ok(fs.existsSync(path.join(instances.gameDir(r.instance.id), 'config', 'test.txt')));
    return { mods: mods.map(m => m.title), blocked: r.blocked.length };
  });

  // ---- modpacks ----
  let packInst;
  await step('modrinth modpack install (.mrpack)', async () => {
    const r = await modrinth.search({ type: 'modpack', query: 'Fabulously Optimized' });
    const hit = r.hits.find(h => h.slug === 'fabulously-optimized') || r.hits[0];
    const vs = await modrinth.versions(hit.id, { type: 'modpack' });
    packInst = await modrinth.installModpack(vs[0].id, { title: hit.title, icon: hit.icon, projectId: hit.id, report });
    const mods = instances.listContent(packInst.id, 'mods');
    assert.ok(mods.length > 5);
    assert.ok(packInst.iconUrl, 'pack picture missing');
    return { name: packInst.name, mc: packInst.mcVersion, loader: packInst.loaderVersion, mods: mods.length, identified: mods.filter(m => m.projectId).length };
  });
  await step('export .mrpack and import it back', async () => {
    const out = path.join(process.env.MCL_DATA_DIR, 'export.mrpack');
    const r = await modrinth.exportMrpack(old.id, out, { include: ['mods', 'resourcepacks', 'shaderpacks', 'config', 'options.txt'], name: 'CI Export', version: '1.0.0' });
    assert.ok(r.linked >= 3, 'expected linked files');
    const back = await packs.importFile(out);
    const a = instances.listContent(old.id, 'mods').filter(m => m.enabled).length;
    const b = instances.listContent(back.instance.id, 'mods').length;
    assert.strictEqual(a, b);
    return { ...r, reimported: back.instance.id, mods: b };
  });


  // ---- Forge / NeoForge ----
  const OFFLINE = { id: '0'.repeat(32), name: 'CiPlayer', mcToken: '0', offline: true };
  await step('forge + neoforge version lists', async () => {
    const fg = await forge.gameVersions('forge');
    const nf = await forge.gameVersions('neoforge');
    for (const v of ['1.20.1', '1.12.2', '1.7.10']) assert.ok(fg.includes(v), 'forge missing ' + v);
    for (const v of ['1.21.1', '1.20.1']) assert.ok(nf.includes(v), 'neoforge missing ' + v);
    const manifest = await mojang.getManifest();
    const ids = new Set(manifest.versions.map(v => v.id));
    const unknown = nf.filter(v => !ids.has(v));
    assert.ok(unknown.length <= 3, 'neoforge → minecraft mapping looks wrong: ' + unknown.join(', '));
    const f1201 = await forge.loaderVersions('forge', '1.20.1');
    const n1211 = await forge.loaderVersions('neoforge', '1.21.1');
    return { forgeMc: fg.length, neoMc: nf.slice(-4), unknownNeo: unknown, forge1201: f1201.slice(0, 2), neo1211: n1211.slice(0, 2) };
  });
  const loaderInst = async (name, loader, mc) => {
    const list = await forge.loaderVersions(loader, mc);
    const pick = list.find(l => l.recommended) || list.find(l => l.stable) || list[0];
    return instances.create({ name, mcVersion: mc, loader, loaderVersion: pick.version, memory: 3072 });
  };
  const loaderCases = [['CI NeoForge', 'neoforge', '1.21.1'], ['CI Forge', 'forge', '1.20.1'], ['CI Forge Legacy', 'forge', '1.12.2']];
  for (const [name, loader, mc] of loaderCases) {
    await step(`install ${loader} for ${mc}`, async () => {
      const inst = await loaderInst(name, loader, mc);
      const t = Date.now();
      const p = await launch.prepare(instances.get(inst.id), OFFLINE, { memory: 3072 }, () => {});
      assert.ok(p.versionId.toLowerCase().includes(loader === 'neoforge' ? 'neoforge' : 'forge') || p.versionId.includes('forge'), 'version id ' + p.versionId);
      return { id: inst.id, loaderVersion: instances.get(inst.id).loaderVersion, versionId: p.versionId, seconds: Math.round((Date.now() - t) / 1000), args: p.args.length };
    });
  }
  await step('modrinth: mods for neoforge (Sodium) and forge (JEI) + forge shader (auto Oculus)', async () => {
    const a = await modrinth.installProject('ci-neoforge', 'sodium', 'mod', {}, report);
    const b = await modrinth.installProject('ci-forge', 'jei', 'mod', {}, report);
    const c = await modrinth.installProject('ci-forge', 'complementary-reimagined', 'shader', {}, report);
    const neoMods = instances.listContent('ci-neoforge', 'mods').map(m => `${m.title} ${m.modVersion || ''}`);
    const forgeMods = instances.listContent('ci-forge', 'mods').map(m => `${m.title} ${m.modVersion || ''}`);
    assert.ok(forgeMods.some(t => /oculus/i.test(t)), 'Oculus not installed: ' + forgeMods);
    return { a, b, c, neoMods, forgeMods };
  });
  await step('curseforge: forge mod (Mouse Tweaks) into Forge 1.20.1', async () => {
    try { return await curseforge.installProject('ci-forge', '60089', 'mod', { title: 'Mouse Tweaks' }, report); }
    catch (e) { if (e.blocked) return { blocked: e.blocked }; throw e; }
  });
  await step('modrinth search with forge/neoforge loaders', async () => {
    const r1 = await modrinth.search({ type: 'mod', gameVersion: '1.20.1', loader: 'forge' });
    const r2 = await modrinth.search({ type: 'mod', gameVersion: '1.21.1', loader: 'neoforge' });
    const r3 = await modrinth.search({ type: 'modpack', loader: 'neoforge' });
    const c1 = await curseforge.search({ type: 'mod', gameVersion: '1.20.1', loader: 'forge' });
    assert.ok(r1.hits.length && r2.hits.length && r3.hits.length && c1.hits.length);
    return { forge: r1.hits[0].title, neo: r2.hits[0].title, neoPack: r3.hits[0].title + ' ' + r3.hits[0].loaders, cfForge: c1.hits[0].title };
  });
  await step('export forge .mrpack and import it back', async () => {
    const out = path.join(process.env.MCL_DATA_DIR, 'forge.mrpack');
    const r = await modrinth.exportMrpack('ci-forge', out, { include: ['mods', 'shaderpacks'], name: 'CI Forge Export', version: '1' });
    const back = await packs.importFile(out);
    assert.strictEqual(back.instance.loader, 'forge');
    assert.strictEqual(back.instance.loaderVersion, instances.get('ci-forge').loaderVersion);
    return { ...r, imported: back.instance.id, loaderVersion: back.instance.loaderVersion };
  });

  fs.writeFileSync(path.join(process.env.MCL_DATA_DIR, 'online-results.json'), JSON.stringify({ newest: newest && newest.id, old: old && old.id, results }, null, 2));
  const failed = Object.entries(results).filter(([, r]) => !r.ok).map(([k]) => k);
  console.log(failed.length ? `\n${failed.length} FAILED: ${failed.join(', ')}` : '\nall online checks passed');
  process.exit(failed.length ? 1 : 0);
})();
