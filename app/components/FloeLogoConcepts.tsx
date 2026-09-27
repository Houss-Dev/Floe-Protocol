type SvgProps = {
  size?: number;
  className?: string;
  /** Cream on dark backgrounds */
  ink?: "cream" | "black";
};

const cream = "#f4f0e5";
const hot = "#ff4d1c";

/** Direction 1 — wordmark only (Anton-style lockup; compact monogram for square slots). */
export function FloeLogoWordmark({
  size = 48,
  className = "",
  ink = "cream",
  compact = false,
}: SvgProps & { compact?: boolean }) {
  const fg = ink === "cream" ? cream : "#17110b";

  if (compact) {
    return (
      <svg viewBox="0 0 100 100" width={size} height={size} className={className} aria-hidden>
        <path
          d="M28 24 H58 C66 24 70 28 70 36 C70 44 66 48 58 48 H40 V76 H28 V24 Z M40 36 H56 C58 36 60 37 60 40 C60 43 58 44 56 44 H40 V36 Z"
          fill={fg}
        />
        <path
          d="M64 26 L80 42 M80 42 L64 42"
          stroke={hot}
          strokeWidth="7"
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
      </svg>
    );
  }

  return (
    <span
      className={`inline-flex items-baseline font-condensed uppercase leading-[0.85] tracking-tight ${className}`}
      style={{ fontSize: size, color: fg }}
    >
      Floe
      <span className="text-hot" style={{ fontSize: size * 0.72, marginLeft: size * 0.06 }}>
        ↗
      </span>
    </span>
  );
}

/** Direction 4 — bracket collateral: bars inside brackets, orange draw gap. */
export function FloeLogoBracket({ size = 48, className = "", ink = "cream" }: SvgProps) {
  const fg = ink === "cream" ? cream : "#17110b";
  const bg = ink === "black" ? "transparent" : "transparent";

  return (
    <svg viewBox="0 0 100 100" width={size} height={size} className={className} aria-hidden>
      {bg !== "transparent" && <rect width="100" height="100" rx="12" fill={bg} />}
      <path
        d="M30 24 H20 V76 H30"
        fill="none"
        stroke={fg}
        strokeWidth="5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M70 24 H80 V76 H70"
        fill="none"
        stroke={fg}
        strokeWidth="5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <rect x="38" y="38" width="7" height="34" rx="1.5" fill={fg} opacity="0.85" />
      <rect x="49" y="30" width="7" height="42" rx="1.5" fill={fg} />
      <rect x="60" y="44" width="7" height="28" rx="1.5" fill={fg} opacity="0.7" />
      <rect x="47" y="48" width="13" height="8" rx="2" fill={hot} />
    </svg>
  );
}

/** Direction 6 — split mark: stock bars, orange bridge, USDC stable side. */
export function FloeLogoSplit({ size = 48, className = "", ink = "cream" }: SvgProps) {
  const fg = ink === "cream" ? cream : "#17110b";
  const bg = "transparent";

  return (
    <svg viewBox="0 0 100 100" width={size} height={size} className={className} aria-hidden>
      {bg !== "transparent" && <rect width="100" height="100" rx="12" fill={bg} />}
      <rect x="16" y="42" width="6" height="30" rx="1.5" fill={fg} opacity="0.75" />
      <rect x="26" y="32" width="6" height="40" rx="1.5" fill={fg} />
      <rect x="36" y="48" width="6" height="24" rx="1.5" fill={fg} opacity="0.85" />
      <path
        d="M46 52 H54"
        stroke={hot}
        strokeWidth="6"
        strokeLinecap="round"
      />
      <path
        d="M54 52 C58 52 60 48 64 48"
        stroke={hot}
        strokeWidth="6"
        strokeLinecap="round"
        fill="none"
      />
      <circle cx="74" cy="52" r="14" fill="none" stroke={fg} strokeWidth="4" />
      <path
        d="M74 44 V60 M66 52 H82"
        stroke={fg}
        strokeWidth="3.5"
        strokeLinecap="round"
        opacity="0.9"
      />
    </svg>
  );
}
