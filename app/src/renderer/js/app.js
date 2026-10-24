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

async function render() {
  const main = document.getElementById('main');
  if (App.current && App.current.cleanup) { try { App.current.cleanup(); } catch {} }
  const route = parseRoute();
  App.renderSidebar();
  const page = window.Pages[route.page] || window.Pages.library;
  main.replaceChildren();
  main.scrollTop = 0;
  App.current = { cleanup: null };
  try {
    const cleanup = await page(main, route);
    App.current.cleanup = cleanup || null;
  } catch (e) {
    main.replaceChildren(U.h('div.page', U.h('div.empty', U.h('h3', 'This page could not load'), U.h('p', e.message), U.h('a.btn', { href: '#library' }, 'Back to library'))));
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
