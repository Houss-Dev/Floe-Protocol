#!/usr/bin/env python3
"""
Drive `anchor build` to success by pinning crates that platform-tools'
rustc 1.79 cannot compile.

platform-tools v1.43 ships Cargo 1.79, which cannot parse `edition = "2024"`
manifests and refuses crates declaring `rust-version > 1.79`. Crates are
downloaded lazily during the SBF build, so a static scan of the registry
always misses some. This loops: build, read the failure, find the newest
version that 1.79 can handle, pin it, repeat.

Usage: scripts/autopin.py [--max N]
"""
import json
import re
import subprocess
import sys
import urllib.request

MAX_ITER = 20

# "failed to parse manifest at .../registry/src/<index>/<crate>-<version>/Cargo.toml"
RE_MANIFEST = re.compile(r"registry/src/[^/]+/([A-Za-z0-9_\-]+)-(\d+\.\d+\.\d+[^/]*)/Cargo\.toml")
# "package `foo v1.2.3` requires rustc 1.85.0"
RE_MSRV = re.compile(r"package [`']?([A-Za-z0-9_\-]+) v(\d+\.\d+\.\d+[^ `'`]*)[`']? requires rustc (\d+\.\d+)")


def sh(cmd, **kw):
    return subprocess.run(cmd, shell=True, capture_output=True, text=True, **kw)


def crates_io(name):
    url = f"https://crates.io/api/v1/crates/{name}"
    req = urllib.request.Request(url, headers={"User-Agent": "ledgerline-bootstrap/0.1"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def parse_ver(v):
    parts = []
    for chunk in re.split(r"[.\-+]", v):
        parts.append(int(chunk) if chunk.isdigit() else 0)
    return tuple(parts)


def best_compatible(name, current):
    """Newest version strictly older than `current` that rustc 1.79 can build."""
    data = crates_io(name)
    cur = parse_ver(current)
    cands = []
    for v in data.get("versions", []):
        num = v["num"]
        if v.get("yanked"):
            continue
        if parse_ver(num) >= cur:
            continue
        rv = v.get("rust_version")
        if rv:
            major, minor = (rv.split(".") + ["0"])[:2]
            if (int(major), int(minor)) > (1, 79):
                continue
        cands.append(num)
    if not cands:
        return None
    cands.sort(key=parse_ver)
    return cands[-1]


def main():
    pinned = []
    for i in range(MAX_ITER):
        print(f"\n===== build attempt {i} =====", flush=True)
        r = sh("anchor build 2>&1")
        out = r.stdout + r.stderr
        if r.returncode == 0:
            print("\nBUILD OK after", len(pinned), "pins:", pinned or "none needed")
            return 0

        target = None
        m = RE_MANIFEST.search(out)
        if m and ("edition2024" in out or "edition 2024" in out):
            target = (m.group(1), m.group(2))
        if target is None:
            m2 = RE_MSRV.search(out)
            if m2:
                target = (m2.group(1), m2.group(2))
        if target is None:
            print("\nFAILED for a reason this script cannot pin. Tail:")
            print("\n".join(out.strip().splitlines()[-25:]))
            return 1

        name, ver = target
        print(f"blocked by {name} {ver}", flush=True)
        replacement = best_compatible(name, ver)
        if not replacement:
            print(f"no older compatible version of {name} on crates.io")
            return 1
        print(f"pinning {name} -> {replacement}", flush=True)
        p = sh(f"cargo update -p {name}@{ver} --precise {replacement} 2>&1")
        if p.returncode != 0:
            print("pin failed:", (p.stdout + p.stderr)[-800:])
            return 1
        pinned.append(f"{name} {replacement}")

        # A fresh crate just landed in the registry; sweep for more in one pass.
        sh("cargo fetch -q 2>&1")
        sh("python3 scripts/check-lock.py 2>&1")

    print(f"gave up after {MAX_ITER} iterations; pinned so far: {pinned}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
