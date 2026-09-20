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
