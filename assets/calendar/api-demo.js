// Demo mode: runs when assets/calendar/config.js has no Supabase settings.
// Posts load from demo-posts.json; every change stays in this browser's localStorage.
// The demo bar lets you view the page as the media team, a brother, or a visitor.

const KEY = 'gilcal-demo:v1';
const ROLE_KEY = 'gilcal-demo:role';

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private window: keep in memory */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } }
};

const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const addDays = (n) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const uid = (p) => `${p}-${Math.random().toString(36).slice(2, 10)}`;
const stamp = () => new Date().toISOString();
const clone = (x) => JSON.parse(JSON.stringify(x));

const DEMO_MEMBER = { member_id: 'demo-member', name: 'Example Brother', committee: 'Education' };

function exampleRequests() {
  return [
    {
      id: 'demo-request-1', title: 'Example: Wine and Chill flyer', contactName: 'Example Chair',
      committee: 'Social & Fundraising', postDate: addDays(30), eventDate: addDays(36),
      about: 'Example request for the demo. Promote the December Wine and Chill and the toy drive.',
      format: 'flyer', platforms: ['instagram', 'facebook'], program: '', assetLink: 'https://drive.google.com/',
      caption: '', link: '', youth: false, releases: false, status: 'new', reviewNote: '', postId: '',
      memberId: 'demo-other', createdAt: stamp(), updatedAt: stamp()
    },
    {
      id: 'demo-request-2', title: 'Example: Alpha Academy recap', contactName: DEMO_MEMBER.name,
      committee: 'Education', postDate: addDays(10), eventDate: '', about: 'Example short-notice request from the demo brother.',
      format: 'carousel', platforms: ['instagram'], program: 'college', assetLink: '', caption: '', link: '',
      youth: true, releases: true, status: 'needs-info', reviewNote: 'Example note: send three curated photos.',
      postId: '', memberId: DEMO_MEMBER.member_id, createdAt: stamp(), updatedAt: stamp()
    }
  ];
}

function exampleMembers() {
  return [
    { id: 'demo-member', name: DEMO_MEMBER.name, committee: 'Education', createdAt: stamp(), lastSeenAt: stamp(), requests: 1, locked: false, signedIn: true },
    { id: 'demo-other', name: 'Example Chair', committee: 'Social & Fundraising', createdAt: stamp(), lastSeenAt: stamp(), requests: 1, locked: false, signedIn: true }
  ];
}

export class DemoApi {
  constructor() {
    this.mode = 'demo';
    this.state = null;
    this.role = store.get(ROLE_KEY, 'staff');
  }

  async init() {
    let state = store.get(KEY, null);
    if (!state || !Array.isArray(state.posts)) {
      const res = await fetch(new URL('./demo-posts.json', import.meta.url));
      const posts = await res.json();
      state = { posts, requests: exampleRequests(), members: exampleMembers(), public: false };
    }
    if (state.me) Object.assign(DEMO_MEMBER, state.me);
    this.state = state;
    this.save();
  }

  save() { store.set(KEY, this.state); }

  reset() {
    store.del(KEY);
    store.del(ROLE_KEY);
  }

  setRole(role) {
    this.role = role;
    store.set(ROLE_KEY, role);
  }

  async settings() { return { public: !!this.state.public, lead_days: 21, ready: true }; }

  async whoami() {
    if (this.role === 'staff') return { role: 'staff', name: 'Media team (demo)' };
    if (this.role === 'member') return { role: 'member', ...DEMO_MEMBER };
    return { role: 'visitor' };
  }

  // The email login behind the session, if any. Live mode uses it for the media team's claim step.
  account() {
    return this.role === 'staff' ? { email: 'media@example.org', anonymous: false } : null;
  }

  requireStaff() { if (this.role !== 'staff') throw new Error('Only the media team can do that.'); }

  // Mirrors row level security: visitors get the public columns only while the calendar is public.
  async posts({ full }) {
    if (this.role === 'visitor' && !this.state.public) return [];
    const posts = clone(this.state.posts);
    if (full && this.role !== 'visitor') return posts;
    const keep = ['id', 'date', 'title', 'category', 'program', 'format', 'platforms', 'status', 'committee', 'concept', 'eventDate', 'link'];
    return posts.map((p) => Object.fromEntries(keep.map((k) => [k, p[k] ?? ''])));
  }

  async requests() { return this.role === 'visitor' ? [] : clone(this.state.requests); }

  // Any chapter code works in the demo; the name and PIN rules match the database.
  async join({ code, name, committee, pin }) {
    const clean = String(name || '').trim().replace(/\s+/g, ' ');
    if (!String(code || '').trim()) throw new Error('That chapter code is not right. Check it with the media team.');
    if (clean.length < 2 || clean.length > 40 || /[<>]/.test(clean)) throw new Error('Use 2 to 40 characters for your name.');
    if (!/^\d{4,6}$/.test(pin || '')) throw new Error('Your PIN must be 4 to 6 digits.');
    this.setRole('member');
    DEMO_MEMBER.name = clean;
    DEMO_MEMBER.committee = committee || '';
    this.state.me = { name: DEMO_MEMBER.name, committee: DEMO_MEMBER.committee };
    const listed = this.state.members.find((m) => m.id === DEMO_MEMBER.member_id);
    if (listed) Object.assign(listed, { name: DEMO_MEMBER.name, committee: DEMO_MEMBER.committee, lastSeenAt: stamp(), signedIn: true });
    else this.state.members.push({ id: DEMO_MEMBER.member_id, name: DEMO_MEMBER.name, committee: DEMO_MEMBER.committee, createdAt: stamp(), lastSeenAt: stamp(), requests: 0, locked: false, signedIn: true });
    this.save();
    return { role: 'member', ...DEMO_MEMBER };
  }

  async rejoin({ name, pin }) { return this.join({ code: 'demo', name, pin, committee: DEMO_MEMBER.committee }); }

  async staffSignIn(email, password) {
    if (!email || !password) throw new Error('Enter your email and password.');
    this.setRole('staff');
  }
  async staffSignUp(email, password) {
    if (!email || !password) throw new Error('Enter your email and password.');
    this.setRole('staff');
    return { needsConfirm: false };
  }
  async claimStaff(_code, name) { this.setRole('staff'); return { role: 'staff', name }; }
  async signOut() { this.setRole('visitor'); }

  async submitRequest(q) {
    if (this.role === 'visitor') throw new Error('Sign in with the chapter code to send a request.');
    if (q.postDate < todayISO()) throw new Error('That post date has passed. Choose a future date.');
    const r = { ...clone(q), id: uid('demo-request'), status: 'new', reviewNote: '', postId: '', memberId: this.role === 'member' ? DEMO_MEMBER.member_id : '', createdAt: stamp(), updatedAt: stamp() };
    this.state.requests.push(r);
    this.save();
    return clone(r);
  }

  async updateRequest(id, q) {
    const r = this.state.requests.find((x) => x.id === id);
    if (!r) throw new Error('That request no longer exists.');
    if (this.role !== 'staff' && r.memberId !== DEMO_MEMBER.member_id) throw new Error('You can edit only your own requests.');
    if (this.role !== 'staff' && !['new', 'needs-info'].includes(r.status)) throw new Error('The media team already reviewed this request. Send a new request for changes.');
    if (q.postDate < todayISO() && q.postDate !== r.postDate) throw new Error('That post date has passed. Choose a future date.');
    Object.assign(r, clone(q), { status: r.status === 'needs-info' && this.role !== 'staff' ? 'new' : r.status, updatedAt: stamp() });
    this.save();
    return clone(r);
  }

  async savePost(post, { isNew }) {
    this.requireStaff();
    const p = { ...clone(post), updatedAt: stamp() };
    if (isNew) {
      p.id = p.id || uid('p');
      p.requestId = p.requestId || '';
      p.createdAt = stamp();
      this.state.posts.push(p);
    } else {
      const i = this.state.posts.findIndex((x) => x.id === post.id);
      if (i < 0) throw new Error('That post no longer exists.');
      this.state.posts[i] = { ...this.state.posts[i], ...p };
    }
    this.save();
    return clone(p);
  }

  async setPostStatus(id, status) {
    this.requireStaff();
    const p = this.state.posts.find((x) => x.id === id);
    if (p) { p.status = status; p.updatedAt = stamp(); this.save(); }
  }

  async deletePost(id) {
    this.requireStaff();
    this.state.posts = this.state.posts.filter((x) => x.id !== id);
    for (const r of this.state.requests) if (r.postId === id) r.postId = '';
    this.save();
  }

  async reviewRequest(id, status, note) {
    this.requireStaff();
    const r = this.state.requests.find((x) => x.id === id);
    if (!r) throw new Error('That request no longer exists.');
    if (status !== 'new' && !note) throw new Error('Add a note for the chair.');
    Object.assign(r, { status, reviewNote: note || '', updatedAt: stamp() });
    this.save();
    return clone(r);
  }

  async approveRequest(id, post) {
    this.requireStaff();
    const r = this.state.requests.find((x) => x.id === id);
    if (!r) throw new Error('That request no longer exists.');
    if (r.status === 'approved' && r.postId) throw new Error('This request is already on the calendar.');
    const p = { ...clone(post), id: post.id || uid('p'), requestId: id, createdAt: stamp(), updatedAt: stamp() };
    this.state.posts.push(p);
    Object.assign(r, { status: 'approved', postId: p.id, reviewNote: '', updatedAt: stamp() });
    this.save();
    return clone(p);
  }

  async memberList() { this.requireStaff(); return clone(this.state.members); }
  async staffList() { this.requireStaff(); return [{ name: 'Media team (demo)', createdAt: stamp() }]; }
  async resetPin(memberId, pin) {
    this.requireStaff();
    if (!/^\d{4,6}$/.test(pin || '')) throw new Error('The new PIN must be 4 to 6 digits.');
    const m = this.state.members.find((x) => x.id === memberId);
    if (!m) throw new Error('That brother is no longer on the list.');
    m.locked = false;
    this.save();
  }

  // Requests stay, with the name on them, as in the database.
  async removeMember(memberId) {
    this.requireStaff();
    if (!this.state.members.some((m) => m.id === memberId)) throw new Error('That brother is no longer on the list.');
    this.state.members = this.state.members.filter((m) => m.id !== memberId);
    for (const r of this.state.requests) if (r.memberId === memberId) r.memberId = '';
    this.save();
  }
  async setPublic(on) { this.requireStaff(); this.state.public = !!on; this.save(); return this.settings(); }
  async setChapterCode(code) { this.requireStaff(); if ((code || '').trim().length < 6) throw new Error('Use a chapter code of at least 6 characters.'); }
}
