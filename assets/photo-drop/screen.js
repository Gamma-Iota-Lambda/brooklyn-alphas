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
// When photos stop arriving, or crawl, the show does not wait for them. It keeps its pace on the
// photos the browser already has, and tries the others behind the scenes, one at a time, until
// one comes down quickly again. "The slow connection" below has the rules.
//
// A photo is never stretched past one and a half times its own pixels. A small photo shows as a
// framed print over the blurred ground instead.
//
// The committee's videos play in between the photos: one after every so many photos, taking
// turns. A video goes on screen only once the whole file is on this computer (clips.js brings
// them down when the photos are not using the connection), so it never stops to load. "The
// videos" below has the rules. With no videos in the show, none of it does anything.
import { READY, screen, codeFromAddress } from './api.js';
import { createClips } from './clips.js';

// Tells the small script in the page that this one arrived.
window.GIL_DROP_STARTED = true;

// screen.html?demo=1 plays six pictures made here and never calls the server.
const DEMO = new URLSearchParams(location.search).get('demo') === '1';

const TICK = 250; // how often tick() looks
const FADE = 1200; // the cross-fade, the same as --sc-fade in screen.css
const CHECK_EVERY = 60000; // ask the server for the approved photos this often
const CHECK_TIMEOUT = 20000;
const LOAD_TIMEOUT = 25000; // a photo that hasn't loaded by now is waited for no longer
const PATIENCE = 3000; // how far past its time the photo on screen may run for a slow next one, when there is another to show
const CACHED_WAIT = 4000; // a photo the browser already has loads at once: one that hasn't by now is one it doesn't have
const TRY_TIMEOUT = 90000; // how long one try behind the scenes may take
const STUCK = 30000; // a try whose small copy of the photo hasn't come by now is not slow, it is stuck
const TRY_PAUSE = [2000, 4000, 8000, 15000]; // the pause after one, two, three and more of those tries failed in a row
const QUICK = 4000; // a photo that comes down within this says photos are arriving quickly again
const AHEAD = 2; // the tries hold off while this many photos have arrived and not yet had their first turn
const REST = 1000; // after a download is let go of, how long before the network is asked for a photo again
const DECODE_WAIT = 3000; // a photo that has loaded but never says it is ready to draw is shown anyway after this
const BACK_WAIT = 1500; // how long a loaded photo waits for its blurred background
const RETRY = [1000, 2000, 4000, 8000]; // the pause after one, two, three and more failed loads in a row, before the network is asked again
const AWAKE_FOR = 3000; // how long the controls and the cursor stay after the mouse moves
const MAX_UPSCALE = 1.5; // the most screen pixels one pixel of a photo may ever cover
const ZOOM = 1.045; // the gentle zoom while a photo shows
const TILT = 1.4; // degrees, for a framed print
const PRINT_ROOM = 0.84; // a print takes no more than this share of the screen it could fill
const SECONDS = [5, 8, 12, 20];
const PAST = 200; // how far back Previous can go
const EVERY = [5, 10, 20]; // the choices for how many photos go by between two videos
const CLIP_WAIT = 8000; // a video on this computer that hasn't shown its first picture by now is left out
const CLIP_MAX = 3600000; // the longest a video stays on screen, whatever length its file claims
const PAUSE_MAX = 180000; // a pause ends by itself after this: nobody is at this computer all night
// A picture with nothing in it. An Image that is let go of is given this in place of its photo:
// that stops the download, if it is still under way, and answers anything waiting on it. Just
// taking the photo's address away does not: Chrome then keeps the Image, and the slide it was
// for, in memory for good.
const BLANK = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';
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

// Remembers which photos have been on screen, the latest last, each with the end of the link it
// came from. The browser's cache still holds them after a reload, or after the browser has been
// started again, so the show can open with them and go round them while the connection is slow.
const seen = {
  get() {
    try {
      const kept = JSON.parse(localStorage.getItem('gil.drop.screen.seen'));
      return Array.isArray(kept) ? kept.filter((mark) => typeof mark === 'string') : [];
    } catch { return []; }
  },
  set(marks) { try { localStorage.setItem('gil.drop.screen.seen', JSON.stringify(marks)); } catch { /* nothing to keep */ } }
};
const markOf = (photo) => `${photo.id} ${photo.url.slice(-24)}`;

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (e) => { clearTimeout(timer); reject(e); });
  });
}

// Asks the server for the approved photos. A request that has had no answer in time is let go
// of, not just given up on: left open on a connection that has stopped, they pile up, one a
// minute, and can end up holding back the photos themselves.
function ask() {
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), CHECK_TIMEOUT);
  const done = () => clearTimeout(timer);
  // Letting go ends the wait by itself. The second clock is for a browser where it doesn't.
  const answer = withTimeout(screen(S.code, stop.signal), CHECK_TIMEOUT + 2000);
  answer.then(done, done);
  return answer;
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
  every: 10, // a video plays after this many photos
  sound: false, // the videos play with their sound
  since: 0, // photos shown since a video last went up
  clipLine: [], // the videos still to have their turn this round
  lastClip: '', // the video that played last, so a new round doesn't open with it again
  photos: new Map(), // id -> { id, url, thumbUrl, caption }: the approved photos, as last heard
  ids: [], // their ids in the server's order, oldest approved first
  queue: [], // the ids still to come in this pass
  past: [], // the ids shown before the one on screen, for Previous
  shown: new Set(), // every id that has been on screen, the latest last: the browser has these photos already
  ready: new Set(), // ids that arrived behind the scenes and wait for their first turn: it has these too
  old: null, // the slide fading out
  now: null, // the slide on screen
  next: null, // the slide being got ready, or ready and waiting
  dueAt: 0, // when the photo on screen has had its time
  left: 0, // while paused: how much of that time was left
  skip: false, // change as soon as the next photo is ready (Next, Previous, a removed photo)
  paused: false,
  retryAt: 0, // after a photo failed to load: don't ask the network for another before this
  misses: 0, // failed loads since a photo last went up
  slow: false, // photos are failing or crawling: the show goes round the ones the browser has
  trying: null, // the photo being tried behind the scenes meanwhile (a slide that never reaches the page)
  tryAt: 0, // don't start another try before this
  fails: 0, // tries that failed in a row
  tried: new Set(), // ids tried and not got on this round of tries
  kept: new Set(), // ids that were set aside as too slow and given their place in the line back
  down: false, // the last check got no answer from the server at all
  pausedAt: 0,
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
// A slide: { id, back, cached, ready, main, mainAt, loadedAt, hasBack, startedAt, img, backImg, el,
// frame, cap, w, h, tilt, removeAt }. back: it was asked for with Previous. cached: the browser
// had the photo already when this load began. main: null while the photo loads, then true or
// false. hasBack: the same for its blurred background.

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
  for (const el of document.querySelectorAll('#sc-form input[name="every"]')) el.checked = Number(el.value) === S.every;
  $('#sc-sound').checked = S.sound;
}

function readForm() {
  const chosen = (name) => ($(`#sc-form input[name="${name}"]:checked`) || {}).value;
  S.code = $('#sc-code').value.trim();
  S.seconds = SECONDS.includes(Number(chosen('seconds'))) ? Number(chosen('seconds')) : 8;
  S.order = chosen('order') === 'oldest' ? 'oldest' : 'shuffle';
  S.captions = $('#sc-captions').checked;
  S.mark = $('#sc-mark').checked;
  S.every = EVERY.includes(Number(chosen('every'))) ? Number(chosen('every')) : 10;
  S.sound = $('#sc-sound').checked;
}

const keep = () => store.set({ code: S.code, seconds: S.seconds, order: S.order, captions: S.captions, mark: S.mark, every: S.every, sound: S.sound });

// "Start the slideshow". Asks the server once before the stage goes up, so a wrong code or a dead
// connection is found while someone is still standing at the computer. `resumed`: the page was
// reloaded while the show was playing, so there is no one to tell and the show just starts,
// unless the server refuses the code: then there is nothing it could ever show.
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
  let videos = null; // null: no answer from the server, so nothing is known about the videos
  let failed = null;
  try {
    if (DEMO) {
      list = await testPictures();
    } else {
      const answer = await ask();
      list = answer.photos;
      videos = Array.isArray(answer.videos) ? answer.videos : [];
    }
  } catch (e) {
    failed = e || new Error('failed');
  }
  S.starting = false;
  $('#sc-start').disabled = false;
  status('');
  if (failed && (!resumed || failed.reason === 'code')) {
    letSleep();
    if (failed.reason === 'code') return problem('code', "That code isn't right. Check it and try again.");
    return problem('start', DEMO ? "This browser couldn't make the test pictures." : "We couldn't get the photos. Check the connection and try again.");
  }
  keep();
  play(failed ? [] : list, failed ? null : videos);
}

// ---------------------------------------------------------------- starting and stopping the show
function play(list, videos = null) {
  S.on = true;
  S.run += 1;
  S.paused = false;
  S.skip = false;
  S.dueAt = S.left = S.retryAt = S.misses = S.lockAt = S.tryAt = S.fails = 0;
  S.slow = S.down = false;
  S.photos = new Map();
  S.ids = [];
  S.queue = [];
  S.past = [];
  S.shown = new Set();
  S.ready = new Set();
  S.tried = new Set();
  S.kept = new Set();
  S.since = 0;
  S.clipLine = [];
  S.lastClip = '';
  S.old = S.now = S.next = S.trying = null;
  $('#sc-slides').textContent = '';
  take(list);
  if (videos) takeClips(videos);
  // The photos this browser showed before, if they are still in the show under the same link.
  if (!DEMO) {
    for (const mark of seen.get()) {
      const photo = S.photos.get(mark.split(' ')[0]);
      if (photo && markOf(photo) === mark) S.shown.add(photo.id);
    }
  }

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
  cancel(S.trying);
  discard(S.now);
  discard(S.old);
  S.old = S.now = S.next = S.trying = null;
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
    answer = await ask();
  } catch (e) {
    // No answer at all, which is not the same as the server saying no.
    if (S.on && run === S.run && !(e && e.status)) S.down = true;
    return;
  }
  if (!S.on || run !== S.run || asked < S.answered) return; // the show stopped, or a newer answer got here first
  S.answered = asked;
  if (!answer || !Array.isArray(answer.photos)) return;
  take(answer.photos);
  takeClips(answer.videos);
  // This small answer getting through doesn't say photos will: a slow connection carries it and
  // still crawls on a photo. But the first answer after the server couldn't be reached at all
  // means the connection has just come back, so a try that began before it did starts afresh.
  if (S.down) {
    S.down = false;
    again();
  }
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
    const was = S.photos.get(p.id);
    if (!was) fresh.push(p.id);
    else if (was.url !== p.url) forget(p.id); // a new link: the browser has nothing under it yet
  }
  // With nothing playing yet, the first pass takes every photo in its turn.
  const underWay = !!(S.now || S.next || S.queue.length);
  const here = (id) => photos.has(id);
  S.photos = photos;
  S.ids = ids;
  S.queue = S.queue.filter(here);
  S.past = S.past.filter(here);
  for (const set of [S.shown, S.ready, S.tried, S.kept]) {
    for (const id of [...set]) if (!here(id)) set.delete(id);
  }
  if (underWay) S.queue.unshift(...fresh);
  if (S.next && !S.next.video && !here(S.next.id)) {
    cancel(S.next);
    S.next = null;
  }
  if (S.trying && !here(S.trying.id)) {
    cancel(S.trying);
    S.trying = null;
  }
  // A photo taken out of the show leaves the screen now: for the next one if it is ready or the
  // browser has one to put up (see `gone` in tick), for the title card if not.
  if (S.now && !S.now.video && !here(S.now.id)) {
    if ((S.next && S.next.ready) || spare()) S.skip = true;
    else clear();
  }
  // A caption an organizer has just fixed shows without waiting for the photo's next turn.
  for (const slide of [S.now, S.next]) {
    if (slide && slide.ready && here(slide.id)) say(slide, photos.get(slide.id).caption);
  }
}

// The next photo to get ready, as { id, fill }, or null when the one on screen is the only one
// there is. Shuffle is a shuffled pass through every photo, then a new shuffle. Never the same
// photo twice in a row. On a slow connection the pass skips the photos the browser doesn't have,
// as long as it has one to go to: they stay in the line and are tried behind the scenes. When
// they are all that is left of the pass, it keeps its place, and a photo that has been on
// screen before fills in (`fill`) until one of them arrives.
function nextId() {
  const on = S.now ? S.now.id : '';
  const trying = S.trying ? S.trying.id : '';
  // Nothing on screen, and the browser has photos (the page was reloaded, or the photo that was
  // on screen has been taken out of the show): the one it showed last is the surest to be there.
  if (!on && !S.ready.size && S.shown.size) return { id: [...S.shown].pop(), fill: true };
  const held = S.slow && spare();
  const fits = (id) => id !== on && id !== trying && (!held || has(id));
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
    // One that has just been tried and didn't come waits behind the others, if there are any.
    let at = S.queue.findIndex((id) => fits(id) && !S.tried.has(id));
    if (at < 0) at = S.queue.findIndex(fits);
    if (at >= 0) return { id: S.queue.splice(at, 1)[0], fill: false };
    if (held && S.queue.some((id) => id !== on && id !== trying)) {
      const id = filler(on);
      if (id) return { id, fill: true };
    }
    S.queue = []; // nothing in this pass can follow the photo on screen: start the next one
  }
  return null;
}

// The photo to fill in while the pass waits on the network: of the ones the browser has, the one
// the room saw longest ago. (S.shown keeps them in the order they were last on screen.)
function filler(on) {
  for (const set of [S.ready, S.shown]) {
    for (const id of set) if (id !== on) return id;
  }
  return '';
}

// ---------------------------------------------------------------- the slow connection
// Two failed loads in a row, or one photo too slow to wait for, and the show stops counting on
// the network (S.slow). The photos that have been on screen are still in the browser's cache, so
// it goes round those at its usual pace. Meanwhile the photos it doesn't have are tried behind
// the scenes, one at a time and with plenty of time each, and each one that arrives goes to the
// front of the line. The show counts on the network again only when a photo comes down quickly.
// The server answering its small check is not that: a slow connection carries the check and
// still takes a minute over a photo.

// The browser has this photo: it has been on screen, or it arrived behind the scenes.
const has = (id) => S.shown.has(id) || S.ready.has(id);

function forget(id) {
  S.shown.delete(id);
  S.ready.delete(id);
}

// The browser didn't have a photo the show thought it had. With nothing on screen, that was the
// photo it showed last, the surest of them, so it stops counting on the rest as well. And a
// photo that has been taken out of the show doesn't stay up for a second guess.
function mistaken(id) {
  forget(id);
  if (!S.now) S.shown.clear();
  else if (!inShow(S.now)) clear();
}

// Is there a photo the browser has, other than the one on screen, for the show to go to?
function spare() {
  const on = S.now ? S.now.id : '';
  for (const set of [S.ready, S.shown]) {
    for (const id of set) if (id !== on) return true;
  }
  return false;
}

// How long a photo took to come down.
const took = (slide) => (slide.loadedAt || slide.mainAt) - slide.startedAt;

// The photo being got ready is too slow to wait for. It carries on loading behind the scenes,
// if nothing else is being tried there, and the show moves on. It was taken out of the line
// for a turn it hasn't had, so it gets its place at the front back: once (S.kept), so that a
// photo that never comes can't hold the line up every time round.
function aside() {
  const slide = S.next;
  S.next = null;
  S.slow = true;
  if (slide.back) {
    // Previous couldn't get its photo: stay on this one rather than jump ahead.
    S.skip = !!S.now && !inShow(S.now);
  } else if (!slide.fill && !S.kept.has(slide.id)) {
    S.kept.add(slide.id);
    S.queue = [slide.id, ...S.queue.filter((id) => id !== slide.id)];
  }
  if (S.trying) cancel(slide);
  else S.trying = slide;
}

// The next photo to try behind the scenes: one the browser doesn't have, in the order the show
// would come to it. One that didn't arrive waits until the others have had their try. Null when
// the browser has them all.
function nextTry() {
  const coming = S.next ? S.next.id : '';
  const open = (id) => id !== coming && !has(id) && !S.tried.has(id);
  let id = S.queue.find(open) || S.ids.find(open);
  if (!id && S.tried.size) {
    S.tried.clear();
    id = S.queue.find(open) || S.ids.find(open);
  }
  return id || null;
}

// A photo tried behind the scenes has arrived: the browser has it now, so getting it ready for
// the screen is quick. It goes to the front of the line, ahead of a photo that was waiting there
// for another turn. One that was only filling in gives way and isn't owed a turn.
function join(slide, t) {
  S.trying = null;
  cancel(slide);
  S.ready.add(slide.id);
  S.fails = 0;
  S.tryAt = t;
  const waiting = S.next && !S.next.back && S.shown.has(S.next.id) ? S.next : null;
  const first = waiting && !waiting.fill ? [slide.id, waiting.id] : [slide.id];
  S.queue = [...first, ...S.queue.filter((id) => !first.includes(id))];
  if (waiting) {
    cancel(waiting);
    S.next = null;
  }
  if (took(slide) <= QUICK) caughtUp();
}

// A photo came down quickly: the show goes back to getting each next photo ready itself.
function caughtUp() {
  S.slow = false;
  S.misses = S.fails = S.retryAt = S.tryAt = 0;
  S.tried.clear();
  cancel(S.trying); // it has had longer than that already: it is probably stuck
  S.trying = null;
}

// The connection looks to be back: the computer says so, or the server answers after not being
// reached. A try that began before then is probably stuck, so the next one starts now.
function again() {
  if (!S.slow) return;
  S.tryAt = S.fails = S.retryAt = 0;
  cancel(S.trying);
  S.trying = null;
}

// ---------------------------------------------------------------- the videos
// clips.js brings the committee's videos down and keeps them on this computer. Here: when one
// plays, and how. A video is a slide like a photo (S.next, S.now, S.old), but it is never in
// the photos' line (S.queue), their history (S.past) or the sets that say which photos the
// browser has: the photos' pass keeps its place while a video plays.
const clips = createClips({
  clock,
  onReady: (id) => {
    // A video that has just arrived has the next turn.
    if (!S.clipLine.includes(id)) S.clipLine.unshift(id);
    if (S.on) tick();
  }
});

// Is the slide's photo or video still in the show?
const inShow = (slide) => (slide.video ? clips.has(slide.id) : S.photos.has(slide.id));

// A promise nobody waits for must not turn into an error in the console.
const quietly = (promise) => { if (promise && promise.catch) promise.catch(() => {}); };

// Takes the server's list of videos. One that is no longer in it leaves the screen now.
function takeClips(list) {
  clips.take(Array.isArray(list) ? list : []);
  S.clipLine = S.clipLine.filter((id) => clips.has(id));
  if (S.next && S.next.video && !clips.has(S.next.id)) {
    cancel(S.next);
    S.next = null;
  }
  if (S.now && S.now.video && !clips.has(S.now.id)) {
    if ((S.next && S.next.ready) || spare()) S.skip = true;
    else clear();
  }
}

// May a piece of a video be asked for? Only when the photos are not using the connection: the
// next one is ready and waiting, and nothing is being tried behind the scenes. On a slow
// connection a photo is being tried nearly all the time, so the photos come first, and the
// videos get the connection once the photos are ahead or all here.
const quiet = () => !S.trying && (!S.next || S.next.ready);

// The video to get ready next, or '' when it isn't a video's turn. One plays after every
// S.every photos (after each pass, when there are fewer photos than that), and the videos take
// turns. A video also goes up when there is nothing else to show: no photo on screen, or one
// that has run past its time with no photo to follow it.
function dueClip(t) {
  const ready = clips.ready();
  if (!ready.length) return '';
  const on = S.now ? S.now.id : '';
  const stuck = !!S.now && !S.paused && t >= S.dueAt + PATIENCE;
  if (S.now && !stuck) {
    if (S.ids.length && S.now.video) return ''; // not two videos in a row while there are photos
    if (S.ids.length && S.since < Math.min(S.every, S.ids.length)) return '';
  }
  S.clipLine = S.clipLine.filter((id) => ready.includes(id));
  if (!S.clipLine.some((id) => id !== on)) {
    S.clipLine = ready.slice();
    if (S.clipLine.length > 1 && S.clipLine[0] === S.lastClip) S.clipLine.push(S.clipLine.shift());
  }
  const at = S.clipLine.findIndex((id) => id !== on);
  return at >= 0 ? S.clipLine.splice(at, 1)[0] : '';
}

// Starts getting a video ready for the screen: a slide with a <video> where a photo has its
// <img>. The blurred ground behind it is its poster picture.
function clipSlide(id, t) {
  const clip = clips.get(id);
  const slide = { id, video: true, back: false, fill: false, cached: true, ready: false, main: null, mainAt: 0, loadedAt: 0, hasBack: null, startedAt: t, img: null, v: document.createElement('video'), backImg: null, el: null, frame: null, cap: null, w: 0, h: 0, tilt: 0, removeAt: 0 };
  const wanted = () => S.next === slide;
  const settle = (ok) => {
    if (slide.main !== null) return;
    slide.main = ok;
    slide.mainAt = clock();
    if (wanted()) tick();
  };
  slide.v.muted = !S.sound;
  slide.v.playsInline = true;
  slide.v.preload = 'auto';
  slide.v.disablePictureInPicture = true;
  slide.v.addEventListener('loadeddata', () => settle(slide.v.videoWidth > 0 && slide.v.videoHeight > 0));
  slide.v.addEventListener('error', () => settle(false));
  // The moment it ends is the moment to move on, whatever its length was said to be.
  slide.v.addEventListener('ended', () => {
    if (S.now !== slide || S.paused) return;
    S.dueAt = Math.min(S.dueAt, clock());
    tick();
  });
  slide.v.src = clip.src;
  if (clip.thumbUrl) {
    slide.backImg = new Image();
    slide.backImg.alt = '';
    slide.backImg.src = clip.thumbUrl;
    arrived(slide.backImg).then((ok) => {
      slide.hasBack = ok;
      if (wanted()) tick();
    });
  } else {
    slide.hasBack = false;
  }
  return slide;
}

// How the video being got ready is getting on. One that can't be played here after all is left
// out until the page is reloaded, and the photos carry on.
function clipStep(slide, t) {
  if (slide.main === null && t - slide.startedAt >= CLIP_WAIT) slide.main = false;
  const at = landed(slide, t);
  if (at === '' || (at === 'in' && build(slide))) return;
  clips.bad(slide.id);
  discard(slide);
  S.next = null;
}

// How long a video stays on screen: its own length, as the browser reads it, or failing that
// as the server has it.
function clipMs(slide) {
  const said = (clips.get(slide.id) || {}).seconds;
  const seconds = Number.isFinite(slide.v.duration) && slide.v.duration > 0 ? slide.v.duration : said;
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(CLIP_MAX, Math.max(2000, seconds * 1000)) : S.seconds * 1000;
}

// Plays the video on screen from its start. With nothing else to show, it goes round and round.
// A browser that won't play sound without a click plays it silent.
function startClip(slide) {
  const v = slide.v;
  v.loop = !S.ids.length && clips.ready().length < 2;
  try { v.currentTime = 0; } catch { /* it starts from where it is */ }
  const go = v.play();
  if (go && go.catch) {
    go.catch(() => {
      v.muted = true;
      quietly(v.play());
    });
  }
}

// Takes a slide out of the page for good. A video is stopped and let go of.
function discard(slide) {
  if (!slide) return;
  if (slide.el) slide.el.remove();
  if (!slide.video) return;
  try {
    slide.v.pause();
    slide.v.removeAttribute('src');
    slide.v.load();
  } catch { /* already let go of */ }
}

// The line in the controls that says how the videos are coming along.
function clipNote() {
  const note = $('#sc-clips');
  if (!note) return;
  const p = clips.progress();
  note.hidden = !p.listed;
  if (!p.listed) return;
  let words = `Videos: ${p.ready} of ${p.listed} ready`;
  if (p.coming !== null) words += `, the next one ${p.coming}% here`;
  if (p.bad) words += `, ${p.bad} can't be played on this computer`;
  if (note.textContent !== words) note.textContent = words;
}

// ---------------------------------------------------------------- the clock
// Looks at the show and makes the next move. Runs every quarter second while the show plays, and
// straight away when something happens (a key, a photo arriving, a fresh list).
function tick() {
  if (!S.on) return;
  const t = clock();

  // The photo that has faded out leaves the page.
  if (S.old && t >= S.old.removeAt) {
    discard(S.old);
    S.old = null;
  }

  // The photo being tried behind the scenes: has it arrived, failed, or had its time?
  const tryout = S.trying;
  if (tryout) {
    const at = landed(tryout, t);
    const age = t - tryout.startedAt;
    // The small copy is a fiftieth of the photo's size. While even that hasn't come, nothing
    // is moving, and the wait is better spent on a fresh try.
    const stuck = tryout.hasBack === null && age >= STUCK;
    if (at === 'in' && tryout.img.naturalWidth > 0 && tryout.img.naturalHeight > 0) {
      join(tryout, t);
    } else if (at || stuck || age >= TRY_TIMEOUT) {
      cancel(tryout);
      S.trying = null;
      S.tried.add(tryout.id);
      S.fails += 1;
      // One that ran out of time has been pause enough.
      S.tryAt = t + TRY_PAUSE[at ? Math.min(S.fails, TRY_PAUSE.length) - 1 : 0];
    }
  }

  // The video being got ready is on this computer: it is there at once, or it can't be played.
  if (S.next && S.next.video && !S.next.ready) clipStep(S.next, t);

  // The photo being got ready: has it arrived, failed, or taken too long?
  const coming = S.next;
  if (coming && !coming.video && !coming.ready) {
    const at = landed(coming, t);
    if (at === 'out' || (at === 'in' && !build(coming))) {
      miss(t);
    } else if (at === 'in') {
      if (S.slow && !coming.cached && took(coming) <= QUICK) caughtUp();
    } else if (coming.main === null && !coming.loadedAt) {
      const age = t - coming.startedAt;
      if (coming.cached && age >= CACHED_WAIT) {
        mistaken(coming.id);
        coming.cached = false;
      }
      // A photo that has to come down the wire holds the screen only so long: until the one
      // showing is a little past its time, when there is another to show instead, and never
      // past LOAD_TIMEOUT. It isn't waited for at all when the one showing has been taken out
      // of the show.
      const gone = !!S.now && !inShow(S.now);
      const late = gone || (!!S.now && !S.paused && t >= S.dueAt + PATIENCE);
      if (!coming.cached && (age >= LOAD_TIMEOUT || ((S.slow || late) && spare()))) aside();
    }
  }

  // A stray press of Space (a hand on the keyboard, a clicker) must not hold one photo all night.
  if (S.paused && t - S.pausedAt >= PAUSE_MAX) pause(false);

  // Time to change photos. The first photo shows as soon as it is ready.
  if (S.next && S.next.ready && (S.skip || !S.now || (!S.paused && t >= S.dueAt))) change(t);

  // A video's turn comes round every so many photos. It needs nothing from the network.
  if (!S.next) {
    const id = dueClip(t);
    if (id) S.next = clipSlide(id, t);
  }

  // Start getting the one after ready. The pause after a failed load is for the network's
  // sake: a photo the browser has needs none. On a slow connection with no photo in hand to go
  // to, the one being tried behind the scenes is the one to wait for: a second download would
  // only share the line with it, and neither would finish. (One that isn't moving at all is
  // given up after STUCK, so the wait is never for nothing for long.)
  const alone = S.slow && !!S.trying && !spare();
  if (!S.next && !alone && (t >= S.retryAt || (S.slow && spare()))) {
    const pick = nextId();
    if (pick) prepare(pick.id, false, t).fill = pick.fill;
    else S.skip = false; // there is nothing else to change to
  }

  // On a slow connection, while the show goes round the photos the browser has, one that it
  // doesn't have is tried behind the scenes.
  if (S.slow && !S.trying && t >= S.tryAt && S.ready.size < AHEAD && spare()) {
    const id = nextTry();
    if (id) S.trying = load(id, false, t);
  }

  // A video that has played to its end with nothing to follow it plays again.
  if (S.now && S.now.video && !S.next && !S.paused && !S.now.v.loop && t >= S.dueAt + PATIENCE) {
    startClip(S.now);
    S.dueAt = t + clipMs(S.now);
  }

  // The videos come down in the gaps, when the photos are not using the connection.
  if (!DEMO) clips.pump(quiet());
  if (S.awake) clipNote();

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
    img.addEventListener('load', () => resolve(true));
    img.addEventListener('error', () => resolve(false));
  });
}

// Starts loading a photo and its blurred background, out of the page, and answers the slide.
function load(id, back, t) {
  const photo = S.photos.get(id);
  const slide = { id, back, fill: false, cached: has(id), ready: false, main: null, mainAt: 0, loadedAt: 0, hasBack: null, startedAt: t, img: new Image(), backImg: null, el: null, frame: null, cap: null, w: 0, h: 0, tilt: 0, removeAt: 0 };
  const wanted = () => S.next === slide || S.trying === slide;
  slide.img.alt = '';
  slide.img.decoding = 'async';
  slide.img.addEventListener('load', () => { slide.loadedAt = clock(); });
  slide.img.src = photo.url;
  arrived(slide.img).then((ok) => {
    if (slide.main !== null) return; // tick() stopped waiting for this answer
    slide.main = ok;
    slide.mainAt = clock();
    if (wanted()) tick();
  });
  // The blurred background is the small copy of the photo. The slide can do without it.
  if (photo.thumbUrl) {
    slide.backImg = new Image();
    slide.backImg.alt = '';
    slide.backImg.src = photo.thumbUrl;
    arrived(slide.backImg).then((ok) => {
      slide.hasBack = ok;
      if (wanted()) tick();
    });
  } else {
    slide.hasBack = false;
  }
  return slide;
}

// Starts getting a photo ready for the screen. tick() puts it in the page once it has arrived.
function prepare(id, back, t) {
  S.next = load(id, back, t);
  return S.next;
}

// How a load is getting on: 'in' when the photo can be drawn and its background has had its
// chance, 'out' when it can't be, '' while it is still on its way.
function landed(slide, t) {
  if (slide.main === null && slide.loadedAt && t - slide.loadedAt >= DECODE_WAIT) {
    slide.main = true; // loaded, but the browser never said it was ready to draw: show it anyway
    slide.mainAt = t;
  }
  if (slide.main === false) return 'out';
  return slide.main && (slide.hasBack !== null || t - slide.mainAt >= BACK_WAIT) ? 'in' : '';
}

// Lets go of a slide that will never show, and stops its downloads if they are still under way.
function cancel(slide) {
  if (!slide) return;
  if (slide.video) return discard(slide);
  if (slide.el) slide.el.remove();
  if (slide.main === null) {
    // Chrome takes a moment to drop a download. Asked for the same photo before it has, it
    // hands back the old download, stuck or not. So the network is left alone for that moment.
    const rested = clock() + REST;
    S.retryAt = Math.max(S.retryAt, rested);
    S.tryAt = Math.max(S.tryAt, rested);
  }
  slide.img.src = BLANK;
  if (slide.backImg) slide.backImg.src = BLANK;
}

// The photo being got ready didn't load. It is skipped for this pass and tried again on the next.
// After a failure the show waits a little before asking the network for another, so a dead
// connection means one quiet try every few seconds, not a storm. Two failures with no photo
// going up in between, and the show stops counting on the network.
function miss(t) {
  const slide = S.next;
  cancel(slide);
  S.next = null;
  S.misses += 1;
  if (slide.cached) mistaken(slide.id);
  else S.retryAt = t + RETRY[Math.min(S.misses, RETRY.length) - 1];
  if (S.misses >= 2) S.slow = true;
  // Previous couldn't get its photo: stay on this one rather than jump ahead.
  if (slide.back) S.skip = !!S.now && !inShow(S.now);
}

function say(slide, caption) {
  slide.cap.firstChild.textContent = caption;
  slide.cap.hidden = !caption;
}

// Puts a loaded photo in the page, see-through, on top of the one showing. False when the
// picture turned out to have no size.
function build(slide) {
  const photo = slide.video ? clips.get(slide.id) : S.photos.get(slide.id);
  const picture = slide.video ? slide.v : slide.img;
  slide.w = slide.video ? picture.videoWidth : picture.naturalWidth;
  slide.h = slide.video ? picture.videoHeight : picture.naturalHeight;
  if (!photo || !slide.w || !slide.h) return false;
  const el = document.createElement('div');
  el.className = slide.video ? 'sc-slide is-clip' : 'sc-slide';
  el.dataset.id = slide.id;
  if (slide.hasBack || (slide.backImg && slide.backImg.complete && slide.backImg.naturalWidth > 0)) {
    slide.backImg.className = 'sc-back';
    el.append(slide.backImg);
  } else if (slide.backImg) {
    slide.backImg.src = BLANK; // too slow or broken: the ground stays black
    slide.backImg = null;
  }
  slide.frame = document.createElement('div');
  slide.frame.className = 'sc-frame';
  picture.className = slide.video ? 'sc-photo sc-clip' : 'sc-photo';
  slide.frame.append(picture);
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
  const print = !slide.video && fit > most;
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
  } else if (!slide.video) {
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
  discard(S.old);
  S.old = S.now;
  if (S.old) {
    S.old.removeAt = t + FADE + 300;
    if (S.old.video) S.old.v.muted = true; // its picture fades out; its sound stops now
    if (!slide.back && S.photos.has(S.old.id)) {
      S.past.push(S.old.id);
      if (S.past.length > PAST) S.past.shift();
    }
  }
  S.now = slide;
  if (slide.video) {
    S.since = 0;
    S.lastClip = slide.id;
  } else {
    S.since += 1;
    S.shown.delete(slide.id); // so the set stays in the order the photos were last on screen
    S.shown.add(slide.id);
    S.ready.delete(slide.id);
    S.kept.delete(slide.id);
    S.misses = 0;
    if (!DEMO) seen.set([...S.shown].map((id) => S.photos.get(id)).filter(Boolean).map(markOf));
  }
  void slide.el.offsetWidth; // so the fade starts from clear, even for a photo that only just arrived
  slide.el.classList.add('is-on');
  stage.classList.add('has-photo');
  S.left = slide.video ? clipMs(slide) : S.seconds * 1000;
  S.dueAt = t + S.left;
  S.skip = false;
  if (slide.video) startClip(slide);
}

// No approved photos are left: the one on screen fades away to the title card.
function clear() {
  discard(S.old);
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
  const first = (waiting && waiting.back) || S.now.video ? [] : [S.now.id];
  if (waiting) {
    if (!waiting.video) first.push(waiting.id);
    cancel(waiting);
    S.next = null;
  }
  S.queue = [...first, ...S.queue.filter((queued) => !first.includes(queued))];
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
  S.pausedAt = t;
  stage.classList.toggle('is-paused', on); // holds the zoom too
  if (S.now && S.now.video) {
    if (on) S.now.v.pause();
    else quietly(S.now.v.play());
  }
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
  // The computer says its connection is back: ask for the photos now rather than at the next
  // minute, and try a photo behind the scenes now rather than after its pause.
  window.addEventListener('online', () => {
    if (!S.on) return;
    again();
    S.down = false;
    check();
    tick();
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
  S.every = EVERY.includes(kept.every) ? kept.every : 10;
  S.sound = kept.sound === true;
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
