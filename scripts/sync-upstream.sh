#!/usr/bin/env bash
# Overlay Clearance's code onto the pinned upstream checkout so it builds with
# upstream's toolchain (circuit compiler, Poseidon2, Soroban workspace).
#
# Our sources of truth live in this repo:
#   circuits/src/*.circom          -> upstream circuits/src/clearance/
#   circuits/test/circuits/*.circom-> upstream circuits/src/test/circuits/
#   circuits/test/rust/*.rs        -> upstream circuits/src/test/
#   contracts/<name>/              -> upstream contracts/<name>/ (rule-registry, clearance-pool)
#   e2e/                           -> upstream clearance-e2e/
#   upstream-patches/*.patch       -> applied to upstream (the only edits to upstream files)
#
# Idempotent: safe to run before every build. Never edit the copies inside
# upstream/; edit the files in this repo and re-run.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UP="$ROOT/upstream/nethermind-spp"

if [ ! -f "$UP/Cargo.toml" ]; then
  git -C "$ROOT" submodule update --init upstream/nethermind-spp
fi

# 1. Restore every file our patches touch to the pinned upstream version, then
#    apply the patches. Works even when a patch itself has changed.
for p in "$ROOT"/upstream-patches/*.patch; do
  git -C "$UP" apply --numstat "$p" | awk '{print $3}' | while read -r f; do
    git -C "$UP" checkout -- "$f"
  done
done
for p in "$ROOT"/upstream-patches/*.patch; do
  git -C "$UP" apply "$p"
done

# 2. Copy our sources (delete stale copies first, so renames do not linger).
rm -rf "$UP/circuits/src/clearance" "$UP/clearance-e2e"
for c in "$ROOT"/contracts/*/; do rm -rf "$UP/contracts/$(basename "$c")"; done
rm -f "$UP"/circuits/src/test/clearance_*.rs
mkdir -p "$UP/circuits/src/clearance"
cp "$ROOT"/circuits/src/*.circom "$UP/circuits/src/clearance/"
cp "$ROOT"/circuits/test/circuits/*.circom "$UP/circuits/src/test/circuits/"
cp "$ROOT"/circuits/test/rust/*.rs "$UP/circuits/src/test/"
for c in "$ROOT"/contracts/*/; do
  n="$(basename "$c")"
  cp -r "$c" "$UP/contracts/$n"
  rm -rf "$UP/contracts/$n/target" "$UP/contracts/$n/test_snapshots"
done
cp -r "$ROOT/e2e" "$UP/clearance-e2e"
rm -rf "$UP/clearance-e2e/target" "$UP/clearance-e2e/test_snapshots"

# 3. Keep the overlay out of the submodule's status.
EXCL="$(git -C "$UP" rev-parse --git-path info/exclude)"
case "$EXCL" in /*) ;; *) EXCL="$UP/$EXCL" ;; esac
for pat in /circuits/src/clearance/ /contracts/rule-registry/ /contracts/clearance-pool/ /clearance-e2e/ \
           /circuits/src/test/circuits/clearance_budget_test.circom \
           /circuits/src/test/clearance_*.rs \
           /circuits/src/test/circuits/pack_hash_test.circom \
           /circuits/src/test/circuits/clearance_identity_test.circom; do
  grep -qxF "$pat" "$EXCL" 2>/dev/null || echo "$pat" >> "$EXCL"
done
echo "synced Clearance overlay into $UP"
