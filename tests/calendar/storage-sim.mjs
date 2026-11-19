// A stand-in for Supabase Storage: the five calls the photo-drop Edge Function makes (put a file,
// sign links, list a folder, remove files, and hand out a link for an upload), and the one a
// browser makes with such a link (send one file, with no key), checked the way Storage checks
// them (the secret key on both headers, the bucket's size limit and allowed types, links that
// run out), with switches to make them fail.
// photo-drop-function.test.mjs uses it, and the live stand-in (live-server.mjs) serves its files
// and passes a browser's uploads on to it.
import { randomUUID } from 'node:crypto';

const MAX_PATHS = 1000; // Storage's own limit on a sign or remove request
const UPLOAD_LINK_MS = 2 * 3600000; // how long Storage lets a link for an upload be used

export class Storage {
  // url: the project's address (SUPABASE_URL). key: the secret key the function must send.
  // maxBytes and types: the bucket's rules, as the migration sets them. now: the clock links
  // run out by, and files are dated by.
  constructor({ url, key, bucket = 'photo-drop', maxBytes = 52428800, types = ['image/jpeg', 'video/mp4', 'video/quicktime'], now = () => Date.now() }) {
    this.url = String(url).replace(/\/+$/, '');
    this.key = key;
    this.bucket = bucket;
    this.maxBytes = maxBytes;
    this.types = types;
    this.now = now;
    this.calls = [];
    this.files = new Map(); // path -> { bytes, type, cacheControl, created }
    this.signed = new Map(); // token -> { path, until }
    this.uploads = new Map(); // an upload link's token -> { path, until, upsert }
    // Storage not answering at all.
    this.down = false;
    // Storage answering with an error. true fails every such call; a pattern fails the calls
    // whose path (or any of whose paths, or for a list, whose folder) it matches.
    this.failPut = false;
    this.failSign = false;
    this.failList = false;
    this.failRemove = false;
    // The same for handing out a link for an upload, and for an upload sent to one.
    this.failUploadLink = false;
    this.failUpload = false;
  }

  // The bytes at a path, or null.
  read(path) {
    const file = this.files.get(path);
    return file ? file.bytes : null;
  }

  // Puts a file in place without going through the function, for setting a test up. Like a file
  // the function puts, it is dated by the clock as it stands.
  seed(path, bytes, type = 'image/jpeg') {
    this.files.set(path, { bytes: Buffer.from(bytes), type, cacheControl: 'no-cache', created: this.now() });
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
    const rest = decodeURIComponent(url.pathname.slice('/storage/v1/object/'.length));
    // An upload to a signed link is the one call that carries no key: the link is the permission.
    const byLink = method === 'PUT' && rest.startsWith('upload/sign/');
    if (!byLink && (headers.get('apikey') !== this.key || headers.get('authorization') !== `Bearer ${this.key}`)) {
      return error(403, 'Unauthorized', 'Invalid Compact JWS');
    }
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
    // Stores the body at a path under the bucket's rules. Answers with Storage's refusal, or
    // with nothing once the file is in. Storage goes by the type the upload states, and never
    // looks inside the file.
    const keep = (path, upsert) => {
      const type = (headers.get('content-type') || 'application/octet-stream').split(';')[0].trim();
      if (!this.types.some((t) => (t.endsWith('/*') ? type.startsWith(t.slice(0, -1)) : t === type))) {
        return error(415, 'invalid_mime_type', `mime type ${type} is not supported`);
      }
      if (body.length > this.maxBytes) return error(413, 'Payload too large', 'The object exceeded the maximum allowed size');
      if (this.files.has(path) && !upsert) return error(409, 'Duplicate', 'The resource already exists');
      this.files.set(path, { bytes: body, type, cacheControl: headers.get('cache-control') || 'no-cache', created: this.now() });
      return null;
    };

    // A link for an upload: POST /object/upload/sign/<bucket>/<path>. Answers with the link, less
    // the project's address: good for that one path, for two hours. x-upsert on this call, not on
    // the upload, says whether the upload may replace a file already there.
    if (method === 'POST' && rest.startsWith('upload/sign/')) {
      const at = rest.slice('upload/sign/'.length);
      if (!at.startsWith(`${this.bucket}/`)) return noBucket();
      const path = at.slice(this.bucket.length + 1);
      if (!path) return error(400, 'Bad Request', 'no object name');
      fromJson();
      if (failing(this.failUploadLink, [path])) return broken();
      const token = randomUUID();
      this.uploads.set(token, { path, until: this.now() + UPLOAD_LINK_MS, upsert: headers.get('x-upsert') === 'true' });
      return reply(200, { url: `/object/upload/sign/${this.bucket}/${path}?token=${token}` });
    }

    // An upload to such a link: PUT /object/upload/sign/<bucket>/<path>?token=<token>, with the
    // bytes as the body. The token must be the one handed out for this path, and not run out.
    // After that the bucket's rules apply as they do to any put.
    if (byLink) {
      const at = rest.slice('upload/sign/'.length);
      if (!at.startsWith(`${this.bucket}/`)) return noBucket();
      const path = at.slice(this.bucket.length + 1);
      const grant = this.uploads.get(url.searchParams.get('token') || '');
      if (!grant || grant.path !== path || grant.until <= this.now()) return error(400, 'InvalidSignature', 'The signature is invalid');
      if (failing(this.failUpload, [path])) return broken();
      return keep(path, grant.upsert) || reply(200, { Key: `${this.bucket}/${path}` });
    }

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

    // List: POST /object/list/<bucket> { prefix, limit, offset, search }. Answers with the files
    // directly in that folder, by name, the way Storage does (a name, an id that a folder would
    // lack, when the file was put there, and its size and the type it was stored with). search
    // keeps only the names that have it in them, whatever the case.
    if (method === 'POST' && rest.startsWith('list/')) {
      if (rest !== `list/${this.bucket}`) return noBucket();
      const asked = fromJson();
      if (!asked || typeof asked.prefix !== 'string') return error(400, 'Bad Request', 'body must have a prefix');
      if (failing(this.failList, [asked.prefix])) return broken();
      const folder = `${asked.prefix.replace(/\/+$/, '')}/`;
      const search = typeof asked.search === 'string' ? asked.search.toLowerCase() : '';
      const names = this.paths().filter((path) => path.startsWith(folder) && !path.slice(folder.length).includes('/')).map((path) => path.slice(folder.length))
        .filter((name) => name.toLowerCase().includes(search));
      const from = Number.isInteger(asked.offset) ? asked.offset : 0;
      const to = from + (Number.isInteger(asked.limit) ? asked.limit : 100);
      return reply(200, names.slice(from, to).map((name) => {
        const file = this.files.get(folder + name);
        return { name, id: randomUUID(), created_at: new Date(file.created).toISOString(), metadata: { size: file.bytes.length, mimetype: file.type } };
      }));
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
      return keep(path, headers.get('x-upsert') === 'true') || reply(200, { Id: randomUUID(), Key: `${this.bucket}/${path}` });
    }

    return error(404, 'not_found', 'Route not found');
  };
}
