const TOKEN_ICON: Record<string, string> = {
  SPYx: "/tokens/spy.png",
  QQQx: "/tokens/qqq.png",
  PRE1x: "/tokens/pre1x.svg",
  USDC: "/tokens/usdc.svg",
};

export function TapeTokenIcon({ ticker, size = 36 }: { ticker: string; size?: number }) {
  const src = TOKEN_ICON[ticker];

  if (src) {
    return (
      <img
        src={src}
        alt=""
        width={size}
        height={size}
        className="shrink-0 rounded-full bg-white object-contain p-0.5"
        aria-hidden
      />
    );
  }

  return (
    <div
      className="grid shrink-0 place-items-center rounded-full bg-hot/15 font-mono text-[10px] font-bold text-hot"
      style={{ width: size, height: size }}
    >
      {ticker.slice(0, 3)}
    </div>
  );
}
