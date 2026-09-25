"use client";

import { useEffect, useState, type ElementType } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  CreditCard,
  Droplets,
  FlaskConical,
  ExternalLink,
  ArrowLeft,
  Menu,
  X,
} from "lucide-react";
import { FLOE_GITHUB_URL } from "../lib/brand";
import { FloeBrandIcon } from "./FloeBrandIcon";
import { WalletButton } from "./WalletButton";

function NavItem({
  href,
  label,
  icon: Icon,
  onNavigate,
}: {
  href: string;
  label: string;
  icon: ElementType;
  onNavigate?: () => void;
}) {
  const path = usePathname();
  const active = path === href || (href !== "/dashboard" && path.startsWith(href));
  return (
    <Link
      href={href}
      onClick={onNavigate}
      className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors ${
        active
          ? "bg-pro-elevated text-pro-text"
          : "text-pro-muted hover:bg-pro-hover hover:text-pro-text"
      }`}
    >
      <Icon className="h-4 w-4 shrink-0 opacity-80" aria-hidden="true" />
      {label}
    </Link>
  );
}

function SidebarNav({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <>
      <div className="border-b border-pro-border px-4 py-5">
        <Link href="/dashboard" onClick={onNavigate} className="flex items-center gap-2.5">
          <FloeBrandIcon size={26} />
          <div>
            <div className="text-sm font-semibold leading-tight">Floe</div>
            <div className="text-[10px] uppercase tracking-wider text-pro-faint">Pro · devnet</div>
          </div>
        </Link>
      </div>

      <nav className="flex flex-1 flex-col gap-6 p-3">
        <div>
          <p className="mb-2 px-3 text-[10px] font-semibold uppercase tracking-wider text-pro-faint">Overview</p>
          <div className="space-y-0.5">
            <NavItem href="/dashboard" label="Dashboard" icon={LayoutDashboard} onNavigate={onNavigate} />
          </div>
        </div>
        <div>
          <p className="mb-2 px-3 text-[10px] font-semibold uppercase tracking-wider text-pro-faint">Explore</p>
          <div className="space-y-0.5">
            <NavItem href="/spend" label="Spend" icon={CreditCard} onNavigate={onNavigate} />
            <NavItem href="/dividends" label="Dividends" icon={Droplets} onNavigate={onNavigate} />
          </div>
        </div>
        <div>
          <p className="mb-2 px-3 text-[10px] font-semibold uppercase tracking-wider text-pro-faint">Protocol</p>
          <div className="space-y-0.5">
            <NavItem
              href="/dashboard#devnet"
              label="Devnet sandbox"
              icon={FlaskConical}
              onNavigate={onNavigate}
            />
            <a
              href={FLOE_GITHUB_URL}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-pro-muted transition hover:bg-pro-hover hover:text-pro-text"
            >
              <ExternalLink className="h-4 w-4 shrink-0 opacity-80" aria-hidden="true" />
              GitHub
            </a>
          </div>
        </div>
      </nav>

      <div className="border-t border-pro-border p-3">
        <Link
          href="/"
          onClick={onNavigate}
          className="flex items-center gap-2 rounded-lg px-3 py-2 text-xs text-pro-muted transition hover:bg-pro-hover hover:text-pro-text"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
          Back to home
        </Link>
      </div>
    </>
  );
}

export function DashboardShell({ children }: { children: React.ReactNode }) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const path = usePathname();

  // Close the drawer on route change (covers in-content links too, e.g. "Dividends →").
  useEffect(() => {
    setDrawerOpen(false);
  }, [path]);

  // Lock body scroll while the mobile drawer is open.
  useEffect(() => {
    if (!drawerOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [drawerOpen]);

  return (
    <div className="flex min-h-screen bg-pro-bg text-pro-text">
      {/* Desktop sidebar */}
      <aside className="hidden w-56 shrink-0 flex-col border-r border-pro-border bg-pro-panel md:flex">
        <SidebarNav />
      </aside>

      {/* Mobile drawer */}
      {drawerOpen && (
        <div className="fixed inset-0 z-50 md:hidden">
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            onClick={() => setDrawerOpen(false)}
            aria-hidden="true"
          />
          <aside className="absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col bg-pro-panel shadow-overlay">
            <button
              type="button"
              onClick={() => setDrawerOpen(false)}
              aria-label="Close menu"
              className="absolute right-3 top-4 flex h-8 w-8 items-center justify-center rounded-lg text-pro-muted transition hover:bg-pro-hover hover:text-pro-text"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
            <SidebarNav onNavigate={() => setDrawerOpen(false)} />
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 items-center justify-between gap-3 border-b border-pro-border bg-pro-panel/80 px-4 backdrop-blur md:px-6">
          <div className="flex items-center gap-2 md:hidden">
            <button
              type="button"
              onClick={() => setDrawerOpen(true)}
              aria-label="Open menu"
              className="flex h-8 w-8 items-center justify-center rounded-lg text-pro-muted transition hover:bg-pro-hover hover:text-pro-text"
            >
              <Menu className="h-5 w-5" aria-hidden="true" />
            </button>
            <Link href="/dashboard" className="flex items-center gap-2">
              <FloeBrandIcon size={24} />
              <span className="text-sm font-semibold">Floe</span>
            </Link>
          </div>
          <p className="hidden text-xs text-pro-faint md:block">Credit line · tokenized stock collateral · Solana devnet</p>
          <WalletButton />
        </header>
        <main className="flex-1 overflow-x-hidden p-4 md:p-6 lg:p-8">{children}</main>
      </div>
    </div>
  );
}
