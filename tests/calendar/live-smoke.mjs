// Live mode, end to end in a real browser, against a local stand-in for Supabase
// (live-server.mjs) that runs the real migration, seed, and row level security.
//
// The media team creates a login, claims it with the media code, adds a post, and turns on the
// public calendar. A visitor then sees public fields only. A brother joins on a phone, sends a
// request, answers the media team's question, and sees it approved. He signs in on a laptop, which
// signs out the phone. The media team resets his PIN and finally removes him.
//
//   npm install --no-save @electric-sql/pglite@0.5.8 playwright@1.56.0
//   npx playwright install chromium   (once)
//   node tests/calendar/live-smoke.mjs
//
// Optional: SCREENSHOTS=dir saves screenshots along the way.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { startLiveServer } from './live-server.mjs';
import { CHAPTER_CODE, MEDIA_CODE } from './harness.mjs';

const SHOTS = process.env.SCREENSHOTS || '';
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const DESKTOP = { width: 1366, height: 900 };
const PHONE = { width: 390, height: 844 };

const nyDate = (offsetDays = 0) => {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(d);
};
const step = (s) => console.log('·', s);

const server = await startLiveServer({ port: 5181 });
const browser = await chromium.launch();
const errors = [];
const opened = [];

async function open(name, viewport) {
  const ctx = await browser.newContext({ viewport, timezoneId: 'America/New_York' });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(`${name}: ${m.text()}`);
  });
  await page.route(/fonts\.googleapis\.com|fonts\.gstatic\.com|googletagmanager\.com/, (r) => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  opened.push({ name, page });
  await page.goto(`${server.origin}/calendar.html`);
  await page.waitForFunction(() => !/Opening the 2026-2027 calendar/.test(document.querySelector('#gc-view')?.textContent || ''));
  return { ctx, page };
}

// On a failure, show what each page was displaying so the failure explains itself.
process.on('uncaughtException', async (e) => {
  console.error(e);
  for (const x of opened) {
    const text = await x.page.evaluate(() => document.querySelector('.gc-main')?.innerText || '').catch(() => '');
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

// ------------------------------------------------------------------ visitor, private calendar
step('a visitor sees the sign-in prompt while the calendar is private');
const visitor = await open('visitor', DESKTOP);
await visitor.page.waitForSelector('.empty h2:has-text("Sign in to see the calendar")');

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

step('the media team sees the full seeded calendar');
await media.page.locator('.tab', { hasText: 'Agenda' }).click();
await media.page.check('#gc-past');
await media.page.waitForFunction(() => document.querySelectorAll('#gc-view .row').length === 128);

step('the media team adds a post and changes its status');
await media.page.getByRole('button', { name: 'Add post' }).first().click();
await media.page.fill('#p-title', 'Live smoke post');
await media.page.fill('#p-date', nyDate(25));
await media.page.fill('#p-caption', 'Private caption for brothers');
await media.page.fill('#p-notes', 'Private note');
await D(media.page).getByRole('button', { name: 'Add to calendar' }).click();
await toast(media.page, /Post added/);
const staffUser = [...server.users.values()].find((u) => u.email === 'eugene@example.org');
let post = await one(`select id, status, updated_by, platforms from public.cal_posts where title = 'Live smoke post'`);
assert.equal(post.updated_by, staffUser.id);
assert.deepEqual(post.platforms, ['instagram', 'facebook', 'threads']);
await media.page.locator('.row', { hasText: 'Live smoke post' }).click();
await media.page.selectOption('#gc-quick-status', 'ready');
await toast(media.page, /Marked ready/);
assert.equal((await one('select status from public.cal_posts where id = $1', [post.id])).status, 'ready');
await shot(media.page, 'post-drawer');
await media.page.keyboard.press('Escape');

step('the media team turns on the public calendar');
await media.page.getByRole('button', { name: 'Manage access' }).click();
await media.page.waitForSelector('#gc-set-public');
await media.page.check('#gc-set-public');
await toast(media.page, /calendar is public/);
assert.equal((await one(`select value from cal_private.config where key = 'calendar_public'`)).value, 'true');
await media.page.keyboard.press('Escape');

step('a visitor now sees the calendar with public fields only');
const publicReads = [];
visitor.page.on('request', (r) => { if (r.url().includes('/rest/v1/cal_posts')) publicReads.push(decodeURIComponent(r.url())); });
await visitor.page.reload();
await visitor.page.waitForSelector('#gc-view .monthbar, #gc-view .agendabar');
await visitor.page.locator('.tab', { hasText: 'Agenda' }).click();
await visitor.page.locator('.row', { hasText: 'Live smoke post' }).click();
const visitorDrawer = await D(visitor.page).innerText();
assert.ok(!/Private caption|Private note/.test(visitorDrawer), 'no private fields for visitors');
assert.match(visitorDrawer, /Brothers who sign in also see/);
assert.ok(publicReads.length && publicReads.every((u) => !u.includes('caption') && !u.includes('select=*')), 'visitor reads ask for public columns only');
assert.equal(await visitor.page.locator('#gc-actions').getByRole('button', { name: 'Sign in' }).count(), 1);

// ------------------------------------------------------------------ a brother on his phone
step('a brother joins on his phone with the chapter code');
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
await phone.page.waitForSelector('.who:has-text("Jean Louis")');
await shot(phone.page, 'phone-signed-in');

step('he sends a request');
await phone.page.locator('#gc-actions').getByRole('button', { name: 'Request a post' }).click();
assert.equal(await phone.page.inputValue('#r-name'), 'Jean Louis');
assert.equal(await phone.page.inputValue('#r-committee'), 'Education');
await phone.page.fill('#r-title', 'Alpha Academy college tour');
await phone.page.fill('#r-date', nyDate(30));
await phone.page.fill('#r-about', 'Alpha Academy visits Howard. Photos from the chaperones.');
await D(phone.page).getByRole('button', { name: 'Send request' }).click();
await toast(phone.page, /Request sent/);
let req = await one(`select id, status, member_id, platforms from public.cal_requests where title = 'Alpha Academy college tour'`);
assert.equal(req.status, 'new');
assert.ok(req.member_id);
assert.deepEqual(req.platforms, ['facebook', 'instagram']);

step('the media team asks a question');
await media.page.reload();
await media.page.waitForSelector('#gc-req-badge:not([hidden])');
await media.page.locator('.tab', { hasText: 'Requests' }).click();
await media.page.locator('.req', { hasText: 'Alpha Academy college tour' }).getByRole('button', { name: 'Open' }).click();
await D(media.page).getByRole('button', { name: 'Ask for info' }).click();
await media.page.fill('#gc-review-note', 'Send three curated photos with releases.');
await D(media.page).getByRole('button', { name: 'Send question' }).click();
await toast(media.page, /Question sent/);
assert.equal((await one('select status from public.cal_requests where id = $1', [req.id])).status, 'needs-info');
await media.page.keyboard.press('Escape');

step('the brother answers by updating his request');
await phone.page.reload();
await phone.page.waitForSelector('#gc-req-badge:not([hidden])');
await phone.page.locator('.tab', { hasText: 'Requests' }).click();
await phone.page.locator('.req', { hasText: 'Alpha Academy college tour' }).getByRole('button', { name: 'Edit' }).click();
await phone.page.fill('#r-asset', 'https://drive.google.com/drive/folders/college-tour');
await phone.page.check('#r-youth');
await phone.page.check('#r-releases');
await D(phone.page).getByRole('button', { name: 'Update request' }).click();
await toast(phone.page, /Request updated/);
req = await one('select status, youth, releases from public.cal_requests where id = $1', [req.id]);
assert.deepEqual(req, { status: 'new', youth: true, releases: true });

step('the media team approves it onto the calendar');
await media.page.reload();
await media.page.locator('.tab', { hasText: 'Requests' }).click();
await media.page.locator('.req', { hasText: 'Alpha Academy college tour' }).getByRole('button', { name: 'Add to calendar' }).click();
assert.equal(await media.page.inputValue('#p-committee'), 'Education');
await D(media.page).getByRole('button', { name: 'Add to calendar' }).click();
await toast(media.page, /Request added to the calendar/);
const approved = await one(`select r.status, r.post_id, p.request_id, p.title from public.cal_requests r join public.cal_posts p on p.id = r.post_id where r.title = 'Alpha Academy college tour'`);
assert.equal(approved.status, 'approved');
assert.equal(approved.title, 'Alpha Academy college tour');
await shot(media.page, 'requests-approved');

step('the brother sees it on the calendar');
await phone.page.reload();
await phone.page.locator('.tab', { hasText: 'Requests' }).click();
await phone.page.waitForSelector('.req:has-text("Alpha Academy college tour") .pill:has-text("On the calendar")');
await phone.page.locator('.req', { hasText: 'Alpha Academy college tour' }).getByRole('button', { name: 'See the post' }).click();
await phone.page.waitForSelector('#gc-drawer-title:has-text("Alpha Academy college tour")');
await phone.page.keyboard.press('Escape');

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
await phone.page.reload();
await toast(phone.page, /signed out on this device/);
await phone.page.locator('#gc-actions').getByRole('button', { name: 'Sign in' }).click();
assert.match(await D(phone.page).innerText(), /signed in on another phone or computer/);
assert.equal(await phone.page.inputValue('#s-name'), 'Jean Louis');
await shot(phone.page, 'phone-signed-out');
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

step('the media team removes him; his request stays with his name');
await media.page.locator('.person', { hasText: 'Jean Louis' }).getByRole('button', { name: 'Remove' }).click();
await media.page.locator('.person', { hasText: 'Jean Louis' }).getByRole('button', { name: 'Remove' }).click();
await toast(media.page, /removed/);
assert.equal((await one(`select count(*)::int as n from public.cal_members`)).n, 0);
assert.equal((await one(`select contact_name from public.cal_requests where title = 'Alpha Academy college tour'`)).contact_name, 'Jean Louis');
await phone.page.reload();
await phone.page.waitForSelector('#gc-actions >> text=Sign in');

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

await browser.close();
await server.close();
if (errors.length) {
  console.error('Browser errors:\n' + errors.join('\n'));
  process.exit(1);
}
console.log('Live mode passed: media team, visitor, brother on two devices, and access management.');
