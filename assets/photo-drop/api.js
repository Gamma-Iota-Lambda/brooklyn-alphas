// The photo drop's link to its Edge Function (supabase/functions/photo-drop). The three pages in
// school-daze/ talk to nothing else: the function checks each page's code and does the rest.
//
// Requests go out as plain text or as a form, never with custom headers, so the browser sends
// them straight away with no permission check first. The function reads JSON from the text.
const config = window.GIL_CALENDAR_CONFIG || {};

// False until assets/calendar/config.js has the Supabase project's address.
export const READY = !!config.supabaseUrl;

const BASE = `${String(config.supabaseUrl || '').replace(/\/+$/, '')}/functions/v1/photo-drop`;

// What went wrong, in words the page can show. `reason` is one of: network, code, closed, full,
// limit, busy, photo, size, input, storage, or empty when the function gave none.
export class DropError extends Error {
  constructor(message, { status = 0, reason = '' } = {}) {
    super(message);
    this.name = 'DropError';
    this.status = status;
    this.reason = reason;
  }
}

async function post(route, body, signal) {
  let res;
  try {
    res = await fetch(`${BASE}/${route}`, {
      method: 'POST',
      body: body instanceof FormData ? body : JSON.stringify(body),
      cache: 'no-store',
      signal
    });
  } catch {
    throw new DropError("We couldn't reach the chapter's server. Check your connection and try again.", { reason: 'network' });
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    // Not JSON: a gateway error page. The status decides the message below.
  }
  if (!res.ok || !data || data.error) {
    const fallback = res.status === 413 ? 'That photo is too large to send.' : 'Something went wrong. Try again.';
    throw new DropError((data && data.error) || fallback, {
      status: res.status,
      reason: (data && data.reason) || (res.status === 413 ? 'size' : '')
    });
  }
  return data;
}

// The upload page: is this link good, and are photos still being taken?
export const open = (code) => post('open', { code });

// The upload page: one photo. `form` is a FormData; drop.js lists its fields. `signal` (optional)
// stops the upload, for a send that has taken too long.
export const send = (form, signal) => post('send', form, signal);

// The review page: action is list, set, caption, settings, delete or empty.
export const review = (code, action, more = {}) => post('review', { ...more, code, action });

// The slideshow: the approved photos. `signal` (optional) lets go of a request that has had no
// answer in time.
export const screen = (code, signal) => post('screen', { code }, signal);

// A code from the page's address: ?k=CODE or #k=CODE (or c= for the review and screen pages).
export function codeFromAddress(names = ['k', 'c']) {
  const places = [new URLSearchParams(location.search), new URLSearchParams(location.hash.replace(/^#/, ''))];
  for (const params of places) {
    for (const name of names) {
      const value = (params.get(name) || '').trim();
      if (value) return value;
    }
  }
  return '';
}

export const esc = (text) => String(text == null ? '' : text)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
