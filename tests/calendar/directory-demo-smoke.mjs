// The brother directory's demo mode in a real browser: every role, claiming and editing a record,
// the media team's edit, import, messages, and phone layout.
//   node tests/calendar/directory-demo-smoke.mjs
// Optional: SCREENSHOTS=dir saves screenshots at desktop and phone widths.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { startLiveServer } from './live-server.mjs';

const SHOTS = process.env.SCREENSHOTS || '';
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const server = await startLiveServer({ port: 5183, demo: true });
const BASE = server.origin;
const step = (s) => console.log('·', s);
const shot = async (page, name, opts = {}) => { if (SHOTS) { await page.waitForTimeout(250); await page.screenshot({ path: `${SHOTS}/dir-${name}.png`, ...opts }); } };

const browser = await chromium.launch();
const errors = [];
async function open(viewport, hash = '') {
  const ctx = await browser.newContext({ viewport, timezoneId: 'America/New_York', acceptDownloads: true });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  await page.route(/fonts\.googleapis\.com|fonts\.gstatic\.com|googletagmanager\.com/, (r) => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  await page.goto(`${BASE}/directory.html${hash}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#gc-view .dirbar, #gc-view .empty, #gc-view .mycard');
  return { ctx, page };
}
const toastText = async (page) => { await page.waitForSelector('#gc-toast:not([hidden])'); return page.textContent('#gc-toast'); };
const drawer = (page) => page.locator('#gc-drawer');
const role = async (page, r) => { await page.click(`[data-act="demo-role"][data-role="${r}"]`); await page.waitForTimeout(150); };

// ------------------------------------------------------------------ desktop, media team
{
  const { ctx, page } = await open({ width: 1380, height: 900 });
  await page.click('[data-act="demo-reset"]');
  await role(page, 'staff');
  step('media team: the directory lists sample brothers grouped by letter');
  assert.ok((await page.locator('.bro').count()) >= 12);
  assert.equal(await page.locator('.tab[data-view="manage"]').isHidden(), false);
  await shot(page, 'desktop-directory', { fullPage: true });

  step('search and filters narrow the list');
  await page.fill('#gc-q', 'bell');
  assert.equal(await page.locator('.bro').count(), 1);
  await page.fill('#gc-q', '');
  await page.click('[data-act="filter"][data-filter="life"]');
  assert.equal(await page.locator('.bro').count(), 3);
  await page.click('[data-act="filter"][data-filter="all"]');

  step('a record opens with full details for the media team, then edits');
  await page.click('.bro:has-text("Marcus Bell")');
  await drawer(page).locator('h2:has-text("Marcus Bell")').waitFor();
  assert.match(await drawer(page).textContent(), /12 Hancock St/);
  await shot(page, 'desktop-record');
  await drawer(page).locator('[data-act="edit"]').click();
  await page.fill('#f-city', 'Queens');
  await page.selectOption('#f-life_member', 'true');
  await page.fill('#f-notes', 'Example note');
  await shot(page, 'desktop-edit');
  await drawer(page).locator('button[type="submit"]').click();
  assert.match(await toastText(page), /Saved/);
  assert.match(await drawer(page).textContent(), /Queens/);
  assert.match(await drawer(page).textContent(), /Example note/);
  await page.keyboard.press('Escape');

  step('a bad phone is refused with the database\'s wording');
  await page.click('[data-act="add"]');
  await page.fill('#f-first_name', 'Test');
  await page.fill('#f-last_name', 'Brother');
  await page.fill('#f-phone', '12345');
  await drawer(page).locator('button[type="submit"]').click();
  assert.match(await page.textContent('#gc-form-err'), /10-digit phone/);
  await page.fill('#f-phone', '718-555-0199');
  await drawer(page).locator('button[type="submit"]').click();
  assert.match(await toastText(page), /Test Brother added/);
  await page.keyboard.press('Escape');

  step('celebrations list the next 90 days');
  await page.click('.tab[data-view="celebrations"]');
  await page.waitForSelector('.cel');
  assert.ok((await page.locator('.cel').count()) >= 4);
  await shot(page, 'desktop-celebrations', { fullPage: true });

  step('messages: preview, save, test, run');
  await page.click('.tab[data-view="messages"]');
  await page.waitForSelector('#m-birthday_text');
  await page.click('[data-act="m-preview"][data-kind="anniversary"]');
  await page.waitForSelector('.pv');
  assert.match(await page.textContent('.pv'), /Charles Wesley|Brother Charles/);
  assert.match(await page.textContent('.pv'), /10 years/);
  await page.fill('#m-birthday_subject', 'Many happy returns, {first_name}');
  await page.click('#gc-form button[type="submit"]');
  assert.match(await toastText(page), /Settings saved/);
  await page.click('[data-act="m-test"][data-kind="birthday"]');
  assert.match(await toastText(page), /Test sent to media@example.org/);
  await page.click('[data-act="m-run"]');
  assert.match(await toastText(page), /Sent \d+, skipped \d+/);
  await page.waitForSelector('.rtable');
  await shot(page, 'desktop-messages', { fullPage: true });

  step('manage: import a CSV in the old spreadsheet\'s layout');
  await page.click('.tab[data-view="manage"]');
  await page.waitForSelector('#gc-import');
  const csv = ['Last Name,First Name,Current Bros,Life,E-Mail,Address,"City,State",Phone,Birthdate,Crossing Date,"Active/Inactive\n2023 -2024",Visiting Brother,Number of Years Alpha,Emergency Contact,Phone number',
    'Chambers Jr.,Romero,Current,,,1122 East 83rd St.,"Brooklyn, NY 11236",646-296-3529,,3/15/2008,Active,,18.6,,',
    'Bell,Marcus,Not Current,x,,,"Brroklyn NY 11233",,9/21/2019,10/20/2018,Avriel George (Mother),,8.0,,347-743-2624',
    'Lawson,Dwight,Not Current,,,643A Madison St. Apt 1A,Brooklyn NY 11221,614-448-7474,,spr09,,,#VALUE!,,'].join('\n');
  await page.setInputFiles('#gc-import', { name: 'roll.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await page.waitForSelector('[data-act="import-go"]');
  const ready = await page.textContent('.pv');
  assert.match(ready, /3 rows ready/);
  assert.match(ready, /looks like the day the row was entered/);
  assert.match(ready, /Spring 2009/);
  await shot(page, 'desktop-import');
  await page.click('[data-act="import-go"]');
  assert.match(await toastText(page), /1 added, 1 updated|2 added, 1 updated/);
  await page.click('.tab[data-view="directory"]');
  await page.fill('#gc-q', 'chambers');
  assert.match(await page.textContent('.bro'), /Romero Chambers Jr\./);
  await page.fill('#gc-q', 'bell');
  await page.click('.bro');
  const bell = await drawer(page).textContent();
  assert.match(bell, /Avriel George \(Mother\)/);
  assert.match(bell, /Brooklyn, NY, 11233/);
  assert.match(bell, /Life member/);
  assert.match(bell, /Not current/);
  await page.keyboard.press('Escape');
  await page.fill('#gc-q', '');

  step('export downloads a CSV');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('[data-act="export"]')]);
  assert.match(dl.suggestedFilename(), /^gil-directory-\d{4}-\d{2}-\d{2}\.csv$/);

  step('visitor: a sign-in prompt and nothing else');
  await role(page, 'visitor');
  await page.waitForSelector('#gc-view .empty');
  assert.match(await page.textContent('#gc-view'), /Sign in to see the directory/);
  assert.equal(await page.locator('.bro').count(), 0);
  await shot(page, 'desktop-visitor');
  await ctx.close();
}

// ------------------------------------------------------------------ phone, brother
{
  const { ctx, page } = await open({ width: 390, height: 844 });
  await role(page, 'member');
  step('brother: shared details only, and a nudge to claim');
  await page.waitForSelector('.bro');
  await page.click('.bro:has-text("Marcus Bell")');
  const txt = await drawer(page).textContent();
  assert.doesNotMatch(txt, /12 Hancock St/, 'no street address for other brothers');
  assert.doesNotMatch(txt, /Example note/, 'no notes');
  assert.match(txt, /Birthday/);
  await page.keyboard.press('Escape');
  await page.click('.bro:has-text("Theo Mason")');
  assert.doesNotMatch(await drawer(page).textContent(), /555-0105/, 'a brother who does not share contact details');
  await page.keyboard.press('Escape');
  await shot(page, 'phone-directory', { fullPage: true });

  step('claim: wrong digits, then the right ones, then edit');
  await page.click('.tab[data-view="me"]');
  await page.waitForSelector('.matches');
  await shot(page, 'phone-find');
  await page.click('.match:has-text("Example Brother")');
  await page.fill('#f-check', '9999');
  await page.click('#gc-form button[type="submit"]');
  assert.match(await page.textContent('#gc-form-err'), /do not match/);
  await page.fill('#f-check', '0100');
  await page.click('#gc-form button[type="submit"]');
  assert.match(await toastText(page), /yours now/);
  await page.waitForSelector('#f-email');
  await page.fill('#f-email', 'me@example.org');
  await page.fill('#f-birth_date', '1990-06-15');
  await page.uncheck('#f-share_contact');
  await shot(page, 'phone-myrecord', { fullPage: true });
  await page.click('#gc-form button[type="submit"]');
  assert.match(await toastText(page), /saved/);
  await page.click('.tab[data-view="directory"]');
  await page.waitForSelector('.bro.mine');
  assert.match(await page.textContent('.bro.mine'), /Your record/);
  assert.doesNotMatch(await page.textContent('.bro.mine'), /555-0100/, 'contact hidden after unsharing');

  step('escape closes the drawer and the toast clears');
  await page.click('.bro.mine');
  await drawer(page).locator('[data-act="view"][data-view="me"]').waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await drawer(page).isHidden(), true);
  await ctx.close();
}

await browser.close();
await server.close();
if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
console.log('directory demo smoke test passed');
