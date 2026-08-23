/**
 * The WolffMsg mark.
 *
 * An angular wolf head built from straight edges only — no curves — so it
 * stays crisp at 20px in a header and at 120px on the sign-in screen. The eyes
 * and muzzle are negative space (`fill-rule: evenodd`) rather than separate
 * shapes, which keeps the silhouette readable when it is filled with the
 * aurora gradient.
 */

interface LogoProps {
  size?: number;
  /** `mark` is the glyph alone; `full` sets it beside the wordmark. */
  variant?: 'mark' | 'full';
  className?: string;
  /** Renders in a single flat colour instead of the gradient. */
  monochrome?: boolean;
}

const HEAD =
  'M20 9.6 L26.4 5.4 L32.9 2 L34.6 14.6 L31.6 2' +
  '4.6 L20 37.4 L8.4 24.6 L5.4 14.6 L7.1 2 L13.6 5.4 Z';
const LEFT_EYE = 'M12.9 17.6 L18.6 19.9 L13.6 21.6 Z';
const RIGHT_EYE = 'M27.1 17.6 L21.4 19.9 L26.4 21.6 Z';
const MUZZLE = 'M20 25.4 L22.9 28.6 L20 31.8 L17.1 28.6 Z';

let gradientSeq = 0;

export function Logo({
  size = 32,
  variant = 'mark',
  className,
  monochrome = false,
}: LogoProps) {
  // A unique id per instance: two logos on one page must not share a gradient
  // definition, or the second silently inherits the first.
  gradientSeq += 1;
  const gradientId = `wolff-aurora-${gradientSeq}`;

  const mark = (
    <svg
      width={size}
      height={size}
      viewBox="0 0 40 40"
      fill="none"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      {!monochrome && (
        <defs>
          <linearGradient id={gradientId} x1="4" y1="3" x2="36" y2="37">
            <stop offset="0%" stopColor="var(--accent-deep)" />
            <stop offset="48%" stopColor="var(--accent)" />
            <stop offset="100%" stopColor="var(--accent-cyan)" />
          </linearGradient>
        </defs>
      )}
      <path
        d={`${HEAD} ${LEFT_EYE} ${RIGHT_EYE} ${MUZZLE}`}
        fill={monochrome ? 'currentColor' : `url(#${gradientId})`}
        fillRule="evenodd"
        clipRule="evenodd"
      />
    </svg>
  );

  if (variant === 'mark') return mark;

  return (
    <span className="logo-lockup">
      {mark}
      <span className="logo-wordmark">
        WOLFF<span className="logo-wordmark-accent">MSG</span>
      </span>
    </span>
  );
}

/**
 * The large sign-in treatment: the mark sitting inside a soft aurora halo,
 * with a slow ambient drift so the screen is not completely static.
 */
export function LogoHero({ size = 96 }: { size?: number }) {
  return (
    <div className="logo-hero" style={{ '--hero-size': `${size}px` } as React.CSSProperties}>
      <span className="logo-hero-halo" aria-hidden="true" />
      <Logo size={size} />
    </div>
  );
}
