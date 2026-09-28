import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDraftKeeper, readDraft, setDraftOwner } from './drafts.js';

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
