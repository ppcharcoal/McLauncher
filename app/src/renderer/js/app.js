'use strict';
/* Router, sidebar and global events. */
const App = {
  instances: [],
  current: null,      // { page, cleanup }
  async refreshInstances() {
    try { this.instances = await U.call('instances'); } catch (e) { this.instances = []; }
    this.renderSidebar();
    return this.instances;
  },
  renderSidebar() {
    const box = document.getElementById('side-instances');
    const route = parseRoute();
    box.replaceChildren(...this.instances.map(i => U.h('a.side-inst' + (route.page === 'instance' && route.id === i.id ? '.active' : ''), { href: `#instance/${i.id}` },
      U.instPic(i), U.h('span', i.name),
      i.session && ['running', 'starting', 'preparing'].includes(i.session.state) ? U.h('i.run-dot', { title: 'Running' }) : null)));
    if (!this.instances.length) box.append(U.h('p.faint', { style: { padding: '4px 10px', fontSize: '12.5px', margin: 0 } }, 'Your instances show up here.'));
    document.querySelectorAll('[data-nav]').forEach(a => a.classList.toggle('active', a.dataset.nav === route.page));
  },
  async refreshAccount() {
    const chip = document.getElementById('account-chip');
    const acc = await U.call('accounts');
    const a = acc.list.find(x => x.id === acc.active);
    chip.replaceChildren(a ? U.skinHead(a.skin, a.name) : U.h('span', { style: { width: '28px', height: '28px', display: 'grid', placeItems: 'center', borderRadius: '5px', background: 'var(--raised)', color: 'var(--muted)', flex: 'none' } }, U.svg('user')),
      U.h('span.who', U.h('b', a ? a.name : 'Sign in'), U.h('small', a ? 'Microsoft account' : 'to play online')));
    this.account = a || null;
  },
  go(hash) { if (location.hash === hash) render(); else location.hash = hash; },
};
window.App = App;

function parseRoute() {
  const [page = 'library', id, tab] = location.hash.replace(/^#/, '').split('/').map(decodeURIComponent);
  return { page, id, tab };
}

let renderSeq = 0;
async function render() {
  const main = document.getElementById('main');
  const seq = ++renderSeq;
  if (App.current && App.current.cleanup) { try { App.current.cleanup(); } catch {} }
  App.current = { cleanup: null };
  const route = parseRoute();
  const prev = App.prevRoute;
  App.prevRoute = route;
  // Switching tabs inside the same instance only animates the tab body.
  App.sameInstance = !!(prev && prev.page === 'instance' && route.page === 'instance' && prev.id === route.id);
  App.renderSidebar();
  const page = window.Pages[route.page] || window.Pages.library;
  const motion = U.motion();
  const stage = U.h('div.page-stage');
  if (App.sameInstance) {
    const order = ['mods', 'resourcepacks', 'shaderpacks', 'saves', 'screenshots', 'files', 'logs', 'settings'];
    stage.style.setProperty('--tab-dir', (order.indexOf(route.tab || 'mods') >= order.indexOf(prev.tab || 'mods') ? 14 : -14) + 'px');
  }
  // Fade the old page out while the new one starts loading.
  const leaving = motion && main.firstChild && !App.sameInstance ? (main.classList.add('page-leave'), U.wait(110)) : null;
  let cleanupP;
  try {
    cleanupP = Promise.resolve(page(stage, route));
    // Show the new page as soon as it has content, or after a short moment at most.
    await Promise.race([cleanupP.catch(() => {}), U.wait(motion ? 240 : 0)]);
  } catch {}
  if (leaving) await leaving;
  if (seq !== renderSeq) { cleanupP && cleanupP.then(c => c && c()).catch(() => {}); return; }
  const keepScroll = App.sameInstance ? main.scrollTop : 0;
  main.classList.remove('page-leave');
  main.replaceChildren(stage);
  main.scrollTop = Math.min(keepScroll, 280);
  stage.classList.add(App.sameInstance ? 'stage-tab' : 'page-enter');
  try {
    const cleanup = await cleanupP;
    if (seq === renderSeq) App.current.cleanup = cleanup || null; else if (cleanup) cleanup();
  } catch (e) {
    if (seq === renderSeq) stage.replaceChildren(U.h('div.page', U.h('div.empty', U.h('h3', 'This page could not load'), U.h('p', e.message), U.h('a.btn', { href: '#library' }, 'Back to library'))));
  }
}

// window buttons
document.querySelectorAll('[data-win]').forEach(b => b.addEventListener('click', () => {
  U.call({ min: 'winMinimize', max: 'winMaximize', close: 'winClose' }[b.dataset.win]);
}));
document.getElementById('account-chip').addEventListener('click', () => C.accountMenu());

// events from the main process
window.mcl.on('task', t => C.onTask(t));
window.mcl.on('navigate', r => App.go(routeHash(r)));
window.mcl.on('session', () => App.refreshInstances());
window.Pages = window.Pages || {};

function routeHash(r) { return r.page === 'instance' ? `#instance/${r.id}/${r.tab || 'mods'}` : `#${r.page}`; }

// Drop a modpack anywhere outside a content list to import it.
document.addEventListener('dragover', e => e.preventDefault());
document.addEventListener('drop', async e => {
  e.preventDefault();
  if (e.defaultPrevented && e.__handled) return;
  const f = e.dataTransfer.files[0];
  if (!f || e.__handled) return;
  const p = window.mcl.pathForFile(f);
  if (!/\.(mrpack|zip)$/i.test(p) && !(f.type === '' && !/\.[a-z0-9]{1,5}$/i.test(p))) return; // archives, or a dropped folder
  try {
    await C.finishImport(await U.call('importPack', p));
  } catch (err) { C.toast(err.message, 'err'); }
});

window.addEventListener('hashchange', render);
(async () => {
  await Promise.all([App.refreshInstances(), App.refreshAccount()]);
  const start = await U.call('startupRoute');
  if (start) history.replaceState(null, '', routeHash(start));
  render();
})();
