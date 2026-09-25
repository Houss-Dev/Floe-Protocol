/**
 * Regenerates the Kit-native TypeScript client from the Anchor IDL.
 *
 * Pipeline (per the Solana Dev skill's IDL & Client Code Generation guide):
 *   Anchor IDL  ->  Codama nodes (nodes-from-anchor)  ->  Kit-native TS client
 *   idl/ledgerline.json  ->  codama/ledgerline.json  ->  clients/ts/ledgerline
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { rootNodeFromAnchor } from "@codama/nodes-from-anchor";
import { renderVisitor } from "@codama/renderers-js";
import { visit } from "@codama/visitors-core";

const root = process.cwd();

async function main() {
  const idlPath = join(root, "idl", "ledgerline.json");
  const freshIdlPath = join(root, "target", "idl", "ledgerline.json");
  let idlSource = idlPath;
  try {
    const { stat } = await import("node:fs/promises");
    const [committed, fresh] = await Promise.all([stat(idlPath), stat(freshIdlPath)]);
    if (fresh.mtimeMs > committed.mtimeMs) {
      idlSource = freshIdlPath;
      console.warn(
        "Using target/idl/ledgerline.json (newer than idl/). Run: Copy-Item target/idl/ledgerline.json idl/ -Force",
      );
    }
  } catch {
    /* use committed idl */
  }
  const anchorIdl = JSON.parse(await readFile(idlSource, "utf8"));
  const rootNode = rootNodeFromAnchor(anchorIdl);

  const codamaDir = join(root, "codama");
  await mkdir(codamaDir, { recursive: true });
  await writeFile(
    join(codamaDir, "ledgerline.json"),
    JSON.stringify(rootNode, null, 2),
  );

  const clientDir = join(root, "clients", "ts", "ledgerline");
  await mkdir(dirname(clientDir), { recursive: true });
  await visit(rootNode, renderVisitor(clientDir, { formatCode: true }));
  console.log(`Generated client at ${clientDir}`);

  await applyPostProcess(clientDir);
}

/**
 * Durable post-generation fixes for known @codama/renderers-js gaps.
 * Idempotent: safe to re-run; each step checks for its marker first.
 *
 * 1. Account codec/type re-exports: instruction files import
 *    `getAssetEncoder`, `type Asset`, ... from `../types`, but the renderer
 *    emits them under `../accounts/*`. Re-export them from the types barrel
 *    so the generated imports resolve. (Uses explicit named re-exports, not
 *    `export *`, to avoid star-export cycles.)
 * 2. Package entry points: the renderer emits TS sources consumed directly
 *    via `file:` link + `transpilePackages`, so `main`/`types`/`exports`
 *    must point at `./src/generated/index.ts` and `type` must be `module`
 *    for Node ESM (tsx) resolution.
 */
const SHIM_MARKER = "ledgerline:codama-postprocess:account-reexports";
const SHIM_LINES = [
  `// ${SHIM_MARKER} — re-exported from ../accounts (see scripts/codama-generate.mjs).`,
  `export { getAssetEncoder, getAssetDecoder, getAssetCodec, getAssetSize } from "../accounts/asset";`,
  `export type { Asset, AssetArgs } from "../accounts/asset";`,
  `export { getConfigEncoder, getConfigDecoder, getConfigCodec, getConfigSize } from "../accounts/config";`,
  `export type { Config, ConfigArgs } from "../accounts/config";`,
  `export { getCreditLineEncoder, getCreditLineDecoder, getCreditLineCodec, getCreditLineSize } from "../accounts/creditLine";`,
  `export type { CreditLine, CreditLineArgs } from "../accounts/creditLine";`,
  `export { getDividendEventEncoder, getDividendEventDecoder, getDividendEventCodec, getDividendEventSize } from "../accounts/dividendEvent";`,
  `export type { DividendEvent, DividendEventArgs } from "../accounts/dividendEvent";`,
];

const PACKAGE_ENTRIES = {
  type: "module",
  main: "./src/generated/index.ts",
  types: "./src/generated/index.ts",
  exports: { ".": "./src/generated/index.ts" },
};

async function applyPostProcess(clientDir) {
  const typesIndex = join(clientDir, "src", "generated", "types", "index.ts");
  const current = await readFile(typesIndex, "utf8");
  if (!current.includes(SHIM_MARKER)) {
    await writeFile(typesIndex, `${current.trimEnd()}\n${SHIM_LINES.join("\n")}\n`);
    console.log("Post-process: added account re-exports to types/index.ts");
  } else {
    console.log("Post-process: types/index.ts shim already present");
  }

  const pkgPath = join(clientDir, "package.json");
  let pkg = {};
  try {
    pkg = JSON.parse(await readFile(pkgPath, "utf8"));
  } catch {
    // Created fresh below.
  }
  let changed = false;
  for (const [key, value] of Object.entries(PACKAGE_ENTRIES)) {
    if (JSON.stringify(pkg[key]) !== JSON.stringify(value)) {
      pkg[key] = value;
      changed = true;
    }
  }
  if (changed) {
    await writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
    console.log("Post-process: fixed package.json entry points");
  } else {
    console.log("Post-process: package.json entry points already correct");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});