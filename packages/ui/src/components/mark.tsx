/**
 * The Jiyan mark: the Ĵ of Jiyan's own logo — the letter with its circumflex, and the swoosh
 * that sweeps beneath the wordmark. Drawn as open strokes that take `currentColor`, so the same
 * file serves the sidebar, the sign-in panel and every theme; the favicon and the home-screen
 * icons draw the same letter in white on the logo's red.
 */
export interface MarkProps {
  size?: number;
  /** The wordmark beside the mark, in the current language. */
  title?: string;
}

export function BrandMark({ size = 32, title }: MarkProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      {/* the circumflex of the Ĵ */}
      <path d="M21.5 7.5 25 4.5 28.5 7.5" strokeWidth={2.4} />
      {/* the J: a stem and its hook */}
      <path d="M25 12.5V28.5C25 34.5 21 37.5 15 36.5" strokeWidth={5.6} />
      {/* the swoosh of the logo, sweeping beneath the letter */}
      <path d="M8.5 38.5C17 45 31 45 40.5 35.5" strokeWidth={1.9} />
    </svg>
  );
}
