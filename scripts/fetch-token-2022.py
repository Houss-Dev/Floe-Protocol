#!/usr/bin/env python3
"""
Pull the live Token-2022 program binary off a cluster and save it as a .so.

The Token-2022 bundled with Agave 2.1.21 predates the ScaledUiAmount
extension, so a test validator started from it rejects that instruction with
"invalid instruction" (custom error 0xc). Loading the current binary over the
same program id gives the local validator the extension set that xStocks mints
actually carry on devnet and mainnet.

Usage: scripts/fetch-token-2022.py [rpc_url] [out_path]
"""
import base64
import json
import os
import subprocess
import sys

TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
ELF_MAGIC = b"\x7fELF"
# ProgramData account state: 4-byte enum, 8-byte slot, 36-byte optional
# upgrade authority. The ELF begins immediately after.
PROGRAM_DATA_HEADER = 45
B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"


def b58encode(raw: bytes) -> str:
    n = int.from_bytes(raw, "big")
    out = ""
    while n > 0:
        n, r = divmod(n, 58)
        out = B58[r] + out
    return "1" * (len(raw) - len(raw.lstrip(b"\x00"))) + out


def rpc(url: str, method: str, params):
    payload = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
    out = subprocess.run(
        ["curl", "-s", "-m", "180", "-X", "POST",
         "-H", "Content-Type: application/json", "--data", payload, url],
        capture_output=True, text=True, check=True,
    ).stdout
    body = json.loads(out)
    if "error" in body:
        raise SystemExit(f"rpc error: {body['error']}")
    return body["result"]


def account_bytes(url: str, pubkey: str) -> bytes:
    value = rpc(url, "getAccountInfo", [pubkey, {"encoding": "base64"}]).get("value")
    if not value:
        raise SystemExit(f"account {pubkey} not found on {url}")
    return base64.b64decode(value["data"][0])


def main() -> None:
    url = sys.argv[1] if len(sys.argv) > 1 else "https://api.devnet.solana.com"
    out = sys.argv[2] if len(sys.argv) > 2 else "target/deploy/spl_token_2022.so"

    program = account_bytes(url, TOKEN_2022)
    if len(program) < 36:
        raise SystemExit("program account too small to hold a Program state")
    kind = int.from_bytes(program[:4], "little")
    if kind != 2:
        raise SystemExit(f"expected Program state (2), got {kind}")

    pd_address = b58encode(program[4:36])
    print(f"programdata: {pd_address}")

    blob = account_bytes(url, pd_address)
    if int.from_bytes(blob[:4], "little") != 3:
        raise SystemExit("programdata account is not in the ProgramData state")

    elf = blob[PROGRAM_DATA_HEADER:]
    if not elf.startswith(ELF_MAGIC):
        raise SystemExit("payload does not begin with the ELF magic")

    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
    with open(out, "wb") as f:
        f.write(elf)
    print(f"wrote {out} ({len(elf)} bytes)")


if __name__ == "__main__":
    main()
