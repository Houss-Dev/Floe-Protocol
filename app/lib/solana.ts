"use client";
import { createClient } from "@solana/kit";
import { solanaRpcConnection } from "@solana/kit-plugin-rpc";
import { rpcTransactionPlanner } from "@solana/kit-plugin-rpc";
import { rpcTransactionPlanSendingExecutor } from "@solana/kit-plugin-rpc";
import { walletSigner } from "@solana/kit-plugin-wallet";
import { RPC_URL } from "./constants";
import { ledgerlineProgram } from "@ledgerline/ledgerline";

export const client = createClient()
  .use(walletSigner({ chain: "solana:devnet" }))
  .use(solanaRpcConnection({ rpcUrl: RPC_URL }))
  .use(rpcTransactionPlanner())
  .use(rpcTransactionPlanSendingExecutor())
  .use(ledgerlineProgram());

export type AppClient = Awaited<typeof client>;