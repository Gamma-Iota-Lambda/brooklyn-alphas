// GIL content calendar: the page behind calendar.html.
// Renders the month board, agenda, requests, and guide, plus the drawers for posts, requests,
// sign-in, and managing access. With Supabase settings in config.js it runs live (api-live.js);
// without them it runs the demo (api-demo.js), which keeps everything in this browser.
import {
  LEAD_DAYS, CONTACT, CATS, PROGRAMS, FORMATS, PLATFORMS, STATUSES, REQ_STATUS, COMMITTEES, MILESTONES,
  CAT, PROG, FMT, PLAT, STAT, CAT_ORDER
} from './data.js';
import { LiveApi } from './api-live.js';
import { DemoApi } from './api-demo.js';

const config = window.GIL_CALENDAR_CONFIG || {};
const api = config.supabaseUrl && config.supabaseKey ? new LiveApi(config) : new DemoApi();
const DEMO = api.mode === 'demo';

const ICON = {
  prev: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square"/></svg>',
  next: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M9 5l7 7-7 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square"/></svg>',
  close: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
  plus: '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-width="2.4"/></svg>',
  down: '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M12 4v11m0 0l-4.5-4.5M12 15l4.5-4.5M5 19.5h14" fill="none" stroke="currentColor" stroke-width="2.2"/></svg>'
};

// ---------------------------------------------------------------- helpers
const $ = (s, root = document) => root.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || '')); return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null; };
const addDays = (d, n) => { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() + n); return x; };
const todayISO = () => iso(new Date());
const daysBetween = (a, b) => { const x = parse(a), y = parse(b); return x && y ? Math.round((y - x) / 86400000) : NaN; };
const fmt = (s, o) => { const d = parse(s); return d ? d.toLocaleDateString('en-US', o) : ''; };
const longDate = (s) => fmt(s, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
const shortDate = (s) => fmt(s, { weekday: 'short', month: 'short', day: 'numeric' });
const localDateOf = (ts) => { const d = new Date(ts); return ts && !isNaN(d) ? iso(d) : ''; };
const safeUrl = (u) => { try { const x = new URL(String(u || '').trim()); return (x.protocol === 'https:' || x.protocol === 'http:') ? x.href : ''; } catch { return ''; } };
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const store = {
  get(k, d) { try { const v = localStorage.getItem('gilcal:' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('gilcal:' + k, JSON.stringify(v)); } catch { /* private window */ } },
  del(k) { try { localStorage.removeItem('gilcal:' + k); } catch { /* private window */ } }
};

// ---------------------------------------------------------------- state
const now = new Date();
const narrow = () => window.matchMedia('(max-width: 760px)').matches;
const VIEWS = ['calendar', 'agenda', 'requests', 'guide'];
const hashView = (location.hash || '').replace('#', '');
const storedView = store.get('view', '');
const storedCats = [].concat(store.get('cats', []) || []).filter((k) => CAT[k]);
const S = {
  role: 'loading', // loading | visitor | member | staff
  me: null, account: null, bootError: '',
  settings: { public: false, ready: true },
  posts: [], postsById: new Map(), requests: [], reqById: new Map(),
  loaded: { posts: false, requests: false }, loadError: '',
  view: VIEWS.includes(hashView) ? hashView : (VIEWS.includes(storedView) ? storedView : (narrow() ? 'agenda' : 'calendar')),
  ym: { y: now.getFullYear(), m: now.getMonth() },
  sel: todayISO(),
  f: { cats: new Set(storedCats.length ? storedCats : CATS.map((c) => c.key)), program: '', status: '', q: '', past: false },
  reqTab: 'new',
  drawer: null, lastTrigger: null,
  signin: { mode: store.get('last-name', '') ? 'rejoin' : 'join', note: '', done: '' },
  access: { members: null, staff: null, error: '', pending: null },
  refreshing: false
};
const isStaff = () => S.role === 'staff';
const isMember = () => S.role === 'member';
const signedIn = () => isStaff() || isMember();
const canSeePosts = () => signedIn() || !!S.settings.public;

// ---------------------------------------------------------------- data shaping
function normPost(d) {
  d = d || {};
  return {
    id: String(d.id || ''), date: parse(d.date) ? d.date : '', title: d.title || 'Untitled post',
    category: CAT[d.category] ? d.category : 'chapter', program: PROG[d.program] ? d.program : '',
    format: FMT[d.format] ? d.format : 'graphic',
    platforms: Array.isArray(d.platforms) ? d.platforms.filter((k) => PLAT[k]) : [],
    status: STAT[d.status] ? d.status : 'planned', committee: d.committee || '',
    concept: d.concept || '', notes: d.notes || '', eventDate: parse(d.eventDate) ? d.eventDate : '',
    link: d.link || '', assetLink: d.assetLink || '', caption: d.caption || '', source: d.source || '',
    requestId: d.requestId || '', createdAt: d.createdAt || '', updatedAt: d.updatedAt || ''
  };
}
function normReq(d) {
  d = d || {};
  return {
    id: String(d.id || ''), title: d.title || 'Untitled request', contactName: d.contactName || '', committee: d.committee || '',
    postDate: parse(d.postDate) ? d.postDate : '', eventDate: parse(d.eventDate) ? d.eventDate : '',
    about: d.about || '', format: FMT[d.format] ? d.format : 'graphic',
    platforms: Array.isArray(d.platforms) ? d.platforms.filter((k) => PLAT[k]) : [],
    program: PROG[d.program] ? d.program : '', assetLink: d.assetLink || '', caption: d.caption || '', link: d.link || '',
    youth: !!d.youth, releases: !!d.releases,
    status: REQ_STATUS[d.status] ? d.status : 'new', reviewNote: d.reviewNote || '', postId: d.postId || '',
    memberId: d.memberId || '', createdAt: d.createdAt || '', updatedAt: d.updatedAt || ''
  };
}
const cmpPost = (a, b) => a.date.localeCompare(b.date) || (CAT_ORDER[a.category] - CAT_ORDER[b.category]) || a.title.localeCompare(b.title);
const isMine = (r) => isMember() && !!S.me && !!r.memberId && r.memberId === S.me.member_id;

function setPosts(rows, loaded = true) {
  S.posts = rows.map(normPost).filter((p) => p.id && p.date).sort(cmpPost);
  S.postsById = new Map(S.posts.map((p) => [p.id, p]));
  S.loaded.posts = loaded;
}
function setRequests(rows, loaded = true) {
  S.requests = rows.map(normReq).filter((r) => r.id);
  S.reqById = new Map(S.requests.map((r) => [r.id, r]));
  S.loaded.requests = loaded;
}
function upsertPost(row) {
  const p = normPost(row);
  setPosts([...S.posts.filter((x) => x.id !== p.id), p]);
  return p;
}
function upsertRequest(row) {
  const r = normReq(row);
  setRequests([...S.requests.filter((x) => x.id !== r.id), r]);
  return r;
}

function visiblePosts() {
  const q = S.f.q.trim().toLowerCase();
  return S.posts.filter((p) =>
    S.f.cats.has(p.category) &&
    (!S.f.program || p.program === S.f.program) &&
    (!S.f.status || p.status === S.f.status) &&
    (!q || `${p.title} ${p.concept} ${p.notes} ${p.committee} ${p.caption}`.toLowerCase().includes(q)));
}
const filtersActive = () => S.f.cats.size !== CATS.length || S.f.program || S.f.status || S.f.q.trim();

// ---------------------------------------------------------------- small renderers
const catTag = (p) => `<span class="tag k-${p.category}"><i class="dot"></i>${esc(CAT[p.category].label)}</span>`;
const progTag = (key) => key && PROG[key] ? `<span class="prog">${esc(PROG[key].short)}</span>` : '';
const pill = (key) => `<span class="pill s-${esc(key)}">${esc((STAT[key] || {}).label || key)}</span>`;
const reqPill = (key) => `<span class="pill s-${esc(key)}">${esc((REQ_STATUS[key] || {}).label || key)}</span>`;
const platList = (keys) => keys.filter((k) => PLAT[k]).map((k) => PLAT[k].label).join(', ');

function leadNote(fromISO, postISO) {
  const n = daysBetween(fromISO, postISO);
  if (isNaN(n)) return '';
  if (n < 0) return '<span class="lead short">Date has passed</span>';
  return n < LEAD_DAYS ? `<span class="lead short">Short notice: ${plural(n, 'day')}</span>` : `<span class="lead">${plural(n, 'day')}' notice</span>`;
}

function countdownHTML() {
  const t = todayISO();
  for (const m of MILESTONES) {
    const n = daysBetween(t, m.date);
    if (n > 0) return `<span class="countdown"><b>${plural(n, 'day')}</b> to ${esc(m.label)}, ${esc(m.detail)}</span>`;
    if (n === 0) return `<span class="countdown"><b>Today</b> ${esc(m.label)}, ${esc(m.detail)}</span>`;
  }
  return '';
}

function rowHTML(p) {
  const d = parse(p.date), today = p.date === todayISO();
  return `<button class="row${today ? ' today' : ''}" data-act="post" data-id="${esc(p.id)}">
    <span class="when"><span class="wd">${esc(d.toLocaleDateString('en-US', { weekday: 'short' }))}</span><span class="dn">${d.getDate()}</span></span>
    <span class="what"><span class="ttl">${esc(p.title)}</span>${p.concept ? `<span class="cpt">${esc(p.concept)}</span>` : ''}
      <span class="meta">${catTag(p)}${progTag(p.program)}<span>${esc(FMT[p.format].label)}</span>${p.committee ? `<span>${esc(p.committee)}</span>` : ''}</span></span>
    ${pill(p.status)}
  </button>`;
}

function emptyHTML(eyebrow, title, body, extra = '') {
  return `<div class="empty"><p class="eyebrow">${esc(eyebrow)}</p><h2>${esc(title)}</h2><p>${body}</p>${extra}</div>`;
}
const signInButtons = () => `<div class="btns"><button class="btn primary" data-act="signin">Sign in</button><button class="btn" data-act="view" data-view="guide">How it works</button></div>`;

// ---------------------------------------------------------------- shell
const el = {
  demo: $('#gc-demo'), actions: $('#gc-actions'), countdown: $('#gc-countdown'), tabs: $('#gc-tabs'), badge: $('#gc-req-badge'),
  q: $('#gc-q'), search: $('#gc-search'), filters: $('#gc-filters'), cats: $('#gc-cats'), fProgram: $('#gc-f-program'),
  fStatus: $('#gc-f-status'), layout: $('#gc-layout'), view: $('#gc-view'), rail: $('#gc-rail'),
  drawer: $('#gc-drawer'), scrim: $('#gc-scrim'), toast: $('#gc-toast')
};

function buildFilters() {
  el.fProgram.innerHTML = '<option value="">All programs</option>' + PROGRAMS.map((p) => `<option value="${p.key}">${esc(p.short)}</option>`).join('');
  el.fStatus.innerHTML = '<option value="">Any status</option>' + STATUSES.map((s) => `<option value="${s.key}">${esc(s.label)}</option>`).join('');
}

function renderDemoBar() {
  if (!DEMO) { el.demo.hidden = true; return; }
  el.demo.hidden = false;
  const roles = [['staff', 'Media team'], ['member', 'Brother'], ['visitor', 'Visitor']];
  el.demo.innerHTML = `<div class="wrap demo-row">
    <p><b>Demo</b>Sample data. Your changes stay in this browser.</p>
    <div class="demo-ctl" role="group" aria-label="View the demo as"><span>View as</span>
      ${roles.map(([k, l]) => `<button class="seg" data-act="demo-role" data-role="${k}" aria-pressed="${api.role === k}">${l}</button>`).join('')}
      <button class="btn small quiet" data-act="demo-reset">Reset demo</button>
    </div></div>`;
}

function renderShell() {
  el.countdown.innerHTML = countdownHTML();
  renderDemoBar();
  let a = '';
  if (isStaff()) {
    a = `<button class="btn primary" data-act="add-post">${ICON.plus}Add post</button><button class="btn" data-act="access">Manage access</button>`;
  } else if (isMember()) {
    a = `<button class="btn primary" data-act="request-new">${ICON.plus}Request a post</button>`;
  } else if (S.role === 'visitor' && S.account && !S.account.anonymous) {
    // Signed in with an email login that hasn't joined the media team yet.
    a = `<button class="btn primary" data-act="signin" data-mode="staff">Finish media team sign-in</button>
      <span class="who">Signed in as <b>${esc(S.account.email)}</b><button class="btn link small" data-act="signout">Sign out</button></span>`;
  } else if (S.role === 'visitor') {
    a = '<button class="btn primary" data-act="signin">Sign in</button>';
    if (S.settings.public) a += '<button class="btn" data-act="view" data-view="guide">How to request a post</button>';
  }
  if (signedIn()) a += `<span class="who">Signed in as <b>${esc(S.me.name)}</b><button class="btn link small" data-act="signout">Sign out</button></span>`;
  el.actions.innerHTML = a;

  for (const b of el.tabs.querySelectorAll('.tab')) b.setAttribute('aria-selected', String(b.dataset.view === S.view));
  let badge = 0;
  if (isStaff()) badge = S.requests.filter((r) => r.status === 'new').length;
  else if (isMember()) badge = S.requests.filter((r) => isMine(r) && r.status === 'needs-info').length;
  el.badge.hidden = !badge;
  el.badge.textContent = badge || '';
  el.badge.setAttribute('aria-label', badge ? (isStaff() ? `${badge} new` : `${badge} need your answer`) : '');

  const showFilters = (S.view === 'calendar' || S.view === 'agenda') && canSeePosts() && S.role !== 'loading' && !S.bootError;
  el.filters.hidden = !showFilters;
  el.search.hidden = !showFilters;
  el.layout.classList.toggle('solo', !showFilters);
  const counts = {};
  for (const p of S.posts) counts[p.category] = (counts[p.category] || 0) + 1;
  el.cats.innerHTML = CATS.map((c) => `<button class="cat-toggle k-${c.key}" data-act="cat" data-cat="${c.key}" aria-pressed="${S.f.cats.has(c.key)}"><i class="dot"></i>${esc(c.label)}${S.loaded.posts ? ` <span class="n">${counts[c.key] || 0}</span>` : ''}</button>`).join('');
  el.fProgram.value = S.f.program;
  el.fStatus.value = S.f.status;
}

function render() { renderShell(); renderMain(); renderRail(); }

function renderMain() {
  if (S.bootError) {
    el.view.innerHTML = emptyHTML('Connection', "The calendar couldn't connect", `${esc(S.bootError)} Reload to try again. If it keeps happening, tell ${esc(CONTACT)}.`, '<div class="btns"><button class="btn" data-act="reload">Reload</button></div>');
    return;
  }
  if (S.role === 'loading') {
    el.view.innerHTML = emptyHTML('Loading', 'Opening the 2026-2027 calendar', "Holidays, Divine Nine Founders' Days, national program posts, and chapter events load here in a moment.");
    return;
  }
  if (S.view === 'guide') return renderGuide();
  if (S.view === 'requests') return renderRequests();
  if (!canSeePosts()) {
    el.view.innerHTML = emptyHTML('Brothers only', 'Sign in to see the calendar', `Brothers sign in with the chapter code the first time, then with their name and PIN. Ask ${esc(CONTACT)} for the code.`, signInButtons());
    return;
  }
  if (S.loadError) {
    el.view.innerHTML = emptyHTML('Connection', 'The calendar could not load', `${esc(S.loadError)} Reload the page to try again.`, '<div class="btns"><button class="btn" data-act="reload">Reload</button></div>');
    return;
  }
  if (!S.loaded.posts) {
    el.view.innerHTML = emptyHTML('Loading', 'Opening the 2026-2027 calendar', 'Posts load here in a moment.');
    return;
  }
  if (S.view === 'agenda') return renderAgenda();
  renderCalendar();
}

// ---------------------------------------------------------------- calendar
function renderCalendar() {
  const { y, m } = S.ym;
  const first = new Date(y, m, 1), last = new Date(y, m + 1, 0);
  const start = addDays(first, -first.getDay()), end = addDays(last, 6 - last.getDay());
  const vis = visiblePosts();
  const byDate = new Map();
  for (const p of vis) { if (!byDate.has(p.date)) byDate.set(p.date, []); byDate.get(p.date).push(p); }
  const today = todayISO();
  const total = Math.round((end - start) / 86400000) + 1;
  let cells = '', i = 0;
  for (let d = new Date(start); d <= end; d = addDays(d, 1), i++) {
    const ds = iso(d), list = byDate.get(ds) || [];
    const cls = ['cell', d.getMonth() !== m && 'out', ds === today && 'today', ds === S.sel && 'sel', i >= total - 7 && 'lastrow'].filter(Boolean).join(' ');
    const label = `${fmt(ds, { weekday: 'long', month: 'long', day: 'numeric' })}${list.length ? `, ${plural(list.length, 'post')}` : ''}`;
    const chips = list.slice(0, 3).map((p) => `<button class="chip k-${p.category}${p.status === 'posted' ? ' done' : ''}${p.format === 'story' ? ' story' : ''}" data-act="post" data-id="${esc(p.id)}" title="${esc(p.title)}"><i class="dot"></i><span class="t">${esc(p.title)}</span></button>`).join('') +
      (list.length > 3 ? `<button class="more" data-act="day" data-date="${ds}">+${list.length - 3} more</button>` : '');
    const pips = list.slice(0, 6).map((p) => `<i class="k-${p.category}"></i>`).join('');
    cells += `<div class="${cls}">
      <button class="daynum" data-act="day" data-date="${ds}" aria-label="${esc(label)}">${d.getDate()}</button>
      <button class="cellhit" data-act="day" data-date="${ds}" aria-label="${esc(label)}"><span class="n">${d.getDate()}</span><span class="pips">${pips}</span></button>
      <div class="chips">${chips}</div></div>`;
  }
  const monthLabel = first.toLocaleDateString('en-US', { month: 'long' });
  const selList = vis.filter((p) => p.date === S.sel);
  el.view.innerHTML = `
    <div class="monthbar">
      <h2>${esc(monthLabel)} <span>${y}</span></h2>
      <div class="monthnav">
        <button class="btn small" data-act="today">Today</button>
        <button class="iconbtn" data-act="prev" aria-label="Previous month">${ICON.prev}</button>
        <button class="iconbtn" data-act="next" aria-label="Next month">${ICON.next}</button>
      </div>
    </div>
    <div class="board">
      <div class="dow" aria-hidden="true">${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((w) => `<span>${narrow() ? w[0] : w}</span>`).join('')}</div>
      <div class="days">${cells}</div>
    </div>
    <div class="daypanel" id="gc-daypanel" role="region" aria-label="Selected day">
      <div class="sectionhead"><h3>${esc(fmt(S.sel, { weekday: 'long', month: 'long', day: 'numeric' }))}</h3>
        ${isStaff() ? `<button class="btn small" data-act="add-post" data-date="${S.sel}">${ICON.plus}Add a post on this day</button>` : ''}</div>
      ${selList.length ? `<div class="list">${selList.map(rowHTML).join('')}</div>`
        : `<p class="muted m0">${filtersActive() ? 'Nothing on this day matches the current filters.' : 'Nothing scheduled for this day.'}</p>`}
    </div>`;
}

// ---------------------------------------------------------------- agenda
function renderAgenda() {
  const t = todayISO();
  const list = visiblePosts().filter((p) => S.f.past || p.date >= t);
  const groups = new Map();
  for (const p of list) { const k = p.date.slice(0, 7); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(p); }
  let body = '';
  for (const [k, arr] of groups) {
    const [yy, mm] = k.split('-').map(Number);
    body += `<h3 class="mhead">${esc(new Date(yy, mm - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' }))}</h3><div class="list">${arr.map(rowHTML).join('')}</div>`;
  }
  if (!list.length) {
    body = S.posts.length
      ? emptyHTML('Agenda', 'No posts match', 'Try another category, program, or status, or clear the search.', '<div class="btns"><button class="btn" data-act="clear-filters">Clear filters</button></div>')
      : emptyHTML('Agenda', 'No posts yet', isStaff() ? 'Add the first post with Add post.' : 'Posts appear here as the media team adds them.');
  }
  el.view.innerHTML = `
    <div class="agendabar">
      <h2>${S.f.past ? 'All posts' : 'Coming up'}</h2>
      <div class="agenda-actions">
        <label class="toggle"><input type="checkbox" id="gc-past" data-act="past"${S.f.past ? ' checked' : ''}>Show earlier posts</label>
        ${list.length ? `<button class="btn small" data-act="export" data-kind="csv">${ICON.down}Spreadsheet</button><button class="btn small" data-act="export" data-kind="ics">${ICON.down}Calendar file</button>` : ''}
      </div>
    </div>${body}`;
}

// ---------------------------------------------------------------- requests
function renderRequests() {
  if (!signedIn()) {
    el.view.innerHTML = emptyHTML('Requests', 'Sign in to request a post', 'Committee chairs and brothers sign in with the chapter code, then send requests here and follow them through review.', signInButtons());
    return;
  }
  if (S.loadError && !S.loaded.requests) {
    el.view.innerHTML = emptyHTML('Connection', 'Requests could not load', `${esc(S.loadError)} Reload the page to try again.`, '<div class="btns"><button class="btn" data-act="reload">Reload</button></div>');
    return;
  }
  if (!S.loaded.requests) { el.view.innerHTML = emptyHTML('Requests', 'Loading requests', 'Requests load here in a moment.'); return; }
  const sorted = [...S.requests].sort((a, b) => (a.postDate || '9').localeCompare(b.postDate || '9') || a.createdAt.localeCompare(b.createdAt));
  if (isStaff()) {
    const counts = {};
    for (const r of S.requests) counts[r.status] = (counts[r.status] || 0) + 1;
    const segs = Object.keys(REQ_STATUS).map((k) => `<button class="seg" data-act="req-tab" data-tab="${k}" aria-pressed="${S.reqTab === k}">${esc(REQ_STATUS[k].label)} <span class="num">${counts[k] || 0}</span></button>`).join('');
    const list = sorted.filter((r) => r.status === S.reqTab);
    el.view.innerHTML = `
      <div class="reqhead"><div><p class="eyebrow">Review inbox</p><h2>Requests</h2></div>
        <button class="btn" data-act="request-new">${ICON.plus}New request</button></div>
      <div class="segs" role="group" aria-label="Request status">${segs}</div>
      ${list.length ? `<div class="reqs">${list.map(reqCard).join('')}</div>`
        : emptyHTML('Inbox', S.reqTab === 'new' ? 'No new requests' : `Nothing marked ${REQ_STATUS[S.reqTab].label.toLowerCase()}`, S.reqTab === 'new' ? 'When a chair sends a request, it lands here for review.' : 'Requests move here as you review them.')}`;
    return;
  }
  const mine = sorted.filter(isMine), others = sorted.filter((r) => !isMine(r) && r.status !== 'declined');
  el.view.innerHTML = `
    <div class="reqhead"><div><p class="eyebrow">Committee requests</p><h2>Requests</h2></div>
      <button class="btn primary" data-act="request-new">${ICON.plus}Request a post</button></div>
    <h3 class="mhead">Your requests</h3>
    ${mine.length ? `<div class="reqs">${mine.map(reqCard).join('')}</div>`
      : emptyHTML('Your requests', 'Nothing sent yet', 'Send a request at least three weeks before the date you want it posted. You can follow its status here.')}
    <h3 class="mhead">In the queue from other committees</h3>
    ${others.length ? `<div class="list">${others.map((r) => `<button class="row" data-act="req" data-id="${esc(r.id)}">
        <span class="when"><span class="wd">${esc(r.postDate ? fmt(r.postDate, { month: 'short' }) : '')}</span><span class="dn">${r.postDate ? parse(r.postDate).getDate() : ''}</span></span>
        <span class="what"><span class="ttl">${esc(r.title)}</span><span class="meta"><span>${esc(r.committee)}</span>${progTag(r.program)}</span></span>
        ${reqPill(r.status)}</button>`).join('')}</div>`
      : '<p class="muted m0">No other requests right now.</p>'}`;
}

function reqCard(r) {
  const mine = isMine(r);
  return `<article class="req">
    <div class="req-top"><div>${mine ? '<span class="yours">Yours</span>' : `<p class="eyebrow">${esc(r.committee || 'Committee')}</p>`}<h3>${esc(r.title)}</h3></div>${reqPill(r.status)}</div>
    <dl class="kv">
      <dt>Post date</dt><dd>${r.postDate ? `${esc(shortDate(r.postDate))} ${leadNote(localDateOf(r.createdAt) || todayISO(), r.postDate)}` : 'Not set'}</dd>
      ${r.eventDate ? `<dt>Event</dt><dd>${esc(shortDate(r.eventDate))}</dd>` : ''}
      <dt>From</dt><dd>${esc(r.contactName || 'Not given')}</dd>
      <dt>Format</dt><dd>${esc(FMT[r.format].label)}${r.platforms.length ? ` on ${esc(platList(r.platforms))}` : ''}</dd>
    </dl>
    ${r.reviewNote ? `<p class="note"><b>Media team:</b> ${esc(r.reviewNote)}</p>` : ''}
    <div class="req-actions">
      <button class="btn small" data-act="req" data-id="${esc(r.id)}">Open</button>
      ${isStaff() && (r.status !== 'approved' || !r.postId) && r.status !== 'declined' ? `<button class="btn small primary" data-act="approve" data-id="${esc(r.id)}">Add to calendar</button>` : ''}
      ${mine && (r.status === 'new' || r.status === 'needs-info') ? `<button class="btn small" data-act="edit-request" data-id="${esc(r.id)}">Edit</button>` : ''}
      ${r.status === 'approved' && r.postId && S.postsById.has(r.postId) ? `<button class="btn small quiet" data-act="post" data-id="${esc(r.postId)}">See the post</button>` : ''}
    </div>
  </article>`;
}

// ---------------------------------------------------------------- guide
function renderGuide() {
  el.view.innerHTML = `<div class="guide">
    <h2>How it works</h2>
    <div>
      <h3>Requesting a post</h3>
      <ol>
        <li><b>Send it three weeks ahead.</b> Sign in, then use Request a post. The form shows the earliest standard date as you pick one.</li>
        <li><b>The media team reviews it.</b> Your request shows New until someone looks at it.</li>
        <li><b>Answer any questions.</b> If it says Needs info, open it, read the note, and update the request.</li>
        <li><b>Watch it go out.</b> Approved requests appear on the calendar and move from Planned to Posted.</li>
      </ol>
    </div>
    <div>
      <h3>What to include</h3>
      <ul>
        <li><b>Final, curated photos or a finished flyer,</b> shared as a Google Drive link. Send your best selects rather than a full camera roll.</li>
        <li><b>Who, what, when, and where,</b> plus any RSVP, ticket, or registration link.</li>
        <li><b>A draft caption if you have one.</b> The media team edits for voice and length.</li>
        <li><b>Handles to tag:</b> partners, venues, and speakers.</li>
      </ul>
    </div>
    <div>
      <h3>Why three weeks</h3>
      <p>Three weeks covers design, review, and scheduling across Instagram, Facebook, Threads, X, gil1906.org, and Substack, with room for district or region approval when a flyer needs it. Shorter notice is still welcome; the media team will tell you whether it can run.</p>
      <h3>Photos of young people</h3>
      <p>For Alpha Academy, the Alpha Esquires scout troop, and any youth program, share photos only when a signed media release is on file for every young person shown. The request form asks you to confirm.</p>
    </div>
    <div>
      <h3>Signing in</h3>
      <ul>
        <li><b>First time:</b> choose Sign in, then First time here. Enter the chapter code from the media team, your first and last name, and a PIN of 4 to 6 digits.</li>
        <li><b>On another phone or computer:</b> choose I've signed in before and enter your name and PIN. You stay signed in on one device at a time, so the other one signs out.</li>
        <li><b>Forgot your PIN:</b> ask the media team to reset it.</li>
        <li><b>Media team:</b> sign in with your email and password.</li>
      </ul>
      <h3 class="mt-gap">Who sees what</h3>
      <p>Signed-in brothers see every post, caption, and note, plus the request queue. When the media team turns on the public calendar, anyone who opens this page sees dates, titles, categories, and post ideas. Captions, notes, creative links, and requests stay with signed-in brothers.</p>
      <p>For access or questions, contact ${esc(CONTACT)}.</p>
    </div>
    <div>
      <h3>Statuses</h3>
      <dl class="statuslist">${STATUSES.map((s) => `<dt>${pill(s.key)}</dt><dd>${esc(s.desc)}</dd>`).join('')}</dl>
    </div>
    <div>
      <h3>Categories</h3>
      <ul class="legend">${CATS.map((c) => `<li class="k-${c.key}"><i class="dot"></i><span><b>${esc(c.label)}.</b> ${esc(c.desc)}</span></li>`).join('')}</ul>
    </div>
    <div class="wide">
      <h3>The four national programs</h3>
      <ul>
        <li><b>Go-To-High-School, Go-To-College,</b> since 1922: finishing high school and college as a road to advancement. Alpha Academy carries it in Brooklyn.</li>
        <li><b>A Voteless People Is a Hopeless People,</b> since the 1930s: voter education, registration, and political awareness.</li>
        <li><b>Project Alpha,</b> with March of Dimes since 1980: young men ages 12 to 15 learn about responsibility, relationships, and health.</li>
        <li><b>Brother's Keeper:</b> quality of life for senior brothers, their spouses and widows, and neighbors who need support.</li>
      </ul>
    </div>
  </div>`;
}

// ---------------------------------------------------------------- rail
function renderRail() {
  const legend = `<div class="panel"><h3>Categories</h3><ul class="legend">${CATS.map((c) => `<li class="k-${c.key}"><i class="dot"></i><span>${esc(c.label)}</span></li>`).join('')}</ul></div>`;
  if (S.role === 'loading' || !canSeePosts() || !S.loaded.posts) { el.rail.innerHTML = legend; return; }
  const t = todayISO(), horizon = iso(addDays(new Date(), 14));
  const up = visiblePosts().filter((p) => p.date >= t && p.date <= horizon);
  const weekEnd = iso(addDays(new Date(), 7));
  const thisWeek = S.posts.filter((p) => p.date >= t && p.date <= weekEnd).length;
  const waiting = S.posts.filter((p) => p.status === 'needs-info' && p.date >= t).length;
  let html = `<div class="panel"><h3>Next two weeks</h3>
    ${up.length ? `<ul class="up">${up.slice(0, 9).map((p) => `<li><button data-act="post" data-id="${esc(p.id)}"><span class="ud">${esc(fmt(p.date, { weekday: 'short', day: 'numeric' }))}</span><span class="ut k-${p.category}"><i class="dot"></i><span>${esc(p.title)}</span></span></button></li>`).join('')}</ul>${up.length > 9 ? `<p class="mt8"><button class="btn small quiet" data-act="view" data-view="agenda">See all ${up.length} in Agenda</button></p>` : ''}`
      : `<p>Nothing in the next two weeks${filtersActive() ? ' with these filters' : ''}.</p>`}</div>`;
  if (isStaff()) {
    const newCount = S.requests.filter((r) => r.status === 'new').length;
    html += `<div class="panel"><h3>Desk</h3>
      <div class="stats"><div class="stat"><b>${thisWeek}</b><span>posts in 7 days</span></div><div class="stat"><b>${newCount}</b><span>new requests</span></div></div>
      <p>${waiting ? `${plural(waiting, 'upcoming post')} marked Needs info.` : 'No upcoming posts are waiting on info.'}</p>
      <button class="btn small" data-act="view" data-view="requests">Review requests</button></div>`;
  } else if (isMember()) {
    const mine = S.requests.filter(isMine);
    const ask = mine.filter((r) => r.status === 'needs-info').length;
    html += `<div class="panel"><h3>Your requests</h3>
      <p>${mine.length ? `${plural(mine.length, 'request')} sent${ask ? `, ${ask} waiting on your answer` : ''}.` : 'Send requests at least three weeks before your post date.'}</p>
      <button class="btn small primary" data-act="request-new">${ICON.plus}Request a post</button></div>`;
  } else {
    html += `<div class="panel"><h3>Brothers</h3>
      <p>Sign in to see captions and notes and to request a post.</p>
      <button class="btn small primary" data-act="signin">Sign in</button></div>`;
  }
  el.rail.innerHTML = html + legend;
}

// ---------------------------------------------------------------- drawer basics
function fieldHTML(id, label, control, hint = '', required = false) {
  return `<div class="field"><label for="${id}">${esc(label)}${required ? ' <span class="req-mark" aria-hidden="true">*</span>' : ''}</label>${control}${hint ? `<p class="hint" id="${id}-hint">${hint}</p>` : ''}</div>`;
}
const inputHTML = (id, type, value, attrs = '') => `<input id="${id}" name="${id}" type="${type}" value="${esc(value || '')}" ${attrs}>`;
const areaHTML = (id, value, attrs = '') => `<textarea id="${id}" name="${id}" ${attrs}>${esc(value || '')}</textarea>`;
const selectHTML = (id, opts, value, attrs = '') => `<select id="${id}" name="${id}" ${attrs}>${opts.map((o) => `<option value="${esc(o.key)}"${o.key === value ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}</select>`;
const checksHTML = (name, legend, opts, values) => `<fieldset class="field"><legend>${esc(legend)}</legend><div class="checks">${opts.map((o) => `<label class="check"><input type="checkbox" name="${name}" value="${o.key}"${values.includes(o.key) ? ' checked' : ''}><span>${esc(o.label)}</span></label>`).join('')}</div></fieldset>`;
const linkLine = (label, url) => { const u = safeUrl(url); return u ? `<dt>${esc(label)}</dt><dd><a href="${esc(u)}" target="_blank" rel="noopener">${esc(u.replace(/^https?:\/\//, '').slice(0, 60))}</a></dd>` : ''; };
// Committee choices, keeping a value that is no longer on the list so saving never changes it silently.
const committeeOpts = (current) => [...COMMITTEES, ...(current && !COMMITTEES.includes(current) ? [current] : [])].map((c) => ({ key: c, label: c }));

function drawerHead(eyebrow, title) {
  return `<div class="dhead"><div><p class="eyebrow">${eyebrow}</p><h2 id="gc-drawer-title" tabindex="-1">${esc(title)}</h2></div><button type="button" class="iconbtn" data-act="close" aria-label="Close">${ICON.close}</button></div>`;
}

function openDrawer(type, data, trigger) {
  S.drawer = { type, data, snap: '' };
  if (trigger) S.lastTrigger = trigger;
  el.scrim.hidden = false;
  el.drawer.hidden = false;
  document.body.style.overflow = 'hidden';
  document.documentElement.classList.add('gc-drawer-open');
  drawDrawer(true);
}
function closeDrawer() {
  S.drawer = null;
  el.drawer.hidden = true;
  el.scrim.hidden = true;
  el.drawer.innerHTML = '';
  document.body.style.overflow = '';
  document.documentElement.classList.remove('gc-drawer-open');
  const t = S.lastTrigger;
  S.lastTrigger = null;
  if (t && document.body.contains(t)) t.focus();
  else el.view.focus({ preventScroll: true });
}
const drawerItem = () => {
  const { type, data } = S.drawer;
  if (type === 'post') return S.postsById.get(data);
  if (type === 'request') return S.reqById.get(data);
  return null;
};
// After a refresh, redraw an open post or request only if it changed, so focus and scroll stay put.
function refreshDrawer() {
  if (!S.drawer) return;
  const { type } = S.drawer;
  if (type !== 'post' && type !== 'request') return;
  const item = drawerItem();
  if (!item) { closeDrawer(); toast(type === 'post' ? 'That post was removed.' : 'That request was removed.'); return; }
  if (JSON.stringify(item) === S.drawer.snap || el.drawer.querySelector('[data-pending]')) return;
  drawDrawer(false);
}

function drawDrawer(focus) {
  const { type, data } = S.drawer;
  let html = '';
  if (type === 'post') html = postView(S.postsById.get(data));
  else if (type === 'post-edit') html = postForm(data);
  else if (type === 'request-new' || type === 'request-edit') html = requestForm(type === 'request-edit' ? S.reqById.get(data) : null);
  else if (type === 'request') html = requestView(S.reqById.get(data));
  else if (type === 'signin') html = signinView();
  else if (type === 'access') html = accessView();
  const item = drawerItem();
  S.drawer.snap = item ? JSON.stringify(item) : '';
  el.drawer.innerHTML = html;
  if (type === 'request-new' || type === 'request-edit') updateLeadHint();
  if (focus) {
    const target = el.drawer.querySelector('[data-autofocus]') || el.drawer.querySelector('#gc-drawer-title');
    if (target) target.focus();
  }
}

// ---------------------------------------------------------------- posts
function postView(p) {
  if (!p) return '';
  const req = p.requestId && S.reqById.get(p.requestId);
  return `${drawerHead(esc(longDate(p.date)), p.title)}
  <div class="dbody">
    <div class="tags">${catTag(p)}${progTag(p.program)}${pill(p.status)}</div>
    ${p.concept ? `<p class="concept">${esc(p.concept)}</p>` : ''}
    <dl class="kv">
      <dt>Format</dt><dd>${esc(FMT[p.format].label)}</dd>
      <dt>Platforms</dt><dd>${p.platforms.length ? esc(platList(p.platforms)) : 'Not set'}</dd>
      ${p.committee ? `<dt>Committee</dt><dd>${esc(p.committee)}</dd>` : ''}
      ${p.eventDate ? `<dt>Event</dt><dd>${esc(longDate(p.eventDate))}</dd>` : ''}
      ${linkLine('Post link', p.link)}${linkLine('Creative', p.assetLink)}${linkLine('Source', p.source)}
    </dl>
    ${p.caption ? `<div class="block"><h4>Caption</h4><div class="caption" id="gc-caption-text">${esc(p.caption)}</div><div><button type="button" class="btn small" data-act="copy" data-target="gc-caption-text">Copy caption</button></div></div>` : ''}
    ${p.notes ? `<div class="block"><h4>Notes</h4><p>${esc(p.notes)}</p></div>` : ''}
    ${req ? `<div class="block"><h4>From a request</h4><p>${esc(req.contactName || 'A chair')}, ${esc(req.committee)}. <button type="button" class="btn small link" data-act="req" data-id="${esc(req.id)}">Open request</button></p></div>` : ''}
    ${!signedIn() ? '<p class="hint">Brothers who sign in also see the caption, notes, and creative links.</p>' : ''}
  </div>
  <div class="dfoot">
    ${isStaff() ? `<label class="sr" for="gc-quick-status">Status</label>${selectHTML('gc-quick-status', STATUSES, p.status, `data-id="${esc(p.id)}" class="autow"`)}<span class="spacer"></span>
      <button type="button" class="btn" data-act="edit-post" data-id="${esc(p.id)}">Edit</button>
      ${p.status !== 'posted' ? `<button type="button" class="btn primary" data-act="mark-posted" data-id="${esc(p.id)}">Mark posted</button>` : ''}`
      : '<button type="button" class="btn" data-act="close">Close</button>'}
  </div>`;
}

function postForm(data) {
  const existing = data && data.id ? S.postsById.get(data.id) : null;
  const pre = existing || Object.assign(normPost({ id: 'new' }), { date: (data && data.date) || S.sel || todayISO(), platforms: ['instagram', 'facebook', 'threads'], committee: 'Media' }, (data && data.prefill) || {});
  const editing = !!existing;
  const fromRequest = (data && data.fromRequest) || '';
  return `<form class="dform" id="gc-form" data-kind="post" data-id="${esc(existing ? existing.id : '')}" data-from-request="${esc(fromRequest)}" novalidate>
    ${drawerHead(editing ? 'Edit post' : (fromRequest ? 'Add request to the calendar' : 'New post'), editing ? existing.title : 'Add a post')}
    <div class="dbody">
      ${fieldHTML('p-title', 'Title', inputHTML('p-title', 'text', pre.title === 'Untitled post' ? '' : pre.title, 'required maxlength="160" data-autofocus'), '', true)}
      <div class="grid2">
        ${fieldHTML('p-date', 'Post date', inputHTML('p-date', 'date', pre.date, 'required'), '', true)}
        ${fieldHTML('p-status', 'Status', selectHTML('p-status', STATUSES, pre.status))}
        ${fieldHTML('p-category', 'Category', selectHTML('p-category', CATS, pre.category))}
        ${fieldHTML('p-program', 'National program', selectHTML('p-program', [{ key: '', label: 'None' }, ...PROGRAMS.map((p) => ({ key: p.key, label: p.short }))], pre.program))}
        ${fieldHTML('p-format', 'Format', selectHTML('p-format', FORMATS, pre.format))}
        ${fieldHTML('p-committee', 'Committee', selectHTML('p-committee', committeeOpts(pre.committee), pre.committee || 'Media'))}
      </div>
      ${checksHTML('p-platforms', 'Platforms', PLATFORMS, pre.platforms)}
      ${fieldHTML('p-concept', 'Post idea', areaHTML('p-concept', pre.concept, 'maxlength="2000"'))}
      ${fieldHTML('p-caption', 'Caption', areaHTML('p-caption', pre.caption, 'maxlength="2200"'), 'Instagram allows up to 2,200 characters.')}
      <div class="grid2">
        ${fieldHTML('p-event', 'Event date', inputHTML('p-event', 'date', pre.eventDate))}
        ${fieldHTML('p-link', 'Post link', inputHTML('p-link', 'url', pre.link, 'placeholder="https://"'), 'RSVP, tickets, or registration.')}
      </div>
      ${fieldHTML('p-asset', 'Creative', inputHTML('p-asset', 'url', pre.assetLink, 'placeholder="https://drive.google.com/..."'), 'Link to the final graphic, video, or photo folder.')}
      ${fieldHTML('p-notes', 'Notes', areaHTML('p-notes', pre.notes, 'maxlength="2000" class="ta-short"'))}
      ${fieldHTML('p-source', 'Source', inputHTML('p-source', 'url', pre.source, 'placeholder="https://"'), 'Where a date or fact was confirmed.')}
      <p class="err" id="gc-form-err" role="alert" hidden></p>
    </div>
    <div class="dfoot" id="gc-dfoot">
      ${editing ? `<button type="button" class="btn danger" data-act="delete-post" data-id="${esc(existing.id)}">Delete</button><span class="spacer"></span>` : ''}
      <button type="button" class="btn quiet" data-act="close">Cancel</button>
      <button type="submit" class="btn primary">${editing ? 'Save changes' : 'Add to calendar'}</button>
    </div>
  </form>`;
}

// ---------------------------------------------------------------- requests
function requestForm(r) {
  const pre = r || normReq({ id: 'new', contactName: isMember() ? S.me.name : '', committee: isMember() ? S.me.committee : '', platforms: ['instagram', 'facebook'] });
  const editing = !!r;
  const earliest = iso(addDays(new Date(), LEAD_DAYS));
  const committees = [...COMMITTEES, ...(pre.committee && !COMMITTEES.includes(pre.committee) ? [pre.committee] : [])];
  return `<form class="dform" id="gc-form" data-kind="request" data-id="${esc(editing ? r.id : '')}" novalidate>
    ${drawerHead(editing ? 'Update your request' : 'Request a post', editing ? r.title : 'What should we post?')}
    <div class="dbody">
      ${r && r.reviewNote ? `<p class="note"><b>Media team:</b> ${esc(r.reviewNote)}</p>` : ''}
      <div class="grid2">
        ${fieldHTML('r-name', 'Your name', inputHTML('r-name', 'text', pre.contactName, 'required maxlength="80" autocomplete="name"' + (pre.contactName ? '' : ' data-autofocus')), '', true)}
        ${fieldHTML('r-committee', 'Committee', `<select id="r-committee" name="r-committee" required><option value="">Choose your committee</option>${committees.map((c) => `<option${c === pre.committee ? ' selected' : ''}>${esc(c)}</option>`).join('')}</select>`, '', true)}
      </div>
      ${fieldHTML('r-title', 'What should we post?', inputHTML('r-title', 'text', editing ? pre.title : '', 'required maxlength="120"' + (pre.contactName ? ' data-autofocus' : '')), 'A short name, for example: School Daze ticket launch.', true)}
      <div class="grid2">
        ${fieldHTML('r-date', 'Requested post date', inputHTML('r-date', 'date', pre.postDate, `required min="${todayISO()}"`), `Earliest standard date: ${esc(shortDate(earliest))}.`, true)}
        ${fieldHTML('r-event', 'Event date', inputHTML('r-event', 'date', pre.eventDate), 'If the post is about an event.')}
      </div>
      ${fieldHTML('r-about', 'Details', areaHTML('r-about', pre.about, 'required maxlength="2000"'), 'Who, what, when, where, and why it matters.', true)}
      <div class="grid2">
        ${fieldHTML('r-format', 'Format', selectHTML('r-format', FORMATS, pre.format))}
        ${fieldHTML('r-program', 'National program', selectHTML('r-program', [{ key: '', label: 'None' }, ...PROGRAMS.map((p) => ({ key: p.key, label: p.short }))], pre.program))}
      </div>
      ${checksHTML('r-platforms', 'Where should it go?', PLATFORMS, pre.platforms)}
      ${fieldHTML('r-asset', 'Creative link', inputHTML('r-asset', 'url', pre.assetLink, 'placeholder="https://drive.google.com/..."'), 'Google Drive link to final, curated photos or a finished flyer.')}
      ${fieldHTML('r-caption', 'Draft caption', areaHTML('r-caption', pre.caption, 'maxlength="2200"'), 'Optional. Include handles to tag.')}
      ${fieldHTML('r-link', 'Link for the post', inputHTML('r-link', 'url', pre.link, 'placeholder="https://"'), 'RSVP, tickets, or registration.')}
      <label class="tick"><input type="checkbox" id="r-youth" name="r-youth"${pre.youth ? ' checked' : ''}><span>This request includes photos of young people.</span></label>
      <label class="tick" id="gc-releases-row"${pre.youth ? '' : ' hidden'}><input type="checkbox" id="r-releases" name="r-releases"${pre.releases ? ' checked' : ''}><span>Signed media releases are on file for every young person shown.</span></label>
      <p class="err" id="gc-form-err" role="alert" hidden></p>
    </div>
    <div class="dfoot">
      <button type="button" class="btn quiet" data-act="close">Cancel</button>
      <button type="submit" class="btn primary">${editing ? 'Update request' : 'Send request'}</button>
    </div>
  </form>`;
}

function updateLeadHint() {
  const input = $('#r-date', el.drawer), hint = $('#r-date-hint', el.drawer);
  if (!input || !hint) return;
  const v = input.value, earliest = iso(addDays(new Date(), LEAD_DAYS));
  hint.className = 'hint';
  if (!v) { hint.textContent = `Earliest standard date: ${shortDate(earliest)}.`; return; }
  const n = daysBetween(todayISO(), v);
  if (isNaN(n)) { hint.textContent = 'Choose a date.'; return; }
  if (n < 0) { hint.textContent = 'That date has passed. Choose a future date.'; hint.classList.add('bad'); return; }
  if (n < LEAD_DAYS) { hint.textContent = `Short notice: ${plural(n, 'day')} away. The media team will confirm whether it can run.`; hint.classList.add('warn'); return; }
  hint.textContent = `${plural(n, 'day')} away. That meets the three-week lead time.`;
}

function requestView(r) {
  if (!r) return '';
  const mine = isMine(r);
  const post = r.postId && S.postsById.get(r.postId);
  let foot = '';
  if (isStaff()) {
    const canAdd = r.status !== 'approved' || !r.postId;
    foot = `${r.status !== 'declined' && r.status !== 'approved' ? `<button type="button" class="btn danger" data-act="decline" data-id="${esc(r.id)}">Decline</button>` : ''}
      ${r.status === 'declined' ? `<button type="button" class="btn" data-act="reopen" data-id="${esc(r.id)}">Reopen</button>` : ''}
      <span class="spacer"></span>
      ${canAdd && r.status !== 'declined' ? `<button type="button" class="btn" data-act="ask-info" data-id="${esc(r.id)}">Ask for info</button><button type="button" class="btn primary" data-act="approve" data-id="${esc(r.id)}">Add to calendar</button>` : ''}
      ${post ? `<button type="button" class="btn" data-act="post" data-id="${esc(post.id)}">Open the post</button>` : ''}`;
  } else {
    foot = `${mine && (r.status === 'new' || r.status === 'needs-info') ? `<button type="button" class="btn primary" data-act="edit-request" data-id="${esc(r.id)}">Edit request</button>` : ''}
      ${post ? `<button type="button" class="btn" data-act="post" data-id="${esc(post.id)}">See the post</button>` : ''}
      <button type="button" class="btn quiet" data-act="close">Close</button>`;
  }
  return `${drawerHead(esc(r.committee || 'Request'), r.title)}
  <div class="dbody">
    <div class="tags">${reqPill(r.status)}${progTag(r.program)}${r.youth ? `<span class="muted">Includes young people${r.releases ? ', releases confirmed' : ''}</span>` : ''}</div>
    ${r.reviewNote ? `<p class="note"><b>Media team:</b> ${esc(r.reviewNote)}</p>` : ''}
    <dl class="kv">
      <dt>Post date</dt><dd>${r.postDate ? `${esc(longDate(r.postDate))} ${leadNote(localDateOf(r.createdAt) || todayISO(), r.postDate)}` : 'Not set'}</dd>
      ${r.eventDate ? `<dt>Event</dt><dd>${esc(longDate(r.eventDate))}</dd>` : ''}
      <dt>From</dt><dd>${esc(r.contactName || 'Not given')}</dd>
      <dt>Format</dt><dd>${esc(FMT[r.format].label)}</dd>
      <dt>Platforms</dt><dd>${r.platforms.length ? esc(platList(r.platforms)) : 'Not set'}</dd>
      ${r.createdAt ? `<dt>Sent</dt><dd>${esc(shortDate(localDateOf(r.createdAt)))}</dd>` : ''}
      ${linkLine('Creative', r.assetLink)}${linkLine('Post link', r.link)}
    </dl>
    ${r.about ? `<div class="block"><h4>Details</h4><p>${esc(r.about)}</p></div>` : ''}
    ${r.caption ? `<div class="block"><h4>Draft caption</h4><div class="caption" id="gc-caption-text">${esc(r.caption)}</div><div><button type="button" class="btn small" data-act="copy" data-target="gc-caption-text">Copy caption</button></div></div>` : ''}
    <div id="gc-review-box"></div>
  </div>
  <div class="dfoot" id="gc-dfoot">${foot}</div>`;
}

function showReviewBox(id, kind) {
  const box = $('#gc-review-box', el.drawer);
  if (!box) return;
  const decline = kind === 'decline';
  box.setAttribute('data-pending', '1');
  box.innerHTML = `<div class="block">
    ${fieldHTML('gc-review-note', decline ? 'Reason, shared with the chair' : 'Question for the chair', areaHTML('gc-review-note', '', 'maxlength="800" class="ta-mid"'), decline ? 'Keep it short and say what would make a future request work.' : 'The chair sees this on the request and can update it.')}
    <div class="confirm"><button type="button" class="btn quiet" data-act="cancel-review">Cancel</button>
    <button type="button" class="btn ${decline ? 'danger' : 'primary'}" data-act="${decline ? 'confirm-decline' : 'confirm-info'}" data-id="${esc(id)}">${decline ? 'Decline request' : 'Send question'}</button></div></div>`;
  const ta = $('#gc-review-note', box);
  if (ta) ta.focus();
}

// ---------------------------------------------------------------- sign in
function signinView() {
  const mode = S.signin.mode;
  const modes = [['join', 'First time here'], ['rejoin', "I've signed in before"], ['staff', 'Media team']];
  const notReady = !DEMO && !S.settings.ready;
  let body = '', foot = '', kind = mode;
  if (mode === 'join') {
    body = `${notReady ? '<p class="note">Sign-in opens once the media team sets the chapter code.</p>' : ''}
      ${fieldHTML('s-code', 'Chapter code', inputHTML('s-code', 'text', '', 'required autocomplete="off" autocapitalize="off" spellcheck="false" data-autofocus'), DEMO ? 'Demo: any code works.' : 'From the media team. You need it only this once.', true)}
      ${fieldHTML('s-name', 'Your name', inputHTML('s-name', 'text', '', 'required maxlength="40" autocomplete="name"'), 'First and last name. You use it with your PIN to sign in on another device.', true)}
      ${fieldHTML('s-committee', 'Committee', `<select id="s-committee" name="s-committee"><option value="">No committee</option>${COMMITTEES.map((c) => `<option>${esc(c)}</option>`).join('')}</select>`, 'Fills in your request forms.')}
      ${fieldHTML('s-pin', 'PIN', inputHTML('s-pin', 'password', '', 'required inputmode="numeric" pattern="[0-9]*" maxlength="6" autocomplete="new-password"'), '4 to 6 digits. Keep it to yourself.', true)}`;
    foot = '<button type="button" class="btn quiet" data-act="close">Cancel</button><button type="submit" class="btn primary">Sign in</button>';
  } else if (mode === 'rejoin') {
    body = `${fieldHTML('s-name', 'Your name', inputHTML('s-name', 'text', store.get('last-name', ''), 'required maxlength="40" autocomplete="username"' + (store.get('last-name', '') ? '' : ' data-autofocus')), 'The name you used the first time.', true)}
      ${fieldHTML('s-pin', 'PIN', inputHTML('s-pin', 'password', '', 'required inputmode="numeric" pattern="[0-9]*" maxlength="6" autocomplete="current-password"' + (store.get('last-name', '') ? ' data-autofocus' : '')), 'Signing in here signs you out on your other device. Forgot it? The media team can reset it.', true)}`;
    foot = '<button type="button" class="btn quiet" data-act="close">Cancel</button><button type="submit" class="btn primary">Sign in</button>';
  } else if (S.account && !S.account.anonymous) {
    kind = 'claim';
    body = `<p class="m0">Signed in as <b>${esc(S.account.email || 'your email')}</b>. To finish, add your name and the media code.</p>
      ${fieldHTML('s-staff-name', 'Your name', inputHTML('s-staff-name', 'text', '', 'required maxlength="60" autocomplete="name" data-autofocus'), 'Shown to the media team.', true)}
      ${fieldHTML('s-media-code', 'Media code', inputHTML('s-media-code', 'text', '', 'required autocomplete="off" autocapitalize="off" spellcheck="false"'), 'The phrase only the media team knows.', true)}`;
    foot = '<button type="button" class="btn quiet" data-act="signout">Sign out</button><span class="spacer"></span><button type="submit" class="btn primary">Join the media team</button>';
  } else {
    kind = 'staff';
    body = `${fieldHTML('s-email', 'Email', inputHTML('s-email', 'email', '', 'required autocomplete="username" data-autofocus'), '', true)}
      ${fieldHTML('s-password', 'Password', inputHTML('s-password', 'password', '', 'required minlength="8" autocomplete="current-password"'), 'New to the media team? Enter your email and a password of at least 8 characters, then choose Create login.', true)}`;
    foot = '<button type="button" class="btn" data-act="staff-signup">Create login</button><span class="spacer"></span><button type="submit" class="btn primary">Sign in</button>';
  }
  return `<form class="dform" id="gc-form" data-kind="${kind}" novalidate>
    ${drawerHead('Sign in', mode === 'staff' ? 'Media team' : 'Brothers')}
    <div class="dbody">
      <div class="modes" role="group" aria-label="How are you signing in?">${modes.map(([k, l]) => `<button type="button" class="seg" data-act="signin-mode" data-mode="${k}" aria-pressed="${mode === k}">${esc(l)}</button>`).join('')}</div>
      ${S.signin.note ? `<p class="note">${esc(S.signin.note)}</p>` : ''}
      ${S.signin.done ? `<p class="ok">${esc(S.signin.done)}</p>` : ''}
      ${body}
      <p class="err" id="gc-form-err" role="alert" hidden></p>
    </div>
    <div class="dfoot">${foot}</div>
  </form>`;
}

// ---------------------------------------------------------------- manage access
function accessView() {
  const A = S.access;
  const dateOf = (ts) => (ts ? shortDate(localDateOf(ts)) : '');
  let people = '<p class="muted m0">Loading the list.</p>';
  if (A.error) people = `<p class="err">${esc(A.error)}</p>`;
  else if (A.members && !A.members.length) people = '<p class="muted m0">No brothers have signed in yet.</p>';
  else if (A.members) {
    people = `<div class="people">${A.members.map((m) => {
      const pending = A.pending && A.pending.id === m.id ? A.pending.kind : '';
      let act = `<button type="button" class="btn small" data-act="m-reset" data-id="${esc(m.id)}">Reset PIN</button><button type="button" class="btn small danger" data-act="m-remove" data-id="${esc(m.id)}">Remove</button>`;
      if (pending === 'reset') {
        act = `<label class="sr" for="gc-pin-${esc(m.id)}">New PIN for ${esc(m.name)}</label><input id="gc-pin-${esc(m.id)}" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="6" autocomplete="off" placeholder="New PIN">
          <button type="button" class="btn small primary" data-act="m-reset-save" data-id="${esc(m.id)}">Save PIN</button><button type="button" class="btn small quiet" data-act="m-cancel">Cancel</button>`;
      } else if (pending === 'remove') {
        act = `<span class="person-meta">Remove ${esc(m.name)}? Their requests stay.</span><button type="button" class="btn small quiet" data-act="m-cancel">Keep</button><button type="button" class="btn small danger" data-act="m-remove-confirm" data-id="${esc(m.id)}">Remove</button>`;
      }
      const meta = [m.committee, m.createdAt && `joined ${dateOf(m.createdAt)}`, m.lastSeenAt && `last sign-in ${dateOf(m.lastSeenAt)}`, plural(m.requests, 'request')].filter(Boolean).join(' · ');
      return `<div class="person">
        <div class="person-top"><span class="person-name">${esc(m.name)}</span>${m.locked ? '<span class="pill s-locked">Locked</span>' : ''}</div>
        <span class="person-meta">${esc(meta)}</span>
        <div class="person-act">${act}</div></div>`;
    }).join('')}</div>`;
  }
  const staff = A.staff ? A.staff.map((s) => esc(s.name)).join(', ') : '';
  return `${drawerHead('Media team', 'Manage access')}
  <div class="dbody">
    <div class="block">
      <h4>Public calendar</h4>
      <label class="tick"><input type="checkbox" id="gc-set-public"${S.settings.public ? ' checked' : ''}><span>Show the calendar to anyone who opens this page</span></label>
      <p class="hint">Visitors see dates, titles, categories, and post ideas. Captions, notes, creative links, and requests stay with signed-in brothers.</p>
    </div>
    <div class="divider"></div>
    <form class="block" id="gc-code-form" data-kind="code" novalidate>
      <h4>Chapter code</h4>
      ${fieldHTML('gc-new-code', 'New code', inputHTML('gc-new-code', 'text', '', 'minlength="6" autocomplete="off" autocapitalize="off" spellcheck="false"'), 'Brothers enter it the first time they sign in. Changing it keeps everyone signed in; share the new code at the next meeting.')}
      <div class="btnrow"><button type="submit" class="btn small">Change code</button></div>
      <p class="err" id="gc-code-err" role="alert" hidden></p>
    </form>
    <div class="divider"></div>
    <div class="block">
      <h4>Brothers${A.members ? ` (${A.members.length})` : ''}</h4>
      <p class="hint">Reset a PIN when a brother forgets it, then tell him the new one privately. Remove signs a brother out; his requests stay.</p>
      ${people}
    </div>
    <div class="divider"></div>
    <div class="block">
      <h4>Media team</h4>
      ${staff ? `<p>${staff}</p>` : ''}
      <p class="hint">To add someone, have them choose Sign in, then Media team, create a login, and enter the media code. Removing someone from the media team is done in Supabase.</p>
    </div>
  </div>
  <div class="dfoot"><button type="button" class="btn" data-act="close">Close</button></div>`;
}

async function loadAccess() {
  try {
    const [members, staff] = await Promise.all([api.memberList(), api.staffList()]);
    S.access.members = members;
    S.access.staff = staff;
    S.access.error = '';
  } catch (e) {
    S.access.error = e.message || 'The list could not load.';
  }
  if (S.drawer && S.drawer.type === 'access') drawDrawer(false);
}

// ---------------------------------------------------------------- writes
function collectPost(form) {
  const fd = new FormData(form);
  const v = (k) => String(fd.get(k) || '').trim();
  return {
    title: v('p-title'), date: v('p-date'), status: v('p-status'), category: v('p-category'), program: v('p-program'),
    format: v('p-format'), committee: v('p-committee'), platforms: fd.getAll('p-platforms').map(String),
    concept: v('p-concept'), caption: v('p-caption'), eventDate: v('p-event'), link: v('p-link'),
    assetLink: v('p-asset'), notes: v('p-notes'), source: v('p-source')
  };
}
function collectRequest(form) {
  const fd = new FormData(form);
  const v = (k) => String(fd.get(k) || '').trim();
  return {
    contactName: v('r-name'), committee: v('r-committee'), title: v('r-title'), postDate: v('r-date'), eventDate: v('r-event'),
    about: v('r-about'), format: v('r-format'), program: v('r-program'), platforms: fd.getAll('r-platforms').map(String),
    assetLink: v('r-asset'), caption: v('r-caption'), link: v('r-link'),
    youth: !!fd.get('r-youth'), releases: !!fd.get('r-releases')
  };
}
function formError(msg, focusId, errId = 'gc-form-err') {
  const err = $('#' + errId, el.drawer);
  if (err) { err.textContent = msg; err.hidden = false; }
  const f = focusId && $('#' + focusId, el.drawer);
  if (f) f.focus();
}
function badUrl(...pairs) {
  for (const [id, val] of pairs) if (val && !safeUrl(val)) return id;
  return '';
}
async function withBusy(form, fn) {
  const btns = [...form.querySelectorAll('button')];
  btns.forEach((b) => { b.disabled = true; });
  try { return await fn(); } finally { btns.forEach((b) => { b.disabled = false; }); }
}

async function submitPost(form) {
  const d = collectPost(form);
  if (!d.title) return formError('Add a title.', 'p-title');
  if (!parse(d.date)) return formError('Choose a post date.', 'p-date');
  const bad = badUrl(['p-link', d.link], ['p-asset', d.assetLink], ['p-source', d.source]);
  if (bad) return formError('Links need to start with https://.', bad);
  const existing = form.dataset.id ? S.postsById.get(form.dataset.id) : null;
  const fromRequest = form.dataset.fromRequest;
  const doc = { ...d, eventDate: parse(d.eventDate) ? d.eventDate : '' };
  if (existing) doc.id = existing.id;
  let saved;
  try {
    saved = await withBusy(form, () => (fromRequest && !existing
      ? api.approveRequest(fromRequest, doc)
      : api.savePost(doc, { isNew: !existing })));
  } catch (e) { return formError(e.message); }
  const p = upsertPost(saved);
  if (fromRequest) await loadData();
  S.sel = p.date;
  const dd = parse(p.date);
  S.ym = { y: dd.getFullYear(), m: dd.getMonth() };
  toast(existing ? 'Post saved' : fromRequest ? 'Request added to the calendar' : 'Post added');
  if (existing) { S.drawer = { type: 'post', data: p.id, snap: '' }; drawDrawer(true); } else closeDrawer();
  render();
}

async function submitRequest(form) {
  const d = collectRequest(form);
  if (!d.contactName || d.contactName.length < 2) return formError('Add your name.', 'r-name');
  if (!d.committee) return formError('Choose your committee.', 'r-committee');
  if (d.title.length < 3) return formError('Say what the post is about in a few words.', 'r-title');
  if (!parse(d.postDate)) return formError('Choose a post date.', 'r-date');
  const existing = form.dataset.id ? S.reqById.get(form.dataset.id) : null;
  if (daysBetween(todayISO(), d.postDate) < 0 && (!existing || existing.postDate !== d.postDate)) return formError('That post date has passed. Choose a future date.', 'r-date');
  if (d.about.length < 3) return formError('Add the details: who, what, when, and where.', 'r-about');
  if (!d.platforms.length) return formError('Choose at least one place to post.', '');
  const bad = badUrl(['r-asset', d.assetLink], ['r-link', d.link]);
  if (bad) return formError('Links need to start with https://.', bad);
  if (d.youth && !d.releases) return formError('Confirm that media releases are on file, or remove photos of young people.', 'r-releases');
  d.eventDate = parse(d.eventDate) ? d.eventDate : '';
  let saved;
  try {
    saved = await withBusy(form, () => (existing ? api.updateRequest(existing.id, d) : api.submitRequest(d)));
  } catch (e) { return formError(e.message); }
  upsertRequest(saved);
  toast(existing ? 'Request updated' : 'Request sent. Track it under Requests.');
  closeDrawer();
  if (!isStaff()) setView('requests'); else render();
}

async function setPostStatus(id, status) {
  const p = S.postsById.get(id);
  if (!p) return;
  try { await api.setPostStatus(id, status); } catch (e) { toast(e.message); if (S.drawer) drawDrawer(false); return; }
  upsertPost({ ...p, status });
  toast(`Marked ${STAT[status].label.toLowerCase()}`);
  if (S.drawer && S.drawer.type === 'post') drawDrawer(false);
  render();
}

async function deletePost(id) {
  try { await api.deletePost(id); } catch (e) { toast(e.message); return; }
  setPosts(S.posts.filter((p) => p.id !== id));
  setRequests(S.requests.map((r) => (r.postId === id ? { ...r, postId: '' } : r)));
  toast('Post deleted');
  closeDrawer();
  render();
}

async function reviewRequest(id, status) {
  const ta = $('#gc-review-note', el.drawer);
  const note = ((ta || {}).value || '').trim();
  if (status !== 'new' && !note) { if (ta) ta.focus(); toast('Write a note for the chair first.'); return; }
  try { upsertRequest(await api.reviewRequest(id, status, note)); } catch (e) { toast(e.message); return; }
  toast(status === 'declined' ? 'Request declined' : status === 'new' ? 'Request reopened' : 'Question sent to the chair');
  if (S.drawer) drawDrawer(false);
  render();
}

async function submitSignin(form) {
  const kind = form.dataset.kind;
  const v = (id) => String(($('#' + id, form) || {}).value || '').trim();
  S.signin.done = '';
  try {
    if (kind === 'join') {
      const code = v('s-code'), name = v('s-name').replace(/\s+/g, ' '), pin = v('s-pin');
      if (!code) return formError('Enter the chapter code.', 's-code');
      if (name.length < 2 || name.length > 40) return formError('Use 2 to 40 characters for your name.', 's-name');
      if (!/^\d{4,6}$/.test(pin)) return formError('Your PIN must be 4 to 6 digits.', 's-pin');
      await withBusy(form, () => api.join({ code, name, pin, committee: v('s-committee') }));
      return afterSignIn();
    }
    if (kind === 'rejoin') {
      const name = v('s-name').replace(/\s+/g, ' '), pin = v('s-pin');
      if (name.length < 2) return formError('Enter the name you used the first time.', 's-name');
      if (!/^\d{4,6}$/.test(pin)) return formError('Your PIN is 4 to 6 digits.', 's-pin');
      await withBusy(form, () => api.rejoin({ name, pin }));
      return afterSignIn();
    }
    if (kind === 'staff') {
      const email = v('s-email'), password = ($('#s-password', form) || {}).value || '';
      if (!email || !password) return formError('Enter your email and password.', email ? 's-password' : 's-email');
      await withBusy(form, () => api.staffSignIn(email, password));
      return afterStaffLogin();
    }
    if (kind === 'claim') {
      const name = v('s-staff-name'), code = v('s-media-code');
      if (name.length < 2) return formError('Add your name.', 's-staff-name');
      if (!code) return formError('Enter the media code.', 's-media-code');
      await withBusy(form, () => api.claimStaff(code, name));
      return afterSignIn();
    }
  } catch (e) {
    return formError(e.message);
  }
}

async function staffSignUp() {
  const form = $('#gc-form', el.drawer);
  if (!form) return;
  const email = String(($('#s-email', form) || {}).value || '').trim(), password = ($('#s-password', form) || {}).value || '';
  if (!/^\S+@\S+\.\S+$/.test(email)) return formError('Enter your email address.', 's-email');
  if (password.length < 8) return formError('Use a password of at least 8 characters.', 's-password');
  try {
    const res = await withBusy(form, () => api.staffSignUp(email, password));
    if (res && res.needsConfirm) {
      S.signin.done = 'Check your email for the confirmation link, then come back here and sign in.';
      drawDrawer(false);
      return;
    }
    return afterStaffLogin();
  } catch (e) {
    return formError(e.message);
  }
}

// After an email sign-in: the media team goes straight in; anyone else sees the claim step.
async function afterStaffLogin() {
  await refreshIdentity();
  if (isStaff()) return afterSignIn();
  S.signin.mode = 'staff';
  S.signin.note = '';
  drawDrawer(true);
}

async function afterSignIn() {
  await refreshIdentity();
  S.signin.note = '';
  S.signin.done = '';
  closeDrawer();
  toast(signedIn() ? `Signed in as ${S.me.name}` : 'Signed in');
  render();
  await loadData();
}

async function signOut() {
  try { await api.signOut(); } catch (e) { toast(e.message); return; }
  store.del('was-member');
  S.signin = { mode: store.get('last-name', '') ? 'rejoin' : 'join', note: '', done: '' };
  await refreshIdentity().catch(() => { S.role = 'visitor'; S.me = { role: 'visitor' }; });
  if (S.drawer) closeDrawer();
  toast('Signed out');
  render();
  await loadData();
}

// ---------------------------------------------------------------- export
function csvCell(v) { const s = String(v ?? ''); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }
function exportList() { const t = todayISO(); return visiblePosts().filter((p) => S.f.past || p.date >= t); }

function toCSV(list) {
  const full = signedIn();
  const head = ['Date', 'Title', 'Category', 'National program', 'Format', 'Platforms', 'Status', 'Committee', 'Event date', 'Post idea', 'Post link'];
  if (full) head.push('Caption', 'Creative', 'Notes', 'Source');
  const rows = [head];
  for (const p of list) {
    const row = [p.date, p.title, CAT[p.category].label, p.program ? PROG[p.program].label : '', FMT[p.format].label, platList(p.platforms), STAT[p.status].label, p.committee, p.eventDate, p.concept, p.link];
    if (full) row.push(p.caption, p.assetLink, p.notes, p.source);
    rows.push(row);
  }
  return rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
}

// iCalendar text: escape per RFC 5545 and fold lines at 75 bytes.
const icsEsc = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const encoder = new TextEncoder();
function icsFold(line) {
  if (encoder.encode(line).length <= 75) return line;
  let out = '', cur = '', bytes = 0, limit = 75;
  for (const ch of line) {
    const b = encoder.encode(ch).length;
    if (bytes + b > limit) { out += cur + '\r\n '; cur = ''; bytes = 0; limit = 74; }
    cur += ch;
    bytes += b;
  }
  return out + cur;
}
function toICS(list) {
  const stampNow = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Gamma Iota Lambda Chapter//Content Calendar//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:GIL content calendar'];
  for (const p of list) {
    const day = p.date.replace(/-/g, ''), next = iso(addDays(parse(p.date), 1)).replace(/-/g, '');
    const desc = [
      `${CAT[p.category].label}${p.program ? ' · ' + PROG[p.program].short : ''} · ${FMT[p.format].label}`,
      p.platforms.length ? 'Platforms: ' + platList(p.platforms) : '',
      `Status: ${STAT[p.status].label}`,
      p.concept
    ].filter(Boolean).join('\n');
    lines.push('BEGIN:VEVENT', `UID:${p.id}@gil1906.org`, `DTSTAMP:${stampNow}`, `DTSTART;VALUE=DATE:${day}`, `DTEND;VALUE=DATE:${next}`,
      `SUMMARY:${icsEsc(p.title)}`, `DESCRIPTION:${icsEsc(desc)}`, `CATEGORIES:${icsEsc(CAT[p.category].label)}`, 'TRANSP:TRANSPARENT');
    if (safeUrl(p.link)) lines.push(`URL:${safeUrl(p.link)}`);
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(icsFold).join('\r\n') + '\r\n';
}

function download(filename, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
function exportFile(kind) {
  const list = exportList();
  if (!list.length) { toast('No posts to export with these filters.'); return; }
  if (kind === 'ics') {
    download('gil-content-calendar.ics', toICS(list), 'text/calendar;charset=utf-8');
    toast(`Calendar file with ${plural(list.length, 'post')} downloaded`);
  } else {
    download('gil-content-calendar.csv', '\ufeff' + toCSV(list), 'text/csv;charset=utf-8');
    toast(`Spreadsheet with ${plural(list.length, 'post')} downloaded`);
  }
}

// ---------------------------------------------------------------- copy and toast
async function copyFrom(id) {
  const node = document.getElementById(id);
  if (!node) return;
  try { await navigator.clipboard.writeText(node.textContent); toast('Caption copied'); } catch {
    const r = document.createRange();
    r.selectNodeContents(node);
    const s = getSelection();
    s.removeAllRanges();
    s.addRange(r);
    toast('Caption selected. Copy it with your keyboard.');
  }
}
let toastTimer = 0;
function toast(msg) {
  el.toast.textContent = msg;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.toast.hidden = true; }, 3600);
}

// ---------------------------------------------------------------- navigation
function setView(v) {
  if (!VIEWS.includes(v)) return;
  S.view = v;
  store.set('view', v);
  try { history.replaceState(null, '', '#' + v); } catch { /* file:// previews */ }
  render();
  // If the reader had scrolled past the top of the view, bring it back under the nav and toolbar.
  const navH = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--nav-h')) || 0;
  const bar = $('#gc-bar');
  const sticky = window.matchMedia('(min-width: 901px)').matches;
  const target = el.layout.getBoundingClientRect().top + window.scrollY - navH - (sticky && bar ? bar.offsetHeight : 0);
  if (window.scrollY > target) window.scrollTo({ top: Math.max(0, target), behavior: 'auto' });
}
function shiftMonth(n) {
  const d = new Date(S.ym.y, S.ym.m + n, 1);
  S.ym = { y: d.getFullYear(), m: d.getMonth() };
  const t = new Date();
  S.sel = (d.getFullYear() === t.getFullYear() && d.getMonth() === t.getMonth()) ? todayISO() : iso(d);
  renderMain();
  renderRail();
}

// ---------------------------------------------------------------- events
document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-act]');
  if (!t || !t.closest('.gc')) return;
  const act = t.dataset.act, id = t.dataset.id;
  switch (act) {
    case 'view': setView(t.dataset.view); break;
    case 'day': {
      S.sel = t.dataset.date;
      const d = parse(S.sel);
      if (d.getMonth() !== S.ym.m || d.getFullYear() !== S.ym.y) S.ym = { y: d.getFullYear(), m: d.getMonth() };
      renderMain();
      if (narrow() || t.classList.contains('more')) { const panel = $('#gc-daypanel'); if (panel) panel.scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'start' }); }
      break;
    }
    case 'prev': shiftMonth(-1); break;
    case 'next': shiftMonth(1); break;
    case 'today': { const n = new Date(); S.ym = { y: n.getFullYear(), m: n.getMonth() }; S.sel = todayISO(); renderMain(); renderRail(); break; }
    case 'cat': {
      const k = t.dataset.cat;
      if (S.f.cats.has(k)) S.f.cats.delete(k); else S.f.cats.add(k);
      if (!S.f.cats.size) CATS.forEach((c) => S.f.cats.add(c.key));
      store.set('cats', [...S.f.cats]);
      render();
      break;
    }
    case 'clear-filters':
      S.f.cats = new Set(CATS.map((c) => c.key)); S.f.program = ''; S.f.status = ''; S.f.q = ''; el.q.value = '';
      store.set('cats', [...S.f.cats]);
      render();
      break;
    case 'past': S.f.past = t.checked; renderMain(); break;
    case 'export': exportFile(t.dataset.kind); break;
    case 'req-tab': S.reqTab = t.dataset.tab; renderMain(); break;
    case 'post': openDrawer('post', id, S.drawer ? S.lastTrigger : t); break;
    case 'req': openDrawer('request', id, S.drawer ? S.lastTrigger : t); break;
    case 'add-post': if (isStaff()) openDrawer('post-edit', { date: t.dataset.date || S.sel || todayISO() }, t); break;
    case 'edit-post': if (isStaff()) openDrawer('post-edit', { id }, S.lastTrigger); break;
    case 'request-new': if (signedIn()) openDrawer('request-new', null, t); else openDrawer('signin', null, t); break;
    case 'edit-request': openDrawer('request-edit', id, S.drawer ? S.lastTrigger : t); break;
    case 'approve': {
      if (!isStaff()) break;
      const r = S.reqById.get(id);
      if (!r) break;
      openDrawer('post-edit', {
        fromRequest: r.id, date: r.postDate, prefill: {
          title: r.title, date: r.postDate || todayISO(), category: 'chapter', program: r.program, format: r.format,
          platforms: r.platforms.length ? r.platforms : ['instagram', 'facebook'], status: 'planned',
          committee: r.committee || 'Other', concept: r.about, caption: r.caption,
          assetLink: r.assetLink, link: r.link, eventDate: r.eventDate,
          notes: `Requested by ${r.contactName || 'a chair'}${r.committee ? ', ' + r.committee : ''}.${r.youth ? ' Includes young people; releases confirmed.' : ''}`
        }
      }, S.drawer ? S.lastTrigger : t);
      break;
    }
    case 'ask-info': showReviewBox(id, 'info'); break;
    case 'decline': showReviewBox(id, 'decline'); break;
    case 'cancel-review': drawDrawer(false); break;
    case 'confirm-info': reviewRequest(id, 'needs-info'); break;
    case 'confirm-decline': reviewRequest(id, 'declined'); break;
    case 'reopen': reviewRequest(id, 'new'); break;
    case 'mark-posted': setPostStatus(id, 'posted'); break;
    case 'delete-post': {
      const foot = $('#gc-dfoot', el.drawer);
      if (!foot) break;
      foot.innerHTML = `<div class="confirm"><span>Delete this post for everyone?</span><button type="button" class="btn quiet" data-act="keep-post">Keep it</button><button type="button" class="btn danger" data-act="confirm-delete" data-id="${esc(id)}">Delete post</button></div>`;
      const k = foot.querySelector('[data-act="keep-post"]');
      if (k) k.focus();
      break;
    }
    case 'keep-post': drawDrawer(false); break;
    case 'confirm-delete': deletePost(id); break;
    case 'copy': copyFrom(t.dataset.target); break;
    case 'close': closeDrawer(); break;
    case 'reload': location.reload(); break;
    case 'signin': S.signin.done = ''; if (t.dataset.mode) S.signin.mode = t.dataset.mode; openDrawer('signin', null, t); break;
    case 'signin-mode': S.signin.mode = t.dataset.mode; S.signin.done = ''; drawDrawer(false); { const b = el.drawer.querySelector(`[data-mode="${t.dataset.mode}"]`); if (b) b.focus(); } break;
    case 'staff-signup': staffSignUp(); break;
    case 'signout': signOut(); break;
    case 'access': if (isStaff()) { S.access = { members: null, staff: null, error: '', pending: null }; openDrawer('access', null, t); loadAccess(); } break;
    case 'm-reset': S.access.pending = { id, kind: 'reset' }; drawDrawer(false); { const f = document.getElementById('gc-pin-' + id); if (f) f.focus(); } break;
    case 'm-remove': S.access.pending = { id, kind: 'remove' }; drawDrawer(false); break;
    case 'm-cancel': S.access.pending = null; drawDrawer(false); break;
    case 'm-reset-save': resetPin(id); break;
    case 'm-remove-confirm': removeMember(id); break;
    case 'demo-role': demoRole(t.dataset.role); break;
    case 'demo-reset': api.reset(); store.del('view'); location.reload(); break;
  }
});

async function resetPin(id) {
  const input = document.getElementById('gc-pin-' + id);
  const pin = input ? input.value.trim() : '';
  if (!/^\d{4,6}$/.test(pin)) { toast('The new PIN must be 4 to 6 digits.'); if (input) input.focus(); return; }
  const m = (S.access.members || []).find((x) => x.id === id);
  try { await api.resetPin(id, pin); } catch (e) { toast(e.message); return; }
  S.access.pending = null;
  toast(`PIN reset. Tell ${m ? m.name : 'him'} the new PIN privately.`);
  await loadAccess();
}
async function removeMember(id) {
  try { await api.removeMember(id); } catch (e) { toast(e.message); return; }
  S.access.pending = null;
  toast('Brother removed');
  await loadAccess();
  await loadData();
}
async function setPublic(on) {
  try { S.settings = { ...S.settings, ...(await api.setPublic(on)) }; } catch (e) { toast(e.message); if (S.drawer) drawDrawer(false); return; }
  toast(S.settings.public ? 'The calendar is public. Captions, notes, and requests stay private.' : 'The calendar is for signed-in brothers only.');
  render();
}
async function setChapterCode(form) {
  const input = $('#gc-new-code', form);
  const code = input ? input.value.trim() : '';
  if (code.length < 6) return formError('Use a chapter code of at least 6 characters.', 'gc-new-code', 'gc-code-err');
  try { await withBusy(form, () => api.setChapterCode(code)); } catch (e) { return formError(e.message, 'gc-new-code', 'gc-code-err'); }
  input.value = '';
  const err = $('#gc-code-err', el.drawer);
  if (err) err.hidden = true;
  toast('Chapter code changed. Share the new code with brothers.');
}
async function demoRole(role) {
  api.setRole(role);
  if (S.drawer) closeDrawer();
  await refreshIdentity();
  await loadData();
  toast(role === 'staff' ? 'Viewing as the media team' : role === 'member' ? 'Viewing as a brother' : 'Viewing as a visitor');
}

document.addEventListener('submit', (e) => {
  const form = e.target;
  if (!form.closest || !form.closest('.gc')) return;
  e.preventDefault();
  const kind = form.dataset.kind;
  if (kind === 'post') submitPost(form);
  else if (kind === 'request') submitRequest(form);
  else if (kind === 'code') setChapterCode(form);
  else if (['join', 'rejoin', 'staff', 'claim'].includes(kind)) submitSignin(form);
});
document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.id === 'gc-quick-status') setPostStatus(t.dataset.id, t.value);
  else if (t.id === 'gc-f-program') { S.f.program = t.value; renderMain(); renderRail(); }
  else if (t.id === 'gc-f-status') { S.f.status = t.value; renderMain(); renderRail(); }
  else if (t.id === 'r-youth') { const row = $('#gc-releases-row', el.drawer); if (row) row.hidden = !t.checked; }
  else if (t.id === 'gc-set-public') setPublic(t.checked);
});
document.addEventListener('input', (e) => {
  if (e.target.id === 'r-date') updateLeadHint();
});
let qTimer = 0;
el.q.addEventListener('input', () => { clearTimeout(qTimer); qTimer = setTimeout(() => { S.f.q = el.q.value; renderMain(); renderRail(); }, 140); });
el.scrim.addEventListener('click', closeDrawer);
document.addEventListener('keydown', (e) => {
  if (!S.drawer) return;
  if (e.key === 'Escape') { e.preventDefault(); closeDrawer(); return; }
  if (e.key === 'Tab') {
    const f = [...el.drawer.querySelectorAll('button,input,select,textarea,a[href],[tabindex]:not([tabindex="-1"])')].filter((x) => !x.disabled && x.offsetParent !== null);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
});
let lastNarrow = narrow();
window.addEventListener('resize', () => { const n = narrow(); if (n !== lastNarrow) { lastNarrow = n; if (S.view === 'calendar') renderMain(); } });

// The site's nav is fixed; keep the page below it and the toolbar stuck just under it.
function watchNav() {
  const nav = document.getElementById('main-nav');
  if (!nav) return;
  const set = () => document.documentElement.style.setProperty('--nav-h', `${Math.ceil(nav.getBoundingClientRect().height)}px`);
  set();
  if ('ResizeObserver' in window) new ResizeObserver(set).observe(nav, { box: 'border-box' });
  else window.addEventListener('resize', set);
}

// ---------------------------------------------------------------- loading
async function refreshIdentity() {
  const [settings, me] = await Promise.all([api.settings(), api.whoami()]);
  S.settings = { public: !!(settings && settings.public), ready: !settings || settings.ready !== false };
  S.me = me && me.role ? me : { role: 'visitor' };
  S.role = S.me.role === 'staff' || S.me.role === 'member' ? S.me.role : 'visitor';
  S.account = api.account ? api.account() : null;
  if (S.role === 'member') { store.set('was-member', true); store.set('last-name', S.me.name); }
  if (S.role === 'staff') store.del('was-member');
}

async function loadData() {
  const jobs = [];
  if (canSeePosts()) jobs.push(api.posts({ full: signedIn() }).then((rows) => setPosts(rows)));
  else setPosts([], false);
  if (signedIn()) jobs.push(api.requests().then((rows) => setRequests(rows)));
  else setRequests([], false);
  try {
    await Promise.all(jobs);
    S.loadError = '';
  } catch (e) {
    S.loadError = e.message || 'The calendar could not load.';
  }
  render();
  refreshDrawer();
}

// A brother's name can sign in on one device at a time. When this device lost it, say so once.
function noticeSignedOut() {
  store.del('was-member');
  S.signin = { mode: 'rejoin', note: 'You were signed out on this device, most likely because your name signed in on another phone or computer. Sign in again with your name and PIN.', done: '' };
}

let lastRefresh = 0;
async function quietRefresh(force) {
  if (S.role === 'loading' || S.bootError || S.refreshing) return;
  if (!force && Date.now() - lastRefresh < 30000) return;
  if (S.drawer && (S.drawer.type === 'signin' || S.drawer.type === 'post-edit' || S.drawer.type.startsWith('request-'))) return;
  S.refreshing = true;
  lastRefresh = Date.now();
  try {
    const before = S.role;
    await refreshIdentity();
    if (before === 'member' && S.role === 'visitor') {
      noticeSignedOut();
      if (S.drawer) closeDrawer();
      toast('You were signed out on this device.');
    }
    await loadData();
  } catch (e) {
    console.warn('Calendar refresh failed', e);
  } finally {
    S.refreshing = false;
  }
}

async function boot() {
  buildFilters();
  watchNav();
  render();
  try {
    await api.init();
    await refreshIdentity();
  } catch (e) {
    S.bootError = e.message || 'Check your connection.';
    S.role = 'visitor';
    render();
    return;
  }
  if (S.role === 'visitor' && store.get('was-member', false)) noticeSignedOut();
  render();
  await loadData();
  lastRefresh = Date.now();
  setInterval(() => { if (!document.hidden) quietRefresh(true); }, 120000);
  window.addEventListener('focus', () => quietRefresh(false));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) quietRefresh(false); });
  if (S.signin.note && S.role === 'visitor') toast('You were signed out on this device.');
}

boot();
