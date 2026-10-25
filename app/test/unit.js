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
t('import: nested CurseForge zip, raw game-files zip, folder, integrity', () => {
  const integrity = require('../src/main/integrity');
  // raw zip with a .minecraft folder and a fabric mod → needs setup with guesses
  const raw = new AdmZip();
  const jar = new AdmZip();
  jar.addFile('fabric.mod.json', Buffer.from(JSON.stringify({ id: 'x', depends: { minecraft: '~1.20.1' } })));
  raw.addFile('MyPack/.minecraft/mods/x.jar', jar.toBuffer());
  raw.addFile('MyPack/.minecraft/config/x.json', Buffer.from('{}'));
  const rawFile = path.join(process.env.MCL_DATA_DIR, 'raw.zip');
  raw.writeZip(rawFile);
  packs.importFile(rawFile).then(r => {
    assert.ok(r.needsSetup);
    assert.strictEqual(r.guess.loader, 'fabric');
    assert.strictEqual(r.guess.mcVersion, '1.20.1');
    assert.strictEqual(r.source.root, 'MyPack/.minecraft/');
    const inst = instances.create({ name: 'Raw', mcVersion: '1.20.1', loader: 'fabric', loaderVersion: '0.16.0' });
    packs.importRawInto(inst.id, r.source);
    assert.ok(fs.existsSync(path.join(instances.gameDir(inst.id), 'mods', 'x.jar')));
    assert.ok(fs.existsSync(path.join(instances.gameDir(inst.id), 'config', 'x.json')));
    // integrity: one present, one missing; adding the missing file by hand places it
    fs.writeFileSync(path.join(instances.gameDir(inst.id), 'mods', 'here.jar'), 'abc');
    integrity.savePackFiles(inst.id, [{ path: 'mods/here.jar', size: 3 }, { path: 'mods/gone.jar', title: 'Gone', page: 'https://example.com' }]);
    let v = integrity.verify(inst.id);
    assert.strictEqual(v.missing.length, 1);
    assert.strictEqual(v.missing[0].fileName, 'gone.jar');
    const dl = path.join(process.env.MCL_DATA_DIR, 'gone.jar');
    fs.writeFileSync(dl, 'zzz');
    return integrity.addManual(inst.id, [dl]).then(res => {
      assert.strictEqual(res.missing.length, 0);
      console.log('ok - raw zip import + integrity (async)');
    });
  }).catch(e => { console.error(e); process.exitCode = 1; });
});
t('prism component pack (GTNH-style) import + merge', () => {
  const prism = require('../src/main/prism');
  const z = new AdmZip();
  const R = 'GT New Horizons 2.8.4/';
  z.addFile(R + 'mmc-pack.json', Buffer.from(JSON.stringify({ formatVersion: 1, components: [
    { uid: 'org.lwjgl3', version: '3.3.3', dependencyOnly: true }, { uid: 'net.minecraft', version: '1.7.10' },
    { uid: 'me.eigenraven.lwjgl3ify.forgepatches', cachedVersion: '2.1.16', cachedName: 'LWJGL3ify Early Classpath' },
    { uid: 'net.minecraftforge', version: '10.13.4.1614' }, { uid: 'me.eigenraven.lwjgl3ify.launchargs', cachedVersion: '2.1.16' }] })));
  z.addFile(R + 'patches/me.eigenraven.lwjgl3ify.forgepatches.json', Buffer.from(JSON.stringify({ uid: 'me.eigenraven.lwjgl3ify.forgepatches', '+jvmArgs': ['-Djava.system.class.loader=X'], libraries: [{ name: 'com.github.GTNewHorizons:lwjgl3ify:2.1.16:forgePatches', 'MMC-hint': 'local' }] })));
  z.addFile(R + 'patches/me.eigenraven.lwjgl3ify.launchargs.json', Buffer.from(JSON.stringify({ uid: 'me.eigenraven.lwjgl3ify.launchargs', mainClass: 'com.gtnewhorizons.retrofuturabootstrap.Main' })));
  z.addFile(R + 'libraries/lwjgl3ify-2.1.16-forgePatches.jar', Buffer.from('jar'));
  z.addFile(R + 'instance.cfg', Buffer.from('InstanceType=OneSix\niconKey=gtnh_icon\nname=GTNH 2.8.4\nOverrideMemory=true\nMaxMemAlloc=6144\n'));
  // 1x1 png
  z.addFile(R + 'gtnh_icon.png', Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cf00000301010018dd8db40000000049454e44ae426082', 'hex'));
  z.addFile(R + '.minecraft/mods/gt.jar', Buffer.from('x'));
  const f = path.join(process.env.MCL_DATA_DIR, 'gtnh.zip');
  z.writeZip(f);
  return packs.importFile(f).then(r => {
    const i = r.instance;
    assert.strictEqual(i.name, 'GTNH 2.8.4');
    assert.strictEqual(i.prism, true);
    assert.strictEqual(i.loader, 'forge');
    assert.strictEqual(i.memory, 6144);
    assert.ok(i.iconFile && i.iconFile.startsWith('icon.'), 'icon not imported');
    assert.ok(fs.existsSync(path.join(instances.dirOf(i.id), 'prism', 'libraries', 'lwjgl3ify-2.1.16-forgePatches.jar')));
    assert.ok(fs.existsSync(path.join(instances.gameDir(i.id), 'mods', 'gt.jar')));
    const comps = prism.components(i.id);
    assert.strictEqual(comps.length, 5);
    assert.ok(comps.find(c => c.uid === 'me.eigenraven.lwjgl3ify.launchargs').custom);
    const m = prism.merge([
      { mainClass: 'net.minecraft.client.main.Main', libraries: [{ name: 'com.google.guava:guava:15.0' }, { name: 'a:b:1' }], compatibleJavaMajors: [8] },
      { compatibleJavaMajors: [17, 21] },
      { '+tweakers': ['T'], libraries: [{ name: 'com.google.guava:guava:17.0' }], mainClass: 'M' },
    ]);
    assert.strictEqual(m.mainClass, 'M');
    assert.deepStrictEqual(m.tweakers, ['T']);
    assert.deepStrictEqual(m.libraries.map(l => l.name), ['com.google.guava:guava:17.0', 'a:b:1']);
    assert.deepStrictEqual(m.compatibleJavaMajors, [17, 21]);
    // a plain Prism Forge pack stays native
    assert.strictEqual(prism.needsEngine({ components: [{ uid: 'org.lwjgl', version: '2.9.4' }, { uid: 'net.minecraft', version: '1.7.10' }, { uid: 'net.minecraftforge', version: '10.13.4.1614' }] }, [], false), false);
    console.log('ok - prism engine import (async)');
  }).catch(e => { console.error(e); process.exitCode = 1; });
});
t('env parsing + java version parsing', () => {
  const launch = require('../src/main/launch');
  assert.deepStrictEqual(launch.parseEnv('A=1\n# c\nB = two words\nbad line\n'), { A: '1', B: 'two words' });
  const java = require('../src/main/java');
  assert.strictEqual(java.majorOf('1.8.0_202'), 8);
  assert.strictEqual(java.majorOf('21.0.3'), 21);
  assert.strictEqual(java.majorOf('17'), 17);
});
process.on('exit', () => console.log(`${n} test groups passed`));
