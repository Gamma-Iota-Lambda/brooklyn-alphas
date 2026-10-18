// A stand-in for Instagram's and Threads' APIs: just enough of each for the calendar-social Edge
// Function, checked the way Meta checks them (app ID and secret, redirect address, one-time codes,
// short- and long-lived tokens), with switches to make them fail. social-function.test.mjs and the
// live stand-in (live-server.mjs) both use it.

const fix = (ts) => ts.replace(/([+-]\d\d)(\d\d)$/, '$1:$2');
const pick = (obj, fields) => Object.fromEntries(fields.filter((f) => f in obj).map((f) => [f, obj[f]]));
export const LONG_LIFE = 5183944;

export class Meta {
  // env: the Edge Function's app IDs and secrets. callback: the redirect address the apps allow.
  constructor({ env, callback }) {
    this.env = env;
    this.callback = callback;
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
    const env = this.env;

    if (url.host === 'api.instagram.com' || (platform === 'threads' && path === '/oauth/access_token')) {
      if (method !== 'POST') return reply(405, { error: { message: 'Use POST', code: 100 } });
      const [id, secret] = platform === 'instagram' ? [env.INSTAGRAM_APP_ID, env.INSTAGRAM_APP_SECRET] : [env.THREADS_APP_ID, env.THREADS_APP_SECRET];
      const ok = form.client_id === id && form.client_secret === secret && form.grant_type === 'authorization_code' &&
        form.redirect_uri === this.callback && this.codes.get(form.code) === platform;
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
      const [grant, secret] = platform === 'instagram' ? ['ig_exchange_token', env.INSTAGRAM_APP_SECRET] : ['th_exchange_token', env.THREADS_APP_SECRET];
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
