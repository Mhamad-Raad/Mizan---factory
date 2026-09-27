/**
 * The Jiyan mark: a box — the warehouse's stock — with a sprout rising from its lid. "Jiyan"
 * is Kurdish for life: goods that come in, move and keep the business growing. Drawn as open
 * strokes that take `currentColor`, so the same file serves the mark on light, on dark and on
 * the sign-in panel, with no second asset; it reads at the favicon's 16 px as a box and a leaf.
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
      {/* the box: its lid, and the two faces below it */}
      <path d="M24 20 37 26.5 24 33 11 26.5Z" />
      <path d="M11 26.5V36L24 42.5 37 36V26.5M24 33V42.5" />
      {/* the sprout: a stem from the lid, and two leaves */}
      <path d="M24 20V11" />
      <path d="M24 14.5C24 9.5 27.5 6 33 6 33 11 29.5 14.5 24 14.5Z" fill="currentColor" stroke="none" />
      <path d="M24 17C24 13.2 21.2 10.5 17 10.5 17 14.3 19.8 17 24 17Z" fill="currentColor" stroke="none" />
    </svg>
  );
}
