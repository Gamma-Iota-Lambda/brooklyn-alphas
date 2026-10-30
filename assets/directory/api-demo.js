// Demo mode: runs when assets/calendar/config.js has no Supabase settings. Sample brothers (not real
// people) live in this browser's localStorage. The demo bar switches between the media team, a
// brother, and a visitor. The rules match the database's (rules.js).

import { checkFields, checkDates, DEFAULTS, fullName, render, sameDay, yearsBetween, todayISO, iso } from './rules.js';

const KEY = 'gildir-demo:v1';
const ROLE_KEY = 'gildir-demo:role';
const ROLES = ['staff', 'member', 'visitor'];

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private window: keep in memory */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } }
};

const uid = () => `demo-${Math.random().toString(36).slice(2, 10)}`;
const stamp = () => new Date().toISOString();
const clone = (x) => JSON.parse(JSON.stringify(x));
const DEMO_BROTHER = { member_id: 'demo-brother', name: 'Example Brother', committee: '' };
const DEMO_STAFF_EMAIL = 'media@example.org';

// Dates relative to today, so the demo always has something coming up.
const shift = (years, days) => { const d = new Date(); d.setFullYear(d.getFullYear() - years); d.setDate(d.getDate() + days); return iso(d); };

function sampleBrothers() {
  const b = (o) => ({
    id: uid(), member_id: null, first_name: '', middle_name: null, last_name: '', suffix: null, status: 'current', life_member: false,
    active: null, email: null, phone: null, phone_alt: null, address: null, city: 'Brooklyn', state: 'NY', zip: null, birth_date: null,
    crossing_date: null, initiation_chapter: null, emergency_contact_name: null, emergency_contact_phone: null, share_contact: true,
    greetings: true, pending: false, notes: null, created_at: stamp(), updated_at: stamp(), ...o
  });
  return [
    b({ first_name: 'Example', last_name: 'Brother', phone: '7185550100', email: 'brother@example.org', address: '1 Example Pl', zip: '11216', birth_date: shift(36, 0), crossing_date: shift(4, 0), notes: 'Example record for the demo. Sign in as a brother and claim it with the digits 0100.' }),
    b({ first_name: 'Marcus', last_name: 'Bell', phone: '7185550101', email: 'marcus@example.org', address: '12 Hancock St', zip: '11216', birth_date: shift(38, 1), crossing_date: shift(10, 1), initiation_chapter: 'Gamma Iota Lambda' }),
    b({ first_name: 'Andre', last_name: 'Pierre', suffix: 'Jr.', life_member: true, phone: '3475550102', email: 'andre@example.org', birth_date: shift(50, 3), crossing_date: shift(30, 12), initiation_chapter: 'Eta Chapter', city: 'Jamaica', zip: '11436' }),
    b({ first_name: 'Calvin', last_name: 'Reed', status: 'not-current', phone: '9175550103', crossing_date: shift(16, 1), city: 'Hempstead' }),
    b({ first_name: 'Walter', last_name: 'Greene', status: 'deceased', life_member: true, birth_date: '1940-10-30', crossing_date: '1961-10-30', city: 'Hempstead' }),
    b({ first_name: 'Theo', last_name: 'Mason', email: 'theo@example.org', share_contact: false, phone: '7185550105', birth_date: shift(34, 2), crossing_date: shift(6, 40) }),
    b({ first_name: 'Darnell', last_name: 'Okafor', phone: '6465550106', email: 'darnell@example.org', birth_date: shift(29, 20), crossing_date: shift(2, 7), address: '77 Willoughby Ave', zip: '11206' }),
    b({ first_name: 'Isaiah', middle_name: 'R', last_name: 'Vance', phone: '7185550107', crossing_date: shift(22, 60), city: 'Union', state: 'NJ', zip: '07083' }),
    b({ first_name: 'Kwame', last_name: 'Boateng', status: 'not-current', phone: '5165550108', crossing_date: shift(40, 100), city: 'Westbury' }),
    b({ first_name: 'Samuel', last_name: 'Lindo', life_member: true, phone: '9175550109', email: 'samuel@example.org', birth_date: shift(62, 15), crossing_date: shift(41, 5), initiation_chapter: 'Gamma Iota Lambda' }),
    b({ first_name: 'Rafael', last_name: 'Duarte', phone: '3475550110', birth_date: shift(31, 45), crossing_date: shift(3, 1), pending: true, notes: 'Added himself from the directory page; confirm at the next meeting.' }),
    b({ first_name: 'Elijah', last_name: 'Thorne', phone: '7185550111', email: 'elijah@example.org', birth_date: shift(44, -2), crossing_date: shift(20, -2), greetings: false })
  ];
}

function fresh() {
  return { brothers: sampleBrothers(), messages: [], settings: { greetings_on: true, digest_on: true, from: 'Gamma Iota Lambda <brothers@mail.gil1906.org>', ...DEFAULTS } };
}

export class DemoApi {
  constructor() {
    this.mode = 'demo';
    this.role = ROLES.includes(store.get(ROLE_KEY, '')) ? store.get(ROLE_KEY, '') : 'staff';
    this.data = store.get(KEY, null) || fresh();
  }

  async init() {}
  persist() { store.set(KEY, this.data); }
  setRole(role) { this.role = ROLES.includes(role) ? role : 'visitor'; store.set(ROLE_KEY, this.role); }
  resetDemo() { this.data = fresh(); this.persist(); }
  account() { return this.role === 'staff' ? { email: DEMO_STAFF_EMAIL, anonymous: false } : this.role === 'member' ? { email: '', anonymous: true } : null; }
  isStaff() { return this.role === 'staff'; }
  signedIn() { return this.role !== 'visitor'; }

  async settings() {
    const s = { ready: true, email_ready: true, count: this.data.brothers.filter((b) => b.status !== 'deceased').length };
    if (!this.isStaff()) return s;
    const last = this.data.messages.filter((m) => m.kind !== 'test').map((m) => m.sent_at).sort().pop() || null;
    return { ...s, ...this.data.settings, last_run: last };
  }

  async whoami() {
    if (this.role === 'staff') return { role: 'staff', name: 'Example Media Team' };
    if (this.role === 'member') return { role: 'member', ...DEMO_BROTHER };
    return { role: 'visitor' };
  }

  // Sign-in in the demo just switches role.
  async join() { this.setRole('member'); return { role: 'member', ...DEMO_BROTHER }; }
  async rejoin() { this.setRole('member'); return { role: 'member', ...DEMO_BROTHER }; }
  async staffSignIn() { this.setRole('staff'); }
  async staffSignUp() { this.setRole('staff'); return { needsConfirm: false }; }
  async claimStaff() { this.setRole('staff'); return { role: 'staff', name: 'Example Media Team' }; }
  async signOut() { this.setRole('visitor'); }

  // ------------------------------------------------------------ records

  publicJson(b) {
    return {
      id: b.id, first_name: b.first_name, middle_name: b.middle_name, last_name: b.last_name, suffix: b.suffix, name: fullName(b),
      status: b.status, life_member: b.life_member, email: b.share_contact ? b.email : null, phone: b.share_contact ? b.phone : null,
      city: b.share_contact ? b.city : null, state: b.share_contact ? b.state : null,
      birthday: b.birth_date ? b.birth_date.slice(5) : null, crossing_date: b.crossing_date, initiation_chapter: b.initiation_chapter,
      years: yearsBetween(b.crossing_date), claimed: !!b.member_id, pending: b.pending
    };
  }
  privateJson(b) { return { ...this.publicJson(b), ...clone(b), name: fullName(b), years: yearsBetween(b.crossing_date), claimed: !!b.member_id }; }
  sorted() { return [...this.data.brothers].sort((a, b) => a.last_name.localeCompare(b.last_name, 'en', { sensitivity: 'base' }) || a.first_name.localeCompare(b.first_name, 'en', { sensitivity: 'base' })); }
  mine() { return this.data.brothers.find((b) => b.member_id === DEMO_BROTHER.member_id) || null; }
  find(id) { const b = this.data.brothers.find((x) => x.id === id); if (!b) throw new Error('That record is no longer in the directory.'); return b; }
  needStaff() { if (!this.isStaff()) throw new Error('Only the media team can do that.'); }

  apply(b, input, all) {
    const { fields, error } = checkFields(input, all);
    if (error) throw new Error(error);
    const next = { ...b, ...fields };
    const e = checkDates(next);
    if (e) throw new Error(e);
    Object.assign(b, next, { updated_at: stamp() });
    return b;
  }

  async list() {
    if (!this.signedIn()) throw new Error('Sign in with the chapter code to see the directory.');
    return this.sorted().map((b) => (this.isStaff() ? this.privateJson(b) : this.publicJson(b)));
  }

  async me() { const b = this.mine(); return b ? this.privateJson(b) : null; }

  async claim(id, check) {
    if (this.role !== 'member') throw new Error('Sign in with the chapter code first.');
    if (this.mine()) throw new Error('You already have a record. Open My record to change it.');
    const b = this.find(id);
    if (b.member_id) throw new Error('Someone already claimed this record. If it is yours, ask the media team to fix it.');
    if (!b.phone && !b.phone_alt) throw new Error('There is no phone number on file for this record, so the media team needs to link it to you. Ask them.');
    const c = String(check || '').replace(/\D/g, '');
    if (!/^\d{4}$/.test(c) || ((b.phone || '').slice(-4) !== c && (b.phone_alt || '').slice(-4) !== c)) {
      throw new Error('Those digits do not match the phone number on file. If your number changed, ask the media team to link the record for you.');
    }
    b.member_id = DEMO_BROTHER.member_id; b.updated_at = stamp();
    this.persist();
    return this.privateJson(b);
  }

  async addSelf(input) {
    if (this.role !== 'member') throw new Error('Sign in with the chapter code first.');
    if (this.mine()) throw new Error('You already have a record. Open My record to change it.');
    const base = { id: uid(), member_id: DEMO_BROTHER.member_id, status: 'current', life_member: false, active: null, share_contact: true, greetings: true, pending: true, notes: null, created_at: stamp() };
    const b = this.apply(base, input, false);
    if (!b.first_name || !b.last_name) throw new Error('Add a first and last name.');
    if (this.data.brothers.some((x) => !x.member_id && x.first_name.toLowerCase() === b.first_name.toLowerCase() && x.last_name.toLowerCase() === b.last_name.toLowerCase())) {
      throw new Error('A record with your name is already in the directory. Claim it instead of adding a new one.');
    }
    this.data.brothers.push(b); this.persist();
    return this.privateJson(b);
  }

  async updateMe(input) {
    const b = this.mine();
    if (!b) throw new Error('Claim your record first.');
    this.apply(b, input, false); this.persist();
    return this.privateJson(b);
  }

  // ------------------------------------------------------------ media team

  async save(id, input) {
    this.needStaff();
    if (id) { const b = this.apply(this.find(id), input, true); this.persist(); return this.privateJson(b); }
    const base = { id: uid(), member_id: null, status: 'current', life_member: false, active: null, share_contact: true, greetings: true, pending: false, notes: null, created_at: stamp() };
    const b = this.apply(base, input, true);
    if (!b.first_name || !b.last_name) throw new Error('Add a first and last name.');
    this.data.brothers.push(b); this.persist();
    return this.privateJson(b);
  }

  async remove(id) { this.needStaff(); this.find(id); this.data.brothers = this.data.brothers.filter((b) => b.id !== id); this.persist(); }

  async link(id, memberId) {
    this.needStaff();
    const b = this.find(id);
    if (memberId && this.data.brothers.some((x) => x.member_id === memberId && x.id !== id)) throw new Error('That sign-in is already linked to another record. Unlink it there first.');
    b.member_id = memberId || null; b.updated_at = stamp(); this.persist();
    return this.privateJson(b);
  }

  async importRows(rows) {
    this.needStaff();
    let added = 0, updated = 0;
    rows.forEach((r, i) => {
      try {
        const cur = this.data.brothers.find((x) => x.first_name.toLowerCase() === String(r.first_name || '').trim().toLowerCase()
          && x.last_name.toLowerCase() === String(r.last_name || '').trim().toLowerCase() && (x.suffix || '').toLowerCase() === String(r.suffix || '').trim().toLowerCase());
        if (cur) { const { first_name, last_name, suffix, ...rest } = r; this.apply(cur, rest, true); updated += 1; } else {
          const base = { id: uid(), member_id: null, status: 'current', life_member: false, active: null, share_contact: true, greetings: true, pending: false, notes: null, created_at: stamp() };
          const b = this.apply(base, r, true);
          if (!b.first_name || !b.last_name) throw new Error('Add a first and last name.');
          this.data.brothers.push(b); added += 1;
        }
      } catch (e) { throw new Error(`Row ${i + 1}: ${e.message}`); }
    });
    this.persist();
    return { added, updated };
  }

  async memberList() {
    this.needStaff();
    return [{ id: DEMO_BROTHER.member_id, name: DEMO_BROTHER.name, committee: '', chair: false, lastSeenAt: stamp() },
      { id: 'demo-chair', name: 'Example Chair', committee: 'Education', chair: true, lastSeenAt: stamp() }];
  }

  async setSettings(fields) {
    this.needStaff();
    for (const [k, v] of Object.entries(fields || {})) {
      if (k === 'greetings_on' || k === 'digest_on') this.data.settings[k] = !!v;
      else if (k in DEFAULTS) this.data.settings[k] = String(v || '').trim() || DEFAULTS[k];
      else if (k === 'from') {
        const s = String(v || '').trim();
        if (s && !/^([^<>@]+<)?[^<>@\s]+@[^<>@\s]+\.[^<>@\s]+>?$/.test(s)) throw new Error('Use a sender like Gamma Iota Lambda <brothers@mail.gil1906.org>.');
        this.data.settings.from = s || 'Gamma Iota Lambda <brothers@mail.gil1906.org>';
      }
    }
    this.persist();
    return this.settings();
  }

  async preview(kind, subject, text) {
    this.needStaff();
    const b = { first_name: 'Charles', last_name: 'Wesley', crossing_date: shift(10, 0), birth_date: shift(35, 0) };
    return { subject: render(subject || DEFAULTS[`${kind}_subject`], b), text: render(text || DEFAULTS[`${kind}_text`], b) };
  }

  async sendTest(kind) {
    this.needStaff();
    const b = { first_name: 'Sample', last_name: 'Brother', crossing_date: shift(10, 0), birth_date: shift(35, 0) };
    const subject = render(this.data.settings[`${kind}_subject`], b);
    this.data.messages.unshift({ id: uid(), brother_id: null, kind: 'test', day: todayISO(), sent_to: DEMO_STAFF_EMAIL, subject, sent_at: stamp() });
    this.persist();
    return { to: DEMO_STAFF_EMAIL, subject, text: render(this.data.settings[`${kind}_text`], b) };
  }

  // The morning run, as the database does it: each brother once per kind and day, then a note to
  // the media team about tomorrow.
  async runNow() {
    this.needStaff();
    const day = todayISO();
    let sent = 0, skipped = 0, digest = false;
    const s = this.data.settings;
    const sentAlready = (b, kind, d) => this.data.messages.some((m) => m.brother_id === b.id && m.kind === kind && m.day === d);
    if (s.greetings_on) {
      for (const b of this.sorted()) {
        if (b.status === 'deceased') continue;
        const kinds = [];
        if (sameDay(b.birth_date, day)) kinds.push('birthday');
        if (sameDay(b.crossing_date, day) && yearsBetween(b.crossing_date, day) >= 1) kinds.push('anniversary');
        for (const kind of kinds) {
          if (!b.greetings || !b.email || sentAlready(b, kind, day)) { skipped += 1; continue; }
          this.data.messages.unshift({ id: uid(), brother_id: b.id, kind, day, sent_to: b.email, subject: render(s[`${kind}_subject`], b, day), sent_at: stamp() });
          sent += 1;
        }
      }
    }
    const t = new Date(); t.setDate(t.getDate() + 1); const tomorrow = iso(t);
    if (s.digest_on && !this.data.messages.some((m) => m.kind === 'digest' && m.day === tomorrow)) {
      const n = this.sorted().filter((b) => b.status !== 'deceased' && (sameDay(b.birth_date, tomorrow) || (sameDay(b.crossing_date, tomorrow) && yearsBetween(b.crossing_date, tomorrow) >= 1))).length;
      if (n) {
        this.data.messages.unshift({ id: uid(), brother_id: null, kind: 'digest', day: tomorrow, sent_to: DEMO_STAFF_EMAIL, subject: `Tomorrow: ${n === 1 ? '1 brother' : `${n} brothers`} to celebrate`, sent_at: stamp() });
        digest = true;
      }
    }
    this.persist();
    return { day, sent, skipped, digest };
  }

  async messages() {
    this.needStaff();
    return this.data.messages.map((m) => ({ id: m.id, brotherId: m.brother_id || '', kind: m.kind, day: m.day, sentTo: m.sent_to, subject: m.subject, sentAt: m.sent_at }));
  }
}
