'use strict';
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { P, ensure } = require('./paths');
const { download, pool, VERSION } = require('./net');
const mojang = require('./mojang');
const fabric = require('./fabric');
const forge = require('./forge');
const javaSel = require('./java');
const prism = require('./prism');
const instances = require('./instances');

const PERF_FLAGS = [
  '-XX:+UseG1GC', '-XX:+ParallelRefProcEnabled', '-XX:MaxGCPauseMillis=200', '-XX:+UnlockExperimentalVMOptions',
  '-XX:+DisableExplicitGC', '-XX:+AlwaysPreTouch', '-XX:G1NewSizePercent=30', '-XX:G1MaxNewSizePercent=40',
  '-XX:G1HeapRegionSize=8M', '-XX:G1ReservePercent=20', '-XX:InitiatingHeapOccupancyPercent=15',
];

function substitute(str, vars) {
  return str.replace(/\$\{([a-zA-Z_]+)\}/g, (m, k) => (k in vars ? vars[k] : m));
}

function expandArgs(list, vars, features) {
  const out = [];
  for (const a of list || []) {
    if (typeof a === 'string') { out.push(substitute(a, vars)); continue; }
    if (!mojang.rulesAllow(a.rules, features)) continue;
    const vals = Array.isArray(a.value) ? a.value : [a.value];
    for (const v of vals) out.push(substitute(v, vars));
  }
  return out;
}

const LOADER_NAMES = { fabric: 'Fabric', forge: 'Forge', neoforge: 'NeoForge' };

async function pickLoaderVersion(inst) {
  if (inst.loaderVersion) return inst.loaderVersion;
  const list = inst.loader === 'fabric' ? await fabric.loaderVersions(inst.mcVersion) : await forge.loaderVersions(inst.loader, inst.mcVersion);
  const pick = list.find(l => l.recommended) || list.find(l => l.stable) || list[0];
  if (!pick) throw new Error(`${LOADER_NAMES[inst.loader]} does not support Minecraft ${inst.mcVersion}.`);
  instances.update(inst.id, { loaderVersion: pick.version });
  return pick.version;
}

/** Resolve the merged version json for an instance, installing the mod loader if needed. */
async function resolveVersion(inst, java, report = () => {}) {
  const vanilla = await mojang.getVanillaJson(inst.mcVersion);
  if (!LOADER_NAMES[inst.loader]) return { version: { ...vanilla, clientId: vanilla.id }, vanilla };
  const loaderVersion = await pickLoaderVersion(inst);
  if (inst.loader === 'fabric') {
    const profile = await fabric.getProfile(inst.mcVersion, loaderVersion);
    return { version: mojang.mergeVersions(profile, vanilla), vanilla };
  }
  const id = await forge.ensureInstalled(inst.loader, loaderVersion, inst.mcVersion, java, report);
  const child = JSON.parse(fs.readFileSync(path.join(P.versions, id, `${id}.json`), 'utf8'));
  return { version: mojang.mergeVersions(child, vanilla), vanilla, ownJar: true };
}

/** Download everything needed and build the java command line. */
async function prepare(inst, account, settings, report) {
  report('Checking game files');
  let java, version, clientJar, extraJvm = [], extraGame = [];
  if (inst.prism) {
    // Instance imported from Prism/MultiMC with its own components (e.g. GTNH with lwjgl3ify).
    ({ java, version, clientJar, extraJvm, extraGame } = await prism.resolve(inst, settings, report));
  } else {
    // Java first: Forge/NeoForge installation runs Java tools.
    java = await javaSel.resolve(inst, settings, await mojang.getVanillaJson(inst.mcVersion), report);
    const r = await resolveVersion(inst, java, report);
    version = r.version;
    clientJar = await mojang.installClient(r.vanilla, report);
    if (r.ownJar) {
      // Forge 1.17+ expects the game jar to be named after the Forge version (versions/<id>/<id>.jar).
      const named = path.join(P.versions, version.id, `${version.id}.jar`);
      if (!fs.existsSync(named) || fs.statSync(named).size !== fs.statSync(clientJar).size) fs.copyFileSync(clientJar, named);
      clientJar = named;
    }
  }
  const plan = mojang.planLibraries(version);
  const libJobs = plan.jobs.filter(j => !(fs.existsSync(j.dest) && (j.size == null || fs.statSync(j.dest).size === j.size)));
  if (libJobs.length) await pool(libJobs, 8, j => download(j.url, j.dest, { sha1: j.sha1, size: j.size }), (d, t) => report('Downloading libraries', d / t));
  const assetInfo = await mojang.installAssets(version, report);


  const gameDir = instances.gameDir(inst.id);
  const nativesDir = path.join(P.root, 'natives', inst.id);
  report('Preparing natives');
  mojang.extractNatives(plan.nativeJars, nativesDir);

  const SEP = path.delimiter; // ':' on Linux, ';' on Windows
  const cp = [...plan.classpath, clientJar].join(SEP);
  const vars = {
    auth_player_name: account.name,
    version_name: version.id,
    game_directory: gameDir,
    assets_root: P.assets,
    game_assets: assetInfo.virtualDir || P.assets,
    assets_index_name: version.assetIndex.id,
    auth_uuid: account.id,
    auth_access_token: account.mcToken,
    auth_session: `token:${account.mcToken}:${account.id}`,
    clientid: '',
    auth_xuid: account.xuid || '',
    user_type: account.offline ? 'legacy' : 'msa',
    user_properties: '{}',
    version_type: 'McLauncher',
    natives_directory: nativesDir,
    launcher_name: 'McLauncher',
    launcher_version: VERSION,
    classpath: cp,
    classpath_separator: SEP,
    library_directory: P.libraries,
    resolution_width: String(inst.width || 854),
    resolution_height: String(inst.height || 480),
  };
  const features = { has_custom_resolution: !!(inst.width && inst.height) };

  let jvm;
  if (version.arguments && version.arguments.jvm && version.arguments.jvm.length) jvm = expandArgs(version.arguments.jvm, vars, features);
  else jvm = [`-Djava.library.path=${nativesDir}`, '-cp', cp];
  let game;
  if (version.arguments && version.arguments.game) game = expandArgs(version.arguments.game, vars, features);
  else game = (version.minecraftArguments || '').split(' ').filter(Boolean).map(a => substitute(a, vars));
  if (extraGame.length) game.push(...extraGame);

  // Linux/Wayland: optionally run the game as a native Wayland window through the system GLFW
  // (avoids XWayland crashes such as SIGSEGV in XCheckTypedWindowEvent on Hyprland).
  const glfwArg = waylandGlfwArg(inst, settings, version.libraries);

  const mem = Math.max(512, Number(inst.memory || settings.memory || 4096));
  const userJvm = [`-Xmx${mem}M`, `-Xms${Math.min(mem, 1024)}M`, ...PERF_FLAGS, '-Dlog4j2.formatMsgNoLookups=true'];
  if (glfwArg) userJvm.push(glfwArg);
  if (extraJvm.length) userJvm.push(...extraJvm.map(a => substitute(a, vars)));
  const extra = `${settings.jvmArgs || ''} ${inst.jvmArgs || ''}`.trim();
  if (extra) userJvm.push(...extra.split(/\s+/));

  if (assetInfo.mapToResources) {
    const res = path.join(gameDir, 'resources');
    if (!fs.existsSync(res)) fs.cpSync(assetInfo.virtualDir, res, { recursive: true });
  }

  return { java, args: [...userJvm, ...jvm, version.mainClass, ...game], cwd: gameDir, versionId: version.id, envVars: inst.envVars || '' };
}

/**
 * Native Wayland: point LWJGL at our shim, which loads the system GLFW but skips the window-icon and
 * window-position calls that Wayland can't do (old Minecraft treats those errors as fatal).
 */
function waylandGlfwArg(inst, settings, libraries) {
  const want = process.platform === 'linux' && (inst.nativeWayland ?? settings.nativeWayland) && !!process.env.WAYLAND_DISPLAY;
  const usesGlfw = (libraries || []).some(l => /^org\.lwjgl3?:lwjgl-glfw:3|^org\.lwjgl:lwjgl-glfw/.test(l.name));
  if (!want || !usesGlfw) return null;
  if (!systemGlfw()) throw new Error('Native Wayland needs the system GLFW library. Install it (on Arch: sudo pacman -S glfw) or turn Native Wayland off in the instance settings.');
  return `-Dorg.lwjgl.glfw.libname=${glfwShim() || systemGlfw()}`;
}
function glfwShim() {
  const name = 'libmcl-glfw-wayland.so';
  const c = [process.resourcesPath && path.join(process.resourcesPath, 'native', name), path.join(__dirname, '../../native/linux-x64', name)];
  return c.find(p => p && fs.existsSync(p)) || null;
}

function systemGlfw() {
  if (process.platform !== 'linux') return null;
  const c = ['/usr/lib/libglfw.so.3', '/usr/lib/libglfw.so', '/usr/lib64/libglfw.so.3', '/usr/lib/x86_64-linux-gnu/libglfw.so.3', '/usr/local/lib/libglfw.so.3'];
  return c.find(p => fs.existsSync(p)) || null;
}

/** "KEY=value" lines → object. */
function parseEnv(text) {
  const out = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

function hasCommand(cmd) {
  if (process.platform === 'win32') return false;
  try { execFileSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' }); return true; } catch { return false; }
}

/** Spawn the game. Calls hooks.onLine(line), hooks.onExit(code). */
function start(prep, settings, hooks) {
  ensure(P.logs);
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('ELECTRON_') || k === 'CHROME_DESKTOP' || k === 'GDK_BACKEND') delete env[k];
  if (process.platform === 'linux') {
    // NVIDIA's "threaded optimizations" crash Minecraft (with Sodium, and in libX11 under XWayland).
    // Sodium recommends turning them off for Minecraft only, which is what this does.
    if (settings.nvidiaThreadedFix !== false && env.__GL_THREADED_OPTIMIZATIONS == null) env.__GL_THREADED_OPTIMIZATIONS = '0';
  }
  Object.assign(env, parseEnv(settings.envVars), parseEnv(prep.envVars));
  let cmd = prep.java, args = prep.args;
  if (settings.gamemode !== false && hasCommand('gamemoderun')) { args = [cmd, ...args]; cmd = 'gamemoderun'; }
  const proc = spawn(cmd, args, { cwd: prep.cwd, env, detached: false, windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'] });
  let buf = { out: '', err: '' };
  const feed = (key, chunk) => {
    buf[key] += chunk.toString('utf8');
    const lines = buf[key].split(/\r?\n/);
    buf[key] = lines.pop();
    for (const l of lines) hooks.onLine(l, key === 'err');
  };
  proc.stdout.on('data', c => feed('out', c));
  proc.stderr.on('data', c => feed('err', c));
  proc.on('error', e => { hooks.onLine(`[McLauncher] Could not start Java: ${e.message}`, true); hooks.onExit(-1); });
  proc.on('exit', (code, signal) => {
    if (buf.out) hooks.onLine(buf.out, false);
    if (buf.err) hooks.onLine(buf.err, true);
    hooks.onExit(code == null ? (signal ? 128 : -1) : code, signal);
  });
  return proc;
}

module.exports = { systemGlfw, glfwShim, waylandGlfwArg, parseEnv, PERF_FLAGS, prepare, start, resolveVersion, expandArgs, substitute, hasCommand };
