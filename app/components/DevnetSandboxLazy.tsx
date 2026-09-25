"use client";

import dynamic from "next/dynamic";

export const DevnetSandboxLazy = dynamic(
  () => import("./DevnetSandbox").then((m) => m.DevnetSandbox),
  { ssr: false, loading: () => <div className="pro-card p-6 text-sm text-pro-muted">Loading devnet sandbox…</div> },
);
