//! Clearance: the full payment circuit, end to end.
//!
//! Real notes in a 20-level pool tree, a real allow-list and budget tree, real
//! Groth16 proofs, and operator-side decryption of the sealed records with each
//! country's private key. Reference implementations here are written from the
//! circuit's spec, independently of the other Clearance test modules.
//!
//! Public signals: outputs first, then public inputs in declaration order.
//!   0 budgetNullifier, 1 newBudgetCommitment, 2 encNewSpent,
//!   3..7  recordR[0].x, recordR[0].y, recordR[1].x, recordR[1].y,
//!   7..13 recordC[0][0..3], recordC[1][0..3],
//!   13 root, 14 publicAmount, 15 extDataHash, 16-17 inputNullifier,
//!   18-19 outputCommitment, 20 nonce, 21 identityRoot, 22 budgetRoot, 23 epoch,
//!   24 senderJurisdiction, 25 receiverJurisdiction, 26 senderPackHash, 27 receiverPackHash

#[cfg(test)]
mod tests {
    use crate::test::utils::{
        circom_tester::{CircuitKeys, Inputs, generate_keys, prove_and_verify_with_keys},
        general::{load_artifacts, poseidon2_hash2, poseidon2_hash3, scalar_to_bigint},
        global_view_key::{Ciphertext, admin_public_key, decrypt_note},
        keypair::derive_public_key,
        merkle_tree::{merkle_proof_padded, merkle_root_padded},
        transaction::prepopulated_prefix,
        transaction_case::{
            InputNote, OutputNote, TxCase, build_base_inputs, prepare_transaction_witness,
        },
    };
    use anyhow::{Result, anyhow, ensure};
    use ark_bn254::Fr as Scalar;
    use num_bigint::BigInt;
    use std::{
        collections::HashSet,
        panic::{self, AssertUnwindSafe},
        path::PathBuf,
        sync::OnceLock,
    };

    const POOL_LEVELS: usize = 20;
    const ID_LEVELS: usize = 10;
    const BUDGET_LEVELS: usize = 20;
    const EPOCH: u64 = 20_783;
    const USD: u64 = 10_000_000; // stroops
    const NG: u64 = 566;
    const GH: u64 = 288;

    fn s(v: u64) -> Scalar {
        Scalar::from(v)
    }
    fn big(x: Scalar) -> BigInt {
        scalar_to_bigint(x)
    }
    /// cents -> stroops
    fn cents(c: u64) -> u64 {
        c * 100_000
    }

    // ---------------- reference: packs, identity, budget ----------------

    #[derive(Clone)]
    struct Pack {
        jurisdiction: u64,
        version: u64,
        offset: i64,
        threshold: u64,
        tiers: [(u64, u64); 3],
        key: (Scalar, Scalar),
    }
    impl Pack {
        fn hash(&self) -> Scalar {
            let d = Some(s(0x14));
            let mut h = poseidon2_hash2(s(self.jurisdiction), s(self.version), d);
            let off = u64::try_from(self.offset + (1 << 31)).unwrap();
            let mut vals = vec![s(off), s(self.threshold)];
            for (p, dd) in self.tiers {
                vals.push(s(p));
                vals.push(s(dd));
            }
            vals.push(self.key.0);
            vals.push(self.key.1);
            for v in vals {
                h = poseidon2_hash2(h, v, d);
            }
            h
        }
        fn set(&self, i: &mut Inputs, p: &str) {
            let off = BigInt::from(self.offset + (1 << 31));
            i.set(format!("{p}Version"), BigInt::from(self.version));
            i.set(format!("{p}UtcOffsetShifted"), off);
            i.set(format!("{p}Threshold"), BigInt::from(self.threshold));
            i.set(format!("{p}PerPayment"), self.tiers.iter().map(|t| BigInt::from(t.0)).collect::<Vec<_>>());
            i.set(format!("{p}Daily"), self.tiers.iter().map(|t| BigInt::from(t.1)).collect::<Vec<_>>());
            i.set(format!("{p}OperatorKey"), vec![big(self.key.0), big(self.key.1)]);
        }
    }

    // Operator private keys (Baby JubJub scalars). Test-only values.
    fn d_ng() -> Scalar {
        s(0x5eed_0566)
    }
    fn d_gh() -> Scalar {
        s(0x5eed_0288)
    }

    // The NG and GH v1 packs as published on testnet (illustrative limits),
    // with test operator keys.
    fn ng_pack() -> Pack {
        Pack {
            jurisdiction: NG,
            version: 1,
            offset: 3600,
            threshold: 1000 * USD,
            tiers: [(cents(1875), cents(3125)), (625 * USD, 1250 * USD), (3125 * USD, 6250 * USD)],
            key: admin_public_key(d_ng()),
        }
    }
    fn gh_pack() -> Pack {
        Pack {
            jurisdiction: GH,
            version: 1,
            offset: 0,
            threshold: 1000 * USD,
            tiers: [(15 * USD, 25 * USD), (500 * USD, 1000 * USD), (2500 * USD, 5000 * USD)],
            key: admin_public_key(d_gh()),
        }
    }

    fn id_commitment(id: Scalar) -> Scalar {
        poseidon2_hash2(id, s(0), Some(s(0x10)))
    }
    fn note_key(id: Scalar) -> Scalar {
        poseidon2_hash2(id, s(1), Some(s(0x10)))
    }
    fn tier_leaf(id: Scalar, j: u64, tier: u64) -> Scalar {
        let d = Some(s(0x11));
        poseidon2_hash2(poseidon2_hash3(id_commitment(id), s(j), s(tier), d), s(0), d)
    }
    fn budget_key(id: Scalar, epoch: u64, k: u64) -> Scalar {
        poseidon2_hash3(id, s(epoch), s(k), Some(s(0x15)))
    }
    fn budget_nullifier(id: Scalar, epoch: u64, k: u64) -> Scalar {
        poseidon2_hash3(id, s(epoch), s(k), Some(s(0x12)))
    }
    fn budget_commitment(id: Scalar, epoch: u64, k: u64, spent: u64) -> Scalar {
        let d = Some(s(0x13));
        let inner = poseidon2_hash3(id_commitment(id), s(epoch), s(k), d);
        poseidon2_hash3(inner, s(spent), budget_key(id, epoch, k), d)
    }

    // ---------------- the chain, as the pool will enforce it ----------------

    #[derive(Default)]
    struct Chain {
        budget_leaves: Vec<Scalar>,
        budget_nullifiers: HashSet<Vec<u8>>,
        /// (budgetNullifier, newBudgetCommitment, encNewSpent) per accepted payment
        events: Vec<(Scalar, Scalar, Scalar)>,
        identity_leaves: Vec<Scalar>,
    }
    impl Chain {
        fn with_people(people: &[&Person]) -> Self {
            let mut c = Self::default();
            for i in 0..4u64 {
                c.identity_leaves.push(tier_leaf(s(9_000 + i), NG, 1)); // other users
            }
            for p in people {
                c.identity_leaves.push(tier_leaf(p.id, p.jurisdiction, p.tier));
            }
            c
        }
        fn budget_root(&self) -> Scalar {
            merkle_root_padded(&self.budget_leaves, BUDGET_LEVELS)
        }
        fn identity_root(&self) -> Scalar {
            merkle_root_padded(&self.identity_leaves, ID_LEVELS)
        }
        fn accept(&mut self, out: &[Scalar]) -> Result<()> {
            ensure!(out[22] == self.budget_root(), "unknown budget root");
            ensure!(out[21] == self.identity_root(), "unknown identity root");
            ensure!(
                self.budget_nullifiers.insert(big(out[0]).to_bytes_be().1),
                "budget nullifier already used"
            );
            self.budget_leaves.push(out[1]);
            self.events.push((out[0], out[1], out[2]));
            Ok(())
        }
    }

    struct Person {
        id: Scalar,
        jurisdiction: u64,
        tier: u64,
    }
    impl Person {
        fn new(id: u64, jurisdiction: u64, tier: u64) -> Self {
            Self { id: s(id), jurisdiction, tier }
        }
        /// Today's budget state, from chain events only (see clearance_budget.rs).
        fn budget_state(&self, chain: &Chain) -> (u64, u64, (Vec<Scalar>, u64)) {
            let (mut seq, mut spent, mut idx) = (0u64, 0u64, None);
            while chain.events.iter().any(|e| e.0 == budget_nullifier(self.id, EPOCH, seq)) {
                let k = budget_key(self.id, EPOCH, seq + 1);
                let (i, e) = chain
                    .events
                    .iter()
                    .enumerate()
                    .find(|(_, e)| {
                        u64::try_from(big(e.2 - k))
                            .is_ok_and(|v| e.1 == budget_commitment(self.id, EPOCH, seq + 1, v))
                    })
                    .expect("state on chain");
                spent = u64::try_from(big(e.2 - k)).unwrap();
                idx = Some(i);
                seq += 1;
            }
            let path = idx.map_or((vec![s(0); BUDGET_LEVELS], 0), |i| {
                merkle_proof_padded(&chain.budget_leaves, i, BUDGET_LEVELS)
            });
            (seq, spent, path)
        }
    }

    // ---------------- a payment ----------------

    #[derive(Clone)]
    struct Payment {
        sender_pack: Pack,
        receiver_pack: Pack,
        notes: [u64; 2],      // input note amounts, owned by the sender's noteKey
        note_owner: Option<Scalar>, // override: spend notes of another private key
        pay: u64,             // output 0, to the receiver
        receiver_pk: Scalar,
        change_pk: Option<Scalar>, // override: change to someone else
        withdrawal: u64,
        deposit: u64,         // public amount in; this circuit must reject it
        claim_jurisdiction: Option<u64>, // override: senderJurisdiction public input
    }
    impl Payment {
        fn domestic(pack: Pack, notes: [u64; 2], pay: u64) -> Self {
            Self {
                receiver_pack: pack.clone(),
                sender_pack: pack,
                notes,
                note_owner: None,
                pay,
                receiver_pk: derive_public_key(s(777)), // Bob
                change_pk: None,
                withdrawal: 0,
                deposit: 0,
                claim_jurisdiction: None,
            }
        }
        fn to(mut self, receiver_pack: Pack) -> Self {
            self.receiver_pack = receiver_pack;
            self
        }
    }

    const EXT_DATA_HASH: u64 = 0xC1EA_2A2C;

    fn inputs(who: &Person, chain: &Chain, p: &Payment) -> Inputs {
        let nk = p.note_owner.unwrap_or_else(|| note_key(who.id));
        let me = derive_public_key(note_key(who.id));
        let change = p.notes[0] + p.notes[1] + p.deposit - p.pay - p.withdrawal;
        let case = TxCase::new(
            vec![
                InputNote { leaf_index: 3, priv_key: nk, blinding: s(11), amount: s(p.notes[0]) },
                InputNote { leaf_index: 6, priv_key: nk, blinding: s(12), amount: s(p.notes[1]) },
            ],
            vec![
                OutputNote { pub_key: p.receiver_pk, blinding: s(21), amount: s(p.pay) },
                OutputNote { pub_key: p.change_pk.unwrap_or(me), blinding: s(22), amount: s(change) },
            ],
        );
        let leaves = prepopulated_prefix(0xC1EA, &[3, 6], 8);
        let w = prepare_transaction_witness(&case, leaves, POOL_LEVELS).expect("witness");
        let mut i = build_base_inputs(&case, &w, s(p.deposit) - s(p.withdrawal));
        i.set("extDataHash", BigInt::from(EXT_DATA_HASH));
        i.set("nonce", BigInt::from(EXT_DATA_HASH));
        i.set("withdrawal", BigInt::from(p.withdrawal));

        let idx = chain
            .identity_leaves
            .iter()
            .position(|l| *l == tier_leaf(who.id, who.jurisdiction, who.tier))
            .unwrap_or(0); // not listed: use some other leaf's path, so the proof must fail
        let (id_path, id_bits) = merkle_proof_padded(&chain.identity_leaves, idx, ID_LEVELS);
        i.set("identityRoot", big(chain.identity_root()));
        i.set("idSecret", big(who.id));
        i.set("tier", BigInt::from(who.tier));
        i.set("issuance", BigInt::from(0u64));
        i.set("idPathElements", id_path.iter().map(|e| big(*e)).collect::<Vec<_>>());
        i.set("idPathIndices", BigInt::from(id_bits));

        let (seq, spent, (bpath, bbits)) = who.budget_state(chain);
        i.set("budgetRoot", big(chain.budget_root()));
        i.set("epoch", BigInt::from(EPOCH));
        i.set("budgetSeq", BigInt::from(seq));
        i.set("budgetSpent", BigInt::from(spent));
        i.set("budgetPathElements", bpath.iter().map(|e| big(*e)).collect::<Vec<_>>());
        i.set("budgetPathIndices", BigInt::from(bbits));

        let sj = p.claim_jurisdiction.unwrap_or(p.sender_pack.jurisdiction);
        i.set("senderJurisdiction", BigInt::from(sj));
        i.set("receiverJurisdiction", BigInt::from(p.receiver_pack.jurisdiction));
        i.set("senderPackHash", big(p.sender_pack.hash()));
        i.set("receiverPackHash", big(p.receiver_pack.hash()));
        p.sender_pack.set(&mut i, "s");
        p.receiver_pack.set(&mut i, "r");
        i.set("recordSalt", vec![BigInt::from(31u64), BigInt::from(32u64)]);
        i
    }

    struct Circuit {
        wasm: PathBuf,
        r1cs: PathBuf,
        keys: CircuitKeys,
    }
    fn circuit() -> &'static Circuit {
        static C: OnceLock<Circuit> = OnceLock::new();
        C.get_or_init(|| {
            let (wasm, r1cs) = load_artifacts("clearance_tx_2_2").expect("make circuits");
            let keys = generate_keys(&r1cs).expect("keys");
            Circuit { wasm, r1cs, keys }
        })
    }

    fn prove(i: &Inputs) -> Result<Vec<Scalar>> {
        let c = circuit();
        let r = panic::catch_unwind(AssertUnwindSafe(|| {
            prove_and_verify_with_keys(&c.wasm, &c.r1cs, i, &c.keys)
        }))
        .map_err(|_| anyhow!("prover panicked"))??;
        ensure!(r.verified, "proof did not verify");
        Ok(r.public_inputs)
    }

    /// Prove and submit to the chain. What the SDK's send() will do.
    fn pay(who: &Person, chain: &mut Chain, p: &Payment) -> Result<Vec<Scalar>> {
        let out = prove(&inputs(who, chain, p))?;
        chain.accept(&out)?;
        Ok(out)
    }

    /// Operator side: open record `k` with a private key.
    /// Returns (idCommitment, receiverPubKey, sent, travelRuleFlag).
    fn open(out: &[Scalar], k: usize, d_priv: Scalar) -> (Scalar, Scalar, u64, bool) {
        let ct = Ciphertext {
            r: (out[3 + 2 * k], out[4 + 2 * k]),
            c1: out[7 + 3 * k],
            c2: out[8 + 3 * k],
            c3: out[9 + 3 * k],
        };
        let m = decrypt_note(&ct, d_priv);
        let v = u64::try_from(big(m.blinding)).unwrap_or(u64::MAX);
        (m.pk, m.amount, v / 2, v % 2 == 1)
    }

    // ---------------- tests ----------------

    #[test]
    #[ignore]
    fn domestic_nigeria_payment_and_operator_opens_the_record() -> Result<()> {
        let ada = Person::new(42, NG, 1);
        let mut chain = Chain::with_people(&[&ada]);
        let p = Payment::domestic(ng_pack(), [10 * USD, 10 * USD], 15 * USD);
        let out = pay(&ada, &mut chain, &p)?;

        // public signals are where the pool expects them
        assert_eq!(out[23], s(EPOCH));
        assert_eq!(out[24], s(NG));
        assert_eq!(out[26], ng_pack().hash());
        assert_eq!(out[27], ng_pack().hash());
        // no amount, sender or receiver in the public signals
        for v in [s(15 * USD), id_commitment(ada.id), p.receiver_pk] {
            assert!(!out.contains(&v), "leaked {v}");
        }
        // NG operator opens both copies
        for k in 0..2 {
            assert_eq!(
                open(&out, k, d_ng()),
                (id_commitment(ada.id), p.receiver_pk, 15 * USD, false),
                "record {k}"
            );
        }
        Ok(())
    }

    #[test]
    #[ignore]
    fn same_payment_passes_in_nigeria_and_fails_in_ghana() -> Result<()> {
        // Tier 1 per-payment: NG 18.75 USD, GH 15 USD. Payment: 16 USD.
        let ada = Person::new(42, NG, 1);
        let kofi = Person::new(43, GH, 1);
        let mut chain = Chain::with_people(&[&ada, &kofi]);
        pay(&ada, &mut chain, &Payment::domestic(ng_pack(), [10 * USD, 10 * USD], 16 * USD))?;
        let p = Payment::domestic(gh_pack(), [10 * USD, 10 * USD], 16 * USD);
        assert!(prove(&inputs(&kofi, &chain, &p)).is_err(), "16 USD over GH tier 1");
        let p = Payment::domestic(gh_pack(), [10 * USD, 10 * USD], 15 * USD);
        pay(&kofi, &mut chain, &p)?; // at GH's limit
        Ok(())
    }

    #[test]
    #[ignore]
    fn cross_border_each_operator_opens_only_its_own_record() -> Result<()> {
        let ada = Person::new(42, NG, 1);
        let mut chain = Chain::with_people(&[&ada]);
        let p = Payment::domestic(ng_pack(), [10 * USD, 10 * USD], 15 * USD).to(gh_pack());
        let out = pay(&ada, &mut chain, &p)?;
        assert_eq!((out[24], out[25]), (s(NG), s(GH)));
        assert_eq!((out[26], out[27]), (ng_pack().hash(), gh_pack().hash()));
        let expected = (id_commitment(ada.id), p.receiver_pk, 15 * USD, false);
        assert_eq!(open(&out, 0, d_ng()), expected, "NG opens record 0");
        assert_eq!(open(&out, 1, d_gh()), expected, "GH opens record 1");
        assert_ne!(open(&out, 1, d_ng()), expected, "NG cannot open GH's record");
        assert_ne!(open(&out, 0, d_gh()), expected, "GH cannot open NG's record");
        Ok(())
    }

    #[test]
    #[ignore]
    fn cross_border_uses_the_senders_limits() -> Result<()> {
        // NG sender to GH: 16 USD is over GH's tier 1 but within NG's, and passes.
        let ada = Person::new(42, NG, 1);
        let mut chain = Chain::with_people(&[&ada]);
        let p = Payment::domestic(ng_pack(), [10 * USD, 10 * USD], 16 * USD).to(gh_pack());
        pay(&ada, &mut chain, &p)?;
        Ok(())
    }

    #[test]
    #[ignore]
    fn travel_rule_flag_uses_the_stricter_threshold() -> Result<()> {
        // NG threshold 1000 USD; a GH pack with 500 USD. Tier 3 sender.
        let gh500 = Pack { version: 2, threshold: 500 * USD, ..gh_pack() };
        let cases: [(u64, Pack, bool); 4] = [
            (600, ng_pack(), false),       // domestic: under 1000
            (600, gh500.clone(), true),    // cross-border: over min(1000, 500)
            (500, gh500.clone(), true),    // exactly at the threshold
            (499, gh500.clone(), false),   // one dollar under
        ];
        for (i, (usd, to, flag)) in cases.into_iter().enumerate() {
            let ada = Person::new(100 + i as u64, NG, 3); // fresh person: day total = this payment
            let mut chain = Chain::with_people(&[&ada]);
            let p = Payment::domestic(ng_pack(), [usd * USD, 0], usd * USD).to(to);
            let out = pay(&ada, &mut chain, &p)?;
            assert_eq!(open(&out, 0, d_ng()).3, flag, "{usd} USD");
        }
        Ok(())
    }

    #[test]
    #[ignore]
    fn daily_budget_holds_across_payments_in_the_full_circuit() -> Result<()> {
        // NG tier 1: 31.25 USD per day. 15 + 15 + 1.25 = 31.25; then nothing.
        let ada = Person::new(42, NG, 1);
        let mut chain = Chain::with_people(&[&ada]);
        let p = |amt| Payment::domestic(ng_pack(), [10 * USD, 10 * USD], amt);
        pay(&ada, &mut chain, &p(15 * USD))?;
        pay(&ada, &mut chain, &p(15 * USD))?;
        assert!(prove(&inputs(&ada, &chain, &p(cents(126)))).is_err(), "over by 0.01");
        pay(&ada, &mut chain, &p(cents(125)))?;
        assert!(prove(&inputs(&ada, &chain, &p(1))).is_err(), "day used up");
        Ok(())
    }

    #[test]
    #[ignore]
    fn change_must_return_to_the_sender() -> Result<()> {
        let ada = Person::new(42, NG, 1);
        let chain = Chain::with_people(&[&ada]);
        let ok = Payment::domestic(ng_pack(), [10 * USD, 10 * USD], 15 * USD);
        assert!(prove(&inputs(&ada, &chain, &ok)).is_ok());
        // Hiding 5 USD more to Bob as "change" would dodge the limits.
        let bad = Payment { change_pk: Some(ok.receiver_pk), ..ok };
        assert!(prove(&inputs(&ada, &chain, &bad)).is_err());
        Ok(())
    }

    #[test]
    #[ignore]
    fn cannot_spend_notes_of_another_key_under_my_identity() -> Result<()> {
        let ada = Person::new(42, NG, 1);
        let chain = Chain::with_people(&[&ada]);
        let ok = Payment::domestic(ng_pack(), [10 * USD, 10 * USD], 15 * USD);
        assert!(prove(&inputs(&ada, &chain, &ok)).is_ok());
        // Ada (KYC'd) moves notes of an unverified key K, sending the change back
        // to K so that the only thing wrong is note ownership.
        let k = s(0xBAD);
        let bad = Payment { note_owner: Some(k), change_pk: Some(derive_public_key(k)), ..ok };
        assert!(prove(&inputs(&ada, &chain, &bad)).is_err());
        Ok(())
    }

    #[test]
    #[ignore]
    fn pack_values_must_match_the_published_hash() -> Result<()> {
        let ada = Person::new(42, NG, 1);
        let chain = Chain::with_people(&[&ada]);
        let p = Payment::domestic(ng_pack(), [10 * USD, 10 * USD], 15 * USD);
        assert!(prove(&inputs(&ada, &chain, &p)).is_ok());

        // Private limits raised, public hash still NG's.
        let mut i = inputs(&ada, &chain, &p);
        i.set("sDaily", vec![BigInt::from(1000 * USD), BigInt::from(1250 * USD), BigInt::from(6250 * USD)]);
        assert!(prove(&i).is_err(), "raised daily limit");

        // Claiming Ghana with Nigeria's pack (and Ada's NG KYC).
        let bad = Payment { claim_jurisdiction: Some(GH), ..p.clone() };
        assert!(prove(&inputs(&ada, &chain, &bad)).is_err(), "wrong sender jurisdiction");

        // Sealing to a key that is not the published operator key.
        let mut i = inputs(&ada, &chain, &p);
        let k = admin_public_key(s(0xE7E));
        i.set("rOperatorKey", vec![big(k.0), big(k.1)]);
        assert!(prove(&i).is_err(), "record sealed to a different key");
        Ok(())
    }

    #[test]
    #[ignore]
    fn withdrawals_count_and_deposits_are_rejected() -> Result<()> {
        let ada = Person::new(42, NG, 1);
        let chain = Chain::with_people(&[&ada]);
        // 15 to Bob + 3 withdrawn = 18 <= 18.75: passes, and the record says 18.
        let ok = Payment { withdrawal: 3 * USD, ..Payment::domestic(ng_pack(), [10 * USD, 10 * USD], 15 * USD) };
        let out = prove(&inputs(&ada, &chain, &ok))?;
        assert_eq!(open(&out, 0, d_ng()).2, 18 * USD);
        // 15 + 4 = 19 > 18.75
        let bad = Payment { withdrawal: 4 * USD, ..ok.clone() };
        assert!(prove(&inputs(&ada, &chain, &bad)).is_err());
        // A balanced deposit (public amount in, notes add up) is still rejected.
        let dep = Payment { withdrawal: 0, deposit: 3 * USD, ..ok.clone() };
        assert!(prove(&inputs(&ada, &chain, &dep)).is_err());
        Ok(())
    }

    #[test]
    #[ignore]
    fn person_not_on_the_allow_list_cannot_pay() -> Result<()> {
        // Same person, same notes, same payment; only the allow-list differs.
        let eve = Person::new(66, NG, 1);
        let p = Payment::domestic(ng_pack(), [10 * USD, 10 * USD], 15 * USD);
        let listed = Chain::with_people(&[&eve]);
        assert!(prove(&inputs(&eve, &listed, &p)).is_ok(), "while listed");
        let unlisted = Chain::with_people(&[]);
        assert!(prove(&inputs(&eve, &unlisted, &p)).is_err(), "not listed");
        Ok(())
    }
}
