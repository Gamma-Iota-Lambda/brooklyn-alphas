// The slideshow's videos: the ones the committee adds on the review page.
//
// A video goes on screen only once the whole file is on this computer, so it can never stop to
// load in front of the room. This file brings each one down behind the scenes, a piece at a time,
// and keeps it in the browser's own storage (Cache Storage). There it survives a reload, and it
// is never downloaded twice. A piece that fails is asked for again; the pieces already here stay.
//
// screen.js decides when a video plays. It calls pump() on every tick and says whether the
// photos are using the connection: a piece is only asked for when they are not.

const CACHE = 'gil-drop-clips-1';
const PIECE = 1048576; // each request asks for this many bytes of the file
const PIECE_TIMEOUT = 60000; // a piece that hasn't come by now is given up and asked for again
const PAUSE = [5000, 15000, 30000, 60000]; // the wait after one, two, three and more failed pieces in a row
const PROBE_TIMEOUT = 10000; // a video that hasn't shown its first picture by now can't be played here
const MEMORY_MAX = 300 * 1048576; // with no storage to keep them in, this much video at most is held in memory

const text = (value) => (typeof value === 'string' ? value : '');

// Can this browser play it? Resolves true once the first picture is there. Never rejects.
function playable(src) {
  return new Promise((resolve) => {
    const video = document.createElement('video');
    let timer = 0;
    const done = (ok) => {
      clearTimeout(timer);
      video.removeAttribute('src');
      try { video.load(); } catch { /* nothing to let go of */ }
      resolve(ok);
    };
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.addEventListener('loadeddata', () => done(video.videoWidth > 0 && video.videoHeight > 0), { once: true });
    video.addEventListener('error', () => done(false), { once: true });
    timer = setTimeout(() => done(false), PROBE_TIMEOUT);
    video.src = src;
  });
}

// clock: the time in milliseconds. onReady(id): a video can now be played.
export function createClips({ clock = () => performance.now(), onReady = () => {} } = {}) {
  const clips = new Map(); // id -> the video, as last heard, and how far its download has got
  let order = []; // their ids in the server's order
  let busy = false; // a look in storage or a piece is under way: one thing at a time
  let storage = null; // a promise for the cache, or for null where the browser has none
  let held = 0; // bytes of video kept in memory because there is no storage

  const open = () => {
    if (!storage) {
      storage = (async () => {
        try { return 'caches' in globalThis ? await caches.open(CACHE) : null; } catch { return null; }
      })();
    }
    return storage;
  };

  // Where a video is kept. The size is part of the name, so a replaced file is fetched afresh.
  const keyOf = (clip) => new URL(`_clips/${clip.id}.${clip.bytes}`, location.href).href;

  // Takes a video out: stops its download, lets go of its file here.
  function drop(clip) {
    clip.gone = true;
    if (clip.stop) clip.stop.abort();
    if (clip.src) URL.revokeObjectURL(clip.src);
    if (clip.inMemory) held -= clip.bytes;
    clip.src = '';
    clip.parts = [];
    open().then((cache) => cache && cache.delete(keyOf(clip))).catch(() => {});
  }

  // Takes the server's list of approved videos. Only ever called with a real answer: a video
  // missing from the list has been taken out of the show, and its file here is deleted.
  function take(list) {
    const ids = [];
    for (const item of Array.isArray(list) ? list : []) {
      if (!item || typeof item.id !== 'string' || !item.id || typeof item.url !== 'string' || !item.url) continue;
      const bytes = Number(item.bytes);
      if (!Number.isInteger(bytes) || bytes <= 0 || ids.includes(item.id)) continue;
      ids.push(item.id);
      const facts = { url: item.url, thumbUrl: text(item.thumbUrl), caption: text(item.caption).trim(), seconds: Number(item.seconds) || 0 };
      const was = clips.get(item.id);
      if (was && was.bytes === bytes) {
        Object.assign(was, facts); // a renewed link serves the same file: the pieces already here stay
        continue;
      }
      if (was) drop(was);
      clips.set(item.id, { id: item.id, bytes, ...facts, state: 'new', looked: false, parts: [], got: 0, fails: 0, waitUntil: 0, src: '', stop: null, inMemory: false, gone: false });
    }
    for (const clip of [...clips.values()]) {
      if (ids.includes(clip.id)) continue;
      drop(clip);
      clips.delete(clip.id);
    }
    order = ids;
    tidy();
  }

  // Deletes stored videos that are no longer in the show (left by an earlier party, say).
  async function tidy() {
    const cache = await open();
    if (!cache) return;
    const keep = new Set([...clips.values()].map(keyOf));
    try {
      for (const request of await cache.keys()) if (!keep.has(request.url)) await cache.delete(request);
    } catch { /* storage that can't be listed is left as it is */ }
  }

  // The file is here: check that this browser can play it, and hand it over.
  async function adopt(clip, blob) {
    const src = URL.createObjectURL(blob);
    const ok = await playable(src);
    if (clip.gone || !ok) {
      URL.revokeObjectURL(src);
      if (clip.inMemory) held -= clip.bytes;
      clip.inMemory = false;
      if (!clip.gone) clip.state = 'bad'; // not tried again until the page is reloaded
      return;
    }
    clip.src = src;
    clip.state = 'ready';
    onReady(clip.id);
  }

  // Before anything is asked of the network: is the video in storage from an earlier visit?
  async function look(clip) {
    clip.looked = true;
    const cache = await open();
    if (!cache || clip.gone) return;
    let blob = null;
    try {
      const kept = await cache.match(keyOf(clip));
      if (kept) blob = await kept.blob();
    } catch { blob = null; }
    if (blob && blob.size === clip.bytes && !clip.gone) await adopt(clip, blob);
  }

  // Every piece has come: put them together, store the file, and play it from storage, so the
  // browser doesn't have to hold it all in memory.
  async function finish(clip) {
    let blob = new Blob(clip.parts, { type: 'video/mp4' }); // a .mov file plays under this name too
    clip.parts = [];
    if (blob.size !== clip.bytes) {
      clip.got = 0;
      throw new Error('size');
    }
    const cache = await open();
    let kept = false;
    if (cache) {
      try {
        await cache.put(keyOf(clip), new Response(blob, { headers: { 'Content-Type': 'video/mp4' } }));
        const back = await cache.match(keyOf(clip));
        const stored = back ? await back.blob() : null;
        if (stored && stored.size === clip.bytes) {
          blob = stored;
          kept = true;
        }
      } catch { kept = false; } // no room, or a private window: fall back on memory
    }
    if (clip.gone) return;
    if (!kept) {
      if (held + clip.bytes > MEMORY_MAX) {
        clip.state = 'left'; // nowhere to keep it: it is left out of this show
        return;
      }
      held += clip.bytes;
      clip.inMemory = true;
    }
    await adopt(clip, blob);
  }

  // Asks for the next piece of a video.
  async function piece(clip) {
    const from = clip.got;
    const to = Math.min(clip.bytes, from + PIECE) - 1;
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(), PIECE_TIMEOUT);
    clip.stop = stop;
    clip.state = 'loading';
    try {
      const res = await fetch(clip.url, { headers: { Range: `bytes=${from}-${to}` }, cache: 'no-store', signal: stop.signal });
      if (res.status !== 206 && res.status !== 200) throw new Error(`status ${res.status}`);
      const part = await res.arrayBuffer();
      if (clip.gone) return;
      if (res.status === 200) {
        // The server sent the whole file, not the piece asked for.
        if (part.byteLength !== clip.bytes) throw new Error('size');
        clip.parts = [part];
        clip.got = clip.bytes;
      } else {
        if (part.byteLength !== to - from + 1) throw new Error('size');
        clip.parts.push(part);
        clip.got = to + 1;
      }
      clip.fails = 0;
      if (clip.got >= clip.bytes) await finish(clip);
    } catch {
      if (clip.gone) return;
      clip.fails += 1;
      clip.waitUntil = clock() + PAUSE[Math.min(clip.fails, PAUSE.length) - 1];
    } finally {
      clearTimeout(timer);
      clip.stop = null;
    }
  }

  // Makes the next move, if nothing is under way. `idle`: the photos are not using the
  // connection, so a piece may be asked for. Looking in storage needs no connection.
  function pump(idle) {
    if (busy) return;
    const t = clock();
    const clip = order.map((id) => clips.get(id)).find((c) => c && (c.state === 'new' || c.state === 'loading') && t >= c.waitUntil && (!c.looked || idle));
    if (!clip) return;
    busy = true;
    (clip.looked ? piece(clip) : look(clip)).catch(() => {}).then(() => { busy = false; });
  }

  // This video didn't play when its turn came: it is left out until the page is reloaded.
  function bad(id) {
    const clip = clips.get(id);
    if (!clip || clip.state !== 'ready') return;
    URL.revokeObjectURL(clip.src);
    if (clip.inMemory) held -= clip.bytes;
    clip.inMemory = false;
    clip.src = '';
    clip.state = 'bad';
  }

  return {
    take,
    pump,
    bad,
    has: (id) => clips.has(id),
    // The ids that can be played now, in the server's order.
    ready: () => order.filter((id) => clips.get(id).state === 'ready'),
    // What screen.js needs to put one on screen, or null.
    get: (id) => {
      const clip = clips.get(id);
      return clip && clip.state === 'ready' ? { id: clip.id, src: clip.src, thumbUrl: clip.thumbUrl, caption: clip.caption, seconds: clip.seconds } : null;
    },
    // For the line in the controls: how many there are, how many can be played, and how far
    // the one coming down has got.
    progress: () => {
      const all = order.map((id) => clips.get(id));
      const coming = all.find((c) => c.state === 'loading');
      return { listed: all.length, ready: all.filter((c) => c.state === 'ready').length, bad: all.filter((c) => c.state === 'bad' || c.state === 'left').length, coming: coming ? Math.floor((100 * coming.got) / coming.bytes) : null };
    }
  };
}
