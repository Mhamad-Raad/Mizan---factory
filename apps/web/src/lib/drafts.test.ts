import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearAllDrafts, clearDraftsExcept, createDraftKeeper, readDraft, setDraftOwner, writeDraft } from './drafts.js';

/**
 * A saved order must not come back as a draft (spec 2.10.2, FR-1305). The save hands out a new
 * idempotency key, which re-armed the form's 300 ms autosave, and the timer wrote the saved form
 * back while the lists refreshed — so the next "New order" offered it again, and restoring it
 * saved the same order twice.
 */
describe('the autosave of an open form', () => {
  beforeEach(() => setDraftOwner('user-a'));
  afterEach(() => {
    window.localStorage.clear();
    setDraftOwner(null);
  });

  it('keeps what is typed until the record is saved', () => {
    const keeper = createDraftKeeper<{ note: string }>('order');
    keeper.write({ note: 'half typed' }, 'key-1');
    expect(readDraft<{ note: string }>('order')?.value).toEqual({ note: 'half typed' });
    expect(readDraft('order')?.idempotency_key).toBe('key-1');
  });

  it('clears the draft on save and writes nothing after it', () => {
    const keeper = createDraftKeeper<{ note: string }>('order', 'o-1');
    keeper.write({ note: 'before save' }, 'key-1');
    keeper.finish();
    expect(readDraft('order', 'o-1')).toBeNull();

    // The timer the new idempotency key re-armed fires after the save.
    keeper.write({ note: 'before save' }, 'key-2');
    expect(readDraft('order', 'o-1')).toBeNull();
    expect(keeper.finished).toBe(true);
  });
});

/**
 * A shared tablet (2.10.2, review): drafts were stored under the form alone, so when a session
 * ended without a clean sign-out the next employee was offered the last one's half-typed order.
 */
describe('drafts belong to the person who typed them', () => {
  afterEach(() => {
    window.localStorage.clear();
    setDraftOwner(null);
  });

  it('never offers one user the draft of another', () => {
    setDraftOwner('user-a');
    createDraftKeeper<{ note: string }>('order').write({ note: "Nazdar's order" }, 'key-a');

    setDraftOwner('user-b');
    expect(readDraft('order')).toBeNull();

    setDraftOwner('user-a');
    expect(readDraft<{ note: string }>('order')?.value).toEqual({ note: "Nazdar's order" });
  });

  it('reads and writes nothing while nobody is signed in', () => {
    setDraftOwner(null);
    createDraftKeeper<{ note: string }>('order').write({ note: 'orphan' }, 'key-x');
    expect(window.localStorage.length).toBe(0);
    expect(readDraft('order')).toBeNull();
  });
});

/**
 * A 401 — an expired session, or a fresh load with nobody signed in — cleared every draft on the
 * device, so a session that timed out mid-order cost the order (review). Signing in clears the
 * *others'* drafts (a user switch, 2.10.2); only signing out clears everything.
 */
describe('which drafts go when somebody signs in or out', () => {
  afterEach(() => {
    window.localStorage.clear();
    setDraftOwner(null);
  });

  function seed(): void {
    for (const user of ['user-a', 'user-b']) {
      setDraftOwner(user);
      writeDraft('order', 'new', { note: user }, `key-${user}`);
    }
    window.localStorage.setItem('mizan.prefs.v1', '{"lang":"ckb-IQ"}');
  }

  it('keeps the draft of the one signing in, and clears everybody else\'s', () => {
    seed();
    clearDraftsExcept('user-a');
    setDraftOwner('user-a');
    expect(readDraft<{ note: string }>('order')?.value).toEqual({ note: 'user-a' });
    setDraftOwner('user-b');
    expect(readDraft('order')).toBeNull();
    expect(window.localStorage.getItem('mizan.prefs.v1')).not.toBeNull();
  });

  it('clears every draft on sign-out', () => {
    seed();
    clearAllDrafts();
    for (const user of ['user-a', 'user-b']) {
      setDraftOwner(user);
      expect(readDraft('order')).toBeNull();
    }
  });
});
