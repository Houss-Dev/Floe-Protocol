"use client";
import { ClientProvider } from "@solana/react";
import { client } from "../lib/solana";

export function KitProvider({ children }: { children: React.ReactNode }) {
  return <ClientProvider client={client}>{children}</ClientProvider>;
}