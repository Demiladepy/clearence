pragma circom 2.2.2;
include "../../clearance/identity.circom";
include "../../clearance/dailyBudget.circom";

// Test entry: identity keys feed the budget, as in the full transfer circuit.
// Public signals: [nullifier, newCommitment, encNewSpent, epoch, budgetRoot].
template BudgetTest(levels) {
    signal input epoch;
    signal input budgetRoot;
    signal input idSecret;
    signal input perPaymentLimit;
    signal input dailyLimit;
    signal input sent;
    signal input seq;
    signal input spent;
    signal input pathElements[levels];
    signal input pathIndices;
    signal output nullifier;
    signal output newCommitment;
    signal output encNewSpent;

    component keys = IdentityKeys();
    keys.idSecret <== idSecret;

    component b = DailyBudget(levels);
    b.epoch <== epoch;
    b.budgetRoot <== budgetRoot;
    b.idSecret <== idSecret;
    b.idCommitment <== keys.idCommitment;
    b.perPaymentLimit <== perPaymentLimit;
    b.dailyLimit <== dailyLimit;
    b.sent <== sent;
    b.seq <== seq;
    b.spent <== spent;
    b.pathElements <== pathElements;
    b.pathIndices <== pathIndices;
    nullifier <== b.nullifier;
    newCommitment <== b.newCommitment;
    encNewSpent <== b.encNewSpent;
}

component main {public [epoch, budgetRoot]} = BudgetTest(10);
