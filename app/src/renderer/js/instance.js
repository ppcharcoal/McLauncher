'use strict';
window.Pages = window.Pages || {};

const TABS = [
  ['mods', 'Mods'], ['resourcepacks', 'Resource packs'], ['shaderpacks', 'Shaders'], ['saves', 'Worlds'],
  ['screenshots', 'Screenshots'], ['files', 'Files'], ['logs', 'Logs'], ['settings', 'Settings'],
];
const KIND_TYPE = { mods: 'mod', resourcepacks: 'resourcepack', shaderpacks: 'shader' };
const KIND_NOUN = { mods: 'mod', resourcepacks: 'resource pack', shaderpacks: 'shader pack' };
const KIND_ICON = { mods: 'cube', resourcepacks: 'layers', shaderpacks: 'sun' };
const LIVE = ['running', 'starting', 'preparing'];
const MODDED = (i) => ['fabric', 'forge', 'neoforge'].includes(i.loader);

Pages.instance = async (main, route) => {
  const { h } = U;
  let inst = await U.call('instance', route.id);
  const tab = TABS.some(t => t[0] === route.tab) ? route.tab : 'mods';
  const cleanups = [];

  // ---------- hero ----------
  const hero = h('div.hero');
  function renderHero() {
    const live = inst.session && LIVE.includes(inst.session.state);
    const backdrop = h('div.backdrop' + (inst.iconUrl ? '' : '.pixelbg'));
    if (inst.iconUrl) backdrop.style.backgroundImage = `url("${inst.iconUrl}")`;
    else backdrop.style.backgroundImage = `url("${U.blockArt(inst.id).toDataURL()}")`;
    const stateText = !inst.session ? null : {
      preparing: 'Getting files ready…', starting: 'Starting Minecraft…', running: 'Playing now',
    }[inst.session.state];
    hero.replaceChildren(backdrop, h('div.hero-inner',
      h('div.pic', { title: 'Change picture', on: { click: changePicture } }, U.instPic(inst), h('div.edit', 'Change picture')),
      h('div.grow',
        h('h1', inst.name),
        h('div.meta',
          h('span.badge', `Minecraft ${inst.mcVersion}`),
          h('span.badge', U.loaderVersionLabel(inst)),
          inst.prism ? h('span.badge', { title: (inst.components || []).join('\n') }, 'Prism pack') : null,
          inst.source && inst.source.version ? h('span.badge', `Pack ${inst.source.version}`) : null,
          h('span', U.duration(inst.playTime)),
          stateText ? h('span', { style: { color: 'var(--accent)', fontWeight: 600 } }, stateText) : null)),
      h('div.actions',
        h('button.btn.icon', { title: 'Open game folder', 'aria-label': 'Open game folder', on: { click: () => U.call('openFolder', inst.id, '') } }, U.svg('folder')),
        h('button.btn.icon', { title: 'Export modpack', 'aria-label': 'Export modpack', on: { click: () => C.exportDialog(inst) } }, U.svg('upload')),
        h('button.btn.icon', { title: 'More', 'aria-label': 'More actions', on: { click: moreMenu } }, U.svg('more')),
        live
          ? h('button.btn.danger.solid.play-btn', { on: { click: () => U.call('kill', inst.id) } }, U.svg('stop'), inst.session.state === 'running' ? 'Stop' : 'Cancel')
          : h('button.btn.primary.play-btn', { on: { click: async () => { await Pages.play(inst); refresh(); } } }, U.svg('play'), 'Play'))));
  }
  async function refresh() { inst = await U.call('instance', inst.id); renderHero(); }
  async function changePicture() {
    try { const r = await U.call('pickIcon', inst.id); if (r) { inst = { ...inst, ...r }; renderHero(); App.refreshInstances(); } } catch (e) { C.toast(e.message, 'err'); }
  }
  function moreMenu() {
    C.modal({ title: inst.name, body: h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
      h('button.btn', { on: { click: async () => { const d = await U.call('duplicateInstance', inst.id); document.querySelector('.scrim').remove(); await App.refreshInstances(); App.go(`#instance/${d.id}`); } } }, U.svg('copy'), 'Duplicate instance'),
      h('button.btn', { on: { click: () => { document.querySelector('.scrim').remove(); C.exportDialog(inst); } } }, U.svg('upload'), 'Export modpack'),
      h('button.btn', { on: { click: async () => {
        document.querySelector('.scrim').remove();
        try {
          const r = await U.call('packRepair', inst.id);
          const v = await U.call('packVerify', inst.id);
          if (!v.total) C.toast('This instance was not installed from a modpack, so there is no file list to check.');
          else if (!r.missing.length) C.toast(r.fixed ? `Downloaded ${r.fixed} missing file${r.fixed === 1 ? '' : 's'}. All ${v.total} modpack files are in place.` : `All ${v.total} modpack files are in place.`);
          else C.missingFiles(inst.id, r.missing);
        } catch (e) { C.toast(e.message, 'err'); }
      } } }, U.svg('check'), 'Check modpack files'),
      inst.iconUrl ? h('button.btn', { on: { click: async () => { await U.call('clearIcon', inst.id); document.querySelector('.scrim').remove(); refresh(); App.refreshInstances(); } } }, U.svg('image'), 'Remove picture') : null,
      h('button.btn.danger', { on: { click: async () => {
        document.querySelector('.scrim').remove();
        if (await C.confirm(`Delete ${inst.name}?`, 'The instance, its mods and its worlds are moved to the trash.', { ok: 'Delete instance', danger: true })) {
          try { await U.call('deleteInstance', inst.id); await App.refreshInstances(); App.go('#library'); } catch (e) { C.toast(e.message, 'err'); }
        }
      } } }, U.svg('trash'), 'Delete instance')), actions: [{ label: 'Close' }] });
  }
  renderHero();
  cleanups.push(window.mcl.on('session', (s) => { if (s && s.instId === inst.id) refresh(); }));

  // ---------- tabs ----------
  const tabs = h('div.tabs', { role: 'tablist' }, TABS.map(([k, label]) => h('button' + (k === tab ? '.on' : ''), { role: 'tab', on: { click: () => App.go(`#instance/${inst.id}/${k}`) } }, label)));
  const body = h('div');
  main.append(hero, h('div.inst-body', tabs, body));
  const tabCleanup = await TAB_RENDER[tab](body, inst, { refresh });
  if (tabCleanup) cleanups.push(tabCleanup);
  return () => cleanups.forEach(f => f && f());
};

// ---------- content lists (mods / resource packs / shaders) ----------
async function renderContentTab(body, inst, kind) {
  const { h } = U;
  let items = [];
  let filter = '';
  const listEl = h('div.list');
  const countEl = h('span.muted');
  const draw = () => {
    const shown = items.filter(i => !filter || (i.title + ' ' + i.file).toLowerCase().includes(filter));
    countEl.textContent = `${items.length} ${KIND_NOUN[kind]}${items.length === 1 ? '' : 's'}${items.some(i => !i.enabled) ? `, ${items.filter(i => !i.enabled).length} turned off` : ''}`;
    if (!items.length) {
      listEl.replaceChildren(h('div.empty', { style: { border: 0 } },
        h('h3', `No ${KIND_NOUN[kind]}s yet`),
        h('p', kind === 'mods' && !MODDED(inst) ? 'This is a vanilla instance. Pick Fabric, Forge or NeoForge in Settings to use mods.' : `Find ${KIND_NOUN[kind]}s on Modrinth or CurseForge, or drop files here.`),
        kind === 'mods' && !MODDED(inst) ? null : h('button.btn.primary', { on: { click: () => App.go(`#discover/${KIND_TYPE[kind]}/${inst.id}`) } }, U.svg('search'), `Browse ${KIND_NOUN[kind]}s`)));
      return;
    }
    listEl.replaceChildren(...shown.map(it => {
      const ico = it.icon ? h('img.ico', { src: it.icon, alt: '', loading: 'lazy', on: { error: (e) => e.target.replaceWith(h('div.ico', U.svg(KIND_ICON[kind]))) } }) : h('div.ico', U.svg(KIND_ICON[kind]));
      const sw = h('label.switch', { title: it.enabled ? 'Turn off' : 'Turn on' },
        h('input', { type: 'checkbox', checked: it.enabled, 'aria-label': `${it.title} enabled`, on: { change: async () => { try { await U.call('toggleContent', inst.id, kind, it.file); load(); } catch (e) { C.toast(e.message, 'err'); } } } }),
        h('span'));
      return h('div.item' + (it.enabled ? '' : '.off'), ico,
        h('div.txt', h('b', it.title), h('small', [it.modVersion, it.file].filter(Boolean).join('   '))),
        h('div.tags', U.envBadge(it.env === '*' ? null : it.env, false), it.source ? h('span.badge', it.source === 'curseforge' ? 'CurseForge' : 'Modrinth') : null),
        sw,
        h('button.btn.small.icon.ghost', { title: 'Delete', 'aria-label': `Delete ${it.title}`, on: { click: async () => {
          if (!(await C.confirm(`Delete ${it.title}?`, 'The file is moved to the trash.', { ok: 'Delete', danger: true }))) return;
          await U.call('deleteContent', inst.id, kind, it.file); load();
        } } }, U.svg('trash')));
    }));
    if (!shown.length) listEl.replaceChildren(h('div.empty', { style: { border: 0 } }, h('p', 'Nothing matches your search.')));
  };
  async function load() { items = await U.call('content', inst.id, kind); draw(); }

  listEl.addEventListener('dragover', e => { e.preventDefault(); listEl.classList.add('drop'); });
  listEl.addEventListener('dragleave', () => listEl.classList.remove('drop'));
  listEl.addEventListener('drop', async e => {
    e.preventDefault(); e.stopPropagation(); listEl.classList.remove('drop');
    const files = [...e.dataTransfer.files].map(f => window.mcl.pathForFile(f)).filter(Boolean);
    if (!files.length) return;
    try { await U.call('addContentFiles', inst.id, kind, files); C.toast(`Added ${files.length} file${files.length === 1 ? '' : 's'}`); load(); } catch (err) { C.toast(err.message, 'err'); }
  });

  const tools = h('div.toolbar',
    h('div.search', U.svg('search'), h('input.input', { placeholder: `Search ${KIND_NOUN[kind]}s`, on: { input: e => { filter = e.target.value.toLowerCase(); draw(); } } })),
    countEl, h('div.spacer'),
    kind === 'mods' ? h('button.btn', { on: { click: () => checkUpdates(inst, load) } }, U.svg('refresh'), 'Check for updates') : null,
    h('button.btn', { on: { click: () => U.call('openFolder', inst.id, kind) } }, U.svg('folder'), 'Open folder'),
    h('button.btn', { on: { click: async () => { const n = await U.call('pickContentFiles', inst.id, kind); if (n) { C.toast(`Added ${n} file${n === 1 ? '' : 's'}`); load(); } } } }, U.svg('plus'), 'Add files'),
    h('button.btn.primary', { disabled: kind === 'mods' && !MODDED(inst), on: { click: () => App.go(`#discover/${KIND_TYPE[kind]}/${inst.id}`) } }, U.svg('search'), `Browse ${KIND_NOUN[kind]}s`));
  body.append(tools, listEl, h('p.drop-hint', `Drop ${kind === 'mods' ? '.jar' : '.zip'} files on the list to add them.`));
  listEl.append(h('div.loading', h('span.spinner')));
  await load();
  if (items.some(i => !i.source)) U.call('identify', inst.id).then(n => { if (n) load(); }).catch(() => {});
}

async function checkUpdates(inst, reload) {
  const { h } = U;
  let list;
  try { list = await U.call('checkUpdates', inst.id); } catch (e) { return C.toast(e.message, 'err'); }
  if (!list.length) return C.toast('Everything is up to date');
  C.modal({
    title: `${list.length} update${list.length === 1 ? '' : 's'} available`, wide: true,
    body: h('div.list', list.map(u => h('div.item', u.icon ? h('img.ico', { src: u.icon, alt: '' }) : h('div.ico', U.svg('cube')),
      h('div.txt', h('b', u.title), h('small', `New version ${u.number}`))))),
    actions: [{ label: 'Later' }, { label: 'Update all', kind: 'primary', onClick: async () => { await U.call('applyUpdates', inst.id, list); C.toast('Updated'); reload(); } }],
  });
}

// ---------- worlds & screenshots ----------
async function renderWorlds(body, inst) {
  const { h } = U;
  const worlds = await U.call('content', inst.id, 'saves');
  body.append(h('div.toolbar', h('span.muted', `${worlds.length} world${worlds.length === 1 ? '' : 's'}`), h('div.spacer'),
    h('button.btn', { on: { click: () => U.call('openFolder', inst.id, 'saves') } }, U.svg('folder'), 'Open worlds folder')));
  if (!worlds.length) return body.append(h('div.empty', h('h3', 'No worlds yet'), h('p', 'Worlds you create in game appear here. You can also copy world folders into the worlds folder.')));
  body.append(h('div.worlds', worlds.map(w => h('div.world',
    w.icon ? h('img.shot', { src: w.icon, alt: '' }) : (() => { const c = U.blockArt(w.file, 16); c.classList.add('shot'); return c; })(),
    h('div.info', h('div', h('b', w.file), h('small', `Played ${U.ago(w.mtime)}`)),
      h('button.btn.small.icon.ghost', { title: 'Open folder', 'aria-label': `Open ${w.file} folder`, on: { click: () => U.call('openFolder', inst.id, `saves/${w.file}`) } }, U.svg('folder')),
      h('button.btn.small.icon.ghost', { title: 'Delete world', 'aria-label': `Delete ${w.file}`, on: { click: async () => {
        if (await C.confirm(`Delete ${w.file}?`, 'The world folder is moved to the trash.', { ok: 'Delete world', danger: true })) { await U.call('deleteContent', inst.id, 'saves', w.file); body.replaceChildren(); renderWorlds(body, inst); }
      } } }, U.svg('trash')))))));
}

async function renderShots(body, inst) {
  const { h } = U;
  const shots = await U.call('content', inst.id, 'screenshots');
  body.append(h('div.toolbar', h('span.muted', `${shots.length} screenshot${shots.length === 1 ? '' : 's'}`), h('div.spacer'),
    h('button.btn', { on: { click: () => U.call('openFolder', inst.id, 'screenshots') } }, U.svg('folder'), 'Open folder')));
  if (!shots.length) return body.append(h('div.empty', h('h3', 'No screenshots yet'), h('p', 'Press F2 in game to take one.')));
  body.append(h('div.shots', shots.map(s => h('img', { src: s.icon, alt: s.file, loading: 'lazy', title: s.file, on: { click: () => U.call('openPath', inst.id, `screenshots/${s.file}`) } }))));
}

// ---------- file browser ----------
const TEXT_EXT = /\.(txt|json|json5|toml|properties|cfg|conf|ini|log|yml|yaml|mcmeta|md|snbt|js|zs|csv)$/i;
async function renderFiles(body, inst) {
  const { h } = U;
  let rel = '';
  let selected = null;
  const crumbs = h('div.crumbs');
  const listEl = h('div.list');
  const preview = h('div.preview', h('p.faint', { style: { margin: 0 } }, 'Select a config or text file to view and edit it here. Double-click any file to open it with your default app.'));
  const quick = h('div.quick', ['mods', 'config', 'resourcepacks', 'shaderpacks', 'saves', 'logs', 'crash-reports'].map(d => h('button.btn.small', { on: { click: () => open(d) } }, U.svg('folder'), d)));
  async function open(path) {
    rel = path; selected = null; editor = null;
    const parts = rel ? rel.split('/') : [];
    crumbs.replaceChildren(h('button', { on: { click: () => open('') } }, 'minecraft'), ...parts.flatMap((p, i) => ['/', h('button', { on: { click: () => open(parts.slice(0, i + 1).join('/')) } }, p)]));
    let entries = [];
    try { entries = await U.call('listDir', inst.id, rel); } catch (e) { C.toast(e.message, 'err'); }
    const rows = [];
    if (rel) rows.push(h('div.file-row.dir', { on: { dblclick: () => open(parts.slice(0, -1).join('/')) } }, U.svg('back'), h('span.n', '..'), h('span.s')));
    for (const e of entries) {
      const p = rel ? `${rel}/${e.name}` : e.name;
      const row = h('div.file-row' + (e.isDir ? '.dir' : ''), { tabindex: 0,
        on: {
          click: async () => { if (selected === p || !(await confirmLeave())) return; listEl.querySelectorAll('.sel').forEach(x => x.classList.remove('sel')); row.classList.add('sel'); selected = p; showPreview(e, p); },
          dblclick: async () => { if (e.isDir) { if (await confirmLeave()) open(p); } else U.call('openPath', inst.id, p); },
          keydown: (ev) => { if (ev.key === 'Enter') e.isDir ? open(p) : U.call('openPath', inst.id, p); },
        } }, U.svg(e.isDir ? 'folder' : 'file'), h('span.n', e.name), h('span.s', e.isDir ? '' : U.size(e.size)));
      rows.push(row);
    }
    if (!entries.length) rows.push(h('p.faint', { style: { padding: '14px', margin: 0 } }, 'This folder is empty.'));
    listEl.replaceChildren(...rows);
  }
  // ---------- text editor ----------
  let editor = null; // { path, original, ta, dirtyEl }
  const isDirty = () => editor && editor.ta.value !== editor.original;
  async function confirmLeave() {
    if (!isDirty()) return true;
    return C.confirm('Discard changes?', `You have unsaved changes in ${editor.path.split('/').pop()}.`, { ok: 'Discard changes', danger: true });
  }
  async function save() {
    if (!editor) return;
    const name = editor.path.split('/').pop();
    if (/\.json$/i.test(name)) {
      try { JSON.parse(editor.ta.value); }
      catch (err) {
        const ok = await C.confirm('This is not valid JSON', `${err.message}. The game may reset this file if you save it like this.`, { ok: 'Save anyway', danger: true });
        if (!ok) return;
      }
    }
    try {
      await U.call('writeText', inst.id, editor.path, editor.ta.value);
      editor.original = editor.ta.value;
      updateDirty();
      C.toast(`Saved ${name}`);
    } catch (err) { C.toast(err.message, 'err'); }
  }
  function updateDirty() {
    if (!editor) return;
    const d = isDirty();
    editor.dirtyEl.textContent = d ? 'Unsaved changes' : 'Saved';
    editor.dirtyEl.classList.toggle('dirty', d);
    editor.saveBtn.disabled = !d;
    editor.revertBtn.disabled = !d;
    if (editor.status && /\.json$/i.test(editor.path)) {
      try { JSON.parse(editor.ta.value); editor.status.textContent = 'Valid JSON'; editor.status.className = 'ed-status ok'; }
      catch (err) { editor.status.textContent = err.message; editor.status.className = 'ed-status bad'; }
    }
  }
  const onKey = (ev) => { if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 's' && editor) { ev.preventDefault(); save(); } };
  document.addEventListener('keydown', onKey);

  async function showPreview(e, p) {
    editor = null;
    if (e.isDir) { preview.replaceChildren(h('p.muted', { style: { margin: 0 } }, `Folder ${e.name}. Double-click to open it.`)); return; }
    if (/\.(png|jpe?g|gif|webp)$/i.test(e.name)) { preview.replaceChildren(h('img', { src: `mcl://instances/${encodeURIComponent(inst.id)}/minecraft/${p.split('/').map(encodeURIComponent).join('/')}`, style: { maxWidth: '100%', imageRendering: 'pixelated' }, alt: e.name })); return; }
    if (!TEXT_EXT.test(e.name)) { preview.replaceChildren(h('p.muted', { style: { margin: 0 } }, `${e.name}, ${U.size(e.size)}. Double-click to open it with your default app.`)); return; }
    let text;
    try { text = await U.call('readText', inst.id, p); } catch (err) { preview.replaceChildren(h('p.muted', err.message)); return; }
    const readOnly = /\.log$/i.test(e.name) || /^(logs|crash-reports)\//.test(p);
    if (readOnly) { preview.replaceChildren(h('pre', text)); return; }
    const ta = h('textarea.editor', { spellcheck: false, autocomplete: 'off', 'aria-label': `Edit ${e.name}`, wrap: 'off' });
    ta.value = text;
    const dirtyEl = h('span.ed-dirty', 'Saved');
    const saveBtn = h('button.btn.small.primary', { disabled: true, title: 'Save (Ctrl+S)', on: { click: save } }, U.svg('check'), 'Save');
    const revertBtn = h('button.btn.small', { disabled: true, on: { click: () => { ta.value = editor.original; updateDirty(); } } }, 'Revert');
    const status = /\.json$/i.test(e.name) ? h('span.ed-status') : null;
    editor = { path: p, original: text, ta, dirtyEl, saveBtn, revertBtn, status };
    ta.addEventListener('input', updateDirty);
    ta.addEventListener('keydown', (ev) => {
      if (ev.key === 'Tab' && !ev.shiftKey) {
        ev.preventDefault();
        const { selectionStart: a, selectionEnd: b } = ta;
        ta.setRangeText('  ', a, b, 'end');
        updateDirty();
      }
    });
    const running = inst.session && ['running', 'starting'].includes(inst.session.state);
    preview.replaceChildren(h('div.ed',
      h('div.ed-bar', h('b', e.name), dirtyEl, h('div.spacer'), revertBtn, saveBtn),
      running ? h('div.ed-note', 'The game is running. Most mods read their config at startup, so changes apply next time you play.') : null,
      ta,
      status ? h('div.ed-foot', status) : null));
    updateDirty();
  }
  body.append(
    h('div.toolbar', crumbs, h('div.spacer'),
      h('button.btn', { on: { click: () => U.call('openFolder', inst.id, rel) } }, U.svg('folder'), 'Open in file manager'),
      h('button.btn.danger', { on: { click: async () => {
        if (!selected) return C.toast('Select a file or folder first', 'err');
        if (await C.confirm(`Move ${selected.split('/').pop()} to the trash?`, 'You can restore it from your trash.', { ok: 'Move to trash', danger: true })) { await U.call('trashPath', inst.id, selected); open(rel); }
      } } }, U.svg('trash'), 'Delete')),
    quick,
    h('div.files', listEl, preview));
  await open('');
  return () => document.removeEventListener('keydown', onKey);
}

// ---------- logs ----------
async function renderLogs(body, inst) {
  const { h } = U;
  const box = h('div.logbox', { role: 'log', tabindex: 0 });
  let follow = true, filter = '', lines = [], liveMode = true;
  box.addEventListener('scroll', () => { follow = box.scrollTop + box.clientHeight >= box.scrollHeight - 30; });
  const cls = (l) => /\b(ERROR|FATAL|Exception|Caused by)\b/.test(l) ? 'e' : /\bWARN\b/.test(l) ? 'w' : l.startsWith('[McLauncher]') || l.startsWith('# ') ? 'l' : '';
  const lineEl = (l) => { const d = document.createElement('div'); const c = cls(l); if (c) d.className = c; d.textContent = l; return d; };
  function redraw() {
    const shown = filter ? lines.filter(l => l.toLowerCase().includes(filter)) : lines;
    const frag = document.createDocumentFragment();
    for (const l of shown.slice(-6000)) frag.append(lineEl(l));
    box.replaceChildren(frag);
    if (!shown.length) box.append(h('div.l', liveMode ? 'Game output appears here when you press Play. Logs are kept after the game closes.' : 'This log is empty.'));
    if (follow) box.scrollTop = box.scrollHeight;
  }
  const banner = h('div');
  const sel = h('select.input', { style: { width: '260px' }, on: { change: () => pick(sel.value) } });
  async function drawBanner() {
    const cur = await U.call('sessionLog', inst.id);
    const s = cur && cur.info;
    banner.replaceChildren();
    if (!s || !liveMode) return;
    let fixBtn = null;
    if (s.state === 'exited' && s.code !== 0) {
      const all = cur.lines.join('\n');
      let tip = s.crashReport ? 'A crash report was written. The full log is below.' : 'Look for red lines in the log below.';
      if (/LinuxDisplay\.getAvailableDisplayModes|xrandr/i.test(all)) tip = 'Older Minecraft versions need the xrandr tool. Install it (on Arch: sudo pacman -S xorg-xrandr) and press Play again.';
      else if (/XCheckTypedWindowEvent|libX11\.so[^\n]*SIGSEGV|SIGSEGV[\s\S]{0,400}libX11/i.test(all)) {
        tip = 'The game crashed inside XWayland (libX11). Running it as a native Wayland window usually fixes this. It needs the glfw package (on Arch: sudo pacman -S glfw).';
        fixBtn = h('button.btn', { on: { click: async () => { await U.call('updateInstance', inst.id, { nativeWayland: true }); C.toast('Native Wayland turned on for this instance'); Pages.play(inst); } } }, 'Use native Wayland and play');
      }
      else if (/Incompatible mods found|Mod resolution failed|missing mandatory dependencies|Missing or unsupported mandatory dependencies/i.test(all)) tip = 'Some mods are incompatible or missing a dependency. The log below names them.';
      banner.append(h('div.banner.crash', h('div.grow', h('b', `Minecraft closed with an error (code ${s.code})`), h('div.muted', { style: { fontSize: '13px' } }, tip)),
        fixBtn,
        s.crashReport ? h('button.btn', { on: { click: async () => C.modal({ title: 'Crash report', wide: true, body: h('pre', { style: { whiteSpace: 'pre-wrap', fontSize: '12px', margin: 0 } }, await U.call('readText', inst.id, s.crashReport)), actions: [{ label: 'Close' }] }) } }, 'View crash report') : null,
        h('button.btn.primary', { on: { click: () => Pages.play(inst) } }, U.svg('play'), 'Play again')));
    } else if (s.state === 'exited') {
      banner.append(h('div.banner.ok', h('div.grow', h('b', 'Game closed'), h('div.muted', { style: { fontSize: '13px' } }, `Session lasted ${Math.max(1, Math.round((s.endedAt - s.startedAt) / 60000))} min. The log is saved.`)),
        h('button.btn.primary', { on: { click: () => Pages.play(inst) } }, U.svg('play'), 'Play again')));
    } else if (s.state === 'failed') {
      banner.append(h('div.banner.crash', h('div.grow', h('b', 'Minecraft could not start'), h('div.muted', { style: { fontSize: '13px' } }, cur.lines[cur.lines.length - 1] || ''))));
    }
  }
  async function pick(v) {
    if (v === 'live') {
      liveMode = true;
      const cur = await U.call('sessionLog', inst.id);
      lines = cur ? cur.lines.slice() : [];
    } else {
      liveMode = false;
      lines = (await U.call('readPastLog', inst.id, v)).split('\n');
    }
    follow = true; redraw(); drawBanner();
  }
  const past = await U.call('pastLogs', inst.id);
  sel.append(h('option', { value: 'live' }, 'Current session'), ...past.map(p => h('option', { value: p.file }, new Date(p.mtime).toLocaleString() + `  (${U.size(p.size)})`)));
  body.append(banner, h('div.toolbar',
    sel,
    h('div.search', U.svg('search'), h('input.input', { placeholder: 'Filter lines', on: { input: U.debounce(e => { filter = e.target.value.toLowerCase(); redraw(); }, 150) } })),
    h('div.spacer'),
    h('button.btn', { on: { click: () => { navigator.clipboard.writeText(lines.join('\n')); C.toast('Log copied'); } } }, U.svg('copy'), 'Copy'),
    h('button.btn', { on: { click: () => U.call('openFolder', inst.id, 'logs') } }, U.svg('folder'), 'Game logs folder')), box);
  // If there is no current session, show the newest saved log instead.
  const cur = await U.call('sessionLog', inst.id);
  if (!cur && past.length) { sel.value = past[0].file; await pick(past[0].file); } else await pick('live');
  const off1 = window.mcl.on('log', (m) => {
    if (m.instId !== inst.id || !liveMode) return;
    lines.push(...m.lines);
    if (lines.length > 40000) lines.splice(0, lines.length - 40000);
    if (filter) return redraw();
    const empty = box.querySelector('.l:only-child'); if (empty) empty.remove();
    const frag = document.createDocumentFragment();
    for (const l of m.lines) frag.append(lineEl(l));
    box.append(frag);
    while (box.childElementCount > 6000) box.firstChild.remove();
    if (follow) box.scrollTop = box.scrollHeight;
  });
  const off2 = window.mcl.on('session', (s) => { if (s && s.instId === inst.id) { if (s.state === 'preparing' && liveMode) { lines = []; redraw(); } drawBanner(); } });
  return () => { off1(); off2(); };
}

// ---------- instance settings ----------
async function renderInstSettings(body, inst, { refresh }) {
  const { h } = U;
  const st = { name: inst.name, mcVersion: inst.mcVersion, loader: inst.loader, loaderVersion: inst.loaderVersion || '', memory: inst.memory || 4096, jvmArgs: inst.jvmArgs || '', javaPath: inst.javaPath || '', width: inst.width || '', height: inst.height || '' };
  const wl = await U.call('waylandInfo');
  const wlSel = h('select.input', { on: { change: e => { st.nativeWayland = e.target.value === 'global' ? null : e.target.value === 'on'; } } },
    h('option', { value: 'global' }, 'Use the global setting'), h('option', { value: 'on' }, 'On: native Wayland window'), h('option', { value: 'off' }, 'Off: XWayland'));
  wlSel.value = inst.nativeWayland == null ? 'global' : inst.nativeWayland ? 'on' : 'off';
  st.nativeWayland = inst.nativeWayland ?? null;
  const waylandSection = wl.linux ? h('div.section', h('h2', 'Display'),
    h('p', wl.glfw ? 'Run Minecraft as a native Wayland window (uses your system GLFW). Try this if the game crashes or misbehaves on Hyprland.' : 'Native Wayland needs the system GLFW library. Install it with: sudo pacman -S glfw'),
    h('div.field', { style: { marginBottom: 0 } }, h('label', 'Native Wayland'), wlSel)) : null;
  const picker = C.loaderPicker({ loader: st.loader || 'vanilla', mc: st.mcVersion, loaderVersion: st.loaderVersion, allowSnapshots: true });
  const memOut = h('output', (st.memory / 1024).toFixed(1) + ' GB');

  // ---- Java ----
  st.javaMajor = inst.javaMajor || null;
  st.envVars = inst.envVars || '';
  const javaSel = h('select.input', { 'aria-label': 'Java version' }, h('option', { value: 'auto' }, 'Automatic'));
  const pathIn = h('input.input', { placeholder: '/usr/lib/jvm/java-21-openjdk/bin/java', value: st.javaPath, on: { input: e => { st.javaPath = e.target.value; javaStatus.textContent = ''; } } });
  const javaStatus = h('span.hint');
  const pathRow = h('div.field', { style: { marginTop: '10px', marginBottom: 0 } }, h('label', 'Java executable'),
    h('div.row', h('div.grow', pathIn),
      h('button.btn', { on: { click: async () => { const p = await U.call('pickJava'); if (p) { pathIn.value = st.javaPath = p; testJava(); } } } }, U.svg('folder'), 'Browse'),
      h('button.btn', { on: { click: () => testJava() } }, U.svg('check'), 'Test')),
    javaStatus);
  async function testJava() {
    if (!st.javaPath.trim()) return;
    javaStatus.textContent = 'Testing…';
    try { const v = await U.call('javaTest', st.javaPath.trim()); javaStatus.textContent = `Java ${v.version}${v.vendor ? ' from ' + v.vendor : ''}${v.arch ? ', ' + v.arch : ''}`; javaStatus.style.color = 'var(--accent)'; }
    catch (e) { javaStatus.textContent = e.message; javaStatus.style.color = 'var(--danger)'; }
  }
  const javaHint = h('p');
  function syncJava() {
    const v = javaSel.value;
    pathRow.style.display = v === 'custom' ? '' : 'none';
    if (v === 'auto') { st.javaMajor = null; st.javaPath = ''; }
    else if (v.startsWith('m:')) { st.javaMajor = Number(v.slice(2)); st.javaPath = ''; }
    else if (v.startsWith('p:')) { st.javaMajor = null; st.javaPath = v.slice(2); pathIn.value = st.javaPath; }
    else if (v === 'custom') { st.javaMajor = null; st.javaPath = pathIn.value; }
  }
  javaSel.addEventListener('change', syncJava);
  javaHint.textContent = inst.prism ? 'Automatic uses a Java version the pack supports.' : 'Automatic uses the Java version Mojang recommends for this Minecraft version and downloads it if needed.';
  U.call('javaOptions').then(o => {
    const opts = [h('option', { value: 'auto' }, 'Automatic (recommended)')];
    if (o.mojang.length) opts.push(h('optgroup', { label: 'Download from Mojang' }, o.mojang.map(m => h('option', { value: `m:${m.major}` }, `Java ${m.major}  (${m.version})`))));
    if (o.system.length) opts.push(h('optgroup', { label: 'Installed on this computer' }, o.system.map(j => h('option', { value: `p:${j.path}` }, `Java ${j.version}  ${j.vendor ? '· ' + j.vendor + ' ' : ''}— ${j.path}`))));
    opts.push(h('option', { value: 'custom' }, 'Custom path…'));
    javaSel.replaceChildren(...opts);
    if (st.javaPath) javaSel.value = o.system.some(j => j.path === st.javaPath) ? `p:${st.javaPath}` : 'custom';
    else if (st.javaMajor) javaSel.value = `m:${st.javaMajor}`;
    else javaSel.value = 'auto';
    if (!javaSel.value) javaSel.value = 'custom';
    syncJava();
  }).catch(() => { javaSel.append(h('option', { value: 'custom' }, 'Custom path…')); });
  pathRow.style.display = st.javaPath ? '' : 'none';
  const javaSection = h('div.section', h('h2', 'Java'), javaHint,
    h('div.field', { style: { marginBottom: 0 } }, h('label', 'Java version'), javaSel), pathRow,
    h('div.field', { style: { marginTop: '16px', marginBottom: 0 } }, h('label', 'Environment variables'),
      h('textarea.input.mono', { rows: 3, placeholder: 'KEY=value, one per line', spellcheck: false, value: st.envVars, on: { input: e => st.envVars = e.target.value } }),
      h('span.hint', 'Passed to the game only. On Linux, NVIDIA threaded optimizations are already turned off for Minecraft.')));

  // ---- version / components ----
  let versionSection;
  if (inst.prism) {
    const comps = await U.call('prismComponents', inst.id).catch(() => []);
    versionSection = h('div.section', h('h2', 'Game version'),
      h('p', 'This instance came from Prism Launcher or MultiMC and is built from the pack\'s own components. Update it by importing a newer version of the pack.'),
      h('div.list', comps.map(c => h('div.item', { style: { minHeight: '44px' } }, h('div.txt', h('b', c.name), h('small', c.uid)), h('span.badge', c.version || ''), c.custom ? h('span.badge', 'From the pack') : null))));
  } else {
    versionSection = h('div.section', h('h2', 'Game version'), h('p', 'Changing versions can break mods and worlds. Make a copy first if you are unsure.'), picker.el);
  }
  body.append(h('div.settings-wrap',
    h('div.section', h('h2', 'General'), h('p', 'Name and picture shown in your library.'),
      h('div.field', h('label', 'Name'), h('input.input', { value: st.name, on: { input: e => st.name = e.target.value } })),
      h('div.row', h('button.btn', { on: { click: async () => { const r = await U.call('pickIcon', inst.id); if (r) { refresh(); App.refreshInstances(); } } } }, U.svg('image'), 'Change picture'),
        inst.iconUrl ? h('button.btn.ghost', { on: { click: async () => { await U.call('clearIcon', inst.id); refresh(); App.refreshInstances(); } } }, 'Use generated picture') : null)),
    versionSection,
    javaSection,
    waylandSection,
    h('div.section', h('h2', 'Performance'), h('p', 'Memory given to Minecraft. Most modpacks run well with 4–8 GB.'),
      h('div.field', h('div.range-row', h('input', { type: 'range', min: 1024, max: 32768, step: 512, value: st.memory, on: { input: e => { st.memory = +e.target.value; memOut.textContent = (st.memory / 1024).toFixed(1) + ' GB'; } } }), memOut)),
      h('div.grid2',
        h('div.field', h('label', 'Window width'), h('input.input', { type: 'number', placeholder: 'Default', value: st.width, on: { input: e => st.width = e.target.value } })),
        h('div.field', h('label', 'Window height'), h('input.input', { type: 'number', placeholder: 'Default', value: st.height, on: { input: e => st.height = e.target.value } }))),
      h('div.field', { style: { marginBottom: 0 } }, h('label', 'Extra Java arguments'), h('input.input', { placeholder: '-XX:+UseZGC', value: st.jvmArgs, on: { input: e => st.jvmArgs = e.target.value } }))),
    h('div.row', h('div.spacer'), h('button.btn.primary', { on: { click: async () => {
      try {
        if (!inst.prism) picker.validate();
        if (javaSel.value === 'custom' && !st.javaPath.trim()) throw new Error('Enter the path to a Java executable, or pick another Java.');
        await U.call('updateInstance', inst.id, { name: st.name.trim() || inst.name, ...(inst.prism ? {} : picker.get()), nativeWayland: st.nativeWayland, memory: st.memory, jvmArgs: st.jvmArgs, javaPath: st.javaPath.trim(), javaMajor: st.javaMajor, envVars: st.envVars, width: +st.width || null, height: +st.height || null });
        C.toast('Settings saved'); refresh(); App.refreshInstances();
      } catch (e) { C.toast(e.message, 'err'); }
    } } }, 'Save changes'))));
}

const TAB_RENDER = {
  mods: (b, i) => renderContentTab(b, i, 'mods'),
  resourcepacks: (b, i) => renderContentTab(b, i, 'resourcepacks'),
  shaderpacks: (b, i) => renderContentTab(b, i, 'shaderpacks'),
  saves: renderWorlds,
  screenshots: renderShots,
  files: renderFiles,
  logs: renderLogs,
  settings: renderInstSettings,
};
