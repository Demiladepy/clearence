#!/usr/bin/env python3
"""Register NG and GH in the testnet rule registry, publish packs, open NG->GH.

Limits are ILLUSTRATIVE until checked against the regulators' texts
(docs/multi-jurisdiction.md). Amounts in USDC stroops (7 decimals).
"""
import json, subprocess, sys, pathlib

NET = sys.argv[1] if len(sys.argv) > 1 else "clr-testnet"
REG = "clr-registry"
SECRETS = pathlib.Path(__file__).resolve().parent.parent / ".secrets"
S = lambda usd: str(round(usd * 10_000_000))

PACKS = {
    566: dict(admin="clr-ng", key="ng", offset=3600,
              tiers=[(18.75, 31.25), (625, 1250), (3125, 6250)]),   # NGN 30k / 50k at 1,600 (display)
    288: dict(admin="clr-gh", key="gh", offset=0,
              tiers=[(15, 25), (500, 1000), (2500, 5000)]),
}

def run(*args, source):
    cmd = ["stellar", "contract", "invoke", "--id", REG, "--source", source, "--network", NET, "--", *args]
    out = subprocess.run(cmd, capture_output=True, text=True)
    if out.returncode != 0:
        raise SystemExit(f"FAILED {' '.join(args[:1])}: {out.stderr.strip()[-400:]}")
    return out.stdout.strip()

def addr(k):
    return subprocess.run(["stellar", "keys", "address", k], capture_output=True, text=True, check=True).stdout.strip()

for j, p in PACKS.items():
    try:
        run("register_jurisdiction", "--jurisdiction", str(j), "--admin", addr(p["admin"]), source="clr-admin")
    except SystemExit as e:
        if "#3" not in str(e) and "JurisdictionExists" not in str(e):
            raise
    pk = json.load(open(SECRETS / f"operator-{p['key']}.json"))["publicKey"]
    rules = {
        "utc_offset_secs": p["offset"],
        "travel_rule_threshold": S(1000),
        "tiers": [{"per_payment": S(a), "daily": S(b)} for a, b in p["tiers"]],
        "operator_key": {"x": str(int(pk["x"], 16)), "y": str(int(pk["y"], 16))},
    }
    h = run("set_pack", "--jurisdiction", str(j), "--rules", json.dumps(rules), source=p["admin"])
    print(f"{j}: pack hash {h}")

print("open  NG->GH:", run("open_corridor", "--from", "566", "--to", "288", source="clr-ng"))
print("accept NG->GH:", run("accept_corridor", "--from", "566", "--to", "288", source="clr-gh"))
print("corridor_open NG->GH:", run("corridor_open", "--from", "566", "--to", "288", source="clr-admin"))
print("corridor_open GH->NG:", run("corridor_open", "--from", "288", "--to", "566", source="clr-admin"))
print("epoch NG:", run("epoch", "--jurisdiction", "566", source="clr-admin"), " epoch GH:", run("epoch", "--jurisdiction", "288", source="clr-admin"))
