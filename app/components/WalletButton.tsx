"use client";
import { useState } from "react";
import {
  useConnect,
  useConnectedWallet,
  useDisconnect,
  useWallets,
  WalletReadyGate,
} from "@solana/kit-plugin-wallet/react";
import { client } from "../lib/solana";

const btn =
  "rounded-full bg-brand-gradient text-xs font-semibold text-white px-3 py-1.5 hover:opacity-90 transition whitespace-nowrap shadow-md shadow-accent2/25";
const menu =
  "absolute right-0 top-full mt-2 w-56 rounded-xl bg-surface border border-line shadow-xl overflow-hidden z-50";
const row =
  "w-full text-left px-3 py-2 text-sm text-foreground hover:bg-surface2 flex items-center justify-between";

function ConnectMenu() {
  const wallets = useWallets(client);
  const connected = useConnectedWallet(client);
  const { dispatch: connect } = useConnect(client);
  const { dispatch: disconnect } = useDisconnect(client);
  const [open, setOpen] = useState(false);

  if (connected?.account) {
    const address = connected.account.address;
    return (
      <div className="relative">
        <button className={btn} onClick={() => setOpen((v) => !v)}>
          {address.slice(0, 4)}…{address.slice(-4)}
        </button>
        {open && (
          <div className={menu}>
            <div className="break-all px-3 py-2 font-mono text-xs text-muted">{address}</div>
            <button
              className={row}
              onClick={() => {
                disconnect();
                setOpen(false);
              }}
            >
              Disconnect
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="relative">
      <button className={btn} onClick={() => setOpen((v) => !v)}>
        Connect
      </button>
      {open && (
        <div className={menu}>
          {wallets.length === 0 && <div className="px-3 py-2 text-xs text-muted">No wallet found</div>}
          {wallets.map((w) => (
            <button key={w.name} className={row} onClick={() => connect(w)}>
              {w.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function WalletButton() {
  return (
    <WalletReadyGate client={client} fallback={<span className="text-xs text-muted">Loading…</span>}>
      <ConnectMenu />
    </WalletReadyGate>
  );
}
