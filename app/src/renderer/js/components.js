'use strict';
/* Modals, toasts and dialogs used across pages. */
const C = {};
const { h } = U;

C.modal = ({ title, subtitle, body, actions = [], wide = false, onClose }) => {
  const root = document.getElementById('modal-root');
  const scrim = h('div.scrim');
  const close = (v) => { scrim.remove(); document.removeEventListener('keydown', onKey); onClose && onClose(v); };
  const onKey = (e) => { if (e.key === 'Escape') close(null); };
  document.addEventListener('keydown', onKey);
  scrim.addEventListener('mousedown', (e) => { if (e.target === scrim) close(null); });
  const footer = h('footer', actions.map(a => h('button.btn' + (a.kind ? '.' + a.kind : ''), {
    on: { click: async (e) => { if (a.onClick) { const btn = e.currentTarget; btn.disabled = true; try { const r = await a.onClick(); if (r !== false) close(r); } catch (err) { C.toast(err.message, 'err'); } finally { btn.disabled = false; } } else close(a.value ?? null); } },
  }, a.label)));
  const modal = h('div.modal' + (wide ? '.wide' : ''), { role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('header', h('h2', title), subtitle && h('p', subtitle)),
    h('div.content', body),
    actions.length ? footer : null);
  scrim.append(modal);
  root.append(scrim);
  setTimeout(() => { const f = modal.querySelector('input, select, button.primary'); if (f) f.focus(); }, 30);
  return { close, el: modal };
};

C.confirm = (title, text, { ok = 'Confirm', danger = false } = {}) => new Promise(res => {
  C.modal({ title, body: h('p.muted', { style: { margin: 0 } }, text), onClose: (v) => res(!!v), actions: [
    { label: 'Cancel', value: false },
    { label: ok, kind: danger ? 'danger.solid' : 'primary', value: true },
  ] });
});

// ---------- toasts & background tasks ----------
const taskEls = new Map();
C.toast = (text, kind = 'ok', ms = 4200) => {
  const el = h('div.task' + (kind === 'err' ? '.err' : '.ok'), h('b', kind === 'err' ? 'Something went wrong' : text), kind === 'err' ? h('small', text) : null);
  document.getElementById('tasks').append(el);
  setTimeout(() => el.remove(), kind === 'err' ? 8000 : ms);
};
C.onTask = (t) => {
  let el = taskEls.get(t.id);
  if (!el) {
    el = h('div.task', h('b'), h('small'), h('div.bar', h('i')));
    taskEls.set(t.id, el);
    document.getElementById('tasks').append(el);
  }
  el.querySelector('b').textContent = t.title;
  el.querySelector('small').textContent = t.error || (t.done ? 'Done' : t.status);
  const bar = el.querySelector('.bar');
  bar.classList.toggle('indet', !t.done && t.progress == null);
  bar.querySelector('i').style.width = t.done ? '100%' : t.progress != null ? Math.round(t.progress * 100) + '%' : '';
  el.classList.toggle('err', !!t.error);
  el.classList.toggle('ok', t.done && !t.error);
  if (t.done) { bar.style.display = 'none'; setTimeout(() => { el.remove(); taskEls.delete(t.id); }, t.error ? 9000 : 2500); }
};

// ---------- CurseForge files that need a manual download ----------
C.blocked = (items, instId) => {
  C.modal({
    title: 'Download these from CurseForge',
    subtitle: 'Their authors only allow downloads from the CurseForge website. Download each file, then put it in the folder shown.',
    wide: true,
    body: h('div.list.blocked-list', items.map(it => h('div.item',
      h('div.txt', h('b', it.title), h('small', `${it.fileName} → ${it.folder}`)),
      h('button.btn.small', { on: { click: () => U.call('openExternal', it.url) } }, U.svg('external'), 'Open download page')))),
    actions: [
      instId ? { label: 'Open mods folder', onClick: () => { U.call('openFolder', instId, 'mods'); return false; } } : null,
      { label: 'Done', kind: 'primary' },
    ].filter(Boolean),
  });
};

// ---------- loader + version picker (new instance & instance settings) ----------
U.LOADERS = [['fabric', 'Fabric'], ['forge', 'Forge'], ['neoforge', 'NeoForge'], ['vanilla', 'Vanilla']];
const loaderGameCache = {};
C.loaderPicker = ({ loader = 'fabric', mc = '', loaderVersion = '', allowSnapshots = true } = {}) => {
  const state = { loader, mc, loaderVersion, snapshots: false };
  let mcList = [];
  const mcSel = h('select.input', { 'aria-label': 'Minecraft version', on: { change: (e) => { state.mc = e.target.value; loadLoaders(); } } }, h('option', 'Loading versions…'));
  const snapToggle = allowSnapshots ? h('label.check', h('input', { type: 'checkbox', on: { change: (e) => { state.snapshots = e.target.checked; fillMc(); } } }), 'Show snapshots') : null;
  const seg = h('div.segmented', U.LOADERS.map(([k, label]) => h('button', { type: 'button', on: { click: () => setLoader(k) } }, label)));
  const loaderSel = h('select.input', { 'aria-label': 'Loader version', on: { change: (e) => { state.loaderVersion = e.target.value; } } });
  const loaderLabel = h('label');
  const hint = h('span.hint');
  const loaderField = h('div.field', loaderLabel, loaderSel, hint);
  const mcHint = h('span.hint');

  async function supported(l) {
    if (l === 'vanilla') return null;
    if (!loaderGameCache[l]) loaderGameCache[l] = U.call('loaderGameVersions', l).then(v => new Set(v)).catch(() => null);
    return loaderGameCache[l];
  }
  async function setLoader(l) {
    state.loader = l;
    [...seg.children].forEach((b, i) => b.classList.toggle('on', U.LOADERS[i][0] === l));
    const name = U.LOADERS.find(x => x[0] === l)[1];
    loaderLabel.textContent = `${name} version`;
    hint.textContent = l === 'forge' ? 'The recommended Forge build is picked for you.' : `The newest stable ${name} build is picked for you.`;
    loaderField.style.display = l === 'vanilla' ? 'none' : '';
    await fillMc();
  }
  async function fillMc() {
    if (!mcList.length) return;
    const keep = state.mc;
    const sup = await supported(state.loader);
    const list = mcList.filter(v => (state.snapshots || v.type === 'release' || v.id === keep) && (!sup || sup.has(v.id)));
    mcSel.replaceChildren(...list.map(v => h('option', { value: v.id }, v.id + (v.type !== 'release' ? '  (snapshot)' : ''))));
    state.mc = list.some(v => v.id === keep) ? keep : (list[0] ? list[0].id : '');
    mcSel.value = state.mc;
    mcHint.textContent = sup ? `${list.length} versions with ${U.LOADERS.find(x => x[0] === state.loader)[1]}` : '';
    await loadLoaders(true);
  }
  let req = 0;
  async function loadLoaders(keepSelection) {
    if (state.loader === 'vanilla' || !state.mc) return;
    const mine = ++req;
    const wanted = keepSelection ? state.loaderVersion : '';
    loaderSel.replaceChildren(h('option', 'Loading…'));
    try {
      const list = await U.call('loaderVersions', state.loader, state.mc);
      if (mine !== req) return;
      if (!list.length) { loaderSel.replaceChildren(h('option', { value: '' }, 'Not available for this version')); state.loaderVersion = ''; return; }
      loaderSel.replaceChildren(...list.map(l => h('option', { value: l.version }, l.label + (l.recommended ? '  (recommended)' : !l.stable ? '  (beta)' : ''))));
      const pick = list.find(l => l.version === wanted) || list.find(l => l.recommended) || list.find(l => l.stable) || list[0];
      state.loaderVersion = pick.version;
      loaderSel.value = state.loaderVersion;
    } catch { loaderSel.replaceChildren(h('option', { value: '' }, 'Could not load versions')); state.loaderVersion = ''; }
  }
  U.call('mcVersions').then(v => { mcList = v; setLoader(state.loader); }).catch(e => { mcSel.replaceChildren(h('option', 'Could not load versions. Check your connection.')); C.toast(e.message, 'err'); });

  const el = h('div',
    h('div.field', h('label', 'Mod loader'), seg),
    h('div.grid2', h('div.field', h('label', 'Minecraft version'), mcSel, snapToggle || mcHint), loaderField));
  return {
    el,
    get: () => ({ loader: state.loader, mcVersion: state.mc, loaderVersion: state.loader === 'vanilla' ? null : state.loaderVersion }),
    validate() {
      if (!state.mc) throw new Error('Pick a Minecraft version.');
      const name = U.LOADERS.find(x => x[0] === state.loader)[1];
      if (state.loader !== 'vanilla' && !state.loaderVersion) throw new Error(`${name} is not available for Minecraft ${state.mc}. Pick another version or loader.`);
    },
  };
};

// ---------- new instance ----------
C.newInstance = async (preset = {}) => {
  const state = { name: preset.name || '', imagePath: null, memory: (await U.call('getSettings')).memory };
  const picBox = h('div.pv', { title: 'Choose a picture', on: { click: pickPic } });
  const setPreview = (url) => { picBox.replaceChildren(url ? h('img', { src: url, alt: '' }) : U.blockArt(state.name || 'new')); };
  setPreview(null);
  async function pickPic() {
    const p = await U.call('pickImagePath');
    if (!p) return;
    state.imagePath = p;
    setPreview(await U.call('imageDataUrl', p));
  }
  const nameIn = h('input.input', { placeholder: 'My survival world', value: state.name, on: { input: (e) => { state.name = e.target.value; if (!state.imagePath) setPreview(null); } } });
  const picker = C.loaderPicker({ loader: preset.loader || 'fabric', mc: preset.mcVersion || '' });
  const memOut = h('output', (state.memory / 1024).toFixed(1) + ' GB');
  const memIn = h('input', { type: 'range', min: 1024, max: 16384, step: 512, value: state.memory, on: { input: (e) => { state.memory = +e.target.value; memOut.textContent = (state.memory / 1024).toFixed(1) + ' GB'; } } });

  const body = h('div',
    h('div.pic-pick', picBox, h('div.grow',
      h('div.field', { style: { marginBottom: '8px' } }, h('label', 'Name'), nameIn),
      h('div.row', h('button.btn.small', { type: 'button', on: { click: pickPic } }, U.svg('image'), 'Choose picture'), h('span.faint', { style: { fontSize: '12px' } }, 'PNG, JPG, WebP or GIF')))),
    picker.el,
    h('div.field', h('label', 'Memory'), h('div.range-row', memIn, memOut)));

  return new Promise(res => C.modal({
    title: 'New instance', body, onClose: res,
    actions: [
      { label: 'Cancel' },
      { label: 'Create instance', kind: 'primary', onClick: async () => {
        picker.validate();
        const v = picker.get();
        const inst = await U.call('createInstance', { name: state.name.trim() || `Minecraft ${v.mcVersion}`, ...v, memory: state.memory });
        if (state.imagePath) await U.call('setIconFromPath', inst.id, state.imagePath);
        return inst;
      } },
    ],
  }));
};

// ---------- export ----------
C.exportDialog = async (inst) => {
  const cands = await U.call('exportCandidates', inst.id);
  const state = { format: 'mrpack', name: inst.name, version: '1.0.0' };
  const seg = h('div.segmented',
    h('button.on', { type: 'button', on: { click: () => setFmt('mrpack') } }, 'Modrinth (.mrpack)'),
    h('button', { type: 'button', on: { click: () => setFmt('zip') } }, 'Full backup (.zip)'));
  const fmtHint = h('p.hint.faint', { style: { margin: '8px 0 0', fontSize: '12.5px' } });
  function setFmt(f) {
    state.format = f;
    seg.children[0].classList.toggle('on', f === 'mrpack');
    seg.children[1].classList.toggle('on', f === 'zip');
    fmtHint.textContent = f === 'mrpack'
      ? 'Mods found on Modrinth are linked, everything else is bundled. Opens in McLauncher, Prism, Modrinth App and others.'
      : 'Everything you tick is copied into the archive, including the picture. Import it again in McLauncher.';
    metaFields.style.display = f === 'mrpack' ? '' : 'none';
  }
  const checks = cands.map(c => {
    const box = h('input', { type: 'checkbox', checked: c.checked });
    return { c, box, el: h('label.check', box, h('span', c.name), c.isDir ? h('small', `${c.count} item${c.count === 1 ? '' : 's'}`) : null) };
  });
  const metaFields = h('div.grid2',
    h('div.field', h('label', 'Pack name'), h('input.input', { value: state.name, on: { input: e => state.name = e.target.value } })),
    h('div.field', h('label', 'Version'), h('input.input', { value: state.version, on: { input: e => state.version = e.target.value } })));
  setFmt('mrpack');
  C.modal({
    title: `Export ${inst.name}`, wide: true,
    body: h('div',
      h('div.field', h('label', 'Format'), seg, fmtHint),
      metaFields,
      h('div.field', h('label', 'Include'), cands.length ? h('div.checks', checks.map(x => x.el)) : h('p.muted', 'This instance has no files yet.'))),
    actions: [
      { label: 'Cancel' },
      { label: 'Export', kind: 'primary', onClick: async () => {
        const include = checks.filter(x => x.box.checked).map(x => x.c.name);
        const r = await U.call('exportPack', inst.id, { format: state.format, include, name: state.name, version: state.version });
        if (!r) return false;
        C.toast(r.linked != null ? `Exported — ${r.linked} files linked to Modrinth, ${r.bundled} bundled` : 'Exported');
        U.call('showFile', r.file);
      } },
    ],
  });
};

// ---------- accounts ----------
C.accountMenu = async () => {
  const acc = await U.call('accounts');
  const rows = acc.list.map(a => h('div.acc-row', U.skinHead(a.skin, a.name), h('div.grow', h('b', a.name), a.id === acc.active ? h('small.muted', { style: { display: 'block' } }, 'Playing as this account') : null),
    a.id !== acc.active ? h('button.btn.small', { on: { click: async () => { await U.call('setActiveAccount', a.id); m.close(); App.refreshAccount(); } } }, 'Use') : null,
    h('button.btn.small.ghost', { on: { click: async () => { await U.call('removeAccount', a.id); m.close(); App.refreshAccount(); } } }, 'Sign out')));
  const m = C.modal({
    title: 'Accounts',
    body: acc.list.length ? h('div', rows) : h('p.muted', { style: { margin: 0 } }, 'Sign in with the Microsoft account that owns Minecraft: Java Edition.'),
    actions: [{ label: 'Close' }, { label: acc.list.length ? 'Add account' : 'Sign in with Microsoft', kind: 'primary', onClick: () => C.signIn() }],
  });
};
C.signIn = async () => {
  try {
    const r = await U.call('addAccount');
    App.refreshAccount();
    const a = r.list.find(x => x.id === r.active);
    C.toast(`Signed in as ${a ? a.name : 'player'}`);
  } catch (e) { C.toast(e.message, 'err'); }
};

window.C = C;
