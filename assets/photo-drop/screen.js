// School Daze photo drop: the slideshow (school-daze/screen.html). It runs on the venue's computer,
// full screen, for the whole party, with nobody watching over it. Everything here is built to
// keep going: the approved photos come from the photo-drop Edge Function (api.js) once a minute,
// and when that fails, or a photo won't load, the show plays on with what it has.
//
// One clock runs the show: tick() looks a few times a second at what is on screen, what is being
// got ready and what time it is, and makes the one next move. Nothing waits on a chain of
// promises that could stall. At most three photos are in the page at once: the one fading out,
// the one showing, and the next one, loaded and waiting out of sight.
//
// A photo is never stretched past one and a half times its own pixels. A small photo shows as a
// framed print over the blurred ground instead.
import { READY, screen, codeFromAddress } from './api.js';

// Tells the small script in the page that this one arrived.
window.GIL_DROP_STARTED = true;

// screen.html?demo=1 plays six pictures made here and never calls the server.
const DEMO = new URLSearchParams(location.search).get('demo') === '1';

const TICK = 250; // how often tick() looks
const FADE = 1200; // the cross-fade, the same as --sc-fade in screen.css
const CHECK_EVERY = 60000; // ask the server for the approved photos this often
const CHECK_TIMEOUT = 20000;
const LOAD_TIMEOUT = 25000; // a photo that hasn't loaded by now is skipped
const BACK_WAIT = 1500; // how long a loaded photo waits for its blurred background
const RETRY = [1000, 2000, 4000, 8000]; // the pause after one, two, three and more failed loads in a row
const AWAKE_FOR = 3000; // how long the controls and the cursor stay after the mouse moves
const MAX_UPSCALE = 1.5; // the most screen pixels one pixel of a photo may ever cover
const ZOOM = 1.045; // the gentle zoom while a photo shows
const TILT = 1.4; // degrees, for a framed print
const PRINT_ROOM = 0.84; // a print takes no more than this share of the screen it could fill
const SECONDS = [5, 8, 12, 20];
const PAST = 200; // how far back Previous can go
const TEST_PICTURES = [
  { w: 2560, h: 1440, hue: 42, caption: 'Test picture 1 of 6. Wide, 2560 by 1440' },
  { w: 1707, h: 2560, hue: 350, caption: 'Test picture 2 of 6. Tall, 1707 by 2560' },
  { w: 640, h: 480, hue: 205, caption: 'Test picture 3 of 6. Small, 640 by 480. A small photo shows as a print and is never stretched' },
  { w: 2560, h: 1707, hue: 140, caption: 'Test picture 4 of 6. A phone photo, 2560 by 1707' },
  { w: 1600, h: 1600, hue: 275, caption: 'Test picture 5 of 6. Square, 1600 by 1600' },
  { w: 2560, h: 1080, hue: 20, caption: '' } // one without a caption
];

// ---------------------------------------------------------------- helpers
const $ = (s, root = document) => root.querySelector(s);
const stage = $('#sc-stage');
// Time that only runs forward, whatever happens to the computer's clock.
const clock = () => performance.now();
const store = {
  get() { try { return JSON.parse(localStorage.getItem('gil.drop.screen')) || {}; } catch { return {}; } },
  set(kept) { try { localStorage.setItem('gil.drop.screen', JSON.stringify(kept)); } catch { /* private browsing: nothing to keep */ } }
};
// Remembers, for this tab only, that the show was playing, so a reload goes straight back to it
// instead of leaving the setup card on the big screens.
const playing = {
  get() { try { return sessionStorage.getItem('gil.drop.screen.on') === (DEMO ? 'demo' : 'live'); } catch { return false; } },
  set(on) {
    try {
      if (on) sessionStorage.setItem('gil.drop.screen.on', DEMO ? 'demo' : 'live');
      else sessionStorage.removeItem('gil.drop.screen.on');
    } catch { /* nothing to keep */ }
  }
};

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (e) => { clearTimeout(timer); reject(e); });
  });
}

function shuffled(list) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// ---------------------------------------------------------------- state
const S = {
  on: false, // the slideshow is playing (the stage is up)
  starting: false,
  run: 0, // goes up each time the show starts or stops, so a late answer from before is ignored
  code: '',
  seconds: 8,
  order: 'shuffle', // or 'oldest'
  captions: true,
  mark: true,
  photos: new Map(), // id -> { id, url, thumbUrl, caption }: the approved photos, as last heard
  ids: [], // their ids in the server's order, oldest approved first
  queue: [], // the ids still to come in this pass
  past: [], // the ids shown before the one on screen, for Previous
  old: null, // the slide fading out
  now: null, // the slide on screen
  next: null, // the slide being got ready, or ready and waiting
  dueAt: 0, // when the photo on screen has had its time
  left: 0, // while paused: how much of that time was left
  skip: false, // change as soon as the next photo is ready (Next, Previous, a removed photo)
  paused: false,
  retryAt: 0, // after a photo failed to load: don't start another before this
  misses: 0, // failed loads in a row
  prints: 0, // framed prints so far, so their tilt alternates
  asked: 0,
  answered: 0,
  awake: false, // the controls and the cursor are showing
  awakeUntil: 0,
  mouseX: null,
  mouseY: null,
  lock: null, // the screen wake lock
  locking: false, // one is being asked for
  lockAt: 0, // when tick() next checks on it
  ticker: 0,
  checker: 0
};
// A slide: { id, back, ready, main, mainAt, hasBack, startedAt, img, backImg, el, frame, cap, w, h,
// tilt, removeAt }. back: it was asked for with Previous. main: null while the photo loads, then
// true or false. hasBack: the same for its blurred background.

// ---------------------------------------------------------------- the setup card
function notReady() {
  $('#sc-main').innerHTML = '<p class="sc-notready">This page isn\'t set up yet.</p>';
  $('#sc-foot').hidden = true;
}

function status(text) {
  $('#sc-status').textContent = text;
}

// Each problem shows beside the thing that fixes it, and the focus goes there too.
const PROBLEM_AT = {
  code: { box: '#sc-code-err', field: '#sc-code' },
  start: { box: '#sc-err', field: null }
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
}

function fillForm() {
  $('#sc-code').value = S.code;
  for (const el of document.querySelectorAll('#sc-form input[name="seconds"]')) el.checked = Number(el.value) === S.seconds;
  for (const el of document.querySelectorAll('#sc-form input[name="order"]')) el.checked = el.value === S.order;
  $('#sc-captions').checked = S.captions;
  $('#sc-mark').checked = S.mark;
}

function readForm() {
  const chosen = (name) => ($(`#sc-form input[name="${name}"]:checked`) || {}).value;
  S.code = $('#sc-code').value.trim();
  S.seconds = SECONDS.includes(Number(chosen('seconds'))) ? Number(chosen('seconds')) : 8;
  S.order = chosen('order') === 'oldest' ? 'oldest' : 'shuffle';
  S.captions = $('#sc-captions').checked;
  S.mark = $('#sc-mark').checked;
}

const keep = () => store.set({ code: S.code, seconds: S.seconds, order: S.order, captions: S.captions, mark: S.mark });

// "Start the slideshow". Asks the server once before the stage goes up, so a wrong code or a dead
// connection is found while someone is still standing at the computer. `resumed`: the page was
// reloaded while the show was playing, so there is no one to tell and the show just starts.
async function begin({ resumed = false } = {}) {
  if (S.on || S.starting) return;
  readForm();
  clearProblems();
  if (!DEMO && !S.code) return problem('code', 'Type the screen code.');
  // Browsers only allow full screen from inside the click itself.
  if (!resumed) goFull();
  keepAwake();
  S.starting = true;
  $('#sc-start').disabled = true;
  status(DEMO ? 'Making the test pictures.' : 'Getting the photos.');
  let list = [];
  let failed = null;
  try {
    list = DEMO ? await testPictures() : (await withTimeout(screen(S.code), CHECK_TIMEOUT)).photos;
  } catch (e) {
    failed = e || new Error('failed');
  }
  S.starting = false;
  $('#sc-start').disabled = false;
  status('');
  if (failed && !resumed) {
    letSleep();
    if (failed.reason === 'code') return problem('code', "That code isn't right. Check it and try again.");
    return problem('start', DEMO ? "This browser couldn't make the test pictures." : "We couldn't get the photos. Check the connection and try again.");
  }
  keep();
  play(failed ? [] : list);
}

// ---------------------------------------------------------------- starting and stopping the show
function play(list) {
  S.on = true;
  S.run += 1;
  S.paused = false;
  S.skip = false;
  S.dueAt = S.left = S.retryAt = S.misses = S.lockAt = 0;
  S.photos = new Map();
  S.ids = [];
  S.queue = [];
  S.past = [];
  S.old = S.now = S.next = null;
  $('#sc-slides').textContent = '';
  take(list);

  document.documentElement.classList.add('sc-playing');
  $('#sc-wrap').hidden = true;
  stage.hidden = false;
  stage.classList.remove('is-paused', 'is-awake', 'has-photo');
  stage.classList.toggle('no-captions', !S.captions);
  // The zoom runs on through the fade to the next photo.
  stage.style.setProperty('--sc-dwell', `${S.seconds + 2.5}s`);
  $('#sc-mark-text').hidden = !S.mark;
  S.awake = false;
  labels();
  // Keys go to the show, not to the button that started it.
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  stage.focus({ preventScroll: true });

  playing.set(true);
  clearInterval(S.ticker);
  clearInterval(S.checker);
  S.ticker = setInterval(tick, TICK);
  if (!DEMO) S.checker = setInterval(check, CHECK_EVERY);
  tick();
}

// "Setup": back to the setup card.
function stop() {
  S.on = false;
  S.run += 1;
  clearInterval(S.ticker);
  clearInterval(S.checker);
  S.ticker = S.checker = 0;
  cancel(S.next);
  S.old = S.now = S.next = null;
  $('#sc-slides').textContent = '';
  letSleep();
  leaveFull();
  playing.set(false);
  document.documentElement.classList.remove('sc-playing');
  stage.hidden = true;
  stage.classList.remove('is-awake');
  $('#sc-wrap').hidden = false;
  fillForm(); // captions may have been switched from the controls
  $('#sc-setup-title').focus({ preventScroll: true });
}

// ---------------------------------------------------------------- the approved photos
// Asks the server for the approved photos. Any failure (no connection, a server error, a code
// that stopped working) keeps the photos the show already has and waits for the next time round.
async function check() {
  if (!S.on || DEMO) return;
  const run = S.run;
  const asked = ++S.asked;
  let answer;
  try {
    answer = await withTimeout(screen(S.code), CHECK_TIMEOUT);
  } catch {
    return;
  }
  if (!S.on || run !== S.run || asked < S.answered) return; // the show stopped, or a newer answer got here first
  S.answered = asked;
  if (!answer || !Array.isArray(answer.photos)) return;
  take(answer.photos);
  tick();
}

// Takes a fresh list of the approved photos: new ones go to the front of the line, removed ones
// leave it, and a removed photo that is on screen is changed for the next one straight away.
function take(list) {
  const photos = new Map();
  const ids = [];
  const fresh = [];
  for (const p of Array.isArray(list) ? list : []) {
    if (!p || typeof p.id !== 'string' || !p.id || typeof p.url !== 'string' || !p.url || photos.has(p.id)) continue;
    photos.set(p.id, {
      id: p.id,
      url: p.url,
      thumbUrl: typeof p.thumbUrl === 'string' ? p.thumbUrl : '',
      caption: typeof p.caption === 'string' ? p.caption.trim() : ''
    });
    ids.push(p.id);
    if (!S.photos.has(p.id)) fresh.push(p.id);
  }
  // With nothing playing yet, the first pass takes every photo in its turn.
  const underWay = !!(S.now || S.next || S.queue.length);
  const here = (id) => photos.has(id);
  S.photos = photos;
  S.ids = ids;
  S.queue = S.queue.filter(here);
  S.past = S.past.filter(here);
  if (underWay) S.queue.unshift(...fresh);
  if (S.next && !here(S.next.id)) {
    cancel(S.next);
    S.next = null;
  }
  if (S.now && !ids.length) clear();
  else if (S.now && !here(S.now.id)) S.skip = true;
  // A caption an organizer has just fixed shows without waiting for the photo's next turn.
  for (const slide of [S.now, S.next]) {
    if (slide && slide.ready && here(slide.id)) say(slide, photos.get(slide.id).caption);
  }
}

// The next photo to get ready, or null when the one on screen is the only one there is.
// Shuffle is a shuffled pass through every photo, then a new shuffle. Never the same photo
// twice in a row.
function nextId() {
  const on = S.now ? S.now.id : '';
  for (let tries = 0; tries < 2; tries++) {
    if (!S.queue.length) {
      const pass = S.order === 'shuffle' ? shuffled(S.ids) : [...S.ids];
      if (pass.length > 2 && pass[0] === on) {
        // The new pass would open with the photo on screen: send it further back.
        const to = 1 + Math.floor(Math.random() * (pass.length - 1));
        [pass[0], pass[to]] = [pass[to], pass[0]];
      }
      S.queue = pass;
    }
    const at = S.queue.findIndex((id) => id !== on);
    if (at >= 0) return S.queue.splice(at, 1)[0];
    S.queue = []; // only the photo on screen was left in this pass: start the next one
  }
  return null;
}

// ---------------------------------------------------------------- the clock
// Looks at the show and makes the next move. Runs every quarter second while the show plays, and
// straight away when something happens (a key, a photo arriving, a fresh list).
function tick() {
  if (!S.on) return;
  const t = clock();

  // The photo that has faded out leaves the page.
  if (S.old && t >= S.old.removeAt) {
    S.old.el.remove();
    S.old = null;
  }

  // The photo being got ready: has it arrived, failed, or taken too long?
  const coming = S.next;
  if (coming && !coming.ready) {
    if (coming.main === false || (coming.main === null && t - coming.startedAt >= LOAD_TIMEOUT)) miss(t);
    else if (coming.main && (coming.hasBack !== null || t - coming.mainAt >= BACK_WAIT) && !build(coming)) miss(t);
  }

  // Time to change photos. The first photo shows as soon as it is ready.
  if (S.next && S.next.ready && (S.skip || !S.now || (!S.paused && t >= S.dueAt))) change(t);

  // Start getting the one after ready.
  if (!S.next && t >= S.retryAt) {
    const id = nextId();
    if (id) prepare(id, false, t);
    else S.skip = false; // there is nothing else to change to
  }

  if (S.awake && t >= S.awakeUntil) sleep();
  // A wake lock can be taken away (a low battery, a power setting). Take it back.
  if (t >= S.lockAt) {
    S.lockAt = t + 60000;
    keepAwake();
  }
}

// ---------------------------------------------------------------- one photo
// Resolves true when the picture has loaded and can be drawn, false when it can't. Never rejects.
function arrived(img) {
  const usable = () => img.complete && img.naturalWidth > 0;
  if (typeof img.decode === 'function') return img.decode().then(() => true, usable);
  return new Promise((resolve) => {
    img.onload = () => resolve(true);
    img.onerror = () => resolve(false);
  });
}

// Starts loading a photo, out of the page. tick() puts it in the page once it has arrived.
function prepare(id, back, t) {
  const photo = S.photos.get(id);
  const slide = { id, back, ready: false, main: null, mainAt: 0, hasBack: null, startedAt: t, img: new Image(), backImg: null, el: null, frame: null, cap: null, w: 0, h: 0, tilt: 0, removeAt: 0 };
  S.next = slide;
  slide.img.alt = '';
  slide.img.decoding = 'async';
  slide.img.src = photo.url;
  arrived(slide.img).then((ok) => {
    slide.main = ok;
    slide.mainAt = clock();
    if (S.next === slide) tick();
  });
  // The blurred background is the small copy of the photo. The slide can do without it.
  if (photo.thumbUrl) {
    slide.backImg = new Image();
    slide.backImg.alt = '';
    slide.backImg.src = photo.thumbUrl;
    arrived(slide.backImg).then((ok) => {
      slide.hasBack = ok;
      if (S.next === slide) tick();
    });
  } else {
    slide.hasBack = false;
  }
}

// Lets go of a slide that will never show, and stops its downloads if they are still under way.
function cancel(slide) {
  if (!slide) return;
  if (slide.el) slide.el.remove();
  slide.img.removeAttribute('src');
  if (slide.backImg) slide.backImg.removeAttribute('src');
}

// The photo being got ready didn't load. It is skipped for this pass and tried again on the next.
// After a failure the show waits a little before starting another load, so a dead connection
// means one quiet try every few seconds, not a storm.
function miss(t) {
  const slide = S.next;
  cancel(slide);
  S.next = null;
  S.misses += 1;
  S.retryAt = t + RETRY[Math.min(S.misses, RETRY.length) - 1];
  // Previous couldn't get its photo: stay on this one rather than jump ahead.
  if (slide.back) S.skip = !!S.now && !S.photos.has(S.now.id);
}

function say(slide, caption) {
  slide.cap.firstChild.textContent = caption;
  slide.cap.hidden = !caption;
}

// Puts a loaded photo in the page, see-through, on top of the one showing. False when the
// picture turned out to have no size.
function build(slide) {
  const photo = S.photos.get(slide.id);
  slide.w = slide.img.naturalWidth;
  slide.h = slide.img.naturalHeight;
  if (!photo || !slide.w || !slide.h) return false;
  const el = document.createElement('div');
  el.className = 'sc-slide';
  el.dataset.id = slide.id;
  if (slide.hasBack) {
    slide.backImg.className = 'sc-back';
    el.append(slide.backImg);
  } else if (slide.backImg) {
    slide.backImg.removeAttribute('src'); // too slow or broken: the ground stays black
    slide.backImg = null;
  }
  slide.frame = document.createElement('div');
  slide.frame.className = 'sc-frame';
  slide.img.className = 'sc-photo';
  slide.frame.append(slide.img);
  slide.cap = document.createElement('p');
  slide.cap.className = 'sc-caption';
  slide.cap.append(document.createElement('span'));
  el.append(slide.frame, slide.cap);
  slide.el = el;
  say(slide, photo.caption);
  layout(slide);
  $('#sc-slides').append(el);
  slide.ready = true;
  return true;
}

// Sizes a photo for the screen. It fills the screen as far as its shape allows, unless that would
// stretch it past MAX_UPSCALE screen pixels for each of its own: then it shows as a framed print
// at that size or under. The count is in real screen pixels, so a screen the computer scales
// (a 4K screen set to 200%) gets the same answer as one it doesn't.
function layout(slide) {
  const W = stage.clientWidth;
  const H = stage.clientHeight;
  if (!W || !H || !slide.el) return;
  const most = MAX_UPSCALE / (window.devicePixelRatio || 1);
  const fit = Math.min(W / slide.w, H / slide.h);
  const print = fit > most;
  let scale = fit;
  let from = 1;
  let to = 1;
  if (print) {
    if (!slide.tilt) slide.tilt = (S.prints++ % 2 ? 1 : -1) * TILT;
    // A tilted print is a little wider and taller on screen than the photo in it. Count that too.
    const turn = (Math.abs(slide.tilt) * Math.PI) / 180;
    const cos = Math.cos(turn);
    const sin = Math.sin(turn);
    scale = Math.min((most * slide.w) / (slide.w * cos + slide.h * sin), (most * slide.h) / (slide.h * cos + slide.w * sin), fit * PRINT_ROOM);
    from = 0.965; // the print grows to its full size and stops there
  } else {
    to = Math.max(1, Math.min(ZOOM, most / fit)); // the zoom stops at the limit too
  }
  slide.el.classList.toggle('is-print', print);
  slide.frame.style.width = `${print ? Math.floor(slide.w * scale) : Math.min(W, Math.round(slide.w * scale))}px`;
  slide.frame.style.height = `${print ? Math.floor(slide.h * scale) : Math.min(H, Math.round(slide.h * scale))}px`;
  slide.frame.style.setProperty('--sc-tilt', `${print ? slide.tilt : 0}deg`);
  slide.frame.style.setProperty('--sc-from', String(from));
  slide.frame.style.setProperty('--sc-to', String(to));
}

// The next photo fades in over the one showing, which leaves the page once it is covered.
function change(t) {
  const slide = S.next;
  S.next = null;
  if (S.old) S.old.el.remove();
  S.old = S.now;
  if (S.old) {
    S.old.removeAt = t + FADE + 300;
    if (!slide.back && S.photos.has(S.old.id)) {
      S.past.push(S.old.id);
      if (S.past.length > PAST) S.past.shift();
    }
  }
  S.now = slide;
  void slide.el.offsetWidth; // so the fade starts from clear, even for a photo that only just arrived
  slide.el.classList.add('is-on');
  stage.classList.add('has-photo');
  S.dueAt = t + S.seconds * 1000;
  S.left = S.seconds * 1000;
  S.skip = false;
  S.misses = 0;
}

// No approved photos are left: the one on screen fades away to the title card.
function clear() {
  if (S.old) S.old.el.remove();
  S.old = S.now;
  S.now = null;
  if (S.old) {
    S.old.el.classList.add('is-leaving');
    S.old.removeAt = clock() + FADE + 300;
  }
  stage.classList.remove('has-photo');
  S.skip = false;
}

// ---------------------------------------------------------------- the controls
function next() {
  if (!S.on) return;
  S.skip = true;
  tick();
}

function previous() {
  if (!S.on || !S.now || !S.past.length) return;
  const id = S.past.pop();
  // The photo that was waiting, and the one on screen, go back to the front of the line, so
  // Next after Previous retraces the same steps.
  const waiting = S.next;
  if (waiting) {
    S.queue.unshift(waiting.id);
    cancel(waiting);
    S.next = null;
  }
  if (!(waiting && waiting.back)) S.queue.unshift(S.now.id);
  prepare(id, true, clock());
  S.skip = true;
  tick();
}

function pause(on) {
  if (!S.on || on === S.paused) return;
  const t = clock();
  if (on) S.left = Math.max(0, S.dueAt - t);
  else S.dueAt = t + Math.max(S.left, FADE);
  S.paused = on;
  stage.classList.toggle('is-paused', on); // holds the zoom too
  labels();
}

function captions(on) {
  S.captions = on;
  stage.classList.toggle('no-captions', !on);
  keep();
  labels();
}

function labels() {
  $('[data-act="pause"]', stage).textContent = S.paused ? 'Play' : 'Pause';
  $('[data-act="captions"]', stage).setAttribute('aria-pressed', String(S.captions));
  $('[data-act="full"]', stage).textContent = isFull() ? 'Leave full screen' : 'Full screen';
}

function act(name) {
  if (name === 'pause') pause(!S.paused);
  if (name === 'previous') previous();
  if (name === 'next') next();
  if (name === 'captions') captions(!S.captions);
  if (name === 'full') toggleFull();
  if (name === 'setup') stop();
}

// The controls and the cursor show for a few seconds after the mouse moves or the screen is
// tapped. tick() hides them again.
function wake() {
  if (!S.on) return;
  S.awake = true;
  S.awakeUntil = clock() + AWAKE_FOR;
  stage.classList.add('is-awake');
}

function sleep() {
  S.awake = false;
  stage.classList.remove('is-awake');
  // A control left holding the keyboard's focus would take the next press of Space for itself.
  if ($('#sc-bar').contains(document.activeElement)) stage.focus({ preventScroll: true });
}

function keys(e) {
  if (!S.on || e.altKey || e.ctrlKey || e.metaKey) return;
  const onControl = e.target instanceof Element && !!e.target.closest('#sc-bar');
  switch (e.key) {
    case ' ':
    case 'Spacebar':
      if (onControl) return; // the control in focus takes it
      e.preventDefault();
      if (!e.repeat) pause(!S.paused);
      break;
    case 'ArrowRight':
    case 'ArrowDown':
    case 'PageDown': // a presenter's clicker sends these
      e.preventDefault();
      next();
      break;
    case 'ArrowLeft':
    case 'ArrowUp':
    case 'PageUp':
      e.preventDefault();
      previous();
      break;
    case 'f':
    case 'F':
      if (!e.repeat) toggleFull();
      break;
    case 'c':
    case 'C':
      if (!e.repeat) captions(!S.captions);
      break;
    case 'Escape':
      leaveFull();
      break;
    case 'Tab':
      wake(); // so the keyboard can reach the controls
      break;
    default:
  }
}

// ---------------------------------------------------------------- full screen and staying awake
// Both are extras. Where a browser has neither, or says no, the show plays on in its window.
const isFull = () => !!(document.fullscreenElement || document.webkitFullscreenElement);

function goFull() {
  if (isFull()) return;
  const page = document.documentElement;
  try {
    const asked = page.requestFullscreen ? page.requestFullscreen({ navigationUI: 'hide' }) : page.webkitRequestFullscreen ? page.webkitRequestFullscreen() : null;
    if (asked && asked.catch) asked.catch(() => {});
  } catch { /* not allowed here */ }
}

function leaveFull() {
  if (!isFull()) return;
  try {
    const left = document.exitFullscreen ? document.exitFullscreen() : document.webkitExitFullscreen ? document.webkitExitFullscreen() : null;
    if (left && left.catch) left.catch(() => {});
  } catch { /* nothing to leave */ }
}

const toggleFull = () => (isFull() ? leaveFull() : goFull());

// Keeps the screen from dimming or sleeping. The browser drops the lock whenever the page is
// hidden, so it is taken again when the page comes back, and tick() checks on it every minute.
async function keepAwake() {
  if (S.locking || (S.lock && !S.lock.released)) return;
  try {
    if (!navigator.wakeLock || document.visibilityState !== 'visible') return;
    S.locking = true;
    const lock = await navigator.wakeLock.request('screen');
    if (S.on || S.starting) S.lock = lock;
    else lock.release().catch(() => {}); // the show stopped in the meantime
  } catch {
    // No wake lock here: the computer's own power settings decide.
  } finally {
    S.locking = false;
  }
}

function letSleep() {
  const lock = S.lock;
  S.lock = null;
  try {
    if (lock && !lock.released) lock.release().catch(() => {});
  } catch { /* already gone */ }
}

// ---------------------------------------------------------------- the test pictures
// Six pictures drawn here, in different shapes and sizes, one of them small. The big numbers and
// fine lines show at a glance whether the venue's screen is sharp.
let pictures = null;

async function testPictures() {
  if (pictures) return pictures;
  const list = [];
  for (const [i, picture] of TEST_PICTURES.entries()) {
    const url = await paint(picture, i + 1, 1);
    const thumbUrl = await paint(picture, i + 1, 480 / Math.max(picture.w, picture.h));
    list.push({ id: `test-${i + 1}`, url, thumbUrl, width: picture.w, height: picture.h, caption: picture.caption });
  }
  pictures = list;
  return list;
}

function paint({ w, h, hue }, number, scale) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no canvas');
  ctx.scale(canvas.width / w, canvas.height / h);
  const ground = ctx.createLinearGradient(0, 0, w, h);
  ground.addColorStop(0, `hsl(${hue}, 70%, 20%)`);
  ground.addColorStop(0.55, `hsl(${(hue + 30) % 360}, 75%, 40%)`);
  ground.addColorStop(1, `hsl(${(hue + 70) % 360}, 80%, 60%)`);
  ctx.fillStyle = ground;
  ctx.fillRect(0, 0, w, h);
  const unit = Math.min(w, h);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
  ctx.lineWidth = Math.max(1, unit / 360);
  for (let ring = 1; ring <= 6; ring++) {
    ctx.beginPath();
    ctx.arc(w * 0.74, h * 0.42, ring * unit * 0.065, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';
  for (let bar = 0; bar < 24; bar += 2) ctx.fillRect(w * 0.06 + bar * unit * 0.008, h * 0.66, unit * 0.008, unit * 0.16);
  ctx.fillStyle = '#fff3bf';
  ctx.font = `700 ${Math.round(unit * 0.26)}px Georgia, "Times New Roman", serif`;
  ctx.fillText(String(number), w * 0.06, h * 0.4);
  ctx.font = `700 ${Math.round(unit * 0.075)}px Georgia, "Times New Roman", serif`;
  ctx.fillText(`${w} x ${h}`, w * 0.06, h * 0.54);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      canvas.width = canvas.height = 0;
      if (blob) resolve(URL.createObjectURL(blob));
      else reject(new Error('no picture'));
    }, 'image/jpeg', 0.9);
  });
}

// ---------------------------------------------------------------- events and start
function listen() {
  $('#sc-form').addEventListener('submit', (e) => {
    e.preventDefault();
    begin();
  });
  // A problem goes away as soon as the person starts fixing it.
  $('#sc-code').addEventListener('input', clearProblems);

  stage.addEventListener('pointermove', (e) => {
    // When the picture under a still mouse changes, browsers send a move of their own. Only a
    // mouse that has really moved brings the controls up.
    if (e.screenX === S.mouseX && e.screenY === S.mouseY) return;
    S.mouseX = e.screenX;
    S.mouseY = e.screenY;
    wake();
  });
  stage.addEventListener('pointerdown', wake);
  // A click on a control doesn't leave the keyboard's focus on it.
  $('#sc-bar').addEventListener('mousedown', (e) => e.preventDefault());
  $('#sc-bar').addEventListener('click', (e) => {
    const button = e.target.closest('[data-act]');
    if (!button) return;
    act(button.dataset.act);
    wake();
  });
  document.addEventListener('keydown', keys);

  // The screen changed size (full screen came or went): fit the photos again.
  window.addEventListener('resize', () => {
    for (const slide of [S.old, S.now, S.next]) if (slide && slide.ready) layout(slide);
  });
  for (const name of ['fullscreenchange', 'webkitfullscreenchange']) document.addEventListener(name, labels);
  document.addEventListener('visibilitychange', () => {
    if (S.on && document.visibilityState === 'visible') keepAwake();
  });
}

function start() {
  if (!READY) return notReady();
  listen();
  const kept = store.get();
  S.code = (codeFromAddress(['c']) || (typeof kept.code === 'string' ? kept.code : '')).slice(0, 120);
  S.seconds = SECONDS.includes(kept.seconds) ? kept.seconds : 8;
  S.order = kept.order === 'oldest' ? 'oldest' : 'shuffle';
  S.captions = kept.captions !== false;
  S.mark = kept.mark !== false;
  fillForm();
  if (DEMO) {
    $('#sc-code-field').hidden = true;
    $('#sc-demo-note').hidden = false;
    $('#sc-demo-line').hidden = true;
    $('#sc-real-link').href = `screen.html${location.hash}`;
  } else {
    $('#sc-demo-link').href = `screen.html?demo=1${location.hash}`;
  }
  $('#sc-loading').hidden = true;
  $('#sc-setup').hidden = false;
  $('#sc-how').hidden = false;
  if (playing.get() && (DEMO || S.code)) begin({ resumed: true });
}

start();
