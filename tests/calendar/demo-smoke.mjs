// Demo mode in a real browser: every role, the drawers, writes, exports, and phone layout.
// The page runs on sample data in the browser (assets/calendar/api-demo.js); no database needed.
//
//   npm install --no-save playwright@1.56.0
//   npx playwright install chromium   (once)
//   node tests/calendar/demo-smoke.mjs
//
// Optional: SCREENSHOTS=dir saves screenshots at desktop and phone widths.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync } from 'node:fs';
import { startLiveServer } from './live-server.mjs';

const SHOTS = process.env.SCREENSHOTS || '';
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const server = await startLiveServer({ port: 5182, demo: true });
const BASE = server.origin;
const step = (s) => console.log('·', s);
const shot = async (page, name, opts = {}) => { if (SHOTS) { await page.waitForTimeout(300); await page.screenshot({ path: `${SHOTS}/demo-${name}.png`, ...opts }); } };

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const inDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return iso(d); };

const browser = await chromium.launch();
const errors = [];
async function open(viewport) {
  const ctx = await browser.newContext({ viewport, timezoneId: 'America/New_York', acceptDownloads: true });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  await page.route(/fonts\.googleapis\.com|fonts\.gstatic\.com|googletagmanager\.com/, (r) => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  await page.goto(`${BASE}/calendar.html`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#gc-view .monthbar, #gc-view .agendabar');
  return { ctx, page };
}
const toastText = async (page) => { await page.waitForSelector('#gc-toast:not([hidden])'); return page.textContent('#gc-toast'); };
const drawer = (page) => page.locator('#gc-drawer');

// ------------------------------------------------------------------ desktop, media team
{
  const { ctx, page } = await open({ width: 1440, height: 900 });
  step('loads as the media team in the demo');
  assert.match(await page.textContent('.who'), /Media team \(demo\)/);
  assert.equal(await page.locator('.tab[aria-selected="true"]').textContent(), 'Calendar');
  assert.equal(await page.locator('#gc-req-badge').textContent(), '1');

  step('a post opens in a drawer fixed to the screen, even after scrolling');
  await page.mouse.wheel(0, 700);
  await page.waitForTimeout(400);
  await page.locator('.chip', { hasText: 'GIL brothers in NYACOA' }).click();
  await page.waitForSelector('#gc-drawer:not([hidden]) .dhead');
  await page.waitForTimeout(350); // let the slide-in finish
  const box = await drawer(page).boundingBox();
  assert.equal(Math.round(box.y), 0, 'drawer top sits at the top of the screen');
  assert.equal(Math.round(box.x + box.width), 1440);
  assert.equal(Math.round(box.height), 900);
  await shot(page, 'flow-post-drawer');

  step('quick status, edit, and save');
  await page.selectOption('#gc-quick-status', 'in-design');
  assert.match(await toastText(page), /Marked in design/);
  assert.match(await drawer(page).locator('.tags').textContent(), /In design/);
  await drawer(page).getByRole('button', { name: 'Edit' }).click();
  await page.fill('#p-title', 'GIL brothers in NYACOA leadership, confirmed');
  await drawer(page).getByRole('button', { name: 'Save changes' }).click();
  assert.match(await toastText(page), /Post saved/);
  assert.equal(await page.textContent('#gc-drawer-title'), 'GIL brothers in NYACOA leadership, confirmed');
  await page.keyboard.press('Escape');
  await page.waitForSelector('#gc-drawer', { state: 'hidden' });

  step('add a post with a bad link, then fix it');
  await page.getByRole('button', { name: 'Add post' }).first().click();
  await page.fill('#p-title', 'Smoke test post');
  await page.fill('#p-date', inDays(20));
  await page.fill('#p-link', 'javascript:alert(1)');
  await drawer(page).getByRole('button', { name: 'Add to calendar' }).click();
  assert.match(await page.textContent('#gc-form-err'), /https/);
  await page.fill('#p-link', 'https://gil1906.org/rsvp');
  await drawer(page).getByRole('button', { name: 'Add to calendar' }).click();
  assert.match(await toastText(page), /Post added/);

  step('agenda shows it, and both exports download');
  await page.locator('.tab', { hasText: 'Agenda' }).click();
  await page.waitForSelector('.agendabar');
  assert.ok(await page.locator('.row', { hasText: 'Smoke test post' }).count() === 1);
  const rows = await page.locator('#gc-view .row').count();
  const [csvDl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Spreadsheet' }).click()]);
  assert.equal(csvDl.suggestedFilename(), 'gil-content-calendar.csv');
  const csv = readFileSync(await csvDl.path(), 'utf8');
  assert.ok(csv.startsWith('﻿Date,Title,Category'));
  assert.equal(csv.trim().split('\r\n').length, rows + 1, 'one CSV row per agenda row');
  assert.match(csv, /Smoke test post/);
  const [icsDl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Calendar file' }).click()]);
  const ics = readFileSync(await icsDl.path(), 'utf8');
  assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\n'));
  assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, rows);
  for (const line of ics.split('\r\n')) assert.ok(Buffer.byteLength(line) <= 75, `ICS line too long: ${line}`);
  assert.match(ics, /SUMMARY:Smoke test post/);
  assert.match(ics, /URL:https:\/\/gil1906.org\/rsvp/);

  step('requests: approve the example request onto the calendar');
  await page.locator('.tab', { hasText: 'Requests' }).click();
  await page.waitForSelector('.reqhead');
  await shot(page, 'flow-requests-staff');
  await page.locator('.req', { hasText: 'Wine and Chill' }).getByRole('button', { name: 'Open' }).click();
  await drawer(page).getByRole('button', { name: 'Add to calendar' }).click();
  assert.equal(await page.inputValue('#p-title'), 'Example: Wine and Chill flyer');
  assert.equal(await page.inputValue('#p-committee'), 'Social & Fundraising');
  await drawer(page).getByRole('button', { name: 'Add to calendar' }).click();
  assert.match(await toastText(page), /Request added to the calendar/);
  await page.locator('.seg', { hasText: 'On the calendar' }).click();
  assert.equal(await page.locator('.req', { hasText: 'Wine and Chill' }).count(), 1);
  assert.equal(await page.locator('#gc-req-badge').isHidden(), true, 'no new requests left');

  step('ask for info, decline, and reopen');
  await page.locator('.seg', { hasText: 'Needs info' }).click();
  await page.locator('.req', { hasText: 'Alpha Academy recap' }).getByRole('button', { name: 'Open' }).click();
  await drawer(page).getByRole('button', { name: 'Decline' }).click();
  await drawer(page).getByRole('button', { name: 'Decline request' }).click();
  assert.match(await toastText(page), /Write a note/);
  await page.fill('#gc-review-note', 'Example: we covered this event last week.');
  await drawer(page).getByRole('button', { name: 'Decline request' }).click();
  assert.match(await toastText(page), /Request declined/);
  await drawer(page).getByRole('button', { name: 'Reopen' }).click();
  assert.match(await toastText(page), /Request reopened/);
  await drawer(page).getByRole('button', { name: 'Ask for info' }).click();
  await page.fill('#gc-review-note', 'Send three curated photos.');
  await drawer(page).getByRole('button', { name: 'Send question' }).click();
  assert.match(await toastText(page), /Question sent/);
  await page.keyboard.press('Escape');

  step('manage access: public calendar, PIN reset, removal, chapter code');
  await page.getByRole('button', { name: 'Manage access' }).click();
  await page.waitForSelector('.people');
  await shot(page, 'flow-access');
  await page.check('#gc-set-public');
  assert.match(await toastText(page), /calendar is public/);
  const chair = page.locator('.person', { hasText: 'Example Chair' });
  await chair.getByRole('button', { name: 'Reset PIN' }).click();
  await page.locator('.person input[type=password]').fill('12');
  await drawer(page).getByRole('button', { name: 'Save PIN' }).click();
  assert.match(await toastText(page), /4 to 6 digits/);
  await page.locator('.person input[type=password]').fill('2468');
  await drawer(page).getByRole('button', { name: 'Save PIN' }).click();
  assert.match(await toastText(page), /PIN reset/);
  await page.locator('.person', { hasText: 'Example Chair' }).getByRole('button', { name: 'Remove' }).click();
  await page.locator('.person', { hasText: 'Example Chair' }).getByRole('button', { name: 'Remove' }).click();
  assert.match(await toastText(page), /removed/);
  assert.equal(await page.locator('.person', { hasText: 'Example Chair' }).count(), 0);
  await page.fill('#gc-new-code', 'abc');
  await drawer(page).getByRole('button', { name: 'Change code' }).click();
  assert.match(await page.textContent('#gc-code-err'), /at least 6/);
  await page.fill('#gc-new-code', 'Brooklyn 2027');
  await drawer(page).getByRole('button', { name: 'Change code' }).click();
  assert.match(await toastText(page), /Chapter code changed/);
  await page.keyboard.press('Escape');

  step('view as a brother: request a post and edit it');
  await page.locator('.demo .seg', { hasText: 'Brother' }).click();
  await page.waitForFunction(() => /Example Brother/.test(document.querySelector('.who')?.textContent || ''));
  await page.locator('.tab', { hasText: 'Requests' }).click();
  assert.equal(await page.locator('.req .yours').count(), 1);
  await page.locator('#gc-view').getByRole('button', { name: 'Request a post' }).click();
  assert.equal(await page.inputValue('#r-name'), 'Example Brother');
  assert.equal(await page.inputValue('#r-committee'), 'Education');
  await page.fill('#r-title', 'Smoke test request');
  await page.fill('#r-date', inDays(10));
  assert.match(await page.textContent('#r-date-hint'), /Short notice/);
  await page.fill('#r-date', inDays(30));
  assert.match(await page.textContent('#r-date-hint'), /meets the three-week lead time/);
  await page.fill('#r-about', 'Who, what, when, and where for the smoke test.');
  await page.check('#r-youth');
  await drawer(page).getByRole('button', { name: 'Send request' }).click();
  assert.match(await page.textContent('#gc-form-err'), /media releases/);
  await page.check('#r-releases');
  await drawer(page).getByRole('button', { name: 'Send request' }).click();
  assert.match(await toastText(page), /Request sent/);
  assert.equal(await page.locator('.req .yours').count(), 2);
  await page.locator('.req', { hasText: 'Smoke test request' }).getByRole('button', { name: 'Edit' }).click();
  await page.fill('#r-title', 'Smoke test request, updated');
  await drawer(page).getByRole('button', { name: 'Update request' }).click();
  assert.match(await toastText(page), /Request updated/);
  await shot(page, 'flow-requests-brother');
  assert.equal(await page.locator('[data-act="add-post"]').count(), 0, 'brothers cannot add posts');

  step('view as a visitor: public calendar shows public fields only');
  await page.locator('.demo .seg', { hasText: 'Visitor' }).click();
  await page.waitForFunction(() => document.querySelector('#gc-actions')?.textContent.includes('Sign in'));
  await page.locator('.tab', { hasText: 'Agenda' }).click();
  await page.locator('.row', { hasText: 'MLK Memorial' }).first().click();
  assert.match(await drawer(page).textContent(), /Brothers who sign in also see/);
  assert.equal(await drawer(page).locator('.caption').count(), 0);
  await page.keyboard.press('Escape');

  step('visitor, private calendar: sign-in prompt, then sign in as a brother');
  await page.locator('.demo .seg', { hasText: 'Media team' }).click();
  await page.waitForFunction(() => /Media team/.test(document.querySelector('.who')?.textContent || ''));
  await page.getByRole('button', { name: 'Manage access' }).click();
  await page.waitForSelector('#gc-set-public');
  await page.uncheck('#gc-set-public');
  assert.match(await toastText(page), /signed-in brothers only/);
  await page.keyboard.press('Escape');
  await page.locator('.demo .seg', { hasText: 'Visitor' }).click();
  await page.waitForSelector('.empty h2:has-text("Sign in to see the calendar")');
  await shot(page, 'flow-visitor-private');
  await page.locator('#gc-view').getByRole('button', { name: 'Sign in' }).click();
  await page.locator('.modes .seg', { hasText: 'First time here' }).click();
  await shot(page, 'flow-signin');
  await page.fill('#s-code', 'anything');
  await page.fill('#s-name', 'Test Brother');
  await page.fill('#s-pin', '12');
  await drawer(page).getByRole('button', { name: 'Sign in', exact: true }).click();
  assert.match(await page.textContent('#gc-form-err'), /4 to 6 digits/);
  await page.fill('#s-pin', '1906');
  await drawer(page).getByRole('button', { name: 'Sign in', exact: true }).click();
  assert.match(await toastText(page), /Signed in as Test Brother/);
  await page.waitForSelector('.monthbar, .agendabar');

  step('sign out, then sign back in by name and PIN, then as the media team');
  await page.locator('.who').getByRole('button', { name: 'Sign out' }).click();
  assert.match(await toastText(page), /Signed out/);
  await page.locator('#gc-actions').getByRole('button', { name: 'Sign in' }).click();
  assert.equal(await page.getAttribute('.modes .seg[data-mode="rejoin"]', 'aria-pressed'), 'true');
  assert.equal(await page.inputValue('#s-name'), 'Test Brother');
  await page.fill('#s-pin', '1906');
  await drawer(page).getByRole('button', { name: 'Sign in', exact: true }).click();
  assert.match(await toastText(page), /Signed in as Test Brother/);
  await page.locator('.who').getByRole('button', { name: 'Sign out' }).click();
  await page.locator('#gc-actions').getByRole('button', { name: 'Sign in' }).click();
  await page.locator('.modes .seg', { hasText: 'Media team' }).click();
  await page.fill('#s-email', 'media@example.org');
  await page.fill('#s-password', 'a long password');
  await drawer(page).getByRole('button', { name: 'Sign in', exact: true }).click();
  assert.match(await toastText(page), /Signed in as Media team/);

  step('guide renders');
  await page.locator('.tab', { hasText: 'How it works' }).click();
  await page.waitForSelector('.guide h2');
  await shot(page, 'flow-guide', { fullPage: true });
  await ctx.close();
}

// ------------------------------------------------------------------ phone
{
  const { ctx, page } = await open({ width: 390, height: 844 });
  step('phone: agenda first, then the month grid and a day');
  assert.equal(await page.locator('.tab[aria-selected="true"]').textContent(), 'Agenda');
  await page.locator('.tab', { hasText: 'Calendar' }).click();
  await page.waitForSelector('.cellhit');
  const day = page.locator('.cellhit', { hasText: '16' }).first();
  await day.click();
  await page.waitForTimeout(600);
  await shot(page, 'phone-calendar-day');
  assert.match(await page.textContent('#gc-daypanel h3'), /October 16/);
  const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.equal(over, 0, 'no sideways scroll');

  step('phone: post drawer fills the screen');
  await page.locator('#gc-daypanel .row').first().click();
  await page.waitForSelector('#gc-drawer:not([hidden]) .dhead');
  await page.waitForTimeout(350); // let the slide-in finish
  const box = await drawer(page).boundingBox();
  assert.deepEqual([Math.round(box.x), Math.round(box.y), Math.round(box.width), Math.round(box.height)], [0, 0, 390, 844]);
  await shot(page, 'phone-post-drawer');
  await drawer(page).getByRole('button', { name: 'Close' }).last().click();

  step('phone: request form and sign-in drawer');
  await page.locator('.demo .seg', { hasText: 'Brother' }).click();
  await page.waitForFunction(() => /Example Brother/.test(document.querySelector('.who')?.textContent || ''));
  await page.locator('#gc-actions').getByRole('button', { name: 'Request a post' }).click();
  await page.waitForSelector('#r-title');
  await shot(page, 'phone-request-form');
  await page.keyboard.press('Escape');
  await page.locator('.demo .seg', { hasText: 'Visitor' }).click();
  await page.waitForSelector('.empty h2');
  await page.locator('#gc-actions').getByRole('button', { name: 'Sign in' }).click();
  await page.waitForSelector('#gc-drawer:not([hidden])');
  await shot(page, 'phone-signin');
  await page.keyboard.press('Escape');

  step('phone: the site menu still opens');
  await page.click('#hamburger');
  await page.waitForSelector('#mobile-menu.open');
  await page.click('#mobile-close');
  await ctx.close();
}

await browser.close();
await server.close();
if (errors.length) { console.error('Browser errors:\n' + errors.join('\n')); process.exit(1); }
console.log('Demo mode passed: media team, brother, and visitor at desktop and phone widths.');
