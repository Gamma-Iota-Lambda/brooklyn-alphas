// Live mode: Supabase for sign-in, posts, requests, request files, and results.
// Needs the project URL and publishable key in assets/calendar/config.js.
// Brothers and chairs write through database functions; the media team edits posts directly under
// row level security. Request files go to the private calendar-files storage bucket. Results come
// from the tables the calendar-social Edge Function fills each night.

const PAGE = 1000;
const BUCKET = 'calendar-files';
const randomId = () => (globalThis.crypto && crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`).replace(/-/g, '').slice(0, 10);

// Storage errors, in words for chairs.
function friendlyStorage(error) {
  const msg = (error && (error.message || error.error)) || '';
  if (/maximum allowed size|too large|exceeded/i.test(msg)) return 'That file is over 50 MB. For large videos, share a Google Drive link instead.';
  if (/mime type|not supported/i.test(msg)) return 'That kind of file can\'t be attached. Attach photos, videos, or PDFs.';
  if (/row-level security|unauthorized|403/i.test(msg)) return 'Only committee chairs and the media team can attach files.';
  return friendly(error, 'The file could not upload. Try again.');
}

// A storage-safe file name: letters, digits, dots, dashes, and underscores.
export function safeFileName(name) {
  const base = String(name || 'file').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\w.-]+/g, '-').replace(/-+/g, '-').replace(/^[-.]+|-+$/g, '');
  return (base || 'file').slice(-80);
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (window.supabase) return resolve();
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('The calendar could not load its sign-in library. Check your connection and reload.'));
    document.head.appendChild(s);
  });
}

// Database functions raise messages written for people; pass those through and translate the rest.
function friendly(error, fallback = 'Something went wrong. Try again.') {
  const msg = (error && (error.message || error.error_description)) || '';
  if (!msg) return fallback;
  if (/row-level security/i.test(msg)) return 'Only the media team can change the calendar.';
  if (/violates check constraint/i.test(msg)) return 'One of the fields is not in the expected format. Check the form and try again.';
  if (/permission denied/i.test(msg)) return 'Sign in to do that.';
  if (/Failed to fetch|NetworkError|network/i.test(msg)) return "Couldn't reach the calendar. Check your connection and try again.";
  return msg;
}

const nn = (v) => (v === '' || v === undefined ? null : v);

export function rowToPost(r) {
  return {
    id: r.id, date: r.date, title: r.title, category: r.category, program: r.program || '',
    format: r.format, platforms: r.platforms || [], status: r.status, committee: r.committee || '',
    concept: r.concept || '', caption: r.caption || '', notes: r.notes || '', eventDate: r.event_date || '',
    link: r.link || '', assetLink: r.asset_link || '', source: r.source || '', requestId: r.request_id || '',
    createdAt: r.created_at || '', updatedAt: r.updated_at || ''
  };
}

export function postToRow(p) {
  return {
    id: p.id, date: p.date, title: p.title, category: p.category, program: nn(p.program), format: p.format,
    platforms: p.platforms, status: p.status, committee: nn(p.committee), concept: nn(p.concept),
    caption: nn(p.caption), notes: nn(p.notes), event_date: nn(p.eventDate), link: nn(p.link),
    asset_link: nn(p.assetLink), source: nn(p.source)
  };
}

export function rowToRequest(r) {
  return {
    id: r.id, title: r.title, contactName: r.contact_name, committee: r.committee, postDate: r.post_date,
    eventDate: r.event_date || '', about: r.about, format: r.format, platforms: r.platforms || [],
    program: r.program || '', assetLink: r.asset_link || '', caption: r.caption || '', link: r.link || '',
    youth: !!r.youth, releases: !!r.releases, status: r.status, reviewNote: r.review_note || '',
    postId: r.post_id || '', memberId: r.member_id || '', files: Array.isArray(r.files) ? r.files : [],
    createdAt: r.created_at || '', updatedAt: r.updated_at || ''
  };
}

// Results: the connected accounts, each platform post with its numbers, and followers by day.
const num = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

export function rowToAccount(r) {
  return {
    platform: r.platform, username: r.username || '', connectedAt: r.connected_at || '', tokenExpiresAt: r.token_expires_at || '',
    lastSyncAt: r.last_sync_at || '', lastError: r.last_error || '', lastErrorAt: r.last_error_at || ''
  };
}

export function rowToSocial(r) {
  return {
    platform: r.platform, mediaId: r.media_id, postedAt: r.posted_at, permalink: r.permalink || '', mediaType: r.media_type || '',
    caption: r.caption || '', postId: r.post_id || '', matchSource: r.match_source || '',
    views: num(r.views), reach: num(r.reach), likes: num(r.likes), comments: num(r.comments), saves: num(r.saves),
    shares: num(r.shares), replies: num(r.replies), reposts: num(r.reposts), quotes: num(r.quotes), interactions: num(r.interactions)
  };
}

function requestToJson(q) {
  return {
    contact_name: q.contactName, committee: q.committee, title: q.title, post_date: q.postDate,
    event_date: q.eventDate || '', about: q.about, format: q.format, platforms: q.platforms,
    program: q.program || '', asset_link: q.assetLink || '', caption: q.caption || '', link: q.link || '',
    youth: !!q.youth, releases: !!q.releases, files: q.files || []
  };
}

export class LiveApi {
  constructor(config) {
    this.mode = 'live';
    this.config = config;
    this.client = null;
    this.session = null;
  }

  async init() {
    await loadScript(new URL('./vendor/supabase.js', import.meta.url).href);
    this.client = window.supabase.createClient(this.config.supabaseUrl, this.config.supabaseKey, {
      auth: { persistSession: true, autoRefreshToken: true, storageKey: 'gilcal.auth' }
    });
    const { data } = await this.client.auth.getSession();
    this.session = data.session;
    this.client.auth.onAuthStateChange((_event, session) => { this.session = session; });
  }

  async rpc(fn, args = {}) {
    const { data, error } = await this.client.rpc(fn, args);
    if (error) throw new Error(friendly(error));
    return data;
  }

  async rows(query, fallback) {
    const { data, error } = await query;
    if (error) throw new Error(friendly(error, fallback));
    return data;
  }

  // Supabase returns at most 1,000 rows per request, so read in pages. make() builds a fresh query each time.
  async allRows(make, fallback) {
    const out = [];
    for (let from = 0; ; from += PAGE) {
      const page = await this.rows(make().range(from, from + PAGE - 1), fallback);
      out.push(...page);
      if (page.length < PAGE) return out;
    }
  }

  // The login behind the session: {email, anonymous}, or null when no one is signed in.
  account() {
    const u = this.session && this.session.user;
    return u ? { email: u.email || '', anonymous: !!u.is_anonymous } : null;
  }

  async settings() {
    return this.rpc('cal_settings');
  }

  // Returns {role: 'visitor' | 'member' | 'chair' | 'staff', name, member_id, committee}.
  async whoami() {
    const me = await this.rpc('cal_whoami');
    // A half-finished sign-in, or a name now signed in on another device, leaves an anonymous
    // session with no brother behind it. Drop it so this device shows the sign-in prompt and the
    // next sign-in starts fresh.
    if (me.role === 'visitor' && this.session?.user?.is_anonymous) {
      try { await this.client.auth.signOut({ scope: 'local' }); } catch { /* already gone */ }
      this.session = null;
    }
    return me;
  }

  async ensureSession() {
    if (this.session) return;
    const { data, error } = await this.client.auth.signInAnonymously();
    if (error) {
      if (/anonymous/i.test(error.message)) {
        throw new Error('Brother sign-in is turned off. The media team needs to allow anonymous sign-ins in Supabase.');
      }
      if (/rate limit/i.test(error.message)) {
        throw new Error('Too many sign-ins from this network in the last hour. Wait a few minutes and try again.');
      }
      throw new Error(friendly(error));
    }
    this.session = data.session;
  }

  // ------------------------------------------------------------ reads

  async posts() {
    const rows = await this.allRows(
      () => this.client.from('cal_posts').select('*').order('date').order('id'),
      'The calendar could not load.'
    );
    return rows.map(rowToPost);
  }

  async requests() {
    const rows = await this.allRows(
      () => this.client.from('cal_requests').select('*').order('post_date').order('id'),
      'Requests could not load.'
    );
    return rows.map(rowToRequest);
  }

  // ------------------------------------------------------------ brothers

  async join({ code, name, committee, pin }) {
    await this.ensureSession();
    return this.rpc('cal_join', { p_code: code, p_name: name, p_pin: pin, p_committee: committee || null });
  }

  async rejoin({ name, pin }) {
    await this.ensureSession();
    const res = await this.rpc('cal_rejoin', { p_name: name, p_pin: pin });
    if (!res.ok) throw new Error(res.message);
    return res.member;
  }

  async submitRequest(q) {
    return rowToRequest(await this.rpc('cal_submit_request', { p_request: requestToJson(q) }));
  }

  async updateRequest(id, q) {
    return rowToRequest(await this.rpc('cal_update_request', { p_id: id, p_request: requestToJson(q) }));
  }

  // ------------------------------------------------------------ media team

  async staffSignIn(email, password) {
    const { data, error } = await this.client.auth.signInWithPassword({ email, password });
    if (error) {
      throw new Error(/invalid login/i.test(error.message) ? 'That email and password do not match.'
        : /not confirmed/i.test(error.message) ? 'Confirm your email first, using the link Supabase sent you.'
        : friendly(error));
    }
    this.session = data.session;
  }

  async staffSignUp(email, password) {
    const { data, error } = await this.client.auth.signUp({ email, password });
    if (error) throw new Error(friendly(error));
    this.session = data.session;
    return { needsConfirm: !data.session };
  }

  async claimStaff(code, name) {
    return this.rpc('cal_claim_staff', { p_code: code, p_name: name });
  }

  async signOut() {
    await this.client.auth.signOut();
    this.session = null;
  }

  async savePost(post, { isNew }) {
    const row = postToRow(post);
    const q = isNew
      ? this.client.from('cal_posts').insert(row).select().single()
      : this.client.from('cal_posts').update(row).eq('id', post.id).select().single();
    return rowToPost(await this.rows(q, 'The post could not be saved.'));
  }

  async setPostStatus(id, status) {
    await this.rows(this.client.from('cal_posts').update({ status }).eq('id', id), 'The status could not be saved.');
  }

  async deletePost(id) {
    await this.rows(this.client.from('cal_posts').delete().eq('id', id), 'The post could not be deleted.');
  }

  async reviewRequest(id, status, note) {
    return rowToRequest(await this.rpc('cal_review_request', { p_id: id, p_status: status, p_note: note || null }));
  }

  async approveRequest(id, post) {
    return rowToPost(await this.rpc('cal_approve_request', { p_id: id, p_post: postToRow(post) }));
  }

  async memberList() {
    const rows = await this.rpc('cal_member_list');
    return rows.map((m) => ({
      id: m.id, name: m.display_name, committee: m.committee || '', chair: !!m.chair, createdAt: m.created_at,
      lastSeenAt: m.last_seen_at, requests: Number(m.requests) || 0, locked: !!m.locked, signedIn: !!m.signed_in
    }));
  }

  async staffList() {
    const rows = await this.rows(
      this.client.from('cal_staff').select('display_name, created_at').order('display_name'),
      'The media team list could not load.'
    );
    return rows.map((s) => ({ name: s.display_name, createdAt: s.created_at }));
  }

  async resetPin(memberId, pin) {
    await this.rpc('cal_reset_pin', { p_member_id: memberId, p_pin: pin });
  }

  async removeMember(memberId) {
    await this.rpc('cal_remove_member', { p_member_id: memberId });
  }

  // Marks a brother as a committee chair (chair true) or back to a viewer.
  async setChair(memberId, chair, committee) {
    return this.rpc('cal_set_chair', { p_member_id: memberId, p_chair: !!chair, p_committee: committee || null });
  }

  // ------------------------------------------------------------ request files

  // Uploads one file into requests/<folder>/ and returns what the request stores about it.
  // folder is the chair's member id, or 'staff' for the media team.
  async uploadFile(file, folder) {
    const path = `requests/${folder}/${randomId()}-${safeFileName(file.name)}`;
    const { error } = await this.client.storage.from(BUCKET).upload(path, file, {
      contentType: file.type || 'application/octet-stream', upsert: false
    });
    if (error) throw new Error(friendlyStorage(error));
    return { path, name: String(file.name || 'file').slice(0, 200), size: file.size, type: file.type || '' };
  }

  async removeFiles(paths) {
    if (!paths.length) return;
    const { error } = await this.client.storage.from(BUCKET).remove(paths);
    if (error) throw new Error(friendlyStorage(error));
  }

  // Links that work for an hour: {path: url}. Files the person may not see are left out.
  async fileUrls(paths) {
    if (!paths.length) return {};
    const { data, error } = await this.client.storage.from(BUCKET).createSignedUrls(paths, 3600);
    if (error) throw new Error(friendlyStorage(error));
    return Object.fromEntries((data || []).filter((d) => d.signedUrl && !d.error).map((d) => [d.path, d.signedUrl]));
  }

  async setChapterCode(code) {
    await this.rpc('cal_set_chapter_code', { p_code: code });
  }

  // ------------------------------------------------------------ results (media team)

  async socialResults() {
    const fallback = 'Results could not load.';
    const [accounts, posts, followers] = await Promise.all([
      this.rows(this.client.from('cal_social_accounts').select('*').order('platform'), fallback),
      this.allRows(() => this.client.from('cal_social_posts').select('*').order('posted_at', { ascending: false }).order('media_id'), fallback),
      this.allRows(() => this.client.from('cal_social_account_days').select('platform, day, followers').order('day').order('platform'), fallback)
    ]);
    return {
      accounts: accounts.map(rowToAccount),
      posts: posts.map(rowToSocial),
      followers: followers.map((f) => ({ platform: f.platform, day: f.day, followers: num(f.followers) }))
    };
  }

  // Starts a Connect and returns where to send the browser: the calendar-social Edge Function, which
  // goes on to Instagram or Threads and comes back to returnTo.
  async socialConnect(platform, returnTo) {
    const state = await this.rpc('cal_social_connect_start', { p_platform: platform, p_return: returnTo });
    return { url: `${this.config.supabaseUrl.replace(/\/+$/, '')}/functions/v1/calendar-social/connect?state=${encodeURIComponent(state)}` };
  }

  async socialDisconnect(platform) {
    await this.rpc('cal_social_disconnect', { p_platform: platform });
  }

  // {ok, message}
  async socialSyncNow() {
    return this.rpc('cal_social_sync_now');
  }

  // postId matches the platform post to that calendar post; null marks it as not on the calendar;
  // auto goes back to matching by date.
  async socialSetMatch(platform, mediaId, postId, auto = false) {
    await this.rpc('cal_social_set_match', { p_platform: platform, p_media_id: mediaId, p_post_id: postId || null, p_auto: !!auto });
  }
}
