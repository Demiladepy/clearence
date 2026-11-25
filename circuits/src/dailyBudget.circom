pragma circom 2.2.2;
// Clearance: per-payment limit and daily budget per person.
//
// Each person has one chain of budget states per local day (epoch):
//
//   state k  = (spent_k, k)          spent_0 = 0
//   key_k    = H(idSecret, epoch, k; 0x15)                    private
//   C_k      = H(H(idCommitment, epoch, k; 0x13), spent_k, key_k; 0x13)
//   N_k      = H(idSecret, epoch, k; 0x12)                    public nullifier
//
// A payment at state k proves:
//   - k = 0 and spent_0 = 0 (first payment today), or C_k is in the budget tree;
//   - sent <= perPaymentLimit and spent_k + sent <= dailyLimit;
// and publishes N_k, C_{k+1} and encSpent = spent_{k+1} + key_{k+1}.
//
// Why this gives one budget per person, not per wallet:
//   - N_k depends only on (idSecret, epoch, k). Every wallet of a person
//     computes the same N_0, so a second "fresh" start the same day reuses
//     N_0 and the pool rejects it. Continuing needs C_k, which commits to the
//     real spent_k.
//   - State is recoverable from the chain by anyone holding idSecret: the
//     wallet recomputes N_0, N_1, ... to find the latest k, and decrypts
//     encSpent with key_k. No server, no sync between wallets.
//   - C_k and key_k bind the epoch, so yesterday's state is useless today, and
//     a new local day starts again at k = 0. The pool passes epoch from the
//     registry (local day of the sender's jurisdiction).
//
// Amounts: USDC stroops. Limits come from the sender pack (bound by PackHash,
// validated <= u64::MAX by the registry); range-checked here anyway, since the
// comparators are only sound on range-checked inputs.
//
// Domain tags: 0x12 nullifier, 0x13 commitment, 0x15 state key.

include "../poseidon2/poseidon2_hash.circom";
include "../merkleProof.circom";
include "../circomlib/circuits/comparators.circom";
include "../circomlib/circuits/bitify.circom";

template BudgetHash(dom) {
    signal input a;
    signal input b;
    signal input c;
    signal output out;
    component h = Poseidon2(3);
    h.inputs[0] <== a;
    h.inputs[1] <== b;
    h.inputs[2] <== c;
    h.domainSeparation <== dom;
    out <== h.out;
}

template BudgetCommitment() {
    signal input idCommitment;
    signal input epoch;
    signal input seq;
    signal input spent;
    signal input key;
    signal output out;
    component inner = BudgetHash(0x13);
    inner.a <== idCommitment;
    inner.b <== epoch;
    inner.c <== seq;
    component outer = BudgetHash(0x13);
    outer.a <== inner.out;
    outer.b <== spent;
    outer.c <== key;
    out <== outer.out;
}

template DailyBudget(levels) {
    // public (wired by the parent circuit / pool)
    signal input epoch;
    signal input budgetRoot;

    // private
    signal input idSecret;
    signal input idCommitment;      // from IdentityKeys in the parent
    signal input perPaymentLimit;   // from TierSelect in the parent
    signal input dailyLimit;
    signal input sent;              // amount leaving the sender in this payment
    signal input seq;
    signal input spent;             // spent today before this payment
    signal input pathElements[levels];
    signal input pathIndices;

    signal output nullifier;
    signal output newCommitment;
    signal output encNewSpent;

    // ---- ranges ----
    component rSent = Num2Bits(64);    rSent.in <== sent;
    component rSpent = Num2Bits(64);   rSpent.in <== spent;
    component rPer = Num2Bits(64);     rPer.in <== perPaymentLimit;
    component rDaily = Num2Bits(64);   rDaily.in <== dailyLimit;
    component rSeq = Num2Bits(32);     rSeq.in <== seq;

    signal newSpent <== spent + sent;  // < 2^65, no wrap

    // ---- limits ----
    component perOk = LessEqThan(65);
    perOk.in[0] <== sent;
    perOk.in[1] <== perPaymentLimit;
    perOk.out === 1;

    component dailyOk = LessEqThan(65);
    dailyOk.in[0] <== newSpent;
    dailyOk.in[1] <== dailyLimit;
    dailyOk.out === 1;

    // ---- previous state ----
    component isFirst = IsZero();
    isFirst.in <== seq;
    spent * isFirst.out === 0;   // first payment of the day starts from 0

    component key = BudgetHash(0x15);
    key.a <== idSecret;
    key.b <== epoch;
    key.c <== seq;

    component prev = BudgetCommitment();
    prev.idCommitment <== idCommitment;
    prev.epoch <== epoch;
    prev.seq <== seq;
    prev.spent <== spent;
    prev.key <== key.out;

    component inTree = MerkleProof(levels);
    inTree.leaf <== prev.out;
    inTree.pathElements <== pathElements;
    inTree.pathIndices <== pathIndices;
    // Not first: the previous state must be in the budget tree.
    (inTree.root - budgetRoot) * (1 - isFirst.out) === 0;

    component nul = BudgetHash(0x12);
    nul.a <== idSecret;
    nul.b <== epoch;
    nul.c <== seq;
    nullifier <== nul.out;

    // ---- next state ----
    component nextKey = BudgetHash(0x15);
    nextKey.a <== idSecret;
    nextKey.b <== epoch;
    nextKey.c <== seq + 1;

    component next = BudgetCommitment();
    next.idCommitment <== idCommitment;
    next.epoch <== epoch;
    next.seq <== seq + 1;
    next.spent <== newSpent;
    next.key <== nextKey.out;
    newCommitment <== next.out;

    encNewSpent <== newSpent + nextKey.out;
}
