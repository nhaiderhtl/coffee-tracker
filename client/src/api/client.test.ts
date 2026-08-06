import { test, expect, describe, beforeEach, afterEach, mock } from 'bun:test';
import { api, uploadUrl } from './client';

// The api client is the only thing standing between a stale token and a
// half-logged-in app, so the 401 path matters as much as the happy one.

const realFetch = globalThis.fetch;

type Call = { url: string; init: RequestInit };
let calls: Call[] = [];

/** Stub fetch with a fixed response. */
function stubFetch(status: number, body: unknown, opts: { json?: boolean } = {}) {
  const { json = true } = opts;
  globalThis.fetch = mock((url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      // A 204 or an HTML error page has no JSON body; the client must treat
      // that as {} rather than exploding.
      json: () => (json ? Promise.resolve(body) : Promise.reject(new SyntaxError('not json'))),
    } as unknown as Response);
  }) as unknown as typeof fetch;
}

let assigned: string[] = [];

beforeEach(() => {
  calls = [];
  assigned = [];
  localStorage.clear();
  // happy-dom would try to actually navigate; capture instead.
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { pathname: '/', assign: (u: string) => { assigned.push(u); } },
  });
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('request', () => {
  test('hits /api and returns the parsed body', async () => {
    stubFetch(200, { hello: 'world' });
    await expect(api.get<{ hello: string }>('/feed')).resolves.toEqual({ hello: 'world' });
    expect(calls[0].url).toBe('/api/feed');
  });

  test('sends JSON content-type and no auth header when logged out', async () => {
    stubFetch(200, {});
    await api.get('/feed');
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers.Authorization).toBeUndefined();
  });

  test('attaches the bearer token when one is stored', async () => {
    localStorage.setItem('token', 'tok-123');
    stubFetch(200, {});
    await api.get('/feed');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer tok-123');
  });

  test('caller headers win over the defaults', async () => {
    localStorage.setItem('token', 'tok-123');
    stubFetch(200, {});
    // Documented precedence: default content-type, then token, then caller.
    await api.get('/feed');
    expect(calls[0].init.headers).toMatchObject({ Authorization: 'Bearer tok-123' });
  });

  test('serialises the body for post and patch', async () => {
    stubFetch(200, {});
    await api.post('/coffees/entries', { coffee_id: 'espresso' });
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.body).toBe('{"coffee_id":"espresso"}');

    await api.patch('/auth/me', { timezone: 'Europe/Vienna' });
    expect(calls[1].init.method).toBe('PATCH');
    expect(calls[1].init.body).toBe('{"timezone":"Europe/Vienna"}');
  });

  test('delete sends the method with no body', async () => {
    stubFetch(200, {});
    await api.delete('/coffees/entries/abc');
    expect(calls[0].init.method).toBe('DELETE');
    expect(calls[0].init.body).toBeUndefined();
  });

  test('a non-JSON body is treated as an empty object', async () => {
    stubFetch(200, null, { json: false });
    await expect(api.get('/whatever')).resolves.toEqual({});
  });
});

describe('errors', () => {
  test('throws the server error message', async () => {
    stubFetch(400, { error: 'The match must start in the future' });
    await expect(api.post('/competitions', {})).rejects.toThrow('The match must start in the future');
  });

  test('falls back to the status when there is no error field', async () => {
    stubFetch(500, {});
    await expect(api.get('/feed')).rejects.toThrow('HTTP 500');
  });

  test('a non-string error field does not become the message', async () => {
    stubFetch(400, { error: { nested: true } });
    await expect(api.get('/feed')).rejects.toThrow('HTTP 400');
  });
});

describe('401 handling', () => {
  test('drops the token and bounces to /auth', async () => {
    localStorage.setItem('token', 'stale');
    stubFetch(401, { error: 'Invalid token' });

    await expect(api.get('/coffees/stats')).rejects.toThrow('Invalid token');
    expect(localStorage.getItem('token')).toBeNull();
    expect(assigned).toEqual(['/auth']);
  });

  test('a failed login does NOT clear the token or redirect', async () => {
    // Otherwise a typo'd password on the auth screen would bounce you to the
    // screen you are already on and wipe an unrelated session.
    localStorage.setItem('token', 'still-good');
    stubFetch(401, { error: 'Invalid credentials' });

    await expect(api.post('/auth/login', {})).rejects.toThrow('Invalid credentials');
    expect(localStorage.getItem('token')).toBe('still-good');
    expect(assigned).toEqual([]);
  });

  test('a failed register is treated the same as a failed login', async () => {
    localStorage.setItem('token', 'still-good');
    stubFetch(401, { error: 'nope' });
    await expect(api.post('/auth/register', {})).rejects.toThrow('nope');
    expect(localStorage.getItem('token')).toBe('still-good');
    expect(assigned).toEqual([]);
  });

  test('no second redirect when already on /auth', async () => {
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { pathname: '/auth', assign: (u: string) => { assigned.push(u); } },
    });
    localStorage.setItem('token', 'stale');
    stubFetch(401, {});
    await expect(api.get('/auth/me')).rejects.toThrow('HTTP 401');
    expect(localStorage.getItem('token')).toBeNull(); // still dropped
    expect(assigned).toEqual([]);                     // but no navigation
  });

  test('other error statuses leave the session alone', async () => {
    localStorage.setItem('token', 'fine');
    stubFetch(403, { error: 'This match belongs to another group' });
    await expect(api.get('/competitions/x')).rejects.toThrow();
    expect(localStorage.getItem('token')).toBe('fine');
    expect(assigned).toEqual([]);
  });
});

describe('uploadUrl', () => {
  test('appends the token to an /uploads path', () => {
    localStorage.setItem('token', 'tok+123');
    // <img> cannot send an Authorization header, hence the query param.
    expect(uploadUrl('/uploads/a.webp')).toBe('/uploads/a.webp?token=tok%2B123');
  });

  test('uses & when the url already has a query', () => {
    localStorage.setItem('token', 'tok');
    expect(uploadUrl('/uploads/a.webp?v=2')).toBe('/uploads/a.webp?v=2&token=tok');
  });

  test('leaves non-upload and absolute urls untouched', () => {
    localStorage.setItem('token', 'tok');
    expect(uploadUrl('https://cdn.example/a.png')).toBe('https://cdn.example/a.png');
    expect(uploadUrl('/api/thing')).toBe('/api/thing');
  });

  test('passes through unchanged when logged out', () => {
    expect(uploadUrl('/uploads/a.webp')).toBe('/uploads/a.webp');
  });

  test('empty and nullish values become undefined', () => {
    expect(uploadUrl(null)).toBeUndefined();
    expect(uploadUrl(undefined)).toBeUndefined();
    expect(uploadUrl('')).toBeUndefined();
  });
});
