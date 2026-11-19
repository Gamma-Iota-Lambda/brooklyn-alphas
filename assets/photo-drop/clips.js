// The slideshow's videos: the ones the committee adds on the review page.
//
// A video goes on screen only once the whole file is on this computer, so it can never stop to
// load in front of the room. This file brings each one down behind the scenes, a piece at a time,
// and keeps the pieces in the browser's own storage (Cache Storage), on disk. A video can be
// hundreds of megabytes, so it is never held in memory whole: each piece goes to storage as it
// arrives, and the video is played from the stored pieces. They survive a reload, so nothing is
// downloaded twice, and a download that was cut off carries on from the piece it had reached. A
// piece that fails is asked for again; the pieces already here stay.
//
// screen.js decides when a video plays. It calls pump() on every tick and says whether the
// photos are using the connection: a piece is only asked for when they are not.

const CACHE = 'gil-drop-clips-2';
const OLD_CACHES = ['gil-drop-clips-1']; // an earlier layout, which kept each video as one file
const PIECE = 1048576; // each request asks for this many bytes of the file
const BIG = 64 * 1048576; // a file larger than this comes down in larger pieces, to get on with it
const BIG_PIECE = 4 * 1048576;
const PIECE_TIMEOUT = 60000; // a piece that hasn't come by now is given up and asked for again
const BIG_PIECE_TIMEOUT = 120000;
const PAUSE = [5000, 15000, 30000, 60000]; // the wait after one, two, three and more failed pieces in a row
const PROBE_TIMEOUT = 30000; // a video that hasn't shown its first picture by now can't be played here
const MEMORY_MAX = 300 * 1048576; // with no storage to keep them in, this much video at most is held in memory

const text = (value) => (typeof value === 'string' ? value : '');
const pieceOf = (bytes) => (bytes > BIG ? BIG_PIECE : PIECE);

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
  let held = 0; // bytes of video kept in memory because there is no storage, or no room in it

  const open = () => {
    if (!storage) {
      storage = (async () => {
        try {
          if (!('caches' in globalThis)) return null;
          for (const name of OLD_CACHES) caches.delete(name).catch(() => {});
          return await caches.open(CACHE);
        } catch {
          return null;
        }
      })();
    }
    return storage;
  };

  // Where a video's pieces are kept. The size is part of the name, so a replaced file is fetched
  // afresh. Piece number n is at this address with n on the end.
  const folderOf = (clip) => new URL(`_clips/${clip.id}.${clip.bytes}/`, location.href).href;
  const keyOf = (clip, from) => `${folderOf(clip)}${from / pieceOf(clip.bytes)}`;

  // Deletes a video's stored pieces.
  function forget(clip) {
    const folder = folderOf(clip);
    open().then(async (cache) => {
      if (!cache) return;
      for (const request of await cache.keys()) if (request.url.startsWith(folder)) await cache.delete(request);
    }).catch(() => {});
  }

  // Memory given back, when the video was being kept there.
  function release(clip) {
    if (clip.inMemory) held -= clip.bytes;
    clip.inMemory = false;
  }

  // Takes a video out: stops its download, lets go of its file here.
  function drop(clip) {
    clip.gone = true;
    if (clip.stop) clip.stop.abort();
    if (clip.src) URL.revokeObjectURL(clip.src);
    release(clip);
    clip.src = '';
    clip.blobs = [];
    forget(clip);
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
      clips.set(item.id, { id: item.id, bytes, ...facts, state: 'new', looked: false, blobs: [], got: 0, fails: 0, waitUntil: 0, src: '', stop: null, onDisk: false, inMemory: false, gone: false });
    }
    for (const clip of [...clips.values()]) {
      if (ids.includes(clip.id)) continue;
      drop(clip);
      clips.delete(clip.id);
    }
    order = ids;
    tidy();
  }

  // Deletes stored pieces of videos that are no longer in the show (left by an earlier party, say).
  async function tidy() {
    const cache = await open();
    if (!cache) return;
    const keep = [...clips.values()].map(folderOf);
    try {
      for (const request of await cache.keys()) if (!keep.some((folder) => request.url.startsWith(folder))) await cache.delete(request);
    } catch { /* storage that can't be listed is left as it is */ }
  }

  // With no storage to keep it in, a video is held in memory, while there is room for it there.
  // False when there is none: the video is left out of this show.
  function intoMemory(clip) {
    if (clip.inMemory) return true;
    if (held + clip.bytes > MEMORY_MAX) {
      clip.state = 'left';
      clip.blobs = [];
      forget(clip);
      return false;
    }
    held += clip.bytes;
    clip.inMemory = true;
    clip.onDisk = false;
    return true;
  }

  // The file is here: check that this browser can play it, and hand it over.
  async function adopt(clip, blob) {
    const src = URL.createObjectURL(blob);
    const ok = await playable(src);
    if (clip.gone || !ok) {
      URL.revokeObjectURL(src);
      release(clip);
      if (!clip.gone) clip.state = 'bad'; // not tried again until the page is reloaded
      return;
    }
    clip.src = src;
    clip.state = 'ready';
    onReady(clip.id);
  }

  // Every piece is here: the video is played from them as they lie in storage, put together by
  // name only, so the browser never has to hold the file in memory.
  async function finish(clip) {
    const blob = new Blob(clip.blobs, { type: 'video/mp4' }); // a .mov file plays under this name too
    clip.blobs = [];
    if (blob.size !== clip.bytes) {
      clip.got = 0;
      forget(clip);
      throw new Error('size');
    }
    await adopt(clip, blob);
  }

  // Before anything is asked of the network: how much of the video is in storage from an earlier
  // visit? All of it, and it can be played at once. Some of it, and the download carries on from
  // there.
  async function look(clip) {
    clip.looked = true;
    const cache = await open();
    if (clip.gone) return;
    if (!cache) {
      intoMemory(clip);
      return;
    }
    clip.onDisk = true;
    const size = pieceOf(clip.bytes);
    const blobs = [];
    let at = 0;
    try {
      while (at < clip.bytes) {
        const kept = await cache.match(keyOf(clip, at));
        const blob = kept ? await kept.blob() : null;
        if (clip.gone) return;
        if (!blob || blob.size !== Math.min(size, clip.bytes - at)) break;
        blobs.push(blob);
        at += blob.size;
      }
    } catch { /* what was found so far stands */ }
    clip.blobs = blobs;
    clip.got = at;
    if (at >= clip.bytes) await finish(clip);
  }

  // Puts one piece away, in storage where there is some, and counts it. A browser with no room
  // left in storage (or a private window, which gives none) holds the video in memory instead,
  // if it is small enough for that.
  async function keep(clip, from, part) {
    let blob = null;
    if (clip.onDisk) {
      try {
        const cache = await open();
        const key = keyOf(clip, from);
        // Straight from the bytes to storage, and read back as a file on disk: no copy of the
        // piece is left in memory.
        await cache.put(key, new Response(part));
        const back = await cache.match(key);
        const stored = back ? await back.blob() : null;
        if (!stored || stored.size !== part.byteLength) throw new Error('storage');
        blob = stored;
      } catch {
        if (clip.gone || !intoMemory(clip)) return;
      }
    }
    if (clip.gone) return;
    if (!blob) blob = new Blob([part]);
    clip.blobs.push(blob);
    clip.got = from + blob.size;
  }

  // Asks for the next piece of a video.
  async function piece(clip) {
    const size = pieceOf(clip.bytes);
    const from = clip.got;
    const to = Math.min(clip.bytes, from + size) - 1;
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(), size > PIECE ? BIG_PIECE_TIMEOUT : PIECE_TIMEOUT);
    clip.stop = stop;
    clip.state = 'loading';
    try {
      const res = await fetch(clip.url, { headers: { Range: `bytes=${from}-${to}` }, cache: 'no-store', signal: stop.signal });
      if (res.status !== 206 && res.status !== 200) throw new Error(`status ${res.status}`);
      // The server sent the whole file, not the piece asked for. A small one is taken as it is. A
      // large one is too much to take in one go, and is asked for again later.
      if (res.status === 200 && clip.bytes > BIG) {
        stop.abort();
        throw new Error('whole');
      }
      const part = await res.arrayBuffer();
      if (clip.gone) return;
      if (res.status === 200) {
        if (part.byteLength !== clip.bytes) throw new Error('size');
        clip.blobs = [];
        clip.got = 0;
        for (let at = 0; at < clip.bytes && !clip.gone && clip.state === 'loading'; at += size) await keep(clip, at, part.slice(at, at + size));
      } else {
        if (part.byteLength !== to - from + 1) throw new Error('size');
        await keep(clip, from, part);
      }
      if (clip.gone || clip.state !== 'loading') return;
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
    release(clip);
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
