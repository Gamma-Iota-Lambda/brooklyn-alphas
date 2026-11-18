// A small ZIP writer for "Download approved photos" on the review page (school-daze/review.html).
//
// The photos are JPEGs, which are compressed already, so each file goes in exactly as it is
// ("stored"). That leaves only the ZIP's own bookkeeping: a short header before each file, a
// directory of every file at the end, and a CRC-32 check value that lets whoever opens the ZIP
// know each photo arrived whole.
//
// This writes the plain ZIP format, with its limits: under 4 GB for the whole ZIP and at most
// 65,535 files. The page starts a new ZIP every 250 MB, far inside both. Nothing here touches the
// page, so it runs in Node too, which is how the tests read back what it wrote.

const LOCAL_HEADER = 30; // bytes before each file, not counting its name
const DIRECTORY_ENTRY = 46; // bytes for each file in the directory, not counting its name
const DIRECTORY_END = 22; // bytes that close the ZIP
const MAX_FILES = 0xffff;
const MAX_BYTES = 0xffffffff;
const STORED = 0; // the "method" for a file kept as it is
const NAME_IS_UTF8 = 0x0800;
const VERSION = 20; // ZIP 2.0, which every unzip program reads

const encoder = new TextEncoder();

// One value for each possible byte, worked out once. It turns the CRC's bit-by-bit sum into a
// lookup for each byte.
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let bit = 0; bit < 8; bit++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

// The CRC-32 of some bytes (a Uint8Array), as a whole number from 0 to 4,294,967,295.
export function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// How much one file adds to a ZIP: its own bytes, its name twice, and its two headers.
export function zipCost(name, size) {
  return size + 2 * encoder.encode(name).length + LOCAL_HEADER + DIRECTORY_ENTRY;
}

// A ZIP keeps each file's time the way MS-DOS did: local time, two-second steps, years 1980 to 2107.
function dosTime(when) {
  const d = when instanceof Date && !Number.isNaN(when.getTime()) ? when : new Date();
  const year = Math.min(Math.max(d.getFullYear(), 1980), 2107);
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  };
}

// The header that sits just before a file's bytes.
function localHeader(file) {
  const out = new Uint8Array(LOCAL_HEADER + file.name.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x04034b50, true);
  view.setUint16(4, VERSION, true);
  view.setUint16(6, NAME_IS_UTF8, true);
  view.setUint16(8, STORED, true);
  view.setUint16(10, file.time, true);
  view.setUint16(12, file.date, true);
  view.setUint32(14, file.crc, true);
  view.setUint32(18, file.size, true); // size in the ZIP
  view.setUint32(22, file.size, true); // size once taken out: the same, since nothing is squeezed
  view.setUint16(26, file.name.length, true);
  view.setUint16(28, 0, true); // no extra fields
  out.set(file.name, LOCAL_HEADER);
  return out;
}

// The same file's line in the directory at the end, which is where unzip programs look first.
function directoryEntry(file) {
  const out = new Uint8Array(DIRECTORY_ENTRY + file.name.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x02014b50, true);
  // "Made by" plain MS-DOS rules. Saying Unix here would promise file permissions this doesn't
  // write, and some programs would then unpack photos nobody is allowed to open.
  view.setUint16(4, VERSION, true);
  view.setUint16(6, VERSION, true);
  view.setUint16(8, NAME_IS_UTF8, true);
  view.setUint16(10, STORED, true);
  view.setUint16(12, file.time, true);
  view.setUint16(14, file.date, true);
  view.setUint32(16, file.crc, true);
  view.setUint32(20, file.size, true);
  view.setUint32(24, file.size, true);
  view.setUint16(28, file.name.length, true);
  // Bytes 30 to 41 stay zero: no extra fields, no comment, one disk, no attributes.
  view.setUint32(42, file.offset, true); // where this file's header starts
  out.set(file.name, DIRECTORY_ENTRY);
  return out;
}

function directoryEnd(count, size, offset) {
  const out = new Uint8Array(DIRECTORY_END);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x06054b50, true);
  view.setUint16(8, count, true); // files on this disk
  view.setUint16(10, count, true); // files in all
  view.setUint32(12, size, true);
  view.setUint32(16, offset, true);
  return out;
}

// Starts an empty ZIP. Add files with add(), then blob() gives the finished ZIP.
//   const zip = createZip();
//   zip.add('school-daze-001-ada-lovelace.jpg', bytes, new Date(photo.createdAt));
//   const file = zip.blob();
// Names must be different from each other; the page numbers its files, so they are.
export function createZip() {
  const parts = []; // the ZIP so far, in order: a header, a file, a header, a file
  const files = []; // what the directory needs to know about each file
  let offset = 0; // bytes written so far
  let directory = 0; // bytes the directory will take

  return {
    get count() { return files.length; },

    // The size of the finished ZIP, were it finished now.
    get size() { return offset + directory + DIRECTORY_END; },

    // `bytes` is a Uint8Array. `when` is the time shown beside the file once unzipped.
    add(name, bytes, when = new Date()) {
      const encoded = encoder.encode(String(name));
      if (!encoded.length || encoded.length > 0xffff) throw new Error('A file in a ZIP needs a name, and a short one.');
      if (files.length >= MAX_FILES || this.size + zipCost(name, bytes.length) > MAX_BYTES) {
        throw new Error('This ZIP is full. Start another one.');
      }
      const file = { name: encoded, size: bytes.length, crc: crc32(bytes), offset, ...dosTime(when) };
      const header = localHeader(file);
      // Each photo is handed to the browser as a Blob straight away. The browser can keep Blobs
      // on disk, so a ZIP of 250 MB doesn't have to sit in the page's memory.
      parts.push(header, new Blob([bytes]));
      files.push(file);
      offset += header.length + file.size;
      directory += DIRECTORY_ENTRY + encoded.length;
    },

    blob() {
      const entries = files.map(directoryEntry);
      return new Blob([...parts, ...entries, directoryEnd(files.length, directory, offset)], { type: 'application/zip' });
    }
  };
}
