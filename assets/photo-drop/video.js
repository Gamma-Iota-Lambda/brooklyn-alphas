// School Daze photo drop: a video the committee adds from the review page (review.js). Guests
// send photos only, and nothing here is used by their page.
//
// Three jobs. videoType() says whether a file is one the show takes. readVideo() opens it in this
// browser, which is the best sign the slideshow's browser can play it too, and reads its size and
// length and a small picture of it (the poster). sendVideo() puts it in the chapter's storage:
// the server hands out two links, the poster and the file go straight to storage through them,
// and the server then checks what arrived before the video joins the show.
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
const CHECK_TRIES = 3; // asking the server to check the video, when the answer got lost
const CHECK_PAUSE = 2000;
const SETTLE_TIMEOUT = 10000;
const KEEP = 'max-age=31536000';
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

// Hands back every place this tab still holds, and resolves with how many it let go. Never
// rejects. Not to be called while this tab is sending a video: that one's place is held too.
// Asking the server to forget a video that has arrived after all does nothing to it.
export async function settleVideos(code) {
  const late = new DropError('That took too long.', { reason: 'network' });
  const let_go = await Promise.all([...owed].map(async (id) => {
    try {
      await within(review(code, 'video-cancel', { id }), SETTLE_TIMEOUT, late);
      paid(id);
      return 1;
    } catch {
      return 0; // still owed: tried again the next time
    }
  }));
  return let_go.reduce((sum, n) => sum + n, 0);
}

// Puts the file where a link from the server points. XMLHttpRequest, because fetch doesn't say
// how much has gone. There is no limit on the whole upload, which can take many minutes on a
// slow connection: it is given up only when nothing has moved for a minute.
function put(link, body, type, { progress, holder }) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let timer = 0;
    const fail = (message) => {
      clearTimeout(timer);
      reject(new DropError(message, { reason: 'upload', status: xhr.status || 0 }));
    };
    const moving = () => {
      clearTimeout(timer);
      timer = setTimeout(() => xhr.abort(), STALL_TIMEOUT);
    };
    xhr.open('PUT', link);
    xhr.setRequestHeader('Content-Type', type);
    xhr.setRequestHeader('cache-control', KEEP);
    xhr.setRequestHeader('x-upsert', 'true');
    xhr.upload.addEventListener('progress', (e) => {
      moving();
      progress(e.loaded, e.lengthComputable ? e.total : body.size);
    });
    xhr.addEventListener('load', () => {
      clearTimeout(timer);
      if (xhr.status >= 200 && xhr.status < 300) return resolve();
      fail(xhr.status === 413
        ? 'That video is too large to store. Export a smaller copy, or trim it, and add it again.'
        : "The video didn't upload. Try again.");
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
// `step` hears where things stand: { step: 'asking' | 'poster' | 'sending' | 'checking', sent, total }.
//
// Returns { done, cancel }. `done` resolves with { id } once the server has the video in the show.
// It rejects with a DropError whose message is the sentence to show; `reason` is 'cancelled' after
// cancel(), 'upload' when the file didn't get to storage, or the server's own. Whatever went
// wrong, the server has been asked to forget the video by then. `asked` on the error is true when
// the server had already been told to check the video: its answer may have been lost on the way
// back, so the video can be in the show all the same, and the list says whether it is.
export function sendVideo({ code, by, video }, step = () => {}) {
  const late = new DropError('That took too long. Check your connection and try again.', { reason: 'network' });
  const holder = { xhr: null, stop: null };
  let id = '';
  let asked = false;
  let cancelled = false;
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
    if (video.poster && answer.upload.poster) {
      step({ step: 'poster' });
      await unlessStopped(putPoster(answer.upload.poster, video.poster, holder));
    }
    step({ step: 'sending', sent: 0, total: video.file.size });
    await unlessStopped(put(answer.upload.video, video.file, answer.upload.type || video.mime, {
      holder,
      progress: (sent, total) => step({ step: 'sending', sent, total })
    }));
    step({ step: 'checking' });
    asked = true;
    for (let attempt = 1; ; attempt += 1) {
      try {
        await unlessStopped(within(review(code, 'video-done', { id, by }), ANSWER_TIMEOUT, late));
        paid(id);
        return { id };
      } catch (e) {
        // The file is in storage, and sending it again could take many minutes. When the answer
        // got lost or storage couldn't be asked, the same question is worth a second and a third try.
        const again = !cancelled && attempt < CHECK_TRIES && e instanceof DropError && (e.reason === 'network' || e.reason === 'storage');
        if (!again) throw e;
        await unlessStopped(new Promise((resolve) => setTimeout(resolve, CHECK_PAUSE)));
      }
    }
  };

  const done = run().catch(async (e) => {
    const error = e instanceof DropError ? e : new DropError('Something went wrong. Try again.');
    if (id) await forget(id);
    error.id = id;
    error.asked = asked;
    throw error;
  });

  return {
    done,
    cancel() {
      if (cancelled) return;
      cancelled = true;
      // The reason first: stopping the upload ends its wait too, and that must not be what is said.
      quit(new DropError("You cancelled, so the video wasn't added.", { reason: 'cancelled' }));
      if (holder.stop) holder.stop.abort();
      if (holder.xhr) holder.xhr.abort();
    }
  };
}
