# Working on Clearance (humans and agents)

Read [README.md](README.md) first. Follow the [prove-it](.claude/skills/prove-it/SKILL.md) skill:
**a change is done when `make verify` passes and `docs/evidence/` is regenerated.**

## Layout

| Path | What | Owner |
|---|---|---|
| `circuits/src/` | Clearance Circom templates (`packHash`, `identity`, ...) | Demilade |
| `circuits/test/` | Test entry-point circuits and Rust proving tests | Demilade |
| `contracts/rule-registry/` | Soroban contract: per-country rule packs, epochs, corridors, allow-list pointers | Demilade |
| `contracts/clearance-pool/` | Soroban contract: the pool that verifies Clearance proofs and enforces the registry | Demilade |
| `e2e/` | End-to-end tests: real proofs against all real contracts in the Soroban test host | Demilade |
| `packages/sdk/` | TypeScript SDK, live on testnet (types are the contract with the UI); `docs/sdk.md` | Demilade |
| `packages/sdk-wasm/` | Rust crate compiled to WASM for the SDK: Clearance hashes, trees, record opening, Groth16 prover | Demilade |
| UI | Separate, built against `packages/sdk` types | Michael |
| `upstream/nethermind-spp/` | Nethermind SPP, git submodule pinned at `cd6c8fc`. **Do not edit.** | upstream |
| `upstream-patches/` | The only edits we make to upstream files, as patches | Demilade |
| `scripts/` | Sync, testnet seeding, evidence generation | |
| `deployments/` | Live contract ids per network | |
| `docs/` | Architecture, research, evidence ([index](docs/README.md)) | |

Our Circom and Rust tests are built **inside** the upstream workspace (they use its Poseidon2,
Merkle and prover code). `scripts/sync-upstream.sh` copies them in; `make` runs it for you. Always
edit files in this repo, never the copies under `upstream/`.

## Commands

```bash
make setup      # init submodule (first time)
make circuits   # sync + compile circuits (about 1 min)
make test       # contract + circuit + end-to-end + SDK tests
make verify     # all of the above + regenerate docs/evidence
./scripts/mutation-test.sh [budget|tx]  # break each constraint, check a test catches it (~40 min all)
```

Testnet: `python3 scripts/seed-testnet.py` (needs operator keys in `.secrets/`, never committed).

## Not evidence

"It compiles", "types check", "should work", a test that cannot fail, a rejection test without a
matching passing case, hand-typed numbers in docs, mocks of the thing under test, a run from before
the last change.

## Rules

- No mocks of our own components. Use the real circuit, contract and testnet.
- Every new circuit template: tests just under, at and just over every limit, plus a Rust or on-chain
  parity check for every hash. Passing first time is not enough: break each constraint (mutation
  test) and confirm a test fails.
- New Poseidon2 domain tags: 0x10 identity, 0x11 leaf, 0x12 budget nullifier, 0x13 budget commitment,
  0x14 pack hash, 0x15 budget state key. Upstream uses 0x01-0x06.
- Never commit `.secrets/`. Never push without being asked.
