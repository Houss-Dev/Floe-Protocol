const WALLET_ICON: Record<string, string> = {
  phantom: "/wallets/phantom.svg",
  solflare: "/wallets/solflare.svg",
  metamask: "/wallets/metamask.svg",
  okx: "/wallets/okx.svg",
};

function walletKey(name: string): string | null {
  const n = name.toLowerCase();
  if (n.includes("phantom")) return "phantom";
  if (n.includes("solflare")) return "solflare";
  if (n.includes("meta")) return "metamask";
  if (n.includes("okx")) return "okx";
  return null;
}

export function WalletLogo({ name, size = 36 }: { name: string; size?: number }) {
  const key = walletKey(name);
  const src = key ? WALLET_ICON[key] : null;

  if (src) {
    return (
      <img
        src={src}
        alt=""
        width={size}
        height={size}
        className="shrink-0 rounded-xl object-cover"
        aria-hidden
      />
    );
  }

  return (
    <span
      className="grid shrink-0 place-items-center rounded-xl bg-pro-elevated text-sm font-semibold text-pro-text"
      style={{ width: size, height: size }}
      aria-hidden
    >
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}
