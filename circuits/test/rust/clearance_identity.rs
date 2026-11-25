//! Clearance: identity and KYC tier.
//!
//! Public signal order (circom puts outputs first):
//!   [idCommitment, noteKey, perPaymentLimit, dailyLimit, identityRoot, jurisdiction]

#[cfg(test)]
mod tests {
    use crate::test::utils::{
        circom_tester::{CircuitKeys, Inputs, generate_keys, prove_and_verify_with_keys},
        general::{load_artifacts, poseidon2_hash2, poseidon2_hash3},
        merkle_tree::{merkle_proof_padded, merkle_root_padded},
    };
    use anyhow::Result;
    use ark_bn254::Fr as Scalar;
    use ark_ff::{BigInteger, PrimeField};
    use num_bigint::{BigInt, BigUint, Sign};
    use std::path::PathBuf;

    const LEVELS: usize = 10;
    const NG: u64 = 566;
    const GH: u64 = 288;
    const STROOPS: u64 = 10_000_000;
    // NG v1 testnet pack (illustrative): (perPayment, daily) per tier, stroops.
    const NG_TIERS: [(u64, u64); 3] = [
        (187_500_000, 312_500_000),
        (625 * STROOPS, 1250 * STROOPS),
        (3125 * STROOPS, 6250 * STROOPS),
    ];

    fn big(s: Scalar) -> BigInt {
        BigInt::from_biguint(Sign::Plus, BigUint::from_bytes_be(&s.into_bigint().to_bytes_be()))
    }

    // ---- Rust reference: what the wallet and the operator compute ----

    fn id_commitment(id_secret: Scalar) -> Scalar {
        poseidon2_hash2(id_secret, Scalar::from(0u64), Some(Scalar::from(0x10u64)))
    }
    fn note_key(id_secret: Scalar) -> Scalar {
        poseidon2_hash2(id_secret, Scalar::from(1u64), Some(Scalar::from(0x10u64)))
    }
    fn leaf(id_commitment: Scalar, jurisdiction: u64, tier: u64, issuance: u64) -> Scalar {
        let d = Some(Scalar::from(0x11u64));
        let inner = poseidon2_hash3(id_commitment, Scalar::from(jurisdiction), Scalar::from(tier), d);
        poseidon2_hash2(inner, Scalar::from(issuance), d)
    }

    /// An operator's allow-list: a few other people plus Ada at `index`.
    struct Registry {
        leaves: Vec<Scalar>,
    }
    impl Registry {
        fn with(ada_leaf: Scalar) -> (Self, usize) {
            let mut leaves: Vec<Scalar> = (0..5u64)
                .map(|i| leaf(id_commitment(Scalar::from(1000 + i)), NG, 1 + i % 3, 0))
                .collect();
            leaves.push(ada_leaf);
            (Self { leaves }, 5)
        }
        fn root(&self) -> Scalar {
            merkle_root_padded(&self.leaves, LEVELS)
        }
    }

    struct Case {
        id_secret: Scalar,
        tier: u64,
        issuance: u64,
        jurisdiction: u64,
        root: Scalar,
        path: (Vec<Scalar>, u64),
    }

    fn case(id_secret: u64, issued_tier: u64, issued_in: u64) -> Case {
        let s = Scalar::from(id_secret);
        let (reg, idx) = Registry::with(leaf(id_commitment(s), issued_in, issued_tier, 0));
        Case {
            id_secret: s,
            tier: issued_tier,
            issuance: 0,
            jurisdiction: issued_in,
            root: reg.root(),
            path: merkle_proof_padded(&reg.leaves, idx, LEVELS),
        }
    }

    fn inputs(c: &Case) -> Inputs {
        let mut i = Inputs::new();
        i.set("identityRoot", big(c.root));
        i.set("jurisdiction", BigInt::from(c.jurisdiction));
        i.set("idSecret", big(c.id_secret));
        i.set("tier", BigInt::from(c.tier));
        i.set("issuance", BigInt::from(c.issuance));
        i.set("pathElements", c.path.0.iter().map(|e| big(*e)).collect::<Vec<_>>());
        i.set("pathIndices", BigInt::from(c.path.1));
        i.set("perPayment", NG_TIERS.iter().map(|t| BigInt::from(t.0)).collect::<Vec<_>>());
        i.set("daily", NG_TIERS.iter().map(|t| BigInt::from(t.1)).collect::<Vec<_>>());
        i
    }

    struct Circuit {
        wasm: PathBuf,
        r1cs: PathBuf,
        keys: CircuitKeys,
    }
    impl Circuit {
        fn load() -> Result<Self> {
            let (wasm, r1cs) = load_artifacts("clearance_identity_test")?;
            let keys = generate_keys(&r1cs)?;
            Ok(Self { wasm, r1cs, keys })
        }
        fn prove(&self, i: &Inputs) -> Result<Vec<BigInt>> {
            let r = prove_and_verify_with_keys(&self.wasm, &self.r1cs, i, &self.keys)?;
            anyhow::ensure!(r.verified, "proof did not verify");
            Ok(r.public_inputs.into_iter().map(big).collect())
        }
    }

    #[test]
    #[ignore]
    fn each_tier_gets_its_own_limits() -> Result<()> {
        let c = Circuit::load()?;
        for tier in 1..=3u64 {
            let k = case(42, tier, NG);
            let out = c.prove(&inputs(&k))?;
            let (pp, daily) = NG_TIERS[(tier - 1) as usize];
            assert_eq!(out[0], big(id_commitment(k.id_secret)), "idCommitment");
            assert_eq!(out[1], big(note_key(k.id_secret)), "noteKey");
            assert_eq!(out[2], BigInt::from(pp), "tier {tier} per-payment");
            assert_eq!(out[3], BigInt::from(daily), "tier {tier} daily");
            assert_eq!(out[4], big(k.root));
            assert_eq!(out[5], BigInt::from(NG));
        }
        Ok(())
    }

    #[test]
    #[ignore]
    fn cannot_claim_a_higher_tier_than_issued() -> Result<()> {
        let c = Circuit::load()?;
        let mut k = case(42, 1, NG);
        k.tier = 3;
        assert!(c.prove(&inputs(&k)).is_err());
        Ok(())
    }

    #[test]
    #[ignore]
    fn ghana_kyc_does_not_prove_under_nigeria() -> Result<()> {
        let c = Circuit::load()?;
        let mut k = case(42, 2, GH);
        assert!(c.prove(&inputs(&k)).is_ok(), "valid in GH");
        k.jurisdiction = NG;
        assert!(c.prove(&inputs(&k)).is_err(), "same leaf, claimed as NG");
        Ok(())
    }

    #[test]
    #[ignore]
    fn someone_elses_secret_fails() -> Result<()> {
        let c = Circuit::load()?;
        let mut k = case(42, 2, NG);
        k.id_secret = Scalar::from(43u64);
        assert!(c.prove(&inputs(&k)).is_err());
        Ok(())
    }

    #[test]
    #[ignore]
    fn tier_outside_1_to_3_fails_even_if_issued() -> Result<()> {
        // An operator bug that issues tier 0 or 4 must not yield any limits.
        let c = Circuit::load()?;
        for bad in [0u64, 4] {
            let k = case(42, bad, NG);
            assert!(c.prove(&inputs(&k)).is_err(), "tier {bad}");
        }
        Ok(())
    }

    #[test]
    #[ignore]
    fn reissued_leaf_after_revocation_is_distinct() -> Result<()> {
        // Same person, same tier, issuance 1: a new leaf that proves on its own.
        let c = Circuit::load()?;
        let s = Scalar::from(42u64);
        let l0 = leaf(id_commitment(s), NG, 2, 0);
        let l1 = leaf(id_commitment(s), NG, 2, 1);
        assert_ne!(l0, l1);
        let (reg, idx) = Registry::with(l1);
        let k = Case {
            id_secret: s,
            tier: 2,
            issuance: 1,
            jurisdiction: NG,
            root: reg.root(),
            path: merkle_proof_padded(&reg.leaves, idx, LEVELS),
        };
        c.prove(&inputs(&k))?;
        Ok(())
    }
}
