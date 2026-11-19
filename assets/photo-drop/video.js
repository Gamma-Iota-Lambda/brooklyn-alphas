// School Daze photo drop: a video the committee adds from the review page (review.js). Guests
// send photos only, and nothing here is used by their page.
//
// Three jobs. videoType() says whether a file is one the show takes. readVideo() opens it in this
// browser, which is the best sign the slideshow's browser can play it too, and reads its size and
// length and a small picture of it (the poster). sendVideo() puts it in the chapter's storage:
// the server hands out two links, the poster and the file go straight to storage through them,
// and the server then checks what arrived before the video joins the show. The file goes up in
// pieces (a resumable upload), so a connection that drops costs one piece, not the whole video.
import { DropError, review } from './api.js';

const TYPES = { mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime' };
const SAID = ['video/mp4', 'video/x-m4v', 'video/quicktime']; // what a browser calls those files
const OPEN_TIMEOUT = 15000; // a video that hasn't opened by then isn't going to
const POSTER_TIMEOUT = 10000;
const POSTER_EDGE = 480;
const POSTER_QUALITY = 0.8;
const POSTER_MAX_BYTES = 307200; // the server drops a larger one
const ANSWER_TIMEOUT = 30000;
const STALL_TIMEOUT = 60000; // no byte has moved for this long: the connection is gone
const STORE_TIMEOUT = 300000; // every byte has gone: this long for storage to put a large file away and answer
const PIECE = 6 * 1024 * 1024; // storage takes a resumable upload in pieces of exactly this size, but for the last
const RETRY = [1000, 3000, 5000, 10000, 20000, 30000]; // the wait before each new try; the last one repeats
const GIVE_UP = 600000; // nothing has got through for this long: the upload is given up
const SWEEP_AFTER = 60000; // after a cancelled upload, the server is asked once more to clear what landed late
const SETTLE_TIMEOUT = 10000;
const KEEP = 'max-age=31536000';
const KEEP_SECONDS = '31536000'; // the same, as a resumable upload states it
const OWED_KEY = 'gil.drop.review.owed';

// 'video/mp4' or 'video/quicktime' for a file the show takes, by its name and by what the browser
// makes of it, or '' for anything else. A browser that can't tell says nothing, and the name decides.
export function videoType(file) {
  const ending = /\.([a-z0-9]+)$/i.exec(String((file && file.name) || ''));
  const type = ending ? TYPES[ending[1].toLowerCase()] || '' : '';
  const said = String((file && file.type) || '').toLowerCase();
  return type && (!said || SAID.includes(said)) ? type : '';
}

const within = (work, ms, late) => {
  let timer;
  const slow = new Promise((resolve, reject) => { timer = setTimeout(() => reject(late), ms); });
  return Promise.race([work, slow]).finally(() => clearTimeout(timer));
};

// One event from a media element, or a rejection if `ms` pass or the element reports an error.
function heard(video, name, ms) {
  return new Promise((resolve, reject) => {
    const done = (settle, value) => {
      clearTimeout(timer);
      video.removeEventListener(name, yes);
      video.removeEventListener('error', no);
      settle(value);
    };
    const yes = () => done(resolve);
    const no = () => done(reject, new Error('The video reported an error.'));
    const timer = setTimeout(() => done(reject, new Error('The video took too long.')), ms);
    video.addEventListener(name, yes);
    video.addEventListener('error', no);
  });
}

// True when nothing was drawn. Some browsers hand over a frame before they have one.
function looksEmpty(ctx, width, height) {
  for (let i = 1; i < 6; i += 1) {
    for (let j = 1; j < 6; j += 1) {
      if (ctx.getImageData(Math.floor((width * i) / 6), Math.floor((height * j) / 6), 1, 1).data[3]) return false;
    }
  }
  return true;
}

const encode = (canvas, quality) => new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));

// A small JPEG of the video a second in (or halfway through one shorter than two seconds).
async function posterOf(video) {
  const length = Number.isFinite(video.duration) ? video.duration : 0;
  const at = Math.min(1, length / 2);
  if (at > 0) {
    const there = heard(video, 'seeked', POSTER_TIMEOUT);
    video.currentTime = at;
    await there;
  }
  if (video.readyState < 2) await heard(video, 'loadeddata', POSTER_TIMEOUT);
  const scale = Math.min(1, POSTER_EDGE / Math.max(video.videoWidth, video.videoHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
  canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  if (looksEmpty(ctx, canvas.width, canvas.height)) return null;
  for (const quality of [POSTER_QUALITY, 0.6]) {
    const blob = await encode(canvas, quality);
    if (blob && blob.type === 'image/jpeg' && blob.size > 0 && blob.size <= POSTER_MAX_BYTES) return blob;
  }
  return null;
}

// Opens a video file in this browser. Resolves with { width, height, seconds, poster }: seconds
// is null when the file doesn't say how long it is, and poster is a JPEG Blob or null when no
// picture could be made of it. Rejects when the browser can't open the file as a video.
export async function readVideo(file) {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.setAttribute('playsinline', '');
  video.preload = 'auto';
  try {
    const opened = heard(video, 'loadedmetadata', OPEN_TIMEOUT);
    video.src = url;
    await opened;
    // Sound with no picture opens too. That isn't something a screen can show.
    if (!(video.videoWidth > 0 && video.videoHeight > 0)) throw new Error('The video has no picture.');
    const facts = {
      width: video.videoWidth,
      height: video.videoHeight,
      seconds: Number.isFinite(video.duration) && video.duration > 0 ? Math.round(video.duration * 100) / 100 : null
    };
    let poster = null;
    try {
      poster = await posterOf(video);
    } catch {
      // No picture of it, then. The video itself is fine.
    }
    return { ...facts, poster };
  } finally {
    // Let go of the file: an open video holds its memory, and the link to it never runs out.
    video.removeAttribute('src');
    try { video.load(); } catch { /* already let go of */ }
    URL.revokeObjectURL(url);
  }
}

const STOPPED = 'The upload stopped. Check the connection and add it again.';

// Places held on the server that this tab hasn't handed back yet: an upload that failed while
// the connection was down, or a page that was reloaded partway through one. Until its place is
// let go, such a video counts toward the videos' limits (the server lets go by itself only after
// three hours). The ids are kept for this tab, so they outlast a reload.
const owed = new Set();
try {
  for (const id of JSON.parse(sessionStorage.getItem(OWED_KEY) || '[]')) if (typeof id === 'string' && id) owed.add(id);
} catch {
  // No storage, or nothing readable in it.
}
const keepOwed = () => {
  try {
    sessionStorage.setItem(OWED_KEY, JSON.stringify([...owed]));
  } catch {
    // Kept in memory only.
  }
};
const owe = (id) => {
  owed.add(id);
  keepOwed();
};
const paid = (id) => {
  if (owed.delete(id)) keepOwed();
};

// While a video is going up, its tab holds a lock in the video's name, which every tab of this
// browser can see. A copy of the tab (Duplicate tab copies what a tab remembers, the places it
// holds included) can tell by it that the upload is alive, and leaves its place alone.
const lockName = (id) => `gil.drop.video.${id}`;
const locks = () => (typeof navigator !== 'undefined' && navigator.locks && navigator.locks.request ? navigator.locks : null);
// Takes the lock. The answer is how to let go of it.
function holdLock(id) {
  if (!locks()) return () => {};
  let release = () => {};
  const held = new Promise((resolve) => { release = resolve; });
  locks().request(lockName(id), () => held).catch(() => {});
  return release;
}
// Is some tab sending this video right now?
async function inUse(id) {
  if (!locks()) return false;
  try {
    return await locks().request(lockName(id), { ifAvailable: true }, (lock) => !lock);
  } catch {
    return false;
  }
}

// Hands back every place this tab still holds, and resolves with how many it let go. Never
// rejects. A place whose video some tab is sending right now is left alone.
// Asking the server to forget a video that has arrived after all does nothing to it.
export async function settleVideos(code) {
  const late = new DropError('That took too long.', { reason: 'network' });
  const let_go = await Promise.all([...owed].map(async (id) => {
    try {
      if (await inUse(id)) return 0;
      await within(review(code, 'video-cancel', { id }), SETTLE_TIMEOUT, late);
      paid(id);
      return 1;
    } catch {
      return 0; // still owed: tried again the next time
    }
  }));
  return let_go.reduce((sum, n) => sum + n, 0);
}

const TOO_LARGE = 'That video is too large to store. Export a smaller copy, or trim it, and add it again.';
const NOT_SENT = "The video didn't upload. Try again.";
// Thrown by sendInPieces when this storage won't take the file that way. It then goes in one request.
const IN_ONE = { inOne: true };
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// What a link for an upload says about where its file goes: storage's address for resumable
// uploads made with such a link's token (it ends in /sign: the one without is for people signed
// in to Supabase, and refuses a token), the bucket, the path in it, and the token that is the
// permission. Null for a link that doesn't read that way.
function readLink(link) {
  try {
    const url = new URL(link);
    const mark = '/object/upload/sign/';
    const at = url.pathname.indexOf(mark);
    const token = url.searchParams.get('token');
    if (at < 0 || !token) return null;
    const rest = decodeURIComponent(url.pathname.slice(at + mark.length));
    const cut = rest.indexOf('/');
    if (cut < 1 || cut === rest.length - 1) return null;
    return { endpoint: `${url.origin}${url.pathname.slice(0, at)}/upload/resumable/sign`, bucket: rest.slice(0, cut), path: rest.slice(cut + 1), token };
  } catch {
    return null;
  }
}

// One request of the resumable protocol that carries none of the file.
async function ask(url, init, holder) {
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), ANSWER_TIMEOUT);
  holder.stop = stop;
  try {
    return await fetch(url, { ...init, cache: 'no-store', signal: stop.signal });
  } finally {
    clearTimeout(timer);
    holder.stop = null;
  }
}

// One piece of the file, from `offset` on. Resolves with the answer's status and the place the
// server says it has reached (NaN when it doesn't say). Rejects when the piece didn't get there.
function sendPiece(url, piece, offset, headers, { progress, holder }) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let timer = 0;
    const moving = (all = false) => {
      clearTimeout(timer);
      timer = setTimeout(() => xhr.abort(), all ? STORE_TIMEOUT : STALL_TIMEOUT);
    };
    const fail = () => {
      clearTimeout(timer);
      reject(new Error('The piece did not arrive.'));
    };
    xhr.open('PATCH', url);
    for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);
    xhr.setRequestHeader('Upload-Offset', String(offset));
    xhr.setRequestHeader('Content-Type', 'application/offset+octet-stream');
    xhr.upload.addEventListener('progress', (e) => {
      moving(e.loaded >= piece.size);
      progress(e.loaded);
    });
    xhr.addEventListener('load', () => {
      clearTimeout(timer);
      const said = xhr.getResponseHeader('Upload-Offset');
      resolve({ status: xhr.status, offset: said === null || said === '' ? NaN : Number(said) });
    });
    xhr.addEventListener('error', fail);
    xhr.addEventListener('abort', fail);
    holder.xhr = xhr;
    moving();
    xhr.send(piece);
  });
}

// Sends the file to storage in pieces (the TUS protocol, which Supabase Storage speaks), with the
// link's token as the permission. A piece that doesn't get there is not the end of it: the page
// waits, asks storage how much it has, and carries on from there, for as long as something gets
// through every ten minutes. `progress(sent, total)` hears each step forward, and
// `waiting(sent, total)` each time the page is waiting to try again.
// Throws IN_ONE when this storage won't start an upload this way.
async function sendInPieces(link, file, type, { progress, waiting, holder }) {
  const to = readLink(link);
  if (!to) throw IN_ONE;
  const size = file.size;
  const headers = { 'Tus-Resumable': '1.0.0', 'x-signature': to.token, 'x-upsert': 'true' };
  const b64 = (text) => btoa(unescape(encodeURIComponent(text)));
  const about = [['bucketName', to.bucket], ['objectName', to.path], ['contentType', type], ['cacheControl', KEEP_SECONDS]]
    .map(([name, value]) => `${name} ${b64(value)}`).join(',');
  const stopped = () => new DropError(STOPPED, { reason: 'upload' });
  // Cancel ends every wait and every try.
  const alive = () => {
    if (holder.cancelled) throw stopped();
  };
  let lastMove = Date.now();
  let tries = 0;
  const moved = () => {
    lastMove = Date.now();
    tries = 0;
  };
  // The wait before another try. The upload is given up when nothing has got through for too long.
  const pause = async (sent) => {
    alive();
    // The ten minutes run from the first try that failed, not from the last piece that got
    // through: a computer that slept through them still gets a try when it wakes.
    if (tries === 0) lastMove = Date.now();
    if (Date.now() - lastMove > GIVE_UP) throw stopped();
    waiting(sent, size);
    const wait = RETRY[Math.min(tries, RETRY.length - 1)];
    const before = Date.now();
    await sleep(wait);
    // A wait that took far longer than it was meant to: the computer was asleep. The ten
    // minutes start again from its waking, so the connection has time to come back.
    if (Date.now() - before > wait + 60000) lastMove = Date.now();
    tries += 1;
    alive();
  };

  // A place for the upload: storage answers with the address the pieces go to.
  const start = async () => {
    for (;;) {
      let res = null;
      try {
        res = await ask(to.endpoint, { method: 'POST', headers: { ...headers, 'Upload-Length': String(size), 'Upload-Metadata': about } }, holder);
      } catch {
        res = null;
      }
      alive();
      if (res && res.status === 201) {
        const location = res.headers.get('Location');
        if (!location) throw IN_ONE; // the browser wasn't shown where: nothing to send pieces to
        // Kept to the address the link named, whichever of its own names storage answers with.
        const where = new URL(location, to.endpoint);
        const named = new URL(to.endpoint);
        where.protocol = named.protocol;
        where.host = named.host;
        moved();
        return where.href;
      }
      if (res && res.status === 413) throw new DropError(TOO_LARGE, { reason: 'upload', status: 413 });
      // Storage said no to starting this way: the file goes in one request instead.
      if (res && res.status < 500 && res.status !== 429 && res.status !== 408) throw IN_ONE;
      await pause(0);
    }
  };

  // How much of the file storage has: a number of bytes, or -1 when it no longer knows the upload.
  const reached = async (where) => {
    const res = await ask(where, { method: 'HEAD', headers }, holder);
    if (res.status === 404 || res.status === 410) return -1;
    if (res.status === 400 || res.status === 401 || res.status === 403) throw new DropError(NOT_SENT, { reason: 'upload', status: res.status });
    const said = res.headers.get('Upload-Offset');
    const at = said === null || said === '' ? NaN : Number(said);
    if (!res.ok || !Number.isInteger(at) || at < 0 || at > size) throw new Error('No answer about the upload.');
    return at;
  };

  let where = await start();
  let offset = 0;
  let restarts = 0;
  while (offset < size) {
    alive();
    const from = offset;
    const end = Math.min(size, from + PIECE);
    let answer = null;
    try {
      answer = await sendPiece(where, file.slice(from, end), from, headers, { holder, progress: (sent) => progress(Math.min(size, from + sent), size) });
    } catch {
      answer = null;
    }
    alive();
    if (answer && (answer.status === 204 || answer.status === 200)) {
      offset = Number.isInteger(answer.offset) && answer.offset > from && answer.offset <= size ? answer.offset : end;
      moved();
      progress(offset, size);
      continue;
    }
    if (answer && answer.status === 413) throw new DropError(TOO_LARGE, { reason: 'upload', status: 413 });
    // The permission ran out, or storage won't have this piece at all: no use trying it again.
    if (answer && [400, 401, 403, 415].includes(answer.status)) throw new DropError(NOT_SENT, { reason: 'upload', status: answer.status });
    // The piece didn't get there, or its answer got lost. Storage says how much it has, and the
    // upload carries on from there.
    for (;;) {
      await pause(offset);
      let at = null;
      try {
        at = await reached(where);
      } catch (e) {
        alive();
        if (e instanceof DropError) throw e;
        continue;
      }
      alive();
      if (at >= 0) {
        if (at > offset) moved();
        offset = at;
        break;
      }
      // Storage no longer knows the upload. Once the last piece has been sent, that means it
      // took it and put the file away, and only its answer got lost: the server's check, which
      // comes next, says for certain. Before that, the upload starts over.
      if (end === size) {
        offset = size;
        break;
      }
      if (restarts >= 2) throw stopped();
      restarts += 1;
      where = await start();
      offset = 0;
      break;
    }
  }
  progress(size, size);
}

// Puts the file where a link from the server points, in one request, for a storage that won't
// take it in pieces. XMLHttpRequest, because fetch doesn't say how much has gone. There is no
// limit on the whole upload, which can take many minutes on a slow connection: it is given up
// only when nothing has moved for a minute.
function put(link, body, type, { progress, holder }) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let timer = 0;
    const fail = (message) => {
      clearTimeout(timer);
      reject(new DropError(message, { reason: 'upload', status: xhr.status || 0 }));
    };
    const moving = (all = false) => {
      clearTimeout(timer);
      timer = setTimeout(() => xhr.abort(), all ? STORE_TIMEOUT : STALL_TIMEOUT);
    };
    xhr.open('PUT', link);
    xhr.setRequestHeader('Content-Type', type);
    xhr.setRequestHeader('cache-control', KEEP);
    xhr.setRequestHeader('x-upsert', 'true');
    xhr.upload.addEventListener('progress', (e) => {
      const total = e.lengthComputable ? e.total : body.size;
      moving(e.loaded >= total);
      progress(e.loaded, total);
    });
    xhr.addEventListener('load', () => {
      clearTimeout(timer);
      if (xhr.status >= 200 && xhr.status < 300) return resolve();
      fail(xhr.status === 413 ? TOO_LARGE : NOT_SENT);
    });
    xhr.addEventListener('error', () => fail(STOPPED));
    xhr.addEventListener('abort', () => fail(STOPPED));
    holder.xhr = xhr;
    moving();
    xhr.send(body);
  });
}

// The poster goes the same way. It is small, and a video without one is still a video, so a
// failure here is never passed on.
async function putPoster(link, poster, holder) {
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), ANSWER_TIMEOUT);
  holder.stop = stop;
  try {
    await fetch(link, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/jpeg', 'cache-control': KEEP, 'x-upsert': 'true' },
      body: poster,
      signal: stop.signal
    });
  } catch {
    // The video goes in without its picture.
  } finally {
    clearTimeout(timer);
    holder.stop = null;
  }
}

// Sends a video to the show. `video` is { file, mime, width, height, seconds, poster, caption };
// `step` hears where things stand: { step: 'asking' | 'poster' | 'sending' | 'waiting' | 'checking', sent, total }.
// 'waiting' is a pause in the sending: the connection dropped, and the page is about to try again.
//
// Returns { done, cancel }. `done` resolves with { id } once the server has the video in the show.
// It rejects with a DropError whose message is the sentence to show; `reason` is 'cancelled' after
// cancel(), 'upload' when the file didn't get to storage, or the server's own. Whatever went
// wrong, the server has been asked to forget the video by then. `asked` on the error is true when
// the server had already been told to check the video: its answer may have been lost on the way
// back, so the video can be in the show all the same, and the list says whether it is.
export function sendVideo({ code, by, video }, step = () => {}) {
  const late = new DropError('That took too long. Check your connection and try again.', { reason: 'network' });
  const holder = { xhr: null, stop: null, cancelled: false };
  let id = '';
  let asked = false;
  let cancelled = false;
  let sending = false; // the file has started on its way to storage
  let unlock = () => {};
  let quit;
  const stopped = new Promise((resolve, reject) => { quit = reject; });
  stopped.catch(() => {});
  // Every wait ends at once on Cancel, also one on an answer that can't be called off.
  const unlessStopped = (work) => Promise.race([work, stopped]);

  const forget = async (which) => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await within(review(code, 'video-cancel', { id: which }), ANSWER_TIMEOUT, late);
        paid(which);
        // An upload that was cut off as its last bytes went can still be put away by storage a
        // moment later, after the server has looked and found nothing to remove. Asked once
        // more in a minute, the server clears whatever landed.
        if (sending) setTimeout(() => { review(code, 'video-cancel', { id: which }).catch(() => {}); }, SWEEP_AFTER);
        return;
      } catch (e) {
        // Storage was struggling: once more. Anything else, and the place stays owed: it is
        // handed back before the next video is added, or by the server in a few hours.
        if (!(e instanceof DropError) || e.reason !== 'storage') return;
      }
    }
  };

  const run = async () => {
    step({ step: 'asking' });
    // First, any place an earlier try left held, so it doesn't take this one's room.
    await unlessStopped(settleVideos(code));
    const place = review(code, 'video', {
      by,
      caption: video.caption || '',
      width: video.width,
      height: video.height,
      bytes: video.file.size,
      seconds: video.seconds,
      mime: video.mime
    });
    let answer;
    try {
      answer = await unlessStopped(within(place, ANSWER_TIMEOUT, late));
    } catch (e) {
      // An answer that lands after the wait was given up still holds a place. Hand it back.
      place.then((held) => {
        if (!held || !held.id) return;
        owe(held.id);
        forget(held.id);
      }, () => {});
      throw e;
    }
    if (!answer || !answer.id || !answer.upload || !answer.upload.video) throw new DropError('Something went wrong. Try again.');
    id = answer.id;
    owe(id);
    unlock = holdLock(id);
    if (video.poster && answer.upload.poster) {
      step({ step: 'poster' });
      await unlessStopped(putPoster(answer.upload.poster, video.poster, holder));
    }
    step({ step: 'sending', sent: 0, total: video.file.size });
    sending = true;
    const type = answer.upload.type || video.mime;
    const progress = (sent, total) => step({ step: 'sending', sent, total });
    try {
      await unlessStopped(sendInPieces(answer.upload.video, video.file, type, {
        holder,
        progress,
        waiting: (sent, total) => step({ step: 'waiting', sent, total })
      }));
    } catch (e) {
      if (e !== IN_ONE) throw e;
      await unlessStopped(put(answer.upload.video, video.file, type, { holder, progress }));
    }
    step({ step: 'checking' });
    asked = true;
    // The file is in storage, and sending it again could take an hour. So the server is asked
    // for as long as its answer is only "not now": an answer that got lost, storage that
    // couldn't be looked in, or an error on the way. The waits are the ones between pieces, and
    // it is given up after the same ten minutes. A plain no ends it at once.
    let firstMiss = 0;
    for (let attempt = 0; ; attempt += 1) {
      try {
        await unlessStopped(within(review(code, 'video-done', { id, by }), ANSWER_TIMEOUT, late));
        paid(id);
        return { id };
      } catch (e) {
        const notNow = e instanceof DropError
          && (e.reason === 'network' || e.reason === 'storage' || (!e.reason && (e.status === 0 || e.status === 429 || e.status >= 500)));
        if (cancelled || !notNow) throw e;
        if (!firstMiss) firstMiss = Date.now();
        if (Date.now() - firstMiss > GIVE_UP) throw e;
        const wait = RETRY[Math.min(attempt, RETRY.length - 1)];
        const before = Date.now();
        await unlessStopped(sleep(wait));
        // The computer slept through the wait: the ten minutes start again from its waking.
        if (Date.now() - before > wait + 60000) firstMiss = Date.now();
      }
    }
  };

  const done = run().catch(async (e) => {
    const error = e instanceof DropError ? e : new DropError('Something went wrong. Try again.');
    if (id) await forget(id);
    error.id = id;
    error.asked = asked;
    throw error;
  }).finally(() => unlock());

  return {
    done,
    cancel() {
      if (cancelled) return;
      cancelled = true;
      holder.cancelled = true;
      // The reason first: stopping the upload ends its wait too, and that must not be what is said.
      quit(new DropError("You cancelled, so the video wasn't added.", { reason: 'cancelled' }));
      if (holder.stop) holder.stop.abort();
      if (holder.xhr) holder.xhr.abort();
    }
  };
}
