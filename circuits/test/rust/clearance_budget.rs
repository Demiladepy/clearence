//! Clearance: per-payment limit and daily budget per person.
//!
//! Public signal order: [nullifier, newCommitment, encNewSpent, epoch, budgetRoot].
//!
//! `Ledger` applies the two rules the pool contract enforces for the budget
//! (nullifier not seen before, root is the current budget-tree root) so
//! multi-payment and multi-wallet days can be run end to end against real
//! proofs. The on-chain version of these rules is tested with the pool.
//! `Wallet::recover` is the wallet-side state recovery the SDK will use.

#[cfg(test)]
mod tests {
    use crate::test::utils::{
        circom_tester::{CircuitKeys, Inputs, generate_keys, prove_and_verify_with_keys},
        general::{load_artifacts, poseidon2_hash2, poseidon2_hash3},
        merkle_tree::{merkle_proof_padded, merkle_root_padded},
    };
    use anyhow::{Result, anyhow, ensure};
    use ark_bn254::Fr as Scalar;
    use ark_ff::{BigInteger, PrimeField};
    use num_bigint::{BigInt, BigUint, Sign};
    use std::{collections::HashSet, path::PathBuf, sync::OnceLock};

    const LEVELS: usize = 10;
    const EPOCH: u64 = 20_783; // a local day number, as returned by registry.epoch()
    // NG v1 tier 1 (illustrative): 18.75 USD per payment, 31.25 USD per day.
    const PER: u64 = 187_500_000;
    const DAILY: u64 = 312_500_000;

    fn s(v: u64) -> Scalar {
        Scalar::from(v)
    }
    fn big(x: Scalar) -> BigInt {
        BigInt::from_biguint(Sign::Plus, BigUint::from_bytes_be(&x.into_bigint().to_bytes_be()))
    }

    // ---- Rust reference, written from the spec in dailyBudget.circom ----

    fn id_commitment(id: Scalar) -> Scalar {
        poseidon2_hash2(id, s(0), Some(s(0x10)))
    }
    fn h3(a: Scalar, b: Scalar, c: Scalar, dom: u64) -> Scalar {
        poseidon2_hash3(a, b, c, Some(s(dom)))
    }
    fn key(id: Scalar, epoch: u64, k: u64) -> Scalar {
        h3(id, s(epoch), s(k), 0x15)
    }
    fn nullifier(id: Scalar, epoch: u64, k: u64) -> Scalar {
        h3(id, s(epoch), s(k), 0x12)
    }
    fn commitment(id: Scalar, epoch: u64, k: u64, spent: u64) -> Scalar {
        let inner = h3(id_commitment(id), s(epoch), s(k), 0x13);
        h3(inner, s(spent), key(id, epoch, k), 0x13)
    }

    // ---- what the chain records per payment ----

    #[derive(Clone)]
    struct Event {
        nullifier: Scalar,
        commitment: Scalar,
        enc_spent: Scalar,
    }

    #[derive(Default)]
    struct Ledger {
        leaves: Vec<Scalar>,
        nullifiers: HashSet<Vec<u8>>,
        events: Vec<Event>,
    }
    impl Ledger {
        fn root(&self) -> Scalar {
            merkle_root_padded(&self.leaves, LEVELS)
        }
        /// Pool rules: proof verified (done by caller), root current, nullifier fresh.
        fn accept(&mut self, out: &[Scalar], root_used: Scalar) -> Result<()> {
            ensure!(out[4] == root_used && root_used == self.root(), "unknown budget root");
            let n = out[0].into_bigint().to_bytes_be();
            ensure!(self.nullifiers.insert(n), "budget nullifier already used");
            self.leaves.push(out[1]);
            self.events.push(Event { nullifier: out[0], commitment: out[1], enc_spent: out[2] });
            Ok(())
        }
    }

    struct Circuit {
        wasm: PathBuf,
        r1cs: PathBuf,
        keys: CircuitKeys,
    }
    fn circuit() -> &'static Circuit {
        static C: OnceLock<Circuit> = OnceLock::new();
        C.get_or_init(|| {
            let (wasm, r1cs) = load_artifacts("clearance_budget_test").expect("make circuits");
            let keys = generate_keys(&r1cs).expect("keys");
            Circuit { wasm, r1cs, keys }
        })
    }

    /// One wallet. Holds only idSecret; everything else comes from the chain.
    struct Wallet {
        id: Scalar,
    }
    struct State {
        seq: u64,
        spent: u64,
        path: (Vec<Scalar>, u64),
    }
    impl Wallet {
        /// Find today's latest state from chain events alone.
        fn recover(&self, ledger: &Ledger, epoch: u64) -> Result<State> {
            let mut seq = 0;
            let mut spent = 0u64;
            let mut idx = None;
            loop {
                let n = nullifier(self.id, epoch, seq);
                let Some(_) = ledger.events.iter().find(|e| e.nullifier == n) else { break };
                // State seq+1 was created by that payment: find and decrypt it.
                let k = key(self.id, epoch, seq + 1);
                let (i, e) = ledger
                    .events
                    .iter()
                    .enumerate()
                    .find(|(_, e)| {
                        let v = e.enc_spent - k;
                        let v64 = big(v);
                        v64 < BigInt::from(1u128 << 65)
                            && e.commitment == commitment(self.id, epoch, seq + 1, u64::try_from(v64).unwrap_or(0))
                    })
                    .ok_or_else(|| anyhow!("state {} not found", seq + 1))?;
                spent = u64::try_from(big(e.enc_spent - k))?;
                idx = Some(i);
                seq += 1;
            }
            let path = match idx {
                Some(i) => merkle_proof_padded(&ledger.leaves, i, LEVELS),
                None => (vec![Scalar::from(0u64); LEVELS], 0),
            };
            Ok(State { seq, spent, path })
        }

        fn inputs(&self, epoch: u64, root: Scalar, st: &State, sent: u64) -> Inputs {
            let mut i = Inputs::new();
            i.set("epoch", BigInt::from(epoch));
            i.set("budgetRoot", big(root));
            i.set("idSecret", big(self.id));
            i.set("perPaymentLimit", BigInt::from(PER));
            i.set("dailyLimit", BigInt::from(DAILY));
            i.set("sent", BigInt::from(sent));
            i.set("seq", BigInt::from(st.seq));
            i.set("spent", BigInt::from(st.spent));
            i.set("pathElements", st.path.0.iter().map(|e| big(*e)).collect::<Vec<_>>());
            i.set("pathIndices", BigInt::from(st.path.1));
            i
        }

        fn prove(&self, i: &Inputs) -> Result<Vec<Scalar>> {
            let c = circuit();
            let r = prove_and_verify_with_keys(&c.wasm, &c.r1cs, i, &c.keys)?;
            ensure!(r.verified, "proof did not verify");
            Ok(r.public_inputs)
        }

        /// Recover state, prove, submit. What the SDK's send() does for the budget.
        fn pay(&self, ledger: &mut Ledger, epoch: u64, sent: u64) -> Result<u64> {
            let st = self.recover(ledger, epoch)?;
            let root = ledger.root();
            let out = self.prove(&self.inputs(epoch, root, &st, sent))?;
            ledger.accept(&out, root)?;
            Ok(st.spent + sent)
        }
    }

    // ---------------- tests ----------------

    #[test]
    #[ignore]
    fn outputs_match_the_rust_reference() -> Result<()> {
        let w = Wallet { id: s(42) };
        let mut l = Ledger::default();
        let st = w.recover(&l, EPOCH)?;
        let out = w.prove(&w.inputs(EPOCH, l.root(), &st, 100_000_000))?;
        assert_eq!(out[0], nullifier(w.id, EPOCH, 0));
        assert_eq!(out[1], commitment(w.id, EPOCH, 1, 100_000_000));
        assert_eq!(out[2], s(100_000_000) + key(w.id, EPOCH, 1));
        assert_eq!(out[3], s(EPOCH));
        l.accept(&out, l.root())?;
        // and the wallet reads the same total back from the chain
        assert_eq!(w.recover(&l, EPOCH)?.spent, 100_000_000);
        Ok(())
    }

    #[test]
    #[ignore]
    fn per_payment_limit_under_at_over() -> Result<()> {
        let w = Wallet { id: s(42) };
        let l = Ledger::default();
        let st = w.recover(&l, EPOCH)?;
        assert!(w.prove(&w.inputs(EPOCH, l.root(), &st, PER - 1)).is_ok(), "under");
        assert!(w.prove(&w.inputs(EPOCH, l.root(), &st, PER)).is_ok(), "at");
        assert!(w.prove(&w.inputs(EPOCH, l.root(), &st, PER + 1)).is_err(), "one stroop over");
        Ok(())
    }

    #[test]
    #[ignore]
    fn daily_budget_under_at_over_across_payments() -> Result<()> {
        // 15 + 15 = 30 USD, then 1.25 USD reaches exactly 31.25; 1 stroop more fails.
        let w = Wallet { id: s(42) };
        let mut l = Ledger::default();
        assert_eq!(w.pay(&mut l, EPOCH, 150_000_000)?, 150_000_000);
        assert_eq!(w.pay(&mut l, EPOCH, 150_000_000)?, 300_000_000);
        // each payment is under the per-payment limit; the cumulative total is what binds
        let st = w.recover(&l, EPOCH)?;
        assert!(w.prove(&w.inputs(EPOCH, l.root(), &st, 12_500_001)).is_err(), "over by 1 stroop");
        assert_eq!(w.pay(&mut l, EPOCH, 12_500_000)?, DAILY, "exactly at the daily limit");
        let st = w.recover(&l, EPOCH)?;
        assert!(w.prove(&w.inputs(EPOCH, l.root(), &st, 1)).is_err(), "nothing left today");
        Ok(())
    }

    #[test]
    #[ignore]
    fn second_wallet_shares_the_budget() -> Result<()> {
        // Same person (same idSecret), two devices, no communication between them.
        let phone = Wallet { id: s(42) };
        let laptop = Wallet { id: s(42) };
        let mut l = Ledger::default();
        phone.pay(&mut l, EPOCH, 187_500_000)?; // 18.75 spent on the phone

        // Laptop tries a fresh start: valid proof, but the pool rejects the reused nullifier.
        let fresh = State { seq: 0, spent: 0, path: (vec![s(0); LEVELS], 0) };
        let root = l.root();
        let out = laptop.prove(&laptop.inputs(EPOCH, root, &fresh, 150_000_000))?;
        let err = l.accept(&out, root).unwrap_err();
        assert!(err.to_string().contains("nullifier"), "{err}");

        // Laptop pretends it spent less at state 1: no such commitment, proof fails.
        let mut lie = laptop.recover(&l, EPOCH)?;
        assert_eq!(lie.spent, 187_500_000, "laptop recovered the phone's total from the chain");
        lie.spent = 0;
        assert!(laptop.prove(&laptop.inputs(EPOCH, l.root(), &lie, 150_000_000)).is_err());

        // Honest path: laptop continues the same budget, and the limit still holds.
        assert!(laptop.pay(&mut l, EPOCH, 150_000_000).is_err(), "18.75 + 15 > 31.25");
        assert_eq!(laptop.pay(&mut l, EPOCH, 125_000_000)?, DAILY);
        Ok(())
    }

    #[test]
    #[ignore]
    fn budget_resets_at_the_next_local_day_and_old_state_is_useless() -> Result<()> {
        let w = Wallet { id: s(42) };
        let mut l = Ledger::default();
        w.pay(&mut l, EPOCH, 187_500_000)?;
        w.pay(&mut l, EPOCH, 125_000_000)?; // day full

        // Yesterday's state (seq 2, spent 31.25) presented as today: commitment binds the epoch.
        let mut y = w.recover(&l, EPOCH)?;
        assert_eq!(y.seq, 2);
        y.spent = 0;
        assert!(w.prove(&w.inputs(EPOCH + 1, l.root(), &y, 1)).is_err());

        // New day: fresh chain, full budget again.
        assert_eq!(w.pay(&mut l, EPOCH + 1, 187_500_000)?, 187_500_000);
        Ok(())
    }

    #[test]
    #[ignore]
    fn another_persons_state_cannot_be_used() -> Result<()> {
        let ada = Wallet { id: s(42) };
        let eve = Wallet { id: s(43) };
        let mut l = Ledger::default();
        ada.pay(&mut l, EPOCH, 100_000_000)?;
        let st = ada.recover(&l, EPOCH)?; // Ada's real state 1 and path
        assert!(ada.prove(&ada.inputs(EPOCH, l.root(), &st, 1)).is_ok(), "valid for Ada");
        assert!(eve.prove(&eve.inputs(EPOCH, l.root(), &st, 1)).is_err(), "not for Eve");
        Ok(())
    }

    #[test]
    #[ignore]
    fn first_payment_of_the_day_starts_from_zero() -> Result<()> {
        // Keeps day totals truthful: wallets and records assume spent_0 = 0.
        let w = Wallet { id: s(42) };
        let l = Ledger::default();
        let mut st = w.recover(&l, EPOCH)?;
        assert!(w.prove(&w.inputs(EPOCH, l.root(), &st, 1)).is_ok(), "baseline");
        st.spent = 1;
        assert!(w.prove(&w.inputs(EPOCH, l.root(), &st, 1)).is_err());
        Ok(())
    }

    #[test]
    #[ignore]
    fn out_of_range_amounts_fail() -> Result<()> {
        // sent = p - 1 (i.e. "-1" in the field) must not wrap around the limits.
        let w = Wallet { id: s(42) };
        let l = Ledger::default();
        let st = w.recover(&l, EPOCH)?;
        let mut i = w.inputs(EPOCH, l.root(), &st, 1);
        assert!(w.prove(&i).is_ok(), "baseline");
        i.set("sent", big(-Scalar::from(1u64)));
        assert!(w.prove(&i).is_err());
        Ok(())
    }
}
