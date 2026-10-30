// GIL brother directory: the page behind directory.html.
// Renders the directory, celebrations, each brother's own record, and the media team's messages
// and manage views, plus the drawers for a brother's details, sign-in, and editing. With Supabase
// settings in assets/calendar/config.js it runs live (api-live.js); without them it runs the demo
// (api-demo.js), which keeps everything in this browser.
import {
  STATUSES, STATUS, PLACEHOLDERS, DEFAULTS, parse, iso, todayISO, clean, fmtPhone, fullName, plural, yearsBetween, sameDay,
  nextOccurrence, render as renderTemplate, checkFields, checkDates, parseCsv, rowsFromSheet, toCsv
} from './rules.js';
import { LiveApi } from './api-live.js';
import { DemoApi } from './api-demo.js';

const config = window.GIL_CALENDAR_CONFIG || {};
const api = config.supabaseUrl && config.supabaseKey ? new LiveApi(config) : new DemoApi();
const DEMO = api.mode === 'demo';
const CONTACT = 'Bro. Eugene Aiken, Associate Editor of the Sphinx';

const ICON = {
  close: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  plus: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  down: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M12 4v11m0 0l-4.5-4.5M12 15l4.5-4.5M5 19.5h14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>'
};

// ---------------------------------------------------------------- helpers
const $ = (s, root = document) => root.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (s, o) => { const d = parse(s); return d ? d.toLocaleDateString('en-US', o) : ''; };
const longDate = (s) => fmt(s, { month: 'long', day: 'numeric', year: 'numeric' });
const shortDate = (s) => fmt(s, { month: 'short', day: 'numeric', year: 'numeric' });
const monthDay = (s) => fmt(s, { month: 'long', day: 'numeric' });
const mdOf = (md) => (md ? fmt(`2000-${md}`, { month: 'long', day: 'numeric' }) : '');
const localDateOf = (ts) => { const d = new Date(ts); return ts && !isNaN(d) ? iso(d) : ''; };
const whenText = (ts) => (ts ? new Date(ts).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');
const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const store = {
  get(k, d) { try { const v = localStorage.getItem(`gildir:${k}`); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(`gildir:${k}`, JSON.stringify(v)); } catch { /* ignore */ } }
};
const hashView = (location.hash || '').replace('#', '');
const wantsSignin = hashView === 'signin';
const FILTERS = [
  { key: 'all', label: 'Everyone' }, { key: 'current', label: 'Current' }, { key: 'life', label: 'Life members' },
  { key: 'not-current', label: 'Not current' }, { key: 'deceased', label: 'Omega Chapter' }, { key: 'unclaimed', label: 'Not claimed yet' }
];

// ---------------------------------------------------------------- state
const S = {
  role: 'visitor', me: null, account: null, settings: { ready: true, email_ready: false },
  list: [], byId: new Map(), loaded: false, mine: null, loadError: '',
  view: ['directory', 'celebrations', 'me', 'messages', 'manage', 'guide'].includes(hashView) ? hashView : 'directory',
  q: '', filter: 'all',
  drawer: null,
  signin: { mode: store.get('last-name', '') ? 'rejoin' : 'join', note: '', done: '' },
  claim: { q: '', pick: null, adding: false },
  msgs: { log: null, error: '', preview: null, busy: '' },
  manage: { members: null, importing: null },
  formErr: ''
};
const isStaff = () => S.role === 'staff';
const signedIn = () => S.role === 'staff' || S.role === 'chair' || S.role === 'member';
const isBrother = () => S.role === 'chair' || S.role === 'member';

const el = {
  demo: $('#gc-demo'), actions: $('#gc-actions'), count: $('#gc-count'), tabs: $('#gc-tabs'), search: $('#gc-search'), q: $('#gc-q'),
  filters: $('#gc-filters'), cats: $('#gc-cats'), layout: $('#gc-layout'), view: $('#gc-view'), rail: $('#gc-rail'),
  scrim: $('#gc-scrim'), drawer: $('#gc-drawer'), toast: $('#gc-toast'), meBadge: $('#gc-me-badge'), pendingBadge: $('#gc-pending-badge')
};

function setList(rows) {
  S.list = rows || [];
  S.byId = new Map(S.list.map((b) => [b.id, b]));
  S.loaded = true;
}

// ---------------------------------------------------------------- shared bits
const pill = (key, label) => `<span class="pill s-${esc(key)}">${esc(label)}</span>`;
const statusPill = (b) => (b.status === 'current' ? '' : pill(b.status, STATUS[b.status].label));
const tagsOf = (b) => [statusPill(b), b.life_member ? pill('life', 'Life member') : '', b.pending ? pill('pending', 'Needs review') : ''].filter(Boolean).join('');
const crossedText = (b) => (b.crossing_date ? `Crossed ${shortDate(b.crossing_date)}${b.years != null ? ` · ${plural(b.years, 'year')}` : ''}` : '');

function emptyHTML(eyebrow, title, body, extra = '') {
  return `<div class="empty"><p class="eyebrow">${esc(eyebrow)}</p><h2>${esc(title)}</h2><p>${body}</p>${extra}</div>`;
}

function toast(msg) {
  el.toast.textContent = msg;
  el.toast.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { el.toast.hidden = true; }, 3200);
}

function formError(msg, focusId) {
  const err = $('#gc-form-err');
  if (err) { err.textContent = msg; err.hidden = false; }
  const f = focusId && $('#' + focusId);
  if (f) f.focus();
  return false;
}

async function withBusy(form, fn) {
  const btns = [...form.querySelectorAll('button')];
  btns.forEach((b) => { b.disabled = true; });
  try { return await fn(); } finally { btns.forEach((b) => { b.disabled = false; }); }
}

// ---------------------------------------------------------------- shell
function renderDemoBar() {
  if (!DEMO) { el.demo.hidden = true; return; }
  const role = api.role;
  const seg = (k, l) => `<button class="seg" data-act="demo-role" data-role="${k}" aria-pressed="${role === k}">${l}</button>`;
  el.demo.hidden = false;
  el.demo.innerHTML = `<div class="wrap demo-row"><p><b>Demo</b>Sample brothers, saved in this browser only. Nothing here is real.</p>
    <div class="demo-ctl"><span>View as</span>${seg('staff', 'Media team')}${seg('member', 'Brother')}${seg('visitor', 'Visitor')}<button class="btn small quiet" data-act="demo-reset">Reset demo</button></div></div>`;
}

function renderShell() {
  let a = '';
  if (isStaff()) {
    a = `<span class="who">Media team: <b>${esc(S.me.name)}</b></span><button class="btn small quiet" data-act="signout">Sign out</button>`;
  } else if (isBrother()) {
    a = `<span class="who">Signed in as <b>${esc(S.me.name)}</b></span><button class="btn small quiet" data-act="signout">Sign out</button>`;
  } else if (S.account && !S.account.anonymous) {
    a = '<button class="btn primary" data-act="signin" data-mode="staff">Finish media team sign-in</button><button class="btn quiet" data-act="signout">Sign out</button>';
  } else {
    a = '<button class="btn primary" data-act="signin">Sign in</button>';
  }
  if (isStaff()) a += `<button class="btn" data-act="add">${ICON.plus}Add a brother</button>`;
  el.actions.innerHTML = a;
  el.count.innerHTML = S.loaded ? `<span class="countdown"><b>${S.list.filter((b) => b.status === 'current').length}</b> current brothers · <b>${S.list.length}</b> on the roll</span>` : '';

  for (const t of el.tabs.querySelectorAll('.tab')) {
    const v = t.dataset.view;
    t.setAttribute('aria-selected', v === S.view);
    if (v === 'messages' || v === 'manage') t.hidden = !isStaff();
    if (v === 'me') t.hidden = !isBrother();
    if (v === 'celebrations') t.hidden = !signedIn();
  }
  const pending = isStaff() ? S.list.filter((b) => b.pending).length : 0;
  el.pendingBadge.hidden = !pending; el.pendingBadge.textContent = pending;
  el.meBadge.hidden = !(isBrother() && S.loaded && !S.mine); el.meBadge.textContent = '!';
  const showFilters = S.view === 'directory' && signedIn();
  el.search.hidden = !showFilters; el.filters.hidden = !showFilters;
  if (showFilters) {
    const counts = Object.fromEntries(FILTERS.map((f) => [f.key, S.list.filter((b) => matchFilter(b, f.key)).length]));
    el.cats.innerHTML = FILTERS.filter((f) => f.key === 'all' || counts[f.key]).map((f) => `<button class="cat-toggle" data-act="filter" data-filter="${f.key}" aria-pressed="${S.filter === f.key}">${esc(f.label)} <span class="n">${counts[f.key]}</span></button>`).join('');
  }
}

function matchFilter(b, key) {
  if (key === 'all') return true;
  if (key === 'life') return b.life_member;
  if (key === 'unclaimed') return !b.claimed && b.status !== 'deceased';
  return b.status === key;
}

function visible() {
  const q = S.q.trim().toLowerCase();
  const qd = q.replace(/\D/g, '');
  return S.list.filter((b) => matchFilter(b, S.filter)).filter((b) => !q
    || `${b.first_name} ${b.last_name} ${b.suffix || ''} ${b.city || ''} ${b.initiation_chapter || ''} ${b.email || ''}`.toLowerCase().includes(q)
    || (qd.length >= 3 && (b.phone || '').includes(qd)));
}

function render() {
  renderDemoBar();
  renderShell();
  renderMain();
  renderRail();
  if (S.drawer) drawDrawer(false);
}

function renderMain() {
  if (S.loadError) {
    el.view.innerHTML = emptyHTML('Something is off', 'The directory could not load', esc(S.loadError), '<div class="btns"><button class="btn primary" data-act="reload">Try again</button></div>');
    el.layout.classList.add('solo');
    return;
  }
  if (!signedIn() && S.view !== 'guide') {
    el.view.innerHTML = emptyHTML('Brothers only', 'Sign in to see the directory',
      `The directory is for brothers of Gamma Iota Lambda. Sign in with the chapter code the first time, then with your name and PIN, the same way as the content calendar. Ask ${esc(CONTACT)} for the code.`,
      '<div class="btns"><button class="btn primary" data-act="signin">Sign in</button><button class="btn" data-act="view" data-view="guide">How it works</button></div>');
    el.layout.classList.add('solo');
    return;
  }
  el.layout.classList.toggle('solo', S.view !== 'directory');
  if (S.view === 'directory') renderDirectory();
  else if (S.view === 'celebrations') renderCelebrations();
  else if (S.view === 'me') renderMe();
  else if (S.view === 'messages') renderMessages();
  else if (S.view === 'manage') renderManage();
  else renderGuide();
}

// ---------------------------------------------------------------- directory
function broCard(b) {
  const mine = S.mine && S.mine.id === b.id;
  const lines = [];
  if (b.phone) lines.push(`<span><a href="tel:${esc(b.phone)}" data-stop>${esc(fmtPhone(b.phone))}</a></span>`);
  if (b.email) lines.push(`<span><a href="mailto:${esc(b.email)}" data-stop>${esc(b.email)}</a></span>`);
  if (b.city) lines.push(`<span>${esc([b.city, b.state].filter(Boolean).join(', '))}</span>`);
  if (crossedText(b)) lines.push(`<span>${esc(crossedText(b))}</span>`);
  if (b.birthday) lines.push(`<span>Birthday ${esc(mdOf(b.birthday))}</span>`);
  return `<button class="bro${mine ? ' mine' : ''}" data-act="open" data-id="${esc(b.id)}">
    <div class="bro-top"><span class="bro-name">${esc(fullName(b))}${b.initiation_chapter ? `<small>${esc(b.initiation_chapter)}</small>` : ''}${mine ? '<small>Your record</small>' : ''}</span></div>
    <div class="bro-lines">${lines.join('') || '<span class="muted">No details shared yet</span>'}</div>
    ${tagsOf(b) ? `<div class="tagrow">${tagsOf(b)}</div>` : ''}
  </button>`;
}

function renderDirectory() {
  if (!S.loaded) { el.view.innerHTML = '<p class="muted">Loading the directory.</p>'; return; }
  const rows = visible();
  if (!S.list.length) {
    el.view.innerHTML = emptyHTML('Empty', 'No brothers yet', isStaff() ? 'Import the chapter spreadsheet under Manage, or add brothers one at a time.' : 'The media team has not added the roll yet.',
      isStaff() ? '<div class="btns"><button class="btn primary" data-act="view" data-view="manage">Go to Manage</button></div>' : '');
    return;
  }
  el.view.innerHTML = `<div class="dirbar"><h2>Brothers <span>${rows.length === S.list.length ? S.list.length : `${rows.length} of ${S.list.length}`}</span></h2>
      ${isStaff() ? `<button class="btn small" data-act="export">${ICON.down}Download CSV</button>` : ''}</div>
    ${rows.length ? `<div class="bros">${rows.map(broCard).join('')}</div>`
      : emptyHTML('No matches', 'No brother matches that', 'Try another spelling, or clear the search and filters.', '<div class="btns"><button class="btn" data-act="clear">Clear</button></div>')}`;
}

// Birthdays and anniversaries in the next days, from the directory list.
function upcoming(days) {
  const today = todayISO();
  const end = parse(today); end.setDate(end.getDate() + days);
  const endISO = iso(end);
  const out = [];
  for (const b of S.list) {
    if (b.status === 'deceased') continue;
    const bd = b.birthday ? `2000-${b.birthday}` : (b.birth_date || '');
    if (bd) { const d = nextOccurrence(bd, today); if (d && d <= endISO) out.push({ day: d, kind: 'birthday', b }); }
    if (b.crossing_date) {
      const d = nextOccurrence(b.crossing_date, today);
      const years = d ? yearsBetween(b.crossing_date, d) : 0;
      if (d && d <= endISO && years >= 1) out.push({ day: d, kind: 'anniversary', b, years });
    }
  }
  return out.sort((x, y) => x.day.localeCompare(y.day) || x.kind.localeCompare(y.kind) || x.b.last_name.localeCompare(y.b.last_name));
}

function celRow(c) {
  const today = c.day === todayISO();
  const d = parse(c.day);
  const mail = isStaff() ? (c.b.email && c.b.greetings !== false ? 'Email goes out' : c.b.email ? 'Asked for no email' : 'No email on file') : '';
  return `<div class="cel${today ? ' today' : ''}">
    <div class="when"><span class="wd">${esc(d.toLocaleDateString('en-US', { month: 'short' }))}</span><span class="dn">${d.getDate()}</span></div>
    <div class="what"><span class="ttl"><button type="button" data-act="open" data-id="${esc(c.b.id)}">${esc(fullName(c.b))}</button></span>
      <span class="meta">${c.kind === 'birthday' ? pill('birthday', 'Birthday') : pill('anniversary', `${plural(c.years, 'year')} in Alpha`)}${c.kind === 'anniversary' ? `<span>crossed ${esc(shortDate(c.b.crossing_date))}</span>` : ''}${today ? '<span>today</span>' : ''}</span></div>
    ${mail ? `<span class="mail">${esc(mail)}</span>` : ''}</div>`;
}

function renderCelebrations() {
  if (!S.loaded) { el.view.innerHTML = '<p class="muted">Loading.</p>'; return; }
  const list = upcoming(90);
  const months = new Map();
  for (const c of list) { const k = c.day.slice(0, 7); if (!months.has(k)) months.set(k, []); months.get(k).push(c); }
  const missing = S.list.filter((b) => b.status !== 'deceased' && !(b.birthday || b.birth_date)).length;
  el.view.innerHTML = `<div class="celbar sectionhead"><h2>Celebrations</h2><span class="muted">The next 90 days</span></div>
    <p class="muted" style="margin:0 0 14px">Birthdays and crossing anniversaries from the directory. ${missing ? `${plural(missing, 'brother')} ${missing === 1 ? 'has' : 'have'} no birthday on file yet; they can add it under My record.` : ''}</p>
    ${list.length ? [...months].map(([k, rows]) => `<h3 class="mhead">${esc(fmt(`${k}-01`, { month: 'long', year: 'numeric' }))}</h3><div class="list">${rows.map(celRow).join('')}</div>`).join('')
      : emptyHTML('Quiet', 'Nothing in the next 90 days', 'As brothers add their birthdays and crossing dates, they show up here.')}`;
}

// ---------------------------------------------------------------- my record
const fieldHTML = (id, label, control, hint = '', required = false) => `<div class="field"><label for="${id}">${esc(label)}${required ? ' <span class="req-mark">*</span>' : ''}</label>${control}${hint ? `<p class="hint">${hint}</p>` : ''}</div>`;
const inputHTML = (id, type, value, attrs = '') => `<input id="${id}" name="${id}" type="${type}" value="${esc(value || '')}" ${attrs}>`;
const areaHTML = (id, value, attrs = '') => `<textarea id="${id}" name="${id}" ${attrs}>${esc(value || '')}</textarea>`;
const selectHTML = (id, opts, value, attrs = '') => `<select id="${id}" name="${id}" ${attrs}>${opts.map((o) => `<option value="${esc(o.key)}"${o.key === value ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}</select>`;
const switchHTML = (id, checked, label, small) => `<label class="switch"><input type="checkbox" id="${id}" name="${id}"${checked ? ' checked' : ''}><span>${esc(label)}${small ? `<small>${esc(small)}</small>` : ''}</span></label>`;

// The fields a brother edits on his own record; the media team's form adds standing and notes.
function recordFields(b, all) {
  const v = (k) => (b && b[k] != null ? b[k] : '');
  return `<fieldset class="fs"><legend>Name</legend>
      <div class="grid3">${fieldHTML('f-first_name', 'First name', inputHTML('f-first_name', 'text', v('first_name'), 'required maxlength="60" autocomplete="given-name"'), '', true)}
      ${fieldHTML('f-middle_name', 'Middle', inputHTML('f-middle_name', 'text', v('middle_name'), 'maxlength="60" autocomplete="additional-name"'))}
      ${fieldHTML('f-suffix', 'Suffix', inputHTML('f-suffix', 'text', v('suffix'), 'maxlength="10" placeholder="Jr., III"'))}</div>
      ${fieldHTML('f-last_name', 'Last name', inputHTML('f-last_name', 'text', v('last_name'), 'required maxlength="60" autocomplete="family-name"'), '', true)}
    </fieldset>
    <fieldset class="fs"><legend>Contact</legend>
      ${fieldHTML('f-email', 'Email', inputHTML('f-email', 'email', v('email'), 'autocomplete="email"'), 'Birthday and anniversary notes from the chapter come here.')}
      <div class="grid2">${fieldHTML('f-phone', 'Phone', inputHTML('f-phone', 'tel', fmtPhone(v('phone')), 'autocomplete="tel"'), 'Also how you claim your record on a new device: the last four digits.')}
      ${fieldHTML('f-phone_alt', 'Second phone', inputHTML('f-phone_alt', 'tel', fmtPhone(v('phone_alt'))))}</div>
    </fieldset>
    <fieldset class="fs"><legend>Address</legend>
      ${fieldHTML('f-address', 'Street', inputHTML('f-address', 'text', v('address'), 'maxlength="160" autocomplete="street-address"'))}
      <div class="grid3">${fieldHTML('f-city', 'City', inputHTML('f-city', 'text', v('city'), 'maxlength="80" autocomplete="address-level2"'))}
      ${fieldHTML('f-state', 'State', inputHTML('f-state', 'text', v('state'), 'maxlength="2" placeholder="NY" autocomplete="address-level1"'))}
      ${fieldHTML('f-zip', 'ZIP', inputHTML('f-zip', 'text', v('zip'), 'inputmode="numeric" maxlength="5" autocomplete="postal-code"'))}</div>
    </fieldset>
    <fieldset class="fs"><legend>In Alpha</legend>
      <div class="grid2">${fieldHTML('f-crossing_date', 'Crossing date', inputHTML('f-crossing_date', 'date', v('crossing_date'), 'min="1906-12-04"'), 'The day you were initiated.')}
      ${fieldHTML('f-birth_date', 'Birthdate', inputHTML('f-birth_date', 'date', v('birth_date'), 'min="1900-01-01"'), 'Brothers see the month and day only.')}</div>
      ${fieldHTML('f-initiation_chapter', 'Chapter of initiation', inputHTML('f-initiation_chapter', 'text', v('initiation_chapter'), 'maxlength="80" placeholder="Gamma Iota Lambda"'))}
    </fieldset>
    <fieldset class="fs"><legend>Emergency contact</legend>
      <div class="grid2">${fieldHTML('f-emergency_contact_name', 'Name', inputHTML('f-emergency_contact_name', 'text', v('emergency_contact_name'), 'maxlength="80"'))}
      ${fieldHTML('f-emergency_contact_phone', 'Phone', inputHTML('f-emergency_contact_phone', 'tel', fmtPhone(v('emergency_contact_phone'))))}</div>
      <p class="hint m0">Seen only by you and the media team.</p>
    </fieldset>
    <fieldset class="fs"><legend>Choices</legend>
      ${switchHTML('f-share_contact', b ? b.share_contact !== false : true, 'Share my phone, email, and city with brothers', 'Your street address, birth year, and emergency contact are never shown to other brothers.')}
      ${switchHTML('f-greetings', b ? b.greetings !== false : true, 'Email me on my birthday and my crossing anniversary', 'A short note from the chapter, sent the morning of.')}
    </fieldset>
    ${all ? `<fieldset class="fs"><legend>Media team</legend>
      <div class="grid3">${fieldHTML('f-status', 'Standing', selectHTML('f-status', STATUSES, v('status') || 'current'))}
      ${fieldHTML('f-life_member', 'Life member', selectHTML('f-life_member', [{ key: 'false', label: 'No' }, { key: 'true', label: 'Yes' }], String(!!v('life_member'))))}
      ${fieldHTML('f-active', 'Active in chapter life', selectHTML('f-active', [{ key: '', label: 'Not noted' }, { key: 'true', label: 'Active' }, { key: 'false', label: 'Inactive' }], b && b.active != null ? String(b.active) : ''))}</div>
      ${fieldHTML('f-notes', 'Notes', areaHTML('f-notes', v('notes'), 'maxlength="2000" class="ta-mid"'), 'For the media team only. Import notes about fixed or dropped values land here.')}
      ${b && b.pending ? switchHTML('f-pending', true, 'Still needs review', 'Turn off once the record is confirmed.') : ''}
    </fieldset>` : ''}`;
}

function readRecordForm(form, all) {
  const v = (k) => { const x = $('#f-' + k, form); return x ? x.value : undefined; };
  const c = (k) => { const x = $('#f-' + k, form); return x ? x.checked : undefined; };
  const input = {
    first_name: v('first_name'), middle_name: v('middle_name'), last_name: v('last_name'), suffix: v('suffix'), email: v('email'),
    phone: v('phone'), phone_alt: v('phone_alt'), address: v('address'), city: v('city'), state: v('state'), zip: v('zip'),
    crossing_date: v('crossing_date'), birth_date: v('birth_date'), initiation_chapter: v('initiation_chapter'),
    emergency_contact_name: v('emergency_contact_name'), emergency_contact_phone: v('emergency_contact_phone'),
    share_contact: c('share_contact'), greetings: c('greetings')
  };
  if (all) {
    Object.assign(input, { status: v('status'), life_member: v('life_member'), active: v('active'), notes: v('notes') });
    if ($('#f-pending', form)) input.pending = c('pending');
  }
  return input;
}

function renderMe() {
  if (!S.loaded) { el.view.innerHTML = '<p class="muted">Loading.</p>'; return; }
  if (S.mine) {
    el.view.innerHTML = `<form class="mycard" id="gc-form" data-kind="me" novalidate>
      <div><p class="eyebrow">Your record</p><h2>${esc(fullName(S.mine))}</h2>
      <p class="muted m0 mt8">Keep this current and the chapter can reach you. ${S.mine.pending ? 'The media team will confirm your record at the next meeting.' : ''}</p></div>
      ${recordFields(S.mine, false)}
      <p class="err" id="gc-form-err" role="alert" hidden></p>
      <div class="formfoot"><span class="muted" style="font-size:12.5px">Last updated ${esc(whenText(S.mine.updated_at))}</span><span class="spacer"></span><button type="submit" class="btn primary">Save my record</button></div>
    </form>`;
    return;
  }
  // Not claimed yet: find the record, or add one.
  const C = S.claim;
  const q = (C.q || S.me.name || '').trim().toLowerCase();
  const parts = q.split(/\s+/).filter(Boolean);
  const candidates = S.list.filter((b) => !b.claimed && b.status !== 'deceased')
    .filter((b) => !parts.length || parts.some((p) => b.last_name.toLowerCase().startsWith(p) || b.first_name.toLowerCase().startsWith(p)))
    .slice(0, 12);
  if (C.pick && S.byId.get(C.pick)) {
    const b = S.byId.get(C.pick);
    el.view.innerHTML = `<form class="mycard" id="gc-form" data-kind="claim-record" novalidate>
      <div><p class="eyebrow">Claim your record</p><h2>${esc(fullName(b))}</h2>
      <p class="muted m0 mt8">To confirm it is you, enter the last four digits of the phone number the chapter has on file for you.</p></div>
      <div class="field"><label for="f-check">Last four digits of your phone</label><div class="pinbox"><input id="f-check" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="4" autocomplete="off" data-autofocus></div>
      <p class="hint">Number changed? Ask the media team to link the record to you instead.</p></div>
      <p class="err" id="gc-form-err" role="alert" hidden></p>
      <div class="formfoot"><button type="button" class="btn quiet" data-act="claim-back">Back</button><span class="spacer"></span><button type="submit" class="btn primary">This is me</button></div>
    </form>`;
    return;
  }
  if (C.adding) {
    el.view.innerHTML = `<form class="mycard" id="gc-form" data-kind="add-self" novalidate>
      <div><p class="eyebrow">Add yourself</p><h2>Your record</h2><p class="muted m0 mt8">Your record goes into the directory right away, marked for the media team to confirm.</p></div>
      ${recordFields({ first_name: (S.me.name || '').split(' ')[0], last_name: (S.me.name || '').split(' ').slice(1).join(' ') }, false)}
      <p class="err" id="gc-form-err" role="alert" hidden></p>
      <div class="formfoot"><button type="button" class="btn quiet" data-act="claim-back">Back</button><span class="spacer"></span><button type="submit" class="btn primary">Add my record</button></div>
    </form>`;
    return;
  }
  el.view.innerHTML = `<div class="mycard">
    <div><p class="eyebrow">One-time step</p><h2>Find your record</h2>
    <p class="muted m0 mt8">The chapter roll was loaded from the old spreadsheet. Pick your name, confirm it with the last four digits of your phone, and the record is yours to keep current.</p></div>
    <div class="field"><label for="gc-claim-q">Your name</label><input id="gc-claim-q" type="search" value="${esc(C.q || S.me.name || '')}" placeholder="Last name" autocomplete="off"></div>
    ${candidates.length ? `<div class="matches">${candidates.map((b) => `<button type="button" class="match" data-act="claim-pick" data-id="${esc(b.id)}"><b>${esc(fullName(b))}</b><span>${esc([b.city, crossedText(b)].filter(Boolean).join(' · ') || 'No details on file')}</span></button>`).join('')}</div>`
      : '<p class="muted m0">No unclaimed record matches that name.</p>'}
    <div class="formfoot"><span class="muted" style="font-size:13px">Not on the list?</span><span class="spacer"></span><button type="button" class="btn" data-act="claim-add">Add myself</button></div>
  </div>`;
}

// ---------------------------------------------------------------- messages (media team)
function renderMessages() {
  const M = S.msgs, s = S.settings;
  if (M.log === null && !M.error) loadMessages();
  const tmpl = (kind, label) => `<fieldset class="fs tmpl"><legend>${esc(label)}</legend>
    ${fieldHTML(`m-${kind}_subject`, 'Subject', inputHTML(`m-${kind}_subject`, 'text', s[`${kind}_subject`] || DEFAULTS[`${kind}_subject`], 'maxlength="200"'))}
    ${fieldHTML(`m-${kind}_text`, 'Message', areaHTML(`m-${kind}_text`, s[`${kind}_text`] || DEFAULTS[`${kind}_text`], 'maxlength="4000"'))}
    <div class="btnrow"><button type="button" class="btn small" data-act="m-preview" data-kind="${kind}">Preview</button><button type="button" class="btn small" data-act="m-test" data-kind="${kind}"${s.email_ready ? '' : ' disabled'}>Email me a test</button><button type="button" class="btn small quiet" data-act="m-default" data-kind="${kind}">Use the default</button></div>
    ${M.preview && M.preview.kind === kind ? `<div class="pv"><b>${esc(M.preview.subject)}</b><p>${esc(M.preview.text)}</p></div>` : ''}
  </fieldset>`;
  const logRows = (M.log || []).slice(0, 60);
  el.view.innerHTML = `<div class="cols">
    <form class="mycard" id="gc-form" data-kind="settings" novalidate>
      <div><p class="eyebrow">Greetings</p><h2>Birthday and anniversary emails</h2>
      <p class="muted m0 mt8">Every morning around 8:30 New York time, each brother with an email on file gets a note on his birthday and on the anniversary of his crossing. The media team gets a note the day before about who is up, so a post or a call can go out.</p></div>
      ${s.email_ready ? '' : '<p class="note">Email is not set up yet. Run <code>supabase/setup/2-request-emails.sql</code> once with the Resend key; the calendar\'s request emails use the same key.</p>'}
      <fieldset class="fs"><legend>Switches</legend>
        ${switchHTML('m-greetings_on', s.greetings_on !== false, 'Send greetings to brothers', 'Off pauses every birthday and anniversary email.')}
        ${switchHTML('m-digest_on', s.digest_on !== false, 'Email the media team the day before', 'Who is celebrating tomorrow, including brothers with no email on file.')}
        ${fieldHTML('m-from', 'Sender', inputHTML('m-from', 'text', s.from || '', 'placeholder="Gamma Iota Lambda <brothers@mail.gil1906.org>"'), 'An address at mail.gil1906.org, the domain Resend verified.')}
      </fieldset>
      ${tmpl('birthday', 'Birthday message')}
      ${tmpl('anniversary', 'Anniversary message')}
      <ul class="holders">${PLACEHOLDERS.map(([k, d]) => `<li><code>${esc(k)}</code> ${esc(d)}</li>`).join('')}</ul>
      <p class="err" id="gc-form-err" role="alert" hidden></p>
      <div class="formfoot"><button type="button" class="btn" data-act="m-run"${s.email_ready ? '' : ' disabled'}>Send today's now</button><span class="spacer"></span><button type="submit" class="btn primary">Save settings</button></div>
    </form>
    <div class="panel">
      <h3>Sent</h3>
      <p>${s.last_run ? `Last run ${esc(whenText(s.last_run))}.` : 'Nothing sent yet.'} The log keeps one line per email.</p>
      ${M.error ? `<p class="err">${esc(M.error)}</p>` : ''}
      ${M.log === null ? '<p class="muted m0">Loading.</p>' : logRows.length ? `<div class="rtable-wrap tall"><table class="rtable"><thead><tr><th>Day</th><th>Kind</th><th>To</th><th class="opt">Subject</th></tr></thead><tbody>
        ${logRows.map((m) => `<tr><td class="when-c">${esc(shortDate(m.day))}</td><td>${pill(m.kind, m.kind === 'digest' ? 'Media team' : m.kind[0].toUpperCase() + m.kind.slice(1))}</td><td>${m.brotherId && S.byId.get(m.brotherId) ? `<button type="button" class="btn link" data-act="open" data-id="${esc(m.brotherId)}">${esc(fullName(S.byId.get(m.brotherId)))}</button>` : esc(m.sentTo)}</td><td class="opt cap1">${esc(m.subject)}</td></tr>`).join('')}
      </tbody></table></div>` : '<p class="muted m0">No emails yet.</p>'}
    </div>
  </div>`;
}

async function loadMessages() {
  try { S.msgs.log = await api.messages(); S.msgs.error = ''; } catch (e) { S.msgs.log = []; S.msgs.error = e.message; }
  if (S.view === 'messages') renderMessages();
}

// ---------------------------------------------------------------- manage (media team)
function renderManage() {
  const M = S.manage;
  if (M.members === null) loadMembers();
  const pending = S.list.filter((b) => b.pending);
  const unclaimed = S.list.filter((b) => !b.claimed && b.status !== 'deceased');
  const claimed = S.list.filter((b) => b.claimed);
  const linkedIds = new Set(claimed.map((b) => b.member_id));
  const free = (M.members || []).filter((m) => !linkedIds.has(m.id));
  const imp = M.importing;
  el.view.innerHTML = `<div class="cols">
    <div class="mycard">
      <div><p class="eyebrow">Roll</p><h2>Import a spreadsheet</h2>
      <p class="muted m0 mt8">A CSV with one brother per row. The columns of the old chapter database work as they are (Last Name, First Name, Current Bros, Life, E-Mail, Address, City,State, Phone, Birthdate, Crossing Date, Emergency Contact, Phone number), and so do the columns of the CSV this page downloads. Rows whose names match a brother already here update that record; the rest are added.</p></div>
      <div class="drop"><input type="file" id="gc-import" accept=".csv,text/csv"><p class="hint">Dates read as 3/23/2024 or 2024-03-23. A birthdate that would make a brother a minor when he crossed is left out and noted, since the old sheet held entry dates in that column.</p></div>
      ${imp ? `<div class="pv"><b>${imp.rows.length} ${imp.rows.length === 1 ? 'row' : 'rows'} ready${imp.unknown.length ? ` · columns not understood: ${esc(imp.unknown.join(', '))}` : ''}</b>
        ${imp.notes.length ? `<p>${esc(imp.notes.slice(0, 12).map(([n, t]) => `${n}: ${t}`).join('\n'))}${imp.notes.length > 12 ? `\nand ${imp.notes.length - 12} more; each is saved in that brother's notes` : ''}</p>` : '<p>Nothing needed fixing.</p>'}
        ${imp.result ? `<p><b>Done: ${imp.result.added} added, ${imp.result.updated} updated.</b></p>` : `<div class="btnrow mt8"><button type="button" class="btn primary" data-act="import-go">Import ${imp.rows.length}</button><button type="button" class="btn quiet" data-act="import-cancel">Cancel</button></div>`}
        ${imp.error ? `<p class="err">${esc(imp.error)}</p>` : ''}</div>` : ''}
      <div class="btnrow"><button type="button" class="btn" data-act="export">${ICON.down}Download the directory as CSV</button><button type="button" class="btn" data-act="add">${ICON.plus}Add a brother</button></div>
    </div>
    <div class="rail">
      <div class="panel"><h3>Needs review</h3>
        ${pending.length ? `<div class="people">${pending.map((b) => `<div class="person"><div class="person-top"><span class="person-name">${esc(fullName(b))}</span>${pill('pending', 'Added himself')}</div><span class="person-meta">${esc([b.phone && fmtPhone(b.phone), b.email, whenText(b.created_at)].filter(Boolean).join(' · '))}</span><div class="person-act"><button type="button" class="btn small primary" data-act="confirm" data-id="${esc(b.id)}">Confirm</button><button type="button" class="btn small" data-act="edit" data-id="${esc(b.id)}">Edit</button></div></div>`).join('')}</div>` : '<p class="m0">Nothing waiting. Brothers who add themselves show up here.</p>'}
      </div>
      <div class="panel"><h3>Sign-ins</h3>
        <p>${claimed.length} of ${S.list.filter((b) => b.status !== 'deceased').length} records claimed. A brother claims his own with the last four digits of his phone; link one here when his number changed or there is none on file.</p>
        ${free.length ? `<div class="linkrow"><label class="sr" for="gc-link-member">Sign-in</label><select id="gc-link-member"><option value="">Choose a sign-in</option>${free.map((m) => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join('')}</select>
          <label class="sr" for="gc-link-record">Record</label><select id="gc-link-record"><option value="">Choose a record</option>${unclaimed.map((b) => `<option value="${esc(b.id)}">${esc(fullName(b))}</option>`).join('')}</select>
          <button type="button" class="btn small primary" data-act="link-go">Link</button></div>` : M.members === null ? '<p class="muted m0">Loading sign-ins.</p>' : '<p class="muted m0">Every sign-in is linked to a record.</p>'}
      </div>
      <div class="panel"><h3>Numbers</h3>
        <div class="stats"><div class="stat"><b>${S.list.filter((b) => b.status === 'current').length}</b><span>current</span></div><div class="stat"><b>${S.list.filter((b) => b.life_member).length}</b><span>life members</span></div>
        <div class="stat"><b>${S.list.filter((b) => b.email).length}</b><span>with an email</span></div><div class="stat"><b>${S.list.filter((b) => b.birth_date).length}</b><span>with a birthdate</span></div></div>
        <p class="m0">Greetings reach only brothers with an email and a date on file. Asking brothers to claim their records fills both in.</p>
      </div>
    </div>
  </div>`;
}

async function loadMembers() {
  try { S.manage.members = await api.memberList(); } catch { S.manage.members = []; }
  if (S.view === 'manage') renderManage();
}

function exportCsv() {
  const rows = S.list.map((b) => ({ ...b, life_member: b.life_member ? 'yes' : 'no', share_contact: b.share_contact === false ? 'no' : 'yes', greetings: b.greetings === false ? 'no' : 'yes', pending: b.pending ? 'yes' : 'no', active: b.active == null ? '' : b.active ? 'yes' : 'no' }));
  const blob = new Blob([toCsv(rows)], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `gil-directory-${todayISO()}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function readImport(file) {
  if (!file) return;
  const text = await file.text();
  const { rows, notes, unknown } = rowsFromSheet(parseCsv(text));
  S.manage.importing = rows.length ? { rows, notes, unknown, result: null, error: '' } : { rows: [], notes: [], unknown, result: null, error: 'No rows with a name were found. The first row needs column headers.' };
  renderManage();
}

async function runImport() {
  const imp = S.manage.importing;
  if (!imp || !imp.rows.length) return;
  try {
    imp.result = await api.importRows(imp.rows);
    await reload();
    toast(`Imported: ${imp.result.added} added, ${imp.result.updated} updated.`);
  } catch (e) { imp.error = e.message; renderManage(); }
}

// ---------------------------------------------------------------- guide
function renderGuide() {
  el.view.innerHTML = `<div class="guide">
    <h2>How the directory works</h2>
    <div>
      <h3>For brothers</h3>
      <ol>
        <li><b>Sign in</b> with the chapter code the first time (your first and last name, and a PIN of 4 to 6 digits), then with your name and PIN. It is the same sign-in as the content calendar: one covers both.</li>
        <li><b>Claim your record</b> under My record. Pick your name and confirm it with the last four digits of the phone number the chapter has on file. If your number changed, the media team links the record for you.</li>
        <li><b>Keep it current.</b> Email, phones, address, crossing date, birthdate, chapter of initiation, and an emergency contact. Change it any time.</li>
        <li><b>Choose what brothers see.</b> Everyone sees your name, standing, crossing date, and birthday (month and day). Phone, email, and city show only if you share them. Your street address, birth year, and emergency contact are for you and the media team only.</li>
      </ol>
      <h3 class="mt-gap">Birthday and anniversary notes</h3>
      <p>On your birthday and on the anniversary of your crossing, the chapter sends a short email in the morning. Add your email and dates to get them; turn them off under My record if you would rather not.</p>
    </div>
    <div>
      <h3>For the media team</h3>
      <ul>
        <li><b>Manage</b> imports the chapter spreadsheet, downloads the directory as CSV, confirms brothers who added themselves, and links sign-ins to records.</li>
        <li><b>Any record</b> opens from the directory with Edit, where standing, life membership, and notes live too. Remove is there for duplicates.</li>
        <li><b>Messages</b> holds the switches, the sender, and the wording of both emails, a preview, a test to yourself, and the log of what went out. The media team also gets a note each day about tomorrow's celebrations, including brothers with no email on file.</li>
        <li><b>Privacy.</b> The database decides what each person can read. Brothers never see street addresses, birth years, emergency contacts, or notes, and nothing is public.</li>
      </ul>
      <h3 class="mt-gap">Standing</h3>
      <dl class="statuslist">${STATUSES.map((s) => `<dt>${pill(s.key, s.label)}</dt><dd>${esc(s.desc)}</dd>`).join('')}<dt>${pill('life', 'Life member')}</dt><dd>Life membership with the fraternity.</dd></dl>
    </div>
  </div>`;
}

// ---------------------------------------------------------------- rail
function renderRail() {
  if (S.view !== 'directory' || !signedIn() || S.loadError) { el.rail.innerHTML = ''; return; }
  const soon = upcoming(30).slice(0, 8);
  const noDate = S.list.filter((b) => b.status !== 'deceased' && !(b.birthday || b.birth_date)).length;
  el.rail.innerHTML = `${isBrother() && S.loaded && !S.mine ? '<div class="panel"><h3>Your record</h3><p>Claim your record once and keep your own details current.</p><button class="btn primary small" data-act="view" data-view="me">Find my record</button></div>' : ''}
    <div class="panel"><h3>Coming up</h3>
    ${soon.length ? `<ul class="up">${soon.map((c) => `<li><button data-act="open" data-id="${esc(c.b.id)}"><span class="ud">${esc(fmt(c.day, { month: 'short', day: 'numeric' }))}</span><span class="ut"><i class="dot" style="--c:${c.kind === 'birthday' ? 'var(--c-holiday)' : 'var(--s-posted)'}"></i>${esc(fullName(c.b))}${c.kind === 'anniversary' ? ` · ${c.years} yr${c.years === 1 ? '' : 's'}` : ''}</span></button></li>`).join('')}</ul>` : '<p>No birthdays or anniversaries in the next 30 days.</p>'}
    <button class="btn small mt8" data-act="view" data-view="celebrations">All celebrations</button></div>
    <div class="panel"><h3>The roll</h3>
    <div class="stats"><div class="stat"><b>${S.list.filter((b) => b.status === 'current').length}</b><span>current</span></div><div class="stat"><b>${S.list.filter((b) => b.life_member).length}</b><span>life members</span></div></div>
    ${noDate ? `<p>${plural(noDate, 'brother')} ${noDate === 1 ? 'has' : 'have'} no birthday on file. Claiming a record is how it gets added.</p>` : ''}
    <ul class="legend"><li><i class="dot" style="--c:var(--c-holiday)"></i>Birthday</li><li><i class="dot" style="--c:var(--s-posted)"></i>Crossing anniversary</li></ul></div>`;
}

// ---------------------------------------------------------------- drawers
function drawerHead(eyebrow, title) {
  return `<div class="dhead"><div><p class="eyebrow">${eyebrow}</p><h2 id="gc-drawer-title" tabindex="-1">${esc(title)}</h2></div><button type="button" class="iconbtn" data-act="close" aria-label="Close">${ICON.close}</button></div>`;
}

function openDrawer(type, data, trigger) {
  S.drawer = { type, data, trigger: trigger || document.activeElement };
  S.formErr = '';
  el.scrim.hidden = false; el.drawer.hidden = false;
  document.body.classList.add('gc-drawer-open');
  document.body.style.overflow = 'hidden';
  drawDrawer(true);
}

function closeDrawer() {
  if (!S.drawer) return;
  const t = S.drawer.trigger;
  S.drawer = null;
  el.scrim.hidden = true; el.drawer.hidden = true; el.drawer.innerHTML = '';
  document.body.classList.remove('gc-drawer-open');
  document.body.style.overflow = '';
  if (t && t.isConnected && typeof t.focus === 'function') t.focus();
}

function drawDrawer(focus) {
  const { type, data } = S.drawer;
  let html = '';
  if (type === 'brother') html = brotherView(S.byId.get(data));
  else if (type === 'edit') html = brotherForm(data ? S.byId.get(data) : null);
  else if (type === 'signin') html = signinView();
  if (!html) { closeDrawer(); return; }
  el.drawer.innerHTML = html;
  if (focus) {
    const target = el.drawer.querySelector('[data-autofocus]') || el.drawer.querySelector('#gc-drawer-title');
    if (target) target.focus();
  }
}

function brotherView(b) {
  if (!b) return '';
  const mine = S.mine && S.mine.id === b.id;
  const full = isStaff() || mine;
  const kv = [];
  const row = (k, v) => { if (v) kv.push(`<dt>${esc(k)}</dt><dd>${v}</dd>`); };
  row('Phone', b.phone ? `<a href="tel:${esc(b.phone)}">${esc(fmtPhone(b.phone))}</a>${b.phone_alt ? ` · <a href="tel:${esc(b.phone_alt)}">${esc(fmtPhone(b.phone_alt))}</a>` : ''}` : '');
  row('Email', b.email ? `<a href="mailto:${esc(b.email)}">${esc(b.email)}</a>` : '');
  row(full ? 'Address' : 'Lives in', full ? esc([b.address, [b.city, b.state].filter(Boolean).join(', '), b.zip].filter(Boolean).join(', ')) : esc([b.city, b.state].filter(Boolean).join(', ')));
  row('Crossed', b.crossing_date ? `${esc(longDate(b.crossing_date))}${b.years != null ? ` · ${plural(b.years, 'year')} in Alpha` : ''}` : '');
  row('Birthday', full && b.birth_date ? esc(longDate(b.birth_date)) : b.birthday ? esc(mdOf(b.birthday)) : '');
  row('Chapter of initiation', esc(b.initiation_chapter || ''));
  if (full) {
    row('Emergency contact', b.emergency_contact_name ? `${esc(b.emergency_contact_name)}${b.emergency_contact_phone ? ` · <a href="tel:${esc(b.emergency_contact_phone)}">${esc(fmtPhone(b.emergency_contact_phone))}</a>` : ''}` : '');
    row('Shares contact', b.share_contact === false ? 'No' : '');
    row('Greeting emails', b.greetings === false ? 'Off' : '');
    if (isStaff()) {
      row('Active', b.active == null ? '' : b.active ? 'Active in chapter life' : 'Inactive');
      row('Sign-in', b.claimed ? 'Claimed' : 'Not claimed yet');
      row('Updated', esc(whenText(b.updated_at)));
    }
  }
  const links = isStaff() && S.manage.members ? S.manage.members : null;
  let foot = '';
  if (mine) foot = '<button type="button" class="btn primary" data-act="view" data-view="me">Edit my record</button>';
  else if (isStaff()) {
    foot = `${b.claimed ? `<button type="button" class="btn small quiet" data-act="unlink" data-id="${esc(b.id)}">Unlink sign-in</button>` : ''}<span class="spacer"></span>
      <button type="button" class="btn danger" data-act="remove" data-id="${esc(b.id)}">Remove</button><button type="button" class="btn primary" data-act="edit" data-id="${esc(b.id)}">Edit</button>`;
    if (b.pending) foot = `<button type="button" class="btn" data-act="confirm" data-id="${esc(b.id)}">Confirm record</button>${foot}`;
  }
  return `<div class="dform">${drawerHead(tagsOf(b) || 'Brother', fullName(b))}
    <div class="dbody">
      ${kv.length ? `<dl class="kv wide">${kv.join('')}</dl>` : '<p class="muted m0">No details shared yet.</p>'}
      ${isStaff() && b.notes ? `<div class="block"><h4>Notes</h4><p class="notes">${esc(b.notes)}</p></div>` : ''}
      ${isStaff() && !b.claimed && links && links.length ? `<div class="block"><h4>Link to a sign-in</h4><div class="linkrow"><select id="gc-link-one"><option value="">Choose a sign-in</option>${links.filter((m) => !S.list.some((x) => x.member_id === m.id)).map((m) => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join('')}</select><button type="button" class="btn small" data-act="link-one" data-id="${esc(b.id)}">Link</button></div></div>` : ''}
      ${S.drawer.confirmRemove ? `<div class="confirm"><span>Remove ${esc(fullName(b))} from the directory?</span><button type="button" class="btn small quiet" data-act="remove-cancel">Keep</button><button type="button" class="btn small danger" data-act="remove-confirm" data-id="${esc(b.id)}">Remove</button></div>` : ''}
      <p class="err" id="gc-form-err" role="alert" hidden></p>
    </div>
    ${foot ? `<div class="dfoot">${foot}</div>` : ''}
  </div>`;
}

function brotherForm(b) {
  return `<form class="dform" id="gc-form" data-kind="${b ? 'edit' : 'add'}" data-id="${esc(b ? b.id : '')}" novalidate>
    ${drawerHead(b ? 'Edit' : 'Add a brother', b ? fullName(b) : 'New record')}
    <div class="dbody">${recordFields(b, true)}<p class="err" id="gc-form-err" role="alert" hidden></p></div>
    <div class="dfoot"><button type="button" class="btn quiet" data-act="${b ? 'open' : 'close'}" data-id="${esc(b ? b.id : '')}">Cancel</button><span class="spacer"></span><button type="submit" class="btn primary">${b ? 'Save' : 'Add'}</button></div>
  </form>`;
}

// Sign-in: the same flow as the calendar.
function signinView() {
  const mode = S.signin.mode;
  const modes = [['join', 'First time here'], ['rejoin', "I've signed in before"], ['staff', 'Media team']];
  const notReady = !DEMO && !S.settings.ready;
  let body = '', foot = '', kind = mode;
  if (mode === 'join') {
    body = `${notReady ? '<p class="note">Sign-in opens once the media team sets the chapter code.</p>' : ''}
      <p class="hint m0">One sign-in covers the directory and the content calendar. Already signed in to the calendar on this device? You are signed in here too.</p>
      ${fieldHTML('s-code', 'Chapter code', inputHTML('s-code', 'text', '', 'required autocomplete="off" autocapitalize="off" spellcheck="false" data-autofocus'), DEMO ? 'Demo: any code works.' : 'From the media team. You need it only this once.', true)}
      ${fieldHTML('s-name', 'Your name', inputHTML('s-name', 'text', '', 'required maxlength="40" autocomplete="name"'), 'First and last name, as the chapter knows you.', true)}
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

// ---------------------------------------------------------------- submits
async function submitForm(form) {
  const kind = form.dataset.kind;
  const v = (id) => String(($('#' + id, form) || {}).value || '').trim();
  try {
    if (['join', 'rejoin', 'staff', 'claim'].includes(kind)) return await submitSignin(form, kind, v);
    if (kind === 'me' || kind === 'add-self' || kind === 'edit' || kind === 'add') {
      const all = kind === 'edit' || kind === 'add';
      const input = readRecordForm(form, all);
      const { fields, error } = checkFields(input, all);
      if (error) return formError(error);
      const base = kind === 'me' ? S.mine : kind === 'edit' ? S.byId.get(form.dataset.id) : {};
      const dateErr = checkDates({ ...base, ...fields });
      if (dateErr) return formError(dateErr, 'f-crossing_date');
      const saved = await withBusy(form, () => kind === 'me' ? api.updateMe(fields) : kind === 'add-self' ? api.addSelf(fields) : api.save(form.dataset.id || null, fields));
      await reload();
      if (kind === 'me') toast('Your record is saved.');
      else if (kind === 'add-self') { S.claim.adding = false; toast('You are in the directory.'); }
      else { toast(kind === 'add' ? `${fullName(saved)} added.` : 'Saved.'); openDrawer('brother', saved.id, S.drawer && S.drawer.trigger); }
      return true;
    }
    if (kind === 'claim-record') {
      const check = v('f-check');
      if (!/^\d{4}$/.test(check)) return formError('Enter the last four digits of your phone number.', 'f-check');
      await withBusy(form, () => api.claim(S.claim.pick, check));
      S.claim.pick = null;
      await reload();
      toast('That record is yours now.');
      return true;
    }
    if (kind === 'settings') {
      const c = (id) => !!($('#' + id, form) || {}).checked;
      const fields = {
        greetings_on: c('m-greetings_on'), digest_on: c('m-digest_on'), from: v('m-from'),
        birthday_subject: v('m-birthday_subject'), birthday_text: ($('#m-birthday_text', form) || {}).value || '',
        anniversary_subject: v('m-anniversary_subject'), anniversary_text: ($('#m-anniversary_text', form) || {}).value || ''
      };
      S.settings = { ...S.settings, ...(await withBusy(form, () => api.setSettings(fields))) };
      S.msgs.preview = null;
      renderMessages();
      toast('Settings saved.');
      return true;
    }
  } catch (e) {
    return formError(e.message);
  }
  return false;
}

async function submitSignin(form, kind, v) {
  S.signin.done = '';
  if (kind === 'join') {
    const code = v('s-code'), name = v('s-name').replace(/\s+/g, ' '), pin = v('s-pin');
    if (!code) return formError('Enter the chapter code.', 's-code');
    if (name.length < 2 || name.length > 40) return formError('Use 2 to 40 characters for your name.', 's-name');
    if (!/^\d{4,6}$/.test(pin)) return formError('Your PIN must be 4 to 6 digits.', 's-pin');
    await withBusy(form, () => api.join({ code, name, pin }));
    store.set('last-name', name);
    return afterSignIn();
  }
  if (kind === 'rejoin') {
    const name = v('s-name').replace(/\s+/g, ' '), pin = v('s-pin');
    if (name.length < 2) return formError('Enter the name you used the first time.', 's-name');
    if (!/^\d{4,6}$/.test(pin)) return formError('Your PIN is 4 to 6 digits.', 's-pin');
    await withBusy(form, () => api.rejoin({ name, pin }));
    store.set('last-name', name);
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
  return false;
}

async function staffSignUp() {
  const form = $('#gc-form', el.drawer);
  if (!form) return;
  const email = String(($('#s-email', form) || {}).value || '').trim(), password = ($('#s-password', form) || {}).value || '';
  if (!/^\S+@\S+\.\S+$/.test(email)) return formError('Enter your email address.', 's-email');
  if (password.length < 8) return formError('Use a password of at least 8 characters.', 's-password');
  try {
    const res = await withBusy(form, () => api.staffSignUp(email, password));
    if (res && res.needsConfirm) { S.signin.done = 'Check your email for the confirmation link, then come back here and sign in.'; drawDrawer(false); return; }
    return afterStaffLogin();
  } catch (e) { return formError(e.message); }
}

async function afterStaffLogin() {
  await refreshIdentity();
  if (isStaff()) return afterSignIn();
  S.signin.mode = 'staff'; S.signin.note = '';
  drawDrawer(true);
}

async function afterSignIn() {
  await refreshIdentity();
  S.signin.note = ''; S.signin.done = '';
  closeDrawer();
  await reload();
  if (isBrother() && !S.mine) { S.view = 'me'; render(); }
  return true;
}

async function signOut() {
  closeDrawer();
  try { await api.signOut(); } catch { /* ignore */ }
  await refreshIdentity();
  setList([]); S.loaded = false; S.mine = null; S.view = 'directory';
  render();
}

// ---------------------------------------------------------------- loading
async function refreshIdentity() {
  try {
    S.me = await api.whoami();
    S.role = S.me.role || 'visitor';
    S.account = api.account();
    S.settings = { ...S.settings, ...(await api.settings()) };
  } catch (e) {
    S.me = { role: 'visitor' }; S.role = 'visitor'; S.account = api.account();
    S.loadError = e.message;
  }
}

async function reload() {
  if (!signedIn()) { setList([]); S.loaded = false; S.mine = null; render(); return; }
  try {
    const [list, mine, settings] = await Promise.all([api.list(), isBrother() ? api.me() : null, api.settings()]);
    setList(list);
    S.mine = mine;
    S.settings = { ...S.settings, ...settings };
    S.loadError = '';
    if (isStaff() && S.msgs.log !== null) loadMessages();
  } catch (e) {
    S.loadError = e.message;
  }
  render();
}

// ---------------------------------------------------------------- events
document.addEventListener('click', async (e) => {
  const stop = e.target.closest('[data-stop]');
  if (stop) { e.stopPropagation(); return; }
  const t = e.target.closest('[data-act]');
  if (!t) return;
  const act = t.dataset.act;
  try {
    switch (act) {
      case 'view': S.view = t.dataset.view; location.hash = S.view; closeDrawer(); render(); el.view.focus({ preventScroll: true }); break;
      case 'filter': S.filter = t.dataset.filter; render(); break;
      case 'clear': S.q = ''; S.filter = 'all'; el.q.value = ''; render(); break;
      case 'reload': S.loadError = ''; await refreshIdentity(); await reload(); break;
      case 'open': if (S.byId.get(t.dataset.id)) openDrawer('brother', t.dataset.id, t); break;
      case 'close': closeDrawer(); break;
      case 'signin': S.signin.done = ''; if (t.dataset.mode) S.signin.mode = t.dataset.mode; openDrawer('signin', null, t); break;
      case 'signin-mode': S.signin.mode = t.dataset.mode; S.signin.done = ''; drawDrawer(false); { const b = el.drawer.querySelector(`[data-mode="${t.dataset.mode}"]`); if (b) b.focus(); } break;
      case 'staff-signup': await staffSignUp(); break;
      case 'signout': await signOut(); break;
      case 'demo-role': api.setRole(t.dataset.role); closeDrawer(); await refreshIdentity(); S.manage.members = null; S.msgs.log = null; await reload(); break;
      case 'demo-reset': api.resetDemo(); S.manage.members = null; S.msgs.log = null; await reload(); toast('Demo reset.'); break;
      case 'claim-pick': S.claim.pick = t.dataset.id; S.claim.adding = false; render(); { const f = $('#f-check'); if (f) f.focus(); } break;
      case 'claim-back': S.claim.pick = null; S.claim.adding = false; render(); break;
      case 'claim-add': S.claim.adding = true; S.claim.pick = null; render(); break;
      case 'add': openDrawer('edit', null, t); break;
      case 'edit': openDrawer('edit', t.dataset.id, S.drawer ? S.drawer.trigger : t); break;
      case 'confirm': await api.save(t.dataset.id, { pending: false }); await reload(); toast('Confirmed.'); if (S.drawer && S.drawer.type === 'brother') drawDrawer(false); break;
      case 'remove': S.drawer.confirmRemove = true; drawDrawer(false); break;
      case 'remove-cancel': S.drawer.confirmRemove = false; drawDrawer(false); break;
      case 'remove-confirm': { const name = fullName(S.byId.get(t.dataset.id) || {}); await api.remove(t.dataset.id); closeDrawer(); await reload(); toast(`${name} removed.`); break; }
      case 'unlink': await api.link(t.dataset.id, null); await reload(); toast('Sign-in unlinked.'); drawDrawer(false); break;
      case 'link-one': { const sel = $('#gc-link-one', el.drawer); if (!sel || !sel.value) return formError('Choose a sign-in first.'); await api.link(t.dataset.id, sel.value); await reload(); toast('Linked.'); drawDrawer(false); break; }
      case 'link-go': { const m = $('#gc-link-member'), r = $('#gc-link-record'); if (!m.value || !r.value) { toast('Choose a sign-in and a record.'); return; } await api.link(r.value, m.value); await reload(); toast('Linked.'); break; }
      case 'export': exportCsv(); break;
      case 'import-go': await runImport(); break;
      case 'import-cancel': S.manage.importing = null; renderManage(); break;
      case 'm-preview': { const k = t.dataset.kind; const form = $('#gc-form'); const r = await api.preview(k, $(`#m-${k}_subject`, form).value, $(`#m-${k}_text`, form).value); S.msgs.preview = { kind: k, ...r }; renderMessages(); break; }
      case 'm-default': { const k = t.dataset.kind; $(`#m-${k}_subject`).value = DEFAULTS[`${k}_subject`]; $(`#m-${k}_text`).value = DEFAULTS[`${k}_text`]; break; }
      case 'm-test': { t.disabled = true; try { const r = await api.sendTest(t.dataset.kind); toast(`Test sent to ${r.to}.`); loadMessages(); } finally { t.disabled = false; } break; }
      case 'm-run': { t.disabled = true; try { const r = await api.runNow(); toast(r.error ? `The run failed: ${r.error}` : `Sent ${r.sent}, skipped ${r.skipped}${r.digest ? ', and the media team note' : ''}.`); await reload(); loadMessages(); } finally { t.disabled = false; } break; }
      default: break;
    }
  } catch (err) {
    if (!formError(err.message)) toast(err.message);
  }
});

document.addEventListener('submit', (e) => {
  const form = e.target.closest('#gc-form');
  if (!form) return;
  e.preventDefault();
  submitForm(form);
});

document.addEventListener('input', (e) => {
  if (e.target === el.q) { S.q = e.target.value; renderMain(); return; }
  if (e.target.id === 'gc-claim-q') { S.claim.q = e.target.value; renderMe(); return; }
});
document.addEventListener('change', (e) => { if (e.target.id === 'gc-import') readImport(e.target.files[0]); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && S.drawer) closeDrawer(); });
el.scrim.addEventListener('click', closeDrawer);
window.addEventListener('hashchange', () => {
  const v = (location.hash || '').replace('#', '');
  if (['directory', 'celebrations', 'me', 'messages', 'manage', 'guide'].includes(v) && v !== S.view) { S.view = v; render(); }
});

// ---------------------------------------------------------------- boot
(async () => {
  try {
    await api.init();
    await refreshIdentity();
    await reload();
    if (wantsSignin && !signedIn()) openDrawer('signin', null, null);
    if (!reduceMotion()) document.body.classList.add('gc-ready');
  } catch (e) {
    S.loadError = e.message;
    render();
  }
})();
