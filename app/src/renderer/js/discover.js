'use strict';
window.Pages = window.Pages || {};

const DISC = { source: 'modrinth', type: 'mod', query: '', env: 'all', gameVersion: null, sort: 'relevance', offset: 0, target: null, packLoader: 'all' };
const PACK_LOADERS = [['all', 'Any loader'], ['fabric', 'Fabric'], ['forge', 'Forge'], ['neoforge', 'NeoForge']];
const loaderOf = (t) => (t && ['fabric', 'forge', 'neoforge'].includes(t.loader) ? t.loader : 'fabric');
const TYPES = [['mod', 'Mods'], ['resourcepack', 'Resource packs'], ['shader', 'Shaders'], ['modpack', 'Modpacks']];
const TYPE_FOLDER = { mod: 'mods', resourcepack: 'resourcepacks', shader: 'shaderpacks' };
const ENVS = [['all', 'Everything'], ['client', 'Client-side'], ['server', 'Server-side'], ['both', 'Client & server'], ['library', 'Libraries']];
const SORTS = { modrinth: [['relevance', 'Relevance'], ['downloads', 'Downloads'], ['follows', 'Follows'], ['newest', 'Newest'], ['updated', 'Recently updated']],
  curseforge: [['relevance', 'Popularity'], ['downloads', 'Downloads'], ['newest', 'Newest'], ['updated', 'Recently updated']] };

Pages.discover = async (main, route) => {
  const { h } = U;
  if (route.id && TYPES.some(t => t[0] === route.id)) DISC.type = route.id;
  const instances = App.instances.length ? App.instances : await App.refreshInstances();
  if (route.tab && instances.some(i => i.id === route.tab)) { DISC.target = route.tab; DISC.gameVersion = null; }
  if (!DISC.target || !instances.some(i => i.id === DISC.target)) DISC.target = instances[0] ? instances[0].id : null;
  const target = () => instances.find(i => i.id === DISC.target) || null;
  if (DISC.gameVersion === null) DISC.gameVersion = DISC.type !== 'modpack' && target() ? target().mcVersion : '';
  DISC.offset = 0;

  let installed = new Map(); // projectId -> true
  async function loadInstalled() {
    installed = new Map();
    const t = target();
    if (!t || DISC.type === 'modpack') return;
    try {
      for (const it of await U.call('content', t.id, TYPE_FOLDER[DISC.type])) {
        if (it.projectId) installed.set(String(it.projectId), true);
        if (it.title) installed.set('t:' + it.title.toLowerCase(), true);
      }
    } catch {}
  }

  const srcSeg = h('div.segmented', ['modrinth', 'curseforge'].map(s => h('button' + (DISC.source === s ? '.on' : ''), { type: 'button', on: { click: () => { DISC.source = s; DISC.offset = 0; if (!SORTS[s].some(x => x[0] === DISC.sort)) DISC.sort = 'relevance'; build(); } } }, s === 'modrinth' ? 'Modrinth' : 'CurseForge')));
  const tabs = h('div.tabs');
  const filters = h('div.filters');
  const targetBar = h('div');
  const results = h('div.results');
  const pager = h('div.pager');
  const searchIn = h('input.input', { placeholder: 'Search', value: DISC.query, on: { input: U.debounce(e => { DISC.query = e.target.value; DISC.offset = 0; search(); }, 300) } });

  main.append(h('div.page',
    h('div.page-head', h('div', { style: { flex: 1 } }, h('h1', 'Discover'), h('p', 'Mods, resource packs, shaders and modpacks from Modrinth and CurseForge.')), srcSeg),
    tabs,
    h('div.disc', filters, h('div', h('div.toolbar', h('div.search', { style: { maxWidth: 'none' } }, U.svg('search'), searchIn), targetBar), results, pager))));

  async function build() {
    srcSeg.querySelectorAll('button').forEach((b, i) => b.classList.toggle('on', ['modrinth', 'curseforge'][i] === DISC.source));
    tabs.replaceChildren(...TYPES.map(([k, label]) => h('button' + (k === DISC.type ? '.on' : ''), { on: { click: () => {
      DISC.type = k; DISC.offset = 0; DISC.env = 'all';
      DISC.gameVersion = k === 'modpack' ? '' : (target() ? target().mcVersion : '');
      build();
    } } }, label)));
    // target instance
    if (DISC.type === 'modpack') targetBar.replaceChildren(h('span.muted', { style: { fontSize: '13px' } }, 'Installing a modpack creates a new instance.'));
    else if (!instances.length) targetBar.replaceChildren(h('button.btn', { on: { click: () => Pages.newInstanceFlow() } }, U.svg('plus'), 'Make an instance to install into'));
    else {
      const sel = h('select.input', { 'aria-label': 'Install into', on: { change: e => { DISC.target = e.target.value; DISC.gameVersion = target().mcVersion; DISC.offset = 0; build(); } } },
        instances.map(i => h('option', { value: i.id }, `${i.name}  (${U.loaderLabel(i)} ${i.mcVersion})`)));
      sel.value = DISC.target;
      targetBar.replaceChildren(h('div.target', h('span.muted', 'Install into'), sel));
    }
    // filters
    const f = [];
    if (DISC.type === 'mod') {
      f.push(h('h4', 'Runs on'), h('div.radio-list', ENVS.map(([k, label]) => {
        const disabled = DISC.source === 'curseforge' && (k === 'client' || k === 'server' || k === 'both');
        return disabled ? null : h('button' + (DISC.env === k ? '.on' : ''), { on: { click: () => { DISC.env = k; DISC.offset = 0; build(); } } }, h('i'), label);
      }), DISC.source === 'curseforge' ? h('p.note', 'CurseForge does not list where mods run. Switch to Modrinth to filter by client and server.') : null));
    }
    const verSel = h('select.input', { on: { change: e => { DISC.gameVersion = e.target.value; DISC.offset = 0; search(); } } }, h('option', { value: '' }, 'Any version'));
    if (DISC.gameVersion) verSel.append(h('option', { value: DISC.gameVersion }, DISC.gameVersion));
    verSel.value = DISC.gameVersion;
    U.call('mcVersions').then(v => {
      const keep = DISC.gameVersion;
      verSel.replaceChildren(h('option', { value: '' }, 'Any version'), ...v.filter(x => x.type === 'release' || x.id === keep).map(x => h('option', { value: x.id }, x.id)));
      verSel.value = keep;
    }).catch(() => {});
    const sortSel = h('select.input', { on: { change: e => { DISC.sort = e.target.value; DISC.offset = 0; search(); } } }, SORTS[DISC.source].map(([k, l]) => h('option', { value: k }, l)));
    sortSel.value = DISC.sort;
    f.push(h('h4', 'Minecraft version'), verSel);
    if (DISC.type !== 'modpack' && target() && DISC.gameVersion !== target().mcVersion) f.push(h('p.note.faint', { style: { fontSize: '12px', margin: '6px 2px' } }, `Your instance runs ${target().mcVersion}. Installs always pick a file made for ${target().mcVersion}.`));
    f.push(h('h4', 'Sort by'), sortSel);
    if (DISC.type === 'modpack') {
      f.push(h('h4', 'Mod loader'), h('div.radio-list', PACK_LOADERS.map(([k, label]) => h('button' + (DISC.packLoader === k ? '.on' : ''), { on: { click: () => { DISC.packLoader = k; DISC.offset = 0; build(); } } }, h('i'), label))));
    }
    if (DISC.type === 'mod') f.push(h('p.faint', { style: { fontSize: '12px', marginTop: '18px' } }, `Showing ${U.loaderLabel({ loader: loaderOf(target()) })} mods${target() && target().loader === 'neoforge' && DISC.gameVersion === '1.20.1' ? ' (and Forge mods, which run on NeoForge 1.20.1)' : ''}.`));
    filters.replaceChildren(...f);
    await loadInstalled();
    search();
  }

  let searchSeq = 0;
  async function search() {
    const seq = ++searchSeq;
    results.replaceChildren(...U.skeleton(5, 'result'));
    pager.replaceChildren();
    let res;
    try {
      res = await U.call('search', DISC.source, { query: DISC.query, type: DISC.type, gameVersion: DISC.gameVersion, env: DISC.env, offset: DISC.offset, sort: DISC.sort, limit: 20,
        loader: DISC.type === 'modpack' ? DISC.packLoader : loaderOf(target()) });
    } catch (e) {
      if (seq !== searchSeq) return;
      results.replaceChildren(h('div.empty', h('h3', 'Could not reach ' + (DISC.source === 'modrinth' ? 'Modrinth' : 'CurseForge')), h('p', e.message), h('button.btn', { on: { click: search } }, U.svg('refresh'), 'Try again')));
      return;
    }
    if (seq !== searchSeq) return;
    if (!res.hits.length) { results.replaceChildren(h('div.empty', h('h3', 'No results'), h('p', 'Try other words, another Minecraft version, or the other source.'))); return; }
    results.replaceChildren(...res.hits.map(renderHit));
    U.stagger(results);
    const page = Math.floor(DISC.offset / 20) + 1, pages = Math.max(1, Math.ceil(res.total / 20));
    pager.replaceChildren(
      h('button.btn.small', { disabled: page <= 1, on: { click: () => { DISC.offset -= 20; search(); document.getElementById('main').scrollTop = 0; } } }, 'Previous'),
      h('span', `Page ${page} of ${pages}`),
      h('button.btn.small', { disabled: page >= pages, on: { click: () => { DISC.offset += 20; search(); document.getElementById('main').scrollTop = 0; } } }, 'Next'));
  }

  function renderHit(p) {
    const isInstalled = installed.has(String(p.id)) || installed.has('t:' + p.title.toLowerCase());
    const btn = installButton(p, isInstalled);
    return h('div.result', { tabindex: 0, on: { click: () => openDrawer(p), keydown: (e) => { if (e.key === 'Enter' && e.target.classList.contains('result')) openDrawer(p); } } },
      p.icon ? h('img.ico', { src: p.icon, alt: '', loading: 'lazy' }) : h('div.ico'),
      h('div.body',
        h('h3', p.title, p.author ? h('small', `by ${p.author}`) : null),
        h('p', p.description),
        h('div.tags', DISC.type === 'mod' ? U.envBadge(p.env, p.isLibrary) : null,
          DISC.type === 'modpack' ? (p.loaders || []).map(l => h('span.badge', l)) : null,
          h('span.stats', `${U.num(p.downloads)} downloads`))),
      h('div.act', btn));
  }

  function installButton(p, isInstalled) {
    if (DISC.type === 'modpack') return h('button.btn.primary', { on: { click: (e) => { e.stopPropagation(); installPack(p, null, e.currentTarget); } } }, U.svg('download'), 'Install');
    if (isInstalled) return h('button.btn', { disabled: true }, U.svg('check'), 'Installed');
    return h('button.btn.primary', { disabled: !target(), on: { click: (e) => { e.stopPropagation(); install(p, null, e.currentTarget); } } }, U.svg('download'), 'Install');
  }

  async function install(p, version, btn) {
    const t = target();
    if (!t) return C.toast('Make an instance first', 'err');
    if (DISC.type === 'mod' && !['fabric', 'forge', 'neoforge'].includes(t.loader)) return C.toast(`${t.name} is a vanilla instance. Pick Fabric, Forge or NeoForge in its settings to add mods.`, 'err');
    if (btn) { btn.disabled = true; btn.replaceChildren(h('span.spinner'), 'Installing'); }
    try {
      const info = { title: p.title, icon: p.icon, slug: p.slug, env: p.env };
      const r = version ? await U.call('installVersion', DISC.source, t.id, version, DISC.type, info) : await U.call('install', DISC.source, t.id, p.id, DISC.type, info);
      if (r && r.blocked) { C.blocked(r.blocked, t.id); if (btn) { btn.disabled = false; btn.replaceChildren(U.svg('download'), 'Install'); } return; }
      installed.set(String(p.id), true);
      const extra = Array.isArray(r) && r.length > 1 ? ` with ${r.length - 1} required ${r.length - 1 === 1 ? 'dependency' : 'dependencies'}` : '';
      C.toast(`Installed ${p.title}${extra}`);
      if (btn) { btn.replaceChildren(U.svg('check'), 'Installed'); btn.classList.remove('primary'); btn.classList.add('done-pop'); }
    } catch (e) {
      C.toast(e.message, 'err');
      if (btn) { btn.disabled = false; btn.replaceChildren(U.svg('download'), 'Install'); }
    }
  }

  async function installPack(p, versionId, btn) {
    if (btn) { btn.disabled = true; btn.replaceChildren(h('span.spinner'), 'Installing'); }
    try {
      if (!versionId) {
        const vs = await U.call('versions', DISC.source, p.id, { type: 'modpack', gameVersion: DISC.gameVersion, loader: DISC.packLoader });
        const pick = vs.find(v => v.type === 'release') || vs[0];
        if (!pick) throw new Error(`${p.title} has no Fabric, Forge or NeoForge version${DISC.gameVersion ? ' for ' + DISC.gameVersion : ''}.`);
        versionId = pick.id;
      }
      const r = await U.call('installModpack', DISC.source, p.id, versionId, { title: p.title, icon: p.icon });
      if (r && r.instance) {
        await App.refreshInstances();
        C.toast(`${p.title} is ready to play`);
        App.go(`#instance/${r.instance.id}/mods`);
      }
      if (r && r.blocked && r.blocked.length) C.blocked(r.blocked, r.instance && r.instance.id);
    } catch (e) { C.toast(e.message, 'err'); }
    finally { if (btn && btn.isConnected) { btn.disabled = false; btn.replaceChildren(U.svg('download'), 'Install'); } }
  }

  async function openDrawer(p) {
    const scrim = h('div.scrim.drawer-scrim');
    const close = () => { U.leave(scrim, 'closing', 210); document.removeEventListener('keydown', onKey); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    scrim.addEventListener('mousedown', e => { if (e.target === scrim) close(); });
    const dbody = h('div.dbody', h('div.list', ...U.skeleton(4)));
    scrim.append(h('aside.drawer', { role: 'dialog', 'aria-label': p.title },
      h('div.dhead', p.icon ? h('img', { src: p.icon, alt: '' }) : h('div'), h('div.grow', { style: { flex: 1, minWidth: 0 } },
        h('h2', p.title), h('div.row', { style: { gap: '6px', marginTop: '6px', flexWrap: 'wrap' } }, DISC.type === 'mod' ? U.envBadge(p.env, p.isLibrary) : null, h('span.faint', { style: { fontSize: '13px' } }, `${U.num(p.downloads)} downloads`))),
        h('button.btn.icon.ghost', { 'aria-label': 'Close', on: { click: close } }, U.svg('x'))),
      dbody));
    document.getElementById('modal-root').append(scrim);
    try {
      const t = target();
      const gv = DISC.type === 'modpack' ? DISC.gameVersion : (t ? t.mcVersion : DISC.gameVersion);
      const [proj, vers] = await Promise.all([U.call('project', DISC.source, p.id), U.call('versions', DISC.source, p.id, { type: DISC.type, gameVersion: gv, loader: DISC.type === 'modpack' ? DISC.packLoader : loaderOf(t) })]);
      const gallery = (proj.gallery || []).slice(0, 8);
      const vlist = vers.slice(0, 12).map(v => h('div.v', h('div', h('b', v.name || v.number), h('small', `${v.type}   ${(v.gameVersions || []).filter(x => /^\d/.test(x)).slice(0, 4).join(', ')}   ${v.date ? new Date(v.date).toLocaleDateString() : ''}`)),
        h('button.btn.small', { on: { click: (e) => DISC.type === 'modpack' ? installPack(p, v.id, e.currentTarget) : install(p, v, e.currentTarget) } }, U.svg('download'), 'Install')));
      dbody.replaceChildren(...[
        h('div.row', { style: { marginBottom: '16px', gap: '8px' } },
          (DISC.type !== 'modpack' && (installed.has(String(p.id)) || installed.has('t:' + p.title.toLowerCase())))
            ? h('button.btn', { disabled: true }, U.svg('check'), 'Installed')
            : h('button.btn.primary', { on: { click: (e) => { const b = e.currentTarget; DISC.type === 'modpack' ? installPack(p, null, b) : install(p, null, b); } } }, U.svg('download'), DISC.type === 'modpack' ? 'Install newest' : 'Install'),
          h('button.btn', { on: { click: () => U.call('openExternal', proj.url) } }, U.svg('external'), DISC.source === 'modrinth' ? 'Open on Modrinth' : 'Open on CurseForge')),
        gallery.length ? h('div.gallery', gallery.map(g => h('img', { src: g, alt: '', loading: 'lazy' }))) : null,
        h('h4', { style: { margin: '6px 0 8px' } }, gv ? `Versions for ${gv}` : 'Versions'),
        vlist.length ? h('div.versions', vlist) : h('p.muted', `No ${DISC.type === 'mod' ? U.loaderLabel({ loader: loaderOf(t) }) + ' ' : ''}files for ${gv || 'this filter'}.`),
        h('div.md', { html: U.renderMd(proj.body || proj.bodyHtml || proj.description, !!proj.bodyHtml) })].filter(Boolean));
    } catch (e) { dbody.replaceChildren(h('div.empty', h('h3', 'Could not load details'), h('p', e.message))); }
  }

  build();
};
