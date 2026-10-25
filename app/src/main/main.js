'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, protocol, net, safeStorage, nativeTheme } = require('electron');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { pathToFileURL } = require('url');

const IS_WIN = process.platform === 'win32';
if (process.platform === 'linux') {
  // Wayland / Hyprland: run natively when possible.
  app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
  app.commandLine.appendSwitch('enable-features', 'WaylandWindowDecorations');
}
// The keyring entry that protects saved accounts is named after the app at startup. Keep the
// pre-rename name until that is set up, then switch to "cairn" (window class / Wayland app id).
app.setName('mclauncher');
if (IS_WIN) app.setAppUserModelId('io.github.ppcharcoal.mclauncher'); // kept from before the rename (installer upgrade path)

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

const { P, readJson, writeJson, safeJoin } = require('./paths');
const netUtil = require('./net');
const auth = require('./auth');
const mojang = require('./mojang');
const fabric = require('./fabric');
const forge = require('./forge');
const instances = require('./instances');
const modrinth = require('./modrinth');
const curseforge = require('./curseforge');
const packs = require('./packs');
const integrity = require('./integrity');
const javaSel = require('./java');
const launch = require('./launch');

protocol.registerSchemesAsPrivileged([{ scheme: 'mcl', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);

const DEFAULT_SETTINGS = { memory: 4096, javaPath: '', jvmArgs: '', closeOnLaunch: true, gamemode: true, curseforgeKey: '', showSnapshots: false, theme: 'system', accent: '#5cc2a8', scale: 1, nativeWayland: 'auto', nvidiaThreadedFix: true, style: 'minimal' };
function getSettings() {
  const s = { ...DEFAULT_SETTINGS, ...readJson(P.settings, {}) };
  if (!/^#[0-9a-f]{6}$/i.test(s.accent)) s.accent = DEFAULT_SETTINGS.accent;
  if (!['system', 'dark', 'light'].includes(s.theme)) s.theme = 'system';
  return s;
}
function applyNativeTheme(theme) { nativeTheme.themeSource = theme; }
function windowBg() {
  const st = getSettings().style;
  if (st === 'darkmatter') return '#05060a';
  if (st === 'aero') return '#bfe6fa';
  return nativeTheme.shouldUseDarkColors ? '#181b22' : '#eceff3';
}

let win = null;
let pendingRoute = null;

function createWindow(route) {
  if (win && !win.isDestroyed()) { win.show(); win.focus(); if (route) send('navigate', route); return; }
  pendingRoute = route || null;
  const bounds = readJson(path.join(P.root, 'window.json'), { width: 1180, height: 760 });
  const settings = getSettings();
  applyNativeTheme({ aero: 'light', darkmatter: 'dark' }[settings.style] || settings.theme);
  win = new BrowserWindow({
    width: bounds.width, height: bounds.height, minWidth: 900, minHeight: 600,
    title: 'Cairn', backgroundColor: windowBg(), show: false, frame: false,
    icon: path.join(__dirname, '../../build/icon.png'),
    webPreferences: { preload: path.join(__dirname, '../preload.js'), sandbox: true, contextIsolation: true, spellcheck: false },
  });
  win.loadFile(path.join(__dirname, '../renderer/index.html'), { query: { theme: settings.theme, accent: settings.accent, style: settings.style || 'minimal', scale: String(settings.scale || 1) } });
  win.once('ready-to-show', () => { win.show(); focusOnHyprland(); });
  win.on('close', () => { try { const [width, height] = win.getSize(); writeJson(path.join(P.root, 'window.json'), { width, height }); } catch {} });
  win.on('closed', () => { win = null; });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('file:')) { e.preventDefault(); if (/^https?:/.test(url)) shell.openExternal(url); } });
  win.on('maximize', () => send('window', { maximized: true }));
  win.on('unmaximize', () => send('window', { maximized: false }));
}

function focusOnHyprland() {
  if (!process.env.HYPRLAND_INSTANCE_SIGNATURE) return;
  execFile('hyprctl', ['dispatch', 'focuswindow', `pid:${process.pid}`], () => {});
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send('event', channel, payload);
}

// ---------- background tasks (progress shown in the UI) ----------
const tasks = new Map();
let taskSeq = 0;
function startTask(title) {
  const id = ++taskSeq;
  const t = { id, title, status: title, progress: null, done: false, error: null };
  tasks.set(id, t);
  send('task', t);
  let last = 0;
  const report = (status, progress = null) => {
    t.status = status; t.progress = progress;
    const now = Date.now();
    if (now - last > 120 || progress === 1 || progress === null) { last = now; send('task', t); }
  };
  const finish = (error) => { t.done = true; t.error = error ? String(error.message || error) : null; send('task', t); setTimeout(() => tasks.delete(id), 4000); };
  return { report, finish, id };
}
async function runTask(title, fn) {
  const t = startTask(title);
  try { const r = await fn(t.report); t.finish(); return r; } catch (e) { t.finish(e); throw e; }
}

// ---------- game sessions ----------
const sessions = new Map(); // instId -> session
const MAX_LINES = 40000;

function sessionInfo(s) {
  return s && { instId: s.instId, state: s.state, startedAt: s.startedAt, endedAt: s.endedAt, code: s.code, crashReport: s.crashReport, logFile: s.logFile, lineCount: s.lines.length };
}

async function launchInstance(instId, opts = {}) {
  const existing = sessions.get(instId);
  if (existing && (existing.state === 'running' || existing.state === 'starting' || existing.state === 'preparing')) throw new Error('This instance is already running.');
  const settings = getSettings();
  const inst = instances.get(instId);
  const s = { instId, state: 'preparing', lines: [], startedAt: Date.now(), code: null, proc: null, pending: [] };
  sessions.set(instId, s);
  send('session', sessionInfo(s));
  let prep, account;
  try {
    prep = await runTask(`Launching ${inst.name}`, async (report) => {
      account = await auth.getLaunchAccount();
      return launch.prepare(inst, account, settings, report);
    });
  } catch (e) {
    s.state = 'failed'; s.code = -1; s.lines.push(`[Cairn] ${e.message}`);
    send('session', sessionInfo(s));
    throw e;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  s.logFile = path.join(P.logs, `${instId}_${stamp}.log`);
  const stream = fs.createWriteStream(s.logFile);
  stream.write(`# Cairn ${netUtil.VERSION} — ${inst.name} (Minecraft ${inst.mcVersion}${inst.loader === 'fabric' ? ', Fabric ' + inst.loaderVersion : ''})\n`);
  stream.write(`# Java: ${prep.java}\n`);
  s.state = 'starting';
  instances.update(instId, { lastPlayed: Date.now() });
  send('session', sessionInfo(s));

  const closeLauncher = opts.closeOnLaunch ?? settings.closeOnLaunch;
  let hidden = false;
  const markRunning = () => {
    if (s.state !== 'starting') return;
    s.state = 'running';
    send('session', sessionInfo(s));
    if (closeLauncher && win && !win.isDestroyed()) { hidden = true; win.destroy(); }
  };
  const readyTimer = setTimeout(markRunning, 45000);
  if (process.env.MCL_TEST_EXIT_AFTER_READY) setTimeout(() => { try { s.proc.kill('SIGKILL'); } catch {} }, 300000);
  const flush = setInterval(() => { if (s.pending.length) { send('log', { instId, lines: s.pending }); s.pending = []; } }, 150);

  s.proc = launch.start(prep, settings, {
    onLine(line, isErr) {
      s.lines.push(line);
      if (s.lines.length > MAX_LINES) s.lines.splice(0, s.lines.length - MAX_LINES);
      s.pending.push(line);
      stream.write(line + '\n');
      if (s.state === 'starting' && /Backend library:|Sound engine started|OpenAL initialized|Created: \d+x\d+x\d+ minecraft:textures|Created: \d+x\d+ textures-atlas|Reloading ResourceManager/.test(line)) {
        clearTimeout(readyTimer); markRunning();
      }
      if (process.env.MCL_TEST_READY_PATTERN && new RegExp(process.env.MCL_TEST_READY_PATTERN).test(line)) {
        clearTimeout(readyTimer); markRunning();
        setTimeout(() => { try { s.proc.kill('SIGTERM'); } catch {} }, 3000);
      } else if (process.env.MCL_TEST_EXIT_AFTER_READY && /Sound engine started|Created: \d+x\d+x\d+ minecraft:textures|Created: \d+x\d+ textures-atlas/.test(line)) {
        setTimeout(() => { try { s.proc.kill('SIGTERM'); } catch {} }, 3000);
      }
    },
    onExit(code) {
      clearTimeout(readyTimer); clearInterval(flush);
      if (s.pending.length) { send('log', { instId, lines: s.pending }); s.pending = []; }
      const ended = Date.now();
      s.state = 'exited'; s.code = code; s.endedAt = ended;
      stream.end(`# exited with code ${code}\n`);
      try { const cur = instances.get(instId); instances.update(instId, { playTime: (cur.playTime || 0) + Math.round((ended - s.startedAt) / 1000) }); } catch {}
      try {
        const dir = path.join(instances.gameDir(instId), 'crash-reports');
        if (code !== 0 && fs.existsSync(dir)) {
          const newest = fs.readdirSync(dir).map(f => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs })).filter(x => x.t >= s.startedAt).sort((a, b) => b.t - a.t)[0];
          if (newest) s.crashReport = `crash-reports/${newest.f}`;
        }
      } catch {}
      if (hidden || !win || win.isDestroyed()) createWindow({ page: 'instance', id: instId, tab: 'logs' });
      else send('session', sessionInfo(s));
      if (process.env.MCL_TEST_RESULT) {
        fs.writeFileSync(process.env.MCL_TEST_RESULT, JSON.stringify({ code, reachedRunning: hidden || s.lines.some(l => /Sound engine started|Backend library/.test(l)), started: s.lines.some(l => /Setting user:|Loading Minecraft .* with Fabric/.test(l)), sawWindow: s.lines.some(l => /Sound engine started|Created: \d+x\d+x\d+ minecraft:textures|textures-atlas/.test(l)), glfwError: s.lines.find(l => /GLFW error/.test(l)) || null, readyPattern: !!process.env.MCL_TEST_READY_PATTERN && s.lines.some(l => new RegExp(process.env.MCL_TEST_READY_PATTERN).test(l)), fmlStarted: s.lines.some(l => /Forge Mod Loader version|ModLauncher running|Loading Minecraft .* with Fabric/.test(l)), hidden, lines: s.lines.length, tail: s.lines.slice(-40) }, null, 2));
        setTimeout(() => app.quit(), 4000);
      }
    },
  });
  return sessionInfo(s);
}

// ---------- IPC ----------
function modSource(src) { return src === 'curseforge' ? curseforge : modrinth; }

const api = {
  // app / window
  appInfo: () => ({ version: netUtil.VERSION, platform: process.platform, dataDir: P.root, hyprland: !!process.env.HYPRLAND_INSTANCE_SIGNATURE, wayland: process.env.XDG_SESSION_TYPE === 'wayland', gamemode: !IS_WIN && launch.hasCommand('gamemoderun') }),
  startupRoute: () => { const r = pendingRoute; pendingRoute = null; return r; },
  winMinimize: () => win && win.minimize(),
  winMaximize: () => win && (win.isMaximized() ? win.unmaximize() : win.maximize()),
  winClose: () => win && win.close(),
  openExternal: (url) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); },
  getSettings,
  setSettings: (patch) => {
    const s = { ...getSettings(), ...patch };
    writeJson(P.settings, s);
    curseforge.setKey(s.curseforgeKey);
    if ('theme' in patch || 'style' in patch) {
      const forced = { aero: 'light', darkmatter: 'dark' }[s.style];
      applyNativeTheme(forced || s.theme);
      if (win && !win.isDestroyed()) win.setBackgroundColor(windowBg());
    }
    return getSettings();
  },
  openDataDir: () => shell.openPath(P.root),
  fontData: (file) => {
    const name = path.basename(String(file));
    if (!/^[a-z-]+\.woff2$/.test(name)) throw new Error('bad font');
    return fs.readFileSync(path.join(__dirname, '../renderer/fonts', name));
  },
  rendererLog: (msg) => { try { fs.appendFileSync(path.join(P.logs, 'launcher-ui.log'), `${new Date().toISOString()} ${String(msg).slice(0, 2000)}\n`); } catch {} },
  systemFonts: () => new Promise((resolve) => {
    if (process.platform !== 'linux') return resolve([]);
    execFile('fc-list', [':', 'family'], { maxBuffer: 8 << 20 }, (err, out) => {
      if (err) return resolve([]);
      const set = new Set();
      for (const line of out.split('\n')) { const f = line.split(',')[0].trim(); if (f) set.add(f); }
      resolve([...set].sort((a, b) => a.localeCompare(b)));
    });
  }),

  // accounts
  accounts: () => auth.publicAccounts(),
  addAccount: () => auth.addAccount(BrowserWindow, win),
  setActiveAccount: (id) => auth.setActive(id),
  removeAccount: (id) => auth.removeAccount(id),

  // versions
  mcVersions: async () => (await mojang.getManifest()).versions.map(v => ({ id: v.id, type: v.type, released: v.releaseTime })),
  fabricGameVersions: async () => (await fabric.gameVersions()).map(v => v.version),
  fabricLoaders: (mc) => fabric.loaderVersions(mc),
  loaderGameVersions: async (loader) => loader === 'fabric' ? (await fabric.gameVersions()).map(v => v.version) : forge.gameVersions(loader),
  loaderVersions: async (loader, mc) => loader === 'fabric'
    ? (await fabric.loaderVersions(mc)).map(l => ({ ...l, label: l.version }))
    : forge.loaderVersions(loader, mc),

  // instances
  instances: () => instances.list().map(i => ({ ...i, session: sessionInfo(sessions.get(i.id)) })),
  instance: (id) => ({ ...instances.get(id), session: sessionInfo(sessions.get(id)) }),
  createInstance: (opts) => instances.create(opts),
  updateInstance: (id, patch) => instances.update(id, patch),
  deleteInstance: async (id) => { if (sessions.get(id) && sessions.get(id).state === 'running') throw new Error('Close the game first.'); await instances.remove(id, shell); sessions.delete(id); },
  duplicateInstance: (id) => instances.duplicate(id),
  pickIcon: async (id) => {
    const r = await dialog.showOpenDialog(win, { title: 'Choose a picture', filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }], properties: ['openFile'] });
    if (r.canceled || !r.filePaths[0]) return null;
    return instances.setIcon(id, { file: r.filePaths[0] });
  },
  setIconFromPath: (id, file) => instances.setIcon(id, { file }),
  pickImagePath: async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Choose a picture', filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }], properties: ['openFile'] });
    return r.canceled ? null : r.filePaths[0] || null;
  },
  imageDataUrl: (file) => {
    const ext = path.extname(file).slice(1).toLowerCase().replace('jpg', 'jpeg');
    if (!['png', 'jpeg', 'webp', 'gif'].includes(ext)) throw new Error('Not an image');
    if (fs.statSync(file).size > 15 * 1024 * 1024) throw new Error('Image is larger than 15 MB.');
    return `data:image/${ext};base64,${fs.readFileSync(file).toString('base64')}`;
  },
  clearIcon: (id) => instances.setIcon(id, {}),
  content: (id, kind) => instances.listContent(id, kind),
  toggleContent: (id, kind, file) => instances.toggleContent(id, kind, file),
  deleteContent: (id, kind, file) => instances.deleteContent(id, kind, file, shell),
  addContentFiles: (id, kind, files) => instances.addFiles(id, kind, files),
  pickContentFiles: async (id, kind) => {
    const filters = { mods: [{ name: 'Fabric mods', extensions: ['jar'] }], resourcepacks: [{ name: 'Resource packs', extensions: ['zip'] }], shaderpacks: [{ name: 'Shader packs', extensions: ['zip'] }] }[kind];
    const r = await dialog.showOpenDialog(win, { title: 'Add files', filters, properties: ['openFile', 'multiSelections'] });
    if (r.canceled) return 0;
    instances.addFiles(id, kind, r.filePaths);
    return r.filePaths.length;
  },
  openFolder: (id, rel = '') => { const p = instances.resolvePath(id, rel); fs.mkdirSync(p, { recursive: true }); return shell.openPath(p); },
  openPath: (id, rel) => shell.openPath(instances.resolvePath(id, rel)),
  showInFolder: (id, rel) => shell.showItemInFolder(instances.resolvePath(id, rel)),
  listDir: (id, rel) => instances.listDir(id, rel),
  trashPath: async (id, rel) => { if (!rel) throw new Error('Refusing to delete the game folder.'); await shell.trashItem(instances.resolvePath(id, rel)); },
  readText: (id, rel) => {
    const p = instances.resolvePath(id, rel);
    const st = fs.statSync(p);
    if (st.size > 4 * 1024 * 1024) throw new Error('This file is too large to preview.');
    return fs.readFileSync(p, 'utf8');
  },
  writeText: (id, rel, content) => {
    if (typeof content !== 'string') throw new Error('Nothing to save');
    if (Buffer.byteLength(content) > 8 * 1024 * 1024) throw new Error('This file is too large to save from here.');
    const p = instances.resolvePath(id, rel);
    if (!fs.existsSync(p) || !fs.statSync(p).isFile()) throw new Error('The file no longer exists.');
    const tmp = p + '.mcl-save';
    fs.writeFileSync(tmp, content, 'utf8');
    fs.renameSync(tmp, p);
    return true;
  },
  identify: (id) => runTask('Identifying files', () => modrinth.identifyInstance(id)),
  checkUpdates: (id) => runTask('Checking for updates', () => modrinth.checkUpdates(id)),
  applyUpdates: (id, list) => runTask('Updating', async (report) => {
    for (const u of list) await modrinth.installVersion(id, u.version, u.kind, { title: u.title, icon: u.icon }, new Set(), report);
  }),

  // launching
  launch: (id) => launchInstance(id),
  kill: (id) => { const s = sessions.get(id); if (s && s.proc) s.proc.kill('SIGTERM'); },
  sessionLog: (id) => { const s = sessions.get(id); return s ? { info: sessionInfo(s), lines: s.lines } : null; },
  pastLogs: (id) => fs.readdirSync(P.logs).filter(f => f.startsWith(id + '_') && f.endsWith('.log')).sort().reverse().slice(0, 30)
    .map(f => ({ file: f, size: fs.statSync(path.join(P.logs, f)).size, mtime: fs.statSync(path.join(P.logs, f)).mtimeMs })),
  readPastLog: (id, file) => { if (!file.startsWith(id + '_')) throw new Error('Bad log'); return fs.readFileSync(safeJoin(P.logs, file), 'utf8'); },

  // browsing
  search: (src, params) => modSource(src).search(params),
  project: (src, id) => modSource(src).project(id),
  versions: (src, id, params) => modSource(src).versions(id, params),
  install: async (src, instId, projectId, kind, info) => {
    try {
      return await runTask(`Installing ${info.title || 'content'}`, (report) => modSource(src).installProject(instId, projectId, kind, info, report));
    } catch (e) { if (e.blocked) return { blocked: e.blocked }; throw e; }
  },
  installVersion: async (src, instId, version, kind, info) => {
    try {
      return await runTask(`Installing ${info.title || 'content'}`, (report) => modSource(src).installVersion(instId, version, kind, info, new Set(), report));
    } catch (e) { if (e.blocked) return { blocked: e.blocked }; throw e; }
  },
  installModpack: async (src, projectId, versionId, info) => {
    try {
      return await runTask(`Installing ${info.title}`, async (report) => {
        if (src === 'curseforge') return curseforge.installModpack(projectId, versionId, { ...info, report });
        const inst = await modrinth.installModpack(versionId, { ...info, projectId, report });
        return { instance: inst, blocked: inst.missing || [] };
      });
    } catch (e) { if (e.blocked) return { blocked: e.blocked }; throw e; }
  },
  importPack: async (file, kind = 'file') => {
    if (!file) {
      const r = kind === 'folder'
        ? await dialog.showOpenDialog(win, { title: 'Import a Prism/MultiMC instance or game folder', properties: ['openDirectory'] })
        : await dialog.showOpenDialog(win, { title: 'Import a modpack', filters: [{ name: 'Modpacks (.mrpack, .zip)', extensions: ['mrpack', 'zip'] }, { name: 'All files', extensions: ['*'] }], properties: ['openFile'] });
      if (r.canceled || !r.filePaths[0]) return null;
      file = r.filePaths[0];
    }
    const isDir = fs.existsSync(file) && fs.statSync(file).isDirectory();
    return runTask(`Importing ${path.basename(file)}`, (report) => isDir ? packs.importFolder(file, report) : packs.importFile(file, report));
  },
  importRawInto: (instId, source) => runTask('Copying game files', () => packs.importRawInto(instId, source)),
  // modpack file checks
  packVerify: (id) => integrity.verify(id),
  packRepair: (id) => runTask('Checking modpack files', (report) => integrity.repair(id, report)),
  packAddFiles: async (id, files) => {
    if (!files) {
      const r = await dialog.showOpenDialog(win, { title: 'Add downloaded files', properties: ['openFile', 'multiSelections'] });
      if (r.canceled) return integrity.verify(id);
      files = r.filePaths;
    }
    return integrity.addManual(id, files);
  },
  packFromDownloads: (id) => integrity.fromFolder(id, app.getPath('downloads')),
  packForget: (id, paths) => integrity.forget(id, paths),
  javaOptions: () => javaSel.options(),
  javaTest: (p) => javaSel.test(p),
  pickJava: async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Choose a Java executable', properties: ['openFile'], filters: process.platform === 'win32' ? [{ name: 'Java', extensions: ['exe'] }] : [] });
    return r.canceled ? null : r.filePaths[0] || null;
  },
  prismComponents: (id) => require('./prism').components(id),
  waylandInfo: () => ({ linux: process.platform === 'linux', wayland: !!process.env.WAYLAND_DISPLAY, glfw: launch.systemGlfw() }),

  exportCandidates: (id) => packs.exportCandidates(id),
  exportPack: async (id, { format, include, name, version, summary }) => {
    const inst = instances.get(id);
    const ext = format === 'mrpack' ? 'mrpack' : 'zip';
    const r = await dialog.showSaveDialog(win, {
      title: 'Export modpack', defaultPath: path.join(app.getPath('downloads'), `${(name || inst.name).replace(/[^\w.-]+/g, '_')}${format === 'mrpack' ? '-' + (version || '1.0.0') : ''}.${ext}`),
      filters: [{ name: format === 'mrpack' ? 'Modrinth modpack' : 'Zip archive', extensions: [ext] }],
    });
    if (r.canceled || !r.filePath) return null;
    return runTask(`Exporting ${inst.name}`, async (report) => {
      if (format === 'mrpack') return { file: r.filePath, ...(await modrinth.exportMrpack(id, r.filePath, { include, name, version, summary }, report)) };
      packs.exportZip(id, r.filePath, { include });
      return { file: r.filePath };
    });
  },
  showFile: (file) => shell.showItemInFolder(file),
};

ipcMain.handle('call', async (_e, method, args) => {
  const fn = api[method];
  if (!fn) throw new Error('Unknown method ' + method);
  return fn(...(args || []));
});

/** CI only: visit each page and save a screenshot so the UI can be reviewed. */
async function runScreenshotTour(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  await new Promise(r => win.webContents.once('did-finish-load', r));
  const errors = [];
  win.webContents.on('console-message', (e) => { if (e.level === 'error' || e.level === 3) errors.push(e.message); });
  const first = instances.list().find(i => i.id === process.env.MCL_TEST_SHOT_INST) || instances.list()[0];
  const stops = [
    ['library', '#library'],
    ['instance-mods', first ? `#instance/${first.id}/mods` : '#library'],
    ['instance-shaders', first ? `#instance/${first.id}/shaderpacks` : '#library'],
    ['instance-worlds', first ? `#instance/${first.id}/saves` : '#library'],
    ['instance-files', first ? `#instance/${first.id}/files` : '#library'],
    ['instance-logs', first ? `#instance/${first.id}/logs` : '#library'],
    ['instance-settings', first ? `#instance/${first.id}/settings` : '#library'],
    ['discover-mods', first ? `#discover/mod/${first.id}` : '#discover/mod'],
    ['discover-modpacks', '#discover/modpack'],
    ['settings', '#settings'],
  ];
  for (const [name, hash] of stops) {
    await win.webContents.executeJavaScript(`location.hash = ${JSON.stringify(hash)}`);
    await wait(name.startsWith('discover') ? 6000 : 2500);
    fs.writeFileSync(path.join(dir, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  }
  await win.webContents.executeJavaScript(`location.hash = '#discover/mod'; setTimeout(() => document.querySelector('.result') && document.querySelector('.result').click(), 5000)`);
  await wait(9000);
  fs.writeFileSync(path.join(dir, 'discover-drawer.png'), (await win.webContents.capturePage()).toPNG());
  await win.webContents.executeJavaScript(`document.querySelector('.drawer-scrim') && document.querySelector('.drawer-scrim').remove(); location.hash = '#library'; setTimeout(() => Pages.newInstanceFlow(), 1500)`);
  await wait(6000);
  fs.writeFileSync(path.join(dir, 'new-instance.png'), (await win.webContents.capturePage()).toPNG());
  if (first) {
    await win.webContents.executeJavaScript(`document.querySelectorAll('.scrim').forEach(s => s.remove()); location.hash = '#instance/${first.id}/mods'; setTimeout(() => C.exportDialog(App.instances.find(i => i.id === ${JSON.stringify(first.id)})), 2000)`);
    await wait(4500);
    fs.writeFileSync(path.join(dir, 'export.png'), (await win.webContents.capturePage()).toPNG());
  }
  if (first) {
    // config editor
    await win.webContents.executeJavaScript(`document.querySelectorAll('.scrim').forEach(s => s.remove()); location.hash = '#instance/${first.id}/files'`);
    await wait(2000);
    const openConfig = async () => {
      const q = [...document.querySelectorAll('.quick button')].find(b => b.textContent.includes('config'));
      if (q) q.click();
      await new Promise(r => setTimeout(r, 900));
      const row = [...document.querySelectorAll('.file-row')].find(r => /\.(json|toml|properties|txt|json5)$/.test((r.querySelector('.n') || {}).textContent || ''));
      if (row) row.click();
      await new Promise(r => setTimeout(r, 700));
      const ta = document.querySelector('textarea.editor');
      if (ta) { ta.value += ' '; ta.dispatchEvent(new Event('input')); }
    };
    await win.webContents.executeJavaScript(`(${openConfig.toString()})()`);
    await wait(1800);
    fs.writeFileSync(path.join(dir, 'config-editor.png'), (await win.webContents.capturePage()).toPNG());
    // missing files dialog
    await win.webContents.executeJavaScript(`C.missingFiles(${JSON.stringify(first.id)}, [{ path: 'mods/example-mod-1.0.jar', title: 'Example Mod', fileName: 'example-mod-1.0.jar', folder: 'mods', url: 'https://www.curseforge.com/minecraft/mc-mods/example' }, { path: 'mods/another-2.3.jar', title: 'Another Mod', fileName: 'another-2.3.jar', folder: 'mods', url: 'https://www.curseforge.com/minecraft/mc-mods/another' }], { forLaunch: true }); 0`);
    await wait(1500);
    fs.writeFileSync(path.join(dir, 'missing-files.png'), (await win.webContents.capturePage()).toPNG());
    await win.webContents.executeJavaScript(`document.querySelectorAll('.scrim').forEach(s => s.remove()); C.importDialog(); 0`);
    await wait(1200);
    fs.writeFileSync(path.join(dir, 'import-dialog.png'), (await win.webContents.capturePage()).toPNG());
    await win.webContents.executeJavaScript(`document.querySelectorAll('.scrim').forEach(s => s.remove()); location.hash = '#settings'`);
    await wait(2500);
    await win.webContents.executeJavaScript(`document.querySelector('.style-cards') && document.querySelector('.style-cards').scrollIntoView({ block: 'center' })`);
    await wait(800);
    fs.writeFileSync(path.join(dir, 'settings-appearance.png'), (await win.webContents.capturePage()).toPNG());
    for (const st of ['glass', 'aero', 'darkmatter']) {
      await win.webContents.executeJavaScript(`document.querySelectorAll('.scrim').forEach(s => s.remove()); Theme.applyStyle('${st}'); location.hash = '#library'; 0`);
      await wait(2200);
      fs.writeFileSync(path.join(dir, `style-${st}-library.png`), (await win.webContents.capturePage()).toPNG());
      await win.webContents.executeJavaScript(`location.hash = '#instance/${first.id}/mods'; 0`);
      await wait(2200);
      fs.writeFileSync(path.join(dir, `style-${st}-instance.png`), (await win.webContents.capturePage()).toPNG());
      await win.webContents.executeJavaScript(`Pages.newInstanceFlow(); 0`);
      await wait(1500);
      fs.writeFileSync(path.join(dir, `style-${st}-dialog.png`), (await win.webContents.capturePage()).toPNG());
    }
    await win.webContents.executeJavaScript(`document.querySelectorAll('.scrim').forEach(s => s.remove()); Theme.applyStyle('minimal'); 0`);
  }
  const second = process.env.MCL_TEST_SHOT_INST2 && instances.list().find(i => i.id === process.env.MCL_TEST_SHOT_INST2);
  if (second) {
    await win.webContents.executeJavaScript(`document.querySelectorAll('.scrim').forEach(s => s.remove()); location.hash = '#instance/${second.id}/mods'; 0`);
    await wait(4000);
    fs.writeFileSync(path.join(dir, 'second-mods.png'), (await win.webContents.capturePage()).toPNG());
    await win.webContents.executeJavaScript(`location.hash = '#instance/${second.id}/settings'; 0`);
    await wait(4000);
    fs.writeFileSync(path.join(dir, 'second-settings.png'), (await win.webContents.capturePage()).toPNG());
    await win.webContents.executeJavaScript(`(document.querySelector('.settings-wrap .section:nth-child(3)') || document.body).scrollIntoView(); 0`);
    await wait(1200);
    fs.writeFileSync(path.join(dir, 'second-settings-java.png'), (await win.webContents.capturePage()).toPNG());
  }
  // light theme + another accent
  await win.webContents.executeJavaScript(`document.querySelectorAll('.scrim').forEach(s => s.remove()); Theme.apply('light', '#5aa9f0'); location.hash = '#library'`);
  await wait(2500);
  fs.writeFileSync(path.join(dir, 'light-library.png'), (await win.webContents.capturePage()).toPNG());
  if (first) {
    await win.webContents.executeJavaScript(`location.hash = '#instance/${first.id}/mods'`);
    await wait(2500);
    fs.writeFileSync(path.join(dir, 'light-instance.png'), (await win.webContents.capturePage()).toPNG());
  }
  await win.webContents.executeJavaScript(`location.hash = '#settings'`);
  await wait(2500);
  fs.writeFileSync(path.join(dir, 'light-settings.png'), (await win.webContents.capturePage()).toPNG());
  fs.writeFileSync(path.join(dir, 'console-errors.txt'), errors.join('\n'));
  app.quit();
}

app.on('second-instance', () => createWindow());
app.on('window-all-closed', () => {
  const playing = [...sessions.values()].some(s => s.state === 'running' || s.state === 'starting' || s.state === 'preparing');
  if (!playing) app.quit();
});

app.whenReady().then(() => {
  app.setName('cairn');
  netUtil.useElectronNet(net);
  auth.init({ safeStorage });
  curseforge.setKey(getSettings().curseforgeKey);
  protocol.handle('mcl', (req) => {
    const u = new URL(req.url);
    const rel = decodeURIComponent(u.hostname + u.pathname);
    let file;
    try { file = safeJoin(P.root, rel); } catch { return new Response('bad path', { status: 400 }); }
    return net.fetch(pathToFileURL(file).toString());
  });
  createWindow();
  if (process.env.MCL_TEST_SHOTS) runScreenshotTour(process.env.MCL_TEST_SHOTS);
  if (process.env.MCL_TEST_LAUNCH) {
    // CI smoke test: launch an instance offline and report the result.
    setTimeout(() => launchInstance(process.env.MCL_TEST_LAUNCH).catch(e => {
      fs.writeFileSync(process.env.MCL_TEST_RESULT, JSON.stringify({ error: e.message, stack: e.stack }));
      app.quit();
    }), 1500);
  }
});
