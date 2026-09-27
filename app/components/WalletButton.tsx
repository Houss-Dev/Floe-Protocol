"use client";
import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import {
  useConnect,
  useConnectedWallet,
  useDisconnect,
  useWallets,
  WalletReadyGate,
} from "@solana/kit-plugin-wallet/react";
import { client } from "../lib/solana";
import { WalletLogo } from "./WalletLogos";

const btn =
  "rounded-full bg-hot text-xs font-semibold text-[#f4f0e5] px-3.5 py-1.5 hover:opacity-90 transition whitespace-nowrap";

const PREFERRED_WALLETS = ["Phantom", "MetaMask", "OKX Wallet", "Solflare"];

function preferredWalletRows<T extends { name: string }>(detected: readonly T[]) {
  const rows = PREFERRED_WALLETS.map((label) => {
    const key = label.split(" ")[0].toLowerCase();
    const wallet = detected.find((w) => w.name.toLowerCase().includes(key)) ?? null;
    return { label, wallet };
  });
  for (const wallet of detected) {
    if (!rows.some((row) => row.wallet === wallet)) {
      rows.push({ label: wallet.name, wallet });
    }
  }
  return rows;
}

function Modal({
  title,
  subtitle,
  onClose,
  children,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return createPortal(
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/70 p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="wallet-modal-title"
        className="w-full max-w-[380px] rounded-3xl border border-pro-border bg-pro-panel p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-5 flex items-start justify-between gap-4">
          <div>
            <h2 id="wallet-modal-title" className="text-lg font-semibold text-pro-text">
              {title}
            </h2>
            {subtitle && <p className="mt-1 text-sm text-pro-muted">{subtitle}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="grid h-8 w-8 place-items-center rounded-full text-pro-muted transition hover:bg-pro-hover hover:text-pro-text"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
        <div className="space-y-2">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

function ConnectMenu() {
  const wallets = useWallets(client);
  const connected = useConnectedWallet(client);
  const { dispatch: connect } = useConnect(client);
  const { dispatch: disconnect } = useDisconnect(client);
  const [open, setOpen] = useState(false);

  if (connected?.account) {
    const address = connected.account.address;
    return (
      <>
        <button type="button" className={btn} onClick={() => setOpen(true)}>
          {address.slice(0, 4)}…{address.slice(-4)}
        </button>
        {open && (
          <Modal title="Wallet" subtitle={address} onClose={() => setOpen(false)}>
            <button
              type="button"
              className="w-full rounded-2xl border border-pro-border bg-pro-elevated px-4 py-3 text-left text-sm font-semibold text-pro-text transition hover:border-hot/50 hover:bg-pro-hover"
              onClick={() => {
                disconnect();
                setOpen(false);
              }}
            >
              Disconnect
            </button>
          </Modal>
        )}
      </>
    );
  }

  return (
    <>
      <button type="button" className={btn} onClick={() => setOpen(true)}>
        Connect
      </button>
      {open && (
        <Modal title="Connect Wallet" subtitle="Select a wallet to connect." onClose={() => setOpen(false)}>
          {preferredWalletRows(wallets).map((row) => {
            const disabled = !row.wallet;
            return (
              <button
                key={row.label}
                type="button"
                disabled={disabled}
                className={`flex w-full items-center gap-3 rounded-2xl border bg-pro-elevated px-3 py-3 text-left text-sm font-medium transition ${
                  disabled
                    ? "cursor-not-allowed border-pro-border text-pro-faint"
                    : "border-pro-border text-pro-text hover:border-[#ab9ff2]/70 hover:bg-pro-hover"
                }`}
                onClick={() => {
                  if (!row.wallet) return;
                  connect(row.wallet);
                  setOpen(false);
                }}
              >
                <WalletLogo name={row.label} size={36} />
                <span>{row.label}</span>
                {disabled && <span className="ml-auto text-xs text-pro-faint">Not installed</span>}
              </button>
            );
          })}
        </Modal>
      )}
    </>
  );
}

export function WalletButton() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  if (!mounted) {
    return <span className="text-xs text-pro-muted">Loading…</span>;
  }

  return (
    <WalletReadyGate client={client} fallback={<span className="text-xs text-pro-muted">Loading…</span>}>
      <ConnectMenu />
    </WalletReadyGate>
  );
}
