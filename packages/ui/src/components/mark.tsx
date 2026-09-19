/**
 * The Mizan mark (spec 3.2.2): a balance beam with two pans drawn as one continuous stroke —
 * the pan at one end holds a stack of three bars (materials), the other a coin. Monochrome:
 * it takes its colour from `currentColor`, so the same file serves the plum mark on light, the
 * light plum on dark and the brass variant on the login panel, with no second asset.
 *
 * "Mizan" is Arabic and Kurdish for scale, or balance. The mark is the product's whole idea:
 * goods on one side, money on the other, and the beam level.
 */
export interface MarkProps {
  size?: number;
  /** The wordmark beside the beam, in the current language. */
  title?: string;
}

export function MizanMark({ size = 32, title }: MarkProps) {
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
      {/* the column and the beam */}
      <path d="M24 9v30M14 39h20M10 15h28" />
      {/* the pivot */}
      <circle cx="24" cy="15" r="2.6" fill="currentColor" stroke="none" />
      {/* the pans, hung from each end of the beam */}
      <path d="M10 15l-5 9a5 5 0 0 0 10 0z" />
      <path d="M38 15l-5 9a5 5 0 0 0 10 0z" />
      {/* materials in one pan: three bars */}
      <path d="M7 21.5h6M8 19h4" strokeWidth={1.6} />
      {/* money in the other: a coin */}
      <circle cx="38" cy="20.5" r="2.2" strokeWidth={1.6} />
    </svg>
  );
}
