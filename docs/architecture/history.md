# Chain history beyond the RPC's retention

Wallets rebuild everything they prove against from contract events: the note tree (pool), the
budget tree, each country's allow-list, nullifiers and sealed records. The public testnet RPC keeps
about **7 days** of events. The deployment started at ledger 5,951,900 (27 Nov), so from about
4 Dec the RPC no longer has the early leaves, and without them no Merkle path, and so no proof, can
be built.

## Fix: an event archive, checked against the chain

```
 scripts/archive-events.mjs ──every 6h (GitHub Actions)──▶ branch events-archive: testnet/events.json
                                                                     │  (raw.githubusercontent.com)
 SDK  Chain.events(ids) ──▶ archive: events up to toLedger ──────────┘
                       └──▶ RPC: events after toLedger (well inside its 7 days)
 SDK  treeLeaves / poolState ──▶ root of the rebuilt tree ──▶ contract.is_known_root(root)? else STATE_MISMATCH
```

- **Archive** (`scripts/archive-events.mjs`): no dependencies, appends every event of the pool,
  budget tree, both allow-lists and the registry, as the RPC serves them (XDR, base64). It refuses
  to run across a gap (archive end older than the RPC's oldest ledger), so a gap is never papered
  over. `.github/workflows/events-archive.yml` runs it every 6 hours and on changes to it.
- **SDK** (`packages/sdk/src/chain.ts`): `Deployment.archiveUrl` (set in `TESTNET`). Events come from
  the archive up to its `toLedger`, then from the RPC. If the archive is unreachable it retries, then
  falls back to the RPC alone; if that range is past retention it throws `HISTORY_UNAVAILABLE`.
- **No trust in the archive** (`packages/sdk/src/state.ts`): every tree rebuilt from events, whether
  archived or live, must hash to a root the contract has in its root history. A missing, altered,
  reordered or invented leaf gives `STATE_MISMATCH` and nothing is proved or sent. A withheld
  nullifier can only make a wallet try to spend a spent note, which the pool rejects.

## Evidence

`make test-history` (in [evidence](../evidence/README.md)) puts a relay in front of the real
testnet RPC that refuses every ledger before a recent cutoff, as the RPC will after 4 Dec, then:
- without the archive: `HISTORY_UNAVAILABLE`;
- with it: the same notes, nullifiers, budget tree and allow-list as the full RPC, and a new user
  makes a real deposit and private payment;
- an archive with one allow-list leaf altered, or two note commitments swapped: `STATE_MISMATCH`.

Mutation-checked: with the root check removed the altered archive is accepted (test fails); with the
archive ignored, payments fail with `HISTORY_UNAVAILABLE` (test fails).

## Limits and the mainnet path

- The archive is only as fresh as its last run; the RPC covers the rest, so it must run at least
  once every ~7 days. A failed run shows as a red workflow. GitHub pauses scheduled workflows in a
  repository with no activity for 60 days.
- The integrity check is against the root history, so it proves the trees, not every byte of every
  event: encrypted note outputs are checked when the wallet decrypts them (the commitment must
  match), and sealed records are checked by the operator's key.
- For mainnet: run our own RPC with full event retention (or an indexer fed by Galexie / a data
  lake) and publish the archive from it. The SDK side does not change: it is a different
  `archiveUrl`. Upstream's `event_chain` (a running hash of every event, kept on-chain) would let the
  check cover every event, not only the trees; adopting it needs a contract redeploy.
