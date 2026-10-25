'use strict';
/**
 * Java selection: Mojang's runtimes by major version, Java installs found on this computer,
 * and custom paths. Used per instance ("Java" in instance settings) and for automatic picks.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const mojang = require('./mojang');

const IS_WIN = process.platform === 'win32';
const EXE = IS_WIN ? 'javaw.exe' : 'java';

function majorOf(v) {
  if (!v) return null;
  const m = /^(?:1\.)?(\d+)/.exec(String(v));
  return m ? Number(m[1]) : null;
}

/** Version of a Java executable: from the JDK's `release` file, or by asking it. */
function versionOf(javaPath) {
  try {
    const home = path.dirname(path.dirname(javaPath));
    const rel = path.join(home, 'release');
    if (fs.existsSync(rel)) {
      const txt = fs.readFileSync(rel, 'utf8');
      const v = /^JAVA_VERSION="([^"]+)"/m.exec(txt);
      const vendor = /^IMPLEMENTOR="([^"]+)"/m.exec(txt);
      const arch = /^OS_ARCH="([^"]+)"/m.exec(txt);
      if (v) return { version: v[1], major: majorOf(v[1]), vendor: vendor ? vendor[1] : '', arch: arch ? arch[1] : '' };
    }
  } catch {}
  const exe = IS_WIN ? javaPath.replace(/javaw\.exe$/i, 'java.exe') : javaPath;
  const r = spawnSync(exe, ['-XshowSettings:properties', '-version'], { encoding: 'utf8', timeout: 10000, windowsHide: true });
  const out = `${r.stdout || ''}\n${r.stderr || ''}`;
  const v = /java\.version = (\S+)/.exec(out) || /version "([^"]+)"/.exec(out);
  if (!v) return null;
  const vendor = /java\.vendor = (.+)/.exec(out);
  const arch = /os\.arch = (\S+)/.exec(out);
  return { version: v[1], major: majorOf(v[1]), vendor: vendor ? vendor[1].trim() : '', arch: arch ? arch[1] : '' };
}

function candidateDirs() {
  const home = os.homedir();
  if (IS_WIN) {
    const pf = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs')].filter(Boolean);
    const vendors = ['Java', 'Eclipse Adoptium', 'Eclipse Foundation', 'Microsoft', 'Zulu', 'BellSoft', 'Amazon Corretto', 'Semeru', 'GraalVM'];
    return [...pf.flatMap(p => vendors.map(v => path.join(p, v))), path.join(home, '.jdks')];
  }
  return ['/usr/lib/jvm', '/usr/lib64/jvm', '/usr/java', '/opt', '/opt/java', path.join(home, '.jdks'), path.join(home, '.sdkman/candidates/java')];
}

/** Java installs on this computer: [{ path, version, major, vendor }]. */
function detectSystem() {
  const found = new Map();
  const add = (p) => {
    try {
      const real = fs.realpathSync(p);
      if (found.has(real) || !fs.statSync(real).isFile()) return;
      const v = versionOf(real);
      if (v && v.major) found.set(real, { path: real, ...v });
    } catch {}
  };
  for (const dir of candidateDirs()) {
    let entries = [];
    try { entries = fs.readdirSync(dir); } catch { continue; }
    for (const e of entries) {
      for (const sub of [path.join(dir, e, 'bin', EXE), path.join(dir, e, 'jre', 'bin', EXE)]) if (fs.existsSync(sub)) add(sub);
    }
  }
  // whatever `java` is on PATH
  const which = spawnSync(IS_WIN ? 'where' : 'sh', IS_WIN ? ['javaw'] : ['-c', 'command -v java'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
  for (const line of (which.stdout || '').split(/\r?\n/)) if (line.trim()) add(line.trim());
  return [...found.values()].sort((a, b) => b.major - a.major || a.path.localeCompare(b.path));
}

/** Majors Mojang provides for this computer, mapped to their runtime component name. */
async function mojangMajors() {
  const runtimes = await mojang.javaRuntimes();
  const byMajor = {};
  for (const [component, info] of Object.entries(runtimes)) {
    if (/snapshot/i.test(component)) continue;
    const major = majorOf(info.version);
    if (!major) continue;
    // keep the newest build per major
    if (!byMajor[major] || String(info.version).localeCompare(String(byMajor[major].version), undefined, { numeric: true }) > 0) byMajor[major] = { component, version: info.version };
  }
  return byMajor;
}

/** Install (or find) a Java of the given major version. */
async function forMajor(major, report) {
  const byMajor = await mojangMajors().catch(() => ({}));
  if (byMajor[major]) {
    const p = await mojang.installJava(byMajor[major].component, report);
    if (p) return p;
  }
  const sys = detectSystem().find(j => j.major === major);
  if (sys) return sys.path;
  throw new Error(`Java ${major} is not available to download for this computer and none was found installed. Install Java ${major} or pick another Java in the instance settings.`);
}

/**
 * Pick the Java for a launch.
 * Order: instance custom path, instance major, global path, the version's own requirement
 * (Prism packs: a compatible major), Mojang's runtime for the Minecraft version.
 */
async function resolve(inst, settings, vanilla, report, { compatibleMajors } = {}) {
  if (inst.javaPath) {
    if (!fs.existsSync(inst.javaPath)) throw new Error(`The Java set for this instance was not found: ${inst.javaPath}`);
    return inst.javaPath;
  }
  if (inst.javaMajor) return forMajor(Number(inst.javaMajor), report);
  if (settings.javaPath) return settings.javaPath;
  const component = (vanilla.javaVersion && vanilla.javaVersion.component) || 'jre-legacy';
  const wantedMajor = vanilla.javaVersion && vanilla.javaVersion.majorVersion;
  if (compatibleMajors && compatibleMajors.length && !(wantedMajor && compatibleMajors.includes(wantedMajor))) {
    const prefs = [...compatibleMajors].sort((a, b) => (a === 21 ? -1 : b === 21 ? 1 : b - a));
    for (const m of prefs) { try { return await forMajor(m, report); } catch {} }
  }
  const java = await mojang.installJava(component, report);
  return java || (IS_WIN ? 'javaw' : 'java');
}

/** For the settings UI: which Java this instance would use and what is available. */
async function options() {
  let majors = {};
  try { majors = await mojangMajors(); } catch {}
  return {
    mojang: Object.entries(majors).map(([major, v]) => ({ major: Number(major), version: v.version })).sort((a, b) => a.major - b.major),
    system: detectSystem(),
  };
}

function test(javaPath) {
  if (!javaPath || !fs.existsSync(javaPath)) throw new Error('That file does not exist.');
  const v = versionOf(javaPath);
  if (!v) throw new Error('This does not look like a working Java.');
  return v;
}

module.exports = { resolve, options, test, detectSystem, versionOf, majorOf, forMajor };
