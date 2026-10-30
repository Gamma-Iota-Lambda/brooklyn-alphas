// Live mode: the brother directory on Supabase, in the same project as the content calendar.
// Needs the project URL and publishable key in assets/calendar/config.js (one project, one config).
// Brothers and the media team write only through database functions (supabase/migrations/
// 20261030000100_brother_directory.sql); the media team also reads dir_brothers and dir_messages
// directly under row level security.

const PAGE = 1000;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (window.supabase) return resolve();
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('The directory could not load its sign-in library. Check your connection and reload.'));
    document.head.appendChild(s);
  });
}

// Database functions raise messages written for people; pass those through and translate the rest.
function friendly(error, fallback = 'Something went wrong. Try again.') {
  const msg = (error && (error.message || error.error_description)) || '';
  if (!msg) return fallback;
  if (/Could not find the function public\.dir_|Could not find the table public\.dir_/i.test(msg)) {
    return 'The directory is not set up in the database yet. The media team needs to run supabase/migrations/20261030000100_brother_directory.sql.';
  }
  if (/row-level security/i.test(msg)) return 'Only the media team can change that.';
  if (/violates check constraint/i.test(msg)) return 'One of the fields is not in the expected format. Check the form and try again.';
  if (/permission denied/i.test(msg)) return 'Sign in to do that.';
  if (/Failed to fetch|NetworkError|network/i.test(msg)) return "Couldn't reach the directory. Check your connection and try again.";
  return msg;
}

export class LiveApi {
  constructor(config) {
    this.mode = 'live';
    this.config = config;
    this.client = null;
    this.session = null;
  }

  async init() {
    await loadScript(new URL('../calendar/vendor/supabase.js', import.meta.url).href);
    // The same storage key as the calendar, so one sign-in covers both pages.
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

  account() {
    const u = this.session && this.session.user;
    return u ? { email: u.email || '', anonymous: !!u.is_anonymous } : null;
  }

  async settings() {
    return this.rpc('dir_settings');
  }

  // {role: 'visitor' | 'member' | 'chair' | 'staff', name, member_id, committee}
  async whoami() {
    const me = await this.rpc('cal_whoami');
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
      if (/anonymous/i.test(error.message)) throw new Error('Brother sign-in is turned off. The media team needs to allow anonymous sign-ins in Supabase.');
      if (/rate limit/i.test(error.message)) throw new Error('Too many sign-ins from this network in the last hour. Wait a few minutes and try again.');
      throw new Error(friendly(error));
    }
    this.session = data.session;
  }

  // ------------------------------------------------------------ sign-in (shared with the calendar)

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

  // ------------------------------------------------------------ brothers

  async list() {
    return this.rpc('dir_list');
  }

  async me() {
    return this.rpc('dir_me');
  }

  async claim(id, check) {
    return this.rpc('dir_claim', { p_id: id, p_check: check });
  }

  async addSelf(fields) {
    return this.rpc('dir_add_self', { p: fields });
  }

  async updateMe(fields) {
    return this.rpc('dir_update_me', { p: fields });
  }

  // ------------------------------------------------------------ media team

  async save(id, fields) {
    return this.rpc('dir_save', { p_id: id || null, p: fields });
  }

  async remove(id) {
    await this.rpc('dir_delete', { p_id: id });
  }

  async link(id, memberId) {
    return this.rpc('dir_link', { p_id: id, p_member_id: memberId || null });
  }

  // {added, updated}
  async importRows(rows) {
    return this.rpc('dir_import', { p_rows: rows });
  }

  async memberList() {
    const rows = await this.rpc('cal_member_list');
    return rows.map((m) => ({ id: m.id, name: m.display_name, committee: m.committee || '', chair: !!m.chair, lastSeenAt: m.last_seen_at }));
  }

  async setSettings(fields) {
    return this.rpc('dir_set_settings', { p: fields });
  }

  async preview(kind, subject, text) {
    return this.rpc('dir_preview', { p_kind: kind, p_subject: subject || '', p_text: text || '' });
  }

  async sendTest(kind) {
    return this.rpc('dir_send_test', { p_kind: kind });
  }

  async runNow() {
    return this.rpc('dir_run_now');
  }

  async messages() {
    const rows = await this.rows(
      this.client.from('dir_messages').select('*').order('sent_at', { ascending: false }).limit(PAGE),
      'The message log could not load.'
    );
    return rows.map((m) => ({ id: m.id, brotherId: m.brother_id || '', kind: m.kind, day: m.day, sentTo: m.sent_to, subject: m.subject, sentAt: m.sent_at }));
  }
}
