//! Clearance pool.
//!
//! A shielded pool whose every call carries one `clearance_tx_2_2` proof (see
//! circuits/src/clearanceTransaction.circom). The circuit proves the payment
//! is valid and within the sender's KYC tier limits under the published rule
//! packs, and seals a compliance record to each operator. This contract
//! checks what the circuit cannot know:
//!
//! - both pack hashes are the active packs in the rule registry,
//! - the corridor is open (cross-border only),
//! - the epoch is the sender country's current local day,
//! - the identity root is known to the sender country's allow-list,
//! - the budget root is known and the budget nullifier unused,
//! - the note root, nullifiers, amounts and external data, as upstream's pool.
//!
//! Notes use upstream's `MerkleTreeWithHistory`. The budget tree is an upstream
//! `asp-membership` contract whose admin is this pool.
//!
//! All checks run before any state change. Token transfers and events come last.
#![no_std]
#![allow(clippy::too_many_arguments)] // constructor, as upstream pool

use contract_types::Groth16Proof;
use pool_core::{
    CircomGroth16VerifierClient, ExtData, amounts, hash_ext_data,
    merkle_with_history::{Error as MerkleError, MerkleTreeWithHistory},
    totals::{self, Error as TotalsError},
};
use soroban_sdk::{
    Address, Bytes, BytesN, Env, I256, U256, Vec, contract, contractclient, contracterror,
    contractevent, contractimpl, contracttype, crypto::bn254::Bn254Fr, token::TokenClient,
};
use soroban_utils::constants::bn256_modulus;

// ---------- other contracts ----------

#[contractclient(name = "RegistryClient")]
pub trait RegistryInterface {
    fn is_active(env: Env, jurisdiction: u32, hash: U256) -> bool;
    fn corridor_open(env: Env, from: u32, to: u32) -> bool;
    fn epoch(env: Env, jurisdiction: u32) -> Result<u64, soroban_sdk::Error>;
    fn allow_list(env: Env, jurisdiction: u32) -> Result<Address, soroban_sdk::Error>;
}

#[contractclient(name = "TreeClient")]
pub trait TreeInterface {
    fn is_known_root(env: Env, root: U256) -> Result<bool, soroban_sdk::Error>;
    fn insert_leaf(env: Env, leaf: U256) -> Result<(), soroban_sdk::Error>;
    fn get_admin(env: Env) -> Result<Address, soroban_sdk::Error>;
}

// ---------- types ----------

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    NotAuthorized = 1,
    MerkleTreeFull = 2,
    AlreadyInitialized = 3,
    WrongLevels = 4,
    NextIndexNotEven = 5,
    WrongExtAmount = 6,
    InvalidProof = 7,
    UnknownRoot = 8,
    AlreadySpentNullifier = 9,
    WrongExtHash = 10,
    NotInitialized = 11,
    Overflow = 12,
    NonCanonicalPublicInput = 13,
    NotesTotalExceeded = 22,
    InvalidClaimAmount = 23,
    InvalidPayee = 24,
    // Clearance
    PackNotActive = 40,
    CorridorClosed = 41,
    WrongEpoch = 42,
    NoAllowList = 43,
    UnknownIdentityRoot = 44,
    UnknownBudgetRoot = 45,
    BudgetNullifierSpent = 46,
    BudgetTreeNotSet = 47,
    BudgetTreeNotOwned = 48,
    BadProofShape = 49,
}

impl From<MerkleError> for Error {
    fn from(e: MerkleError) -> Self {
        match e {
            MerkleError::AlreadyInitialized => Error::AlreadyInitialized,
            MerkleError::MerkleTreeFull => Error::MerkleTreeFull,
            MerkleError::WrongLevels => Error::WrongLevels,
            MerkleError::NextIndexNotEven => Error::NextIndexNotEven,
            MerkleError::NotInitialized => Error::NotInitialized,
            MerkleError::Overflow => Error::Overflow,
        }
    }
}

impl From<TotalsError> for Error {
    fn from(e: TotalsError) -> Self {
        match e {
            TotalsError::NotInitialized => Error::NotInitialized,
            TotalsError::NotesTotalExceeded => Error::NotesTotalExceeded,
            TotalsError::Overflow => Error::Overflow,
            TotalsError::InvalidClaimAmount => Error::InvalidClaimAmount,
            TotalsError::InvalidPayee => Error::InvalidPayee,
        }
    }
}

/// A `clearance_tx_2_2` proof and its public signals.
#[contracttype]
#[derive(Clone)]
pub struct ClearanceProof {
    pub proof: Groth16Proof,
    // upstream transaction signals
    pub root: U256,
    pub input_nullifiers: Vec<U256>,
    pub output_commitment0: U256,
    pub output_commitment1: U256,
    pub public_amount: U256,
    pub ext_data_hash: BytesN<32>,
    // Clearance signals
    pub identity_root: U256,
    pub budget_root: U256,
    pub epoch: u64,
    pub sender_jurisdiction: u32,
    pub receiver_jurisdiction: u32,
    pub sender_pack_hash: U256,
    pub receiver_pack_hash: U256,
    pub budget_nullifier: U256,
    pub new_budget_commitment: U256,
    pub enc_new_spent: U256,
    /// Ephemeral keys of the two sealed records: [R0.x, R0.y, R1.x, R1.y].
    pub record_r: Vec<U256>,
    /// Ciphertexts: [c0.1, c0.2, c0.3, c1.1, c1.2, c1.3]. Record 0 is sealed
    /// to the sender's operator, record 1 to the receiver's.
    pub record_c: Vec<U256>,
}

#[contracttype]
#[derive(Clone)]
enum DataKey {
    Admin,
    Token,
    Verifier,
    Registry,
    BudgetTree,
    Fee,
    MinimumDepositAmount,
    MaximumDepositAmount,
    Nullifier(U256),
    BudgetNullifier(U256),
}

// ---------- events ----------

/// Same shape as upstream's, so upstream wallets can scan notes.
#[contractevent]
#[derive(Clone)]
pub struct NewCommitmentEvent {
    #[topic]
    pub commitment: U256,
    pub index: u32,
    pub encrypted_output: Bytes,
}

#[contractevent]
#[derive(Clone)]
pub struct NewNullifierEvent {
    #[topic]
    pub nullifier: U256,
}

/// One step of a person's daily budget chain. Their wallets find their own
/// steps by recomputing the nullifiers, and decrypt the day total with
/// `enc_new_spent`. The new commitment's tree index is in the budget tree's
/// `LeafAdded` event.
#[contractevent(topics = ["budget_step"])]
#[derive(Clone)]
pub struct BudgetStep {
    #[topic]
    pub nullifier: U256,
    pub commitment: U256,
    pub enc_new_spent: U256,
    pub epoch: u64,
}

/// The two sealed compliance records of a payment. Each operator watches the
/// topic for its jurisdiction and opens its own copy with its private key.
#[contractevent(topics = ["sealed_record"])]
#[derive(Clone)]
pub struct SealedRecord {
    #[topic]
    pub sender_jurisdiction: u32,
    #[topic]
    pub receiver_jurisdiction: u32,
    pub epoch: u64,
    pub sender_pack_hash: U256,
    pub receiver_pack_hash: U256,
    pub record_r: Vec<U256>,
    pub record_c: Vec<U256>,
}

// ---------- contract ----------

#[contract]
pub struct ClearancePool;

#[contractimpl]
impl ClearancePool {
    /// `fee` should be 0: the circuit counts any public outflow, including a
    /// fee taken from notes, towards the sender's limits.
    pub fn __constructor(
        env: Env,
        admin: Address,
        token: Address,
        verifier: Address,
        registry: Address,
        fee: i128,
        minimum_deposit_amount: i128,
        maximum_deposit_amount: U256,
        levels: u32,
    ) -> Result<(), Error> {
        if fee < 0 || minimum_deposit_amount < 0 {
            return Err(Error::WrongExtAmount);
        }
        let i = env.storage().instance();
        i.set(&DataKey::Admin, &admin);
        i.set(&DataKey::Token, &token);
        i.set(&DataKey::Verifier, &verifier);
        i.set(&DataKey::Registry, &registry);
        i.set(&DataKey::Fee, &fee);
        i.set(&DataKey::MinimumDepositAmount, &minimum_deposit_amount);
        i.set(&DataKey::MaximumDepositAmount, &maximum_deposit_amount);
        totals::init(&env);
        MerkleTreeWithHistory::init(&env, levels)?;
        Ok(())
    }

    /// Admin sets the budget tree once. It must be an `asp-membership` tree
    /// whose admin is this pool, so only this pool can append budget states.
    pub fn set_budget_tree(env: Env, tree: Address) -> Result<(), Error> {
        Self::admin(&env)?.require_auth();
        let i = env.storage().instance();
        if i.has(&DataKey::BudgetTree) {
            return Err(Error::AlreadyInitialized);
        }
        let owner = TreeClient::new(&env, &tree)
            .try_get_admin()
            .map_err(|_| Error::BudgetTreeNotOwned)?
            .map_err(|_| Error::BudgetTreeNotOwned)?;
        if owner != env.current_contract_address() {
            return Err(Error::BudgetTreeNotOwned);
        }
        i.set(&DataKey::BudgetTree, &tree);
        Ok(())
    }

    pub fn transact(
        env: Env,
        proof: ClearanceProof,
        ext_data: ExtData,
        sender: Address,
    ) -> Result<(), Error> {
        sender.require_auth();
        soroban_utils::extend_instance(&env);
        let zero = I256::from_i32(&env, 0);
        let token = Self::get(&env, &DataKey::Token)?;
        let fee: i128 = Self::get(&env, &DataKey::Fee)?;

        if proof.input_nullifiers.len() != 2 || proof.record_r.len() != 4 || proof.record_c.len() != 6 {
            return Err(Error::BadProofShape);
        }

        // 1. Deposit cap and minimum
        let deposit_amount = if ext_data.ext_amount > zero {
            let max: U256 = Self::get(&env, &DataKey::MaximumDepositAmount)?;
            if U256::from_be_bytes(&env, &ext_data.ext_amount.to_be_bytes()) > max {
                return Err(Error::WrongExtAmount);
            }
            let amount = amounts::i256_to_i128_nonneg(&env, &ext_data.ext_amount)
                .ok_or(Error::WrongExtAmount)?;
            let min: i128 = Self::get(&env, &DataKey::MinimumDepositAmount)?;
            if amount.checked_sub(fee).ok_or(Error::WrongExtAmount)? < min {
                return Err(Error::WrongExtAmount);
            }
            Some(amount)
        } else {
            None
        };

        // 2. Note root and nullifiers
        if !MerkleTreeWithHistory::is_known_root(&env, &proof.root)? {
            return Err(Error::UnknownRoot);
        }
        for n in proof.input_nullifiers.iter() {
            if Self::is_spent(env.clone(), n) {
                return Err(Error::AlreadySpentNullifier);
            }
        }

        // 3. External data, bound to this pool and token
        if hash_ext_data(&env, &ext_data, &token) != proof.ext_data_hash {
            return Err(Error::WrongExtHash);
        }

        // 4. Public amount (net of fee) and withdrawal payee
        let net = ext_data
            .ext_amount
            .to_i128()
            .and_then(|a| a.checked_sub(fee))
            .ok_or(Error::WrongExtAmount)?;
        let expected = amounts::calculate_public_amount(&env, I256::from_i128(&env, net))
            .ok_or(Error::WrongExtAmount)?;
        if proof.public_amount != expected {
            return Err(Error::WrongExtAmount);
        }
        let withdrawal_amount = if ext_data.ext_amount < zero {
            totals::check_payee(&env, &ext_data.recipient, &token)?;
            let abs = zero.sub(&ext_data.ext_amount);
            Some(amounts::i256_to_i128_nonneg(&env, &abs).ok_or(Error::WrongExtAmount)?)
        } else {
            None
        };

        // 5. Rule registry: packs, corridor, local day
        let registry = RegistryClient::new(&env, &Self::get::<Address>(&env, &DataKey::Registry)?);
        let (sj, rj) = (proof.sender_jurisdiction, proof.receiver_jurisdiction);
        if !registry.is_active(&sj, &proof.sender_pack_hash)
            || !registry.is_active(&rj, &proof.receiver_pack_hash)
        {
            return Err(Error::PackNotActive);
        }
        if sj != rj && !registry.corridor_open(&sj, &rj) {
            return Err(Error::CorridorClosed);
        }
        match registry.try_epoch(&sj) {
            Ok(Ok(e)) if e == proof.epoch => {}
            _ => return Err(Error::WrongEpoch),
        }

        // 6. Identity: the sender country's allow-list knows the root
        let allow_list = match registry.try_allow_list(&sj) {
            Ok(Ok(a)) => a,
            _ => return Err(Error::NoAllowList),
        };
        if !matches!(
            TreeClient::new(&env, &allow_list).try_is_known_root(&proof.identity_root),
            Ok(Ok(true))
        ) {
            return Err(Error::UnknownIdentityRoot);
        }

        // 7. Budget: known root, unused nullifier
        let budget_tree = TreeClient::new(&env, &Self::get::<Address>(&env, &DataKey::BudgetTree)
            .map_err(|_| Error::BudgetTreeNotSet)?);
        if !matches!(budget_tree.try_is_known_root(&proof.budget_root), Ok(Ok(true))) {
            return Err(Error::UnknownBudgetRoot);
        }
        if Self::is_budget_spent(env.clone(), proof.budget_nullifier.clone()) {
            return Err(Error::BudgetNullifierSpent);
        }

        // 8. Proof
        Self::verify(&env, &proof)?;

        // ---- state changes ----
        totals::record(&env, net, fee)?;
        for n in proof.input_nullifiers.iter() {
            env.storage().persistent().set(&DataKey::Nullifier(n), &());
        }
        env.storage()
            .persistent()
            .set(&DataKey::BudgetNullifier(proof.budget_nullifier.clone()), &());
        let (idx0, idx1) = MerkleTreeWithHistory::insert_two_leaves(
            &env,
            proof.output_commitment0.clone(),
            proof.output_commitment1.clone(),
        )?;
        if !matches!(budget_tree.try_insert_leaf(&proof.new_budget_commitment), Ok(Ok(()))) {
            return Err(Error::BudgetTreeNotOwned);
        }

        // ---- tokens ----
        let token_client = TokenClient::new(&env, &token);
        let this = env.current_contract_address();
        if let Some(amount) = deposit_amount {
            token_client.transfer(&sender, &this, &amount);
        } else if let Some(amount) = withdrawal_amount {
            token_client.transfer(&this, &ext_data.recipient, &amount);
        }

        // ---- events ----
        for n in proof.input_nullifiers.iter() {
            NewNullifierEvent { nullifier: n }.publish(&env);
        }
        NewCommitmentEvent {
            commitment: proof.output_commitment0.clone(),
            index: idx0,
            encrypted_output: ext_data.encrypted_output0.clone(),
        }
        .publish(&env);
        NewCommitmentEvent {
            commitment: proof.output_commitment1.clone(),
            index: idx1,
            encrypted_output: ext_data.encrypted_output1.clone(),
        }
        .publish(&env);
        BudgetStep {
            nullifier: proof.budget_nullifier.clone(),
            commitment: proof.new_budget_commitment.clone(),
            enc_new_spent: proof.enc_new_spent.clone(),
            epoch: proof.epoch,
        }
        .publish(&env);
        SealedRecord {
            sender_jurisdiction: sj,
            receiver_jurisdiction: rj,
            epoch: proof.epoch,
            sender_pack_hash: proof.sender_pack_hash.clone(),
            receiver_pack_hash: proof.receiver_pack_hash.clone(),
            record_r: proof.record_r.clone(),
            record_c: proof.record_c.clone(),
        }
        .publish(&env);
        Ok(())
    }

    // ---------- reads ----------

    pub fn get_root(env: Env) -> Result<U256, Error> {
        Ok(MerkleTreeWithHistory::get_last_root(&env)?)
    }
    pub fn is_known_root(env: Env, root: U256) -> Result<bool, Error> {
        Ok(MerkleTreeWithHistory::is_known_root(&env, &root)?)
    }
    pub fn is_spent(env: Env, nullifier: U256) -> bool {
        env.storage().persistent().has(&DataKey::Nullifier(nullifier))
    }
    pub fn is_budget_spent(env: Env, nullifier: U256) -> bool {
        env.storage().persistent().has(&DataKey::BudgetNullifier(nullifier))
    }
    pub fn budget_tree(env: Env) -> Result<Address, Error> {
        Self::get(&env, &DataKey::BudgetTree).map_err(|_| Error::BudgetTreeNotSet)
    }
    pub fn registry(env: Env) -> Result<Address, Error> {
        Self::get(&env, &DataKey::Registry)
    }
    pub fn verifier(env: Env) -> Result<Address, Error> {
        Self::get(&env, &DataKey::Verifier)
    }
    pub fn token(env: Env) -> Result<Address, Error> {
        Self::get(&env, &DataKey::Token)
    }

    // ---------- internals ----------

    fn admin(env: &Env) -> Result<Address, Error> {
        Self::get(env, &DataKey::Admin)
    }

    fn get<T: soroban_sdk::TryFromVal<Env, soroban_sdk::Val>>(
        env: &Env,
        key: &DataKey,
    ) -> Result<T, Error> {
        env.storage().instance().get(key).ok_or(Error::NotInitialized)
    }

    /// Public signals in circuit order: outputs, then public inputs as declared.
    fn public_inputs(env: &Env, p: &ClearanceProof) -> Result<Vec<Bn254Fr>, Error> {
        let ext = U256::from_be_bytes(env, &Bytes::from(p.ext_data_hash.clone()));
        let mut vals: Vec<U256> = Vec::new(env);
        vals.push_back(p.budget_nullifier.clone());
        vals.push_back(p.new_budget_commitment.clone());
        vals.push_back(p.enc_new_spent.clone());
        vals.append(&p.record_r);
        vals.append(&p.record_c);
        vals.push_back(p.root.clone());
        vals.push_back(p.public_amount.clone());
        vals.push_back(ext.clone());
        vals.append(&p.input_nullifiers);
        vals.push_back(p.output_commitment0.clone());
        vals.push_back(p.output_commitment1.clone());
        vals.push_back(ext); // nonce = extDataHash
        vals.push_back(p.identity_root.clone());
        vals.push_back(p.budget_root.clone());
        vals.push_back(U256::from_u128(env, u128::from(p.epoch)));
        vals.push_back(U256::from_u32(env, p.sender_jurisdiction));
        vals.push_back(U256::from_u32(env, p.receiver_jurisdiction));
        vals.push_back(p.sender_pack_hash.clone());
        vals.push_back(p.receiver_pack_hash.clone());

        let modulus = bn256_modulus(env);
        let mut out: Vec<Bn254Fr> = Vec::new(env);
        for v in vals.iter() {
            if !amounts::is_canonical_bn256_public_input(&v, &modulus) {
                return Err(Error::NonCanonicalPublicInput);
            }
            out.push_back(Bn254Fr::from_bytes(amounts::u256_to_bytes(env, &v)));
        }
        Ok(out)
    }

    fn verify(env: &Env, p: &ClearanceProof) -> Result<(), Error> {
        let inputs = Self::public_inputs(env, p)?;
        let verifier: Address = Self::get(env, &DataKey::Verifier)?;
        soroban_utils::extend_contract(env, &verifier);
        match CircomGroth16VerifierClient::new(env, &verifier).try_verify(&p.proof, &inputs) {
            Ok(Ok(true)) => Ok(()),
            _ => Err(Error::InvalidProof),
        }
    }
}
