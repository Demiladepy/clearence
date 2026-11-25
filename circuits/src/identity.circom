pragma circom 2.2.2;
// Clearance: identity and KYC tier.
//
// One person = one `idSecret`, held by their wallet(s). Everything a payment
// needs about who is paying is derived from it:
//
//   idCommitment = Poseidon2(idSecret, 0; 0x10)      given to the operator at KYC
//   noteKey      = Poseidon2(idSecret, 1; 0x10)      spending key for the pool notes
//   leaf         = Poseidon2(
//                    Poseidon2(idCommitment, jurisdiction, tier; 0x11),
//                    issuance; 0x11)                 inserted by the operator
//
// - Every wallet the person uses derives the same idCommitment and noteKey,
//   so they share one identity and one daily budget (FR-3, AT-3).
// - The leaf binds the jurisdiction, so an identity KYC'd in Ghana proves
//   nothing under Nigeria's pack, even if two countries ever share a tree.
// - `issuance` lets the operator re-issue a leaf after a revocation or a tier
//   change without colliding with the revoked leaf.
// - The tier selects that tier's limits from the sender's pack, as private
//   signals. The pack values themselves are bound by PackHash.
//
// Domain tags 0x10 and 0x11 are unused upstream (0x01-0x06 are taken).

include "../poseidon2/poseidon2_hash.circom";
include "../merkleProof.circom";

template IdentityKeys() {
    signal input idSecret;
    signal output idCommitment;
    signal output noteKey;

    component c = Poseidon2(2);
    c.inputs[0] <== idSecret;
    c.inputs[1] <== 0;
    c.domainSeparation <== 0x10;
    idCommitment <== c.out;

    component k = Poseidon2(2);
    k.inputs[0] <== idSecret;
    k.inputs[1] <== 1;
    k.domainSeparation <== 0x10;
    noteKey <== k.out;
}

template TierLeaf() {
    signal input idCommitment;
    signal input jurisdiction;
    signal input tier;
    signal input issuance;
    signal output leaf;

    component inner = Poseidon2(3);
    inner.inputs[0] <== idCommitment;
    inner.inputs[1] <== jurisdiction;
    inner.inputs[2] <== tier;
    inner.domainSeparation <== 0x11;

    component outer = Poseidon2(2);
    outer.inputs[0] <== inner.out;
    outer.inputs[1] <== issuance;
    outer.domainSeparation <== 0x11;
    leaf <== outer.out;
}

// Selects the limits for `tier` (1, 2 or 3). Fails for any other tier.
template TierSelect() {
    signal input tier;
    signal input perPayment[3];
    signal input daily[3];
    signal output perPaymentLimit;
    signal output dailyLimit;

    signal s[3];
    signal pp[3];
    signal dd[3];
    var sum = 0;
    var weighted = 0;
    var ppAcc = 0;
    var ddAcc = 0;
    for (var t = 0; t < 3; t++) {
        s[t] <-- tier == t + 1 ? 1 : 0;
        s[t] * (s[t] - 1) === 0;
        sum += s[t];
        weighted += (t + 1) * s[t];
        pp[t] <== s[t] * perPayment[t];
        dd[t] <== s[t] * daily[t];
        ppAcc += pp[t];
        ddAcc += dd[t];
    }
    sum === 1;           // exactly one tier selected
    weighted === tier;   // and it is `tier`
    perPaymentLimit <== ppAcc;
    dailyLimit <== ddAcc;
}

// Proves: the sender holds an identity the sender's operator issued at
// `tier`, in the tree with root `identityRoot`, and outputs that tier's limits.
template ClearanceIdentity(levels) {
    // public (wired by the parent circuit)
    signal input identityRoot;
    signal input jurisdiction;      // sender's jurisdiction, also hashed into senderPackHash

    // private
    signal input idSecret;
    signal input tier;
    signal input issuance;
    signal input pathElements[levels];
    signal input pathIndices;
    signal input perPayment[3];     // sender pack, bound by PackHash
    signal input daily[3];

    signal output idCommitment;
    signal output noteKey;
    signal output perPaymentLimit;
    signal output dailyLimit;

    component keys = IdentityKeys();
    keys.idSecret <== idSecret;
    idCommitment <== keys.idCommitment;
    noteKey <== keys.noteKey;

    component leaf = TierLeaf();
    leaf.idCommitment <== keys.idCommitment;
    leaf.jurisdiction <== jurisdiction;
    leaf.tier <== tier;
    leaf.issuance <== issuance;

    component proof = MerkleProof(levels);
    proof.leaf <== leaf.leaf;
    proof.pathElements <== pathElements;
    proof.pathIndices <== pathIndices;
    proof.root === identityRoot;

    component sel = TierSelect();
    sel.tier <== tier;
    sel.perPayment <== perPayment;
    sel.daily <== daily;
    perPaymentLimit <== sel.perPaymentLimit;
    dailyLimit <== sel.dailyLimit;
}
