type Props = {
  size?: number;
  className?: string;
  /** Cream/orange on dark UI; black/orange on light backgrounds. */
  ink?: "cream" | "black";
  /** @deprecated Bracket lockup removed — kept for call-site compat; ignored. */
  compact?: boolean;
};

const cream = "#f4f0e5";
const black = "#17110b";
const hot = "#ff4d1c";

/** Twin-wave Floe mark — cream front, orange back (brand palette). */
export function FloeBrandIcon({ size = 32, className = "", ink = "cream" }: Props) {
  const front = ink === "cream" ? cream : black;

  return (
    <svg
      viewBox="0 0 100 100"
      width={size}
      height={size}
      className={className}
      role="img"
      aria-label="Floe"
    >
      <path
        d="M14 58 C28 44 38 44 50 58 C62 72 72 72 86 58"
        stroke={hot}
        strokeWidth="11"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      <path
        d="M10 44 C24 30 34 30 46 44 C58 58 68 58 82 44"
        stroke={front}
        strokeWidth="11"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}
