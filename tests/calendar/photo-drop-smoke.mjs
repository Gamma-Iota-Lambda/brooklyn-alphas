// The School Daze photo drop, end to end in a real browser, against the local stand-in for
// Supabase (live-server.mjs): the real photo-drop Edge Function on the real migrations, with
// Storage simulated (storage-sim.mjs).
//
// A guest opens the upload page on a phone: a link without a code, a wrong code, then two photos
// (one large, one small) with a caption. The same two sent again are kept once, a file that is
// not a picture is refused on the page, and the sixth photo from one email is stopped by the
// server. An organizer signs in on a laptop, fixes a caption, and goes through the line in the
// full view, the only place a photo can be approved. The venue's slideshow plays the approved
// photo and nothing else, and a photo approved later joins at its next check. The organizer then
// adds a video for the committee: it is read on the page, sent straight to Storage with its
// progress showing, lands under Approved, plays in the full view, and plays in a second slideshow
// between the photos until Back to waiting takes it out. Last: closing uploads, Delete on the
// Rejected tab, and Delete everything, which leave no file behind.
//
//   npm install --no-save @electric-sql/pglite@0.5.8 playwright@1.56.0
//   npx playwright install chromium   (once)
//   node tests/calendar/photo-drop-smoke.mjs
//
// Optional: SCREENSHOTS=dir saves screenshots along the way.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startLiveServer, DROP_UPLOAD_CODE, DROP_REVIEW_CODE, DROP_SCREEN_CODE } from './live-server.mjs';

const SHOTS = process.env.SCREENSHOTS || '';
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const PHONE = { width: 390, height: 844 };
const LAPTOP = { width: 1366, height: 900 };
const BIG_SCREEN = { width: 1920, height: 1080 };
// review.js ignores a tap on a card for up to this long after the grid moves (SETTLE, MOVED), and
// a tap in the full view for a moment after a photo opens, so a double tap can't hit the next one.
const SETTLE = 1000;
const LIMIT = "You've sent 5 photos, which is the most one person can send.";
// Three seconds of 640 by 360, in a codec every Chromium plays.
const CLIP = fileURLToPath(new URL('./fixtures/clip.mp4', import.meta.url));

let current = 'starting';
const step = (s) => { current = s; console.log('·', s); };

const server = await startLiveServer({ port: 5184 });
const browser = await chromium.launch();
const errors = []; // console errors and uncaught exceptions, from every page
const refusals = []; // the browser's own console line for each 4xx answer: '<page> <route> <status>'
const answers = []; // every answer from the photo-drop function: { who, route, status, body }
const reading = [];
const opened = [];

// clock: put the page's timers and clock under page.clock, to move the slideshow's time.
async function open(name, viewport, path, { phone = false, clock = false } = {}) {
  const ctx = await browser.newContext({ viewport, timezoneId: 'America/New_York', ...(phone ? { isMobile: true, hasTouch: true } : {}) });
  ctx.setDefaultTimeout(15000);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    // Chromium writes this line itself for every answer of 400 and up. The ones this test
    // provokes on purpose are counted at the end; anything else is an error.
    const drop = /\/functions\/v1\/photo-drop\/(\w+)$/.exec(m.location().url || '');
    const status = /status of (4\d\d)/.exec(m.text());
    if (/Failed to load resource/.test(m.text()) && drop && status) refusals.push(`${name} ${drop[1]} ${status[1]}`);
    else errors.push(`${name}: ${m.text()} ${m.location().url || ''}`);
  });
  page.on('response', (r) => {
    const drop = /\/functions\/v1\/photo-drop\/(\w+)$/.exec(new URL(r.url()).pathname);
    if (drop) reading.push(r.json().catch(() => null).then((body) => answers.push({ who: name, route: drop[1], status: r.status(), body })));
  });
  await page.route(/fonts\.googleapis\.com|fonts\.gstatic\.com|googletagmanager\.com/, (r) => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  if (clock) await page.clock.install();
  opened.push({ name, page });
  await page.goto(`${server.origin}${path}`);
  return { ctx, page };
}

// The function's answers to one page on one route, once every answer so far has been read.
async function answered(who, route) {
  await Promise.all(reading);
  return answers.filter((a) => a.who === who && a.route === route);
}

const text = async (page, selector) => ((await page.locator(selector).textContent()) || '').replace(/\s+/g, ' ').trim();
const texts = async (locator) => (await locator.allTextContents()).map((t) => t.replace(/\s+/g, ' ').trim());
const shot = async (page, name, wait = 300) => { if (SHOTS) { await page.waitForTimeout(wait); await page.screenshot({ path: `${SHOTS}/drop-${name}.png` }); } };
const rows = () => server.sql(`select id, status, name, email, caption, width, height, bytes, has_thumb, original, path, thumb_path, url, thumb_url, reviewed_by,
  kind, seconds, mime from public.drop_photos order by created_at, id`);
const statuses = async () => (await rows()).map((r) => r.status);

// Waits for the database to say so: the pages show a change before the server has it.
async function until(what, check) {
  for (let i = 0; i < 100; i += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`still waiting after 10 seconds: ${what}`);
}

// ------------------------------------------------------------------ pictures
// Drawn and read in the browser, so the test needs no picture library of its own.
const easel = await (await browser.newContext()).newPage();

async function jpeg(name, width, height, hue) {
  const base64 = await easel.evaluate(async ([w, h, tint]) => {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    const ground = ctx.createLinearGradient(0, 0, w, h);
    ground.addColorStop(0, `hsl(${tint}, 70%, 22%)`);
    ground.addColorStop(1, `hsl(${(tint + 80) % 360}, 80%, 62%)`);
    ctx.fillStyle = ground;
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
    ctx.lineWidth = Math.max(2, h / 200);
    for (let ring = 1; ring <= 5; ring += 1) {
      ctx.beginPath();
      ctx.arc(w * 0.7, h * 0.45, ring * h * 0.07, 0, Math.PI * 2);
      ctx.stroke();
    }
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(binary);
  }, [width, height, hue]);
  return { name, mimeType: 'image/jpeg', buffer: Buffer.from(base64, 'base64') };
}

// What a stored file is: null unless it starts the way a JPEG does, then its size once decoded.
async function decoded(bytes) {
  if (!bytes || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) return null;
  return easel.evaluate(async (base64) => {
    const picture = await createImageBitmap(await (await fetch(`data:image/jpeg;base64,${base64}`)).blob());
    return { width: picture.width, height: picture.height };
  }, Buffer.from(bytes).toString('base64'));
}

const LARGE = await jpeg('IMG_0042.jpg', 4000, 3000, 42);
const SMALL = await jpeg('stepping-1998.jpg', 800, 600, 205);
const MORE = [await jpeg('graduation.jpg', 1600, 1200, 140), await jpeg('probate.jpg', 1200, 900, 275), await jpeg('the-yard.jpg', 1024, 768, 350)];
const ONE_MORE = await jpeg('one-more.jpg', 1280, 960, 20);
const NOTE = { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('not a photo') };

async function choose(page, files, ready) {
  await page.setInputFiles('#ph-files', files);
  await page.waitForFunction((n) => document.querySelectorAll('.ph-photo.is-ready').length === n && !document.querySelector('.ph-photo.is-checking'), ready);
}

async function send(page) {
  await page.check('#ph-consent');
  await page.click('#ph-send');
}

// The full view, with its photo on screen and its buttons taking taps.
async function viewing(page, id, position) {
  await page.waitForSelector(`#rv-view[open] #rv-view-img[data-id="${id}"]`);
  await page.waitForFunction(() => {
    const img = document.querySelector('#rv-view-img');
    return img.complete && img.naturalWidth > 0 && !document.querySelector('#rv-view-stage').classList.contains('is-loading');
  });
  assert.equal(await text(page, '#rv-view-pos'), position);
  await page.waitForTimeout(SETTLE);
}

// The full view with a video in it, far enough along to play, and its buttons taking taps.
async function playing(page, id, position) {
  await page.waitForSelector(`#rv-view[open] #rv-view-video[data-id="${id}"]`);
  await page.waitForFunction(() => document.querySelector('#rv-view-video').readyState >= 2);
  assert.equal(await text(page, '#rv-view-pos'), position);
  await page.waitForTimeout(SETTLE);
}

// Opens one of the review page's two folding panels, if it isn't open already.
async function unfold(page, panel) {
  if (!(await page.locator(panel).evaluate((el) => el.open))) await page.click(`${panel} summary`);
}

const counts = async (page) => (await texts(page.locator('.rv-tab [data-count]'))).map(Number);
const tab = async (page, name) => {
  await page.click(`#rv-tab-${name}`);
  await page.waitForSelector(`#rv-tab-${name}[aria-selected="true"]`);
};
const card = (page, id) => page.locator(`.rv-card[data-id="${id}"]`);
const acts = (page, id) => card(page, id).locator('.rv-actions [data-act]').evaluateAll((buttons) => buttons.map((b) => b.dataset.act));

// Moves the mouse over the slideshow, which brings its controls up for a few seconds.
async function nudge(page) {
  await page.mouse.move(900, 500);
  await page.mouse.move(960, 540, { steps: 4 });
}

const onScreen = (page) => page.locator('.sc-slide').evaluateAll((slides) => slides.map((s) => s.dataset.id));

try {
  // The migration's deadline is a real date (noon on the day of the party). Move it ahead of
  // today, so this test reads the same after the party as before it.
  await server.sql(`update cal_private.config set value = $1 where key = 'drop_closes_at'`, [new Date(Date.now() + 3 * 86400000).toISOString()]);

  // ------------------------------------------------------------------ a guest, on a phone
  step('the link without a code asks for one, and a wrong code is refused');
  const guest = await open('guest', PHONE, '/school-daze/photos.html', { phone: true });
  await guest.page.waitForSelector('#ph-code');
  assert.equal(await text(guest.page, '#ph-code-title'), 'Enter the code from your email');
  assert.equal((await answered('guest', 'open')).length, 0, 'nothing is asked of the server without a code');
  await guest.page.fill('#ph-code-input', 'not-the-code');
  await guest.page.click('#ph-code-go');
  await guest.page.waitForSelector('#ph-code-err');
  assert.equal(await text(guest.page, '#ph-code-err'), "That code isn't right. Check your School Daze email and try again.");
  assert.equal(await guest.page.locator('#ph-form').isVisible(), false);
  await shot(guest.page, 'code-wrong');

  step('the right code opens the form, and a large and a small photo each get their size label');
  await guest.page.fill('#ph-code-input', DROP_UPLOAD_CODE);
  await guest.page.click('#ph-code-go');
  await guest.page.waitForSelector('#ph-form');
  assert.equal(new URL(guest.page.url()).search, `?k=${DROP_UPLOAD_CODE}`, 'the code moves into the address, so a reload keeps it');
  assert.match(await text(guest.page, '#ph-deadline'), /^Send them by .+\.$/);
  await choose(guest.page, [LARGE, SMALL], 2);
  assert.deepEqual(await texts(guest.page.locator('.ph-photo .pd-pill')), ['Sharp', 'Small']);
  assert.match(await text(guest.page, '.ph-photo:nth-child(2)'), /It may look soft\. If you have a larger copy, send that one\./);
  assert.equal(await text(guest.page, '#ph-room'), '2 chosen. You can add 3 more.');

  step('she adds a caption, ticks the box and sends: two JPEGs with thumbnails are stored, waiting');
  await guest.page.fill('#ph-name', 'Ada Lovelace');
  await guest.page.fill('#ph-email', 'Ada@Example.com');
  await guest.page.locator('.ph-photo').first().locator('[data-caption]').fill('Howard, class of 1998');
  await shot(guest.page, 'chosen');
  await send(guest.page);
  await guest.page.waitForSelector('#ph-done');
  assert.equal(await text(guest.page, '#ph-done-count'), 'We got 2 photos. You can send 3 more.');
  const sent = await rows();
  assert.deepEqual(sent.map((r) => [r.status, r.name, r.email, r.caption, r.width, r.height, r.has_thumb]), [
    ['waiting', 'Ada Lovelace', 'ada@example.com', 'Howard, class of 1998', 2560, 1920, true],
    ['waiting', 'Ada Lovelace', 'ada@example.com', null, 800, 600, true]
  ]);
  assert.deepEqual(sent.map((r) => r.original), [
    { name: 'IMG_0042.jpg', width: 4000, height: 3000, bytes: LARGE.buffer.length, type: 'image/jpeg' },
    { name: 'stepping-1998.jpg', width: 800, height: 600, bytes: SMALL.buffer.length, type: 'image/jpeg' }
  ]);
  for (const r of sent) {
    const photo = server.storage.read(r.path);
    const thumb = server.storage.read(r.thumb_path);
    const size = await decoded(photo);
    assert.deepEqual(size, { width: r.width, height: r.height }, 'the stored photo is a JPEG of the size the row gives');
    assert.ok(Math.max(size.width, size.height) <= 2560, 'no longer than 2560 on its long side');
    const small = await decoded(thumb);
    assert.equal(Math.max(small.width, small.height), 480, 'with a thumbnail');
    assert.equal(r.bytes, photo.length + thumb.length);
    assert.ok(r.url.startsWith(`${server.origin}/storage/v1/object/sign/photo-drop/${r.path}?token=`));
    assert.ok(r.thumb_url.startsWith(`${server.origin}/storage/v1/object/sign/photo-drop/${r.thumb_path}?token=`));
  }
  assert.equal(server.storage.paths().length, 4);
  const [first, second] = sent;
  await shot(guest.page, 'done');

  step('the same two photos sent again are kept once: the server answers with the first ids');
  await guest.page.click('#ph-more');
  await choose(guest.page, [LARGE, SMALL], 2);
  await send(guest.page);
  await guest.page.waitForSelector('#ph-done');
  assert.equal(await text(guest.page, '#ph-done-count'), 'We got 2 photos. You can send 3 more.');
  assert.deepEqual((await answered('guest', 'send')).map((a) => [a.status, a.body.id, a.body.left]),
    [[200, first.id, 4], [200, second.id, 3], [200, first.id, 3], [200, second.id, 3]]);
  assert.deepEqual((await rows()).map((r) => r.id), [first.id, second.id], 'no new rows');
  assert.equal(server.storage.paths().length, 4, 'and no new files');

  step('a file that is not a picture is refused on the page, and nothing is sent');
  await guest.page.click('#ph-more');
  await guest.page.setInputFiles('#ph-files', [NOTE]);
  await guest.page.waitForSelector('.ph-photo.is-bad');
  assert.equal(await text(guest.page, '.ph-photo.is-bad .ph-problem'),
    'We couldn\'t read "notes.txt". If it\'s an iPhone photo, open this page on your iPhone, or send a JPEG or PNG copy.');
  assert.equal(await text(guest.page, '#ph-status'), "1 photo can't be used.");
  await send(guest.page);
  await guest.page.waitForSelector('#ph-photos-err');
  assert.equal(await text(guest.page, '#ph-photos-err'), "These photos can't be sent. Choose different ones.");
  assert.equal((await answered('guest', 'send')).length, 4, 'the page asked the server nothing');
  await shot(guest.page, 'not-a-photo');
  await guest.page.click('.ph-photo.is-bad [data-act="remove"]');

  step('three more reach the limit of 5, and the page offers no more');
  await choose(guest.page, MORE, 3);
  assert.deepEqual(await texts(guest.page.locator('.ph-photo .pd-pill')), ['Sharp', 'Good', 'Good']);
  assert.equal(await text(guest.page, '#ph-room'), "That's as many as you can send. To swap one, remove it first.");
  await send(guest.page);
  await guest.page.waitForSelector('#ph-done');
  assert.equal(await text(guest.page, '#ph-done-count'), 'We got 3 photos.');
  assert.equal(await guest.page.locator('#ph-more').isVisible(), false);
  assert.deepEqual(await statuses(), Array(5).fill('waiting'));
  await guest.ctx.close();

  step('a sixth photo from the same email, on a later visit, is stopped with the server\'s sentence');
  const later = await open('guest later', PHONE, `/school-daze/photos.html?k=${DROP_UPLOAD_CODE}`, { phone: true });
  await later.page.waitForSelector('#ph-form');
  assert.equal(await later.page.inputValue('#ph-email'), '', 'a new visit on another phone: the page knows nothing of the five');
  await choose(later.page, [ONE_MORE], 1);
  await later.page.fill('#ph-name', 'Ada Lovelace');
  await later.page.fill('#ph-email', 'ada@example.com');
  await send(later.page);
  await later.page.waitForSelector('#ph-err');
  assert.equal(await text(later.page, '#ph-err'), LIMIT);
  assert.deepEqual((await answered('guest later', 'send')).map((a) => [a.status, a.body.reason, a.body.error]), [[409, 'limit', LIMIT]]);
  assert.equal((await rows()).length, 5);
  assert.equal(server.storage.paths().length, 10, 'ten files: five photos and their thumbnails');
  await shot(later.page, 'limit');

  // ------------------------------------------------------------------ an organizer, on a laptop
  step('an organizer is refused with a wrong code, signs in with the right one, and sees who sent what');
  const organizer = await open('organizer', LAPTOP, '/school-daze/review.html');
  const review = organizer.page;
  await review.waitForSelector('#rv-signin');
  await review.fill('#rv-code', DROP_UPLOAD_CODE); // the code every guest has opens nothing here
  await review.fill('#rv-name', 'Eugene Aiken');
  await review.click('#rv-signin-go');
  await review.waitForSelector('#rv-signin-err');
  assert.equal(await text(review, '#rv-signin-err'), "That code isn't right. Check it and try again.");
  assert.equal(await review.locator('#rv-app').isVisible(), false);
  await review.fill('#rv-code', DROP_REVIEW_CODE);
  await review.click('#rv-signin-go');
  await review.waitForSelector('#rv-app');
  assert.deepEqual(await counts(review), [5, 0, 0]);
  assert.deepEqual(await review.locator('.rv-card').evaluateAll((cards) => cards.map((c) => c.dataset.id)), (await rows()).map((r) => r.id), 'oldest first');
  assert.deepEqual(await texts(review.locator('.rv-card .rv-name')), Array(5).fill('Ada Lovelace'));
  assert.deepEqual(await texts(review.locator('.rv-card .rv-email')), Array(5).fill('ada@example.com'));
  assert.equal(await text(review, `.rv-card[data-id="${first.id}"] .rv-size`), 'Sharp 4000 × 3000');
  assert.equal(await text(review, `.rv-card[data-id="${second.id}"] .rv-size`), 'Small 800 × 600');
  await review.waitForFunction((id) => document.querySelector(`.rv-card[data-id="${id}"] .rv-thumb img`).naturalWidth === 480, first.id);

  step('a waiting card offers Review and Reject, and no Approve');
  for (const r of await rows()) assert.deepEqual(await acts(review, r.id), ['view', 'reject']);
  assert.equal(await review.locator('#rv-grid').getByRole('button', { name: /approve/i }).count(), 0);
  assert.equal(await text(review, '#rv-shown'), '5 photos waiting, oldest first. Open a photo to approve it.');
  await shot(review, 'waiting');

  step('he edits a caption');
  await card(review, first.id).locator('[data-act="edit"]').click();
  await card(review, first.id).locator('.rv-cap-form input').fill('Howard University, 1998');
  await card(review, first.id).locator('.rv-cap-form button[type="submit"]').click();
  assert.equal(await text(review, `.rv-card[data-id="${first.id}"] .rv-cap-text`), 'Howard University, 1998');
  await until('the caption to be saved', async () => (await rows())[0].caption === 'Howard University, 1998');

  step('Review them in order: he approves the first from the full view and rejects the second');
  await review.click('#rv-review-all');
  await viewing(review, first.id, '1 of 5 waiting');
  assert.deepEqual(await review.evaluate(() => [document.querySelector('#rv-view-img').naturalWidth, document.querySelector('#rv-view-img').naturalHeight]), [2560, 1920],
    'the full view shows the stored photo, not the thumbnail');
  assert.equal(await text(review, '#rv-view-who .rv-view-name'), 'Ada Lovelace Sharp 4000 × 3000');
  assert.equal(await text(review, '#rv-view-who .rv-view-cap'), 'Howard University, 1998');
  await shot(review, 'full-view');
  await review.click('#rv-view-actions [data-act="approve"]');
  await viewing(review, second.id, '1 of 4 waiting');
  await review.click('#rv-view-actions [data-act="reject"]');
  await viewing(review, (await rows())[2].id, '1 of 3 waiting');
  await review.click('#rv-view-close');
  await until('both decisions to be saved', async () => (await statuses()).join() === 'approved,rejected,waiting,waiting,waiting');
  assert.deepEqual((await rows()).slice(0, 2).map((r) => r.reviewed_by), ['Eugene Aiken', 'Eugene Aiken']);

  step('the counts follow: 3 waiting, 1 approved, 1 rejected');
  assert.deepEqual(await counts(review), [3, 1, 1]);
  assert.equal(await review.locator('.rv-card').count(), 3);
  await tab(review, 'approved');
  assert.deepEqual(await review.locator('.rv-card').evaluateAll((cards) => cards.map((c) => c.dataset.id)), [first.id]);
  assert.match(await text(review, `.rv-card[data-id="${first.id}"]`), /Approved by Eugene Aiken, /);
  assert.deepEqual(await acts(review, first.id), ['waiting'], 'an approved photo can only go back to waiting');
  await tab(review, 'rejected');
  assert.deepEqual(await acts(review, second.id), ['waiting', 'delete']);

  // ------------------------------------------------------------------ the slideshow
  step('the slideshow refuses the review code and starts with the screen code');
  const venue = await open('venue', BIG_SCREEN, '/school-daze/screen.html', { clock: true });
  const show = venue.page;
  await show.waitForSelector('#sc-setup');
  await show.fill('#sc-code', DROP_REVIEW_CODE);
  await show.click('#sc-start');
  await show.waitForSelector('#sc-code-err');
  assert.equal(await text(show, '#sc-code-err'), "That code isn't right. Check it and try again.");
  assert.equal(await show.locator('#sc-stage').isVisible(), false);
  await show.fill('#sc-code', DROP_SCREEN_CODE);
  await show.click('#sc-start');
  await show.waitForSelector('#sc-stage');

  step('only the approved photo shows, with its caption');
  await show.waitForSelector(`.sc-slide.is-on[data-id="${first.id}"]`);
  assert.equal(await text(show, '.sc-slide.is-on .sc-caption'), 'Howard University, 1998');
  assert.equal(await show.locator('.sc-slide.is-on .sc-caption').isVisible(), true);
  assert.equal(await show.locator('.sc-slide.is-on .sc-photo').evaluate((img) => img.naturalWidth), 2560);
  assert.deepEqual((await answered('venue', 'screen')).map((a) => [a.status, (a.body.photos || []).map((p) => p.id)]), [[403, []], [200, [first.id]]]);
  await show.clock.runFor(20000); // more than two turns at 8 seconds a photo
  assert.deepEqual(await onScreen(show), [first.id]);
  await shot(show, 'slideshow');

  step('the rejected photo goes back to waiting and is approved, and joins the show at its next check');
  await review.waitForTimeout(SETTLE);
  await card(review, second.id).locator('[data-act="waiting"]').click();
  await until('the photo to be waiting again', async () => (await statuses())[1] === 'waiting');
  assert.deepEqual(await counts(review), [4, 1, 0]);
  await tab(review, 'waiting');
  await card(review, second.id).locator('.rv-actions [data-act="view"]').click();
  await viewing(review, second.id, '1 of 4 waiting');
  await review.click('#rv-view-actions [data-act="approve"]');
  await until('the photo to be approved', async () => (await statuses())[1] === 'approved');
  await review.click('#rv-view-close');
  assert.deepEqual(await counts(review), [3, 2, 0]);
  const checks = (await answered('venue', 'screen')).length;
  assert.deepEqual(await onScreen(show), [first.id], 'not before the slideshow asks again');
  await show.clock.fastForward(61000); // its check comes round once a minute
  await show.waitForSelector(`.sc-slide.is-on[data-id="${second.id}"]`);
  assert.ok((await answered('venue', 'screen')).length > checks);
  assert.equal(await show.locator(`.sc-slide[data-id="${second.id}"] .sc-caption`).isHidden(), true, 'it has no caption');
  assert.equal(await show.locator(`.sc-slide[data-id="${second.id}"] .sc-photo`).evaluate((img) => img.naturalWidth), 800);
  assert.equal(await show.locator(`.sc-slide[data-id="${second.id}"]`).evaluate((slide) => slide.classList.contains('is-print')), true,
    'a small photo shows as a print and is not stretched across the screen');
  await shot(show, 'slideshow-joined', 1500); // once the fade is over

  // ------------------------------------------------------------------ a video from the committee
  step('Add a video refuses a file this browser can\'t open, then reads the clip: its length, size and poster');
  await unfold(review, '#rv-tools');
  assert.equal(await text(review, '#rv-add-hint'), "For the committee. Guests can't send videos. MP4 or MOV, 50 MB at most each.");
  await review.click('#rv-add-open');
  await review.waitForSelector('#rv-add[open]');
  await review.setInputFiles('#rv-add-file', { name: 'notes.mp4', mimeType: 'video/mp4', buffer: NOTE.buffer }); // a text file, renamed
  await review.waitForSelector('#rv-add-err');
  assert.equal(await text(review, '#rv-add-err'),
    "This browser can't open that video, so the slideshow may not be able to play it either. Save it as an MP4 (H.264) and add it again.");
  assert.equal(await review.locator('#rv-add-about').isVisible(), false);
  await review.setInputFiles('#rv-add-file', CLIP);
  await review.waitForFunction(() => /×/.test(document.querySelector('#rv-add-facts').textContent));
  assert.equal(await text(review, '#rv-add-facts'), '0:03 · 0.1 MB · 640 × 360');
  assert.equal(await review.locator('#rv-add-err').isVisible(), false);
  await review.waitForFunction(() => {
    const poster = document.querySelector('#rv-add-poster img');
    return poster && poster.complete && poster.naturalWidth === 480;
  });
  await review.fill('#rv-add-caption', 'The step show');
  await shot(review, 'video-chosen');

  step('he adds it: the box shows its progress with one button, Cancel, and then says it is in');
  const clip = readFileSync(CLIP);
  server.storage.slowUpload = 1500; // the clip is small: hold Storage back, so there is a wait to see
  await review.click('#rv-add-go');
  await review.waitForFunction(() => /^Sending the video: \d+%$/.test(document.querySelector('#rv-add-status').textContent));
  assert.equal(await review.locator('#rv-add-bar').isVisible(), true);
  assert.deepEqual(await texts(review.locator('#rv-add .pd-btnrow button:visible')), ['Cancel']);
  assert.deepEqual((await rows()).filter((r) => r.kind === 'video').map((r) => r.status), ['sending'], 'a place is held for it, and it is not in the show yet');
  await shot(review, 'video-sending', 0);
  await review.waitForFunction(() => !document.querySelector('#rv-add').open && !document.querySelector('#rv-toast').hidden
    && document.querySelector('#rv-toast-text').textContent === 'Video added. It joins the slideshow within a couple of minutes.');
  server.storage.slowUpload = 0;
  const video = (await rows()).find((r) => r.kind === 'video');
  assert.deepEqual([video.status, video.name, video.email, video.caption, video.width, video.height, video.bytes, Number(video.seconds), video.mime, video.has_thumb, video.reviewed_by],
    ['approved', 'Eugene Aiken', 'committee', 'The step show', 640, 360, clip.length, 3, 'video/mp4', true, 'Eugene Aiken']);
  assert.deepEqual([video.path, video.thumb_path], [`videos/${video.id}.mp4`, `thumbs/${video.id}.jpg`]);
  assert.ok(Buffer.from(server.storage.read(video.path)).equals(clip), 'the stored video is the file, byte for byte');
  assert.equal(server.storage.files.get(video.path).type, 'video/mp4');
  assert.deepEqual(await decoded(server.storage.read(video.thumb_path)), { width: 480, height: 270 }, 'with a poster made on the page');
  assert.equal(server.storage.paths().length, 12, 'five photos and their thumbnails, the video and its poster');

  step('it is under Approved, with its badge and its length, and no email');
  await review.waitForFunction(() => document.querySelector('.rv-tab [data-count="approved"]').textContent === '3');
  assert.deepEqual(await counts(review), [3, 3, 0]);
  assert.match(await text(review, '#rv-usage'), / of 600 photos\. Videos: 1, using 1 of 200 MB\.$/);
  await tab(review, 'approved');
  assert.deepEqual(await review.locator('.rv-card').evaluateAll((cards) => cards.map((c) => c.dataset.id)), [first.id, second.id, video.id]);
  assert.equal(await text(review, `.rv-card[data-id="${video.id}"] .rv-size`), 'Video · 0:03 MP4 · 0.1 MB · 640 × 360');
  assert.equal(await text(review, `.rv-card[data-id="${video.id}"] .rv-name`), 'Added by Eugene Aiken');
  assert.equal(await card(review, video.id).locator('.rv-email').count(), 0);
  assert.equal(await text(review, `.rv-card[data-id="${video.id}"] .rv-cap-text`), 'The step show');
  assert.deepEqual(await acts(review, video.id), ['waiting']);
  assert.equal(await text(review, '#rv-shown'), '2 photos and 1 video approved, oldest first');
  await review.waitForFunction((id) => document.querySelector(`.rv-card[data-id="${id}"] .rv-thumb img`).naturalWidth === 480, video.id);
  await shot(review, 'video-approved');

  step('it plays in the full view, where the arrow keys are the video\'s own');
  await card(review, video.id).locator('.rv-thumb').click();
  await playing(review, video.id, '3 of 3 approved');
  assert.deepEqual(await review.evaluate(() => {
    const v = document.querySelector('#rv-view-video');
    return [v.videoWidth, v.videoHeight, v.controls, v.hidden, document.querySelector('#rv-view-img').hidden];
  }), [640, 360, true, false, true]);
  assert.equal(await text(review, '#rv-view-who .rv-view-name'), 'Added by Eugene Aiken Video · 0:03 MP4 · 0.1 MB · 640 × 360');
  await review.evaluate(() => document.querySelector('#rv-view-video').play());
  await review.waitForFunction(() => document.querySelector('#rv-view-video').currentTime > 0.5);
  await shot(review, 'video-full-view', 0);
  await review.focus('#rv-view-video');
  await review.keyboard.press('ArrowLeft'); // winds the video back; from a button it would open the photo before
  await review.waitForTimeout(300);
  assert.equal(await review.locator('#rv-view-video').getAttribute('data-id'), video.id);
  assert.equal(await text(review, '#rv-view-pos'), '3 of 3 approved');
  await review.click('#rv-view-close');
  await review.waitForFunction(() => !document.querySelector('#rv-view').open && !document.querySelector('#rv-view-video').hasAttribute('src'));

  step('a second slideshow, in real time, plays the video between the photos');
  const stage = await open('second screen', BIG_SCREEN, '/school-daze/screen.html');
  const live = stage.page;
  await live.waitForSelector('#sc-setup');
  await live.fill('#sc-code', DROP_SCREEN_CODE);
  for (const [name, value] of [['seconds', '5'], ['order', 'oldest'], ['every', '5']]) await live.click(`label.sc-choice:has(input[name="${name}"][value="${value}"])`);
  await live.click('#sc-start');
  await live.waitForSelector('#sc-stage');
  await live.waitForSelector('.sc-slide.is-on:not(.is-clip)'); // a photo first
  assert.deepEqual((await answered('second screen', 'screen')).map((a) => [a.status, a.body.photos.map((p) => p.id), a.body.videos.map((v) => [v.id, v.bytes, v.caption])]),
    [[200, [first.id, second.id], [[video.id, clip.length, 'The step show']]]]);
  // The video comes down in the background before its turn, and the controls say how that is
  // going while they are in sight: moving the mouse brings them up. With two photos and a video
  // after every five, its turn is after each pass through the photos.
  await nudge(live);
  await live.waitForFunction(() => document.querySelector('#sc-clips').textContent === 'Videos: 1 of 1 ready', null, { timeout: 30000 });
  await live.waitForSelector(`.sc-slide.is-clip.is-on[data-id="${video.id}"]`, { timeout: 45000 });
  await live.waitForFunction(() => document.querySelector('.sc-slide.is-clip.is-on video.sc-clip').currentTime > 0.5);
  assert.deepEqual(await live.locator('.sc-slide.is-clip.is-on video.sc-clip').evaluate((v) => [v.videoWidth, v.videoHeight, v.muted, v.paused]), [640, 360, true, false],
    'the video itself, playing, with no sound unless sound is switched on');
  assert.equal(await text(live, '.sc-slide.is-clip.is-on .sc-caption'), 'The step show');
  await shot(live, 'slideshow-video', 0);
  await live.waitForSelector('.sc-slide.is-on:not(.is-clip)', { timeout: 30000 }); // and a photo after it

  step('Back to waiting takes the video out of the show at the slideshow\'s next check');
  await review.waitForTimeout(SETTLE);
  await card(review, video.id).locator('[data-act="waiting"]').click();
  await until('the video to be waiting', async () => (await rows()).find((r) => r.kind === 'video').status === 'waiting');
  assert.deepEqual(await counts(review), [4, 2, 0]);
  await tab(review, 'waiting');
  assert.deepEqual(await acts(review, video.id), ['view', 'reject'], 'a waiting video is approved from the full view only, like a photo');
  assert.equal(await text(review, '#rv-shown'), '3 photos and 1 video waiting, oldest first. Open one to approve it.');
  // The check comes once a minute, and this slideshow's minute is a real one.
  for (let i = 0; i < 750; i += 1) {
    const asked = await answered('second screen', 'screen');
    if (asked.length > 1 && asked[asked.length - 1].body.videos.length === 0) break;
    assert.ok(i < 749, 'the slideshow asked again within 75 seconds');
    await live.waitForTimeout(100);
  }
  await nudge(live);
  await live.waitForFunction(() => document.querySelector('#sc-clips').hidden);
  await live.evaluate(() => {
    window.clipsShown = 0;
    new MutationObserver((changes) => {
      for (const change of changes) for (const node of change.addedNodes) if (node.classList && node.classList.contains('is-clip')) window.clipsShown += 1;
    }).observe(document.querySelector('#sc-slides'), { childList: true });
  });
  await live.waitForTimeout(12000); // more than a pass through the two photos, at 5 seconds each
  assert.equal(await live.evaluate(() => window.clipsShown), 0, 'no video in the pass after the check');
  await stage.ctx.close();

  // ------------------------------------------------------------------ closing, and cleaning up
  step('closing uploads on the review page turns the upload page to its closed state');
  await review.click('#rv-uploads summary');
  assert.equal(await text(review, '#rv-state-pill'), 'Open');
  await review.click('label.rv-switch');
  await until('the switch to be saved', async () => (await server.sql(`select value from cal_private.config where key = 'drop_open'`))[0].value === 'false');
  assert.equal(await text(review, '#rv-state-pill'), 'Closed');
  assert.equal(await text(review, '#rv-state'), 'Closed. Nobody can send photos until you switch this back on.');
  await later.page.reload();
  await later.page.waitForSelector('#ph-closed');
  assert.equal(await text(later.page, '#ph-closed h2'), 'Photo uploads have closed');
  assert.equal(await later.page.locator('#ph-party').isVisible(), true);
  assert.equal(await later.page.locator('#ph-form').isVisible(), false);
  await shot(later.page, 'closed');

  step('Delete on the Rejected tab removes that photo and its two files');
  const third = (await rows())[2];
  await review.waitForTimeout(SETTLE);
  await card(review, third.id).locator('[data-act="reject"]').click();
  await until('the photo to be rejected', async () => (await statuses())[2] === 'rejected');
  await tab(review, 'rejected');
  await review.waitForTimeout(SETTLE);
  await card(review, third.id).locator('[data-act="delete"]').click();
  await review.waitForSelector('#rv-confirm[open]');
  assert.equal(await text(review, '#rv-confirm-title'), 'Delete this photo for good?');
  await review.click('#rv-confirm-yes');
  await until('the photo to be deleted', async () => (await rows()).length === 5);
  assert.deepEqual([server.storage.read(third.path), server.storage.read(third.thumb_path)], [null, null]);
  assert.equal(server.storage.paths().length, 10, 'four photos and the video, each with its small picture');
  assert.deepEqual(await counts(review), [3, 2, 0]);

  step('Delete everything removes every photo, the video, every file, and a file no row points to');
  // A send that died partway while Storage was struggling can leave a file like this one. Files
  // under ten minutes old are left alone, in case their photo is still arriving.
  const stray = 'photos/00000000-0000-4000-8000-000000000000.jpg';
  server.storage.seed(stray, ONE_MORE.buffer);
  server.storage.files.get(stray).created -= 3600000;
  assert.equal(server.storage.paths().length, 11);
  assert.deepEqual(server.storage.paths().filter((path) => path.startsWith('videos/')), [video.path]);
  await unfold(review, '#rv-tools');
  await review.click('#rv-empty-all');
  await review.waitForSelector('#rv-confirm[open]');
  assert.match(await text(review, '#rv-confirm-text'), /^This deletes every photo and video and their files for good: 3 waiting, 2 approved and 0 rejected\./);
  assert.equal(await review.locator('#rv-confirm-yes').isDisabled(), true, 'not until the word is typed');
  await review.fill('#rv-confirm-input', 'DELETE');
  await shot(review, 'delete-everything');
  await review.click('#rv-confirm-yes');
  await review.waitForSelector('#rv-toast');
  assert.equal(await text(review, '#rv-toast-text'), 'Deleted 4 photos and 1 video. The drop is empty.');
  assert.equal((await rows()).length, 0);
  assert.deepEqual(server.storage.paths(), [], 'nothing is left, in videos/ or anywhere else');
  assert.deepEqual(await counts(review), [0, 0, 0]);

  step('the slideshow goes back to its title card at the next check');
  await show.clock.fastForward(61000);
  await show.waitForSelector('#sc-stage:not(.has-photo)');
  await show.clock.runFor(2000); // the last photo fades out and leaves the page
  assert.deepEqual(await onScreen(show), []);
  assert.equal(await show.locator('#sc-title').isVisible(), true);

  // ------------------------------------------------------------------ nothing went wrong quietly
  step('no page logged an error, beyond the browser\'s own line for the four refusals above');
  assert.deepEqual(server.dropLog, [], 'the function logged nothing');
  assert.deepEqual(refusals.sort(), ['guest later send 409', 'guest open 403', 'organizer review 403', 'venue screen 403']);
  assert.deepEqual(errors, []);
  console.log('Photo drop passed: a guest who sends, an organizer who reviews, the slideshow, a video from the committee, closing, and deleting.');
} catch (e) {
  // Show what each page was displaying, so the failure explains itself.
  console.error(`\nFAILED at: ${current}\n`);
  console.error(e);
  for (const x of opened) {
    const shown = await x.page.evaluate(() => document.body.innerText).catch(() => '(closed)');
    console.error(`\n--- ${x.name}\n${shown.replace(/\n{2,}/g, '\n').slice(0, 1200)}`);
  }
  await Promise.all(reading).catch(() => {});
  console.error('\nthe function\'s answers:\n' + answers.map((a) => `${a.who} ${a.route} ${a.status} ${JSON.stringify(a.body).slice(0, 160)}`).join('\n'));
  if (server.dropLog.length) console.error('\nthe function\'s log:\n' + server.dropLog.join('\n'));
  if (errors.length) console.error('\nbrowser errors:\n' + errors.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  await server.close();
}
