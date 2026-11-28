pragma circom 2.2.2;
// Clearance: the payment circuit.
//
// One proof per payment. On top of upstream's PolicyTransaction (notes,
// nullifiers, balance), it proves:
//
//   1. Ownership: every input note is spent with the sender's noteKey, derived
//      from their idSecret. Notes of a key that was never KYC'd cannot be moved
//      under someone else's identity.
//   2. Identity and tier: the sender's allow-list leaf (idCommitment,
//      senderJurisdiction, tier) is in identityRoot.
//   3. Packs: senderPackHash and receiverPackHash are the hashes of the private
//      pack values, so the limits, thresholds and operator keys used below are
//      exactly what each country's operator published in the rule registry.
//   4. Amount: sent = payment to the receiver + withdrawal. Change goes back
//      to the sender's own key. A deposit into the sender's own balance sends
//      nothing; a deposit that also pays someone counts that payment.
//   5. Limits: sent <= per-payment limit, and today's total <= daily limit,
//      with the sender's tier limits from the sender's pack (DailyBudget).
//   6. Travel Rule: flag = todaysTotal >= min(senderThreshold, receiverThreshold).
//   7. Sealed records: the record (idCommitment, receiverPubKey, 2*sent + flag)
//      is encrypted to the sender operator's key (idx 0) and the receiver
//      operator's key (idx 1), with upstream's GVK encryption. Domestic
//      payments pass the same pack twice, so both records go to one operator
//      and every payment has the same shape on-chain.
//
// Not enforced here (the pool contract checks them against the registry):
// both pack hashes are active, the corridor is open, epoch = registry
// epoch(senderJurisdiction), identityRoot and budgetRoot are known roots,
// the budget nullifier is fresh, nonce = extDataHash.

include "../policyTransaction.circom";
include "../globalViewKey.circom";
include "../circomlib/circuits/comparators.circom";
include "../circomlib/circuits/bitify.circom";
include "./packHash.circom";
include "./identity.circom";
include "./dailyBudget.circom";

template ClearanceTransaction(nIns, nOuts, levels, idLevels, budgetLevels) {
    assert(nOuts == 2); // output 0: payment, output 1: change to self

    /** PUBLIC INPUTS **/
    signal input root;
    signal input publicAmount;
    signal input extDataHash;
    signal input inputNullifier[nIns];
    signal input outputCommitment[nOuts];
    signal input nonce;                 // pool passes extDataHash
    signal input identityRoot;
    signal input budgetRoot;
    signal input epoch;
    signal input senderJurisdiction;
    signal input receiverJurisdiction;
    signal input senderPackHash;
    signal input receiverPackHash;

    /** PRIVATE: notes **/
    signal input inAmount[nIns];
    signal input inPrivateKey[nIns];
    signal input inBlinding[nIns];
    signal input inPathIndices[nIns];
    signal input inPathElements[nIns][levels];
    signal input outAmount[nOuts];
    signal input outPubkey[nOuts];
    signal input outBlinding[nOuts];
    signal input deposit;               // publicAmount = deposit - withdrawal
    signal input withdrawal;

    /** PRIVATE: identity **/
    signal input idSecret;
    signal input tier;
    signal input issuance;
    signal input idPathElements[idLevels];
    signal input idPathIndices;

    /** PRIVATE: budget **/
    signal input budgetSeq;
    signal input budgetSpent;
    signal input budgetPathElements[budgetLevels];
    signal input budgetPathIndices;

    /** PRIVATE: packs **/
    signal input sVersion;
    signal input sUtcOffsetShifted;
    signal input sThreshold;
    signal input sPerPayment[3];
    signal input sDaily[3];
    signal input sOperatorKey[2];
    signal input rVersion;
    signal input rUtcOffsetShifted;
    signal input rThreshold;
    signal input rPerPayment[3];
    signal input rDaily[3];
    signal input rOperatorKey[2];

    /** PRIVATE: record encryption **/
    signal input recordSalt[2];

    /** OUTPUTS (public) **/
    signal output budgetNullifier;
    signal output newBudgetCommitment;
    signal output encNewSpent;
    signal output recordR[2][2];
    signal output recordC[2][3];

    // ---- base transaction ----
    component core = PolicyTransaction(nIns, nOuts, levels);
    core.root <== root;
    core.publicAmount <== publicAmount;
    core.extDataHash <== extDataHash;
    core.inputNullifier <== inputNullifier;
    core.outputCommitment <== outputCommitment;
    core.inAmount <== inAmount;
    core.inPrivateKey <== inPrivateKey;
    core.inBlinding <== inBlinding;
    core.inPathIndices <== inPathIndices;
    core.inPathElements <== inPathElements;
    core.outAmount <== outAmount;
    core.outPubkey <== outPubkey;
    core.outBlinding <== outBlinding;

    // ---- 1. identity keys and note ownership ----
    component keys = IdentityKeys();
    keys.idSecret <== idSecret;
    for (var i = 0; i < nIns; i++) {
        inPrivateKey[i] === keys.noteKey;
    }

    // ---- 3. packs ----
    component sPack = PackHash();
    sPack.jurisdiction <== senderJurisdiction;
    sPack.version <== sVersion;
    sPack.utcOffsetShifted <== sUtcOffsetShifted;
    sPack.travelRuleThreshold <== sThreshold;
    sPack.perPayment <== sPerPayment;
    sPack.daily <== sDaily;
    sPack.operatorKey <== sOperatorKey;
    sPack.out === senderPackHash;

    component rPack = PackHash();
    rPack.jurisdiction <== receiverJurisdiction;
    rPack.version <== rVersion;
    rPack.utcOffsetShifted <== rUtcOffsetShifted;
    rPack.travelRuleThreshold <== rThreshold;
    rPack.perPayment <== rPerPayment;
    rPack.daily <== rDaily;
    rPack.operatorKey <== rOperatorKey;
    rPack.out === receiverPackHash;

    // ---- 2. identity and tier (sender's country) ----
    component id = ClearanceIdentity(idLevels);
    id.identityRoot <== identityRoot;
    id.jurisdiction <== senderJurisdiction;
    id.idSecret <== idSecret;
    id.tier <== tier;
    id.issuance <== issuance;
    id.pathElements <== idPathElements;
    id.pathIndices <== idPathIndices;
    id.perPayment <== sPerPayment;
    id.daily <== sDaily;

    // ---- 4. amount sent ----
    // Change goes back to the sender (same pubkey as the spent notes).
    outPubkey[1] === core.inPublicKey[0];
    // Public amount is a deposit or a withdrawal (never both), each < 2^64.
    component rD = Num2Bits(64);
    rD.in <== deposit;
    component rW = Num2Bits(64);
    rW.in <== withdrawal;
    deposit * withdrawal === 0;
    publicAmount === deposit - withdrawal;
    // What leaves the sender: the payment output plus any withdrawal.
    // Range-checked (< 2^64) in DailyBudget.
    signal sent <== outAmount[0] + withdrawal;

    // ---- 5. limits ----
    component budget = DailyBudget(budgetLevels);
    budget.epoch <== epoch;
    budget.budgetRoot <== budgetRoot;
    budget.idSecret <== idSecret;
    budget.idCommitment <== keys.idCommitment;
    budget.perPaymentLimit <== id.perPaymentLimit;
    budget.dailyLimit <== id.dailyLimit;
    budget.sent <== sent;
    budget.seq <== budgetSeq;
    budget.spent <== budgetSpent;
    budget.pathElements <== budgetPathElements;
    budget.pathIndices <== budgetPathIndices;
    budgetNullifier <== budget.nullifier;
    newBudgetCommitment <== budget.newCommitment;
    encNewSpent <== budget.encNewSpent;

    // ---- 6. Travel Rule flag against the stricter threshold ----
    component rST = Num2Bits(64); rST.in <== sThreshold;
    component rRT = Num2Bits(64); rRT.in <== rThreshold;
    component senderStricter = LessThan(64);
    senderStricter.in[0] <== sThreshold;
    senderStricter.in[1] <== rThreshold;
    signal threshold <== rThreshold + senderStricter.out * (sThreshold - rThreshold);
    component over = GreaterEqThan(65);
    over.in[0] <== budget.newSpentOut;
    over.in[1] <== threshold;
    signal flag <== over.out;

    // ---- 7. sealed records ----
    signal recordValue <== 2 * sent + flag;
    component seal[2];
    for (var k = 0; k < 2; k++) {
        seal[k] = GlobalViewKeyEncryption();
        seal[k].D[0] <== k == 0 ? sOperatorKey[0] : rOperatorKey[0];
        seal[k].D[1] <== k == 0 ? sOperatorKey[1] : rOperatorKey[1];
        seal[k].nonce <== nonce;
        seal[k].idx <== k;
        seal[k].pk <== keys.idCommitment;
        seal[k].amount <== outPubkey[0];
        seal[k].blinding <== recordValue;
        seal[k].salt <== recordSalt[k];
        recordR[k][0] <== seal[k].R[0];
        recordR[k][1] <== seal[k].R[1];
        recordC[k][0] <== seal[k].c1;
        recordC[k][1] <== seal[k].c2;
        recordC[k][2] <== seal[k].c3;
    }
}
