// School Daze photo drop: the upload page (school-daze/photos.html). Ticket buyers open it from
// the link in their email, mostly on phones, and send a few photos from their college days for
// the big screens at the party.
//
// The page shows one section at a time: checking the link, asking for the code, closed, full, the
// form, or the thank-you. Each photo is made ready in the browser (image.js) and sent on its own
// through the photo-drop Edge Function (api.js), so one that fails never takes the others with it.
// The only thing kept on the device is the person's name and email, for next time.
import { READY, DropError, open, send, codeFromAddress, esc } from './api.js';
import { LIMITS, VERDICTS, prepare, smaller } from './image.js';

// Tells the small script in the page that this one arrived.
window.GIL_DROP_STARTED = true;

const SEND_TIMEOUT = 180000; // a send that hasn't answered in three minutes isn't going to
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MONTHS = ['Jan.', 'Feb.', 'March', 'April', 'May', 'June', 'July', 'Aug.', 'Sept.', 'Oct.', 'Nov.', 'Dec.'];
const VIEWS = ['loading', 'code', 'trouble', 'closed', 'full', 'form', 'done'];
// Photos in these states are on their way to being sent, so they count toward the limit.
const TAKES_ROOM = new Set(['checking', 'ready', 'waiting', 'sending', 'failed']);
// After one of these answers, the next photo would get the same one. Stop and say so once.
const STOPS = new Set(['limit', 'closed', 'full', 'code', 'input']);
const NO_PICTURE = '<svg viewBox="0 0 24 24" width="30" height="30" aria-hidden="true"><path d="M4 5h16v14H4zM4 16l4.5-4.5 3.5 3.5 3-3 5 5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><circle cx="9" cy="9.5" r="1.4" fill="currentColor"/></svg>';

// ---------------------------------------------------------------- helpers
const $ = (s, root = document) => root.querySelector(s);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const store = {
  get() { try { return JSON.parse(localStorage.getItem('gil.drop.me')) || {}; } catch { return {}; } },
  set(me) { try { localStorage.setItem('gil.drop.me', JSON.stringify(me)); } catch { /* private browsing: nothing to keep */ } }
};

// ---------------------------------------------------------------- state
const S = {
  view: 'loading',
  code: '',
  typed: false, // the code was typed here rather than carried in the link
  perPerson: 5,
  left: 5, // how many more photos this email may send, as far as the page knows
  leftFor: '', // the email that count came back for
  limits: { ...LIMITS },
  cards: [], // the chosen photos, in the order they were chosen
  nextId: 1,
  checking: false,
  sending: false,
  sent: 0 // photos sent since the form was last empty
};
// A card: { id, file, state, message, verdict, prepared, previewUrl, caption, refused, shrunk, el }.
// state: checking (being made ready), ready, bad (can't be used), waiting and sending (during a
// send), sent, or failed (worth another try).

// ---------------------------------------------------------------- which section shows
function show(view, { scroll = false } = {}) {
  S.view = view;
  for (const name of VIEWS) $(`#ph-${name}`).hidden = name !== view;
  const shut = view === 'closed' || view === 'full';
  $('#ph-party').hidden = !shut;
  $('#ph-ask').hidden = shut || view === 'done';
  // Screen readers follow the focus, so put it on the new section's heading.
  const heading = $(`#ph-${view} [data-heading]`);
  if (heading) heading.focus({ preventScroll: true });
  if (scroll) $(`#ph-${view}`).scrollIntoView({ block: 'start', behavior: reduceMotion() ? 'auto' : 'smooth' });
}

function notReady() {
  $('#ph-main').innerHTML = '<p class="ph-notready">This page isn\'t set up yet.</p>';
  $('#ph-foot').hidden = true;
}

function askForCode({ title, lead, error = '' }) {
  $('#ph-code-title').textContent = title;
  $('#ph-code-lead').textContent = lead;
  $('#ph-code-err').textContent = error;
  $('#ph-code-err').hidden = !error;
  show('code');
  if (error) $('#ph-code-input').focus();
}
const CODE_MISSING = {
  title: 'Enter the code from your email',
  lead: 'The link in your School Daze email fills this in for you. No link? Type the code from the email here.'
};
const CODE_WRONG_LINK = {
  title: "That link isn't right",
  lead: 'Use the link in your School Daze email. If you have the code from that email, you can type it here.'
};
const CODE_WRONG_TYPED = { ...CODE_MISSING, error: "That code isn't right. Check your School Daze email and try again." };

// Asks the server whether the code is good and photos are still being taken, then shows the
// section that fits the answer.
async function check() {
  $('#ph-loading-text').textContent = 'Checking your link.';
  show('loading');
  let answer;
  try {
    answer = await open(S.code);
  } catch (e) {
    if (e.reason === 'code') return askForCode(S.typed ? CODE_WRONG_TYPED : CODE_WRONG_LINK);
    $('#ph-trouble-text').textContent = e instanceof DropError ? e.message : 'Something went wrong. Try again.';
    return show('trouble');
  }
  if (S.typed) {
    // Put the code in the address, so reloading the page doesn't ask for it again.
    try { history.replaceState(null, '', `?k=${encodeURIComponent(S.code)}`); } catch { /* not allowed here: no harm */ }
  }
  if (!answer.open) return show(answer.reason === 'full' ? 'full' : 'closed');

  const perPerson = Number(answer.perPerson);
  S.perPerson = Number.isInteger(perPerson) && perPerson > 0 ? perPerson : 5;
  S.left = S.perPerson;
  S.leftFor = '';
  S.limits = { ...LIMITS, ...(answer.limits || {}) };
  for (const el of document.querySelectorAll('[data-per-person]')) el.textContent = String(S.perPerson);
  const by = deadlineText(answer.closesAt);
  $('#ph-deadline').textContent = by ? `Send them by ${by}.` : '';
  $('#ph-deadline').hidden = !by;
  refresh();
  show('form');
}

// "noon on Saturday, Nov. 21". Always New York's time, where the party is, and said so to
// anyone whose own clock reads differently.
function deadlineText(iso) {
  const at = new Date(iso || NaN);
  if (Number.isNaN(at.getTime())) return '';
  try {
    const options = { weekday: 'long', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true };
    const read = (zone) => Object.fromEntries(new Intl.DateTimeFormat('en-US', { ...options, timeZone: zone }).formatToParts(at).map((p) => [p.type, p.value]));
    const ny = read('America/New_York');
    const here = read(undefined);
    const hour = Number(ny.hour);
    const half = /p/i.test(ny.dayPeriod) ? 'PM' : 'AM';
    let time = ny.minute === '00' ? `${hour} ${half}` : `${hour}:${ny.minute} ${half}`;
    if (time === '12 PM') time = 'noon';
    if (time === '12 AM') time = 'midnight';
    const elsewhere = here.hour !== ny.hour || here.day !== ny.day || here.dayPeriod !== ny.dayPeriod;
    return `${time} on ${ny.weekday}, ${MONTHS[Number(ny.month) - 1]} ${ny.day}${elsewhere ? ' (New York time)' : ''}`;
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------- messages
function status(text) {
  $('#ph-status').textContent = text;
}

// Each problem shows beside the thing that fixes it, and the focus goes there too.
const PROBLEM_AT = {
  name: { box: '#ph-name-err', field: '#ph-name' },
  email: { box: '#ph-email-err', field: '#ph-email' },
  photos: { box: '#ph-photos-err', field: '#ph-files' },
  consent: { box: '#ph-err', field: '#ph-consent' },
  send: { box: '#ph-err', field: null }
};

function clearProblems() {
  for (const { box, field } of Object.values(PROBLEM_AT)) {
    $(box).hidden = true;
    $(box).textContent = '';
    if (field) $(field).removeAttribute('aria-invalid');
  }
}

function problem(where, message) {
  clearProblems();
  const { box, field } = PROBLEM_AT[where];
  $(box).textContent = message;
  $(box).hidden = false;
  if (field) {
    $(field).setAttribute('aria-invalid', 'true');
    $(field).focus();
  }
  $(box).scrollIntoView({ block: 'center', behavior: reduceMotion() ? 'auto' : 'smooth' });
}

function pickNote(text) {
  $('#ph-pick-note').textContent = text;
  $('#ph-pick-note').hidden = !text;
}

// ---------------------------------------------------------------- choosing photos
const roomLeft = () => S.left - S.cards.filter((c) => TAKES_ROOM.has(c.state)).length;
const sameFile = (a, b) => a.name === b.name && a.size === b.size && a.lastModified === b.lastModified;
const limitText = () => `You've sent ${plural(S.perPerson, 'photo')}, which is the most one person can send.`;

function addFiles(files) {
  if (S.sending || S.view !== 'form') return;
  clearProblems();
  const notes = [];
  let leftOut = 0;
  for (const file of files) {
    if (S.cards.some((c) => sameFile(c.file, file))) {
      notes.push(`"${file.name}" is already here.`);
    } else if (roomLeft() <= 0) {
      leftOut += 1;
    } else {
      const card = { id: S.nextId++, file, state: 'checking', message: '', verdict: '', prepared: null, previewUrl: '', caption: '', refused: false, shrunk: false, el: document.createElement('li') };
      S.cards.push(card);
      $('#ph-cards').append(card.el);
      paint(card);
    }
  }
  if (leftOut) {
    const most = S.left < S.perPerson ? `You can send ${plural(S.left, 'more photo')}` : `You can send up to ${plural(S.perPerson, 'photo')}`;
    notes.push(`${most}, so ${leftOut === 1 ? '1 of these was' : `${leftOut} of these were`} left out.`);
  }
  pickNote(notes.join(' '));
  refresh();
  checkPhotos();
}

// Makes the chosen photos ready, one after another. Photos chosen while this runs join the line.
async function checkPhotos() {
  if (S.checking) return;
  S.checking = true;
  let done = 0;
  try {
    for (;;) {
      const card = S.cards.find((c) => c.state === 'checking');
      if (!card) break;
      const toGo = S.cards.filter((c) => c.state === 'checking').length;
      if (!S.sending) status(`Checking photo ${done + 1} of ${done + toGo}`);
      let result;
      try {
        result = await prepare(card.file, S.limits);
      } catch {
        result = { ok: false, message: `We couldn't read "${card.file.name}". Try a different photo.` };
      }
      done += 1;
      if (!S.cards.includes(card)) {
        // Removed while it was being checked.
        if (result.previewUrl) URL.revokeObjectURL(result.previewUrl);
        continue;
      }
      card.previewUrl = result.previewUrl || '';
      card.verdict = result.verdict || '';
      card.prepared = result.ok ? result : null;
      card.message = result.ok ? '' : result.message;
      card.state = result.ok ? 'ready' : 'bad';
      paint(card);
      refresh();
    }
  } finally {
    S.checking = false;
    refresh();
    if (!S.sending) status(readyText());
  }
}

function readyText() {
  const ready = S.cards.filter((c) => c.state === 'ready').length;
  const bad = S.cards.filter((c) => c.state === 'bad').length;
  const parts = [];
  if (ready) parts.push(`${plural(ready, 'photo')} ready to send.`);
  if (bad) parts.push(`${plural(bad, 'photo')} can't be used.`);
  return parts.join(' ');
}

function removeCard(card) {
  if (S.sending) return;
  const at = S.cards.indexOf(card);
  if (at < 0) return;
  S.cards.splice(at, 1);
  if (card.previewUrl) URL.revokeObjectURL(card.previewUrl);
  card.el.remove();
  clearProblems();
  pickNote('');
  refresh();
  if (!S.checking) status(readyText());
  if (allSent()) return showDone();
  // The button that had the focus is gone. Put the focus on the next sensible thing.
  const next = S.cards[at] || S.cards[at - 1];
  const target = (next && $('[data-act="remove"]', next.el)) || $('#ph-files');
  if (!target.disabled) target.focus();
}

function clearCards() {
  for (const card of S.cards) {
    if (card.previewUrl) URL.revokeObjectURL(card.previewUrl);
    card.el.remove();
  }
  S.cards = [];
}

// ---------------------------------------------------------------- drawing
function paint(card) {
  card.el.className = `ph-photo is-${card.state}`;
  card.el.dataset.id = String(card.id);
  card.el.innerHTML = cardHTML(card);
}

function setState(card, state) {
  card.state = state;
  paint(card);
}

function cardHTML(card) {
  const name = esc(card.file.name);
  const verdict = VERDICTS[card.verdict];
  const tone = { great: 'ok', good: 'ok', small: 'warn' }[card.verdict] || '';
  const pill = verdict ? `<span class="pd-pill ${tone}">${esc(verdict.label)}</span>` : '';
  const picture = card.previewUrl
    ? `<img class="ph-pic" src="${esc(card.previewUrl)}" alt="${name}" />`
    : `<div class="ph-pic ph-nopic">${NO_PICTURE}</div>`;

  let info = '';
  if (card.state === 'checking') info = '<p class="ph-state">Checking this photo</p>';
  if (card.state === 'ready') {
    const notes = [verdict && verdict.note, card.previewUrl ? '' : "We can't show this one here, but it will be sent."].filter(Boolean);
    info = `${pill}${notes.map((note) => `<p class="ph-note">${esc(note)}</p>`).join('')}`;
  }
  if (card.state === 'bad') info = `<p class="ph-problem">${esc(card.message)}</p>`;
  if (card.state === 'waiting') info = '<p class="ph-state">Waiting to send</p>';
  if (card.state === 'sending') info = '<p class="ph-state">Sending</p><div class="ph-bar"><span></span></div>';
  if (card.state === 'sent') info = '<span class="pd-pill ok">Sent</span>';
  if (card.state === 'failed') info = `<p class="ph-problem">${esc(card.message)}</p>`;

  const locked = card.state === 'waiting' || card.state === 'sending' || card.state === 'sent';
  const hasCaption = card.state === 'ready' || card.state === 'failed' || (locked && card.caption.trim());
  const caption = hasCaption ? `
    <div class="pd-field ph-caption">
      <label for="ph-cap-${card.id}">Caption (optional)<span class="pd-sr"> for ${name}</span></label>
      <input id="ph-cap-${card.id}" type="text" maxlength="80" enterkeyhint="done" autocomplete="off" data-caption value="${esc(card.caption)}"${locked ? ' disabled' : ` aria-describedby="ph-cap-hint-${card.id}"`} />
      ${locked ? '' : `<p class="pd-hint" id="ph-cap-hint-${card.id}">School and year, or a few words. Shown with your photo.</p>`}
    </div>` : '';

  const actions = [];
  if (card.state === 'failed') actions.push(`<button type="button" class="pd-btn small primary" data-act="retry" aria-label="Try again with ${name}">Try again</button>`);
  if (!locked) actions.push(`<button type="button" class="pd-btn small" data-act="remove" aria-label="Remove ${name}">Remove</button>`);

  return `
    ${picture}
    <div class="ph-info">
      ${card.previewUrl ? '' : `<p class="ph-file-name">${name}</p>`}
      ${info}
      ${actions.length ? `<div class="ph-actions">${actions.join('')}</div>` : ''}
    </div>
    ${caption}`;
}

// The Choose photos button, the line under it, and the Send photos button.
function refresh() {
  const room = roomLeft();
  const chosen = S.cards.filter((c) => TAKES_ROOM.has(c.state)).length;
  const input = $('#ph-files');
  input.disabled = S.sending || room <= 0;
  $('#ph-choose').setAttribute('aria-disabled', String(input.disabled));
  $('#ph-send').disabled = S.sending || S.cards.some((c) => c.state === 'checking');
  // After a photo didn't go through, the big button is the obvious way to try it again.
  $('#ph-send').textContent = !S.sending && S.cards.some((c) => c.state === 'failed') ? 'Try again' : 'Send photos';

  let text = `Up to ${plural(S.perPerson, 'photo')}.`;
  if (S.left <= 0) text = limitText();
  else if (!chosen && S.left < S.perPerson) text = `You can send ${plural(S.left, 'more photo')}.`;
  else if (chosen && room <= 0) text = "That's as many as you can send. To swap one, remove it first.";
  else if (chosen) text = `${chosen} chosen. You can add ${room} more.`;
  $('#ph-room').textContent = text;
}

// ---------------------------------------------------------------- sending
const allSent = () => S.sent > 0 && !S.sending && !S.cards.some((c) => TAKES_ROOM.has(c.state));

function whoIsSending() {
  const name = $('#ph-name').value.trim().replace(/\s+/g, ' ');
  const email = $('#ph-email').value.trim();
  if (!name) return problem('name', 'Add your name.');
  if (!EMAIL.test(email) || email.length > 120) return problem('email', 'Add the email you bought your ticket with.');
  // Show the tidied values, so what's on the page is what was sent.
  $('#ph-name').value = name;
  $('#ph-email').value = email;
  return { name, email };
}

// Sends every photo that is ready, or just `only` (a photo's own Try again).
async function sendPhotos(only) {
  if (S.sending) return;
  clearProblems();
  const me = whoIsSending();
  if (!me) return;
  const queue = only ? [only] : S.cards.filter((c) => c.state === 'ready' || c.state === 'failed');
  if (!queue.length) {
    if (S.left <= 0) return problem('send', limitText());
    return problem('photos', S.cards.some((c) => c.state === 'bad') ? "These photos can't be sent. Choose different ones." : 'Choose at least one photo.');
  }
  if (!$('#ph-consent').checked) return problem('consent', 'Check the box to say these are your photos to share.');
  store.set(me);
  pickNote('');

  S.sending = true;
  for (const card of queue) setState(card, 'waiting');
  refresh();
  window.addEventListener('beforeunload', warnBeforeLeaving);
  let stop = null;
  try {
    for (let i = 0; i < queue.length && !stop; i += 1) {
      if (S.left <= 0) {
        stop = { reason: 'limit', message: limitText() };
      } else {
        status(`Sending ${i + 1} of ${queue.length}`);
        setState(queue[i], 'sending');
        stop = await sendOne(queue[i], me);
      }
    }
  } finally {
    window.removeEventListener('beforeunload', warnBeforeLeaving);
    // Whatever didn't go is ready again, so nothing chosen is lost.
    for (const card of queue) if (card.state === 'waiting' || card.state === 'sending') setState(card, 'ready');
    S.sending = false;
    refresh();
  }
  afterSending(stop);
}

// Sends one photo and records how it went on its card. Answers null to carry on with the next
// photo, or { reason, message } when the server's answer means no photo will get through.
async function sendOne(card, me) {
  try {
    const answer = await deliver(card, me);
    S.sent += 1;
    S.left = Number.isInteger(answer.left) ? Math.max(0, answer.left) : S.left - 1;
    S.leftFor = me.email.toLowerCase();
    card.message = '';
    setState(card, 'sent');
    return null;
  } catch (e) {
    const known = e instanceof DropError;
    if (known && STOPS.has(e.reason)) return { reason: e.reason, message: e.message };
    card.message = known ? e.message : 'Something went wrong. Try again.';
    // The server looked at the photo itself and can't use it. Trying again won't change that.
    card.refused = known && e.reason === 'photo';
    setState(card, card.refused ? 'bad' : 'failed');
    return null;
  }
}

// One photo to the server. If the server finds it too large, a smaller copy goes once more.
async function deliver(card, me) {
  try {
    return await inTime((signal) => send(formFor(card, me), signal));
  } catch (e) {
    const tooLarge = e instanceof DropError && (e.status === 413 || e.reason === 'size');
    if (!tooLarge || card.shrunk) throw e;
    card.shrunk = true;
    const again = await smaller(card.file, S.limits);
    if (!again.ok) throw e;
    card.prepared = { ...card.prepared, blob: again.blob, thumb: again.thumb || card.prepared.thumb, width: again.width, height: again.height };
    return inTime((signal) => send(formFor(card, me), signal));
  }
}

// A phone that loses its signal mid-send can leave a request hanging. Give up after a while, so
// the person gets a Try again instead of a page that says "Sending" forever. Giving up stops the
// upload itself, so the next photo doesn't have to share a weak signal with it. If it had already
// arrived, sending it again is safe: the server keeps one copy of a photo.
function inTime(start) {
  const stop = new AbortController();
  let timer;
  const late = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      stop.abort();
      reject(new DropError('That took too long. Check your connection and try again.', { reason: 'network' }));
    }, SEND_TIMEOUT);
  });
  return Promise.race([start(stop.signal), late]).finally(() => clearTimeout(timer));
}

// The fields the function's /send route reads. Text first, then the files.
function formFor(card, me) {
  const photo = card.prepared;
  const form = new FormData();
  form.append('code', S.code);
  form.append('name', me.name);
  form.append('email', me.email);
  form.append('caption', card.caption.trim());
  form.append('width', String(photo.width));
  form.append('height', String(photo.height));
  form.append('original', JSON.stringify(photo.original));
  form.append('website', $('#ph-extra').value);
  form.append('photo', photo.blob, 'photo.jpg');
  if (photo.thumb) form.append('thumb', photo.thumb, 'thumb.jpg');
  return form;
}

function warnBeforeLeaving(e) {
  e.preventDefault();
  e.returnValue = '';
}

// Where the page goes once a send has finished or been stopped.
function afterSending(stop) {
  const unsent = S.cards.filter((c) => TAKES_ROOM.has(c.state)).length;
  const failed = S.cards.filter((c) => c.state === 'failed').length;

  if (stop && stop.reason === 'code') {
    status('');
    return askForCode(CODE_WRONG_LINK);
  }
  if (stop && stop.reason === 'input') {
    status('');
    return problem(/email/i.test(stop.message) ? 'email' : /name/i.test(stop.message) ? 'name' : 'send', stop.message);
  }
  if (stop) {
    // The limit, closed or full: nothing more can go, in the server's own words.
    if (S.sent) return showDone({ note: `${stop.message} ${unsent === 1 ? '1 photo was' : `${unsent} photos were`} not sent.`, more: false });
    status('');
    if (stop.reason === 'limit') return problem('send', stop.message);
    clearCards();
    return show(stop.reason === 'full' ? 'full' : 'closed', { scroll: true });
  }
  if (allSent()) {
    const refused = S.cards.filter((c) => c.refused);
    const why = [...new Set(refused.map((c) => c.message))].join(' ');
    return showDone({ note: refused.length ? `${refused.length === 1 ? "1 photo wasn't" : `${refused.length} photos weren't`} sent. ${why}` : '' });
  }
  const parts = [];
  if (S.sent) parts.push(`${plural(S.sent, 'photo')} sent.`);
  if (failed) parts.push(`${failed === 1 ? "1 photo didn't" : `${failed} photos didn't`} go through. Tap Try again.`);
  else if (!S.sent) parts.push("These photos can't be sent. Choose different ones.");
  status(parts.join(' '));
}

function showDone({ note = '', more = true } = {}) {
  const canSendMore = more && S.left > 0;
  $('#ph-done-title').innerHTML = `<span>${S.sent === 1 ? 'Got it.' : 'Got them.'}</span> <span>Thank you!</span>`;
  $('#ph-done-count').textContent = `We got ${plural(S.sent, 'photo')}.${canSendMore ? ` You can send ${S.left} more.` : ''}`;
  $('#ph-done-note').textContent = note;
  $('#ph-done-note').hidden = !note;
  $('#ph-more').parentElement.hidden = !canSendMore;
  clearCards();
  status('');
  show('done', { scroll: true });
}

function sendMore() {
  S.sent = 0;
  clearCards();
  clearProblems();
  pickNote('');
  status('');
  $('#ph-consent').checked = false; // each batch of photos gets its own yes
  refresh();
  show('form');
  $('#ph-step-photos').scrollIntoView({ block: 'start', behavior: reduceMotion() ? 'auto' : 'smooth' });
  $('#ph-files').focus({ preventScroll: true });
}

// ---------------------------------------------------------------- events
function listen() {
  $('#ph-code-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const code = $('#ph-code-input').value.trim();
    if (!code) return askForCode({ ...CODE_MISSING, error: 'Type the code from your School Daze email.' });
    S.code = code;
    S.typed = true;
    check();
  });
  $('#ph-retry').addEventListener('click', check);
  $('#ph-more').addEventListener('click', sendMore);

  $('#ph-form').addEventListener('submit', (e) => {
    e.preventDefault();
    sendPhotos();
  });
  // Return on a phone's keyboard means "done typing", not "send everything now".
  $('#ph-form').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !e.target.matches('input[type="text"], input[type="email"]')) return;
    e.preventDefault();
    e.target.blur();
  });

  $('#ph-files').addEventListener('change', (e) => {
    addFiles([...e.target.files]);
    e.target.value = ''; // so a photo that was removed can be chosen again
  });
  // A photo dropped anywhere on the page joins the list. Without this the browser would leave the
  // page to show the photo, and everything typed would be lost.
  const carriesFiles = (e) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  document.addEventListener('dragover', (e) => { if (carriesFiles(e)) e.preventDefault(); });
  document.addEventListener('drop', (e) => {
    if (!carriesFiles(e)) return;
    e.preventDefault();
    addFiles([...e.dataTransfer.files]);
  });

  $('#ph-cards').addEventListener('click', (e) => {
    const button = e.target.closest('[data-act]');
    const card = button && S.cards.find((c) => c.el.contains(button));
    if (!card) return;
    if (button.dataset.act === 'remove') removeCard(card);
    if (button.dataset.act === 'retry') sendPhotos(card);
  });
  $('#ph-cards').addEventListener('input', (e) => {
    const card = e.target.matches('[data-caption]') && S.cards.find((c) => c.el.contains(e.target));
    if (card) card.caption = e.target.value;
  });

  // A problem goes away as soon as the person starts fixing it.
  for (const where of ['name', 'email', 'consent']) {
    $(PROBLEM_AT[where].field).addEventListener('input', () => {
      if (!$(PROBLEM_AT[where].box).hidden) clearProblems();
    });
  }
  // The count of photos left belongs to one email. A different email starts fresh.
  $('#ph-email').addEventListener('change', () => {
    if (!S.leftFor || $('#ph-email').value.trim().toLowerCase() === S.leftFor) return;
    S.left = S.perPerson;
    S.leftFor = '';
    refresh();
  });
}

function start() {
  if (!READY) return notReady();
  listen();
  const me = store.get();
  $('#ph-name').value = typeof me.name === 'string' ? me.name.slice(0, 80) : '';
  $('#ph-email').value = typeof me.email === 'string' ? me.email.slice(0, 120) : '';
  S.code = codeFromAddress(['k']);
  if (!S.code) return askForCode(CODE_MISSING);
  check();
}

start();
