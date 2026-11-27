//! A deployed Clearance system in the Soroban test host, plus the wallet and
//! operator logic that drives it from chain state and events.
//!
//! Contracts, all real: Stellar asset token, rule registry (NG and GH packs,
//! NG->GH corridor), one `asp-membership` allow-list per country (admin = that
//! operator), the budget tree (`asp-membership`, admin = pool), the Groth16
//! verifier embedding clearance_tx_2_2's key, and the Clearance pool.
//!
//! Off-chain state (note tree, budget tree, allow-lists) is mirrored from the
//! events the contracts emit, and every mirror root is checked against the
//! contract's own root after each call.

use anyhow::{Context, Result, anyhow, ensure};
use ark_bn254::{Fq, Fr as Scalar};
use ark_ff::{BigInteger, PrimeField};
use asp_membership::{ASPMembership, ASPMembershipClient};
use circom_groth16_verifier::CircomGroth16Verifier;
use circuits::test::utils::{
    circom_tester::{CircuitKeys, Inputs, load_keys, prove_and_verify_with_keys},
    general::{load_artifacts, poseidon2_hash2, poseidon2_hash3, scalar_to_bigint},
    global_view_key::{Ciphertext, admin_public_key, decrypt_note},
    keypair::{derive_public_key, sign},
    merkle_tree::{PrefixTree, merkle_proof_padded, merkle_root_padded},
    transaction::{commitment, nullifier},
};
use clearance_pool::{ClearancePool, ClearancePoolClient, ClearanceProof};
use contract_types::Groth16Proof;
use num_bigint::BigInt;
use pool_core::{ExtData, hash_ext_data};
use rule_registry::{OperatorKey, PackInput, RuleRegistry, RuleRegistryClient, TierLimits};
use soroban_sdk::{
    Address, Bytes, BytesN, Env, I256, U256, Vec as SVec,
    crypto::bn254::{Bn254G1Affine, Bn254G2Affine},
    testutils::{Address as _, Events as _, Ledger as _},
    token::StellarAssetClient,
    xdr::{ContractEventBody, ScVal},
};
use std::{path::PathBuf, sync::OnceLock};

pub const POOL_LEVELS: u32 = 20;
pub const ID_LEVELS: u32 = 10;
pub const BUDGET_LEVELS: u32 = 20;
pub const USD: u64 = 10_000_000;
pub const NG: u32 = 566;
pub const GH: u32 = 288;
/// 2026-11-27 12:00 UTC.
pub const NOON_27_NOV: u64 = 1_795_780_800;

pub fn s(v: u64) -> Scalar {
    Scalar::from(v)
}
pub fn cents(c: u64) -> u64 {
    c * 100_000
}
fn big(x: Scalar) -> BigInt {
    scalar_to_bigint(x)
}

// ---------------- conversions ----------------

pub fn to_u256(env: &Env, x: Scalar) -> U256 {
    let mut b = [0u8; 32];
    let v = x.into_bigint().to_bytes_be();
    b[32 - v.len()..].copy_from_slice(&v);
    U256::from_be_bytes(env, &Bytes::from_array(env, &b))
}
pub fn from_u256(u: &U256) -> Scalar {
    let b = u.to_be_bytes();
    let mut a = [0u8; 32];
    b.copy_into_slice(&mut a);
    Scalar::from_be_bytes_mod_order(&a)
}
fn fq_be(f: &Fq) -> [u8; 32] {
    let mut b = [0u8; 32];
    let v = f.into_bigint().to_bytes_be();
    b[32 - v.len()..].copy_from_slice(&v);
    b
}
/// arkworks proof -> Soroban encoding: G1 `x || y`, G2 `x.c1 || x.c0 || y.c1 || y.c0`.
fn to_soroban_proof(env: &Env, p: &ark_groth16::Proof<ark_bn254::Bn254>) -> Groth16Proof {
    let g1 = |pt: &ark_bn254::G1Affine| {
        let mut b = [0u8; 64];
        b[..32].copy_from_slice(&fq_be(&pt.x));
        b[32..].copy_from_slice(&fq_be(&pt.y));
        Bn254G1Affine::from_array(env, &b)
    };
    let mut b = [0u8; 128];
    b[..32].copy_from_slice(&fq_be(&p.b.x.c1));
    b[32..64].copy_from_slice(&fq_be(&p.b.x.c0));
    b[64..96].copy_from_slice(&fq_be(&p.b.y.c1));
    b[96..].copy_from_slice(&fq_be(&p.b.y.c0));
    Groth16Proof { a: g1(&p.a), b: Bn254G2Affine::from_array(env, &b), c: g1(&p.c) }
}

// ---------------- reference hashes (spec in circuits/src) ----------------

pub fn id_commitment(id: Scalar) -> Scalar {
    poseidon2_hash2(id, s(0), Some(s(0x10)))
}
pub fn note_key(id: Scalar) -> Scalar {
    poseidon2_hash2(id, s(1), Some(s(0x10)))
}
pub fn tier_leaf(id: Scalar, j: u32, tier: u64) -> Scalar {
    let d = Some(s(0x11));
    poseidon2_hash2(poseidon2_hash3(id_commitment(id), s(j.into()), s(tier), d), s(0), d)
}
pub fn budget_key(id: Scalar, epoch: u64, k: u64) -> Scalar {
    poseidon2_hash3(id, s(epoch), s(k), Some(s(0x15)))
}
pub fn budget_nullifier(id: Scalar, epoch: u64, k: u64) -> Scalar {
    poseidon2_hash3(id, s(epoch), s(k), Some(s(0x12)))
}
pub fn budget_commitment(id: Scalar, epoch: u64, k: u64, spent: u64) -> Scalar {
    let d = Some(s(0x13));
    let inner = poseidon2_hash3(id_commitment(id), s(epoch), s(k), d);
    poseidon2_hash3(inner, s(spent), budget_key(id, epoch, k), d)
}

// ---------------- packs ----------------

#[derive(Clone)]
pub struct Pack {
    pub jurisdiction: u32,
    pub version: u32,
    pub offset: i32,
    pub threshold: u64,
    pub tiers: [(u64, u64); 3],
    pub key: (Scalar, Scalar),
}
impl Pack {
    pub fn hash(&self) -> Scalar {
        let d = Some(s(0x14));
        let mut h = poseidon2_hash2(s(self.jurisdiction.into()), s(self.version.into()), d);
        let off = u64::try_from(i64::from(self.offset) + (1 << 31)).expect("offset");
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
    pub fn input(&self, env: &Env) -> PackInput {
        let mut tiers = SVec::new(env);
        for (p, d) in self.tiers {
            tiers.push_back(TierLimits { per_payment: p.into(), daily: d.into() });
        }
        PackInput {
            utc_offset_secs: self.offset,
            travel_rule_threshold: self.threshold.into(),
            tiers,
            operator_key: OperatorKey { x: to_u256(env, self.key.0), y: to_u256(env, self.key.1) },
        }
    }
    fn set(&self, i: &mut Inputs, p: &str) {
        i.set(format!("{p}Version"), BigInt::from(self.version));
        i.set(format!("{p}UtcOffsetShifted"), BigInt::from(i64::from(self.offset) + (1 << 31)));
        i.set(format!("{p}Threshold"), BigInt::from(self.threshold));
        i.set(format!("{p}PerPayment"), self.tiers.iter().map(|t| BigInt::from(t.0)).collect::<Vec<_>>());
        i.set(format!("{p}Daily"), self.tiers.iter().map(|t| BigInt::from(t.1)).collect::<Vec<_>>());
        i.set(format!("{p}OperatorKey"), vec![big(self.key.0), big(self.key.1)]);
    }
}

/// Test-only operator private keys.
pub fn d_ng() -> Scalar {
    s(0x5eed_0566)
}
pub fn d_gh() -> Scalar {
    s(0x5eed_0288)
}
/// NG and GH v1, as published on testnet (illustrative limits), test operator keys.
pub fn ng_pack() -> Pack {
    Pack {
        jurisdiction: NG,
        version: 1,
        offset: 3600,
        threshold: 1000 * USD,
        tiers: [(cents(1875), cents(3125)), (625 * USD, 1250 * USD), (3125 * USD, 6250 * USD)],
        key: admin_public_key(d_ng()),
    }
}
pub fn gh_pack() -> Pack {
    Pack {
        jurisdiction: GH,
        version: 1,
        offset: 0,
        threshold: 1000 * USD,
        tiers: [(15 * USD, 25 * USD), (500 * USD, 1000 * USD), (2500 * USD, 5000 * USD)],
        key: admin_public_key(d_gh()),
    }
}

// ---------------- people and notes ----------------

#[derive(Clone)]
pub struct Person {
    pub id: Scalar,
    pub jurisdiction: u32,
    pub tier: u64,
    pub account: Address,
}
impl Person {
    pub fn receive_key(&self) -> Scalar {
        derive_public_key(note_key(self.id))
    }
}

/// A note the wallet owns: amount, blinding and its index in the pool tree.
#[derive(Clone, Copy, Debug)]
pub struct OwnedNote {
    pub amount: u64,
    pub blinding: Scalar,
    pub index: usize,
}

// ---------------- the world ----------------

pub struct World {
    pub env: Env,
    pub token: Address,
    pub registry: RuleRegistryClient<'static>,
    pub pool: ClearancePoolClient<'static>,
    pub budget_tree: ASPMembershipClient<'static>,
    pub allow_lists: [(u32, ASPMembershipClient<'static>); 2],
    // mirrors, rebuilt from events
    pub notes: Vec<Scalar>,
    pub budget_leaves: Vec<Scalar>,
    pub budget_steps: Vec<(Scalar, Scalar, Scalar)>,
    pub id_leaves: [(u32, Vec<Scalar>); 2],
    salt: u64,
}

impl World {
    pub fn new() -> Self {
        let env = Env::default();
        env.mock_all_auths();
        env.cost_estimate().budget().reset_unlimited();
        env.ledger().set_timestamp(NOON_27_NOV);
        let admin = Address::generate(&env);
        let ng_op = Address::generate(&env);
        let gh_op = Address::generate(&env);

        let token = env.register_stellar_asset_contract_v2(admin.clone()).address();
        let registry = RuleRegistryClient::new(&env, &env.register(RuleRegistry, (admin.clone(),)));
        registry.register_jurisdiction(&NG, &ng_op);
        registry.register_jurisdiction(&GH, &gh_op);
        let h = registry.set_pack(&NG, &ng_pack().input(&env));
        assert_eq!(from_u256(&h), ng_pack().hash(), "registry vs reference pack hash (NG)");
        let h = registry.set_pack(&GH, &gh_pack().input(&env));
        assert_eq!(from_u256(&h), gh_pack().hash(), "registry vs reference pack hash (GH)");
        registry.open_corridor(&NG, &GH);
        registry.accept_corridor(&NG, &GH);

        let tree = |owner: &Address, levels: u32| {
            ASPMembershipClient::new(&env, &env.register(ASPMembership, (owner.clone(), levels)))
        };
        let ng_list = tree(&ng_op, ID_LEVELS);
        let gh_list = tree(&gh_op, ID_LEVELS);
        registry.set_allow_list(&NG, &ng_list.address);
        registry.set_allow_list(&GH, &gh_list.address);

        let verifier = env.register(CircomGroth16Verifier, ());
        let pool = ClearancePoolClient::new(
            &env,
            &env.register(
                ClearancePool,
                (
                    admin.clone(),
                    token.clone(),
                    verifier,
                    registry.address.clone(),
                    0i128,
                    0i128,
                    U256::from_u128(&env, 1_000_000 * u128::from(USD)),
                    POOL_LEVELS,
                ),
            ),
        );
        let budget_tree = tree(&pool.address, BUDGET_LEVELS);
        pool.set_budget_tree(&budget_tree.address);

        Self {
            registry,
            pool,
            budget_tree,
            allow_lists: [(NG, ng_list), (GH, gh_list)],
            env,
            token,
            notes: Vec::new(),
            budget_leaves: Vec::new(),
            budget_steps: Vec::new(),
            id_leaves: [(NG, Vec::new()), (GH, Vec::new())],
            salt: 1,
        }
    }

    fn fresh(&mut self) -> Scalar {
        self.salt += 1;
        s(0xB11D_0000 + self.salt)
    }

    /// The operator of `p.jurisdiction` KYCs `p` at `p.tier`.
    pub fn onboard(&mut self, id: u64, jurisdiction: u32, tier: u64, usd: u64) -> Person {
        let p = Person { id: s(id), jurisdiction, tier, account: Address::generate(&self.env) };
        let leaf = tier_leaf(p.id, jurisdiction, tier);
        let k = usize::from(jurisdiction == GH);
        self.allow_lists[k].1.insert_leaf(&to_u256(&self.env, leaf));
        self.id_leaves[k].1.push(leaf);
        assert_eq!(
            from_u256(&self.allow_lists[k].1.get_root()),
            merkle_root_padded(&self.id_leaves[k].1, ID_LEVELS as usize),
            "allow-list root parity"
        );
        StellarAssetClient::new(&self.env, &self.token).mint(&p.account, &i128::from(usd * USD));
        p
    }

    /// Someone with a funded Stellar account whom no operator has listed.
    pub fn unlisted(&mut self, id: u64, jurisdiction: u32, tier: u64, usd: u64) -> Person {
        let p = Person { id: s(id), jurisdiction, tier, account: Address::generate(&self.env) };
        StellarAssetClient::new(&self.env, &self.token).mint(&p.account, &i128::from(usd * USD));
        p
    }

    pub fn epoch(&self, j: u32) -> u64 {
        self.registry.epoch(&j)
    }

    /// Today's budget state for `p`, recovered from BudgetStep events only.
    pub fn budget_state(&self, p: &Person) -> (u64, u64, Option<usize>) {
        let e = self.epoch(p.jurisdiction);
        let (mut seq, mut spent, mut idx) = (0, 0, None);
        while self.budget_steps.iter().any(|b| b.0 == budget_nullifier(p.id, e, seq)) {
            let k = budget_key(p.id, e, seq + 1);
            let (i, st) = self
                .budget_steps
                .iter()
                .enumerate()
                .find_map(|(i, b)| {
                    let v = u64::try_from(big(b.2 - k)).ok()?;
                    (b.1 == budget_commitment(p.id, e, seq + 1, v)).then_some((i, v))
                })
                .expect("budget state on chain");
            spent = st;
            idx = Some(self.budget_leaves.iter().position(|l| *l == self.budget_steps[i].1).expect("leaf"));
            seq += 1;
        }
        (seq, spent, idx)
    }

    /// Build inputs for a payment. `spend`: up to two owned notes (missing
    /// ones are zero-amount dummies). `to`: receiver key and amount.
    #[allow(clippy::too_many_arguments)]
    pub fn payment(
        &mut self,
        who: &Person,
        spend: &[OwnedNote],
        to: (Scalar, u64),
        deposit: u64,
        withdrawal: u64,
        receiver_pack: &Pack,
        recipient: &Address,
    ) -> Payment {
        let env = self.env.clone();
        let sender_pack = if who.jurisdiction == NG { ng_pack() } else { gh_pack() };
        let nk = note_key(who.id);
        let me = derive_public_key(nk);

        let ext_amount = i128::from(deposit) - i128::from(withdrawal);
        let ext = ExtData {
            recipient: recipient.clone(),
            ext_amount: I256::from_i128(&env, ext_amount),
            encrypted_output0: Bytes::new(&env),
            encrypted_output1: Bytes::new(&env),
        };
        let ext_hash = env.as_contract(&self.pool.address, || hash_ext_data(&env, &ext, &self.token));
        let ext_scalar = from_u256(&U256::from_be_bytes(&env, &Bytes::from(ext_hash.clone())));

        // inputs (real notes from the tree, or zero-amount dummies)
        let tree = PrefixTree::new(&self.notes, POOL_LEVELS as usize);
        let mut ins: Vec<(u64, Scalar, Scalar, Vec<Scalar>)> = Vec::new(); // amount, blinding, pathIdx, path
        for k in 0..2 {
            match spend.get(k) {
                Some(n) => {
                    let (path, bits) = tree.proof(n.index);
                    ins.push((n.amount, n.blinding, s(bits), path));
                }
                None => ins.push((0, self.fresh(), s(0), vec![s(0); POOL_LEVELS as usize])),
            }
        }
        let total_in: u64 = ins.iter().map(|x| x.0).sum();
        let change = total_in + deposit - to.1 - withdrawal;
        let (b0, b1) = (self.fresh(), self.fresh());

        let mut i = Inputs::new();
        i.set("root", big(tree.root()));
        i.set("publicAmount", big(s(deposit) - s(withdrawal)));
        i.set("extDataHash", big(ext_scalar));
        i.set("nonce", big(ext_scalar));
        let nuls: Vec<Scalar> = ins
            .iter()
            .map(|(a, b, bits, _)| {
                let cm = commitment(s(*a), me, *b);
                nullifier(cm, *bits, sign(nk, cm, *bits))
            })
            .collect();
        i.set("inputNullifier", nuls.iter().map(|x| big(*x)).collect::<Vec<_>>());
        i.set("inAmount", ins.iter().map(|x| BigInt::from(x.0)).collect::<Vec<_>>());
        i.set("inPrivateKey", vec![big(nk), big(nk)]);
        i.set("inBlinding", ins.iter().map(|x| big(x.1)).collect::<Vec<_>>());
        i.set("inPathIndices", ins.iter().map(|x| big(x.2)).collect::<Vec<_>>());
        i.set("inPathElements", ins.iter().flat_map(|x| x.3.iter().map(|e| big(*e))).collect::<Vec<_>>());
        let outs = [(to.0, to.1, b0), (me, change, b1)];
        i.set("outputCommitment", outs.iter().map(|o| big(commitment(s(o.1), o.0, o.2))).collect::<Vec<_>>());
        i.set("outAmount", outs.iter().map(|o| BigInt::from(o.1)).collect::<Vec<_>>());
        i.set("outPubkey", outs.iter().map(|o| big(o.0)).collect::<Vec<_>>());
        i.set("outBlinding", outs.iter().map(|o| big(o.2)).collect::<Vec<_>>());
        i.set("deposit", BigInt::from(deposit));
        i.set("withdrawal", BigInt::from(withdrawal));

        let k = usize::from(who.jurisdiction == GH);
        let leaves = &self.id_leaves[k].1;
        let idx = leaves.iter().position(|l| *l == tier_leaf(who.id, who.jurisdiction, who.tier)).unwrap_or(0);
        let (id_path, id_bits) = merkle_proof_padded(leaves, idx, ID_LEVELS as usize);
        i.set("identityRoot", big(merkle_root_padded(leaves, ID_LEVELS as usize)));
        i.set("idSecret", big(who.id));
        i.set("tier", BigInt::from(who.tier));
        i.set("issuance", BigInt::from(0u64));
        i.set("idPathElements", id_path.iter().map(|e| big(*e)).collect::<Vec<_>>());
        i.set("idPathIndices", BigInt::from(id_bits));

        let (seq, spent, bidx) = self.budget_state(who);
        let (bpath, bbits) = match bidx {
            Some(x) => merkle_proof_padded(&self.budget_leaves, x, BUDGET_LEVELS as usize),
            None => (vec![s(0); BUDGET_LEVELS as usize], 0),
        };
        i.set("budgetRoot", big(merkle_root_padded(&self.budget_leaves, BUDGET_LEVELS as usize)));
        i.set("epoch", BigInt::from(self.epoch(who.jurisdiction)));
        i.set("budgetSeq", BigInt::from(seq));
        i.set("budgetSpent", BigInt::from(spent));
        i.set("budgetPathElements", bpath.iter().map(|e| big(*e)).collect::<Vec<_>>());
        i.set("budgetPathIndices", BigInt::from(bbits));

        i.set("senderJurisdiction", BigInt::from(who.jurisdiction));
        i.set("receiverJurisdiction", BigInt::from(receiver_pack.jurisdiction));
        i.set("senderPackHash", big(sender_pack.hash()));
        i.set("receiverPackHash", big(receiver_pack.hash()));
        sender_pack.set(&mut i, "s");
        receiver_pack.set(&mut i, "r");
        let (r0, r1) = (self.fresh(), self.fresh());
        i.set("recordSalt", vec![big(r0), big(r1)]);

        Payment {
            inputs: i,
            ext,
            ext_hash,
            change: OwnedNote { amount: change, blinding: b1, index: 0 },
            sent_note: (to.0, to.1, b0),
        }
    }

    /// Prove with the proving key whose verification key the verifier embeds.
    pub fn prove(&self, p: &Payment) -> Result<ClearanceProof> {
        static KEYS: OnceLock<(PathBuf, PathBuf, CircuitKeys)> = OnceLock::new();
        let (wasm, r1cs, keys) = KEYS.get_or_init(|| {
            let (wasm, r1cs) = load_artifacts("clearance_tx_2_2").expect("make circuits");
            let pk = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../testdata/clearance_tx_2_2_proving_key.bin");
            (wasm, r1cs, load_keys(pk).expect("proving key"))
        });
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            prove_and_verify_with_keys(wasm, r1cs, &p.inputs, keys)
        }))
        .map_err(|_| anyhow!("prover panicked"))??;
        ensure!(r.verified, "proof did not verify locally");
        let env = &self.env;
        let x = |k: usize| to_u256(env, r.public_inputs[k]);
        let v = |range: std::ops::Range<usize>| {
            let mut out = SVec::new(env);
            for k in range {
                out.push_back(x(k));
            }
            out
        };
        let small = |k: usize| u64::try_from(big(r.public_inputs[k])).context("small public input");
        Ok(ClearanceProof {
            proof: to_soroban_proof(env, &r.proof),
            budget_nullifier: x(0),
            new_budget_commitment: x(1),
            enc_new_spent: x(2),
            record_r: v(3..7),
            record_c: v(7..13),
            root: x(13),
            public_amount: x(14),
            ext_data_hash: p.ext_hash.clone(),
            input_nullifiers: v(16..18),
            output_commitment0: x(18),
            output_commitment1: x(19),
            identity_root: x(21),
            budget_root: x(22),
            epoch: small(23)?,
            sender_jurisdiction: u32::try_from(small(24)?)?,
            receiver_jurisdiction: u32::try_from(small(25)?)?,
            sender_pack_hash: x(26),
            receiver_pack_hash: x(27),
        })
    }

    /// Submit; on success fold the pool's events into the mirrors and check
    /// every mirror root against its contract.
    pub fn submit(
        &mut self,
        who: &Person,
        proof: &ClearanceProof,
        ext: &ExtData,
    ) -> Result<Submitted, clearance_pool::Error> {
        match self.pool.try_transact(proof, ext, &who.account) {
            Ok(Ok(())) => {}
            Err(Ok(e)) => return Err(e),
            other => panic!("unexpected transact outcome: {other:?}"),
        }
        let res = self.env.cost_estimate().resources();
        let events = self.fold_events();
        assert_eq!(
            from_u256(&self.pool.get_root()),
            PrefixTree::new(&self.notes, POOL_LEVELS as usize).root(),
            "note tree root parity"
        );
        assert_eq!(
            from_u256(&self.budget_tree.get_root()),
            merkle_root_padded(&self.budget_leaves, BUDGET_LEVELS as usize),
            "budget tree root parity"
        );
        Ok(Submitted { record: events, instructions: res.instructions, mem_bytes: res.mem_bytes })
    }

    /// Read the pool's events of the last call (XDR, as an RPC serves them).
    fn fold_events(&mut self) -> SealedRecordEvent {
        let all = self.env.events().all().filter_by_contract(&self.pool.address);
        let mut record = None;
        let mut first_index = None;
        for ev in all.events() {
            let ContractEventBody::V0(body) = &ev.body;
            let name = match &body.topics[0] {
                ScVal::Symbol(sym) => sym.to_string(),
                _ => continue,
            };
            let field = |k: &str| -> &ScVal {
                let ScVal::Map(Some(m)) = &body.data else { panic!("event data not a map") };
                &m.iter().find(|e| matches!(&e.key, ScVal::Symbol(s) if s.to_string() == k)).expect(k).val
            };
            match name.as_str() {
                "new_commitment_event" => {
                    let cm = sc_scalar(&body.topics[1]);
                    let ScVal::U32(index) = field("index") else { panic!("index") };
                    first_index.get_or_insert(*index as usize);
                    assert_eq!(*index as usize, self.notes.len(), "note index order");
                    self.notes.push(cm);
                }
                "budget_step" => {
                    let n = sc_scalar(&body.topics[1]);
                    let c = sc_scalar(field("commitment"));
                    let e = sc_scalar(field("enc_new_spent"));
                    self.budget_steps.push((n, c, e));
                    self.budget_leaves.push(c);
                }
                "sealed_record" => {
                    let vecs = |k: &str| -> Vec<Scalar> {
                        let ScVal::Vec(Some(v)) = field(k) else { panic!("{k}") };
                        v.iter().map(sc_scalar).collect()
                    };
                    let ScVal::U32(sj) = &body.topics[1] else { panic!("sj") };
                    let ScVal::U32(rj) = &body.topics[2] else { panic!("rj") };
                    record = Some(SealedRecordEvent {
                        sender_jurisdiction: *sj,
                        receiver_jurisdiction: *rj,
                        r: vecs("record_r"),
                        c: vecs("record_c"),
                        first_note_index: 0,
                    });
                }
                _ => {}
            }
        }
        let mut r = record.expect("sealed_record event");
        r.first_note_index = first_index.expect("note events");
        r
    }
}

fn sc_scalar(v: &ScVal) -> Scalar {
    let ScVal::U256(p) = v else { panic!("expected U256, got {v:?}") };
    let mut b = [0u8; 32];
    b[..8].copy_from_slice(&p.hi_hi.to_be_bytes());
    b[8..16].copy_from_slice(&p.hi_lo.to_be_bytes());
    b[16..24].copy_from_slice(&p.lo_hi.to_be_bytes());
    b[24..].copy_from_slice(&p.lo_lo.to_be_bytes());
    Scalar::from_be_bytes_mod_order(&b)
}

pub struct Payment {
    pub inputs: Inputs,
    pub ext: ExtData,
    pub ext_hash: BytesN<32>,
    /// The sender's change note (index filled after submission).
    pub change: OwnedNote,
    pub sent_note: (Scalar, u64, Scalar),
}

pub struct SealedRecordEvent {
    pub sender_jurisdiction: u32,
    pub receiver_jurisdiction: u32,
    pub r: Vec<Scalar>,
    pub c: Vec<Scalar>,
    pub first_note_index: usize,
}

pub struct Submitted {
    pub record: SealedRecordEvent,
    pub instructions: i64,
    pub mem_bytes: i64,
}
impl Submitted {
    /// The sender's change note now on chain (output 1 = first index + 1).
    pub fn change(&self, p: &Payment) -> OwnedNote {
        OwnedNote { index: self.record.first_note_index + 1, ..p.change }
    }
    /// The receiver's note (output 0).
    pub fn received(&self, p: &Payment) -> OwnedNote {
        OwnedNote { amount: p.sent_note.1, blinding: p.sent_note.2, index: self.record.first_note_index }
    }
}

/// Operator side: open record `k` (0 = sender's operator, 1 = receiver's).
/// Returns (idCommitment, receiverPubKey, sent, travelRuleFlag).
pub fn open_record(ev: &SealedRecordEvent, k: usize, d_priv: Scalar) -> (Scalar, Scalar, u64, bool) {
    let ct = Ciphertext {
        r: (ev.r[2 * k], ev.r[2 * k + 1]),
        c1: ev.c[3 * k],
        c2: ev.c[3 * k + 1],
        c3: ev.c[3 * k + 2],
    };
    let m = decrypt_note(&ct, d_priv);
    let v = u64::try_from(big(m.blinding)).unwrap_or(u64::MAX);
    (m.pk, m.amount, v / 2, v % 2 == 1)
}
