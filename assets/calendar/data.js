// Reference lists for the content calendar. The database checks the same keys
// (supabase/migrations/); change both together.

export const LEAD_DAYS = 21;
export const CONTACT = 'Bro. Eugene Aiken, Associate Editor of the Sphinx';

export const CATS = [
  { key: 'alpha', label: 'Alpha legacy', desc: "Founders' Day, the Jewels, Charter Day, and conventions." },
  { key: 'chapter', label: 'Chapter events', desc: 'GIL programs, service, fundraisers, and approved requests.' },
  { key: 'program', label: 'National programs', desc: 'Posts tied to the four national programs.' },
  { key: 'heritage', label: 'Heritage and culture', desc: 'Black history, heritage months, and Brooklyn legacy.' },
  { key: 'd9', label: 'Divine Nine', desc: "Founders' Days for our fellow NPHC organizations." },
  { key: 'notable', label: 'Notable Alpha men', desc: 'Birthdays of well-known brothers.' },
  { key: 'series', label: 'Monthly series', desc: 'Brother spotlight and This Month in Alpha History.' },
  { key: 'holiday', label: 'Holidays', desc: 'Civic and family holidays.' },
  { key: 'faith', label: 'Faith', desc: 'Christmas and Easter greetings.' }
];

export const PROGRAMS = [
  { key: 'vote', label: 'A Voteless People Is a Hopeless People', short: 'Voteless People' },
  { key: 'college', label: 'Go-To-High-School, Go-To-College', short: 'Go-To-College' },
  { key: 'project-alpha', label: 'Project Alpha', short: 'Project Alpha' },
  { key: 'keeper', label: "Brother's Keeper", short: "Brother's Keeper" }
];

export const FORMATS = [
  { key: 'graphic', label: 'Single graphic' },
  { key: 'carousel', label: 'Carousel' },
  { key: 'reel', label: 'Reel or video' },
  { key: 'story', label: 'Story' },
  { key: 'flyer', label: 'Event flyer' },
  { key: 'text', label: 'Text post' }
];

// Facebook is off while the chapter has no access to it. The database still accepts
// 'facebook', so adding { key: 'facebook', label: 'Facebook' } back here turns it on again.
export const PLATFORMS = [
  { key: 'instagram', label: 'Instagram' },
  { key: 'threads', label: 'Threads' },
  { key: 'x', label: 'X' },
  { key: 'website', label: 'gil1906.org' },
  { key: 'substack', label: 'Substack' },
  { key: 'whatsapp', label: 'WhatsApp' }
];

export const STATUSES = [
  { key: 'planned', label: 'Planned', desc: 'On the calendar, not started.' },
  { key: 'needs-info', label: 'Needs info', desc: 'Waiting on dates, details, or creative.' },
  { key: 'in-design', label: 'In design', desc: 'Graphic or video in progress.' },
  { key: 'ready', label: 'Ready', desc: 'Approved and ready to schedule.' },
  { key: 'scheduled', label: 'Scheduled', desc: 'Queued on the platform.' },
  { key: 'posted', label: 'Posted', desc: 'Live.' },
  { key: 'skipped', label: 'Skipped', desc: 'Intentionally not posting.' }
];

export const REQ_STATUS = {
  new: { label: 'New', desc: 'Waiting for review.' },
  'needs-info': { label: 'Needs info', desc: 'The media team asked a question.' },
  approved: { label: 'On the calendar', desc: 'Scheduled as a post.' },
  declined: { label: 'Declined', desc: 'Not running. The note explains why.' }
};

export const COMMITTEES = [
  'Community Service', 'DX Alumni', 'Education', 'Finance', 'Historian', 'Membership',
  'Social & Fundraising', 'E-Board', 'Media', 'Other'
];

// Files chairs attach to requests. The storage bucket enforces the same size and types
// (supabase/migrations/20261013000200_chairs_and_request_files.sql); 50 MB is the Supabase Free
// plan's limit.
export const FILES = {
  max: 10,
  maxBytes: 50 * 1024 * 1024,
  accept: 'image/*,video/*,application/pdf'
};

export const MILESTONES = [
  { date: '2026-12-04', label: "Founders' Day", detail: '120 years' },
  { date: '2027-05-05', label: 'GIL Charter Day', detail: '82 years' }
];

const byKey = (arr) => Object.fromEntries(arr.map((x) => [x.key, x]));
export const CAT = byKey(CATS);
export const PROG = byKey(PROGRAMS);
export const FMT = byKey(FORMATS);
export const PLAT = byKey(PLATFORMS);
export const STAT = byKey(STATUSES);
export const CAT_ORDER = Object.fromEntries(CATS.map((c, i) => [c.key, i]));
