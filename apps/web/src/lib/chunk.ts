/**
 * Asking twice for a screen's chunk (NFR-03's route splitting, FR-1305's connection).
 *
 * `React.lazy` asks its factory exactly once and remembers the answer — including a rejection —
 * so a file that failed to arrive on a factory floor with two bars of signal would stay failed
 * for the life of the page however many times the employee taps. One retry after a short pause
 * covers the ordinary dropout; a second failure is a real one (the tab is offline, or the
 * server was deployed and the content-hashed file is gone), and `RouteBoundary` turns it into a
 * screen that says so and offers the reload that actually fixes it.
 */
export async function loadTwice<T>(load: () => Promise<T>, pauseMs = 600): Promise<T> {
  try {
    return await load();
  } catch {
    await new Promise((resolve) => setTimeout(resolve, pauseMs));
    try {
      return await load();
    } catch (error) {
      throw new ChunkLoadError(error);
    }
  }
}

/**
 * A screen's file that did not arrive — told apart from a screen that arrived and then failed
 * to draw, because the two need different words: "check your connection" is the right advice
 * for the first and a wrong one for the second.
 */
export class ChunkLoadError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'ChunkLoadError';
  }
}
