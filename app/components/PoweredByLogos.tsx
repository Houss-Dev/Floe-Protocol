const MARKS = {
  Solana: { src: "/brands/solana.svg", alt: "Solana" },
  "Pyth Network": { src: "/brands/pyth.svg", alt: "Pyth Network" },
  "Token-2022": { src: "/brands/token2022.svg", alt: "Token-2022" },
  Anchor: { src: "/brands/anchor.png", alt: "Anchor" },
} as const;

export function PoweredByItem({ name }: { name: keyof typeof MARKS }) {
  const mark = MARKS[name];
  return (
    <div className="flex items-center gap-3 text-foreground">
      <img src={mark.src} alt="" className="h-10 w-10 shrink-0 object-contain" />
      <span className="ll-content-title">{name}</span>
    </div>
  );
}
