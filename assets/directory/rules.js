// Shared rules for the brother directory: field cleaning and checks that mirror the database's
// (supabase/migrations/20261030000100_brother_directory.sql), date helpers, message templates,
// and the spreadsheet import mapping. The demo API and the page both use these; in live mode the
// database has the final say.

export const STATUSES = [
  { key: 'current', label: 'Current', desc: 'Financial with the chapter.' },
  { key: 'not-current', label: 'Not current', desc: 'On the roll, not financial this year.' },
  { key: 'deceased', label: 'Omega Chapter', desc: 'Entered Omega Chapter. Kept for the record; never emailed.' }
];
export const STATUS = Object.fromEntries(STATUSES.map((s) => [s.key, s]));

export const PLACEHOLDERS = [
  ['{first_name}', 'first name'], ['{name}', 'full name'], ['{years}', 'years since crossing, as a number'],
  ['{years_text}', '"1 year" or "12 years"'], ['{ordinal}', '"12th"'], ['{crossing_year}', 'the year he crossed'], ['{date}', "today's date"]
];

export const DEFAULTS = {
  birthday_subject: 'Happy birthday, Brother {first_name}',
  birthday_text: 'Happy birthday, Brother {first_name}.\n\nThe brothers of Gamma Iota Lambda celebrate you today. We hope the year ahead brings you good health, good company, and work that matters.\n\nEnjoy your day.\n\n06',
  anniversary_subject: 'Happy Alpha anniversary, Brother {first_name}: {years_text} in the bond',
  anniversary_text: 'Happy anniversary, Brother {first_name}.\n\nOn this day in {crossing_year} you crossed into Alpha Phi Alpha. That is {years_text} of brotherhood, scholarship, and service, and Gamma Iota Lambda is better for it.\n\nThank you for every one of them.\n\n06'
};

export const pad = (n) => String(n).padStart(2, '0');
export const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const parse = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || '')); return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null; };
export const todayISO = () => iso(new Date());
export const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
export const digits = (v) => { let d = String(v ?? '').replace(/\D/g, ''); if (d.length === 11 && d.startsWith('1')) d = d.slice(1); return d; };
export const fmtPhone = (d) => (d && /^\d{10}$/.test(d) ? `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}` : d || '');
export const fullName = (b) => [b.first_name, b.last_name, b.suffix].filter(Boolean).join(' ');
export const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

// Whole years from one date to another, the way Postgres's age() counts them.
export function yearsBetween(fromISO, onISO) {
  const a = parse(fromISO), b = parse(onISO || todayISO());
  if (!a || !b) return null;
  let y = b.getFullYear() - a.getFullYear();
  if (b.getMonth() < a.getMonth() || (b.getMonth() === a.getMonth() && b.getDate() < a.getDate())) y -= 1;
  return y;
}

const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

// True when the month and day of d fall on the day given. February 29 counts on February 28 in a
// year without one.
export function sameDay(dISO, dayISO) {
  const d = parse(dISO), t = parse(dayISO);
  if (!d || !t) return false;
  if (d.getMonth() === t.getMonth() && d.getDate() === t.getDate()) return true;
  return d.getMonth() === 1 && d.getDate() === 29 && t.getMonth() === 1 && t.getDate() === 28 && !isLeap(t.getFullYear());
}

// The next date on which a yearly date comes around, on or after fromISO.
export function nextOccurrence(dISO, fromISO) {
  const d = parse(dISO), f = parse(fromISO || todayISO());
  if (!d || !f) return '';
  for (let y = f.getFullYear(); y <= f.getFullYear() + 1; y += 1) {
    const md = d.getMonth() === 1 && d.getDate() === 29 && !isLeap(y) ? [1, 28] : [d.getMonth(), d.getDate()];
    const x = new Date(y, md[0], md[1]);
    if (x >= f) return iso(x);
  }
  return '';
}

export const ordinal = (n) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th'}`;

export function render(template, b, dayISO) {
  const years = yearsBetween(b.crossing_date, dayISO);
  const day = parse(dayISO || todayISO());
  return String(template || '')
    .replaceAll('{first_name}', b.first_name || '')
    .replaceAll('{name}', fullName(b))
    .replaceAll('{years}', years == null ? '' : String(years))
    .replaceAll('{years_text}', years == null ? '' : years === 1 ? '1 year' : `${years} years`)
    .replaceAll('{ordinal}', years == null ? '' : ordinal(years))
    .replaceAll('{crossing_year}', b.crossing_date ? b.crossing_date.slice(0, 4) : '')
    .replaceAll('{date}', day ? day.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : '');
}

// Cleans a form payload and returns {fields, error}. all: every field (the media team); otherwise
// only what a brother may change. Messages match the database's.
export function checkFields(input, all = false) {
  const f = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(input, k);
  const str = (k, fn = clean) => { if (has(k)) f[k] = fn(input[k]) || null; };
  str('first_name'); str('middle_name'); str('last_name'); str('suffix');
  str('email', (v) => clean(v).toLowerCase());
  str('phone', digits); str('phone_alt', digits);
  str('address'); str('city'); str('state', (v) => clean(v).toUpperCase());
  str('zip', (v) => String(v ?? '').replace(/\D/g, ''));
  str('initiation_chapter'); str('emergency_contact_name'); str('emergency_contact_phone', digits);
  if (has('share_contact')) f.share_contact = input.share_contact !== false && input.share_contact !== 'false';
  if (has('greetings')) f.greetings = input.greetings !== false && input.greetings !== 'false';
  for (const k of ['birth_date', 'crossing_date']) {
    if (!has(k)) continue;
    const v = clean(input[k]);
    if (v && !parse(v)) return { error: 'Use real dates, like 2024-03-23.' };
    f[k] = v || null;
  }
  if (all) {
    if (has('status')) f.status = input.status || 'current';
    if (has('life_member')) f.life_member = input.life_member === true || input.life_member === 'true';
    if (has('active')) f.active = input.active === '' || input.active == null ? null : input.active === true || input.active === 'true';
    if (has('pending')) f.pending = input.pending === true || input.pending === 'true';
    if (has('notes')) f.notes = String(input.notes ?? '').trim() || null;
  }
  const over = (k, n) => f[k] && f[k].length > n;
  if (has('first_name') && !f.first_name || has('last_name') && !f.last_name) return { error: 'Add a first and last name.' };
  if (over('first_name', 60) || over('last_name', 60) || over('middle_name', 60)) return { error: 'Keep each part of the name under 60 characters.' };
  if (over('suffix', 10)) return { error: 'Keep the suffix short, like Jr. or III.' };
  if (f.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.email)) return { error: 'That email address does not look right.' };
  for (const k of ['phone', 'phone_alt', 'emergency_contact_phone']) if (f[k] && !/^\d{10}$/.test(f[k])) return { error: 'Use a 10-digit phone number, like 718-555-0100.' };
  if (f.state && !/^[A-Z]{2}$/.test(f.state)) return { error: 'Use the two-letter state, like NY.' };
  if (f.zip && !/^\d{5}$/.test(f.zip)) return { error: 'Use a 5-digit ZIP code.' };
  if (over('address', 160) || over('city', 80)) return { error: 'Keep the address under 160 characters and the city under 80.' };
  const today = todayISO();
  if (f.birth_date && (f.birth_date > today || f.birth_date < '1900-01-01')) return { error: 'That birthdate is not possible.' };
  if (f.crossing_date && (f.crossing_date > today || f.crossing_date < '1906-12-04')) return { error: 'A crossing date falls between December 4, 1906 and today.' };
  if (f.status && !STATUS[f.status]) return { error: 'Choose a standing from the list.' };
  if (over('initiation_chapter', 80) || over('emergency_contact_name', 80)) return { error: 'Keep the chapter and contact names under 80 characters.' };
  if (over('notes', 2000)) return { error: 'Keep the notes under 2,000 characters.' };
  return { fields: f };
}

// The check that needs both dates, run against the merged record.
export function checkDates(b) {
  if (b.birth_date && b.crossing_date) {
    const a = parse(b.birth_date); a.setFullYear(a.getFullYear() + 16);
    if (parse(b.crossing_date) < a) return 'The birthdate and crossing date are less than 16 years apart. Check both.';
  }
  return '';
}

// ------------------------------------------------------------ spreadsheet import

// Reads CSV text into rows of strings. Handles quotes, commas and newlines inside quotes, and CRLF.
export function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  const s = String(text || '').replace(/^﻿/, '');
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (q) {
      if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i += 1; } else q = false; } else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i += 1;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim() !== ''));
}

// Column names the import understands, by their normalized header (letters and digits only).
const HEADERS = {
  lastname: 'last_name', firstname: 'first_name', middlename: 'middle_name', suffix: 'suffix', name: 'name',
  currentbros: 'status', status: 'status', standing: 'status', life: 'life_member', lifemember: 'life_member',
  email: 'email', emailaddress: 'email', address: 'address', street: 'address', citystate: 'city_state', city: 'city',
  state: 'state', zip: 'zip', zipcode: 'zip', phone: 'phone', phonealt: 'phone_alt', secondphone: 'phone_alt',
  visitingbrother: 'phone_alt', birthdate: 'birth_date', birthday: 'birth_date', crossingdate: 'crossing_date',
  crossed: 'crossing_date', initiationchapter: 'initiation_chapter', chapter: 'initiation_chapter',
  emergencycontact: 'emergency_contact_name', emergencycontactname: 'emergency_contact_name',
  phonenumber: 'emergency_contact_phone', emergencycontactphone: 'emergency_contact_phone', emergencyphone: 'emergency_contact_phone',
  notes: 'notes', sharecontact: 'share_contact', greetings: 'greetings', activeinactive: 'active', active: 'active', pending: 'pending'
};
const SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv']);
const normHeader = (h) => String(h || '').toLowerCase().replace(/\s*\d{4}\s*-\s*\d{4}/, '').replace(/[^a-z0-9]/g, '');
const titleSuffix = (s) => ({ jr: 'Jr.', sr: 'Sr.' }[s.toLowerCase()] || s.toUpperCase());

function readDate(v) {
  const s = clean(v);
  if (!s) return { value: '' };
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return { value: `${m[1]}-${pad(m[2])}-${pad(m[3])}` };
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/.exec(s);
  if (m) {
    let y = +m[3]; if (y < 100) y += y < 40 ? 2000 : 1900;
    const d = new Date(y, +m[1] - 1, +m[2]);
    if (d.getMonth() !== +m[1] - 1) return { value: '', note: `date "${s}" is not a real date` };
    return { value: iso(d), note: s === m[0] ? '' : `date "${s}" read as ${iso(d)}` };
  }
  m = /^(spr|sum|fal|win)[a-z]*\s*'?(\d{2,4})$/i.exec(s);
  if (m) { let y = +m[2]; if (y < 100) y += y < 40 ? 2000 : 1900; return { value: '', note: `crossing date in the sheet: ${{ spr: 'Spring', sum: 'Summer', fal: 'Fall', win: 'Winter' }[m[1].toLowerCase()]} ${y} (no exact day)` }; }
  if (/^\d{5}$/.test(s)) { const d = new Date(1899, 11, 30); d.setDate(d.getDate() + +s); return { value: iso(d), note: `date stored as the number ${s} in the sheet` }; }
  return { value: '', note: `date "${s}" could not be read` };
}

// Turns spreadsheet rows (first row headers) into import payloads plus notes about what was fixed.
// Returns {rows, notes: [[name, note]], unknown: [headers]}.
export function rowsFromSheet(table) {
  if (!table.length) return { rows: [], notes: [], unknown: [] };
  const cols = table[0].map((h) => HEADERS[normHeader(h)] || '');
  const unknown = table[0].filter((h, i) => h.trim() && !cols[i]);
  const rows = [], notes = [];
  for (const r of table.slice(1)) {
    const raw = {};
    cols.forEach((c, i) => { if (c && r[i] != null && String(r[i]).trim() !== '') raw[c] = raw[c] ? `${raw[c]} ${r[i]}` : r[i]; });
    if (raw.name && !raw.first_name) {
      const parts = clean(raw.name).split(' ');
      raw.first_name = parts.shift(); raw.last_name = parts.join(' ');
    }
    if (!raw.first_name && !raw.last_name) continue;
    const out = {};
    const rowNotes = [];
    // Names: a suffix at the end of the last name, a middle initial at the end of the first.
    let last = clean(raw.last_name), first = clean(raw.first_name);
    const lp = last.split(' ');
    if (lp.length > 1 && SUFFIXES.has(lp[lp.length - 1].toLowerCase().replace('.', ''))) { out.suffix = titleSuffix(lp.pop().replace('.', '')); last = lp.join(' '); }
    const fp = first.split(' ');
    if (fp.length > 1 && /^[A-Z]\.?$/.test(fp[fp.length - 1])) { out.middle_name = fp.pop().replace('.', ''); first = fp.join(' '); }
    out.first_name = first; out.last_name = last;
    if (raw.suffix) out.suffix = clean(raw.suffix);
    if (raw.middle_name) out.middle_name = clean(raw.middle_name);
    const name = `${first} ${last}`;
    if (raw.status != null) {
      const s = clean(raw.status).toLowerCase();
      out.status = { current: 'current', 'not current': 'not-current', 'not-current': 'not-current', deceased: 'deceased', omega: 'deceased', 'omega chapter': 'deceased' }[s] || '';
      if (!out.status) { rowNotes.push(`standing "${clean(raw.status)}" was not understood; set to current`); out.status = 'current'; }
    }
    if (raw.life_member != null) out.life_member = /^(x|y|yes|true|1|life)$/i.test(clean(raw.life_member));
    if (raw.active != null) {
      const a = clean(raw.active).toLowerCase();
      if (a === 'active' || a === 'yes') out.active = true;
      else if (a === 'inactive' || a === 'no') out.active = false;
      else if (a && a !== 'deceased') {
        // The old sheet held one emergency contact in this column.
        if (!raw.emergency_contact_name) { out.emergency_contact_name = clean(raw.active); rowNotes.push(`"${clean(raw.active)}" was in the Active/Inactive column and was read as the emergency contact`); }
        else rowNotes.push(`Active/Inactive column held "${clean(raw.active)}"`);
      }
    }
    for (const k of ['email', 'initiation_chapter', 'emergency_contact_name', 'notes', 'city', 'state', 'zip']) if (raw[k] != null) out[k] = clean(raw[k]);
    if (raw.address != null) {
      const a = clean(raw.address);
      if (/^[\d.]+$/.test(a)) rowNotes.push(`address "${a}" was left out`); else out.address = a;
    }
    if (raw.city_state != null) {
      let s = clean(raw.city_state);
      const apt = /^(Apt\.?\s*\S+)\s+(.*)$/i.exec(s);
      if (apt) { out.address = `${out.address || ''} ${apt[1]}`.trim(); s = apt[2]; }
      const z = /(\d{5})(?:-\d{4})?\s*$/.exec(s);
      if (z) { out.zip = z[1]; s = s.slice(0, z.index).trim(); }
      s = s.replace(/,\s*$/, '');
      const parts = s.split(',').map((x) => x.trim()).filter(Boolean);
      let city = s, state = '';
      if (parts.length >= 2) { city = parts[0]; state = parts[parts.length - 1]; } else {
        const t = s.split(' ');
        if (t.length >= 2 && /^[A-Za-z]{2}$/.test(t[t.length - 1])) { state = t.pop(); city = t.join(' '); }
      }
      const fix = { brroklyn: 'Brooklyn', jamacia: 'Jamaica', rockvillecentre: 'Rockville Centre', deerpark: 'Deer Park', ny: 'New York', 'mt. vernon': 'Mount Vernon' }[city.toLowerCase()];
      if (fix && fix !== city) { rowNotes.push(`city "${city}" read as ${fix}`); city = fix; }
      if (city) out.city = city;
      if (state) out.state = state.toUpperCase().slice(0, 2);
    }
    for (const k of ['phone', 'phone_alt', 'emergency_contact_phone']) {
      if (raw[k] == null) continue;
      const d = digits(String(raw[k]).replace(/\.0$/, ''));
      if (d.length === 10) out[k] = d; else rowNotes.push(`${k === 'phone' ? 'phone' : k === 'phone_alt' ? 'second phone' : 'emergency contact phone'} "${clean(raw[k])}" has ${d.length} digits and was left out`);
    }
    if (raw.crossing_date != null) { const d = readDate(raw.crossing_date); if (d.note) rowNotes.push(d.note); if (d.value) out.crossing_date = d.value; }
    if (raw.birth_date != null) {
      const d = readDate(raw.birth_date);
      if (d.note) rowNotes.push(d.note);
      if (d.value) {
        // A real birthdate makes the brother an adult by the time he crossed (or by now if unknown).
        const ref = out.crossing_date ? +out.crossing_date.slice(0, 4) : new Date().getFullYear();
        if (+d.value.slice(0, 4) + 17 <= ref) out.birth_date = d.value;
        else rowNotes.push(`the sheet's birthdate ${parse(d.value).toLocaleDateString('en-US')} looks like the day the row was entered and was left out`);
      }
    }
    if (raw.share_contact != null) out.share_contact = !/^(n|no|false|0)$/i.test(clean(raw.share_contact));
    if (raw.greetings != null) out.greetings = !/^(n|no|false|0)$/i.test(clean(raw.greetings));
    if (raw.pending != null) out.pending = /^(y|yes|true|1)$/i.test(clean(raw.pending));
    if (rowNotes.length) {
      out.notes = [out.notes, `Import ${new Date().toLocaleDateString('en-US')}: ${rowNotes.join('; ')}`].filter(Boolean).join('\n');
      for (const n of rowNotes) notes.push([name, n]);
    }
    rows.push(out);
  }
  return { rows, notes, unknown };
}

export const CSV_COLUMNS = [
  'first_name', 'middle_name', 'last_name', 'suffix', 'status', 'life_member', 'active', 'email', 'phone', 'phone_alt', 'address', 'city',
  'state', 'zip', 'birth_date', 'crossing_date', 'initiation_chapter', 'emergency_contact_name', 'emergency_contact_phone',
  'share_contact', 'greetings', 'pending', 'notes'
];

export function toCsv(rows, columns = CSV_COLUMNS) {
  const cell = (v) => { const s = v == null ? '' : String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [columns.join(','), ...rows.map((r) => columns.map((c) => cell(r[c])).join(','))].join('\r\n');
}
