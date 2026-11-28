Michael,

One more SDK update before you record: **0.1.2**. Please take it; without it the app stops working
around 4 Dec.

**Why.** The public testnet RPC keeps only about 7 days of events. The SDK rebuilds the pool from
events, and our deployment started on 27 Nov. Once those first days drop out, every proof would
fail and users would show as "not verified".

**Fix.** The SDK now reads older events from an archive that a GitHub Action refreshes every
6 hours, and the rest from the RPC. It checks every rebuilt tree against the on-chain root, so a
wrong archive can't make it lie. Proven on testnet with the RPC cut off as it will be after
4 Dec: a new user still deposits and pays (`make test-history`, transaction links in
`docs/evidence/README.md`).

**To pick it up** (same as last time):

```bash
git merge origin/main
cd packages/sdk && pnpm install && pnpm build && npm pack --pack-destination ../../frontend/vendor
```

Point `frontend/package.json` at `vendor/clearance-sdk-0.1.2.tgz`, delete the 0.1.1 tarball, then
`npm install`.

**UI:** no code changes needed. If you map error codes to copy, there are two new ones (nothing is
sent in either case):
- `HISTORY_UNAVAILABLE`: "Can't load the pool's history right now, try again shortly";
- `STATE_MISMATCH`: "Refresh and try again".

`err.userMessage` already has wording for both.

The browser now fetches `raw.githubusercontent.com` as well as the RPC. If you set a
Content-Security-Policy `connect-src`, add it.

Demilade
