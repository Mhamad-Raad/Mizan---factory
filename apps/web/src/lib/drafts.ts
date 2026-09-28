/**
 * Drafts (spec 2.10.2). A half-typed order survives a reload, a dropped connection or a
 * locked screen, and it carries **its own idempotency key** — so the retry after a timeout is
 * the same request, and the order is never written twice (FR-1305).
 *
 * Storage may throw (private mode, quota, disabled), so every path here is safe to fail:
 * a draft is a convenience, never the record.
 *
 * Drafts belong to the person who typed them. They are stored under the signed-in user's id, so
 * on a shared tablet the next employee is never offered the last one's half-typed order — even
 * when the device was not signed out cleanly (a session that expired, a browser that closed).
 */
const PREFIX = 'mizan.draft.';

/** Whose drafts are read and written; set with the session (`useApp.setSession`). */
let owner: string | null = null;

export function setDraftOwner(userId: string | null): void {
  owner = userId;
}

export interface Draft<T> {
  form: string;
  id: string;
  /** Reused across retries of the same submission, never across submissions. */
  idempotency_key: string;
  saved_at: number;
  value: T;
}

function keyOf(form: string, id: string): string | null {
  // Nobody signed in: nothing is anybody's draft.
  return owner === null ? null : `${PREFIX}${owner}.${form}.${id}`;
}

export function readDraft<T>(form: string, id = 'new'): Draft<T> | null {
  const key = keyOf(form, id);
  if (key === null) return null;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Draft<T>;
    if (!parsed || typeof parsed !== 'object' || !parsed.idempotency_key) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeDraft<T>(form: string, id: string, value: T, idempotencyKey: string): void {
  const key = keyOf(form, id);
  if (key === null) return;
  try {
    const draft: Draft<T> = {
      form,
      id,
      idempotency_key: idempotencyKey,
      saved_at: Date.now(),
      value,
    };
    window.localStorage.setItem(key, JSON.stringify(draft));
  } catch {
    // Nothing to do: the form keeps working, it simply will not survive a reload.
  }
}

export function clearDraft(form: string, id = 'new'): void {
  const key = keyOf(form, id);
  if (key === null) return;
  try {
    window.localStorage.removeItem(key);
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

/** Every draft of every form, cleared on sign-out (spec 2.10.2). */
export function clearAllDrafts(): void {
  clearDraftsExcept(null);
}

/**
 * Every draft but `userId`'s, cleared when somebody signs in (spec 2.10.2: a user switch clears
 * them). The one signing in keeps their own: a session that expired, or a 401 on a fresh load,
 * is not a sign-out, and the order they were half-way through is still theirs.
 */
export function clearDraftsExcept(userId: string | null): void {
  const own = userId === null ? null : `${PREFIX}${userId}.`;
  try {
    const keys: string[] = [];
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (key?.startsWith(PREFIX) && (own === null || !key.startsWith(own))) keys.push(key);
    }
    for (const key of keys) window.localStorage.removeItem(key);
  } catch {
    /* ignored on purpose */
  }
}
