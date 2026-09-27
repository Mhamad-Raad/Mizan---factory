import { afterEach, describe, expect, it } from 'vitest';
import { createDraftKeeper, readDraft } from './drafts.js';

/**
 * A saved order must not come back as a draft (spec 2.10.2, FR-1305). The save hands out a new
 * idempotency key, which re-armed the form's 300 ms autosave, and the timer wrote the saved form
 * back while the lists refreshed — so the next "New order" offered it again, and restoring it
 * saved the same order twice.
 */
describe('the autosave of an open form', () => {
  afterEach(() => window.localStorage.clear());

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
