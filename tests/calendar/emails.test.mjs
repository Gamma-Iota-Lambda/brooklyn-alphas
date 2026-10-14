// Request emails: the trigger that emails the media team about each new request. pg_net and
// Supabase Vault are replaced by local stand-ins (harness.mjs) that record each email instead of
// sending it. Run with the other database tests: node --test "tests/calendar/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from './harness.mjs';

const NOW = '2026-10-13T16:00:00Z';
const KEY = 're_test_1234567890abcdef';

const request = (over = {}) => JSON.stringify({
  contact_name: 'Farid Adenuga',
  committee: 'Social & Fundraising',
  title: 'Wine and Chill flyer',
  post_date: '2026-11-30',
  event_date: '2026-12-18',
  about: 'Promote the December Wine and Chill and toy drive.',
  format: 'flyer',
  platforms: ['instagram', 'threads'],
  program: '',
  asset_link: 'https://drive.google.com/drive/folders/example',
  caption: '',
  link: '',
  youth: false,
  releases: false,
  ...over
});

const emails = (h) => h.sql('select url, body, headers, timeout_milliseconds from net.http_calls order by id');

test('request emails stay off until the key and sender are set, and only the database can send them', async () => {
  const h = await createDb();
  await h.setNow(NOW);
  const staff = await h.staff('Eugene Aiken');
  const chair = await h.chair('Farid Adenuga', 'Social & Fundraising');
  const saved = await h.rpc1(chair, 'cal_submit_request', { p_request: request() });
  assert.ok(saved.id, 'the request saves');
  assert.equal((await emails(h)).length, 0, 'no email before setup');

  await assert.rejects(() => h.sql(`select cal_private.set_email_settings('PASTE THE RESEND API KEY HERE')`), /starts with re_/);
  await assert.rejects(() => h.sql(`select cal_private.set_email_settings($1, 'nobody')`, [KEY]), /sender like/);
  await assert.rejects(() => h.sql(`select cal_private.set_email_settings($1, 'GIL <calendar@mail.gil1906.org')`, [KEY]), /sender like/);
  await h.sql('select cal_private.set_email_settings($1)', [KEY]);
  await h.sql(`select cal_private.set_email_settings($1, 'calendar@mail.gil1906.org')`, ['re_rotated_abcdefghijk']);
  const keys = await h.sql(`select decrypted_secret from vault.decrypted_secrets where name = 'calendar_resend_api_key'`);
  assert.deepEqual(keys.map((k) => k.decrypted_secret), ['re_rotated_abcdefghijk'], 'running it again replaces the key');
  assert.equal((await h.sql(`select value from cal_private.config where key = 'email_from'`))[0].value, 'calendar@mail.gil1906.org');

  for (const who of [null, chair, staff]) {
    await assert.rejects(() => h.select(who, 'select decrypted_secret from vault.decrypted_secrets'), /permission denied/);
    await assert.rejects(() => h.select(who, `select cal_private.email_media_team('Hello', 'Hello')`), /permission denied/);
    await assert.rejects(() => h.select(who, `select cal_private.set_email_settings('re_someone_else_1234')`), /permission denied/);
  }
});

test('a new request emails every media team login through Resend', async () => {
  const h = await createDb();
  await h.setNow(NOW);
  await h.sql('select cal_private.set_email_settings($1)', [KEY]);
  const eugene = await h.staff('Eugene Aiken');
  await h.staff('Jessy Dwyer');
  const chair = await h.chair('Farid Adenuga', 'Social & Fundraising');
  await h.member('David Brown');
  const path = `requests/${chair.memberId}/a1-flyer.png`;
  await h.upload(chair, path);

  const saved = await h.rpc1(chair, 'cal_submit_request', {
    p_request: request({
      files: [{ path, name: 'flyer.png', size: 2048, type: 'image/png' }],
      program: 'keeper', youth: true, releases: true, caption: 'Join us Dec. 18.', link: 'https://example.org/rsvp'
    })
  });
  const sent = await emails(h);
  assert.equal(sent.length, 1);
  const [mail] = sent;
  assert.equal(mail.url, 'https://api.resend.com/emails');
  assert.equal(mail.headers.Authorization, `Bearer ${KEY}`);
  assert.equal(mail.timeout_milliseconds, 10000);
  assert.equal(mail.body.from, 'GIL Content Calendar <calendar@mail.gil1906.org>');
  assert.deepEqual(mail.body.to, ['eugene@example.org', 'jessy@example.org'], 'the media team, and no one else');
  assert.equal(mail.body.subject, 'New content request: Wine and Chill flyer');
  assert.equal(mail.body.text, [
    'Farid Adenuga (Social & Fundraising) sent a content request.',
    '',
    'Title: Wine and Chill flyer',
    'Requested post date: Monday, November 30, 2026',
    'Event date: Friday, December 18, 2026',
    'Format: Event flyer',
    'Platforms: Instagram, Threads',
    "National program: Brother's Keeper",
    'Files: 1 attached',
    'Shared link: https://drive.google.com/drive/folders/example',
    'Link for the post: https://example.org/rsvp',
    'Photos of young people: the chair confirmed media releases are on file.',
    '',
    'Details:',
    'Promote the December Wine and Chill and toy drive.',
    '',
    'Draft caption:',
    'Join us Dec. 18.',
    '',
    'Review it in the calendar: https://www.gil1906.org/calendar.html#requests',
    '',
    'You get this email because you have a media team login for the GIL content calendar.'
  ].join('\n'));

  // Edits and reviews don't send email.
  await h.rpc1(chair, 'cal_update_request', { p_id: saved.id, p_request: request({ title: 'Wine and Chill flyer, updated' }) });
  await h.rpc1(eugene, 'cal_review_request', { p_id: saved.id, p_status: 'needs-info', p_note: 'Which venue?' });
  assert.equal((await emails(h)).length, 1);

  // Short notice gets its own line; optional details stay out when they're empty.
  await h.rpc1(chair, 'cal_submit_request', { p_request: request({ title: 'Last-minute flyer', post_date: '2026-10-20' }) });
  let text = (await emails(h)).at(-1).body.text;
  assert.match(text, /^Short notice: the post date is in 7 days, under the three-week lead time\.$/m);
  await h.rpc1(chair, 'cal_submit_request', {
    p_request: request({ title: 'Same-day post', post_date: '2026-10-13', event_date: '', asset_link: '' })
  });
  text = (await emails(h)).at(-1).body.text;
  assert.match(text, /^Short notice: the post date is today\.$/m);
  assert.doesNotMatch(text, /Event date|Shared link|Files:|National program|Draft caption|Link for the post|young people/);

  // A media team member who sends a request himself isn't emailed about it.
  await h.rpc1(eugene, 'cal_submit_request', { p_request: request({ title: 'Media team post' }) });
  assert.deepEqual((await emails(h)).at(-1).body.to, ['jessy@example.org']);
  assert.equal((await emails(h)).length, 4);
});

test('a request still saves when there is no one to email or the email cannot be sent', async () => {
  const h = await createDb();
  await h.setNow(NOW);
  await h.sql('select cal_private.set_email_settings($1)', [KEY]);
  const chair = await h.chair('Farid Adenuga', 'Social & Fundraising');

  await h.rpc1(chair, 'cal_submit_request', { p_request: request({ title: 'No media team yet' }) });
  assert.equal((await emails(h)).length, 0, 'no media team logins, so no email');

  await h.staff('Eugene Aiken');
  await h.sql(`select set_config('app.net_fail', 'on', false)`);
  const saved = await h.rpc1(chair, 'cal_submit_request', { p_request: request({ title: 'Email is down' }) });
  assert.ok(saved.id);
  assert.equal((await emails(h)).length, 0);
  const titles = (await h.sql('select title from public.cal_requests order by created_at, title')).map((r) => r.title);
  assert.deepEqual(titles.sort(), ['Email is down', 'No media team yet']);

  await h.sql(`select set_config('app.net_fail', 'off', false)`);
  await h.rpc1(chair, 'cal_submit_request', { p_request: request({ title: 'Back up' }) });
  assert.deepEqual((await emails(h)).map((e) => e.body.subject), ['New content request: Back up']);
});
