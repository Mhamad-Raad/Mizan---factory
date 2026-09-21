import { useEffect, useState } from 'react';

/**
 * A typed value, held back until the typing stops (NFR-03).
 *
 * Every search field in the system — the material, customer, company and document pickers
 * since I1, and global search since I4 — used the raw input as its query key, so a twelve-letter
 * customer name was eleven requests. On the reference connection of NFR-03 (400 kbps, 400 ms
 * round trip) that is a request storm on a factory's phone for one search, and the answers land
 * in whatever order they come back in.
 *
 * 250 ms is chosen to be under the 400 ms round trip: the request for what somebody has finished
 * typing leaves before the answer to the previous one could have arrived anyway.
 */
export function useDebouncedValue<T>(value: T, delayMs = 250): T {
  const [held, setHeld] = useState(value);

  useEffect(() => {
    if (value === held) return;
    const timer = setTimeout(() => setHeld(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, held, delayMs]);

  return held;
}
