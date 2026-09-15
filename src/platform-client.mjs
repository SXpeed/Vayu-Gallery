const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export class PlatformError extends Error {
  constructor(message, { status = 0, code = 'REQUEST_FAILED', requestId } = {}) {
    super(message);
    this.name = 'PlatformError';
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

function csrfCookie(cookieText, secure) {
  const name = secure ? '__Host-vayu-csrf' : 'vayu-csrf';
  const matches = String(cookieText).split(';').map(part => part.trim()).filter(part => part.startsWith(`${name}=`));
  if (matches.length !== 1) return '';
  try { return decodeURIComponent(matches[0].slice(name.length + 1)); } catch { return ''; }
}

function validatePath(path) {
  if (typeof path !== 'string' || !path.startsWith('/api/') || /[\\#\s]/.test(path)) throw new TypeError('Use a same-origin API path.');
  const pathname = path.split('?')[0];
  if (/%(?:2e|2f|5c)/i.test(pathname) || pathname.split('/').some(part => part === '.' || part === '..' || part === '' && pathname.indexOf(part) > 0)) {
    throw new TypeError('Invalid API path.');
  }
  if (pathname.includes('//')) throw new TypeError('Invalid API path.');
  return pathname;
}

// Dependencies are injectable for deterministic tests. The browser uses only
// same-origin requests and its HttpOnly session cookie; no session token is stored.
export function createPlatformClient({
  fetch: fetcher = (...args) => globalThis.fetch(...args),
  cookies = () => globalThis.document?.cookie || '',
  secure = () => globalThis.location?.protocol === 'https:',
} = {}) {
  let generation = 0;
  let selected = null;
  let disposed = false;
  const pending = new Set();
  const changed = () => new PlatformError('The gallery changed. This request was cancelled; reload the original gallery to check whether changes completed.', { code: 'SCOPE_CHANGED' });
  const invalidate = () => {
    generation += 1;
    for (const controller of pending) controller.abort();
    pending.clear();
  };

  async function request(path, { method, body, version, signal } = {}) {
    if (disposed) throw new PlatformError('This workspace has closed.', { code: 'CLIENT_DISPOSED' });
    const pathname = validatePath(path);
    const tenant = pathname.match(/^\/api\/galleries\/([^/]+)(?:\/|$)/)?.[1];
    if (tenant && (!selected || tenant !== selected.id)) throw new PlatformError('Select this gallery before requesting its records.', { code: 'GALLERY_SCOPE' });
    const started = generation;
    const scope = selected;
    const verb = (method || (body === undefined ? 'GET' : 'POST')).toUpperCase();
    if (!['GET', 'HEAD', ...UNSAFE].includes(verb)) throw new TypeError('Unsupported HTTP method.');
    if (!UNSAFE.has(verb) && body !== undefined) throw new TypeError('Read requests cannot include a body.');
    const headers = { Accept: 'application/json' };
    if (UNSAFE.has(verb)) {
      const csrf = csrfCookie(cookies(), secure());
      if (!csrf) throw new PlatformError('Your security token is unavailable. Refresh this page or sign in again.', { status: 403, code: 'CSRF' });
      headers['Content-Type'] = 'application/json';
      headers['X-CSRF-Token'] = csrf;
    }
    if (version !== undefined) {
      if (!Number.isSafeInteger(version) || version < 1) throw new TypeError('A positive record version is required.');
      headers['If-Match'] = `"${version}"`;
    }
    if (tenant && scope?.accessId) headers['X-Provider-Access'] = scope.accessId;
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    pending.add(controller);
    try {
      const response = await fetcher(path, {
        method: verb, headers, credentials: 'same-origin', cache: 'no-store', redirect: 'error',
        signal: controller.signal,
        ...(UNSAFE.has(verb) ? { body: JSON.stringify(body ?? {}) } : {}),
      });
      if (started !== generation || disposed) throw changed();
      const data = response.status === 204 ? null : await response.json().catch(() => null);
      if (started !== generation || disposed) throw changed();
      if (controller.signal.aborted) throw new DOMException('Request cancelled.', 'AbortError');
      if (!response.ok) throw new PlatformError(data?.error?.message || 'The request could not be completed. Please try again.', {
        status: response.status, code: data?.error?.code || 'REQUEST_FAILED',
        requestId: data?.requestId || response.headers?.get('X-Request-ID'),
      });
      if (data === null && response.status !== 204) throw new PlatformError('The server returned an unreadable response.', { status: response.status, code: 'INVALID_RESPONSE' });
      return data;
    } catch (error) {
      if (started !== generation || disposed) throw changed();
      throw error;
    } finally {
      pending.delete(controller);
      signal?.removeEventListener('abort', abort);
    }
  }

  return {
    request,
    async session() {
      const value=await request('/api/session');
      if(!UUID.test(value?.id||'')||typeof value.name!=='string'||typeof value.email!=='string'||typeof value.provider!=='boolean'||!Array.isArray(value.organizations)||value.organizations.some(o=>!UUID.test(o.id||'')))throw new PlatformError('This server is not a compatible gallery platform.',{code:'INVALID_SESSION'});
      return value;
    },
    bindGallery(id) {
      if(!selected||selected.id!==id)throw new PlatformError('Choose this gallery first.',{code:'GALLERY_SCOPE'});
      const boundGeneration=generation;
      return {galleryRequest(suffix,options){
        if(disposed||boundGeneration!==generation)return Promise.reject(changed());
        if(typeof suffix!=='string'||!suffix||suffix.startsWith('/')||suffix.startsWith('?'))return Promise.reject(new TypeError('Use a gallery resource path.'));
        return request(`/api/galleries/${id}/${suffix}`,options);
      }};
    },
    selectGallery(id, accessId) {
      if (disposed) throw new PlatformError('This workspace has closed.', { code: 'CLIENT_DISPOSED' });
      if (id !== null && id !== undefined && !UUID.test(id)) throw new TypeError('Invalid gallery identifier.');
      if (accessId !== undefined && accessId !== null && !UUID.test(accessId)) throw new TypeError('Invalid provider access identifier.');
      invalidate();
      selected = id ? Object.freeze({ id, accessId: accessId || null }) : null;
    },
    galleryRequest(suffix, options) {
      if (!selected) return Promise.reject(new PlatformError('Choose a gallery first.', { code: 'GALLERY_REQUIRED' }));
      if (typeof suffix !== 'string' || !suffix || suffix.startsWith('/') || suffix.startsWith('?')) return Promise.reject(new TypeError('Use a gallery resource path.'));
      return request(`/api/galleries/${selected.id}/${suffix}`, options);
    },
    async logout() {
      invalidate();
      selected = null;
      return request('/api/logout', { method: 'POST', body: {} });
    },
    dispose() { invalidate(); selected = null; disposed = true; },
  };
}
