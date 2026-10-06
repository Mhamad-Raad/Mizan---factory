/**
 * The idle sign-out (D-078): a user who does nothing for this long is signed out, on every
 * device. One figure for the browser, which measures idleness, and the server, which stands
 * behind it — so it lives where both read it.
 */
export const SESSION_IDLE_MINUTES = 15;

/** The last part of those minutes is a warning that a press or a key answers. */
export const SESSION_IDLE_WARNING_SECONDS = 60;
