/**
 * Cloudinary as the byte store.
 *
 * Workers KV is 1 GB for the whole project and 25 MiB per value, so it cannot
 * hold a video or a 50 MB archive. Cloudinary holds the bytes, serves them from
 * its own CDN, and gives us image and video transforms for free, which is what
 * makes the gallery light without the Worker ever touching a pixel.
 *
 * Three things are deliberate here:
 *
 * 1. Uploads are signed, so the api secret never leaves the Worker and the
 *    browser cannot become a write client. The signature is Cloudinary's scheme:
 *    SHA-1 over the sorted `key=value&...` string plus the secret.
 *
 * 2. The public id is an HMAC of the content digest under a salt, not the digest
 *    itself. Identical bytes still collapse onto one asset (the digest decides
 *    that), but the resulting url is not computable from the file, so a locked
 *    post's media is not fetchable by anyone who merely guesses a hash. The salt
 *    is a secret for exactly this reason.
 *
 * 3. `auto/upload` picks the resource type: images and video go to their own
 *    type, everything else to raw. One code path, and Cloudinary decides where
 *    a given file belongs.
 */

const enc = new TextEncoder();

function bytesToHex(buffer) {
  const out = new Uint8Array(buffer);
  let s = '';
  for (let i = 0; i < out.length; i++) s += out[i].toString(16).padStart(2, '0');
  return s;
}

function base64url(buffer) {
  let s = '';
  for (const b of new Uint8Array(buffer)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hmac(secret, algo, message) {
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: algo }, false, ['sign'],
  );
  return crypto.subtle.sign('HMAC', key, enc.encode(message));
}

function fromBase64Url(text) {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((text.length + 3) % 4);
  const raw = atob(padded);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** Is a Cloudinary upload configured? Without all three vars we fall back to KV. */
export function cloudinaryReady(env) {
  return Boolean(env.CLOUDINARY_CLOUD_NAME && env.CLOUDINARY_API_KEY
    && env.CLOUDINARY_API_SECRET && env.CLOUDINARY_SALT);
}

async function signature(env, params) {
  const body = Object.keys(params)
    .filter((k) => params[k] !== '' && params[k] !== undefined && params[k] !== null)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&') + env.CLOUDINARY_API_SECRET;
  return bytesToHex(await hmac(env.CLOUDINARY_API_SECRET, 'SHA-1', body));
}

/**
 * A public id that is stable per content (so re-uploads are one asset and one
 * write) and unpredictable from it (so the url is not a hash of the file).
 * 40 hex characters, which is Cloudinary's public id length limit.
 */
export async function publicIdFor(env, sha) {
  const mac = await hmac(env.CLOUDINARY_SALT, 'SHA-256', sha);
  return bytesToHex(mac).slice(0, 40);
}

/**
 * Uploads bytes and returns `{ url, rid, size, deduped, type }`.
 *
 * `overwrite` means the same bytes from a second post cost nothing: the second
 * call rewrites the same public id instead of adding an asset, and the caller
 * already knows the content is present because it matched on the digest.
 */
export async function upload(env, { bytes, sha, mime, name }) {
  const cloud = env.CLOUDINARY_CLOUD_NAME;
  const publicId = await publicIdFor(env, sha);
  const stamp = Math.floor(Date.now() / 1000);

  const form = new FormData();
  form.set('file', new Blob([bytes], { type: mime || 'application/octet-stream' }), name || 'blob');
  form.set('api_key', env.CLOUDINARY_API_KEY);
  form.set('public_id', publicId);
  form.set('timestamp', String(stamp));
  form.set('overwrite', 'true');
  form.set('invalidate', 'true');
  // A paste's images are shown next to the code, so a 1200 px rendition is
  // enough to read them and small enough to page through a gallery on a phone.
  if (/^image\//i.test(mime || '')) {
    form.set('eager', 'c_limit,w_1600,dpr_auto,q_auto:80|c_fill,w_400,h_300,dpr_auto,q_auto:70');
    form.set('quality', 'auto');
    form.set('fetch_format', 'auto');
  }

  const signed = {};
  for (const [k, v] of form.entries()) if (typeof v === 'string') signed[k] = v;
  form.set('signature', await signature(env, signed));

  const res = await fetch(`https://api.cloudinary.com/v1_1/${cloud}/auto/upload`, {
    method: 'POST', body: form,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`cloudinary upload failed: ${res.status} ${detail.slice(0, 200)}`);
  }
  const json = await res.json();
  return {
    url: json.secure_url,
    rid: json.public_id,
    resourceType: json.resource_type,
    size: json.bytes ?? bytes.byteLength,
    width: json.width || 0,
    height: json.height || 0,
    format: json.format || '',
  };
}

/** The resource types the admin API can act on, and nothing else. */
const RESOURCE_TYPES = new Set(['image', 'video', 'raw']);

/**
 * The resource type an asset was stored under.
 *
 * `auto` is an upload-time convenience - it infers the type from the bytes being
 * sent - and there is nothing to infer from in a destroy, so `auto/destroy` is
 * not a valid admin call. The type has to be named, and the stored delivery url
 * is the record of what Cloudinary was actually told; the mime is the fallback for
 * a row whose url was never written.
 */
export function resourceTypeOf(url, mime) {
  const parts = partsOf(url);
  if (parts && RESOURCE_TYPES.has(parts.resourceType)) return parts.resourceType;
  if (typeof mime === 'string') {
    if (mime.startsWith('image/')) return 'image';
    if (mime.startsWith('video/')) return 'video';
  }
  // Everything Cloudinary did not treat as a media asset is a raw file, which is
  // where archives and documents live. A wrong-but-existing type is worth less
  // than a leaked asset, so this has to return something valid.
  return 'raw';
}

/** Deletes an asset. A takedown has to take the bytes with it, not just the row. */
export async function destroy(env, rid, url = '', mime = '') {
  if (!rid || !cloudinaryReady(env)) return false;
  const form = new FormData();
  form.set('public_id', rid);
  form.set('timestamp', String(Math.floor(Date.now() / 1000)));
  const signed = {};
  for (const [k, v] of form.entries()) if (typeof v === 'string') signed[k] = v;
  form.set('signature', await signature(env, signed));
  const res = await fetch(
    `https://api.cloudinary.com/v1_1/${env.CLOUDINARY_CLOUD_NAME}/${resourceTypeOf(url, mime)}/destroy`,
    { method: 'POST', body: form },
  );
  return res.ok;
}

/** A url of the form https://res.cloudinary.com/<cloud>/<type>/upload/<id>. */
function partsOf(url) {
  const m = /^https:\/\/res\.cloudinary\.com\/[^/]+\/([^/]+)\/upload\/(.+)$/.exec(url || '');
  return m ? { resourceType: m[1], publicId: m[2] } : null;
}

/**
 * Injects a transformation before the public id. `c_limit` keeps the aspect
 * ratio and never upscales, which is what stops a 400 px screenshot being
 * stretched into a blurry 1600 px mess.
 */
export function transformed(url, transformation) {
  const parts = partsOf(url);
  if (!parts || !transformation) return url;
  if (parts.resourceType !== 'image' && parts.resourceType !== 'video') return url;
  return url.replace('/upload/', `/upload/${transformation}/`);
}

const PREVIEW = 'c_limit,w_1400,dpr_auto,q_auto,f_auto';
const THUMB = 'c_fill,w_320,h_240,dpr_auto,q_auto,f_auto,c_pad';

/** What the gallery shows: a 1400 px rendition rather than the original. */
export function previewUrl(url) {
  return transformed(url, PREVIEW);
}

/** What the gallery's strip shows: 320x240, cropped and padded, so the strip is even. */
export function thumbUrl(url) {
  return transformed(url, THUMB);
}

/** A video's poster frame, taken from the first second of the asset. */
export function posterUrl(url) {
  return transformed(url, 'so_1');
}
