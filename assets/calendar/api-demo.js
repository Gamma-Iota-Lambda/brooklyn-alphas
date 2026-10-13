// Demo mode: runs when assets/calendar/config.js has no Supabase settings.
// Posts load from demo-posts.json; every change stays in this browser's localStorage, and attached
// files stay in this tab only. The demo bar lets you view the page as the media team, a committee
// chair, a brother, or a visitor. The rules match the database's.

import { safeFileName } from './api-live.js';

const KEY = 'gilcal-demo:v2';
const ROLE_KEY = 'gilcal-demo:role';
const ROLES = ['staff', 'chair', 'member', 'visitor'];

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private window: keep in memory */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } }
};

const isoOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const todayISO = () => isoOf(new Date());
const addDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return isoOf(d); };
const uid = (p) => `${p}-${Math.random().toString(36).slice(2, 10)}`;
const stamp = () => new Date().toISOString();
const clone = (x) => JSON.parse(JSON.stringify(x));

// The two people the demo signs you in as.
const DEMO_CHAIR = { member_id: 'demo-chair', name: 'Example Chair', committee: 'Education' };
const DEMO_BROTHER = { member_id: 'demo-brother', name: 'Example Brother', committee: '' };

// Files attached in the demo live only in this tab, as object URLs.
const blobs = new Map();

function exampleRequests() {
  return [
    {
      id: 'demo-request-1', title: 'Example: Wine and Chill flyer', contactName: 'Example Social Chair',
      committee: 'Social & Fundraising', postDate: addDays(30), eventDate: addDays(36),
      about: 'Example request for the demo. Promote the December Wine and Chill and the toy drive.',
      format: 'flyer', platforms: ['instagram', 'threads'], program: '', assetLink: 'https://drive.google.com/',
      caption: '', link: '', youth: false, releases: false, files: [], status: 'new', reviewNote: '', postId: '',
      memberId: 'demo-chair-2', createdAt: stamp(), updatedAt: stamp()
    },
    {
      id: 'demo-request-2', title: 'Example: Alpha Academy recap', contactName: DEMO_CHAIR.name,
      committee: 'Education', postDate: addDays(10), eventDate: '', about: 'Example short-notice request from the demo chair.',
      format: 'carousel', platforms: ['instagram'], program: 'college', assetLink: '', caption: '', link: '',
      youth: true, releases: true, files: [], status: 'needs-info', reviewNote: 'Example note: send three curated photos.',
      postId: '', memberId: DEMO_CHAIR.member_id, createdAt: stamp(), updatedAt: stamp()
    }
  ];
}

function exampleMembers() {
  const base = { createdAt: stamp(), lastSeenAt: stamp(), locked: false, signedIn: true };
  return [
    { ...base, id: DEMO_CHAIR.member_id, name: DEMO_CHAIR.name, committee: 'Education', chair: true, requests: 1 },
    { ...base, id: 'demo-chair-2', name: 'Example Social Chair', committee: 'Social & Fundraising', chair: true, requests: 1 },
    { ...base, id: DEMO_BROTHER.member_id, name: DEMO_BROTHER.name, committee: '', chair: false, requests: 0 }
  ];
}

export class DemoApi {
  constructor() {
    this.mode = 'demo';
    this.state = null;
    const role = store.get(ROLE_KEY, 'staff');
    this.role = ROLES.includes(role) ? role : 'staff';
  }

  async init() {
    let state = store.get(KEY, null);
    if (!state || !Array.isArray(state.posts)) {
      const res = await fetch(new URL('./demo-posts.json', import.meta.url));
      const posts = await res.json();
      state = { posts, requests: exampleRequests(), members: exampleMembers() };
    }
    if (state.brother) Object.assign(DEMO_BROTHER, state.brother);
    this.state = state;
    this.save();
  }

  save() { store.set(KEY, this.state); }

  reset() {
    store.del(KEY);
    store.del(ROLE_KEY);
  }

  setRole(role) {
    this.role = ROLES.includes(role) ? role : 'visitor';
    store.set(ROLE_KEY, this.role);
  }

  async settings() { return { lead_days: 21, ready: true }; }

  async whoami() {
    if (this.role === 'staff') return { role: 'staff', name: 'Media team (demo)' };
    if (this.role === 'chair') return { role: 'chair', ...DEMO_CHAIR };
    if (this.role === 'member') return { role: 'member', ...DEMO_BROTHER };
    return { role: 'visitor' };
  }

  // The email login behind the session, if any. Live mode uses it for the media team's claim step.
  account() {
    return this.role === 'staff' ? { email: 'media@example.org', anonymous: false } : null;
  }

  requireStaff() { if (this.role !== 'staff') throw new Error('Only the media team can do that.'); }

  requireChair() {
    if (this.role === 'staff' || this.role === 'chair') return;
    if (this.role === 'member') throw new Error('Requests come from committee chairs. Ask your chair to send it, or ask the media team to set you up as a chair.');
    throw new Error('Sign in as a committee chair to send a request.');
  }

  // Mirrors row level security: signed-in brothers see posts; chairs and the media team see requests.
  async posts() { return this.role === 'visitor' ? [] : clone(this.state.posts); }

  async requests() { return this.role === 'staff' || this.role === 'chair' ? clone(this.state.requests) : []; }

  // Any chapter code works in the demo; the name and PIN rules match the database. Signs in as a brother.
  async join({ code, name, committee, pin }) {
    const clean = String(name || '').trim().replace(/\s+/g, ' ');
    if (!String(code || '').trim()) throw new Error('That chapter code is not right. Check it with the media team.');
    if (clean.length < 2 || clean.length > 40 || /[<>]/.test(clean)) throw new Error('Use 2 to 40 characters for your name.');
    if (!/^\d{4,6}$/.test(pin || '')) throw new Error('Your PIN must be 4 to 6 digits.');
    this.setRole('member');
    DEMO_BROTHER.name = clean;
    DEMO_BROTHER.committee = committee || '';
    this.state.brother = { name: DEMO_BROTHER.name, committee: DEMO_BROTHER.committee };
    const listed = this.state.members.find((m) => m.id === DEMO_BROTHER.member_id);
    if (listed) Object.assign(listed, { name: DEMO_BROTHER.name, committee: DEMO_BROTHER.committee, lastSeenAt: stamp(), signedIn: true });
    else this.state.members.push({ id: DEMO_BROTHER.member_id, name: DEMO_BROTHER.name, committee: DEMO_BROTHER.committee, chair: false, createdAt: stamp(), lastSeenAt: stamp(), requests: 0, locked: false, signedIn: true });
    this.save();
    return { role: 'member', ...DEMO_BROTHER };
  }

  async rejoin({ name, pin }) { return this.join({ code: 'demo', name, pin, committee: DEMO_BROTHER.committee }); }

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

  myFolder() { return this.role === 'chair' ? DEMO_CHAIR.member_id : 'staff'; }

  checkFiles(files) {
    if ((files || []).length > 10) throw new Error('Attach up to 10 files. For more, share a Google Drive link.');
    if (this.role === 'chair' && (files || []).some((f) => String(f.path).split('/')[1] !== DEMO_CHAIR.member_id)) {
      throw new Error('Attach files with this form\'s upload button.');
    }
  }

  async submitRequest(q) {
    this.requireChair();
    if (q.postDate < todayISO()) throw new Error('That post date has passed. Choose a future date.');
    this.checkFiles(q.files);
    const r = {
      ...clone(q), files: clone(q.files || []), id: uid('demo-request'), status: 'new', reviewNote: '', postId: '',
      memberId: this.role === 'chair' ? DEMO_CHAIR.member_id : '', createdAt: stamp(), updatedAt: stamp()
    };
    this.state.requests.push(r);
    this.save();
    return clone(r);
  }

  async updateRequest(id, q) {
    this.requireChair();
    const r = this.state.requests.find((x) => x.id === id);
    if (!r) throw new Error('That request no longer exists.');
    if (this.role !== 'staff' && r.memberId !== DEMO_CHAIR.member_id) throw new Error('You can edit only your own requests.');
    if (this.role !== 'staff' && !['new', 'needs-info'].includes(r.status)) throw new Error('The media team already reviewed this request. Send a new request for changes.');
    if (q.postDate < todayISO() && q.postDate !== r.postDate) throw new Error('That post date has passed. Choose a future date.');
    this.checkFiles(q.files);
    Object.assign(r, clone(q), { files: clone(q.files || []), status: r.status === 'needs-info' && this.role !== 'staff' ? 'new' : r.status, updatedAt: stamp() });
    this.save();
    return clone(r);
  }

  // ------------------------------------------------------------ files (this tab only)

  async uploadFile(file, folder) {
    if (this.role !== 'staff' && this.role !== 'chair') throw new Error('Only committee chairs and the media team can attach files.');
    if (file.size > 50 * 1024 * 1024) throw new Error('That file is over 50 MB. For large videos, share a Google Drive link instead.');
    const path = `requests/${folder || this.myFolder()}/${uid('f').slice(2)}-${safeFileName(file.name)}`;
    blobs.set(path, URL.createObjectURL(file));
    return { path, name: String(file.name || 'file').slice(0, 200), size: file.size, type: file.type || '' };
  }

  async removeFiles(paths) {
    for (const p of paths) {
      const url = blobs.get(p);
      if (url) URL.revokeObjectURL(url);
      blobs.delete(p);
    }
  }

  async fileUrls(paths) {
    const mine = (p) => this.role === 'staff' || (this.role === 'chair' && String(p).split('/')[1] === DEMO_CHAIR.member_id);
    return Object.fromEntries(paths.filter((p) => blobs.has(p) && mine(p)).map((p) => [p, blobs.get(p)]));
  }

  // ------------------------------------------------------------ media team

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
    return clone(isNew ? p : this.state.posts.find((x) => x.id === post.id));
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

  async setChair(memberId, chair, committee) {
    this.requireStaff();
    const m = this.state.members.find((x) => x.id === memberId);
    if (!m) throw new Error('That brother is no longer on the list.');
    if (chair && !(committee || m.committee)) throw new Error('Choose the committee he chairs.');
    Object.assign(m, { chair: !!chair, committee: committee || m.committee });
    this.save();
    return { role: m.chair ? 'chair' : 'member', name: m.name, member_id: m.id, committee: m.committee };
  }

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

  async setChapterCode(code) { this.requireStaff(); if ((code || '').trim().length < 6) throw new Error('Use a chapter code of at least 6 characters.'); }
}
