// A stand-in for Supabase Storage: the four calls the photo-drop Edge Function makes (put a file,
// sign links, list a folder, remove files), checked the way Storage checks them (the secret key on
// both headers, the bucket's size limit and allowed types, links that run out), with switches to
// make them fail.
// photo-drop-function.test.mjs uses it, and the live stand-in (live-server.mjs) can serve its files.
import { randomUUID } from 'node:crypto';

const MAX_PATHS = 1000; // Storage's own limit on a sign or remove request

export class Storage {
  // url: the project's address (SUPABASE_URL). key: the secret key the function must send.
  // maxBytes and types: the bucket's rules, as the migration sets them. now: the clock links
  // run out by.
  constructor({ url, key, bucket = 'photo-drop', maxBytes = 8388608, types = ['image/jpeg'], now = () => Date.now() }) {
    this.url = String(url).replace(/\/+$/, '');
    this.key = key;
    this.bucket = bucket;
    this.maxBytes = maxBytes;
    this.types = types;
    this.now = now;
    this.calls = [];
    this.files = new Map(); // path -> { bytes, type, cacheControl }
    this.signed = new Map(); // token -> { path, until }
    // Storage not answering at all.
    this.down = false;
    // Storage answering with an error. true fails every such call; a pattern fails the calls
    // whose path (or any of whose paths, or for a list, whose folder) it matches.
    this.failPut = false;
    this.failSign = false;
    this.failList = false;
    this.failRemove = false;
  }

  // The bytes at a path, or null.
  read(path) {
    const file = this.files.get(path);
    return file ? file.bytes : null;
  }

  // Puts a file in place without going through the function, for setting a test up.
  seed(path, bytes, type = 'image/jpeg') {
    this.files.set(path, { bytes: Buffer.from(bytes), type, cacheControl: 'no-cache' });
  }

  paths() {
    return [...this.files.keys()].sort();
  }

  // The bytes a signed link leads to, or null when the link is wrong, is for another file, or has
  // run out. Takes the full link or the part Storage answers with (/object/sign/...).
  fileFor(signedUrl) {
    let url;
    try {
      url = new URL(String(signedUrl), `${this.url}/storage/v1/`);
    } catch {
      return null;
    }
    const at = url.pathname.indexOf(`/object/sign/${this.bucket}/`);
    if (at < 0) return null;
    const path = decodeURIComponent(url.pathname.slice(at + `/object/sign/${this.bucket}/`.length));
    const grant = this.signed.get(url.searchParams.get('token') || '');
    if (!grant || grant.path !== path || grant.until <= this.now()) return null;
    return this.read(path);
  }

  fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = (init.method || 'GET').toUpperCase();
    const headers = new Headers(init.headers || {});
    const call = { method, path: url.pathname, headers: Object.fromEntries(headers), json: null, bytes: 0 };
    this.calls.push(call);
    if (this.down) throw new TypeError('fetch failed');
    const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    const error = (status, name, message) => reply(status, { statusCode: String(status), error: name, message });
    const broken = () => error(500, 'Internal', 'Internal Server Error');
    const failing = (rule, paths) => rule === true || (rule instanceof RegExp && paths.some((p) => rule.test(p)));

    if (url.origin !== this.url || !url.pathname.startsWith('/storage/v1/object/')) return error(404, 'not_found', 'Route not found');
    if (headers.get('apikey') !== this.key || headers.get('authorization') !== `Bearer ${this.key}`) {
      return error(403, 'Unauthorized', 'Invalid Compact JWS');
    }
    const rest = decodeURIComponent(url.pathname.slice('/storage/v1/object/'.length));
    const body = init.body === undefined || init.body === null ? Buffer.alloc(0) : Buffer.from(await new Response(init.body).arrayBuffer());
    call.bytes = body.length;
    const fromJson = () => {
      try {
        call.json = JSON.parse(body.toString('utf8'));
      } catch {
        call.json = null;
      }
      return call.json && typeof call.json === 'object' ? call.json : null;
    };
    const list = (paths) => Array.isArray(paths) && paths.length >= 1 && paths.length <= MAX_PATHS && paths.every((p) => typeof p === 'string');
    const noBucket = () => error(404, 'Bucket not found', 'Bucket not found');

    // Signed links: POST /object/sign/<bucket> { expiresIn, paths }
    if (method === 'POST' && rest.startsWith('sign/')) {
      if (rest !== `sign/${this.bucket}`) return noBucket();
      const asked = fromJson();
      if (!asked || !Number.isInteger(asked.expiresIn) || asked.expiresIn < 1 || !list(asked.paths)) {
        return error(400, 'Bad Request', 'body must have expiresIn and 1 to 1000 paths');
      }
      if (failing(this.failSign, asked.paths)) return broken();
      return reply(200, asked.paths.map((path) => {
        if (!this.files.has(path)) return { error: 'Either the object does not exist or you do not have access to it', path, signedURL: null };
        const token = randomUUID();
        this.signed.set(token, { path, until: this.now() + asked.expiresIn * 1000 });
        return { error: null, path, signedURL: `/object/sign/${this.bucket}/${path}?token=${token}` };
      }));
    }

    // List: POST /object/list/<bucket> { prefix, limit, offset }. Answers with the files directly
    // in that folder, by name, the way Storage does (a name, and an id that a folder would lack).
    if (method === 'POST' && rest.startsWith('list/')) {
      if (rest !== `list/${this.bucket}`) return noBucket();
      const asked = fromJson();
      if (!asked || typeof asked.prefix !== 'string') return error(400, 'Bad Request', 'body must have a prefix');
      if (failing(this.failList, [asked.prefix])) return broken();
      const folder = `${asked.prefix.replace(/\/+$/, '')}/`;
      const names = this.paths().filter((path) => path.startsWith(folder) && !path.slice(folder.length).includes('/')).map((path) => path.slice(folder.length));
      const from = Number.isInteger(asked.offset) ? asked.offset : 0;
      const to = from + (Number.isInteger(asked.limit) ? asked.limit : 100);
      return reply(200, names.slice(from, to).map((name) => ({ name, id: randomUUID(), metadata: { mimetype: 'image/jpeg' } })));
    }

    // Remove: DELETE /object/<bucket> { prefixes }. Answers with the files that were there.
    if (method === 'DELETE') {
      if (rest !== this.bucket) return noBucket();
      const asked = fromJson();
      if (!asked || !list(asked.prefixes)) return error(400, 'Bad Request', 'body must have 1 to 1000 prefixes');
      if (failing(this.failRemove, asked.prefixes)) return broken();
      const gone = asked.prefixes.filter((path) => this.files.delete(path));
      return reply(200, gone.map((name) => ({ name, bucket_id: this.bucket })));
    }

    // Put: POST /object/<bucket>/<path>, with the bytes as the body
    if (method === 'POST' && rest.includes('/')) {
      if (!rest.startsWith(`${this.bucket}/`)) return noBucket();
      const path = rest.slice(this.bucket.length + 1);
      if (!path) return error(400, 'Bad Request', 'no object name');
      if (failing(this.failPut, [path])) return broken();
      // Storage goes by the type the upload states, and never looks inside the file.
      const type = (headers.get('content-type') || 'application/octet-stream').split(';')[0].trim();
      if (!this.types.some((t) => (t.endsWith('/*') ? type.startsWith(t.slice(0, -1)) : t === type))) {
        return error(415, 'invalid_mime_type', `mime type ${type} is not supported`);
      }
      if (body.length > this.maxBytes) return error(413, 'Payload too large', 'The object exceeded the maximum allowed size');
      if (this.files.has(path) && headers.get('x-upsert') !== 'true') return error(409, 'Duplicate', 'The resource already exists');
      this.files.set(path, { bytes: body, type, cacheControl: headers.get('cache-control') || 'no-cache' });
      return reply(200, { Id: randomUUID(), Key: `${this.bucket}/${path}` });
    }

    return error(404, 'not_found', 'Route not found');
  };
}
