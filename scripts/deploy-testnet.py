#!/usr/bin/env python3
"""Deploy the full Clearance system to Stellar testnet and record it in
deployments/testnet.json.

  make wasm                       # build the four contract WASMs first
  python3 scripts/deploy-testnet.py [network]

Deploys, in order:
  token        Stellar asset CLRUSD issued by clr-admin (a TEST token, 7 decimals)
  registry     rule-registry, admin clr-admin; NG and GH registered (admins
               clr-ng, clr-gh), v1 packs published with the operator keys in
               .secrets/, NG->GH corridor opened and accepted
  allow-lists  one asp-membership tree per country (10 levels), admin = that
               country's operator, registered in the registry
  verifier     circom-groth16-verifier embedding clearance_tx_2_2_vk.json
  pool         clearance-pool (fee 0, 20 levels)
  budget tree  asp-membership (20 levels), admin = the pool

Pack limits are ILLUSTRATIVE (docs/architecture/multi-jurisdiction.md).
"""
import json, pathlib, subprocess, sys, time

NET = sys.argv[1] if len(sys.argv) > 1 else "clr-testnet"
ROOT = pathlib.Path(__file__).resolve().parent.parent
WASM = ROOT / "upstream/nethermind-spp/target/wasm32v1-none/release"
SECRETS = ROOT / ".secrets"
OUT = ROOT / "deployments/testnet.json"
S = lambda usd: str(round(usd * 10_000_000))

PACKS = {
    566: dict(name="Nigeria", admin="clr-ng", key="ng", offset=3600,
              tiers=[(18.75, 31.25), (625, 1250), (3125, 6250)]),
    288: dict(name="Ghana", admin="clr-gh", key="gh", offset=0,
              tiers=[(15, 25), (500, 1000), (2500, 5000)]),
}
log = []


def sh(*cmd):
    out = subprocess.run(cmd, capture_output=True, text=True)
    if out.returncode != 0:
        raise SystemExit(f"FAILED: {' '.join(cmd[:6])} ...\n{out.stderr.strip()[-1500:]}")
    return out.stdout.strip()


def addr(k):
    return sh("stellar", "keys", "address", k)


def deploy(name, wasm, source, *ctor):
    cid = sh("stellar", "contract", "deploy", "--wasm", str(WASM / wasm), "--source", source,
             "--network", NET, "--alias", f"clr-{name}", *(["--", *ctor] if ctor else []))
    print(f"deployed {name}: {cid}")
    log.append((name, cid))
    return cid


def invoke(cid, source, fn, *args):
    return sh("stellar", "contract", "invoke", "--id", cid, "--source", source, "--network", NET,
              "--", fn, *args)


for w in ["rule_registry.wasm", "asp_membership.wasm", "circom_groth16_verifier.wasm", "clearance_pool.wasm"]:
    if not (WASM / w).exists():
        raise SystemExit(f"missing {WASM / w}: run `make wasm`")

admin = addr("clr-admin")

# token
asset = f"CLRUSD:{admin}"
try:
    token = sh("stellar", "contract", "asset", "deploy", "--asset", asset, "--source", "clr-admin",
               "--network", NET, "--alias", "clr-token")
except SystemExit:
    token = sh("stellar", "contract", "id", "asset", "--asset", asset, "--network", NET)
print("token:", token)

# registry and packs
registry = deploy("registry", "rule_registry.wasm", "clr-admin", "--admin", admin)
pack_hashes = {}
for j, p in PACKS.items():
    invoke(registry, "clr-admin", "register_jurisdiction", "--jurisdiction", str(j), "--admin", addr(p["admin"]))
    pk = json.load(open(SECRETS / f"operator-{p['key']}.json"))["publicKey"]
    rules = {
        "utc_offset_secs": p["offset"],
        "travel_rule_threshold": S(1000),
        "tiers": [{"per_payment": S(a), "daily": S(b)} for a, b in p["tiers"]],
        "operator_key": {"x": str(int(pk["x"], 16)), "y": str(int(pk["y"], 16))},
    }
    pack_hashes[j] = json.loads(invoke(registry, p["admin"], "set_pack", "--jurisdiction", str(j),
                                       "--rules", json.dumps(rules)))
    print(f"{p['name']} pack v1: {pack_hashes[j]}")
invoke(registry, "clr-ng", "open_corridor", "--from", "566", "--to", "288")
invoke(registry, "clr-gh", "accept_corridor", "--from", "566", "--to", "288")
assert invoke(registry, "clr-admin", "corridor_open", "--from", "566", "--to", "288") == "true"

# allow-lists, one per country, run by that country's operator
allow_lists = {}
for j, p in PACKS.items():
    cid = deploy(f"allow-list-{p['key']}", "asp_membership.wasm", p["admin"],
                 "--admin", addr(p["admin"]), "--levels", "10")
    invoke(registry, p["admin"], "set_allow_list", "--jurisdiction", str(j), "--allow_list", cid)
    allow_lists[j] = cid

# verifier, pool, budget tree
verifier = deploy("verifier", "circom_groth16_verifier.wasm", "clr-admin")
pool = deploy("pool", "clearance_pool.wasm", "clr-admin",
              "--admin", admin, "--token", token, "--verifier", verifier, "--registry", registry,
              "--fee", "0", "--minimum_deposit_amount", "0",
              "--maximum_deposit_amount", S(1_000_000), "--levels", "20")
budget_tree = deploy("budget-tree", "asp_membership.wasm", "clr-admin", "--admin", pool, "--levels", "20")
invoke(pool, "clr-admin", "set_budget_tree", "--tree", budget_tree)
assert json.loads(invoke(pool, "clr-admin", "budget_tree")) == budget_tree

epoch = {j: int(json.loads(invoke(registry, "clr-admin", "epoch", "--jurisdiction", str(j)))) for j in PACKS}

prev = json.load(open(OUT)) if OUT.exists() else {}
history = prev.get("history", [])
if prev.get("ruleRegistry"):
    history.append({"ruleRegistry": prev["ruleRegistry"], "deployTx": prev.get("deployTx"),
                    "note": "registry v1 (22 Nov), before allow-list pointers"})
out = {
    "network": "testnet",
    "networkPassphrase": "Test SDF Network ; September 2015",
    "deployedAt": time.strftime("%Y-%m-%dT%H:%MZ", time.gmtime()),
    "token": {"contract": token, "asset": asset, "note": "CLRUSD is a test token issued by clr-admin, not USDC"},
    "ruleRegistry": registry,
    "verifier": verifier,
    "verifierKey": "testdata/clearance_tx_2_2_vk.json (dev key from circuit-compiler, not a ceremony)",
    "pool": pool,
    "budgetTree": budget_tree,
    "accounts": {"registryAdmin": admin, "operatorNG": addr("clr-ng"), "operatorGH": addr("clr-gh")},
    "jurisdictions": {
        str(j): {"name": p["name"], "packVersion": 1, "packHash": pack_hashes[j],
                 "allowList": allow_lists[j], "epochAtDeploy": epoch[j], "illustrative": True}
        for j, p in PACKS.items()
    },
    "corridors": [{"from": 566, "to": 288, "open": True}],
    "history": history,
}
OUT.write_text(json.dumps(out, indent=2) + "\n")
print(f"wrote {OUT}")
