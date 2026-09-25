#!/usr/bin/env bash
# Ledgerline toolchain bootstrap. Safe to re-run.
set -uo pipefail

export DEBIAN_FRONTEND=noninteractive

# The Rust toolchain is ~1.5 GB. It must NOT live under $HOME:
# the workspace snapshot is capped at 128 MB / 10k files, and installing there
# blew the budget and silently dropped files. Use /var/tmp: it is on the real disk
# (20 GB) and outside the snapshot. Do NOT use /tmp -- it is a 993 MB tmpfs.
# The toolchain does not persist between sessions either way, so nothing is lost.
export TOOLCHAIN_DIR="${TOOLCHAIN_DIR:-/var/tmp/toolchain}"
export CARGO_HOME="$TOOLCHAIN_DIR/cargo"
export RUSTUP_HOME="$TOOLCHAIN_DIR/rustup"
mkdir -p "$CARGO_HOME/bin" "$RUSTUP_HOME"
export PATH="$CARGO_HOME/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
ok()  { printf '    \033[1;32mOK\033[0m %s\n' "$*"; }

say "0/6  swap (sandbox has 2 GB RAM; the test validator alone RSSes ~1.4 GB)"
# Without swap, every allocation stalls in direct reclaim (mocha freezes with
# wchan=folio_wait_bit_common, validator stuck "Waiting for fees to stabilize").
if ! swapon --show 2>/dev/null | grep -q /var/tmp/swapfile; then
  sudo fallocate -l 2G /var/tmp/swapfile 2>/dev/null \
    || sudo dd if=/dev/zero of=/var/tmp/swapfile bs=1M count=2048 status=none
  sudo chmod 600 /var/tmp/swapfile
  sudo mkswap /var/tmp/swapfile >/dev/null 2>&1 && sudo swapon /var/tmp/swapfile \
    || echo "    (swapon not permitted here — tests may thrash)"
fi
ok "swap: $(swapon --show=NAME --noheadings 2>/dev/null | tr '\n' ' ' || echo none)"

say "1/6  system packages"
sudo apt-get update -qq
sudo apt-get install -y -qq --no-install-recommends \
    build-essential pkg-config libudev-dev protobuf-compiler \
    libssl-dev ca-certificates curl git clang lld
ok "apt packages"

say "2/6  rustup + Rust 1.86.0"
if ! command -v rustc >/dev/null 2>&1; then
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
    | sh -s -- -y --default-toolchain 1.86.0 --profile minimal
fi
rustup default 1.86.0 >/dev/null 2>&1 || true
rustup component add rustfmt clippy >/dev/null 2>&1 || true
ok "$(rustc --version)"
ok "$(cargo --version)"

say "3/6  Agave / Solana CLI 2.1.21"
if ! solana --version 2>/dev/null | grep -q '2\.1\.21'; then
  sh -c "$(curl -sSfL https://release.anza.xyz/v2.1.21/install)"
fi
ok "$(solana --version | head -1)"

say "4/6  Anchor CLI 0.32.2 (prebuilt binary)"
# `cargo install avm` compiles from source and is slow + flaky in CI sandboxes.
# The release binary is a single static file and is much more reliable.
ANCHOR_VER=0.32.2
if ! anchor --version 2>/dev/null | grep -q "$ANCHOR_VER"; then
  curl -fsSL --max-time 300 -o "$CARGO_HOME/bin/anchor" \
    "https://github.com/otter-sec/anchor/releases/download/v${ANCHOR_VER}/anchor-${ANCHOR_VER}-x86_64-unknown-linux-gnu"
  chmod +x "$CARGO_HOME/bin/anchor"
  # -f above makes curl fail loudly instead of writing an HTML 404 page to the binary.
  anchor --version >/dev/null || { echo "anchor download failed"; exit 1; }
fi
ok "$(anchor --version)"

say "5/6  verify lockfile is compatible with platform-tools rustc 1.79"
# platform-tools v1.43 ships rustc 1.79; newer crate versions break the SBF build.
if [ -f scripts/check-lock.py ] && [ -f Cargo.lock ]; then
  python3 scripts/check-lock.py || echo "    (check-lock is advisory)"
fi
ok "lockfile check done"

say "6/6  node tooling"
npm install -g pnpm@9 >/dev/null 2>&1 || true
ok "node $(node --version)  pnpm $(pnpm --version 2>/dev/null || echo 'n/a')"

say "DONE — versions"
rustc --version
cargo --version
solana --version | head -1
anchor --version
node --version
echo "TOOLCHAIN_READY"

# NOTE: after `cargo generate-lockfile`, run `python3 scripts/check-lock.py` and pin any
# offenders. See docs/TOOLCHAIN.md — platform-tools ships rustc 1.79.
