#!/usr/bin/env bash
# Mutation testing for Clearance circuits: remove or weaken one constraint at a
# time and check that a test fails. A mutation that "survives" (every test
# still passes) means a test is missing or too weak.
#
#   ./scripts/mutation-test.sh budget    # dailyBudget.circom vs clearance_budget tests
#   ./scripts/mutation-test.sh tx        # payment circuit vs clearance_tx tests
#   ./scripts/mutation-test.sh pool      # pool contract vs clearance-e2e (real proofs)
#   ./scripts/mutation-test.sh           # all suites
#   ONLY="pack hash" ./scripts/mutation-test.sh tx   # just the mutations whose name matches
#
# Do not sync or rebuild circuits while this runs: it mutates the copies in upstream/.
#
# Mutations are applied only to the overlay copies inside upstream/, never to our
# sources. The overlay is restored and rebuilt at the end. Writes
# docs/evidence/mutation-<suite>.md and exits non-zero on any survivor.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UP="$ROOT/upstream/nethermind-spp"
SRC="$UP/circuits/src/clearance"

# Each entry: file | name | sed expression. Files under circuits/src are
# mutated in upstream's circuits/src/clearance/, contracts/* in upstream's contracts/.
suite_budget() {
  KIND=circuit
  FILTER=clearance_budget
  MUTATIONS=(
    "dailyBudget.circom|no per-payment check|s/    perOk.out === 1;//"
    "dailyBudget.circom|no daily check|s/    dailyOk.out === 1;//"
    "dailyBudget.circom|no budget-tree membership|s/    (inTree.root - budgetRoot) \* (1 - isFirst.out) === 0;//"
    "dailyBudget.circom|first payment may start above 0|s/    spent \* isFirst.out === 0;.*//"
    "dailyBudget.circom|commitment ignores epoch|s/    prev.epoch <== epoch;/    prev.epoch <== 0;/"
    "dailyBudget.circom|nullifier ignores seq|s/    nul.c <== seq;/    nul.c <== 0;/"
    "dailyBudget.circom|no range check on sent|s/.*rSent.in <== sent;//"
    "dailyBudget.circom|commitment ignores identity|s/    prev.idCommitment <== idCommitment;/    prev.idCommitment <== 0;/"
  )
}

suite_tx() {
  KIND=circuit
  FILTER=clearance_tx
  MUTATIONS=(
    "clearanceTransaction.circom|input notes need not be the sender's|s/        inPrivateKey\[i\] === keys.noteKey;//"
    "clearanceTransaction.circom|sender pack hash unchecked|s/    sPack.out === senderPackHash;//"
    "clearanceTransaction.circom|receiver pack hash unchecked|s/    rPack.out === receiverPackHash;//"
    "clearanceTransaction.circom|change may go to anyone|s/    outPubkey\[1\] === core.inPublicKey\[0\];//"
    "clearanceTransaction.circom|deposit and withdrawal together|s/    deposit \* withdrawal === 0;//"
    "clearanceTransaction.circom|public amount not bound to withdrawal|s/    publicAmount === deposit - withdrawal;//"
    "clearanceTransaction.circom|withdrawal not counted in sent|s/    signal sent <== outAmount\[0\] + withdrawal;/    signal sent <== outAmount[0];/"
    "clearanceTransaction.circom|flag uses sender threshold only|s/    signal threshold <== .*/    signal threshold <== sThreshold;/"
    "clearanceTransaction.circom|flag always 0|s/    signal flag <== over.out;/    signal flag <== 0;/"
    "clearanceTransaction.circom|both records sealed to sender operator|s/k == 0 ? sOperatorKey\[\([01]\)\] : rOperatorKey\[[01]\]/sOperatorKey[\1]/"
    "clearanceTransaction.circom|record omits the amount|s/    signal recordValue <== 2 \* sent + flag;/    signal recordValue <== flag;/"
    "clearanceTransaction.circom|record omits the receiver|s/        seal\[k\].amount <== outPubkey\[0\];/        seal[k].amount <== 0;/"
    "clearanceTransaction.circom|limits from receiver pack|s/    id.perPayment <== sPerPayment;/    id.perPayment <== rPerPayment;/"
    "identity.circom|identity root unchecked|s/    proof.root === identityRoot;//"
  )
}

suite_pool() {
  KIND=e2e
  FILTER=clearance_e2e
  local P=contracts/clearance-pool/src/lib.rs
  MUTATIONS=(
    "$P|pack hashes not checked against the registry|s/            return Err(Error::PackNotActive);/            {}/"
    "$P|corridor not checked|s/            return Err(Error::CorridorClosed);/            {}/"
    "$P|epoch not checked|s/            Ok(Ok(e)) if e == proof.epoch => {}/            Ok(Ok(_)) => {}/"
    "$P|identity root not checked|s/            return Err(Error::UnknownIdentityRoot);/            {}/"
    "$P|budget nullifier not checked|s/            return Err(Error::BudgetNullifierSpent);/            {}/"
    "$P|budget nullifier not recorded|s/            .set(&DataKey::BudgetNullifier(proof.budget_nullifier.clone()), &());/            .has(\&DataKey::BudgetNullifier(proof.budget_nullifier.clone()));/"
    "$P|note nullifiers not checked|s/                return Err(Error::AlreadySpentNullifier);/                {}/"
    "$P|ext data hash not checked|s/            return Err(Error::WrongExtHash);/            {}/"
    "$P|proof result ignored|s/            _ => Err(Error::InvalidProof),/            _ => Ok(()),/"
  )
}

# Our source path -> the copy in upstream that gets built.
upstream_copy() {
  case "$1" in
    contracts/*) echo "$UP/$1" ;;
    *) echo "$SRC/$1" ;;
  esac
}
our_source() {
  case "$1" in
    contracts/*) echo "$ROOT/$1" ;;
    *) echo "$ROOT/circuits/src/$1" ;;
  esac
}

run_suite() {
  local suite=$1
  "suite_$suite"
  local out="$ROOT/docs/evidence/mutation-$suite.md" rows="" survivors=0
  for m in "${MUTATIONS[@]}"; do
    IFS='|' read -r file name expr <<< "$m"
    if [ -n "${ONLY:-}" ] && [[ "$name" != *"$ONLY"* ]]; then continue; fi
    "$ROOT/scripts/sync-upstream.sh" >/dev/null
    sed -i "$expr" "$(upstream_copy "$file")"
    if cmp -s "$(upstream_copy "$file")" "$(our_source "$file")"; then
      rows+="| $name | ERROR: mutation did not apply | |"$'\n'; survivors=$((survivors+1)); echo "$name: ERROR"; continue
    fi
    local log failed
    if [ "$KIND" = circuit ]; then
      if ! make -C "$UP" circuits TESTS=1 >/dev/null 2>&1; then
        rows+="| $name | killed (does not compile) | |"$'\n'; echo "$name: does not compile"; continue
      fi
      log=$(cd "$UP" && cargo test -q -p circuits --release "$FILTER" -- --include-ignored 2>&1)
    else
      log=$(cd "$UP" && VERIFIER_VK_JSON="$UP/testdata/clearance_tx_2_2_vk.json" \
        cargo test -q -p clearance-e2e --release -- --include-ignored 2>&1)
      if echo "$log" | grep -q "^error\[\|could not compile"; then
        rows+="| $name | ERROR: does not compile | |"$'\n'; survivors=$((survivors+1)); echo "$name: compile error"; continue
      fi
    fi
    failed=$(echo "$log" | grep -oE "^    [a-z_:]*tests::[a-z_0-9:]+$|tests::[a-z_0-9:]+ \.\.\. FAILED" \
      | grep -oE "[a-z_0-9]+( \.\.\. FAILED)?$" | sed 's/ \.\.\. FAILED//' | sort -u | paste -sd, - | sed 's/,/, /g')
    if [ -n "$failed" ]; then rows+="| $name | killed | $failed |"$'\n'
    else rows+="| $name | **SURVIVED** | none |"$'\n'; survivors=$((survivors+1)); fi
    echo "$name: ${failed:-SURVIVED}"
  done
  {
    echo "# Mutation testing: $suite"
    echo
    echo "Generated by \`scripts/mutation-test.sh $suite\` on $(date -u +%Y-%m-%dT%H:%MZ) at \`$(git -C "$ROOT" rev-parse --short HEAD)\`."
    echo "Each row removes or weakens one constraint; \"killed\" means at least one \`$FILTER\` test failed."
    echo
    echo "| Mutation | Result | Tests that caught it |"
    echo "|---|---|---|"
    printf "%s" "$rows"
  } > "$out"
  return $survivors
}

SUITES=("${@:-budget tx pool}")
status=0
for s in ${SUITES[@]}; do run_suite "$s" || status=1; done
"$ROOT/scripts/sync-upstream.sh" >/dev/null && make -C "$UP" circuits TESTS=1 >/dev/null 2>&1
exit $status
