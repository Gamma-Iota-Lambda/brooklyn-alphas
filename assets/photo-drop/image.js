// Photos in the browser, for the School Daze upload page (school-daze/photos.html).
//
// A phone photo is far larger than the venue's screens need, and an iPhone's may be a HEIC file
// that only Safari can open. So each photo is redrawn here as a JPEG no longer than 2560 pixels on
// its long side before it is sent, with a small copy for the organizers' review page. Redrawing
// also drops what a camera writes into the file, such as where the photo was taken.
//
// A photo is never made larger than it came: a small one enlarged only looks soft on a big screen.
// The verdict the page shows is about the file the person picked, not the copy that is sent.
//
// One photo at a time, always: opening several large photos at once crashes iPhones. prepare() and
// smaller() take turns on their own, however they are called.

// The server's limits, used until /open sends the real ones.
export const LIMITS = { minEdge: 500, maxEdge: 2560, maxBytes: 6291456 };

const FALLBACK_EDGE = 1920; // the long side to drop to when a photo is still too heavy
const THUMB_EDGE = 480;
const THUMB_QUALITY = 0.72;
const THUMB_MAX_BYTES = 307200; // the server drops a small copy bigger than this
const NAME_MAX = 120; // the server keeps a photo's details only while they stay short
const PICKED_MAX_BYTES = 40 * 1024 * 1024; // no phone photo is this big, and opening one could crash the page

// How a photo will look on the big screens, by the long side of the file the person picked.
// `note` is the sentence to show with the label when there is more to say. Guests read these,
// and to them the photos are for a throwback tribute: the words don't mention a screen.
export const VERDICTS = {
  great: { label: 'Sharp', note: '' },
  good: { label: 'Good', note: '' },
  small: { label: 'Small', note: 'It may look soft. If you have a larger copy, send that one.' },
  tiny: { label: 'Too small', note: 'Too small to use. If you have a larger copy, send that one.' }
};

export function verdictFor(longSide, minEdge = LIMITS.minEdge) {
  if (!(longSide >= minEdge)) return 'tiny';
  if (longSide >= 1600) return 'great';
  if (longSide >= 1000) return 'good';
  return 'small';
}

// Gets one picked file ready to send. Answers
//   { ok: true, blob, thumb, width, height, verdict, original, previewUrl }
// or { ok: false, message, verdict?, previewUrl? } when the photo can't be used.
// blob is the JPEG to send and width and height are its pixels. thumb is the small copy, or null.
// original is { name, width, height, bytes, type } of the picked file. previewUrl is an object URL
// for the page to show ('' when the browser can't draw the photo); the page revokes it when the
// photo leaves the page. Never throws.
export const prepare = (file, limits) => inTurn(() => prepareNow(file, withDefaults(limits)));

// For a photo the server found too large (413): one more copy, 1920 on the long side and a little
// more compressed. Answers { ok: true, blob, thumb, width, height } or { ok: false }.
export const smaller = (file, limits) => inTurn(() => smallerNow(file, withDefaults(limits)));

let line = Promise.resolve();
function inTurn(work) {
  const run = line.then(work, work);
  line = run.catch(() => {});
  return run;
}

function withDefaults(limits) {
  const out = { ...LIMITS };
  for (const key of Object.keys(LIMITS)) {
    const n = Number(limits && limits[key]);
    if (Number.isFinite(n) && n > 0) out[key] = n;
  }
  return out;
}

async function prepareNow(file, limits) {
  const original = { name: String(file.name || 'photo').slice(0, NAME_MAX), width: 0, height: 0, bytes: file.size, type: typeOf(file) };
  const shown = `"${original.name}"`;
  if (/^video\//.test(file.type || '')) {
    return { ok: false, message: `${shown} is a video. This page takes photos only.` };
  }
  if (file.size > PICKED_MAX_BYTES) {
    return { ok: false, message: `${shown} is too large for this page to open. Send a smaller copy.` };
  }
  const edge = Math.min(FALLBACK_EDGE, limits.maxEdge);
  const seen = {};
  let drawn;
  try {
    drawn = await redraw(file, [
      { edge: limits.maxEdge, quality: 0.88 },
      { edge: limits.maxEdge, quality: 0.8 },
      { edge, quality: 0.8 }
    ], limits, seen);
  } catch {
    // The browser can't open it (a HEIC outside Safari, a damaged file) or couldn't draw it.
    return untouched(file, original, limits, seen.natural);
  }
  original.width = drawn.natural.width;
  original.height = drawn.natural.height;
  const verdict = verdictFor(Math.max(original.width, original.height), limits.minEdge);
  const previewUrl = drawn.thumb || drawn.blob ? URL.createObjectURL(drawn.thumb || drawn.blob) : '';
  if (verdict === 'tiny') {
    return { ok: false, verdict, previewUrl, message: VERDICTS.tiny.note };
  }
  if (drawn.blob.size > limits.maxBytes) {
    return { ok: false, previewUrl, message: `We couldn't make ${shown} small enough to send. Try a different copy.` };
  }
  return {
    ok: true,
    blob: drawn.blob,
    thumb: drawn.thumb && drawn.thumb.size <= THUMB_MAX_BYTES ? drawn.thumb : null,
    width: drawn.width,
    height: drawn.height,
    verdict,
    original,
    previewUrl
  };
}

async function smallerNow(file, limits) {
  try {
    const drawn = await redraw(file, [{ edge: Math.min(FALLBACK_EDGE, limits.maxEdge), quality: 0.82 }], limits);
    if (!drawn.blob || drawn.blob.size > limits.maxBytes) return { ok: false };
    return {
      ok: true,
      blob: drawn.blob,
      thumb: drawn.thumb && drawn.thumb.size <= THUMB_MAX_BYTES ? drawn.thumb : null,
      width: drawn.width,
      height: drawn.height
    };
  } catch {
    return { ok: false };
  }
}

// Opens the file as a picture and draws it as a JPEG, trying each step of `plan` ({ edge,
// quality }) until one fits under the size limit. Throws when the browser can't open or draw it.
// A photo under the smallest size the screens can use gets a small copy for the page to show and
// no JPEG to send. `seen.natural` is filled in as soon as the picture's size is known, for the
// caller to use if the drawing fails after that.
async function redraw(file, plan, limits, seen = {}) {
  const url = URL.createObjectURL(file);
  const img = new Image();
  const canvas = document.createElement('canvas');
  const small = document.createElement('canvas');
  try {
    const unsure = await opened(img, url);
    // Phone photos are stored sideways with a note saying which way is up. Browsers follow the
    // note, so these are the sizes as the person sees the photo.
    const natural = { width: img.naturalWidth, height: img.naturalHeight };
    if (!natural.width || !natural.height) throw new Error('The picture has no size.');
    seen.natural = natural;

    if (Math.max(natural.width, natural.height) < limits.minEdge) {
      paint(small, img, natural, THUMB_EDGE);
      return { blob: null, thumb: await encode(small, THUMB_QUALITY).catch(() => null), width: 0, height: 0, natural };
    }

    let blob = null;
    let edge = 0;
    for (const step of plan) {
      if (step.edge !== edge) {
        paint(canvas, img, natural, step.edge);
        edge = step.edge;
      }
      blob = await encode(canvas, step.quality);
      if (blob.size <= limits.maxBytes) break;
    }

    // The small copy comes from the canvas, not the file, so the photo is only opened once.
    paint(small, canvas, { width: canvas.width, height: canvas.height }, THUMB_EDGE);
    if ((unsure || isOpaqueKind(file)) && looksEmpty(small)) throw new Error('Nothing was drawn.');
    const thumb = await encode(small, THUMB_QUALITY).catch(() => null);
    return { blob, thumb, width: canvas.width, height: canvas.height, natural };
  } finally {
    // Phones run out of picture memory quickly. Give all of it back before the next photo.
    URL.revokeObjectURL(url);
    img.onload = img.onerror = null;
    img.removeAttribute('src');
    canvas.width = canvas.height = 0;
    small.width = small.height = 0;
  }
}

// Resolves once the browser has read the picture and can draw it. Rejects when it can't. Answers
// true when the browser read the picture but wouldn't promise it can be drawn: worth a try, as
// long as the result is checked.
function opened(img, url) {
  const loaded = new Promise((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('The picture could not be opened.'));
  });
  loaded.catch(() => {}); // decode() reports the same failure
  img.decoding = 'async';
  img.src = url;
  if (typeof img.decode !== 'function') return loaded.then(() => false); // browsers too old for decode()
  return img.decode().then(() => false, () => loaded.then(() => true));
}

// Draws `source` onto `canvas`, scaled down so its long side is at most `edge`. Never scaled up.
function paint(canvas, source, size, edge) {
  const scale = Math.min(1, edge / Math.max(size.width, size.height));
  canvas.width = Math.max(1, Math.round(size.width * scale));
  canvas.height = Math.max(1, Math.round(size.height * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('No canvas to draw on.'); // an iPhone out of picture memory
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
}

// Browsers may hand back nothing, or a PNG, when they can't make the JPEG. Neither will do.
function encode(canvas, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob && blob.type === 'image/jpeg') resolve(blob);
      else reject(new Error('The picture could not be saved as a JPEG.'));
    }, 'image/jpeg', quality);
  });
}

// Camera photos have no see-through parts, so one that comes out fully see-through was never
// drawn: the phone ran out of memory and said nothing. Better to fall back than to send a black
// rectangle. Other kinds (a PNG, say) can be see-through on purpose and aren't checked.
const isOpaqueKind = (file) => /^image\/(jpe?g|hei[cf])$/.test(typeOf(file));

function looksEmpty(canvas) {
  try {
    const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
    const step = 4 * Math.max(1, Math.floor(data.length / 4 / 400)); // about 400 pixels, spread out
    for (let i = 3; i < data.length; i += step) if (data[i] !== 0) return false;
    return true;
  } catch {
    return false;
  }
}

// When the browser can't open or draw the file: a JPEG that fits the limit goes as it is, without
// a small copy, and its size is read from the file itself. Anything else is refused with what to
// do next. `natural` is the size the browser saw, when it got that far.
async function untouched(file, original, limits, natural) {
  const unreadable = {
    ok: false,
    message: natural
      ? `We couldn't get "${original.name}" ready to send. Try it again, or send a different copy.`
      : `We couldn't read "${original.name}". If it's an iPhone photo, open this page on your iPhone, or send a JPEG or PNG copy.`
  };
  if (!file.size || file.size > limits.maxBytes) return unreadable;
  let size = null;
  try {
    size = jpegSize(new Uint8Array(await new Response(file).arrayBuffer()));
  } catch {
    // Not readable at all.
  }
  if (!size) return unreadable;
  // A photo stored on its side: say the size the way people will see it. The server keeps this
  // order when the numbers are the file's own two, swapped.
  if (natural && natural.width === size.height && natural.height === size.width) size = natural;
  const verdict = verdictFor(Math.max(size.width, size.height), limits.minEdge);
  if (verdict === 'tiny') {
    return { ok: false, verdict, previewUrl: '', message: VERDICTS.tiny.note };
  }
  return {
    ok: true,
    blob: file.slice(0, file.size, 'image/jpeg'),
    thumb: null,
    width: size.width,
    height: size.height,
    verdict,
    original: { ...original, width: size.width, height: size.height, type: 'image/jpeg' },
    previewUrl: ''
  };
}

// A JPEG's width and height, from its start-of-frame segment, or null when the bytes aren't a JPEG
// the server would take. The server reads the same segment the same way.
export function jpegSize(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) return null;
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) return null;
    const marker = bytes[i + 1];
    if (marker === 0xff) { i += 1; continue; } // padding between segments
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; } // no length
    if (marker === 0xd9 || marker === 0xda) return null; // the picture data began with no size given
    const length = (bytes[i + 2] << 8) | bytes[i + 3];
    if (length < 2) return null;
    if (marker >= 0xc0 && marker <= 0xc2) {
      const height = (bytes[i + 5] << 8) | bytes[i + 6];
      const width = (bytes[i + 7] << 8) | bytes[i + 8];
      return width && height ? { width, height } : null;
    }
    i += 2 + length;
  }
  return null;
}

// The file's kind. Some browsers leave it blank for kinds they don't know, HEIC above all.
const KIND_BY_ENDING = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', heic: 'image/heic', heif: 'image/heif', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif' };
function typeOf(file) {
  const given = String(file.type || '').toLowerCase().slice(0, 60);
  if (given) return given === 'image/jpg' ? 'image/jpeg' : given;
  const ending = (/\.([a-z0-9]+)$/i.exec(file.name || '') || [])[1];
  return KIND_BY_ENDING[String(ending || '').toLowerCase()] || '';
}
