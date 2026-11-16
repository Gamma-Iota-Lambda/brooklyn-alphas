// Instagram and Threads results: connecting an account, saving each sync, matching posts to the
// calendar, the nightly schedule, and who can read the numbers. Vault, pg_net, and pg_cron are
// local stand-ins (harness.mjs). Run with the other database tests:
//   node --test "tests/calendar/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from './harness.mjs';

const NOW = '2026-10-20T16:00:00Z';
const FUNCTIONS = 'https://uqfoifrpyysqjvwtkgia.supabase.co/functions/v1';
const DAYS_60 = 60 * 86400;
const TABLES = ['cal_social_accounts', 'cal_social_posts', 'cal_social_post_days', 'cal_social_account_days'];

// What the Edge Function does once Instagram or Threads sends the media team member back.
const connect = (h, platform, who, token = `${platform}-token-1`, functionsUrl = FUNCTIONS) =>
  h.sql('select cal_private.social_save_connection($1, $2, $3, $4, $5, $6, $7)',
    [platform, `${platform}-account-1`, 'gil1906', token, DAYS_60, who.id, functionsUrl]);

// What the Edge Function saves after each sync.
const sync = (h, platform, account, posts) =>
  h.sql('select cal_private.social_save_sync($1, $2::jsonb, $3::jsonb) as r',
    [platform, JSON.stringify(account), JSON.stringify(posts)]).then((rows) => rows[0].r);

const secret = (h, name) =>
  h.sql('select decrypted_secret from vault.decrypted_secrets where name = $1', [name]).then((rows) => rows.map((r) => r.decrypted_secret));

test('only the media team reads results and starts a Connect, and each Connect code works once', async () => {
  const h = await createDb();
  await h.setNow(NOW);
  const staff = await h.staff('Eugene Aiken');
  const chair = await h.chair('Farid Adenuga', 'Social & Fundraising');
  const bro = await h.member('David Brown');
  await connect(h, 'instagram', staff);
  await sync(h, 'instagram', { followers: 1500 }, [{ media_id: 'm1', posted_at: '2026-10-19T15:00:00Z', views: 10 }]);

  for (const t of TABLES) {
    await assert.rejects(() => h.select(null, `select * from public.${t}`), /permission denied/, `visitors can't read ${t}`);
    for (const who of [chair, bro]) assert.deepEqual(await h.select(who, `select * from public.${t}`), [], `brothers see no ${t}`);
    assert.equal((await h.select(staff, `select * from public.${t}`)).length, 1, `the media team reads ${t}`);
    await assert.rejects(() => h.select(staff, `delete from public.${t}`), /permission denied/, `the page can't change ${t}`);
  }
  await assert.rejects(() => h.select(staff, `update public.cal_social_posts set views = 1000000`), /permission denied/);
  for (const who of [null, bro, staff]) {
    await assert.rejects(() => h.select(who, 'select decrypted_secret from vault.decrypted_secrets'), /permission denied/);
    await assert.rejects(() => h.select(who, 'select * from cal_private.social_connect_states'), /permission denied/);
  }

  await assert.rejects(() => h.rpc(null, 'cal_social_connect_start', { p_platform: 'instagram' }), /permission denied/);
  await assert.rejects(() => h.rpc(chair, 'cal_social_connect_start', { p_platform: 'instagram' }), /Only the media team/);
  await assert.rejects(() => h.rpc(staff, 'cal_social_connect_start', { p_platform: 'facebook' }), /Instagram or Threads/);
  const state = await h.rpc1(staff, 'cal_social_connect_start', { p_platform: 'threads', p_return: 'https://www.gil1906.org/calendar' });
  assert.match(state, /^[0-9a-f]{48}$/);

  const peek = (s) => h.sql('select * from cal_private.social_connect_peek($1)', [s]);
  const claim = (s) => h.sql('select * from cal_private.social_connect_claim($1)', [s]);
  assert.deepEqual(await peek(state), [{ platform: 'threads', return_to: 'https://www.gil1906.org/calendar' }]);
  assert.deepEqual(await claim(state), [{ platform: 'threads', user_id: staff.id, return_to: 'https://www.gil1906.org/calendar' }]);
  assert.deepEqual(await peek(state), [], 'a used code is gone');
  await assert.rejects(() => claim(state), /That Connect link has expired/);
  await assert.rejects(() => claim('not-a-code'), /That Connect link has expired/);

  // The page can only ask to come back to the chapter site, a preview of it, or a local test server.
  const returns = [
    ['https://gil1906.org/calendar.html', true],
    ['https://brooklyn-alphas-git-feat-calendar-results-gamma-iota-lambda.vercel.app/calendar.html', true],
    ['http://localhost:5181/calendar.html', true],
    ['https://www.gil1906.org.example.com/calendar.html', false],
    ['https://someone-else.vercel.app/calendar.html', false],
    ['javascript:alert(1)', false],
    ['https://www.gil1906.org/calendar.html"><script>', false]
  ];
  for (const [url, kept] of returns) {
    const s = await h.rpc1(staff, 'cal_social_connect_start', { p_platform: 'instagram', p_return: url });
    assert.equal((await peek(s))[0].return_to, kept ? url : null, url);
  }

  // Codes last 30 minutes, and old ones are cleared out the next day.
  const late = await h.rpc1(staff, 'cal_social_connect_start', { p_platform: 'instagram' });
  await h.setNow('2026-10-20T16:31:00Z');
  assert.deepEqual(await peek(late), []);
  await assert.rejects(() => claim(late), /expired/);
  await h.setNow('2026-10-22T16:00:00Z');
  await h.rpc1(staff, 'cal_social_connect_start', { p_platform: 'instagram' });
  assert.equal((await h.sql('select count(*)::int as n from cal_private.social_connect_states'))[0].n, 1);

  // The Edge Function's side runs only as the database owner.
  for (const who of [staff, chair]) {
    await assert.rejects(() => h.select(who, `select * from cal_private.social_connect_peek('x')`), /permission denied/);
    await assert.rejects(() => h.select(who, `select * from cal_private.social_token('instagram')`), /permission denied/);
  }
});

test('connecting keeps the token in Vault, renewals replace it, and disconnecting forgets it', async () => {
  const h = await createDb();
  await h.setNow(NOW);
  const staff = await h.staff();
  const chair = await h.chair('Farid Adenuga');
  await connect(h, 'instagram', staff, 'IG-token-1');

  assert.deepEqual(await secret(h, 'calendar_instagram_token'), ['IG-token-1']);
  const [account] = await h.select(staff, 'select * from public.cal_social_accounts');
  assert.equal(account.platform, 'instagram');
  assert.equal(account.username, 'gil1906');
  assert.equal(account.connected_by, staff.id);
  assert.equal(account.token_expires_at.toISOString(), '2026-12-19T16:00:00.000Z');
  assert.ok(!JSON.stringify(account).includes('IG-token'), 'the page never sees the token');
  assert.deepEqual(await h.sql(`select value from cal_private.config where key = 'functions_url'`), [{ value: FUNCTIONS }]);

  const token = () => h.sql(`select * from cal_private.social_token('instagram')`);
  assert.equal((await token())[0].token, 'IG-token-1');

  await h.setNow('2026-10-27T16:00:00Z');
  await h.sql(`select cal_private.social_save_token('instagram', 'IG-token-2', $1)`, [DAYS_60]);
  const [renewed] = await token();
  assert.equal(renewed.token, 'IG-token-2');
  assert.equal(renewed.refreshed_at.toISOString(), '2026-10-27T16:00:00.000Z');
  assert.equal(renewed.expires_at.toISOString(), '2026-12-26T16:00:00.000Z');
  assert.deepEqual(await secret(h, 'calendar_instagram_token'), ['IG-token-2'], 'one secret, replaced');
  await h.sql(`select cal_private.social_save_token('instagram', 'IG-token-3', 0)`);
  assert.equal((await token())[0].expires_at.toISOString(), '2026-12-26T16:00:00.000Z', 'no expiry given keeps the last one');
  await assert.rejects(() => h.sql(`select cal_private.social_save_token('instagram', '', $1)`, [DAYS_60]), /No token/);
  await assert.rejects(() => h.sql(`select cal_private.social_save_token('threads', 'TH', $1)`, [DAYS_60]), /not connected/);

  // A second platform, with an address that isn't an Edge Functions address: the saved one stays.
  await connect(h, 'threads', staff, 'TH-token-1', 'javascript:alert(1)');
  assert.deepEqual(await h.sql(`select value from cal_private.config where key = 'functions_url'`), [{ value: FUNCTIONS }]);
  await assert.rejects(() => connect(h, 'threads', staff, ''), /No access token came back/);
  await assert.rejects(() => connect(h, 'facebook', staff), /Unknown platform/);
  assert.deepEqual(await h.sql('select * from cal_private.social_connected() as p'), [{ p: 'instagram' }, { p: 'threads' }]);

  await assert.rejects(() => h.rpc(chair, 'cal_social_disconnect', { p_platform: 'instagram' }), /Only the media team/);
  await h.rpc(staff, 'cal_social_disconnect', { p_platform: 'instagram' });
  assert.deepEqual(await secret(h, 'calendar_instagram_token'), []);
  assert.deepEqual(await token(), []);
  assert.deepEqual((await h.select(staff, 'select platform from public.cal_social_accounts')).map((r) => r.platform), ['threads']);
  assert.deepEqual(await secret(h, 'calendar_threads_token'), ['TH-token-1']);
});

test('a sync saves each post, a daily snapshot for recent posts, and followers', async () => {
  const h = await createDb();
  await h.setNow(NOW);
  await h.sql('delete from public.cal_posts');
  const staff = await h.staff();
  await assert.rejects(() => sync(h, 'instagram', {}, []), /instagram is not connected/);
  await connect(h, 'instagram', staff);

  const long = 'Brothers, '.repeat(60);
  let saved = await sync(h, 'instagram', { username: 'gil1906', followers: 1500, posts: 320 }, [
    {
      media_id: '1801', posted_at: '2026-10-19T22:15:00+0000', permalink: 'https://www.instagram.com/p/DQ1abc/',
      media_type: 'CAROUSEL_ALBUM', caption: `  Founders'\n\nDay   ${long}`,
      views: 900, reach: 700, likes: 80, comments: 6, saves: 9, shares: 12, interactions: 107
    },
    { media_id: '1702', posted_at: '2026-08-01T14:00:00Z', permalink: 'javascript:alert(1)', media_type: 'REELS', views: 5000, likes: 300 },
    { media_id: '', posted_at: '2026-10-01T14:00:00Z', views: 1 },
    { media_id: '1603', posted_at: null, views: 1 }
  ]);
  assert.deepEqual(saved, { posts: 2, matched: 0 }, 'posts without an id or a date are left out');

  const posts = () => h.select(staff, `
    select media_id, posted_at, permalink, media_type, caption, views::int, reach::int, likes::int, comments::int, saves::int,
      shares::int, replies::int, interactions::int
    from public.cal_social_posts order by media_id`);
  let [reel, carousel] = await posts();
  assert.equal(reel.permalink, null, 'only https links are kept');
  assert.equal(reel.media_type, 'REELS');
  assert.equal(reel.caption, null);
  assert.deepEqual([reel.views, reel.likes, reel.reach, reel.replies], [5000, 300, null, null]);
  assert.equal(carousel.posted_at.toISOString(), '2026-10-19T22:15:00.000Z');
  assert.equal(carousel.caption.length, 300);
  assert.ok(carousel.caption.startsWith("Founders' Day Brothers, Brothers,"), 'captions keep one line, trimmed');
  assert.deepEqual([carousel.views, carousel.reach, carousel.likes, carousel.comments, carousel.saves, carousel.shares, carousel.interactions],
    [900, 700, 80, 6, 9, 12, 107]);

  const days = () => h.select(staff, 'select media_id, day::text, views::int, likes::int from public.cal_social_post_days order by media_id, day');
  assert.deepEqual(await days(), [{ media_id: '1801', day: '2026-10-20', views: 900, likes: 80 }], 'snapshots cover the last 30 days');
  const followers = () => h.select(staff, 'select platform, day::text, followers::int, posts::int from public.cal_social_account_days order by day');
  assert.deepEqual(await followers(), [{ platform: 'instagram', day: '2026-10-20', followers: 1500, posts: 320 }]);

  // The next night, newer numbers for the recent post and just the like count for the older one.
  await h.setNow('2026-10-21T16:00:00Z');
  saved = await sync(h, 'instagram', { followers: 1504 }, [
    { media_id: '1801', posted_at: '2026-10-19T22:15:00Z', views: 1300, likes: 95, comments: 7 },
    { media_id: '1702', posted_at: '2026-08-01T14:00:00Z', likes: 302 }
  ]);
  assert.deepEqual(saved, { posts: 2, matched: 0 });
  [reel, carousel] = await posts();
  assert.deepEqual([reel.views, reel.likes], [5000, 302], 'numbers a sync leaves out stay');
  assert.deepEqual([carousel.views, carousel.reach, carousel.likes, carousel.comments], [1300, 700, 95, 7]);
  assert.equal(carousel.permalink, 'https://www.instagram.com/p/DQ1abc/');
  assert.ok(carousel.caption.startsWith("Founders' Day"));

  // Refresh now, later the same day, updates today's snapshot.
  await h.setNow('2026-10-21T18:00:00Z');
  await sync(h, 'instagram', { followers: 1506, posts: 321 }, [{ media_id: '1801', posted_at: '2026-10-19T22:15:00Z', views: 1400, likes: 96 }]);
  assert.deepEqual(await days(), [
    { media_id: '1801', day: '2026-10-20', views: 900, likes: 80 },
    { media_id: '1801', day: '2026-10-21', views: 1400, likes: 96 }
  ]);
  assert.deepEqual(await followers(), [
    { platform: 'instagram', day: '2026-10-20', followers: 1500, posts: 320 },
    { platform: 'instagram', day: '2026-10-21', followers: 1506, posts: 321 }
  ]);

  // A sync that doesn't finish leaves a note for the Results tab; the next good one clears it.
  await h.sql(`select cal_private.social_sync_failed('instagram', $1)`, ['x'.repeat(600)]);
  let [account] = await h.select(staff, 'select last_error, last_error_at, last_sync_at from public.cal_social_accounts');
  assert.equal(account.last_error.length, 500);
  assert.equal(account.last_error_at.toISOString(), '2026-10-21T18:00:00.000Z');
  await h.sql(`select cal_private.social_sync_failed('instagram', '  ')`);
  [account] = await h.select(staff, 'select last_error from public.cal_social_accounts');
  assert.equal(account.last_error, 'The sync did not finish.');
  await h.setNow('2026-10-22T08:20:00Z');
  await sync(h, 'instagram', {}, []);
  [account] = await h.select(staff, 'select last_error, last_error_at, last_sync_at from public.cal_social_accounts');
  assert.deepEqual([account.last_error, account.last_error_at, account.last_sync_at.toISOString()], [null, null, '2026-10-22T08:20:00.000Z']);
  await assert.rejects(() => sync(h, 'instagram', {}, { media_id: '1801' }), /Posts must be a list/);
});

test('posts match calendar posts by date, and the media team fixes the rest by hand', async () => {
  const h = await createDb();
  await h.setNow('2026-11-10T16:00:00Z');
  await h.sql('delete from public.cal_posts');
  const staff = await h.staff();
  const chair = await h.chair('Farid Adenuga');
  const calendar = [
    ['p-a', '2026-11-02', '{instagram,threads}', 'planned', 'graphic'],
    ['p-b', '2026-11-03', '{instagram}', 'planned', 'story'],
    ['p-c', '2026-11-04', '{instagram}', 'planned', 'graphic'],
    ['p-d', '2026-11-04', '{instagram}', 'planned', 'carousel'],
    ['p-e', '2026-11-05', '{threads}', 'planned', 'text'],
    ['p-f', '2026-11-06', '{instagram}', 'skipped', 'graphic'],
    ['p-g', '2026-11-07', '{instagram}', 'planned', 'graphic'],
    ['p-h', '2026-11-08', '{instagram}', 'posted', 'reel']
  ];
  for (const [id, date, platforms, status, format] of calendar) {
    await h.sql('insert into public.cal_posts (id, date, title, platforms, status, format) values ($1, $2, $3, $4, $5, $6)',
      [id, date, `Calendar post ${id}`, platforms, status, format]);
  }
  await connect(h, 'instagram', staff);
  await connect(h, 'threads', staff);

  // New York time decides the day: Nov. 9 at 02:00 UTC is 9 p.m. on Nov. 8.
  const ig = [
    ['m1', '2026-11-02T23:00:00Z'], ['m2', '2026-11-03T17:00:00Z'], ['m3', '2026-11-04T17:00:00Z'],
    ['m4', '2026-11-05T17:00:00Z'], ['m5', '2026-11-06T17:00:00Z'], ['m6', '2026-11-07T15:00:00Z'],
    ['m7', '2026-11-07T20:00:00Z'], ['m8', '2026-11-09T02:00:00Z']
  ];
  const th = [['t1', '2026-11-02T23:05:00Z'], ['t2', '2026-11-05T18:00:00Z'], ['t3', '2026-11-04T18:00:00Z']];
  const asPosts = (list) => list.map(([media_id, posted_at]) => ({ media_id, posted_at, views: 100 }));
  assert.deepEqual(await sync(h, 'instagram', {}, asPosts(ig)), { posts: 8, matched: 2 });
  assert.deepEqual(await sync(h, 'threads', {}, asPosts(th)), { posts: 3, matched: 2 });

  const matches = async () => Object.fromEntries((await h.select(staff, `
    select platform || ':' || media_id as k, coalesce(post_id, '-') || ' ' || coalesce(match_source, '-') as v
    from public.cal_social_posts order by 1`)).map((r) => [r.k, r.v]));
  const expected = {
    'instagram:m1': 'p-a date', // one post that day, one calendar post for Instagram
    'instagram:m2': '- -', // the calendar post that day is a story
    'instagram:m3': '- -', // two calendar posts that day
    'instagram:m4': '- -', // the calendar post that day is for Threads only
    'instagram:m5': '- -', // the calendar post that day was skipped
    'instagram:m6': '- -', // two posts went out that day
    'instagram:m7': '- -',
    'instagram:m8': 'p-h date', // 9 p.m. on Nov. 8 in New York
    'threads:t1': 'p-a date', // one calendar post can match on each platform
    'threads:t2': 'p-e date',
    'threads:t3': '- -' // the calendar posts that day are for Instagram
  };
  assert.deepEqual(await matches(), expected);

  // Hand matches stay put, and take that calendar post out of date matching.
  const setMatch = (who, media, post, auto = false) =>
    h.rpc(who, 'cal_social_set_match', { p_platform: media.startsWith('t') ? 'threads' : 'instagram', p_media_id: media, p_post_id: post, p_auto: auto });
  await assert.rejects(() => setMatch(chair, 'm3', 'p-c'), /Only the media team/);
  await assert.rejects(() => setMatch(staff, 'm99', 'p-c'), /no longer in the results/);
  await assert.rejects(() => setMatch(staff, 'm3', 'p-zzz'), /no longer exists/);
  await setMatch(staff, 'm3', 'p-c');
  await setMatch(staff, 'm6', 'p-g');
  await setMatch(staff, 'm2', null);
  Object.assign(expected, { 'instagram:m3': 'p-c manual', 'instagram:m6': 'p-g manual', 'instagram:m2': '- none' });
  assert.deepEqual(await matches(), expected, 'm7 stays open: p-g already has its post');
  await sync(h, 'instagram', {}, asPosts(ig));
  assert.deepEqual(await matches(), expected, 'the next sync keeps hand matches');

  // Calendar edits rematch right away.
  const edit = (sql) => h.select(staff, sql);
  await edit(`update public.cal_posts set status = 'planned' where id = 'p-f'`);
  expected['instagram:m5'] = 'p-f date';
  assert.deepEqual(await matches(), expected, 'un-skipping a post');
  await edit(`update public.cal_posts set date = '2026-11-10' where id = 'p-a'`);
  assert.deepEqual(await matches(), { ...expected, 'instagram:m1': '- -', 'threads:t1': '- -' }, 'moving a post');
  await edit(`update public.cal_posts set date = '2026-11-02' where id = 'p-a'`);
  assert.deepEqual(await matches(), expected);
  await edit(`update public.cal_posts set platforms = '{instagram}' where id = 'p-e'`);
  Object.assign(expected, { 'instagram:m4': 'p-e date', 'threads:t2': '- -' });
  assert.deepEqual(await matches(), expected, 'changing platforms');
  await edit(`delete from public.cal_posts where id = 'p-h'`);
  expected['instagram:m8'] = '- -';
  assert.deepEqual(await matches(), expected, 'deleting a post');
  await edit(`delete from public.cal_posts where id = 'p-c'`);
  expected['instagram:m3'] = 'p-d date';
  assert.deepEqual(await matches(), expected, 'a hand match whose calendar post is deleted goes back to matching by date');

  await setMatch(staff, 'm6', null, true);
  expected['instagram:m6'] = '- -';
  assert.deepEqual(await matches(), expected, 'back to automatic: two posts that day, so no match');
  await setMatch(staff, 'm2', null, true);
  expected['instagram:m2'] = '- -';
  assert.deepEqual(await matches(), expected);
});

test('every night pg_cron asks the Edge Function to sync, and the media team can refresh sooner', async () => {
  const h = await createDb();
  await h.setNow(NOW);
  const staff = await h.staff();
  const chair = await h.chair('Farid Adenuga');
  const [job] = await h.sql(`select schedule, command, active from cron.job where jobname = 'gil-calendar-social-sync'`);
  assert.deepEqual(job, { schedule: '20 8 * * *', command: 'select cal_private.social_sync_request()', active: true });

  const calls = () => h.sql('select url, body, headers, timeout_milliseconds from net.http_calls order by id');
  const nightly = () => h.sql(job.command); // pg_cron runs it as the database owner
  await nightly();
  assert.equal((await calls()).length, 0, 'nothing to sync before an account is connected');
  assert.deepEqual(await h.rpc1(staff, 'cal_social_sync_now'), { ok: false, message: 'Connect Instagram or Threads first.' });

  await connect(h, 'instagram', staff);
  await nightly();
  const [call] = await calls();
  assert.equal(call.url, `${FUNCTIONS}/calendar-social/sync`);
  assert.deepEqual(call.body, {});
  assert.equal(call.timeout_milliseconds, 30000);
  const key = call.headers['x-sync-key'];
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.deepEqual(await secret(h, 'calendar_social_sync_key'), [key]);
  const keyOk = (k) => h.sql('select cal_private.social_sync_key_ok($1) as ok', [k]).then((rows) => rows[0].ok);
  assert.equal(await keyOk(key), true);
  for (const wrong of ['wrong', '', null, key.toUpperCase()]) assert.equal(await keyOk(wrong), false, String(wrong));

  await assert.rejects(() => h.rpc(null, 'cal_social_sync_now'), /permission denied/);
  await assert.rejects(() => h.rpc(chair, 'cal_social_sync_now'), /Only the media team/);
  assert.deepEqual(await h.rpc1(staff, 'cal_social_sync_now'), { ok: true, message: 'Refreshing. New numbers show up in a minute or two.' });
  assert.deepEqual(await h.rpc1(staff, 'cal_social_sync_now'),
    { ok: false, message: 'A refresh is already on its way. Check back in a few minutes.' });
  await h.setNow('2026-10-20T16:11:00Z');
  assert.equal((await h.rpc1(staff, 'cal_social_sync_now')).ok, true);
  assert.equal((await calls()).length, 3);

  for (const who of [null, chair, staff]) {
    await assert.rejects(() => h.select(who, 'select cal_private.social_sync_request()'), /permission denied/);
    await assert.rejects(() => h.select(who, `select cal_private.social_save_sync('instagram', '{}', '[]')`), /permission denied/);
    await assert.rejects(() => h.select(who, `select cal_private.social_sync_key_ok('x')`), /permission denied/);
  }
});

const BLOCKED = { kind: 'blocked', request: 'GET graph.instagram.com/v25.0/me', status: 400, code: 200, subcode: 5258005, type: 'OAuthException', trace: 'AbC123' };
const failed = (h, platform, message, detail) =>
  h.sql('select cal_private.social_sync_failed($1, $2, $3::jsonb)', [platform, message, JSON.stringify(detail)]);
const account = (h, platform) =>
  h.sql('select last_sync_at, last_error, last_error_detail, stale_alerted_at from public.cal_social_accounts where platform = $1', [platform]).then((rows) => rows[0]);

test('the media team gets an email once the numbers have been stuck for two days, then once a week', async () => {
  const h = await createDb();
  await h.sql(`select cal_private.set_email_settings('re_testkey_12345678')`);
  const eugene = await h.staff('Eugene Aiken');
  await h.staff('Robert Brissett');
  const chair = await h.chair('Farid Adenuga');
  const [job] = await h.sql(`select schedule, command, active from cron.job where jobname = 'gil-calendar-social-health'`);
  assert.deepEqual(job, { schedule: '10 9 * * *', command: 'select cal_private.social_health_check()', active: true });
  const check = async (iso) => {
    await h.setNow(iso);
    return (await h.sql(job.command))[0].social_health_check; // pg_cron runs it as the database owner
  };
  const emails = () => h.sql(`select body from net.http_calls where url = 'https://api.resend.com/emails' order by id`).then((rows) => rows.map((r) => r.body));

  assert.equal(await check('2026-10-18T09:10:00Z'), 0, 'nothing is connected');
  await h.setNow('2026-10-19T01:04:00Z');
  await connect(h, 'instagram', eugene);
  await connect(h, 'threads', eugene);
  await h.setNow('2026-10-19T08:20:00Z');
  await sync(h, 'instagram', { username: 'gil1906', followers: 1500, posts: 320 }, []);
  await sync(h, 'threads', { username: 'gil1906', followers: 410 }, []);
  assert.equal(await check('2026-10-19T09:10:00Z'), 0, 'both synced this morning');

  // Two nights in a row save nothing.
  for (const night of ['2026-10-20T08:20:00Z', '2026-10-21T08:20:00Z']) {
    await h.setNow(night);
    await failed(h, 'instagram', 'Instagram sent an error: API access blocked.', BLOCKED);
    await failed(h, 'threads', "Threads didn't answer. The next sync tries again.", { kind: 'network', request: 'GET graph.threads.net/v1.0/me' });
    if (night.startsWith('2026-10-20')) assert.equal(await check('2026-10-20T09:10:00Z'), 0, 'one missed night is not two days');
  }
  assert.equal(await check('2026-10-21T09:10:00Z'), 2);
  let sent = await emails();
  assert.equal(sent.length, 1, 'one email covers both accounts');
  assert.deepEqual(sent[0].to, ['eugene@example.org', 'robert@example.org']);
  assert.equal(sent[0].subject, 'The Instagram and Threads numbers have stopped updating');
  assert.equal(sent[0].text, [
    'The Instagram and Threads numbers on the content calendar have stopped updating. The numbers saved so far are still there.',
    '',
    'Instagram (@gil1906)',
    'Last updated: Monday, October 19, 2026 (2 days ago)',
    'Latest note (Wednesday, October 21): Instagram sent an error: API access blocked.',
    'Details, for Meta support: GET graph.instagram.com/v25.0/me, HTTP 400, code 200, subcode 5258005, OAuthException, trace AbC123',
    'The saved sign-in lasts until Thursday, December 17. After that, choose Reconnect on the Results tab, once the problem has cleared.',
    '',
    'Threads (@gil1906)',
    'Last updated: Monday, October 19, 2026 (2 days ago)',
    "Latest note (Wednesday, October 21): Threads didn't answer. The next sync tries again.",
    'Details, for Meta support: GET graph.threads.net/v1.0/me',
    'The saved sign-in lasts until Thursday, December 17. After that, choose Reconnect on the Results tab, once the problem has cleared.',
    '',
    'What to do',
    '- Open Results on the calendar and read the note on each account: https://www.gil1906.org/calendar.html#results',
    "- If a note says to choose Reconnect, do that. Otherwise leave the connection in place and don't choose Disconnect: the saved sign-in picks up by itself once the problem clears.",
    '- Not sure what to do? Forward this email to whoever looks after the website. The setup guide covers it under "When the numbers stop updating".',
    '',
    'This email comes again in a week if the numbers are still stuck. You get it because you have a media team login for the GIL content calendar.'
  ].join('\n'));

  for (const day of ['2026-10-22T09:10:00Z', '2026-10-27T09:10:00Z']) assert.equal(await check(day), 0, 'not again inside the week');
  assert.equal(await check('2026-10-28T09:10:00Z'), 2, 'again a week later');
  sent = await emails();
  assert.equal(sent.length, 2);
  assert.match(sent[1].text, /Last updated: Monday, October 19, 2026 \(9 days ago\)/);
  // No try has been recorded for a week either, which is its own sign of trouble.
  assert.match(sent[1].text, /Latest note \(Wednesday, October 21\): Instagram sent an error: API access blocked\.\nNothing has reported in since that note either, so the nightly update may have stopped running\. Whoever looks after the website should check it\.\nDetails, for Meta support/);
  assert.doesNotMatch(sent[0].text, /Nothing has reported in since that note/, 'not while the tries are still coming in');

  // Instagram comes back; Threads doesn't. Then Instagram goes quiet with no error at all, the way
  // it would if the nightly request stopped arriving. Its new gap gets an email after two days.
  await h.setNow('2026-10-29T08:20:00Z');
  await sync(h, 'instagram', { username: 'gil1906', followers: 1510, posts: 321 }, []);
  assert.deepEqual(await account(h, 'instagram').then((a) => [a.last_error, a.last_error_detail, a.stale_alerted_at]), [null, null, null]);
  assert.equal(await check('2026-10-29T09:10:00Z'), 0, 'Threads was reported yesterday');
  assert.equal(await check('2026-10-30T09:10:00Z'), 0);
  assert.equal(await check('2026-10-31T09:10:00Z'), 2, 'the email lists every stuck account');
  sent = await emails();
  assert.equal(sent.length, 3);
  assert.match(sent[2].text, /Instagram \(@gil1906\)\nLast updated: Thursday, October 29, 2026 \(2 days ago\)\nNo note\. Nothing has reported in since then, so the nightly update may not be running\. Whoever looks after the website should check it\.\nThe saved sign-in lasts/);
  assert.match(sent[2].text, /Threads \(@gil1906\)\nLast updated: Monday, October 19, 2026 \(12 days ago\)/);

  // Only Threads is stuck now.
  await h.setNow('2026-11-06T08:20:00Z');
  await sync(h, 'instagram', { username: 'gil1906', followers: 1512, posts: 322 }, []);
  assert.equal(await check('2026-11-06T09:10:00Z'), 0);
  assert.equal(await check('2026-11-07T09:10:00Z'), 1);
  sent = await emails();
  assert.equal(sent[3].subject, 'The Threads numbers have stopped updating');
  assert.ok(!sent[3].text.includes('Instagram (@gil1906)'));

  // With emails turned off nothing is sent or marked, so the email goes out once they are back on.
  await h.sql(`delete from cal_private.config where key = 'email_from'`);
  assert.equal(await check('2026-11-14T09:10:00Z'), 0);
  assert.equal((await account(h, 'threads')).stale_alerted_at.toISOString(), '2026-11-07T09:10:00.000Z');
  await h.sql(`select cal_private.set_email_settings('re_testkey_12345678')`);
  assert.equal(await check('2026-11-15T09:10:00Z'), 2);
  assert.equal((await emails()).length, 5);

  for (const who of [null, chair, eugene]) {
    await assert.rejects(() => h.select(who, 'select cal_private.social_health_check()'), /permission denied/);
    await assert.rejects(() => h.select(who, `select cal_private.social_sync_failed('instagram', 'x', '{}'::jsonb)`), /permission denied/);
  }
});

test('an account that never synced, or whose sign-in ran out, is reported too', async () => {
  const h = await createDb();
  await h.sql(`select cal_private.set_email_settings('re_testkey_12345678')`);
  const staff = await h.staff();
  await h.setNow('2026-10-19T01:04:00Z');
  await connect(h, 'threads', staff);
  await h.setNow('2026-10-21T01:03:00Z');
  assert.equal((await h.sql('select cal_private.social_health_check() as n'))[0].n, 0, 'connected just under two days ago');
  await h.sql(`update public.cal_social_accounts set token_expires_at = '2026-10-20T00:00:00Z'`);
  await failed(h, 'threads', 'The Threads connection expired. Choose Reconnect on the Results tab.', { kind: 'expired' });
  await h.setNow('2026-10-21T09:10:00Z');
  assert.equal((await h.sql('select cal_private.social_health_check() as n'))[0].n, 1);
  const [mail] = await h.sql(`select body from net.http_calls where url = 'https://api.resend.com/emails'`);
  assert.equal(mail.body.subject, 'The Threads numbers have stopped updating');
  // The note already says to choose Reconnect, so nothing about the sign-in's date is added.
  assert.match(mail.body.text, /Threads \(@gil1906\)\nNo numbers have come in since it was connected on Sunday, October 18, 2026\.\nLatest note \(Tuesday, October 20\): The Threads connection expired\. Choose Reconnect on the Results tab\.\n\nWhat to do/);
});

test('the email gives the reason only when there is one: not an old note, and no date to wait for when the fix is Reconnect', async () => {
  const h = await createDb();
  await h.sql(`select cal_private.set_email_settings('re_testkey_12345678')`);
  const staff = await h.staff();
  await h.setNow('2026-10-19T01:04:00Z');
  await connect(h, 'instagram', staff);
  await connect(h, 'threads', staff);
  const emails = () => h.sql(`select body from net.http_calls where url = 'https://api.resend.com/emails' order by id`).then((rows) => rows.map((r) => r.body.text));
  const check = async (iso) => {
    await h.setNow(iso);
    return (await h.sql('select cal_private.social_health_check() as n'))[0].n;
  };

  // Threads: its last sync saved and left a note. Then the nightly request stopped arriving, so
  // nothing was recorded after it. That note is not why the numbers stopped.
  await h.setNow('2026-10-19T08:20:00Z');
  await sync(h, 'threads', { username: 'gil1906' }, []);
  await h.sql(`select cal_private.social_sync_failed('threads', 'Threads didn''t send the follower count this time.')`);
  // Instagram: the password changed, and the sign-in stopped working with weeks left on it.
  await sync(h, 'instagram', { username: 'gil1906', followers: 1500 }, []);
  await h.setNow('2026-10-21T08:20:00Z');
  await failed(h, 'instagram', 'The Instagram connection stopped working. Choose Reconnect on the Results tab.', { kind: 'token', request: 'GET graph.instagram.com/v25.0/me', status: 400, code: 190 });

  assert.equal(await check('2026-10-21T09:10:00Z'), 2);
  const [text] = await emails();
  assert.match(text, /Instagram \(@gil1906\)\nLast updated: Monday, October 19, 2026 \(2 days ago\)\nLatest note \(Wednesday, October 21\): The Instagram connection stopped working\. Choose Reconnect on the Results tab\.\nDetails, for Meta support: GET graph\.instagram\.com\/v25\.0\/me, HTTP 400, code 190\n\nThreads/);
  assert.match(text, /Threads \(@gil1906\)\nLast updated: Monday, October 19, 2026 \(2 days ago\)\nNo note\. Nothing has reported in since then, so the nightly update may not be running\. Whoever looks after the website should check it\.\nThe saved sign-in lasts until Thursday, December 17\./);
  assert.ok(!text.includes('follower count'), 'the old note stays out');
  assert.equal((text.match(/The saved sign-in lasts until/g) || []).length, 1, 'only for the account that should wait');
});

test('the weekly email keeps its day when pg_cron starts a moment early, and a failed send shows as a failed run', async () => {
  const h = await createDb();
  await h.sql(`select cal_private.set_email_settings('re_testkey_12345678')`);
  const staff = await h.staff();
  await h.setNow('2026-10-19T08:20:00Z');
  await connect(h, 'instagram', staff);
  await sync(h, 'instagram', { username: 'gil1906', followers: 1500 }, []);
  const check = async (iso) => {
    await h.setNow(iso);
    return (await h.sql('select cal_private.social_health_check() as n'))[0].n;
  };
  const sentCount = () => h.sql(`select count(*)::int as n from net.http_calls`).then((r) => r[0].n);

  // If the email can't even be handed over, the run fails where cron.job_run_details shows it, and
  // the account isn't marked, so the next morning tries again.
  await h.sql(`select set_config('app.net_fail', 'on', false)`);
  await assert.rejects(() => check('2026-10-21T09:10:00.350Z'), /pg_net is not available/);
  assert.equal((await account(h, 'instagram')).stale_alerted_at, null);
  await h.sql(`select set_config('app.net_fail', 'off', false)`);

  assert.equal(await check('2026-10-22T09:10:00.350Z'), 1);
  for (const early of ['2026-10-23T09:10:00.120Z', '2026-10-28T09:10:00.120Z']) assert.equal(await check(early), 0);
  assert.equal(await check('2026-10-29T09:10:00.120Z'), 1, 'a week on, though the job started 230 ms earlier in the second');
  assert.equal(await check('2026-11-05T09:10:00.480Z'), 1);
  assert.equal(await sentCount(), 3);
});

test('what Instagram or Threads sent stays with its note, and goes when the note does', async () => {
  const h = await createDb();
  await h.setNow(NOW);
  const staff = await h.staff();
  const chair = await h.chair('Farid Adenuga');
  await connect(h, 'instagram', staff);
  const detail = () => account(h, 'instagram').then((a) => a.last_error_detail);

  await failed(h, 'instagram', 'Instagram sent an error: API access blocked.', BLOCKED);
  assert.deepEqual(await detail(), BLOCKED);
  assert.deepEqual(await h.select(staff, 'select last_error_detail from public.cal_social_accounts'), [{ last_error_detail: BLOCKED }], 'the media team can read it');
  assert.deepEqual(await h.select(chair, 'select last_error_detail from public.cal_social_accounts'), [], 'no one else can');

  // A note after a sync that saved has no detail, and replaces the earlier error's.
  await h.sql(`select cal_private.social_sync_failed('instagram', 'Instagram asked the calendar to slow down. Numbers for some posts update on the next sync.')`);
  assert.equal(await detail(), null);

  // Anything that isn't a small object is left out; the note still saves.
  for (const odd of ['[1, 2]', '"text"', JSON.stringify({ trace: 'x'.repeat(1200) })]) {
    await h.sql('select cal_private.social_sync_failed($1, $2, $3::jsonb)', ['instagram', 'Instagram sent an error: Odd.', odd]);
    assert.deepEqual(await account(h, 'instagram').then((a) => [a.last_error, a.last_error_detail]), ['Instagram sent an error: Odd.', null]);
  }

  await failed(h, 'instagram', 'Instagram sent an error: API access blocked.', BLOCKED);
  await sync(h, 'instagram', { username: 'gil1906', followers: 1500 }, []);
  assert.equal(await detail(), null, 'a sync that saves clears it');

  await failed(h, 'instagram', 'The Instagram connection stopped working. Choose Reconnect on the Results tab.', { kind: 'token', code: 190 });
  await connect(h, 'instagram', staff, 'instagram-token-2');
  assert.deepEqual(await account(h, 'instagram').then((a) => [a.last_error, a.last_error_detail]), [null, null], 'so does reconnecting');
});

test('the results migration runs on a project that already ran the first three', async () => {
  const h = await createDb({
    migrations: ['20261013000100_content_calendar.sql', '20261013000200_chairs_and_request_files.sql', '20261014000100_request_emails.sql']
  });
  await h.setNow(NOW);
  const staff = await h.staff();
  const chair = await h.chair('Farid Adenuga', 'Social & Fundraising');
  const sent = await h.rpc1(chair, 'cal_submit_request', {
    p_request: JSON.stringify({
      contact_name: 'Farid Adenuga', committee: 'Social & Fundraising', title: 'Wine and Chill flyer', post_date: '2026-11-30',
      about: 'Promote the December Wine and Chill.', format: 'flyer', platforms: ['instagram'], youth: false, releases: false
    })
  });

  await h.migrate('20261018000100_social_results.sql');

  assert.equal((await h.select(staff, 'select id from public.cal_posts')).length, 128);
  assert.deepEqual((await h.select(staff, 'select id from public.cal_requests')).map((r) => r.id), [sent.id]);
  for (const t of TABLES) assert.deepEqual(await h.select(staff, `select * from public.${t}`), []);
  assert.equal((await secret(h, 'calendar_social_sync_key')).length, 1);
  await h.select(staff, `update public.cal_posts set status = 'posted' where id = '2026-11-03-election-day'`);
  assert.equal((await h.sql(`select status from public.cal_posts where id = '2026-11-03-election-day'`))[0].status, 'posted');
});
