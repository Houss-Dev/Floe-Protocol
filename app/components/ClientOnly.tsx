"use client";
import { useEffect, useState, type ReactNode } from "react";

/** Avoid SSR/extension attribute mismatches (e.g. fdprocessedid). */
export function ClientOnly({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  if (!ready) return <div className="min-h-[40vh]" />;
  return <>{children}</>;
}
