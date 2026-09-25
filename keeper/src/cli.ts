#!/usr/bin/env tsx
/**
 * Unified Kit keeper CLI (solana-dev aligned).
 *
 *   tsx src/cli.ts --selftest
 *   tsx src/cli.ts --config keeper/config.demo.json [--loop N [intervalSec]]
 *   tsx src/cli.ts --once | --loop
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  createClient,
  createKeyPairSignerFromBytes,
  generateKeyPairSigner,
  type Address,
} from "@solana/kit";
import { solanaRpcConnection, rpcTransactionPlanner, rpcTransactionPlanSendingExecutor } from "@solana/kit-plugin-rpc";
import { signer } from "@solana/kit-plugin-signer";
import { ledgerlineProgram } from "@ledgerline/ledgerline";
import { runConfigSelftest } from "./config/selftest.js";
import { runConfigTick } from "./config/tick.js";
import type { KeeperConfig } from "./config/types.js";
import { runEnvKeeper } from "./env-keeper.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, "../..");

function resolveKeypairPath(cfg: KeeperConfig): string {
  const kp = cfg.keypair;
  if (kp.startsWith("~")) {
    return path.join(process.env.HOME ?? process.env.USERPROFILE ?? "", kp.slice(1));
  }
  return path.isAbsolute(kp) ? kp : path.join(REPO_ROOT, kp);
}

async function loadSignerFromConfig(cfg: KeeperConfig) {
  const kpPath = resolveKeypairPath(cfg);
  if (fs.existsSync(kpPath)) {
    const raw = JSON.parse(fs.readFileSync(kpPath, "utf8"));
    return createKeyPairSignerFromBytes(Uint8Array.from(raw));
  }
  console.warn(`[keeper] no keypair at ${kpPath} — generating ephemeral signer`);
  return generateKeyPairSigner();
}

async function runConfigKeeper(cfgPath: string, ticks: number, intervalSec: number) {
  const cfg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, cfgPath), "utf8")) as KeeperConfig;
  const programId = cfg.programId as Address;
  const keeperSigner = await loadSignerFromConfig(cfg);

  const client = createClient()
    .use(signer(keeperSigner))
    .use(solanaRpcConnection({ rpcUrl: cfg.rpc }))
    .use(rpcTransactionPlanner())
    .use(rpcTransactionPlanSendingExecutor())
    .use(ledgerlineProgram());

  const log = (s: string) => console.log(new Date().toISOString().slice(11, 19), s);

  for (let i = 0; i < ticks; i++) {
    log(`keeper tick ${i + 1}/${ticks}`);
    await runConfigTick(cfg, REPO_ROOT, programId, client, keeperSigner, log);
    if (i + 1 < ticks) {
      await new Promise((r) => setTimeout(r, intervalSec * 1000));
    }
  }
}

export async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  if (argv.includes("--selftest")) {
    runConfigSelftest(REPO_ROOT);
    return;
  }

  const configIdx = argv.indexOf("--config");
  if (configIdx >= 0) {
    const cfgPath = argv[configIdx + 1] ?? "keeper/config.demo.json";
    const loopIdx = argv.indexOf("--loop");
    const ticks = loopIdx >= 0 ? Number(argv[loopIdx + 1] ?? 1) : 1;
    const intervalSec = loopIdx >= 0 ? Number(argv[loopIdx + 2] ?? 30) : 30;
    await runConfigKeeper(cfgPath, ticks, intervalSec);
    return;
  }

  const once = argv.includes("--once");
  const loop = argv.includes("--loop");
  await runEnvKeeper({ once, loop: loop || !once });
}

main().catch((e) => {
  console.error("keeper failed:", e);
  process.exit(1);
});
