//! Clearance: rule-pack hash parity.
//!
//! Three implementations of the pack hash must agree:
//!   1. the rule-registry contract (computed on-chain when a pack is published),
//!   2. the Rust reference below,
//!   3. the `PackHash` circuit.
//! The golden values are the NG and GH v1 pack hashes read back from the live
//! testnet registry CDEXDT6BPD5XM7ASG2DQNVEJK37MX75TNSF4F27RD7LU5N7EPKVLOWCB.

#[cfg(test)]
mod tests {
    use crate::test::utils::{
        circom_tester::{Inputs, prove_and_verify},
        general::{load_artifacts, poseidon2_hash2},
    };
    use anyhow::Result;
    use ark_bn254::Fr as Scalar;
    use ark_ff::{BigInteger, PrimeField};
    use num_bigint::{BigInt, BigUint, Sign};

    const PACK_DOMAIN: u64 = 0x14;
    const STROOPS: u64 = 10_000_000;

    struct Pack {
        jurisdiction: u64,
        version: u64,
        utc_offset_secs: i64,
        threshold: u64,
        tiers: [(u64, u64); 3],
        key: (&'static str, &'static str),
        onchain: &'static str,
    }

    // USD amounts as stroops; 18.75 USD = 187_500_000.
    const NG_V1: Pack = Pack {
        jurisdiction: 566,
        version: 1,
        utc_offset_secs: 3600,
        threshold: 1000 * STROOPS,
        tiers: [
            (187_500_000, 312_500_000),
            (625 * STROOPS, 1250 * STROOPS),
            (3125 * STROOPS, 6250 * STROOPS),
        ],
        key: (
            "2fc5abae81b0271fadeb747ef10ceb622c3a25d618c83b7c3791fb5ac39aa7e0",
            "17b6f1f1c0310c052bed7fb45f82ca7002abf8875b86e97938a10341bdd04dc3",
        ),
        onchain: "793274114535773168330462619525225772468182337604504132993004277258700724562",
    };

    const GH_V1: Pack = Pack {
        jurisdiction: 288,
        version: 1,
        utc_offset_secs: 0,
        threshold: 1000 * STROOPS,
        tiers: [
            (15 * STROOPS, 25 * STROOPS),
            (500 * STROOPS, 1000 * STROOPS),
            (2500 * STROOPS, 5000 * STROOPS),
        ],
        key: (
            "039099996fea0e2f95b59776448da792335475da894d4da84372c143d28c45e4",
            "003e4c7c5954dbad5c83d876ce0be5400f0a72a4cb1aaa834d0fa4c49c8d264b",
        ),
        onchain: "15352878594874501808841481184584733912846590580291801597728574576845088907239",
    };

    fn hex_big(h: &str) -> BigInt {
        BigInt::from_bytes_be(Sign::Plus, &hex::decode(h).unwrap())
    }

    fn to_scalar(v: &BigInt) -> Scalar {
        Scalar::from(v.to_biguint().unwrap())
    }

    fn to_big(s: Scalar) -> BigInt {
        BigInt::from_biguint(Sign::Plus, BigUint::from_bytes_be(&s.into_bigint().to_bytes_be()))
    }

    fn offset_shifted(o: i64) -> BigInt {
        BigInt::from(o + (1_i64 << 31))
    }

    /// Rust reference, written independently of the contract.
    fn reference(p: &Pack) -> BigInt {
        let dom = Some(Scalar::from(PACK_DOMAIN));
        let mut h = poseidon2_hash2(Scalar::from(p.jurisdiction), Scalar::from(p.version), dom);
        let mut absorb: Vec<BigInt> =
            vec![offset_shifted(p.utc_offset_secs), BigInt::from(p.threshold)];
        for (pp, d) in p.tiers {
            absorb.push(BigInt::from(pp));
            absorb.push(BigInt::from(d));
        }
        absorb.push(hex_big(p.key.0));
        absorb.push(hex_big(p.key.1));
        for v in absorb {
            h = poseidon2_hash2(h, to_scalar(&v), dom);
        }
        to_big(h)
    }

    fn inputs(p: &Pack) -> Inputs {
        let mut i = Inputs::new();
        i.set("jurisdiction", BigInt::from(p.jurisdiction));
        i.set("version", BigInt::from(p.version));
        i.set("utcOffsetShifted", offset_shifted(p.utc_offset_secs));
        i.set("travelRuleThreshold", BigInt::from(p.threshold));
        i.set("perPayment", p.tiers.iter().map(|t| BigInt::from(t.0)).collect::<Vec<_>>());
        i.set("daily", p.tiers.iter().map(|t| BigInt::from(t.1)).collect::<Vec<_>>());
        i.set("operatorKey", vec![hex_big(p.key.0), hex_big(p.key.1)]);
        i
    }

    #[test]
    fn pack_hash_reference_matches_testnet_registry() {
        for p in [&NG_V1, &GH_V1] {
            let onchain: BigInt = p.onchain.parse().unwrap();
            assert_eq!(reference(p), onchain, "jurisdiction {}", p.jurisdiction);
        }
    }

    #[test]
    #[ignore]
    fn pack_hash_circuit_matches_testnet_registry() -> Result<()> {
        let (wasm, r1cs) = load_artifacts("pack_hash_test")?;
        for p in [&NG_V1, &GH_V1] {
            let res = prove_and_verify(&wasm, &r1cs, &inputs(p))?;
            assert!(res.verified);
            let onchain: BigInt = p.onchain.parse().unwrap();
            assert_eq!(res.public_inputs.len(), 1, "only output is public");
            assert_eq!(to_big(res.public_inputs[0]), onchain, "jurisdiction {}", p.jurisdiction);
        }
        Ok(())
    }

    #[test]
    #[ignore]
    fn pack_hash_circuit_rejects_a_changed_limit() -> Result<()> {
        // A prover who changes one limit gets a different hash, which the
        // pool's `is_active` check then rejects.
        let (wasm, r1cs) = load_artifacts("pack_hash_test")?;
        let mut i = inputs(&NG_V1);
        i.set("daily", vec![BigInt::from(312_500_001u64), BigInt::from(1250 * STROOPS), BigInt::from(6250 * STROOPS)]);
        let res = prove_and_verify(&wasm, &r1cs, &i)?;
        let onchain: BigInt = NG_V1.onchain.parse().unwrap();
        assert_ne!(to_big(res.public_inputs[0]), onchain);
        Ok(())
    }
}
