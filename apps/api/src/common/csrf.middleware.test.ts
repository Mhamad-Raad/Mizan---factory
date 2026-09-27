import { describe, expect, it } from 'vitest';
import type { Response } from 'express';
import { CsrfMiddleware, appOrigin } from './csrf.middleware.js';
import type { RequestWithContext } from './request-context.js';

/** A write with no session cookie: only the Origin/Referer check applies to it. */
function passes(appBaseUrl: string, headers: Record<string, string>): boolean {
  const request = { method: 'POST', headers, cookies: {} } as unknown as RequestWithContext;
  let passed = false;
  try {
    new CsrfMiddleware(appBaseUrl).use(request, {} as Response, () => {
      passed = true;
    });
  } catch {
    return false;
  }
  return passed;
}

describe('the Origin check against APP_BASE_URL', () => {
  it('reads APP_BASE_URL as an origin, whatever trailing slash, path or default port it was written with', () => {
    expect(appOrigin('https://mizan.example/')).toBe('https://mizan.example');
    expect(appOrigin('https://mizan.example:443')).toBe('https://mizan.example');
    expect(appOrigin('https://mizan.example/app/')).toBe('https://mizan.example');
    expect(appOrigin('http://localhost:5173')).toBe('http://localhost:5173');
  });

  it.each(['https://mizan.example/', 'https://mizan.example:443', 'https://mizan.example'])(
    'lets the app itself write when APP_BASE_URL is %s',
    (base) => {
      expect(passes(base, { origin: 'https://mizan.example' })).toBe(true);
      expect(passes(base, { referer: 'https://mizan.example/orders?page=2' })).toBe(true);
      expect(passes(base, {})).toBe(true);
    },
  );

  it('refuses another site, another port, and an origin that names none', () => {
    const base = 'https://mizan.example/';
    expect(passes(base, { origin: 'https://evil.example' })).toBe(false);
    expect(passes(base, { origin: 'https://mizan.example:8443' })).toBe(false);
    expect(passes(base, { origin: 'http://mizan.example' })).toBe(false);
    expect(passes(base, { origin: 'null' })).toBe(false);
    expect(passes(base, { origin: 'null', referer: 'https://mizan.example/orders' })).toBe(false);
    expect(passes(base, { referer: 'https://evil.example/page' })).toBe(false);
    expect(passes(base, { referer: 'not a url' })).toBe(false);
  });
});
