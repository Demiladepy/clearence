pragma circom 2.2.2;
// Clearance: rule-pack hash.
//
// Must match `pack_hash` in contracts/rule-registry/src/lib.rs exactly. The
// registry computes this hash on-chain when an operator publishes a pack; the
// circuit recomputes it from private pack values so the proof is bound to
// exactly the limits the operator published.
//
// packHash = chained Poseidon2 (t=3, domain 0x14) over, in order:
//   jurisdiction, version, utcOffset + 2^31, travelRuleThreshold,
//   t1.perPayment, t1.daily, t2.perPayment, t2.daily, t3.perPayment, t3.daily,
//   operatorKey.x, operatorKey.y
//
// Range checks on the limits are done where they are used (budget checks),
// not here. The hash binds the values; the registry validated their ranges.

include "../poseidon2/poseidon2_hash.circom";

template PackHash() {
    signal input jurisdiction;
    signal input version;
    signal input utcOffsetShifted;     // utc_offset_secs + 2^31
    signal input travelRuleThreshold;  // USDC stroops
    signal input perPayment[3];        // per tier, USDC stroops
    signal input daily[3];             // per tier, USDC stroops
    signal input operatorKey[2];       // Baby JubJub (x, y)

    signal output out;

    var N = 10; // absorbs after hashing (jurisdiction, version)
    signal chain[N + 1];
    signal absorb[N];

    absorb[0] <== utcOffsetShifted;
    absorb[1] <== travelRuleThreshold;
    for (var t = 0; t < 3; t++) {
        absorb[2 + 2 * t] <== perPayment[t];
        absorb[3 + 2 * t] <== daily[t];
    }
    absorb[8] <== operatorKey[0];
    absorb[9] <== operatorKey[1];

    component h[N + 1];
    h[0] = Poseidon2(2);
    h[0].inputs[0] <== jurisdiction;
    h[0].inputs[1] <== version;
    h[0].domainSeparation <== 0x14;
    chain[0] <== h[0].out;

    for (var i = 0; i < N; i++) {
        h[i + 1] = Poseidon2(2);
        h[i + 1].inputs[0] <== chain[i];
        h[i + 1].inputs[1] <== absorb[i];
        h[i + 1].domainSeparation <== 0x14;
        chain[i + 1] <== h[i + 1].out;
    }

    out <== chain[N];
}
