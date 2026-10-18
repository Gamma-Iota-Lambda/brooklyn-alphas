// The calendar-social Edge Function (supabase/functions/calendar-social/social.js), run in Node
// against the real migrations in PGlite, with Instagram and Threads simulated below. Covers Connect,
// the nightly sync, token renewal, and what the media team sees when something goes wrong.
// Run with the other database tests: node --test "tests/calendar/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from './harness.mjs';
import { createHandler, makeDb, DEFAULT_RETURN } from '../../supabase/functions/calendar-social/social.js';

const BASE = 'https://uqfoifrpyysqjvwtkgia.supabase.co';
const FN = `${BASE}/functions/v1/calendar-social`;
const CALLBACK = `${FN}/callback`;
const ENV = {
  SUPABASE_URL: BASE,
  INSTAGRAM_APP_ID: 'ig-app-1',
  INSTAGRAM_APP_SECRET: 'ig-secret-shh',
  THREADS_APP_ID: 'th-app-1',
  THREADS_APP_SECRET: 'th-secret-shh'
};
const LONG_LIFE = 5183944;

const fix = (ts) => ts.replace(/([+-]\d\d)(\d\d)$/, '$1:$2');
const pick = (obj, fields) => Object.fromEntries(fields.filter((f) => f in obj).map((f) => [f, obj[f]]));

// Just enough of Instagram's and Threads' APIs, checked the way Meta checks them, with switches to
// make them fail.
class Meta {
  constructor() {
    this.calls = [];
    this.tokens = new Map();
    this.codes = new Map([['ig-code-1', 'instagram'], ['th-code-1', 'threads']]);
    this.serial = 0;
    this.media = { instagram: [], threads: [] };
    this.numbers = new Map();
    this.unsupported = new Map();
    this.followers = { instagram: 1500, threads: 410 };
    this.rateLimitAfter = Infinity;
    this.insightCalls = 0;
    this.down = false;
  }

  issue(platform, kind) {
    const token = `${platform === 'instagram' ? 'IG' : 'TH'}-${kind}-${(this.serial += 1)}`;
    this.tokens.set(token, { platform, kind });
    return token;
  }

  add(platform, id, timestamp, fields = {}, numbers = {}) {
    this.media[platform].push({ id, timestamp, ...fields });
    this.media[platform].sort((a, b) => Date.parse(fix(b.timestamp)) - Date.parse(fix(a.timestamp)));
    this.numbers.set(id, numbers);
  }

  insightsFor(id) {
    return this.calls.filter((c) => c.path.endsWith(`/${id}/insights`)).length;
  }

  page(platform, params, url, withNext) {
    const since = params.since ? Number(params.since) * 1000 : -Infinity;
    const list = this.media[platform].filter((m) => Date.parse(fix(m.timestamp)) >= since);
    const start = Number(params.after || 0);
    const items = list.slice(start, start + Math.min(Number(params.limit || 25), 2));
    const end = start + items.length;
    const paging = { cursors: { before: `c${start}`, after: String(end) } };
    if (withNext && end < list.length) {
      const next = new URL(url);
      next.searchParams.set('after', String(end));
      paging.next = next.toString();
    }
    return { data: items.map((m) => pick(m, ['id', ...String(params.fields || '').split(',')])), paging };
  }

  insights(id, metric, reply) {
    this.insightCalls += 1;
    if (this.insightCalls > this.rateLimitAfter) {
      return reply(400, { error: { message: '(#4) Application request limit reached', type: 'OAuthException', code: 4 } });
    }
    const names = String(metric || '').split(',');
    const bad = names.find((n) => this.unsupported.get(id)?.has(n));
    if (bad) {
      return reply(400, { error: { message: `(#100) The Media Insights API does not support the ${bad} metric for this media product type.`, type: 'OAuthException', code: 100 } });
    }
    const numbers = this.numbers.get(id) || {};
    return reply(200, {
      data: names.map((name) => ({ name, period: 'lifetime', values: [{ value: numbers[name] ?? 0 }], title: name, id: `${id}/insights/${name}/lifetime` }))
    });
  }

  fetch = async (input, init = {}) => {
    if (this.down) throw new TypeError('fetch failed');
    const url = new URL(String(input));
    const method = (init.method || 'GET').toUpperCase();
    const form = init.body ? Object.fromEntries(new URLSearchParams(String(init.body))) : null;
    const params = Object.fromEntries(url.searchParams);
    this.calls.push({ method, host: url.host, path: url.pathname, params, form });
    const reply = (status, body) =>
      new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    const expired = () => reply(400, { error: { message: 'Error validating access token: Session has expired.', type: 'OAuthException', code: 190, error_subcode: 463 } });
    const platform = url.host === 'graph.threads.net' ? 'threads' : 'instagram';
    const held = this.tokens.get(params.access_token || '');
    const path = url.pathname;

    if (url.host === 'api.instagram.com' || (platform === 'threads' && path === '/oauth/access_token')) {
      if (method !== 'POST') return reply(405, { error: { message: 'Use POST', code: 100 } });
      const [id, secret] = platform === 'instagram' ? [ENV.INSTAGRAM_APP_ID, ENV.INSTAGRAM_APP_SECRET] : [ENV.THREADS_APP_ID, ENV.THREADS_APP_SECRET];
      const ok = form.client_id === id && form.client_secret === secret && form.grant_type === 'authorization_code' &&
        form.redirect_uri === CALLBACK && this.codes.get(form.code) === platform;
      if (!ok) {
        return platform === 'instagram'
          ? reply(400, { error_type: 'OAuthException', code: 400, error_message: 'Invalid authorization code' })
          : reply(400, { error: { message: 'Invalid verification code format.', type: 'OAuthException', code: 100 } });
      }
      this.codes.delete(form.code);
      const token = this.issue(platform, 'short');
      return platform === 'instagram'
        ? reply(200, { data: [{ access_token: token, user_id: '17841400000000001', permissions: 'instagram_business_basic,instagram_business_manage_insights' }] })
        // Threads sends user_id as a bare number too large for JavaScript to hold exactly.
        : reply(200, `{"access_token":"${token}","token_type":"bearer","user_id":17841405793187218}`);
    }
    if (path === '/access_token') {
      const [grant, secret] = platform === 'instagram' ? ['ig_exchange_token', ENV.INSTAGRAM_APP_SECRET] : ['th_exchange_token', ENV.THREADS_APP_SECRET];
      if (params.grant_type !== grant || params.client_secret !== secret || held?.platform !== platform || held.kind !== 'short') return expired();
      return reply(200, { access_token: this.issue(platform, 'long'), token_type: 'bearer', expires_in: LONG_LIFE });
    }
    if (path === '/refresh_access_token') {
      const grant = platform === 'instagram' ? 'ig_refresh_token' : 'th_refresh_token';
      if (params.grant_type !== grant || held?.platform !== platform || held.kind !== 'long') return expired();
      this.tokens.delete(params.access_token);
      return reply(200, { access_token: this.issue(platform, 'long'), token_type: 'bearer', expires_in: LONG_LIFE });
    }
    if (!held || held.platform !== platform || held.kind !== 'long') return expired();

    if (platform === 'instagram') {
      if (path === '/v25.0/me') {
        const me = { id: '9000000000000001', user_id: '17841400000000001', username: 'gil1906', followers_count: this.followers.instagram, media_count: 320 };
        return reply(200, { data: [pick(me, String(params.fields).split(','))] });
      }
      if (path === '/v25.0/me/media') return reply(200, this.page('instagram', params, url, true));
      const m = path.match(/^\/v25\.0\/(\w+)\/insights$/);
      if (m) return this.insights(m[1], params.metric, reply);
    } else {
      if (path === '/v1.0/me') return reply(200, { id: '26000000000000001', username: 'gil1906' });
      if (path === '/v1.0/me/threads_insights' && params.metric === 'followers_count') {
        return reply(200, { data: [{ name: 'followers_count', period: 'day', title: 'followers_count', total_value: { value: this.followers.threads }, id: '26000000000000001/insights/followers_count/day' }] });
      }
      if (path === '/v1.0/me/threads') return reply(200, this.page('threads', params, url, false));
      const m = path.match(/^\/v1\.0\/(\w+)\/insights$/);
      if (m) return this.insights(m[1], params.metric, reply);
    }
    return reply(400, { error: { message: `Unsupported get request: ${path}`, code: 100 } });
  };
}

async function setup(now = '2026-10-21T16:00:00Z', env = ENV) {
  const h = await createDb();
  await h.sql('delete from public.cal_posts');
  await h.setNow(now);
  const clock = { t: Date.parse(now) };
  const meta = new Meta();
  const tasks = [];
  const logs = [];
  const handler = createHandler({
    env,
    db: makeDb((text, params) => h.sql(text, params)),
    fetch: meta.fetch,
    waitUntil: (p) => tasks.push(p),
    now: () => clock.t,
    log: { error: (m) => logs.push(m), warn: (m) => logs.push(m) }
  });
  return {
    h,
    meta,
    logs,
    at: async (iso) => {
      clock.t = Date.parse(iso);
      await h.setNow(iso);
    },
    settle: async () => {
      while (tasks.length) await tasks.shift();
    },
    get: (path) => handler(new Request(`${FN}${path}`)),
    post: (path, headers = {}) => handler(new Request(`${FN}${path}`, { method: 'POST', headers, body: '{}' }))
  };
}

const location = (res) => new URL(res.headers.get('location'));
const note = (res) => location(res).searchParams.get('connect_error');

// A connection made earlier, with a token Meta knows.
async function connected(s, staff, platform) {
  const token = s.meta.issue(platform, 'long');
  await s.h.sql('select cal_private.social_save_connection($1, $2, $3, $4, $5, $6, $7)',
    [platform, `${platform}-1`, 'gil1906', token, LONG_LIFE, staff.id, `${BASE}/functions/v1`]);
  return token;
}

async function syncKey(h) {
  return (await h.sql(`select decrypted_secret from vault.decrypted_secrets where name = 'calendar_social_sync_key'`))[0].decrypted_secret;
}

const accountState = (s, staff, platform) =>
  s.h.select(staff, 'select last_sync_at, last_error from public.cal_social_accounts where platform = $1', [platform]).then((r) => r[0]);

test('Connect sends the media team to Instagram and back, keeps the token on the server, and syncs right away', async () => {
  const s = await setup('2026-10-21T16:00:00Z');
  const staff = await s.h.staff();
  s.meta.add('instagram', '1801', '2026-10-19T22:15:00+0000',
    { caption: "Founders' Day", media_type: 'CAROUSEL_ALBUM', media_product_type: 'FEED', permalink: 'https://www.instagram.com/p/DQ1abc/', like_count: 80, comments_count: 6 },
    { views: 900, reach: 700, likes: 80, comments: 6, saved: 9, shares: 12, total_interactions: 107 });
  s.meta.add('instagram', '1702', '2026-08-01T14:00:00+0000',
    { caption: 'Step show', media_type: 'VIDEO', media_product_type: 'REELS', permalink: 'https://www.instagram.com/reel/DP2def/', like_count: 300, comments_count: 20 },
    { views: 5000, reach: 4000, likes: 300, comments: 20, saved: 40, shares: 55, total_interactions: 415 });
  s.meta.add('instagram', '1603', '2026-03-01T14:00:00+0000', { media_type: 'IMAGE', media_product_type: 'FEED', like_count: 50, comments_count: 2 }, { views: 600 });
  s.meta.add('instagram', '1504', '2025-12-01T14:00:00+0000', { media_type: 'IMAGE', media_product_type: 'FEED', like_count: 40, comments_count: 1 }, { views: 500 });
  s.meta.add('instagram', '1405', '2025-01-01T14:00:00+0000', { media_type: 'IMAGE', media_product_type: 'FEED', like_count: 10, comments_count: 0 }, { views: 100 });

  const state = await s.h.rpc1(staff, 'cal_social_connect_start', { p_platform: 'instagram', p_return: 'https://www.gil1906.org/calendar.html' });
  const go = await s.get(`/connect?state=${state}`);
  assert.equal(go.status, 302);
  const to = location(go);
  assert.equal(to.origin + to.pathname, 'https://www.instagram.com/oauth/authorize');
  assert.deepEqual(Object.fromEntries(to.searchParams), {
    client_id: 'ig-app-1',
    redirect_uri: CALLBACK,
    response_type: 'code',
    scope: 'instagram_business_basic,instagram_business_manage_insights',
    state,
    force_reauth: 'true',
    enable_fb_login: 'false'
  });

  // Instagram adds #_ to the code. Browsers usually drop it; the function drops it either way.
  const back = await s.get(`/callback?code=${encodeURIComponent('ig-code-1#_')}&state=${state}`);
  assert.equal(back.status, 303);
  assert.equal(back.headers.get('location'), 'https://www.gil1906.org/calendar.html?connected=instagram#results');
  await s.settle();

  const exchange = s.meta.calls.find((c) => c.host === 'api.instagram.com');
  assert.deepEqual(exchange.form, {
    client_id: 'ig-app-1', client_secret: 'ig-secret-shh', grant_type: 'authorization_code', redirect_uri: CALLBACK, code: 'ig-code-1'
  });
  const [vault] = await s.h.sql(`select decrypted_secret from vault.decrypted_secrets where name = 'calendar_instagram_token'`);
  assert.match(vault.decrypted_secret, /^IG-long-\d+$/, 'Vault holds the long-lived token');
  const [account] = await s.h.select(staff, 'select * from public.cal_social_accounts');
  assert.equal(account.account_id, '17841400000000001');
  assert.equal(account.username, 'gil1906');
  assert.equal(account.connected_by, staff.id);
  assert.equal(account.token_expires_at.getTime(), Date.parse('2026-10-21T16:00:00Z') + LONG_LIFE * 1000);
  assert.equal(account.last_error, null);
  assert.ok(account.last_sync_at, 'the first sync ran');
  assert.deepEqual(await s.h.sql(`select value from cal_private.config where key = 'functions_url'`), [{ value: `${BASE}/functions/v1` }]);

  // The first sync: every post from the last 400 days, with its numbers, across pages.
  const posts = await s.h.select(staff, `
    select media_id, media_type, permalink, caption, views::int, reach::int, likes::int, comments::int, saves::int, shares::int, interactions::int
    from public.cal_social_posts order by posted_at desc`);
  assert.deepEqual(posts.map((p) => p.media_id), ['1801', '1702', '1603', '1504']);
  assert.deepEqual(posts[0], {
    media_id: '1801', media_type: 'CAROUSEL_ALBUM', permalink: 'https://www.instagram.com/p/DQ1abc/', caption: "Founders' Day",
    views: 900, reach: 700, likes: 80, comments: 6, saves: 9, shares: 12, interactions: 107
  });
  assert.equal(posts[1].media_type, 'REELS');
  assert.equal(s.meta.calls.filter((c) => c.path === '/v25.0/me/media').length, 3, 'three pages of media');
  assert.equal(s.meta.insightCalls, 4);
  assert.deepEqual(await s.h.select(staff, 'select day::text, followers::int, posts::int from public.cal_social_account_days'),
    [{ day: '2026-10-21', followers: 1500, posts: 320 }]);

  // Codes work once.
  const again = await s.get(`/callback?code=ig-code-1&state=${state}`);
  assert.equal(location(again).origin + location(again).pathname, DEFAULT_RETURN);
  assert.match(note(again), /That Connect link has expired/);
  assert.ok(!JSON.stringify(s.logs).includes('IG-'), 'tokens never reach the logs');
});

test('Threads connects the same way, leaves out reposts of other accounts, and adds up interactions', async () => {
  const s = await setup('2026-10-21T16:00:00Z');
  const staff = await s.h.staff();
  s.meta.add('threads', '3101', '2026-10-20T13:00:00+0000', { text: 'Vote early', permalink: 'https://www.threads.com/@gil1906/post/DQx1', media_type: 'TEXT_POST', is_quote_post: false },
    { views: 1200, likes: 40, replies: 5, reposts: 3, quotes: 1, shares: 2 });
  s.meta.add('threads', '3102', '2026-10-19T13:00:00+0000', { text: 'Repost', media_type: 'REPOST_FACADE' }, { views: 999 });
  s.meta.add('threads', '3103', '2026-10-18T13:00:00+0000', { text: 'Photo', permalink: 'https://www.threads.com/@gil1906/post/DQx3', media_type: 'IMAGE', is_quote_post: false },
    { views: 800, likes: 20, replies: 2, reposts: 1, quotes: 0, shares: 4 });
  s.meta.add('threads', '3104', '2026-10-10T13:00:00+0000', { text: 'Quote', permalink: 'https://www.threads.com/@gil1906/post/DQx4', media_type: 'TEXT_POST', is_quote_post: true },
    { views: 300, likes: 10, replies: 1, reposts: 0, quotes: 0 });
  s.meta.unsupported.set('3104', new Set(['shares']));

  const state = await s.h.rpc1(staff, 'cal_social_connect_start', { p_platform: 'threads', p_return: 'http://localhost:5181/calendar.html' });
  const to = location(await s.get(`/connect?state=${state}`));
  assert.equal(to.origin + to.pathname, 'https://threads.com/oauth/authorize');
  assert.deepEqual(Object.fromEntries(to.searchParams), {
    client_id: 'th-app-1', redirect_uri: CALLBACK, response_type: 'code', scope: 'threads_basic,threads_manage_insights', state
  });
  const back = await s.get(`/callback?code=th-code-1&state=${state}`);
  assert.equal(back.headers.get('location'), 'http://localhost:5181/calendar.html?connected=threads#results');
  await s.settle();

  const [account] = await s.h.select(staff, 'select account_id, username, last_error from public.cal_social_accounts');
  assert.deepEqual(account, { account_id: '26000000000000001', username: 'gil1906', last_error: null }, "the account's id comes from /me, exactly");
  const posts = await s.h.select(staff, `
    select media_id, media_type, caption, views::int, likes::int, replies::int, reposts::int, quotes::int, shares::int, interactions::int, reach
    from public.cal_social_posts order by posted_at desc`);
  assert.deepEqual(posts, [
    { media_id: '3101', media_type: 'TEXT_POST', caption: 'Vote early', views: 1200, likes: 40, replies: 5, reposts: 3, quotes: 1, shares: 2, interactions: 51, reach: null },
    { media_id: '3103', media_type: 'IMAGE', caption: 'Photo', views: 800, likes: 20, replies: 2, reposts: 1, quotes: 0, shares: 4, interactions: 27, reach: null },
    { media_id: '3104', media_type: 'TEXT_POST', caption: 'Quote', views: 300, likes: 10, replies: 1, reposts: 0, quotes: 0, shares: null, interactions: 11, reach: null }
  ]);
  assert.equal(s.meta.insightsFor('3102'), 0, 'no insights asked for a repost');
  assert.equal(s.meta.insightsFor('3104'), 2, 'one try with shares, one without');
  const list = s.meta.calls.find((c) => c.path === '/v1.0/me/threads');
  assert.equal(list.params.since, String(Math.floor((Date.parse('2026-10-21T16:00:00Z') - 400 * 86400000) / 1000)));
  assert.deepEqual(await s.h.select(staff, 'select platform, followers::int from public.cal_social_account_days'), [{ platform: 'threads', followers: 410 }]);
});

test('a cancelled or failed sign-in comes back to the calendar with a note and saves nothing', async () => {
  const s = await setup('2026-10-21T16:00:00Z');
  const staff = await s.h.staff();
  const start = (platform, ret = 'https://www.gil1906.org/calendar.html') =>
    s.h.rpc1(staff, 'cal_social_connect_start', { p_platform: platform, p_return: ret });
  const nothingSaved = async () => {
    assert.deepEqual(await s.h.sql('select platform from public.cal_social_accounts'), []);
    assert.deepEqual(await s.h.sql(`select name from vault.secrets where name like 'calendar_%_token'`), []);
  };

  let state = await start('instagram');
  let res = await s.get(`/callback?error=access_denied&error_reason=user_denied&error_description=The+user+denied+your+request&state=${state}`);
  assert.equal(location(res).origin + location(res).pathname, 'https://www.gil1906.org/calendar.html');
  assert.equal(location(res).hash, '#results');
  assert.equal(note(res), "Instagram wasn't connected. The sign-in was cancelled.");
  await nothingSaved();

  state = await start('instagram');
  res = await s.get(`/callback?code=not-a-real-code&state=${state}`);
  assert.equal(note(res), "Instagram wasn't connected. Instagram sent an error: Invalid authorization code");
  state = await start('threads');
  res = await s.get(`/callback?code=not-a-real-code&state=${state}`);
  assert.equal(note(res), "Threads wasn't connected. Threads sent an error: Invalid verification code format.");
  state = await start('threads');
  res = await s.get(`/callback?state=${state}`);
  assert.equal(note(res), "Threads wasn't connected. It sent no sign-in code.");
  await nothingSaved();

  // Expired, unknown, and missing codes.
  state = await start('instagram');
  await s.at('2026-10-21T16:31:00Z');
  for (const path of [`/connect?state=${state}`, `/callback?code=ig-code-1&state=${state}`, '/connect?state=%3Cscript%3E', '/connect']) {
    res = await s.get(path);
    assert.equal(location(res).origin + location(res).pathname, DEFAULT_RETURN, path);
    assert.equal(note(res), 'That Connect link has expired. Choose Connect again on the Results tab.', path);
  }
  await nothingSaved();
  assert.equal(s.meta.codes.has('ig-code-1'), true, 'an expired code is never exchanged');

  // An app that isn't set up yet.
  const bare = await setup('2026-10-21T16:00:00Z', { SUPABASE_URL: BASE, INSTAGRAM_APP_ID: 'ig-app-1', INSTAGRAM_APP_SECRET: 'ig-secret-shh' });
  const staff2 = await bare.h.staff();
  const threadsState = await bare.h.rpc1(staff2, 'cal_social_connect_start', { p_platform: 'threads', p_return: 'https://www.gil1906.org/calendar.html' });
  res = await bare.get(`/connect?state=${threadsState}`);
  assert.equal(note(res), "Threads isn't set up yet. Its app ID and secret go in the Edge Function's secrets first.");
  assert.equal(bare.meta.calls.length, 0);
});

test('the nightly sync needs the key, renews tokens weekly, and refreshes older posts on Sundays', async () => {
  const s = await setup('2026-10-20T08:20:00Z');
  const staff = await s.h.staff();
  const first = await connected(s, staff, 'instagram');
  s.meta.add('instagram', '1801', '2026-10-19T22:15:00+0000', { media_type: 'IMAGE', media_product_type: 'FEED', like_count: 80, comments_count: 6 }, { views: 900, likes: 80 });
  s.meta.add('instagram', '1702', '2026-08-01T14:00:00+0000', { media_type: 'VIDEO', media_product_type: 'REELS', like_count: 300, comments_count: 20 }, { views: 5000, likes: 300 });
  s.meta.add('instagram', '1603', '2026-03-01T14:00:00+0000', { media_type: 'IMAGE', media_product_type: 'FEED', like_count: 50, comments_count: 2 }, { views: 600, likes: 50 });
  // A calendar post that day, for the end-to-end match.
  await s.h.sql(`insert into public.cal_posts (id, date, title, platforms) values ('p-founders', '2026-10-19', 'Founders Day', '{instagram,threads}')`);

  for (const headers of [{}, { 'x-sync-key': 'wrong' }]) {
    const res = await s.post('/sync', headers);
    assert.equal(res.status, 401);
  }
  assert.equal(s.meta.calls.length, 0);
  const key = await syncKey(s.h);
  const nightly = async (iso) => {
    await s.at(iso);
    const before = s.meta.insightCalls;
    const res = await s.post('/sync', { 'x-sync-key': key });
    assert.equal(res.status, 202);
    assert.deepEqual(await res.json(), { syncing: ['instagram'] });
    await s.settle();
    return s.meta.insightCalls - before;
  };

  assert.equal(new Date('2026-10-21T08:20:00Z').getUTCDay(), 3, 'a Wednesday');
  assert.equal(await nightly('2026-10-21T08:20:00Z'), 3, 'the first sync gets numbers for every post');
  const views = async () => Object.fromEntries((await s.h.select(staff, 'select media_id, views::int, likes::int, post_id from public.cal_social_posts')).map((r) => [r.media_id, r]));
  assert.equal((await views())['1801'].post_id, 'p-founders', 'matched to the calendar by date');

  s.meta.add('instagram', '1902', '2026-10-21T20:00:00+0000', { media_type: 'IMAGE', media_product_type: 'FEED', like_count: 12, comments_count: 1 }, { views: 150, likes: 12 });
  s.meta.media.instagram.find((m) => m.id === '1702').like_count = 310;
  s.meta.numbers.set('1702', { views: 5100, likes: 310 });
  assert.equal(await nightly('2026-10-22T08:20:00Z'), 2, 'Thursday: the new post and the one from this week');
  let now = await views();
  assert.deepEqual([now['1702'].views, now['1702'].likes], [5000, 310], 'older posts keep their numbers and update likes from the post list');
  assert.equal(now['1902'].views, 150);

  assert.equal(new Date('2026-10-25T08:20:00Z').getUTCDay(), 0, 'a Sunday');
  assert.equal(await nightly('2026-10-25T08:20:00Z'), 4, 'Sunday: every post');
  now = await views();
  assert.equal(now['1702'].views, 5100);
  assert.equal(s.meta.calls.filter((c) => c.path === '/refresh_access_token').length, 0, 'no renewal in the first week');

  assert.equal(await nightly('2026-10-28T08:20:00Z'), 2);
  const renewals = s.meta.calls.filter((c) => c.path === '/refresh_access_token');
  assert.equal(renewals.length, 1, 'renewed once the token is a week old');
  assert.equal(renewals[0].params.grant_type, 'ig_refresh_token');
  const [vault] = await s.h.sql(`select decrypted_secret from vault.decrypted_secrets where name = 'calendar_instagram_token'`);
  assert.notEqual(vault.decrypted_secret, first);
  assert.equal(s.meta.tokens.has(first), false);
  const [account] = await s.h.select(staff, 'select token_refreshed_at, token_expires_at, last_error from public.cal_social_accounts');
  assert.equal(account.token_refreshed_at.toISOString(), '2026-10-28T08:20:00.000Z');
  assert.equal(account.token_expires_at.getTime(), Date.parse('2026-10-28T08:20:00Z') + LONG_LIFE * 1000);
  assert.equal(account.last_error, null);
  const lastMedia = s.meta.calls.filter((c) => c.path === '/v25.0/me/media').at(-1);
  assert.equal(lastMedia.params.access_token, vault.decrypted_secret, 'the sync uses the renewed token');

  const days = await s.h.select(staff, `select day::text from public.cal_social_post_days where media_id = '1801' order by day`);
  assert.deepEqual(days.map((d) => d.day), ['2026-10-21', '2026-10-22', '2026-10-25', '2026-10-28'], 'a snapshot each night');
});

test('sync problems leave a note on the Results tab, and the numbers that came through still save', async () => {
  const s = await setup('2026-10-21T08:20:00Z');
  const staff = await s.h.staff();
  const igToken = await connected(s, staff, 'instagram');
  const thToken = await connected(s, staff, 'threads');
  for (const [id, ts] of [['1801', '2026-10-19T22:15:00+0000'], ['1702', '2026-10-12T14:00:00+0000'], ['1603', '2026-10-05T14:00:00+0000']]) {
    s.meta.add('instagram', id, ts, { media_type: 'IMAGE', media_product_type: 'FEED', like_count: 10, comments_count: 1 }, { views: 100, reach: 90, likes: 10 });
  }
  s.meta.add('threads', '3101', '2026-10-20T13:00:00+0000', { text: 'Hello', media_type: 'TEXT_POST' }, { views: 50, likes: 5 });
  const key = await syncKey(s.h);
  const nightly = async (iso) => {
    await s.at(iso);
    await s.post('/sync', { 'x-sync-key': key });
    await s.settle();
  };

  // Threads stops accepting its token; Instagram keeps going.
  s.meta.tokens.delete(thToken);
  // Instagram can't report views for one post, so it gets the smaller set of numbers.
  s.meta.unsupported.set('1702', new Set(['views', 'total_interactions']));
  await nightly('2026-10-21T08:20:00Z');
  assert.equal((await accountState(s, staff, 'threads')).last_error, 'The Threads connection stopped working. Choose Reconnect on the Results tab.');
  assert.equal((await accountState(s, staff, 'instagram')).last_error, null);
  const reach = await s.h.select(staff, `select media_id, views::int, reach::int from public.cal_social_posts where platform = 'instagram' order by media_id`);
  assert.deepEqual(reach, [
    { media_id: '1603', views: 100, reach: 90 },
    { media_id: '1702', views: null, reach: 90 },
    { media_id: '1801', views: 100, reach: 90 }
  ]);

  // Rate limits stop the numbers partway. Every post still saves with its likes.
  s.meta.add('instagram', '1902', '2026-10-21T20:00:00+0000', { media_type: 'IMAGE', media_product_type: 'FEED', like_count: 7, comments_count: 0 }, { views: 70, likes: 7 });
  s.meta.add('instagram', '1903', '2026-10-21T21:00:00+0000', { media_type: 'IMAGE', media_product_type: 'FEED', like_count: 8, comments_count: 0 }, { views: 80, likes: 8 });
  s.meta.rateLimitAfter = s.meta.insightCalls + 1;
  await nightly('2026-10-22T08:20:00Z');
  assert.equal((await accountState(s, staff, 'instagram')).last_error,
    'Instagram asked the calendar to slow down. Numbers for some posts update on the next sync.');
  const fresh = await s.h.select(staff, `select media_id, views::int, likes::int from public.cal_social_posts where media_id in ('1902', '1903') order by media_id`);
  assert.equal(fresh.length, 2);
  assert.deepEqual(fresh.map((p) => p.likes), [7, 8]);
  assert.equal(fresh.filter((p) => p.views !== null).length, 1, 'one post got its numbers before the limit');
  s.meta.rateLimitAfter = Infinity;

  // No answer at all.
  s.meta.down = true;
  await nightly('2026-10-23T08:20:00Z');
  assert.equal((await accountState(s, staff, 'instagram')).last_error, "Instagram didn't answer. The next sync tries again.");
  s.meta.down = false;

  // A token past its expiry date isn't sent anywhere.
  await s.h.sql(`update public.cal_social_accounts set token_expires_at = '2026-10-23T00:00:00Z' where platform = 'instagram'`);
  const calls = s.meta.calls.length;
  await nightly('2026-10-24T08:20:00Z');
  assert.equal((await accountState(s, staff, 'instagram')).last_error, 'The Instagram connection expired. Choose Reconnect on the Results tab.');
  assert.equal(s.meta.calls.filter((c, i) => i >= calls && c.host === 'graph.instagram.com').length, 0);

  // Reconnecting clears the note, and the next sync runs clean.
  await s.h.sql('select cal_private.social_save_connection($1, $2, $3, $4, $5, $6, $7)',
    ['instagram', 'instagram-1', 'gil1906', s.meta.issue('instagram', 'long'), LONG_LIFE, staff.id, `${BASE}/functions/v1`]);
  await nightly('2026-10-25T08:20:00Z');
  const state = await accountState(s, staff, 'instagram');
  assert.equal(state.last_error, null);
  assert.equal(state.last_sync_at.toISOString(), '2026-10-25T08:20:00.000Z');

  const notes = JSON.stringify([...(await s.h.sql('select last_error from public.cal_social_accounts')), ...s.logs]);
  for (const secret of [igToken, thToken, 'ig-secret-shh', 'th-secret-shh']) assert.ok(!notes.includes(secret), 'no tokens or secrets in notes or logs');
});

test("Meta's uninstall and deletion callbacks answer, and anything else is not found", async () => {
  const s = await setup();
  const uninstall = await s.post('/uninstall');
  assert.equal(uninstall.status, 200);
  assert.deepEqual(await uninstall.json(), { ok: true });
  const deletion = await s.post('/delete');
  assert.equal(deletion.status, 200);
  const body = await deletion.json();
  assert.equal(body.url, `${DEFAULT_RETURN}#results`);
  assert.match(body.confirmation_code, /^[0-9a-f-]{36}$/);
  assert.equal((await s.get('/sync')).status, 404);
  assert.equal((await s.get('/anything')).status, 404);
  assert.equal((await s.post('/connect')).status, 404);
});
