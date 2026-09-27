/**
 * Drafts (spec 2.10.2). A half-typed order survives a reload, a dropped connection or a
 * locked screen, and it carries **its own idempotency key** — so the retry after a timeout is
 * the same request, and the order is never written twice (FR-1305).
 *
 * Storage may throw (private mode, quota, disabled), so every path here is safe to fail:
 * a draft is a convenience, never the record.
 */
const PREFIX = 'mizan.draft.';

export interface Draft<T> {
  form: string;
  id: string;
  /** Reused across retries of the same submission, never across submissions. */
  idempotency_key: string;
  saved_at: number;
  value: T;
}

function keyOf(form: string, id: string): string {
  return `${PREFIX}${form}.${id}`;
}

export function readDraft<T>(form: string, id = 'new'): Draft<T> | null {
  try {
    const raw = window.localStorage.getItem(keyOf(form, id));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Draft<T>;
    if (!parsed || typeof parsed !== 'object' || !parsed.idempotency_key) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeDraft<T>(form: string, id: string, value: T, idempotencyKey: string): void {
  try {
    const draft: Draft<T> = {
      form,
      id,
      idempotency_key: idempotencyKey,
      saved_at: Date.now(),
      value,
    };
    window.localStorage.setItem(keyOf(form, id), JSON.stringify(draft));
  } catch {
    // Nothing to do: the form keeps working, it simply will not survive a reload.
  }
}

export function clearDraft(form: string, id = 'new'): void {
  try {
    window.localStorage.removeItem(keyOf(form, id));
  } catch {
    /* ignored on purpose */
  }
}

/**
 * The autosave of one form while it is open. Once the record is saved, `finish()` clears the
 * draft **and stops the autosave for good**: the save hands out a fresh idempotency key, which
 * re-arms the form's autosave timer, and without the stop that timer wrote the saved form back
 * as a draft while the lists refreshed — the next "New order" then offered to restore an order
 * that already existed, and restoring it saved it twice.
 */
export interface DraftKeeper<T> {
  write: (value: T, idempotencyKey: string) => void;
  finish: () => void;
  readonly finished: boolean;
}

export function createDraftKeeper<T>(form: string, id = 'new'): DraftKeeper<T> {
  let finished = false;
  return {
    write(value, idempotencyKey) {
      if (!finished) writeDraft(form, id, value, idempotencyKey);
    },
    finish() {
      finished = true;
      clearDraft(form, id);
    },
    get finished() {
      return finished;
    },
  };
}

/** Every draft of every form, cleared on sign-out and on a user switch (spec 2.10.2). */
export function clearAllDrafts(): void {
  try {
    const keys: string[] = [];
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (key?.startsWith(PREFIX)) keys.push(key);
    }
    for (const key of keys) window.localStorage.removeItem(key);
  } catch {
    /* ignored on purpose */
  }
}
