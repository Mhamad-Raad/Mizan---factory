import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { signOutEverywhereHere } from './signOut.js';

describe('signing out forgets the previous user (security review, finding 8)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  function seeded(): QueryClient {
    const client = new QueryClient();
    client.setQueryData(['customers'], [{ name: 'Kawa', balance: 13_100 }]);
    window.localStorage.setItem('mizan.draft.v1:order:new', '{"lines":[]}');
    window.localStorage.setItem('mizan.prefs.v1', '{"lang":"ckb-IQ"}');
    return client;
  }

  it('clears the cache, the drafts and the session when the server signs out', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 204, text: async () => '' }));
    const client = seeded();
    const clearSession = vi.fn();

    await signOutEverywhereHere(client, clearSession);

    expect(client.getQueryData(['customers'])).toBeUndefined();
    expect(window.localStorage.getItem('mizan.draft.v1:order:new')).toBeNull();
    // The device's own preferences are not the user's data and stay.
    expect(window.localStorage.getItem('mizan.prefs.v1')).not.toBeNull();
    expect(clearSession).toHaveBeenCalledOnce();
  });

  it('forgets everything here even when the sign-out request fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')));
    const client = seeded();
    const clearSession = vi.fn();

    await expect(signOutEverywhereHere(client, clearSession)).resolves.toBeUndefined();
    expect(client.getQueryData(['customers'])).toBeUndefined();
    expect(window.localStorage.getItem('mizan.draft.v1:order:new')).toBeNull();
    expect(clearSession).toHaveBeenCalledOnce();
  });
});
