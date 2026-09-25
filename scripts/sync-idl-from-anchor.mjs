/**
 * Copy Anchor's fresh IDL into idl/ledgerline.json (run from repo root after `anchor build`).
 */
import { copyFile, access } from "node:fs/promises";
import { join } from "node:path";

const root = process.cwd();
const src = join(root, "target", "idl", "ledgerline.json");
const dest = join(root, "idl", "ledgerline.json");

try {
  await access(src);
} catch {
  console.error(
    [
      "Missing target/idl/ledgerline.json",
      "",
      "Run from the Ledgerline repo root (not app/):",
      "  cd ..   # if you are in app/",
      "  anchor build",
      "  npm run sync:idl",
    ].join("\n"),
  );
  process.exit(1);
}

await copyFile(src, dest);
console.log(`Copied ${src} -> ${dest}`);
