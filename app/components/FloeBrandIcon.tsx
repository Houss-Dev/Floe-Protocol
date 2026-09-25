import Image from "next/image";

type Props = {
  size?: number;
  className?: string;
};

/** Official Floe mark (violet on black). */
export function FloeBrandIcon({ size = 32, className = "" }: Props) {
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center overflow-hidden rounded-lg bg-[#0b0b0f] ${className}`}
      style={{ width: size, height: size }}
    >
      <Image
        src="/floe-logo.png"
        alt=""
        width={size}
        height={size}
        className="h-full w-full object-contain"
        priority
        aria-hidden
      />
    </span>
  );
}
