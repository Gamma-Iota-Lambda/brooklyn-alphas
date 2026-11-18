// School Daze photo drop: the review page (school-daze/review.html). Two or three organizers use
// it, on a phone as often as a laptop, to approve the photos that play on the venue's big screens.
//
// The page keeps one list of photos, as the photo-drop Edge Function last sent it (api.js), and
// draws the tab that is open from it. A tap on Approve or Reject changes that list at once and
// tells the server afterwards. If the server refuses, the list goes back the way it was and the
// page says so. The list is asked for again every minute; what comes back is fitted into the page
// around whatever the organizer is doing, so an open photo or a caption half typed stays put.
//
// Kept on the device: the review code and the organizer's name, until Sign out.
import { READY, DropError, review, esc } from './api.js';
import { VERDICTS, verdictFor } from './image.js';
import { createZips } from './zip.js';

// Tells the small script in the page that this one arrived.
window.GIL_DROP_STARTED = true;

const REFRESH_EVERY = 60000;
const ANSWER_TIMEOUT = 30000; // an answer that hasn't come in half a minute isn't going to
const PHOTO_TIMEOUT = 120000; // one photo, for the download
const ZIP_BYTES = 250 * 1000 * 1000; // a new ZIP file starts past this
const IDS_AT_ONCE = 200; // the most photos the server changes in one go
const CAPTION_MAX = 80;
const SETTLE = 400; // after photos move, taps wait this long: a double tap must not hit the next one
const MONTHS = ['Jan.', 'Feb.', 'March', 'April', 'May', 'June', 'July', 'Aug.', 'Sept.', 'Oct.', 'Nov.', 'Dec.'];
const VIEWS = ['loading', 'signin', 'trouble', 'app'];
const TABS = ['waiting', 'approved', 'rejected'];
const LABEL = { waiting: 'Waiting', approved: 'Approved', rejected: 'Rejected' };
const DONE = { approved: 'approved', rejected: 'rejected', waiting: 'moved back to waiting' };
const NOTHING = {
  waiting: 'Nothing is waiting. New photos show up here on their own.',
  approved: 'No photos are approved yet. Approved photos play on the big screens.',
  rejected: 'No photos are rejected.'
};
const TONE = { great: 'ok', good: 'ok', small: 'warn', tiny: 'bad' };
const STATE_PILL = { open: ['Open', 'ok'], closed: ['Closed', 'bad'], full: ['Full', 'warn'] };
const CODE_CHANGED = "That code isn't right anymore. Type the current one.";

// ---------------------------------------------------------------- helpers
const $ = (s, root = document) => root.querySelector(s);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const whyOf = (e) => (e instanceof DropError ? e.message : 'Something went wrong. Try again.');
const store = {
  get() { try { return JSON.parse(localStorage.getItem('gil.drop.review')) || {}; } catch { return {}; } },
  set(me) { try { localStorage.setItem('gil.drop.review', JSON.stringify(me)); } catch { /* private browsing: nothing to keep */ } },
  clear() { try { localStorage.removeItem('gil.drop.review'); } catch { /* nothing was kept */ } }
};

// A request on a phone that loses its signal can hang. Give up after a while, so a tap that
// didn't land is undone and said, rather than left looking done.
function inTime(request, ms = ANSWER_TIMEOUT) {
  let timer;
  const late = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new DropError('That took too long. Check your connection and try again.', { reason: 'network' })), ms);
  });
  return Promise.race([request, late]).finally(() => clearTimeout(timer));
}

// Dates and times in the organizer's own time zone.
function timeParts(at, more = {}) {
  const options = { weekday: 'long', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true, ...more };
  return Object.fromEntries(new Intl.DateTimeFormat('en-US', options).formatToParts(at).map((p) => [p.type, p.value]));
}
function clockText(p) {
  const half = /p/i.test(p.dayPeriod) ? 'PM' : 'AM';
  const time = p.minute === '00' ? `${Number(p.hour)} ${half}` : `${Number(p.hour)}:${p.minute} ${half}`;
  if (time === '12 PM') return 'noon';
  if (time === '12 AM') return 'midnight';
  return time;
}
// "Nov. 18, 6:01 PM"
function shortWhen(iso) {
  const at = new Date(iso || NaN);
  if (Number.isNaN(at.getTime())) return '';
  const p = timeParts(at);
  return `${MONTHS[Number(p.month) - 1]} ${p.day}, ${clockText(p)}`;
}
// "Saturday, Nov. 21 at noon EST"
function longWhen(iso) {
  const at = new Date(iso || NaN);
  if (Number.isNaN(at.getTime())) return '';
  const p = timeParts(at, { timeZoneName: 'short' });
  return `${p.weekday}, ${MONTHS[Number(p.month) - 1]} ${p.day} at ${clockText(p)}${p.timeZoneName ? ` ${p.timeZoneName}` : ''}`;
}
// "Eastern Standard Time", as it is on that day.
function zoneName(at) {
  try {
    return timeParts(at, { timeZoneName: 'long' }).timeZoneName || '';
  } catch {
    return '';
  }
}
// A time as a datetime-local field holds it: the organizer's own clock, no zone.
function fieldTime(iso) {
  const at = new Date(iso || NaN);
  if (Number.isNaN(at.getTime())) return '';
  const two = (n) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())}T${two(at.getHours())}:${two(at.getMinutes())}`;
}
// "38 MB", or "0.4 MB" when it is small.
function megabytes(bytes) {
  const mb = Math.max(0, Number(bytes) || 0) / 1e6;
  return `${mb > 0 && mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

// ---------------------------------------------------------------- state
const S = {
  view: 'loading',
  session: 0, // goes up at every sign-in and sign-out; an answer for an older one is dropped
  code: '',
  name: '',
  settings: null, // as the server sent it: { open, closesAt, state, maxPhotos, maxBytes, photos, bytes }
  photos: [], // every photo, oldest first, as the server sent them
  tab: 'waiting',
  editing: new Map(), // photo id -> the caption to start its open editor with
  viewing: '', // the id of the photo in the full view
  viewAt: 0, // where that photo is, or last was, among the photos shown
  viewNext: '',
  viewPrev: '',
  loading: false,
  loadedAt: 0,
  loadError: '',
  busy: 0, // changes on their way to the server
  changes: 0, // goes up when a change leaves and again when its answer lands
  stale: false, // a list came back while a change was out: ask again once things are quiet
  timer: 0,
  againTimer: 0,
  toastTimer: 0,
  settleAt: 0,
  deadlineTouched: false, // the organizer is choosing a deadline: a refresh must not overwrite it
  downloading: false,
  zipLinks: [],
  confirm: null // what the "Are you sure?" box is asking: { word, run, running }
};
const cards = new Map(); // photo id -> { el, thumb, body }: the cards in the grid right now

const byId = (id) => S.photos.find((p) => p.id === id);
const shown = () => S.photos.filter((p) => p.status === S.tab);
const count = (status) => S.photos.filter((p) => p.status === status).length;

// ---------------------------------------------------------------- which section shows
function show(view) {
  S.view = view;
  for (const name of VIEWS) $(`#rv-${name}`).hidden = name !== view;
  $('#rv-me').hidden = view !== 'app';
  // Screen readers follow the focus, so put it on the new section's heading.
  const heading = $(`#rv-${view} [data-heading]`);
  if (heading) heading.focus({ preventScroll: true });
}

function notReady() {
  $('#rv-main').innerHTML = '<p class="rv-notready">This page isn\'t set up yet.</p>';
}

// ---------------------------------------------------------------- messages
// A line across the bottom of the screen. Problems stay until they are read; good news leaves
// on its own. An open box covers the page, so the line moves into the box to stay in sight.
function toast(text, tone = 'bad') {
  const box = $('#rv-toast');
  clearTimeout(S.toastTimer);
  if (!text) {
    box.hidden = true;
    return;
  }
  const host = $('#rv-confirm').open ? $('#rv-confirm') : $('#rv-view').open ? $('#rv-view') : document.body;
  if (box.parentElement !== host) host.append(box);
  box.className = `rv-toast ${tone}`;
  $('#rv-toast-text').textContent = text;
  box.hidden = false;
  S.toastTimer = setTimeout(() => { box.hidden = true; }, tone === 'bad' ? 15000 : 5000);
}

// For screen readers only: what a tap just did.
function say(text) {
  $('#rv-say').textContent = text;
}

// ---------------------------------------------------------------- signing in and out
function askToSignIn(error = '') {
  const me = store.get();
  // A name already typed stays: a wrong code shouldn't mean typing both again.
  if (!$('#rv-name').value) $('#rv-name').value = S.name || (typeof me.name === 'string' ? me.name.slice(0, 60) : '');
  $('#rv-signin-err').textContent = error;
  $('#rv-signin-err').hidden = !error;
  $('#rv-signin-go').disabled = false;
  $('#rv-signin-go').textContent = 'Sign in';
  show('signin');
  if (error) $('#rv-code').focus();
}

// Asks the server for the list with this code. A list back means the code is good.
// `from` is 'form' (just typed) or 'kept' (from an earlier visit).
async function enter(code, name, from) {
  const session = ++S.session;
  let data;
  try {
    data = await inTime(review(code, 'list'));
  } catch (e) {
    if (session !== S.session) return;
    if (e.reason === 'code') {
      if (from === 'kept') store.set({ name });
      return askToSignIn(from === 'kept' ? CODE_CHANGED : "That code isn't right. Check it and try again.");
    }
    if (from === 'form') return askToSignIn(whyOf(e));
    $('#rv-trouble-text').textContent = whyOf(e);
    return show('trouble');
  }
  if (session !== S.session) return;
  S.code = code;
  S.name = name;
  store.set({ code, name });
  $('#rv-code').value = '';
  $('#rv-me-name').textContent = name;
  S.tab = 'waiting';
  show('app');
  take(data);
  if (from === 'form') $(`#rv-tab-${S.tab}`).focus({ preventScroll: true });
  clearInterval(S.timer);
  S.timer = setInterval(() => { if (!document.hidden) load({ quiet: true }); }, REFRESH_EVERY);
}

// Back to an empty page. With `keep`, the code and name stay on the device (the server just
// couldn't be reached); without it they go.
function leave() {
  S.session += 1;
  clearInterval(S.timer);
  clearTimeout(S.againTimer);
  for (const id of ['#rv-view', '#rv-confirm']) if ($(id).open) $(id).close();
  toast('');
  dropZipLinks();
  $('#rv-download-status').textContent = '';
  $('#rv-download-missed').hidden = true;
  Object.assign(S, { code: '', settings: null, photos: [], tab: 'waiting', viewing: '', loading: false, loadedAt: 0, loadError: '', busy: 0, stale: false, deadlineTouched: false, downloading: false, confirm: null });
  S.editing.clear();
  for (const { el } of cards.values()) el.remove();
  cards.clear();
}

function signOut() {
  leave();
  store.clear();
  S.name = '';
  $('#rv-code').value = '';
  $('#rv-name').value = '';
  askToSignIn();
}

// The server stopped taking the code: someone changed it. The name stays for next time.
function lockedOut() {
  const name = S.name;
  leave();
  store.set({ name });
  askToSignIn(CODE_CHANGED);
}

// ---------------------------------------------------------------- the list
// Asks for the list again. Quiet is the page's own minute-by-minute refresh: a failure then
// shows only as a line by the Refresh button, never as a message in the way.
async function load({ quiet = false } = {}) {
  if (S.view !== 'app' || S.loading) return;
  const session = S.session;
  const before = S.changes;
  S.loading = true;
  paintBar();
  try {
    const data = await inTime(review(S.code, 'list'));
    if (session !== S.session) return;
    // A change went out or came back while this list was on its way, so the list may be from
    // before the change. Showing it would undo a tap on screen. Drop it and ask again.
    if (before !== S.changes || S.busy) {
      S.stale = true;
      return;
    }
    take(data);
    if (!quiet) say(`Checked. ${count('waiting')} waiting, ${count('approved')} approved, ${count('rejected')} rejected.`);
  } catch (e) {
    if (session !== S.session) return;
    if (e.reason === 'code') return lockedOut();
    S.loadError = whyOf(e);
    if (!quiet) toast(S.loadError);
  } finally {
    if (session === S.session) {
      S.loading = false;
      paintBar();
      if (S.stale && !S.busy) again();
    }
  }
}

// Ask for the list once more, shortly, without anyone having to tap.
function again() {
  S.stale = false;
  clearTimeout(S.againTimer);
  S.againTimer = setTimeout(() => load({ quiet: true }), 800);
}

function take(data) {
  if (data.settings) S.settings = data.settings;
  S.photos = Array.isArray(data.photos) ? data.photos : [];
  S.loadedAt = Date.now();
  S.loadError = '';
  for (const id of [...S.editing.keys()]) if (!byId(id)) S.editing.delete(id);
  if (S.viewing && !byId(S.viewing)) {
    $('#rv-view').close();
    toast('That photo is no longer here. Someone else deleted it.');
  }
  render();
}

// One change sent to the server. Callers have already shown it on the page and undo it if this
// throws. While any change is out, load() won't trust a list it gets back.
async function change(action, more) {
  S.busy += 1;
  S.changes += 1;
  const session = S.session;
  try {
    return await inTime(review(S.code, action, more));
  } finally {
    if (session === S.session) {
      S.busy -= 1;
      S.changes += 1;
      if (S.stale && !S.busy) again();
    }
  }
}

// After a change was refused and undone: say so, or go back to sign-in when the code is why.
function refused(e, what) {
  if (e instanceof DropError && e.reason === 'code') return lockedOut();
  toast(`${what} ${whyOf(e)}`);
}

// ---------------------------------------------------------------- drawing
function render() {
  if (S.view !== 'app') return;
  paintBar();
  paintUploads();
  paintTabs();
  paintGrid();
  paintViewer();
}

function paintBar() {
  const s = S.settings;
  $('#rv-usage').textContent = s ? `${megabytes(s.bytes)} of ${megabytes(s.maxBytes)}, ${s.photos} of ${plural(s.maxPhotos, 'photo')}` : '';
  const at = S.loadedAt ? clockText(timeParts(new Date(S.loadedAt))) : '';
  let stamp = at ? `Checked at ${at}` : '';
  if (S.loadError) stamp = `Couldn't refresh. Showing the photos as of ${at}.`;
  if (S.loading) stamp = 'Checking for new photos';
  $('#rv-stamp').textContent = stamp;
  $('#rv-stamp').classList.toggle('bad', !!S.loadError && !S.loading);
  $('#rv-refresh').disabled = S.loading;
}

// The Uploads panel: the state in words, the switch, and the deadline.
function stateInWords(s) {
  const until = longWhen(s.closesAt);
  if (!s.open) return { short: 'switched off', long: "Closed. Nobody can send photos until you switch this back on." };
  if (s.state === 'closed') {
    return {
      short: until ? `since ${until}` : '',
      long: until ? `Closed since ${until}, when the deadline passed. To take more photos, save a later deadline or choose No deadline.` : 'Closed.'
    };
  }
  if (s.state === 'full') {
    return { short: 'no room for more', long: 'Full. We have all the photos we can keep, so nobody can send more. Delete rejected photos to make room.' };
  }
  return until ? { short: `until ${until}`, long: `Open until ${until}.` } : { short: 'with no deadline', long: 'Open, with no deadline.' };
}

function paintUploads() {
  const s = S.settings;
  if (!s) return;
  const state = !s.open ? 'closed' : STATE_PILL[s.state] ? s.state : 'open';
  const words = stateInWords(s);
  $('#rv-state-pill').textContent = STATE_PILL[state][0];
  $('#rv-state-pill').className = `pd-pill ${STATE_PILL[state][1]}`;
  $('#rv-state-short').textContent = words.short;
  if ($('#rv-state').textContent !== words.long) $('#rv-state').textContent = words.long;
  $('#rv-open').checked = !!s.open;
  const field = $('#rv-deadline');
  // Leave the field alone while the organizer is choosing a time in it.
  if (!S.deadlineTouched && document.activeElement !== field) field.value = fieldTime(s.closesAt);
  const zone = zoneName(new Date(field.value || s.closesAt || Date.now()));
  $('#rv-zone').textContent = zone ? `In your own time zone: ${zone}.` : 'In your own time zone.';
  $('#rv-deadline-none').disabled = !s.closesAt;
}

function paintTabs() {
  for (const tab of TABS) {
    const button = $(`#rv-tab-${tab}`);
    const on = tab === S.tab;
    $('[data-count]', button).textContent = String(count(tab));
    button.setAttribute('aria-selected', String(on));
    button.tabIndex = on ? 0 : -1;
  }
  $('#rv-panel').setAttribute('aria-labelledby', `rv-tab-${S.tab}`);
}

// Fits the list into the grid without rebuilding it: cards that left are taken out, new ones are
// put in their place in line, and a card is redrawn only when something on it changed.
function paintGrid() {
  const grid = $('#rv-grid');
  // A card whose caption is being typed stays where it is even if its photo has moved on.
  const list = S.photos.filter((p) => p.status === S.tab || (S.editing.has(p.id) && cards.has(p.id)));
  const keep = new Set(list.map((p) => p.id));
  for (const [id, card] of cards) {
    if (keep.has(id)) continue;
    card.el.remove();
    cards.delete(id);
  }
  let at = grid.firstElementChild;
  for (const p of list) {
    let card = cards.get(p.id);
    if (!card) {
      card = newCard(p);
      cards.set(p.id, card);
    }
    paintCard(card, p);
    if (card.el === at) at = at.nextElementSibling;
    else grid.insertBefore(card.el, at);
  }
  const n = shown().length;
  $('#rv-empty').textContent = NOTHING[S.tab];
  $('#rv-empty').hidden = list.length > 0;
  $('#rv-shown').textContent = n ? `${plural(n, 'photo')} ${LABEL[S.tab].toLowerCase()}, oldest first` : '';
  $('#rv-approve-all').hidden = S.tab !== 'waiting' || n < 2;
}

function newCard(p) {
  const el = document.createElement('li');
  el.className = 'rv-card';
  el.dataset.id = p.id;
  const thumb = document.createElement('button');
  thumb.type = 'button';
  thumb.className = 'rv-thumb';
  thumb.dataset.act = 'view';
  const body = document.createElement('div');
  body.className = 'rv-body';
  el.append(thumb, body);
  return { el, thumb, body, thumbSig: '', bodySig: '' };
}

function paintCard(card, p) {
  const thumbSig = `${p.thumbUrl}\n${p.name}`;
  if (card.thumbSig !== thumbSig) {
    card.thumbSig = thumbSig;
    card.thumb.classList.remove('is-broken');
    card.thumb.setAttribute('aria-label', `See the photo from ${p.name} full size`);
    card.thumb.innerHTML = `<img src="${esc(p.thumbUrl)}" alt="" loading="lazy" decoding="async" /><span class="rv-thumb-miss">This picture didn't load. Tap Refresh.</span>`;
  }
  const editing = S.editing.has(p.id);
  if (editing && card.body.dataset.editing) return; // someone is typing here: leave it exactly as it is
  const bodySig = JSON.stringify([p.status, p.name, p.email, p.caption, p.width, p.height, p.original, p.createdAt, p.reviewedAt, p.reviewedBy, editing]);
  if (card.bodySig === bodySig) return;
  card.bodySig = bodySig;
  // Redrawing would drop the keyboard's place. Note which button had it, and give it back.
  const held = card.body.contains(document.activeElement) ? document.activeElement.dataset.act : '';
  card.body.innerHTML = bodyHTML(p, editing);
  if (editing) card.body.dataset.editing = '1';
  else delete card.body.dataset.editing;
  const back = held && $(`[data-act="${held}"]`, card.body);
  if (back) back.focus({ preventScroll: true });
}

// The pill that says how a photo will look on the big screens, by the file the person picked
// where that is known, and the photo's size in pixels.
function sizeHTML(p) {
  const o = p.original && p.original.width > 0 && p.original.height > 0 ? p.original : p;
  const verdict = verdictFor(Math.max(o.width, o.height));
  return `<span class="pd-pill ${TONE[verdict]}">${esc(VERDICTS[verdict].label)}</span> <span class="rv-dims">${Number(o.width)} × ${Number(o.height)}</span>`;
}

function bodyHTML(p, editing) {
  const name = esc(p.name);
  const by = p.status !== 'waiting' && p.reviewedAt
    ? `<p class="rv-when">${LABEL[p.status]}${p.reviewedBy ? ` by ${esc(p.reviewedBy)}` : ''}, ${esc(shortWhen(p.reviewedAt))}</p>`
    : '';
  const caption = editing ? `
    <form class="rv-cap-form" data-form="caption" novalidate>
      <div class="pd-field">
        <label for="rv-cap-${esc(p.id)}">Caption<span class="pd-sr"> for the photo from ${name}</span></label>
        <input id="rv-cap-${esc(p.id)}" type="text" maxlength="${CAPTION_MAX}" enterkeyhint="done" autocomplete="off" value="${esc(S.editing.get(p.id))}" aria-describedby="rv-cap-hint-${esc(p.id)}" />
        <p class="pd-hint" id="rv-cap-hint-${esc(p.id)}">Shown with the photo on the big screens. Leave it empty for no caption.</p>
      </div>
      <div class="rv-cap-btns">
        <button type="submit" class="pd-btn small primary">Save</button>
        <button type="button" class="pd-btn small" data-act="cancel">Cancel</button>
      </div>
    </form>` : `
    <div class="rv-cap">
      ${p.caption ? `<p class="rv-cap-text">${esc(p.caption)}</p>` : '<p class="rv-cap-text none">No caption</p>'}
      <button type="button" class="pd-btn small" data-act="edit" aria-label="${p.caption ? 'Edit' : 'Add'} the caption for the photo from ${name}">${p.caption ? 'Edit' : 'Add'}</button>
    </div>`;
  const about = `<span class="pd-sr"> the photo from ${name}</span>`;
  const actions = p.status === 'waiting'
    ? `<button type="button" class="pd-btn primary" data-act="approve">Approve${about}</button>
       <button type="button" class="pd-btn" data-act="reject">Reject${about}</button>`
    : `<button type="button" class="pd-btn" data-act="waiting">Back to waiting<span class="pd-sr"> with the photo from ${name}</span></button>
       ${p.status === 'rejected' ? `<button type="button" class="pd-btn danger" data-act="delete">Delete${about}</button>` : ''}`;
  return `
    <p class="rv-name">${name}</p>
    <p class="rv-email">${esc(p.email)}</p>
    <p class="rv-when">Sent ${esc(shortWhen(p.createdAt))}</p>
    ${by}
    <p class="rv-size">${sizeHTML(p)}</p>
    ${caption}
    <div class="rv-actions">${actions}</div>`;
}

// ---------------------------------------------------------------- approve, reject, back to waiting
// Moves photos to a status: on the page at once, then on the server. Photos the server didn't
// take go back to where they were, with a message.
async function setStatus(ids, status) {
  const rows = ids.map(byId).filter((p) => p && p.status !== status);
  if (!rows.length) return;
  const session = S.session;
  const from = rows[0].status;
  const before = new Map(rows.map((p) => [p.id, { status: p.status, reviewedAt: p.reviewedAt, reviewedBy: p.reviewedBy }]));
  const now = new Date().toISOString();
  for (const p of rows) {
    p.status = status;
    p.reviewedAt = status === 'waiting' ? null : now;
    p.reviewedBy = status === 'waiting' ? null : S.name;
  }
  S.settleAt = Date.now() + SETTLE;
  render();
  say(`${rows.length === 1 ? 'Photo' : plural(rows.length, 'photo')} ${DONE[status]}. ${count('waiting')} waiting.`);

  let sent = 0;
  try {
    let changed = 0;
    for (; sent < rows.length; sent += IDS_AT_ONCE) {
      const answer = await change('set', { ids: rows.slice(sent, sent + IDS_AT_ONCE).map((p) => p.id), status, by: S.name });
      changed += Number(answer.changed) || 0;
    }
    // Fewer changed than asked: someone else got to some first. See how things stand now.
    if (session === S.session && changed < rows.length) again();
  } catch (e) {
    if (session !== S.session) return;
    const undone = rows.slice(sent);
    for (const row of undone) {
      const p = byId(row.id);
      if (p) Object.assign(p, before.get(row.id));
    }
    S.settleAt = Date.now() + SETTLE;
    render();
    const what = undone.length === 1
      ? `The photo from ${undone[0].name} wasn't ${DONE[status]}. It is back in ${LABEL[from]}.`
      : `${undone.length} photos weren't ${DONE[status]}. They are back in ${LABEL[from]}.`;
    refused(e, what);
  }
}

// A tap on a card's Approve, Reject or Back to waiting.
function moveFromCard(p, status) {
  const at = shown().findIndex((x) => x.id === p.id);
  keepDraft(p);
  setStatus([p.id], status);
  focusCardAt(at);
}

// The card that is now at this place in the grid gets the keyboard, or the tab when none is left.
function focusCardAt(at) {
  const list = shown();
  const next = list[at] || list[at - 1];
  const card = next && cards.get(next.id);
  const target = (card && $('.rv-actions .pd-btn', card.body)) || $(`#rv-tab-${S.tab}`);
  target.focus({ preventScroll: true });
}

function askApproveAll() {
  // Exactly the photos on screen now. One that arrives while the box is open is not among them.
  const ids = shown().map((p) => p.id);
  if (S.tab !== 'waiting' || !ids.length) return;
  confirmWith({
    title: `Approve all ${ids.length} photos shown?`,
    text: 'They will play on the big screens. You can send any of them back to waiting afterwards.',
    yes: `Approve ${plural(ids.length, 'photo')}`,
    run: () => setStatus(ids, 'approved'),
    after: () => $(`#rv-tab-${S.tab}`).focus({ preventScroll: true })
  });
}

// ---------------------------------------------------------------- captions
function editCaption(p) {
  S.editing.set(p.id, p.caption || '');
  render();
  const input = $('input', cards.get(p.id).body);
  input.focus();
  input.select();
}

function stopEditing(p) {
  S.editing.delete(p.id);
  render();
  const card = cards.get(p.id);
  const edit = card && $('[data-act="edit"]', card.body);
  if (edit) edit.focus({ preventScroll: true });
}

// A caption half typed on a card is saved when the card's photo is moved, rather than lost.
function keepDraft(p) {
  const card = cards.get(p.id);
  const input = S.editing.has(p.id) && card && $('.rv-cap-form input', card.body);
  if (input) saveCaption(p.id, input.value, { focus: false });
}

async function saveCaption(id, typed, { focus = true } = {}) {
  const p = byId(id);
  if (!p) return;
  const session = S.session;
  const next = typed.replace(/\s+/g, ' ').trim().slice(0, CAPTION_MAX);
  const before = p.caption || null;
  if (next === (before || '')) return focus ? stopEditing(p) : S.editing.delete(id);
  p.caption = next || null;
  if (focus) stopEditing(p);
  else S.editing.delete(id);
  say(next ? 'Caption saved.' : 'Caption removed.');
  try {
    await change('caption', { id, caption: next });
  } catch (e) {
    if (session !== S.session) return;
    // Put the old caption back, and reopen the box with what was typed so it isn't lost.
    const now = byId(id);
    if (now) {
      now.caption = before;
      if (cards.has(id)) S.editing.set(id, next);
    }
    render();
    refused(e, "That caption wasn't saved.");
  }
}

// ---------------------------------------------------------------- deleting
function askDelete(p) {
  const at = shown().findIndex((x) => x.id === p.id);
  confirmWith({
    title: 'Delete this photo for good?',
    text: `The photo from ${p.name} is removed from the chapter's storage. It can't be brought back.`,
    yes: 'Delete photo',
    danger: true,
    run: () => deletePhoto(p.id),
    after: () => focusCardAt(at)
  });
}

async function deletePhoto(id) {
  const at = S.photos.findIndex((p) => p.id === id);
  if (at < 0) return;
  const session = S.session;
  const [p] = S.photos.splice(at, 1);
  S.editing.delete(id);
  const room = S.settings ? { photos: S.settings.photos, bytes: S.settings.bytes } : null;
  if (room) Object.assign(S.settings, { photos: Math.max(0, room.photos - 1), bytes: Math.max(0, room.bytes - (Number(p.bytes) || 0)) });
  S.settleAt = Date.now() + SETTLE;
  render();
  say('Photo deleted.');
  try {
    const answer = await change('delete', { ids: [id] });
    if (session === S.session && !answer.deleted) again();
  } catch (e) {
    if (session !== S.session) return;
    if (!byId(id)) S.photos.splice(Math.min(at, S.photos.length), 0, p);
    if (room && S.settings) Object.assign(S.settings, room);
    S.settleAt = Date.now() + SETTLE;
    render();
    refused(e, `The photo from ${p.name} wasn't deleted. It is back in ${LABEL[p.status]}.`);
  }
}

function askDeleteEverything() {
  const total = S.photos.length;
  confirmWith({
    title: 'Delete everything?',
    text: `This deletes every photo and its files for good: ${count('waiting')} waiting, ${count('approved')} approved and ${count('rejected')} rejected${total ? '' : ', plus any still arriving'}. The slideshow goes empty. It can't be undone. To keep the approved photos, download them first.`,
    yes: 'Delete everything',
    working: 'Deleting',
    danger: true,
    word: 'DELETE',
    waits: true,
    // Not shown as done until the server says it is: this is the one change nobody can take back.
    run: async () => {
      const session = S.session;
      let answer;
      try {
        answer = await change('empty', { confirm: 'DELETE' });
      } catch (e) {
        if (session === S.session && e instanceof DropError && e.reason === 'code') {
          lockedOut();
          return;
        }
        throw e;
      }
      if (session !== S.session) return;
      S.photos = [];
      S.editing.clear();
      if (S.settings) Object.assign(S.settings, { photos: 0, bytes: 0 });
      render();
      toast(`Deleted ${plural(Number(answer.deleted) || 0, 'photo')}. The drop is empty.`, 'ok');
      again();
    }
  });
}

// ---------------------------------------------------------------- "Are you sure?"
// Opens the box. `run` does the thing. A change the page shows at once and undoes if it fails
// returns straight away, and the box closes. One the page waits for (`waits`) keeps the box open
// until the server answers, and shows the reason there if it throws. `after` puts the keyboard
// somewhere sensible once the box has closed. `word` is a word the organizer must type first.
function confirmWith({ title, text, yes, working = '', danger = false, word = '', waits = false, run, after = null }) {
  S.confirm = { word, run, after, yes, working, waits, running: false };
  $('#rv-confirm-title').textContent = title;
  $('#rv-confirm-text').textContent = text;
  $('#rv-confirm-word').hidden = !word;
  $('#rv-confirm-label').textContent = word ? `Type ${word} to go ahead` : '';
  $('#rv-confirm-input').value = '';
  $('#rv-confirm-err').hidden = true;
  const go = $('#rv-confirm-yes');
  go.className = `pd-btn ${danger ? 'danger' : 'primary'}`;
  go.textContent = yes;
  go.disabled = !!word;
  $('#rv-confirm-no').disabled = false;
  $('#rv-confirm').showModal();
  // The keyboard starts on the safe choice.
  (word ? $('#rv-confirm-input') : $('#rv-confirm-no')).focus();
}

async function confirmed() {
  const c = S.confirm;
  if (!c || c.running) return;
  if (c.word && $('#rv-confirm-input').value.trim() !== c.word) return;
  c.running = true;
  const go = $('#rv-confirm-yes');
  go.disabled = true;
  $('#rv-confirm-no').disabled = true;
  if (c.working) go.textContent = c.working;
  $('#rv-confirm-err').hidden = true;
  try {
    if (c.waits) await c.run();
    else c.run();
    if (S.confirm !== c) return;
    if ($('#rv-confirm').open) $('#rv-confirm').close();
    if (c.after) c.after();
  } catch (e) {
    if (S.confirm !== c) return;
    c.running = false;
    go.textContent = c.yes;
    go.disabled = false;
    $('#rv-confirm-no').disabled = false;
    $('#rv-confirm-err').textContent = whyOf(e);
    $('#rv-confirm-err').hidden = false;
  }
}

// ---------------------------------------------------------------- the full view
function openViewer(id) {
  S.viewing = id;
  if (!$('#rv-view').open) $('#rv-view').showModal();
  paintViewer();
  $('#rv-view-close').focus({ preventScroll: true });
}

// Draws what goes around the photo, and the photo itself only when it is a different one, so a
// refresh never makes an open photo blink or jump.
function paintViewer() {
  if (!S.viewing || !$('#rv-view').open) return;
  const p = byId(S.viewing);
  if (!p) return;
  const list = shown();
  const at = list.findIndex((x) => x.id === p.id);
  if (at >= 0) S.viewAt = at;
  // A photo that has left this tab (someone else approved it) keeps its place in line.
  const prev = at >= 0 ? list[at - 1] : list[S.viewAt - 1];
  const next = at >= 0 ? list[at + 1] : list[S.viewAt];
  S.viewPrev = prev ? prev.id : '';
  S.viewNext = next ? next.id : '';
  $('#rv-view-prev').disabled = !prev;
  $('#rv-view-next').disabled = !next;

  const img = $('#rv-view-img');
  if (img.dataset.id !== p.id) {
    img.dataset.id = p.id;
    $('#rv-view-stage').className = 'rv-view-stage is-loading';
    $('#rv-view-wait').textContent = 'Loading the photo';
    img.alt = `The photo from ${p.name}`;
    img.src = p.url;
    S.settleAt = Date.now() + SETTLE;
    // Have the next one ready, so going through a long line doesn't mean waiting on each.
    if (next) new Image().src = next.url;
  }

  const pos = at >= 0 ? `${at + 1} of ${list.length} ${LABEL[S.tab].toLowerCase()}` : `Now ${LABEL[p.status].toLowerCase()}`;
  if ($('#rv-view-pos').textContent !== pos) $('#rv-view-pos').textContent = pos;
  const who = `<p class="rv-view-name">${esc(p.name)} <span class="rv-view-size">${sizeHTML(p)}</span></p>${p.caption ? `<p class="rv-view-cap">${esc(p.caption)}</p>` : ''}`;
  if ($('#rv-view-who').innerHTML !== who) $('#rv-view-who').innerHTML = who;
  const actions = $('#rv-view-actions');
  if (actions.dataset.status !== p.status) {
    actions.dataset.status = p.status;
    actions.innerHTML = p.status === 'waiting'
      ? '<button type="button" class="pd-btn primary" data-act="approve">Approve</button><button type="button" class="pd-btn" data-act="reject">Reject</button>'
      : '<button type="button" class="pd-btn" data-act="waiting">Back to waiting</button>';
  }
}

function step(id) {
  if (!id || !byId(id)) return;
  S.viewing = id;
  paintViewer();
}

// Approve or Reject in the full view: the photo moves, and the next in line takes its place.
function moveFromViewer(status) {
  const p = byId(S.viewing);
  // Not until the photo is on screen, and not on the second tap of a double tap: nobody should
  // approve a photo they haven't seen.
  if (!p || Date.now() < S.settleAt || $('#rv-view-stage').classList.contains('is-loading')) return;
  const list = shown();
  const at = list.findIndex((x) => x.id === p.id);
  // A photo that already left this tab stays in view. Otherwise the next in line takes its place.
  const next = at < 0 ? p : list[at + 1] || list[at - 1];
  if (next) S.viewing = next.id;
  setStatus([p.id], status);
  if (!next) {
    $('#rv-view').close();
    return toast(`That was the last photo ${LABEL[S.tab].toLowerCase()}.`, 'ok');
  }
  // The button that was tapped may have been redrawn. Keep the keyboard inside the view.
  if (!$('#rv-view').contains(document.activeElement)) $('#rv-view-actions .pd-btn').focus({ preventScroll: true });
}

function viewerClosed() {
  const last = S.viewing;
  S.viewing = '';
  const img = $('#rv-view-img');
  img.removeAttribute('src');
  delete img.dataset.id;
  delete $('#rv-view-actions').dataset.status;
  backToPage();
  // Back in the grid, at the photo that was open or the tab it left.
  const card = cards.get(last);
  (card ? card.thumb : $(`#rv-tab-${S.tab}`)).focus();
}

// A message shown inside a box goes back to the page with it.
function backToPage() {
  const box = $('#rv-toast');
  if (box.parentElement !== document.body) document.body.append(box);
}

// ---------------------------------------------------------------- uploads: the switch and the deadline
async function setOpen(open) {
  if (!S.settings) return;
  const session = S.session;
  const before = { ...S.settings };
  S.settings.open = open;
  if (!open) S.settings.state = 'closed';
  else if (before.state === 'closed' && !before.open) S.settings.state = 'open';
  render();
  try {
    const answer = await change('settings', { open });
    if (session !== S.session) return;
    if (answer.settings) S.settings = answer.settings;
    render();
  } catch (e) {
    if (session !== S.session) return;
    S.settings = before;
    render();
    refused(e, `Uploads are still ${before.open ? 'open' : 'closed'}.`);
  }
}

// Saves a deadline (an ISO time) or removes it (null). Shown only once the server has it.
async function setDeadline(closesAt) {
  const session = S.session;
  const save = $('#rv-deadline-save');
  const none = $('#rv-deadline-none');
  $('#rv-deadline-err').hidden = true;
  save.disabled = true;
  none.disabled = true;
  (closesAt ? save : none).textContent = 'Saving';
  try {
    const answer = await change('settings', { closesAt });
    if (session !== S.session) return;
    if (answer.settings) S.settings = answer.settings;
    S.deadlineTouched = false;
    if (document.activeElement === $('#rv-deadline')) $('#rv-deadline').blur();
    render();
    toast(`Saved. ${stateInWords(S.settings).long}`, 'ok');
  } catch (e) {
    if (session !== S.session) return;
    refused(e, "The deadline wasn't saved.");
  } finally {
    if (session === S.session) {
      save.disabled = false;
      save.textContent = 'Save';
      none.textContent = 'No deadline';
      none.disabled = !(S.settings && S.settings.closesAt);
    }
  }
}

function deadlineProblem(message) {
  $('#rv-deadline-err').textContent = message;
  $('#rv-deadline-err').hidden = false;
  $('#rv-deadline').focus();
}

// ---------------------------------------------------------------- downloading the approved photos
// "school-daze-007-ada-lovelace.jpg": the photo's number in the approved list, then the name with
// anything a file name can't hold taken out.
function fileName(number, name) {
  const safe = String(name || '').normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  return `school-daze-${String(number).padStart(3, '0')}-${safe || 'photo'}.jpg`;
}

// One photo's bytes, or null. Tried twice, unless the first answer says the link itself is no good.
async function fetchPhoto(url) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(), PHOTO_TIMEOUT);
    try {
      // no-store: the copy the browser kept when it showed the photo can't be read by a script.
      const res = await fetch(url, { cache: 'no-store', signal: stop.signal });
      if (res.ok) {
        const bytes = new Uint8Array(await res.arrayBuffer());
        if (bytes.length) return bytes;
      } else if (res.status >= 400 && res.status < 500) {
        return null;
      }
    } catch {
      // The connection dropped or the wait ran out. Once more, then move on.
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

function dropZipLinks() {
  for (const url of S.zipLinks) URL.revokeObjectURL(url);
  S.zipLinks = [];
  $('#rv-zips').innerHTML = '';
}

// Starts the browser saving a finished ZIP, and leaves a link to it in case the browser held
// the download back (some do when a page saves a second file by itself).
function handOver(blob, photos, part) {
  const name = part === 1 ? 'school-daze-photos.zip' : `school-daze-photos-${part}.zip`;
  const url = URL.createObjectURL(blob);
  S.zipLinks.push(url);
  const item = document.createElement('li');
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.textContent = `${name} (${plural(photos, 'photo')}, ${megabytes(blob.size)})`;
  item.append(link);
  $('#rv-zips').append(item);
  link.click();
}

async function downloadApproved() {
  if (S.downloading) return;
  const session = S.session;
  const status = $('#rv-download-status');
  const missed = $('#rv-download-missed');
  const list = S.photos.filter((p) => p.status === 'approved').map((p) => ({ name: p.name, url: p.url, createdAt: p.createdAt }));
  dropZipLinks();
  missed.hidden = true;
  if (!list.length) {
    status.textContent = 'No photos are approved yet.';
    return;
  }
  S.downloading = true;
  $('#rv-download').disabled = true;
  const failed = [];
  let saved = 0;
  let files = 0;
  let broke = false;
  const zips = createZips(ZIP_BYTES, (blob, photos) => {
    files += 1;
    saved += photos;
    handOver(blob, photos, files);
  });
  try {
    for (let i = 0; i < list.length; i += 1) {
      status.textContent = `Getting ${i + 1} of ${list.length}`;
      const bytes = await fetchPhoto(list[i].url);
      if (session !== S.session) return;
      if (bytes) zips.add(fileName(i + 1, list[i].name), bytes, new Date(list[i].createdAt));
      else failed.push(`${String(i + 1).padStart(3, '0')} ${list[i].name}`);
    }
    zips.close();
  } catch {
    // The device ran out of room for the ZIP. What was already handed over is still good.
    broke = true;
  } finally {
    if (session === S.session) {
      S.downloading = false;
      $('#rv-download').disabled = false;
    }
  }
  if (session !== S.session) return;
  const done = saved
    ? `Saved ${plural(saved, 'photo')} in ${plural(files, 'ZIP file')}. If a download didn't start, tap the file below.`
    : '';
  status.textContent = done;
  say(done);
  const notes = [];
  if (broke) notes.push('The download stopped before the end: this device ran out of room. Try it on a laptop.');
  if (failed.length) {
    notes.push(`${failed.length === 1 ? "1 photo couldn't be fetched, so it isn't" : `${failed.length} photos couldn't be fetched, so they aren't`} in the ZIP: ${failed.join(', ')}. Check your connection, tap Refresh, then download again.`);
  }
  missed.textContent = notes.join(' ');
  missed.hidden = !notes.length;
}

// ---------------------------------------------------------------- events
function listen() {
  // Signing in and out
  $('#rv-signin-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const code = $('#rv-code').value.trim();
    const name = $('#rv-name').value.replace(/\s+/g, ' ').trim();
    const problem = (message, field) => {
      $('#rv-signin-err').textContent = message;
      $('#rv-signin-err').hidden = false;
      $(field).focus();
    };
    if (!code) return problem('Type the review code.', '#rv-code');
    if (!name) return problem('Add your name.', '#rv-name');
    $('#rv-name').value = name;
    $('#rv-signin-err').hidden = true;
    $('#rv-signin-go').disabled = true;
    $('#rv-signin-go').textContent = 'Checking';
    enter(code, name, 'form');
  });
  $('#rv-code-show').addEventListener('change', (e) => { $('#rv-code').type = e.target.checked ? 'text' : 'password'; });
  $('#rv-signout').addEventListener('click', signOut);
  $('#rv-trouble-out').addEventListener('click', signOut);
  $('#rv-retry').addEventListener('click', () => {
    const me = store.get();
    $('#rv-loading-text').textContent = 'Loading the photos.';
    show('loading');
    enter(me.code, me.name, 'kept');
  });

  // Staying current
  $('#rv-refresh').addEventListener('click', () => load());
  // A phone that was asleep or on another app missed its refreshes. Catch up on the way back.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && S.view === 'app' && Date.now() - S.loadedAt >= REFRESH_EVERY) load({ quiet: true });
  });

  // Tabs
  const tabs = $('.rv-tabs');
  const openTab = (tab) => {
    if (tab === S.tab) return;
    S.tab = tab;
    S.editing.clear();
    render();
  };
  tabs.addEventListener('click', (e) => {
    const button = e.target.closest('[data-tab]');
    if (button) openTab(button.dataset.tab);
  });
  tabs.addEventListener('keydown', (e) => {
    const move = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
    if (!move) return;
    e.preventDefault();
    const next = TABS[(TABS.indexOf(S.tab) + move + TABS.length) % TABS.length];
    openTab(next);
    $(`#rv-tab-${next}`).focus();
  });
  $('#rv-approve-all').addEventListener('click', askApproveAll);

  // The cards
  const grid = $('#rv-grid');
  const photoOf = (node) => {
    const el = node.closest('.rv-card');
    return el ? byId(el.dataset.id) : null;
  };
  grid.addEventListener('click', (e) => {
    const button = e.target.closest('[data-act]');
    const p = button && photoOf(button);
    if (!p) return;
    const act = button.dataset.act;
    if (act === 'view') return openViewer(p.id);
    if (act === 'edit') return editCaption(p);
    if (act === 'cancel') return stopEditing(p);
    // The grid just moved under the finger. A tap this soon was meant for the photo before.
    if (Date.now() < S.settleAt) return;
    if (act === 'delete') return askDelete(p);
    const status = { approve: 'approved', reject: 'rejected', waiting: 'waiting' }[act];
    if (status) moveFromCard(p, status);
  });
  grid.addEventListener('submit', (e) => {
    e.preventDefault();
    const p = photoOf(e.target);
    if (p) saveCaption(p.id, $('input', e.target).value);
  });
  grid.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !e.target.matches('.rv-cap-form input')) return;
    const p = photoOf(e.target);
    if (p) stopEditing(p);
  });
  // A picture whose link has run out or didn't arrive: say so in its place.
  grid.addEventListener('error', (e) => {
    if (e.target.matches('.rv-thumb img')) e.target.closest('.rv-thumb').classList.add('is-broken');
  }, true);

  // The full view
  const view = $('#rv-view');
  $('#rv-view-close').addEventListener('click', () => view.close());
  $('#rv-view-prev').addEventListener('click', () => step(S.viewPrev));
  $('#rv-view-next').addEventListener('click', () => step(S.viewNext));
  view.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') step(S.viewPrev);
    if (e.key === 'ArrowRight') step(S.viewNext);
  });
  view.addEventListener('close', viewerClosed);
  $('#rv-view-actions').addEventListener('click', (e) => {
    const button = e.target.closest('[data-act]');
    const status = button && { approve: 'approved', reject: 'rejected', waiting: 'waiting' }[button.dataset.act];
    if (status) moveFromViewer(status);
  });
  const img = $('#rv-view-img');
  img.addEventListener('load', () => { $('#rv-view-stage').className = 'rv-view-stage'; });
  img.addEventListener('error', () => {
    if (!img.getAttribute('src')) return;
    $('#rv-view-stage').className = 'rv-view-stage is-broken';
    $('#rv-view-wait').textContent = "This photo didn't load. Close it, tap Refresh, and open it again.";
  });

  // "Are you sure?"
  const ask = $('#rv-confirm');
  $('#rv-confirm-form').addEventListener('submit', (e) => {
    e.preventDefault();
    confirmed();
  });
  $('#rv-confirm-no').addEventListener('click', () => ask.close());
  $('#rv-confirm-input').addEventListener('input', (e) => {
    $('#rv-confirm-yes').disabled = !S.confirm || S.confirm.running || e.target.value.trim() !== S.confirm.word;
  });
  // Escape closes the box, except in the middle of the work it was asked to do.
  ask.addEventListener('cancel', (e) => { if (S.confirm && S.confirm.running) e.preventDefault(); });
  ask.addEventListener('close', () => {
    S.confirm = null;
    backToPage();
  });

  // Uploads
  $('#rv-open').addEventListener('change', (e) => setOpen(e.target.checked));
  $('#rv-deadline').addEventListener('input', () => {
    S.deadlineTouched = true;
    $('#rv-deadline-err').hidden = true;
  });
  $('#rv-deadline-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const typed = $('#rv-deadline').value;
    const at = new Date(typed || NaN);
    if (!typed) return deadlineProblem('Choose a date and time, or tap No deadline.');
    if (Number.isNaN(at.getTime())) return deadlineProblem("That date and time didn't read right. Choose them again.");
    setDeadline(at.toISOString());
  });
  $('#rv-deadline-none').addEventListener('click', () => setDeadline(null));

  // Tools
  $('#rv-download').addEventListener('click', downloadApproved);
  $('#rv-empty-all').addEventListener('click', askDeleteEverything);

  $('#rv-toast-close').addEventListener('click', () => toast(''));
}

function start() {
  if (!READY) return notReady();
  listen();
  const me = store.get();
  if (typeof me.code === 'string' && me.code && typeof me.name === 'string' && me.name) {
    show('loading');
    return enter(me.code, me.name.slice(0, 60), 'kept');
  }
  askToSignIn();
}

start();
