'use strict';
// Offline unit tests for the pure parts of the launcher.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.MCL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mcl-unit-'));
const mojang = require('../src/main/mojang');
const launch = require('../src/main/launch');
const modrinth = require('../src/main/modrinth');
const instances = require('../src/main/instances');
const packs = require('../src/main/packs');
const { safeJoin } = require('../src/main/paths');
const AdmZip = require('adm-zip');

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok -', name); };

t('maven path', () => {
  assert.strictEqual(mojang.mavenPath('net.fabricmc:fabric-loader:0.16.5'), 'net/fabricmc/fabric-loader/0.16.5/fabric-loader-0.16.5.jar');
  assert.strictEqual(mojang.mavenPath('org.lwjgl:lwjgl:3.3.3:natives-linux'), 'org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3-natives-linux.jar');
  assert.strictEqual(mojang.mavenPath('a.b:c:1@zip'), 'a/b/c/1/c-1.zip');
});
t('rules', () => {
  assert.ok(mojang.rulesAllow(undefined));
  assert.ok(!mojang.rulesAllow([{ action: 'allow', os: { name: 'osx' } }]));
  assert.ok(mojang.rulesAllow([{ action: 'allow' }, { action: 'disallow', os: { name: 'osx' } }]));
  assert.ok(mojang.rulesAllow([{ action: 'allow', os: { name: mojang.OS } }]));
  assert.ok(!mojang.rulesAllow([{ action: 'allow', features: { is_demo_user: true } }], {}));
  assert.ok(mojang.rulesAllow([{ action: 'allow', features: { has_custom_resolution: true } }], { has_custom_resolution: true }));
});
t('native classifiers on x64', () => {
  if (process.arch !== 'x64') return;
  const me = mojang.OS, other = me === 'windows' ? 'linux' : 'windows';
  assert.ok(mojang.nativeClassifierOk(`natives-${me}`));
  assert.ok(!mojang.nativeClassifierOk(`natives-${me}-arm64`));
  assert.ok(!mojang.nativeClassifierOk(`natives-${me}-x86`));
  assert.ok(!mojang.nativeClassifierOk(`natives-${other}`));
  assert.ok(!mojang.nativeClassifierOk('natives-macos-arm64'));
});
t('merge + plan libraries (fabric wins duplicates, natives detected)', () => {
  const vanilla = { id: '1.21.1', mainClass: 'net.minecraft.client.main.Main', arguments: { game: ['--username', '${auth_player_name}'], jvm: ['-cp', '${classpath}'] },
    assetIndex: { id: '17' }, javaVersion: { component: 'java-runtime-delta' }, downloads: { client: {} },
    libraries: [
      { name: 'org.ow2.asm:asm:9.1', downloads: { artifact: { path: 'org/ow2/asm/asm/9.1/asm-9.1.jar', url: 'https://x/asm91', sha1: 'a', size: 1 } } },
      { name: 'org.lwjgl:lwjgl:3.3.3', downloads: { artifact: { path: 'l.jar', url: 'https://x/l', sha1: 'b', size: 1 } } },
      { name: `org.lwjgl:lwjgl:3.3.3:natives-${mojang.OS}`, rules: [{ action: 'allow', os: { name: mojang.OS } }], downloads: { artifact: { path: 'ln.jar', url: 'https://x/ln', sha1: 'c', size: 1 } } },
      { name: 'org.lwjgl:lwjgl:3.3.3:natives-macos', rules: [{ action: 'allow', os: { name: 'osx' } }], downloads: { artifact: { path: 'lw.jar', url: 'https://x/lw', sha1: 'd', size: 1 } } },
    ] };
  const fab = { id: 'fabric-loader-0.16.5-1.21.1', inheritsFrom: '1.21.1', mainClass: 'net.fabricmc.loader.impl.launch.knot.KnotClient',
    arguments: { game: [], jvm: ['-DFabricMcEmu= net.minecraft.client.main.Main '] },
    libraries: [{ name: 'org.ow2.asm:asm:9.7', url: 'https://maven.fabricmc.net/' }, { name: 'net.fabricmc:fabric-loader:0.16.5', url: 'https://maven.fabricmc.net/' }] };
  const m = mojang.mergeVersions(fab, vanilla);
  assert.strictEqual(m.mainClass, fab.mainClass);
  assert.strictEqual(m.assetIndex.id, '17');
  assert.strictEqual(m.arguments.jvm.length, 3);
  const plan = mojang.planLibraries(m);
  const urls = plan.jobs.map(j => j.url);
  assert.ok(urls.includes('https://maven.fabricmc.net/org/ow2/asm/asm/9.7/asm-9.7.jar'));
  assert.ok(!urls.includes('https://x/asm91'), 'vanilla asm should be replaced by fabric asm');
  if (process.arch === 'x64') {
    assert.ok(urls.includes('https://x/ln'));
    assert.ok(!urls.includes('https://x/lw'));
    assert.strictEqual(plan.nativeJars.length, 1);
  }
});
t('argument expansion', () => {
  const out = launch.expandArgs(['--a', '${x}', { rules: [{ action: 'allow', features: { has_custom_resolution: true } }], value: ['--w', '${w}'] }, { rules: [{ action: 'allow', os: { name: mojang.OS } }], value: '-Dlinux=${x}' }], { x: 'X', w: '800' }, { has_custom_resolution: false });
  assert.deepStrictEqual(out, ['--a', 'X', '-Dlinux=X']);
});
t('modrinth env facets + labels', () => {
  assert.deepStrictEqual(modrinth.envFacets('library'), [['categories:library']]);
  assert.strictEqual(modrinth.envFacets('all').length, 0);
  assert.strictEqual(modrinth.envLabel('required', 'unsupported'), 'client');
  assert.strictEqual(modrinth.envLabel('unsupported', 'required'), 'server');
  assert.strictEqual(modrinth.envLabel('required', 'required'), 'both');
});
t('safeJoin blocks escapes', () => {
  const base = path.resolve(os.tmpdir(), 'a');
  assert.throws(() => safeJoin(base, '../b'));
  assert.throws(() => safeJoin(base, path.resolve('/etc/passwd')));
  assert.strictEqual(safeJoin(base, 'mods/x.jar'), path.join(base, 'mods', 'x.jar'));
});
t('instances: create, content listing, toggle, export/import zip', () => {
  const inst = instances.create({ name: 'Test Pack', mcVersion: '1.21.1', loader: 'fabric', loaderVersion: '0.16.5' });
  assert.strictEqual(inst.id, 'test-pack');
  const gd = instances.gameDir(inst.id);
  const jar = new AdmZip();
  jar.addFile('fabric.mod.json', Buffer.from(JSON.stringify({ id: 'demo', name: 'Demo Mod', version: '1.2.3', environment: 'client' })));
  jar.writeZip(path.join(gd, 'mods', 'demo.jar'));
  fs.mkdirSync(path.join(gd, 'saves', 'World 1'), { recursive: true });
  fs.writeFileSync(path.join(gd, 'saves', 'World 1', 'level.dat'), 'x');
  fs.writeFileSync(path.join(gd, 'options.txt'), 'fov:0');
  let mods = instances.listContent(inst.id, 'mods');
  assert.strictEqual(mods[0].title, 'Demo Mod');
  assert.strictEqual(mods[0].modVersion, '1.2.3');
  assert.strictEqual(mods[0].env, 'client');
  instances.toggleContent(inst.id, 'mods', 'demo.jar');
  mods = instances.listContent(inst.id, 'mods');
  assert.strictEqual(mods[0].enabled, false);
  assert.strictEqual(instances.listContent(inst.id, 'saves')[0].file, 'World 1');
  const out = path.join(process.env.MCL_DATA_DIR, 'export.zip');
  packs.exportZip(inst.id, out, { include: ['mods', 'saves', 'options.txt'] });
  const cands = packs.exportCandidates(inst.id).map(c => c.name);
  assert.ok(cands.includes('mods') && cands.includes('options.txt'));
  return packs.importFile(out).then(r => {
    assert.strictEqual(r.instance.name, 'Test Pack');
    assert.notStrictEqual(r.instance.id, inst.id);
    assert.ok(fs.existsSync(path.join(instances.gameDir(r.instance.id), 'mods', 'demo.jar.disabled')));
    assert.ok(fs.existsSync(path.join(instances.gameDir(r.instance.id), 'saves', 'World 1', 'level.dat')));
    console.log('ok - zip round trip');
  });
});
t('prism zip import + zip-slip rejected', () => {
  const z = new AdmZip();
  z.addFile('MyPack/instance.cfg', Buffer.from('InstanceType=OneSix\nname=Prism Pack\n'));
  z.addFile('MyPack/mmc-pack.json', Buffer.from(JSON.stringify({ components: [{ uid: 'net.minecraft', version: '1.20.1' }, { uid: 'net.fabricmc.fabric-loader', version: '0.15.0' }] })));
  z.addFile('MyPack/.minecraft/mods/a.jar', Buffer.from('jar'));
  const f = path.join(process.env.MCL_DATA_DIR, 'prism.zip');
  z.writeZip(f);
  packs.importFile(f).then(r => {
    assert.strictEqual(r.instance.name, 'Prism Pack');
    assert.strictEqual(r.instance.loaderVersion, '0.15.0');
    assert.ok(fs.existsSync(path.join(instances.gameDir(r.instance.id), 'mods', 'a.jar')));
    console.log('ok - prism import');
  });
  const bad = { getEntries: () => [{ entryName: 'overrides/../../evil.txt', isDirectory: false, getData: () => Buffer.from('x') }] };
  assert.throws(() => modrinth.extractOverrides(bad, instances.gameDir('test-pack'), ['overrides/']));
});
t('neoforge version mapping', () => {
  const forge = require('../src/main/forge');
  assert.strictEqual(forge.neoToMc('21.1.209'), '1.21.1');
  assert.strictEqual(forge.neoToMc('21.0.167'), '1.21');
  assert.strictEqual(forge.neoToMc('20.4.237'), '1.20.4');
  assert.strictEqual(forge.neoToMc('21.4.0-beta'), '1.21.4');
  assert.strictEqual(forge.neoToMc('26.1.0.3-beta'), '26.1');
  assert.strictEqual(forge.neoToMc('26.1.2.7'), '26.1.2');
  assert.strictEqual(forge.shortVersion('forge', '1.20.1', '1.20.1-47.3.0'), '47.3.0');
  assert.strictEqual(forge.shortVersion('forge', '1.7.10', '1.7.10-10.13.4.1614-1.7.10'), '10.13.4.1614');
  assert.strictEqual(forge.shortVersion('neoforge', '1.20.1', '1.20.1-47.1.106'), '47.1.106');
  assert.ok(forge.installerUrl('neoforge', '1.20.1-47.1.106').includes('/net/neoforged/forge/'));
  assert.ok(forge.installerUrl('neoforge', '21.1.209').endsWith('neoforge-21.1.209-installer.jar'));
});
t('forge mods.toml + mcmod.info metadata', () => {
  const inst = instances.create({ name: 'Forge Meta', mcVersion: '1.20.1', loader: 'forge', loaderVersion: '1.20.1-47.3.0' });
  const gd = instances.gameDir(inst.id);
  const a = new AdmZip();
  a.addFile('META-INF/mods.toml', Buffer.from('modLoader="javafml"\nloaderVersion="[47,)"\n[[mods]]\nmodId="jei"\nversion="${file.jarVersion}"\ndisplayName="Just Enough Items"\ndescription=\'\'\'\nShows items\n\'\'\'\n[[dependencies.jei]]\nmodId="forge"\n'));
  a.addFile('META-INF/MANIFEST.MF', Buffer.from('Manifest-Version: 1.0\nImplementation-Version: 15.2.0.27\n'));
  a.writeZip(path.join(gd, 'mods', 'jei.jar'));
  const b = new AdmZip();
  b.addFile('mcmod.info', Buffer.from(JSON.stringify([{ modid: 'oldmod', name: 'Old Mod', version: '1.0' }])));
  b.writeZip(path.join(gd, 'mods', 'old.jar'));
  const mods = instances.listContent(inst.id, 'mods');
  const jei = mods.find(m => m.file === 'jei.jar');
  assert.strictEqual(jei.title, 'Just Enough Items');
  assert.strictEqual(jei.modVersion, '15.2.0.27');
  assert.strictEqual(mods.find(m => m.file === 'old.jar').title, 'Old Mod');
});
t('prism neoforge import', () => {
  const z = new AdmZip();
  z.addFile('Neo/instance.cfg', Buffer.from('name=Neo Pack\n'));
  z.addFile('Neo/mmc-pack.json', Buffer.from(JSON.stringify({ components: [{ uid: 'net.minecraft', version: '1.21.1' }, { uid: 'net.neoforged', version: '21.1.209' }] })));
  z.addFile('Neo/minecraft/options.txt', Buffer.from('x'));
  const f = path.join(process.env.MCL_DATA_DIR, 'neo.zip');
  z.writeZip(f);
  packs.importFile(f).then(r => {
    assert.strictEqual(r.instance.loader, 'neoforge');
    assert.strictEqual(r.instance.loaderVersion, '21.1.209');
    console.log('ok - prism neoforge import (async)');
  });
});
process.on('exit', () => console.log(`${n} test groups passed`));
