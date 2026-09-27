import { describe, expect, it } from 'vitest';
import { isDevelopmentHost, loadEnv } from './env.js';

const base = { DATABASE_URL: 'postgresql://x', SESSION_PEPPER: 'a-pepper-long-enough-0123' };

describe('the environment (security review, finding 13)', () => {
  it('refuses development settings on a public address, and says how to fix it', () => {
    expect(() => loadEnv({ ...base, APP_BASE_URL: 'https://mizan.example.com' })).toThrow(
      /NODE_ENV is "development" \(the default when it is not set\).*Set NODE_ENV=production/s,
    );
    expect(() =>
      loadEnv({ ...base, NODE_ENV: 'development', APP_BASE_URL: 'https://mizan.example.com' }),
    ).toThrow(/Secure/);
  });

  it('keeps development working on this machine and on a private network', () => {
    expect(loadEnv({ ...base }).NODE_ENV).toBe('development');
    for (const url of ['http://localhost:5173', 'http://127.0.0.1:5173', 'http://192.168.1.20:5173', 'http://10.0.0.5', 'http://mizan.local']) {
      expect(isDevelopmentHost(url)).toBe(true);
    }
    for (const url of ['https://mizan.example.com', 'http://8.8.8.8', 'http://172.32.0.1', 'not a url']) {
      expect(isDevelopmentHost(url)).toBe(false);
    }
  });

  it('lets production and test run anywhere', () => {
    expect(loadEnv({ ...base, NODE_ENV: 'production', APP_BASE_URL: 'https://mizan.example.com' }).NODE_ENV).toBe(
      'production',
    );
    expect(loadEnv({ ...base, NODE_ENV: 'test', APP_BASE_URL: 'https://mizan.example.com' }).NODE_ENV).toBe('test');
  });

  it('reads TRUST_PROXY as a hop count, a switch or a list', () => {
    expect(loadEnv({ ...base }).TRUST_PROXY).toBe(false);
    expect(loadEnv({ ...base, TRUST_PROXY: '1' }).TRUST_PROXY).toBe(1);
    expect(loadEnv({ ...base, TRUST_PROXY: 'true' }).TRUST_PROXY).toBe(true);
    expect(loadEnv({ ...base, TRUST_PROXY: 'loopback, 172.16.0.0/12' }).TRUST_PROXY).toBe('loopback, 172.16.0.0/12');
  });
});
