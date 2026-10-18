// Live mode, end to end in a real browser, against a local stand-in for Supabase
// (live-server.mjs) that runs the real migration, seed, row level security, and storage policies.
//
// A visitor sees only the sign-in prompt. The media team creates a login and claims it with the
// media code. A brother joins on his phone and can only view. The media team makes him a committee
// chair; he sends a request with a photo and a PDF attached, answers a question by swapping a file,
// and sees it approved. The media team opens his files. He signs in on a laptop, which signs out
// the phone. The media team resets his PIN, makes him a viewer again, and finally removes him.
// The home page's Sign in button opens the sign-in panel. Last, the media team connects Instagram
// and Threads through the real Edge Function (with Meta simulated), matches a post by hand, refreshes,
// and disconnects.
//
//   npm install --no-save @electric-sql/pglite@0.5.8 playwright@1.56.0
//   npx playwright install chromium   (once)
//   node tests/calendar/live-smoke.mjs
//
// Optional: SCREENSHOTS=dir saves screenshots along the way.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startLiveServer } from './live-server.mjs';
import { CHAPTER_CODE, MEDIA_CODE } from './harness.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SHOTS = process.env.SCREENSHOTS || '';
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const DESKTOP = { width: 1366, height: 900 };
const PHONE = { width: 390, height: 844 };
const PHOTO = { name: 'chapter-flyer.png', mimeType: 'image/png', buffer: readFileSync(join(root, 'gil-crest.png')) };
const PDF = { name: 'run of show.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n') };
const NOTE = { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('not a photo') };

const nyDate = (offsetDays = 0) => {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(d);
};
const step = (s) => console.log('·', s);

const server = await startLiveServer({ port: 5181 });
const browser = await chromium.launch();
const errors = [];
const opened = [];

async function open(name, viewport, path = '/calendar.html') {
  const ctx = await browser.newContext({ viewport, timezoneId: 'America/New_York', acceptDownloads: true });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(`${name}: ${m.text()}`);
  });
  await page.route(/fonts\.googleapis\.com|fonts\.gstatic\.com|googletagmanager\.com/, (r) => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  opened.push({ name, page });
  await page.goto(`${server.origin}${path}`);
  if (path.startsWith('/calendar')) await ready(page);
  return { ctx, page };
}
const ready = (page) => page.waitForFunction(() => !/Opening the 2026-2027 calendar/.test(document.querySelector('#gc-view')?.textContent || ''));

// On a failure, show what each page was displaying so the failure explains itself.
process.on('uncaughtException', async (e) => {
  console.error(e);
  for (const x of opened) {
    const text = await x.page.evaluate(() => (document.querySelector('.gc-main') || document.body)?.innerText || '').catch(() => '');
    console.error(`\n--- ${x.name}\n${text.replace(/\n{2,}/g, '\n').slice(0, 1200)}`);
  }
  if (errors.length) console.error('errors:\n' + errors.join('\n'));
  process.exit(1);
});

const D = (page) => page.locator('#gc-drawer');
const toast = async (page, re) => {
  await page.waitForFunction((src) => {
    const t = document.querySelector('#gc-toast');
    return t && !t.hidden && new RegExp(src).test(t.textContent);
  }, re.source, { timeout: 8000 });
};
const formError = async (page, re) => {
  await page.waitForFunction((src) => new RegExp(src).test(document.querySelector('#gc-form-err')?.textContent || ''), re.source, { timeout: 8000 });
};
const shot = async (page, name) => { if (SHOTS) { await page.waitForTimeout(300); await page.screenshot({ path: `${SHOTS}/live-${name}.png` }); } };
const one = async (sql, params) => (await server.sql(sql, params))[0];
const reload = async (page) => { await page.reload(); await ready(page); };

// ------------------------------------------------------------------ visitors
step('a visitor sees only the sign-in prompt, and no calendar data is read');
const visitor = await open('visitor', DESKTOP);
const visitorReads = [];
visitor.page.on('request', (r) => { if (/\/rest\/v1\/cal_(posts|requests)/.test(r.url())) visitorReads.push(r.url()); });
await reload(visitor.page);
await visitor.page.waitForSelector('.empty h2:has-text("Sign in to see the calendar")');
assert.equal(await visitor.page.locator('#gc-bar').isHidden(), true, 'no tabs or filters for visitors');
assert.equal(visitorReads.length, 0, 'the page does not even ask for posts');

step('the home page has a Sign in button that opens the sign-in panel');
const home = await open('home', DESKTOP, '/index.html');
await home.page.locator('#main-nav a.nav-signin').click();
await home.page.waitForURL(/calendar\.html/);
await ready(home.page);
await home.page.waitForSelector('#gc-drawer:not([hidden]) .modes');
assert.equal(new URL(home.page.url()).hash, '', 'the #signin hash is cleared');
await home.ctx.close();

// ------------------------------------------------------------------ media team
step('the media team creates a login and claims it with the media code');
const media = await open('media', DESKTOP);
await media.page.locator('#gc-actions').getByRole('button', { name: 'Sign in' }).click();
await media.page.locator('.modes .seg', { hasText: 'Media team' }).click();
await media.page.fill('#s-email', 'eugene@example.org');
await media.page.fill('#s-password', 'black and gold 1906');
await D(media.page).getByRole('button', { name: 'Create login' }).click();
await media.page.waitForSelector('#s-staff-name');
await media.page.fill('#s-staff-name', 'Eugene Aiken');
await media.page.fill('#s-media-code', 'not the code');
await D(media.page).getByRole('button', { name: 'Join the media team' }).click();
await formError(media.page, /media code is not right/);
await media.page.fill('#s-media-code', MEDIA_CODE.toUpperCase());
await D(media.page).getByRole('button', { name: 'Join the media team' }).click();
await toast(media.page, /Signed in as Eugene Aiken/);
await media.page.waitForSelector('.who:has-text("Eugene Aiken")');

step('the media team sees the full seeded calendar, with no Facebook anywhere');
await media.page.locator('.tab', { hasText: 'Agenda' }).click();
await media.page.check('#gc-past');
await media.page.waitForFunction(() => document.querySelectorAll('#gc-view .row').length === 128);

step('the media team adds a post and changes its status');
await media.page.getByRole('button', { name: 'Add post' }).first().click();
assert.equal(await media.page.locator('input[name="p-platforms"][value="facebook"]').count(), 0, 'Facebook is not offered');
await media.page.fill('#p-title', 'Live smoke post');
await media.page.fill('#p-date', nyDate(25));
await media.page.fill('#p-caption', 'Caption for brothers');
await D(media.page).getByRole('button', { name: 'Add to calendar' }).click();
await toast(media.page, /Post added/);
const staffUser = [...server.users.values()].find((u) => u.email === 'eugene@example.org');
const post = await one(`select id, updated_by, platforms from public.cal_posts where title = 'Live smoke post'`);
assert.equal(post.updated_by, staffUser.id);
assert.deepEqual(post.platforms, ['instagram', 'threads']);
await media.page.locator('.row', { hasText: 'Live smoke post' }).click();
await media.page.selectOption('#gc-quick-status', 'ready');
await toast(media.page, /Marked ready/);
assert.equal((await one('select status from public.cal_posts where id = $1', [post.id])).status, 'ready');
await media.page.keyboard.press('Escape');

// ------------------------------------------------------------------ a brother: view only
step('a brother joins on his phone with the chapter code and can only view');
const phone = await open('phone', PHONE);
await phone.page.locator('#gc-actions').getByRole('button', { name: 'Sign in' }).click();
await phone.page.fill('#s-code', 'wrong code');
await phone.page.fill('#s-name', 'Jean Louis');
await phone.page.selectOption('#s-committee', 'Education');
await phone.page.fill('#s-pin', '24680');
await D(phone.page).getByRole('button', { name: 'Sign in', exact: true }).click();
await formError(phone.page, /chapter code is not right/);
await phone.page.fill('#s-code', `  ${CHAPTER_CODE.toLowerCase()} `);
await D(phone.page).getByRole('button', { name: 'Sign in', exact: true }).click();
await toast(phone.page, /Signed in as Jean Louis/);
await phone.page.waitForSelector('#gc-view .row');
assert.equal(await phone.page.locator('#gc-actions').getByRole('button', { name: 'Request a post' }).count(), 0, 'brothers cannot request');
assert.equal(await phone.page.locator('.tab[data-view="requests"]').isHidden(), true, 'no Requests tab for brothers');
assert.equal(await phone.page.locator('.tab[data-view="results"]').isHidden(), true, 'no Results tab for brothers');
const brotherReads = await phone.page.evaluate(async () => {
  const r = await fetch('/rest/v1/cal_social_posts?select=*', { headers: { apikey: 'sb_publishable_test', Authorization: `Bearer ${JSON.parse(localStorage.getItem('gilcal.auth')).access_token}` } });
  return r.json();
});
assert.deepEqual(brotherReads, [], 'brothers read no results, even asking the Data API directly');
await phone.page.locator('.row', { hasText: 'Live smoke post' }).click();
assert.match(await D(phone.page).innerText(), /Caption for brothers/);
await phone.page.keyboard.press('Escape');
await shot(phone.page, 'phone-brother');

// ------------------------------------------------------------------ the media team makes him a chair
step('the media team makes him the Education chair');
await media.page.getByRole('button', { name: 'Manage access' }).click();
await media.page.waitForSelector('.person:has-text("Jean Louis")');
await media.page.locator('.person', { hasText: 'Jean Louis' }).getByRole('button', { name: 'Make chair' }).click();
await media.page.selectOption('.person select', 'Education');
await media.page.locator('.person', { hasText: 'Jean Louis' }).getByRole('button', { name: 'Make chair' }).click();
await toast(media.page, /Jean Louis can now send requests for Education/);
assert.deepEqual(await one(`select chair, committee from public.cal_members where display_name = 'Jean Louis'`), { chair: true, committee: 'Education' });
await media.page.waitForSelector('.person:has-text("Jean Louis") .pill:has-text("Chair")');
await shot(media.page, 'access');
await media.page.keyboard.press('Escape');

step('as a chair, he sends a request with a photo and a PDF attached');
await reload(phone.page);
await phone.page.locator('#gc-actions').getByRole('button', { name: 'Request a post' }).click();
assert.equal(await phone.page.inputValue('#r-name'), 'Jean Louis');
assert.equal(await phone.page.inputValue('#r-committee'), 'Education');
await phone.page.fill('#r-title', 'Alpha Academy college tour');
await phone.page.fill('#r-date', nyDate(30));
await phone.page.fill('#r-about', 'Alpha Academy visits Howard. Photos from the chaperones.');
await phone.page.setInputFiles('#r-files', [NOTE]);
await phone.page.waitForSelector('#gc-files-err:not([hidden])');
assert.match(await phone.page.textContent('#gc-files-err'), /isn't a photo, video, or PDF/);
await phone.page.setInputFiles('#r-files', [PHOTO, PDF]);
await phone.page.waitForFunction(() => document.querySelectorAll('#gc-filelist .filerow').length === 2);
await shot(phone.page, 'request-files');
await D(phone.page).getByRole('button', { name: 'Send request' }).click();
await toast(phone.page, /Request sent/);
const chairRow = await one(`select id from public.cal_members where display_name = 'Jean Louis'`);
let req = await one(`select id, status, member_id, platforms, files from public.cal_requests where title = 'Alpha Academy college tour'`);
assert.equal(req.status, 'new');
assert.equal(req.member_id, chairRow.id);
assert.deepEqual(req.platforms, ['instagram']);
assert.equal(req.files.length, 2);
assert.ok(req.files.every((f) => f.path.startsWith(`requests/${chairRow.id}/`)), 'files sit in his folder');
assert.deepEqual(req.files.map((f) => f.name), ['chapter-flyer.png', 'run of show.pdf']);
assert.equal(server.files.size, 2);

step('the media team opens the request and the files load through signed links');
await reload(media.page);
await media.page.waitForSelector('#gc-req-badge:not([hidden])');
await media.page.locator('.tab', { hasText: 'Requests' }).click();
await media.page.locator('.req', { hasText: 'Alpha Academy college tour' }).getByRole('button', { name: 'Open' }).click();
await media.page.waitForFunction(() => {
  const img = document.querySelector('#gc-drawer .thumb.k-image img');
  return img && img.complete && img.naturalWidth > 0;
});
const dl = await D(media.page).locator('.thumb.k-pdf .thumb-dl').getAttribute('href');
assert.match(dl, /download=run%20of%20show\.pdf/);
const fetched = await media.page.request.get(dl);
assert.equal(fetched.status(), 200);
assert.match(fetched.headers()['content-disposition'] || '', /attachment/);
assert.ok((await fetched.body()).toString().startsWith('%PDF'));
await shot(media.page, 'request-files-staff');

step('the media team asks a question; he swaps the PDF for another photo');
await D(media.page).getByRole('button', { name: 'Ask for info' }).click();
await media.page.fill('#gc-review-note', 'Send one more photo instead of the PDF.');
await D(media.page).getByRole('button', { name: 'Send question' }).click();
await toast(media.page, /Question sent/);
await media.page.keyboard.press('Escape');
await reload(phone.page);
await phone.page.waitForSelector('#gc-req-badge:not([hidden])');
await phone.page.locator('.tab', { hasText: 'Requests' }).click();
await phone.page.locator('.req', { hasText: 'Alpha Academy college tour' }).getByRole('button', { name: 'Edit' }).click();
await phone.page.waitForFunction(() => document.querySelectorAll('#gc-filelist .filerow').length === 2);
await phone.page.getByRole('button', { name: 'Remove run of show.pdf' }).click();
await phone.page.setInputFiles('#r-files', [{ ...PHOTO, name: 'second-photo.png' }]);
await phone.page.check('#r-youth');
await phone.page.check('#r-releases');
await D(phone.page).getByRole('button', { name: 'Update request' }).click();
await toast(phone.page, /Request updated/);
req = await one('select status, files from public.cal_requests where title = $1', ['Alpha Academy college tour']);
assert.equal(req.status, 'new');
assert.deepEqual(req.files.map((f) => f.name), ['chapter-flyer.png', 'second-photo.png']);
let objects = [];
for (let i = 0; i < 40; i++) { // the page removes the old file right after the update saves
  objects = await server.sql(`select name from storage.objects where bucket_id = 'calendar-files' order by name`);
  if (objects.length === 2) break;
  await new Promise((r) => setTimeout(r, 100));
}
assert.equal(objects.length, 2, 'the removed PDF is deleted from storage');
assert.ok(!objects.some((o) => o.name.endsWith('run-of-show.pdf')));

step('the media team approves it; the post shows the request files');
await reload(media.page);
await media.page.locator('.tab', { hasText: 'Requests' }).click();
await media.page.locator('.req', { hasText: 'Alpha Academy college tour' }).getByRole('button', { name: 'Add to calendar' }).click();
assert.equal(await media.page.inputValue('#p-committee'), 'Education');
await D(media.page).getByRole('button', { name: 'Add to calendar' }).click();
await toast(media.page, /Request added to the calendar/);
const approved = await one(`select r.status, p.request_id, p.title from public.cal_requests r join public.cal_posts p on p.id = r.post_id where r.title = 'Alpha Academy college tour'`);
assert.equal(approved.status, 'approved');
await media.page.locator('.seg', { hasText: 'On the calendar' }).click();
await media.page.locator('.req', { hasText: 'Alpha Academy college tour' }).getByRole('button', { name: 'See the post' }).click();
await media.page.waitForSelector('#gc-drawer h4:has-text("Files from the request")');
await media.page.waitForFunction(() => document.querySelectorAll('#gc-drawer .thumb img').length === 2);
await media.page.keyboard.press('Escape');

step('he sees it on the calendar');
await reload(phone.page);
await phone.page.locator('.tab', { hasText: 'Requests' }).click();
await phone.page.waitForSelector('.req:has-text("Alpha Academy college tour") .pill:has-text("On the calendar")');

// ------------------------------------------------------------------ a second device
step('signing in on a laptop needs the right PIN, and signs out the phone');
const laptop = await open('laptop', DESKTOP);
await laptop.page.locator('#gc-actions').getByRole('button', { name: 'Sign in' }).click();
await laptop.page.locator('.modes .seg', { hasText: "I've signed in before" }).click();
await laptop.page.fill('#s-name', 'jean louis');
await laptop.page.fill('#s-pin', '11111');
await D(laptop.page).getByRole('button', { name: 'Sign in', exact: true }).click();
await formError(laptop.page, /PIN does not match/);
await laptop.page.fill('#s-pin', '24680');
await D(laptop.page).getByRole('button', { name: 'Sign in', exact: true }).click();
await toast(laptop.page, /Signed in as Jean Louis/);
await laptop.page.waitForSelector('#gc-actions >> text=Request a post');
await phone.page.reload();
await toast(phone.page, /signed out on this device/);
await phone.page.locator('#gc-actions').getByRole('button', { name: 'Sign in' }).click();
assert.match(await D(phone.page).innerText(), /signed in on another phone or computer/);
assert.equal(await phone.page.inputValue('#s-name'), 'Jean Louis');
await phone.page.keyboard.press('Escape');

step('the media team resets his PIN; the new PIN works on the phone');
await media.page.getByRole('button', { name: 'Manage access' }).click();
await media.page.waitForSelector('.person:has-text("Jean Louis")');
await media.page.locator('.person', { hasText: 'Jean Louis' }).getByRole('button', { name: 'Reset PIN' }).click();
await media.page.locator('.person input[type=password]').fill('1357');
await D(media.page).getByRole('button', { name: 'Save PIN' }).click();
await toast(media.page, /PIN reset/);
await phone.page.locator('#gc-actions').getByRole('button', { name: 'Sign in' }).click();
await phone.page.fill('#s-pin', '1357');
await D(phone.page).getByRole('button', { name: 'Sign in', exact: true }).click();
await toast(phone.page, /Signed in as Jean Louis/);

step('the media team makes him a viewer again; he can no longer request');
await media.page.locator('.person', { hasText: 'Jean Louis' }).getByRole('button', { name: 'Make viewer' }).click();
await toast(media.page, /no longer sends requests/);
await reload(phone.page);
await phone.page.waitForSelector('#gc-view .row, #gc-view .monthbar');
assert.equal(await phone.page.locator('#gc-actions').getByRole('button', { name: 'Request a post' }).count(), 0);

step('the media team removes him; his request and files stay');
await media.page.locator('.person', { hasText: 'Jean Louis' }).getByRole('button', { name: 'Remove' }).click();
await media.page.locator('.person', { hasText: 'Jean Louis' }).getByRole('button', { name: 'Remove' }).click();
await toast(media.page, /removed/);
assert.equal((await one(`select count(*)::int as n from public.cal_members`)).n, 0);
assert.equal((await one(`select contact_name from public.cal_requests where title = 'Alpha Academy college tour'`)).contact_name, 'Jean Louis');
await reload(phone.page);
await phone.page.waitForSelector('.empty h2:has-text("Sign in to see the calendar")');

step('the media team changes the chapter code');
await media.page.fill('#gc-new-code', 'Spring 2027 code');
await D(media.page).getByRole('button', { name: 'Change code' }).click();
await toast(media.page, /Chapter code changed/);
await media.page.keyboard.press('Escape');

step('the media team signs out and back in with email and password');
await media.page.locator('.who').getByRole('button', { name: 'Sign out' }).click();
await toast(media.page, /Signed out/);
await media.page.locator('#gc-actions').getByRole('button', { name: 'Sign in' }).click();
await media.page.locator('.modes .seg', { hasText: 'Media team' }).click();
await media.page.fill('#s-email', 'eugene@example.org');
await media.page.fill('#s-password', 'wrong password');
await D(media.page).getByRole('button', { name: 'Sign in', exact: true }).click();
await formError(media.page, /email and password do not match/);
await media.page.fill('#s-password', 'black and gold 1906');
await D(media.page).getByRole('button', { name: 'Sign in', exact: true }).click();
await toast(media.page, /Signed in as Eugene Aiken/);

// ------------------------------------------------------------------ results
step('Results starts with nothing connected');
// Two calendar posts on quiet days in the past, and what Instagram and Threads will report.
const quiet = [];
for (let i = 12; quiet.length < 3 && i < 300; i++) {
  const d = nyDate(-i);
  if (!(await one('select count(*)::int as n from public.cal_posts where date = $1', [d])).n) quiet.push(d);
}
// The unmatched post goes on the latest day: the list covers days since the calendar's first post.
const [dayC, dayA, dayB] = quiet;
await server.sql(`insert into public.cal_posts (id, date, title, category, platforms, status) values
  ('p-results-a', $1, 'Results post A', 'chapter', '{instagram,threads}', 'posted'), ('p-results-b', $2, 'Results post B', 'program', '{instagram}', 'posted')`, [dayA, dayB]);
server.meta.add('instagram', '1801', `${dayA}T22:00:00+0000`,
  { caption: 'Results post A on Instagram', media_type: 'IMAGE', media_product_type: 'FEED', permalink: 'https://www.instagram.com/p/A1/', like_count: 80, comments_count: 6 },
  { views: 900, reach: 700, likes: 80, comments: 6, saved: 9, shares: 12, total_interactions: 107 });
server.meta.add('instagram', '1802', `${dayC}T21:00:00+0000`,
  { caption: 'Thank you to everyone who came out', media_type: 'IMAGE', media_product_type: 'FEED', permalink: 'https://www.instagram.com/p/A2/', like_count: 30, comments_count: 2 },
  { views: 300, reach: 250, likes: 30, comments: 2, saved: 1, shares: 3, total_interactions: 36 });
server.meta.add('threads', '3101', `${dayA}T23:00:00+0000`,
  { text: 'Results post A on Threads', permalink: 'https://www.threads.com/@gil1906/post/T1', media_type: 'TEXT_POST', is_quote_post: false },
  { views: 200, likes: 10, replies: 2, reposts: 1, quotes: 0, shares: 1 });
// The Edge Function sends the browser to Instagram's or Threads' sign-in, which this test plays:
// it checks where the function sent the browser, then goes straight on to the callback with a code.
const signIns = [];
await media.page.route(/\/functions\/v1\/calendar-social\/connect/, async (route) => {
  const res = await route.fetch({ maxRedirects: 0 });
  const to = new URL(res.headers().location);
  signIns.push(to);
  const code = to.host === 'www.instagram.com' ? 'ig-code-1' : 'th-code-1';
  await route.fulfill({ status: 302, headers: { location: `${to.searchParams.get('redirect_uri')}?code=${code}&state=${to.searchParams.get('state')}` } });
});
await media.page.locator('.tab', { hasText: 'Results' }).click();
await media.page.waitForSelector('.results .acct');
assert.match(await media.page.locator('#gc-view').innerText(), /Connect the chapter's accounts/);

step('the media team connects Instagram through the Edge Function, and the first sync matches by date');
await media.page.locator('.acct', { hasText: 'Instagram' }).getByRole('button', { name: 'Connect Instagram' }).click();
await media.page.waitForSelector('.rnote:has-text("Instagram is connected")', { timeout: 15000 });
assert.equal(new URL(media.page.url()).search, '', 'the note from Connect leaves the address');
assert.equal(signIns[0].origin + signIns[0].pathname, 'https://www.instagram.com/oauth/authorize');
assert.equal(signIns[0].searchParams.get('redirect_uri'), `${server.origin}/functions/v1/calendar-social/callback`);
await server.settle();
assert.deepEqual(await one(`select username, account_id from public.cal_social_accounts where platform = 'instagram'`), { username: 'gil1906', account_id: '17841400000000001' });
assert.deepEqual(await server.sql(`select media_id, post_id, match_source from public.cal_social_posts order by media_id`), [
  { media_id: '1801', post_id: 'p-results-a', match_source: 'date' },
  { media_id: '1802', post_id: null, match_source: null }
]);
await reload(media.page);
await media.page.waitForSelector('.results .kpis');
await media.page.locator('.seg[data-period="all"]').click();
assert.match(await media.page.locator('.card', { hasText: 'Top posts' }).innerText(), /Results post A/);
assert.match(await media.page.locator('.card', { has: media.page.locator('h3', { hasText: 'Not matched yet' }) }).innerText(), /Thank you to everyone who came out/);
await shot(media.page, 'results');

step('he matches the other post by hand');
await media.page.locator('.card', { has: media.page.locator('h3', { hasText: 'Not matched yet' }) }).locator('.row').first().click();
await media.page.selectOption('#gc-social-post', 'p-results-b');
await D(media.page).getByRole('button', { name: 'Save match' }).click();
await toast(media.page, /Matched to Results post B/);
assert.deepEqual(await one(`select post_id, match_source from public.cal_social_posts where media_id = '1802'`), { post_id: 'p-results-b', match_source: 'manual' });
await media.page.keyboard.press('Escape');

step('the media team connects Threads too');
await media.page.locator('.acct', { hasText: 'Threads' }).getByRole('button', { name: 'Connect Threads' }).click();
await media.page.waitForSelector('.rnote:has-text("Threads is connected")', { timeout: 15000 });
assert.equal(signIns[1].origin + signIns[1].pathname, 'https://threads.com/oauth/authorize');
await server.settle();
assert.deepEqual(await one(`select post_id, match_source from public.cal_social_posts where media_id = '3101'`), { post_id: 'p-results-a', match_source: 'date' });

step('Refresh now asks the Edge Function to sync, the way the nightly job does');
await reload(media.page);
await media.page.getByRole('button', { name: 'Refresh now' }).click();
await toast(media.page, /Refreshing/);
const call = await one('select url, headers from net.http_calls order by id desc limit 1');
assert.equal(call.url, `${server.origin}/functions/v1/calendar-social/sync`);
server.meta.numbers.set('1801', { views: 1250, reach: 900, likes: 95, comments: 7, saved: 10, shares: 15, total_interactions: 127 });
const synced = await fetch(call.url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-sync-key': call.headers['x-sync-key'] }, body: '{}' });
assert.equal(synced.status, 202);
await server.settle();
assert.equal((await one(`select views::int from public.cal_social_posts where media_id = '1801'`)).views, 1250);

step("the post's drawer on the calendar shows its results");
await reload(media.page);
await media.page.locator('.seg[data-period="all"]').click();
await media.page.locator('.postbtn', { hasText: 'Results post A' }).first().click();
await D(media.page).locator('.resline [data-act="post"]').click();
await media.page.waitForSelector('#gc-drawer h4:has-text("Results")');
assert.match(await D(media.page).locator('.block', { hasText: 'Results' }).innerText(), /1,250\s+views/);
await media.page.keyboard.press('Escape');

step('the media team disconnects Threads; its token is gone and its numbers stay');
const thCard = () => media.page.locator('.acct', { hasText: 'Threads' });
await thCard().getByRole('button', { name: 'Disconnect' }).click();
await thCard().getByRole('button', { name: 'Disconnect' }).click();
await toast(media.page, /Threads disconnected/);
assert.equal((await one(`select count(*)::int as n from public.cal_social_accounts where platform = 'threads'`)).n, 0);
assert.equal((await one(`select count(*)::int as n from vault.secrets where name = 'calendar_threads_token'`)).n, 0);
assert.equal((await one(`select count(*)::int as n from public.cal_social_posts where platform = 'threads'`)).n, 1);

await browser.close();
await server.close();
if (errors.length) {
  console.error('Browser errors:\n' + errors.join('\n'));
  process.exit(1);
}
console.log('Live mode passed: visitors locked out, a brother who views, a chair who requests with files, the media team, and Results.');
