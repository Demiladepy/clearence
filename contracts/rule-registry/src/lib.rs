//! Clearance rule registry.
//!
//! One registry serves every jurisdiction. Each jurisdiction (ISO 3166-1
//! numeric code: NG 566, GH 288, KE 404, ZA 710) has its own admin, the
//! licensed operator there, who alone can publish that jurisdiction's rule
//! packs. Packs are versioned and never deleted, so an old proof can be shown
//! to have used an old pack, and the pool rejects any pack that is not active.
//!
//! The pack hash is computed here, on-chain, from the pack values with
//! Poseidon2, the same hash the circuit recomputes from its private inputs.
//! Nobody submits a hash, so a pack's hash always matches its published numbers.
//!
//! Cross-border: a payment from jurisdiction A to B needs a corridor that A's
//! admin opened and B's admin accepted. Domestic payments (A to A) need none.
#![no_std]

use soroban_sdk::{
    Address, Env, U256, Vec, contract, contracterror, contractevent, contractimpl, contracttype,
    crypto::bn254::Bn254Fr,
};
use soroban_utils::{bn256_modulus, extend_instance, extend_persistent, poseidon2_hash2};

#[cfg(test)]
mod test;

/// Number of tiers every pack defines.
pub const TIER_COUNT: u32 = 3;
/// Domain-separation tag for the pack hash chain (`0x14`).
pub const PACK_HASH_DOMAIN: u32 = 0x14;
/// Seconds in a day, for the epoch (budget day) computation.
pub const DAY_SECS: u64 = 86_400;
/// Amounts are range-checked to 64 bits in the circuit.
const MAX_AMOUNT: i128 = u64::MAX as i128;
/// UTC offsets allowed: -12:00 to +14:00.
const MIN_UTC_OFFSET: i32 = -12 * 3600;
const MAX_UTC_OFFSET: i32 = 14 * 3600;

/// Baby JubJub: `a·x² + y² = 1 + d·x²·y²` (same as `pool-gvk`).
const CURVE_A: u32 = 168_700;
const CURVE_D: u32 = 168_696;

/// Limits for one tier, in USDC stroops (7 decimals).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TierLimits {
    pub per_payment: i128,
    pub daily: i128,
}

/// Operator's Baby JubJub public key; sealed records are encrypted to it.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OperatorKey {
    pub x: U256,
    pub y: U256,
}

/// What a jurisdiction admin publishes.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PackInput {
    /// Local time offset from UTC in seconds. The budget day rolls over at
    /// local midnight (Lagos +3600, Accra 0, Nairobi +10800, Johannesburg +7200).
    pub utc_offset_secs: i32,
    /// Travel Rule threshold in USDC stroops.
    pub travel_rule_threshold: i128,
    /// Exactly `TIER_COUNT` tiers, Tier 1 first, non-decreasing.
    pub tiers: Vec<TierLimits>,
    pub operator_key: OperatorKey,
}

/// A published pack.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RulePack {
    pub jurisdiction: u32,
    pub version: u32,
    pub rules: PackInput,
    /// Poseidon2 hash of all the values above; public input to every proof.
    pub hash: U256,
    /// Ledger timestamp when it was published.
    pub published_at: u64,
}

#[contracttype]
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct Corridor {
    /// Set by the sending jurisdiction's admin.
    pub opened: bool,
    /// Set by the receiving jurisdiction's admin.
    pub accepted: bool,
}

#[contracttype]
#[derive(Clone, Debug)]
enum DataKey {
    Admin,
    /// Admin of a jurisdiction.
    JurisdictionAdmin(u32),
    /// Active version for a jurisdiction (0 = none yet).
    Active(u32),
    /// (jurisdiction, version) -> RulePack
    Pack(u32, u32),
    /// (from, to) -> Corridor
    Corridor(u32, u32),
    /// Allow-list (identity tree) contract of a jurisdiction
    AllowList(u32),
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    NotInitialized = 1,
    UnknownJurisdiction = 2,
    JurisdictionExists = 3,
    NoActivePack = 4,
    UnknownPackVersion = 5,
    WrongTierCount = 6,
    InvalidLimit = 7,
    TiersNotMonotonic = 8,
    InvalidThreshold = 9,
    InvalidUtcOffset = 10,
    InvalidOperatorKey = 11,
    Overflow = 12,
    SameJurisdiction = 13,
    BeforeEpochZero = 14,
    NoAllowList = 15,
}

#[contractevent(topics = ["pack_changed"])]
pub struct PackChanged {
    #[topic]
    pub jurisdiction: u32,
    pub version: u32,
    pub hash: U256,
}

#[contractevent(topics = ["jurisdiction_registered"])]
pub struct JurisdictionRegistered {
    #[topic]
    pub jurisdiction: u32,
    pub admin: Address,
}

#[contractevent(topics = ["corridor_changed"])]
pub struct CorridorChanged {
    #[topic]
    pub from: u32,
    #[topic]
    pub to: u32,
    pub opened: bool,
    pub accepted: bool,
}

#[contractevent(topics = ["allow_list_changed"])]
pub struct AllowListChanged {
    #[topic]
    pub jurisdiction: u32,
    pub allow_list: Address,
}

#[contract]
pub struct RuleRegistry;

#[contractimpl]
impl RuleRegistry {
    pub fn __constructor(env: Env, admin: Address) {
        env.storage().instance().set(&DataKey::Admin, &admin);
    }

    // ---------- jurisdictions ----------

    /// Registry admin onboards a jurisdiction and names its operator.
    pub fn register_jurisdiction(env: Env, jurisdiction: u32, admin: Address) -> Result<(), Error> {
        registry_admin(&env)?.require_auth();
        let key = DataKey::JurisdictionAdmin(jurisdiction);
        if env.storage().persistent().has(&key) {
            return Err(Error::JurisdictionExists);
        }
        env.storage().persistent().set(&key, &admin);
        extend_persistent(&env, &key);
        extend_instance(&env);
        JurisdictionRegistered { jurisdiction, admin }.publish(&env);
        Ok(())
    }

    /// The current operator of a jurisdiction hands it to a new address.
    pub fn transfer_jurisdiction(env: Env, jurisdiction: u32, new_admin: Address) -> Result<(), Error> {
        jurisdiction_admin(&env, jurisdiction)?.require_auth();
        let key = DataKey::JurisdictionAdmin(jurisdiction);
        env.storage().persistent().set(&key, &new_admin);
        extend_persistent(&env, &key);
        Ok(())
    }

    pub fn jurisdiction_admin(env: Env, jurisdiction: u32) -> Result<Address, Error> {
        jurisdiction_admin(&env, jurisdiction)
    }

    // ---------- packs ----------

    /// Publish a new pack version for `jurisdiction` and make it active.
    /// Returns the pack hash. Emits `pack_changed`.
    pub fn set_pack(env: Env, jurisdiction: u32, rules: PackInput) -> Result<U256, Error> {
        jurisdiction_admin(&env, jurisdiction)?.require_auth();
        validate(&env, &rules)?;

        let active_key = DataKey::Active(jurisdiction);
        let prev: u32 = env.storage().persistent().get(&active_key).unwrap_or(0);
        let version = prev.checked_add(1).ok_or(Error::Overflow)?;
        let hash = pack_hash(&env, jurisdiction, version, &rules);

        let pack = RulePack {
            jurisdiction,
            version,
            rules,
            hash: hash.clone(),
            published_at: env.ledger().timestamp(),
        };
        let pack_key = DataKey::Pack(jurisdiction, version);
        env.storage().persistent().set(&pack_key, &pack);
        env.storage().persistent().set(&active_key, &version);
        extend_persistent(&env, &pack_key);
        extend_persistent(&env, &active_key);
        extend_instance(&env);

        PackChanged { jurisdiction, version, hash: hash.clone() }.publish(&env);
        Ok(hash)
    }

    /// Re-activate an earlier version (e.g. roll back a bad pack). Emits `pack_changed`.
    pub fn activate_version(env: Env, jurisdiction: u32, version: u32) -> Result<(), Error> {
        jurisdiction_admin(&env, jurisdiction)?.require_auth();
        let pack = get_pack(&env, jurisdiction, version)?;
        let active_key = DataKey::Active(jurisdiction);
        env.storage().persistent().set(&active_key, &version);
        extend_persistent(&env, &active_key);
        PackChanged { jurisdiction, version, hash: pack.hash }.publish(&env);
        Ok(())
    }

    pub fn active_pack(env: Env, jurisdiction: u32) -> Result<RulePack, Error> {
        active_pack(&env, jurisdiction)
    }

    pub fn pack(env: Env, jurisdiction: u32, version: u32) -> Result<RulePack, Error> {
        get_pack(&env, jurisdiction, version)
    }

    /// The pool calls this: is `hash` the jurisdiction's active pack?
    pub fn is_active(env: Env, jurisdiction: u32, hash: U256) -> bool {
        active_pack(&env, jurisdiction).is_ok_and(|p| p.hash == hash)
    }

    /// Budget day for `jurisdiction` at the current ledger time, in local time.
    /// The pool passes this to the circuit as the public `epoch`; users never set it.
    pub fn epoch(env: Env, jurisdiction: u32) -> Result<u64, Error> {
        let pack = active_pack(&env, jurisdiction)?;
        epoch_at(env.ledger().timestamp(), pack.rules.utc_offset_secs)
    }

    // ---------- corridors ----------

    /// Sending jurisdiction's admin opens `from -> to`.
    pub fn open_corridor(env: Env, from: u32, to: u32) -> Result<Corridor, Error> {
        if from == to {
            return Err(Error::SameJurisdiction);
        }
        jurisdiction_admin(&env, from)?.require_auth();
        jurisdiction_admin(&env, to)?; // must exist
        update_corridor(&env, from, to, |c| c.opened = true)
    }

    /// Receiving jurisdiction's admin accepts `from -> to`.
    pub fn accept_corridor(env: Env, from: u32, to: u32) -> Result<Corridor, Error> {
        if from == to {
            return Err(Error::SameJurisdiction);
        }
        jurisdiction_admin(&env, to)?.require_auth();
        jurisdiction_admin(&env, from)?;
        update_corridor(&env, from, to, |c| c.accepted = true)
    }

    /// Either side can close the corridor, immediately.
    pub fn close_corridor(env: Env, caller: Address, from: u32, to: u32) -> Result<Corridor, Error> {
        caller.require_auth();
        let a = jurisdiction_admin(&env, from)?;
        let b = jurisdiction_admin(&env, to)?;
        if caller != a && caller != b {
            return Err(Error::UnknownJurisdiction);
        }
        update_corridor(&env, from, to, |c| {
            c.opened = false;
            c.accepted = false;
        })
    }

    // ---------- allow-lists ----------

    /// The jurisdiction's admin names the contract holding its KYC allow-list
    /// (an upstream `asp-membership` tree it administers). The pool checks
    /// each proof's identity root against this contract.
    pub fn set_allow_list(env: Env, jurisdiction: u32, allow_list: Address) -> Result<(), Error> {
        jurisdiction_admin(&env, jurisdiction)?.require_auth();
        env.storage()
            .persistent()
            .set(&DataKey::AllowList(jurisdiction), &allow_list);
        AllowListChanged { jurisdiction, allow_list }.publish(&env);
        Ok(())
    }

    pub fn allow_list(env: Env, jurisdiction: u32) -> Result<Address, Error> {
        env.storage()
            .persistent()
            .get(&DataKey::AllowList(jurisdiction))
            .ok_or(Error::NoAllowList)
    }

    /// Domestic is always open; cross-border needs both sides.
    pub fn corridor_open(env: Env, from: u32, to: u32) -> bool {
        if from == to {
            return env.storage().persistent().has(&DataKey::JurisdictionAdmin(from));
        }
        let c: Corridor = env
            .storage()
            .persistent()
            .get(&DataKey::Corridor(from, to))
            .unwrap_or_default();
        c.opened && c.accepted
    }
}

// ---------- internals ----------

fn registry_admin(env: &Env) -> Result<Address, Error> {
    env.storage().instance().get(&DataKey::Admin).ok_or(Error::NotInitialized)
}

fn jurisdiction_admin(env: &Env, jurisdiction: u32) -> Result<Address, Error> {
    env.storage()
        .persistent()
        .get(&DataKey::JurisdictionAdmin(jurisdiction))
        .ok_or(Error::UnknownJurisdiction)
}

fn get_pack(env: &Env, jurisdiction: u32, version: u32) -> Result<RulePack, Error> {
    env.storage()
        .persistent()
        .get(&DataKey::Pack(jurisdiction, version))
        .ok_or(Error::UnknownPackVersion)
}

fn active_pack(env: &Env, jurisdiction: u32) -> Result<RulePack, Error> {
    let version: u32 = env
        .storage()
        .persistent()
        .get(&DataKey::Active(jurisdiction))
        .ok_or(Error::NoActivePack)?;
    get_pack(env, jurisdiction, version)
}

fn update_corridor(env: &Env, from: u32, to: u32, f: impl FnOnce(&mut Corridor)) -> Result<Corridor, Error> {
    let key = DataKey::Corridor(from, to);
    let mut c: Corridor = env.storage().persistent().get(&key).unwrap_or_default();
    f(&mut c);
    env.storage().persistent().set(&key, &c);
    extend_persistent(env, &key);
    CorridorChanged { from, to, opened: c.opened, accepted: c.accepted }.publish(env);
    Ok(c)
}

/// Local-day index. Exposed for tests and off-chain tools.
pub fn epoch_at(ledger_ts: u64, utc_offset_secs: i32) -> Result<u64, Error> {
    let local = i128::from(ledger_ts)
        .checked_add(i128::from(utc_offset_secs))
        .ok_or(Error::Overflow)?;
    if local < 0 {
        return Err(Error::BeforeEpochZero);
    }
    let days = local.checked_div(i128::from(DAY_SECS)).ok_or(Error::Overflow)?;
    u64::try_from(days).map_err(|_| Error::Overflow)
}

fn validate(env: &Env, rules: &PackInput) -> Result<(), Error> {
    if rules.utc_offset_secs < MIN_UTC_OFFSET || rules.utc_offset_secs > MAX_UTC_OFFSET {
        return Err(Error::InvalidUtcOffset);
    }
    if rules.travel_rule_threshold <= 0 || rules.travel_rule_threshold > MAX_AMOUNT {
        return Err(Error::InvalidThreshold);
    }
    if rules.tiers.len() != TIER_COUNT {
        return Err(Error::WrongTierCount);
    }
    let mut prev: Option<TierLimits> = None;
    for t in rules.tiers.iter() {
        if t.per_payment <= 0 || t.daily <= 0 || t.daily > MAX_AMOUNT || t.per_payment > t.daily {
            return Err(Error::InvalidLimit);
        }
        if let Some(p) = &prev
            && (t.per_payment < p.per_payment || t.daily < p.daily)
        {
            return Err(Error::TiersNotMonotonic);
        }
        prev = Some(t);
    }
    if !operator_key_valid(env, &rules.operator_key) {
        return Err(Error::InvalidOperatorKey);
    }
    Ok(())
}

/// On-curve, in-field, not small-order (same checks as `pool-gvk`).
fn operator_key_valid(env: &Env, k: &OperatorKey) -> bool {
    let p = bn256_modulus(env);
    if k.x >= p || k.y >= p {
        return false;
    }
    let zero = U256::from_u32(env, 0);
    if k.x == zero || k.y == zero {
        return false;
    }
    let bn = env.crypto().bn254();
    let fr = |v: u32| Bn254Fr::from_u256(U256::from_u32(env, v));
    let x = Bn254Fr::from_u256(k.x.clone());
    let y = Bn254Fr::from_u256(k.y.clone());
    let x2 = bn.fr_mul(&x, &x);
    let y2 = bn.fr_mul(&y, &y);
    let ax2 = bn.fr_mul(&fr(CURVE_A), &x2);
    let lhs = bn.fr_add(&ax2, &y2);
    let rhs = bn.fr_add(&fr(1), &bn.fr_mul(&fr(CURVE_D), &bn.fr_mul(&x2, &y2)));
    let on_curve = lhs.as_u256() == rhs.as_u256();
    let order8 = y2.as_u256() == ax2.as_u256();
    on_curve && !order8
}

/// Field encoding of a signed offset: `offset + 2^31`, always non-negative.
fn offset_field(env: &Env, offset: i32) -> U256 {
    let shifted = i64::from(offset).saturating_add(1_i64 << 31);
    U256::from_u128(env, u128::try_from(shifted).unwrap_or(0))
}

fn amount_field(env: &Env, v: i128) -> U256 {
    // validate() guarantees 0 < v <= u64::MAX
    U256::from_u128(env, u128::try_from(v).unwrap_or(0))
}

/// packHash = chained Poseidon2 (t=3, domain 0x14) over, in order:
/// jurisdiction, version, utcOffset+2^31, travelRuleThreshold,
/// t1.perPayment, t1.daily, t2.perPayment, t2.daily, t3.perPayment, t3.daily,
/// operatorKey.x, operatorKey.y.
///
/// h = H(jurisdiction, version); then h = H(h, next) for each following value.
/// The circuit's `PackHash` template must hash the same values in the same order.
pub fn pack_hash(env: &Env, jurisdiction: u32, version: u32, rules: &PackInput) -> U256 {
    let dom = Some(U256::from_u32(env, PACK_HASH_DOMAIN));
    let mut h = poseidon2_hash2(
        env,
        U256::from_u32(env, jurisdiction),
        U256::from_u32(env, version),
        dom.clone(),
    );
    let mut absorb = |v: U256| {
        h = poseidon2_hash2(env, h.clone(), v, dom.clone());
    };
    absorb(offset_field(env, rules.utc_offset_secs));
    absorb(amount_field(env, rules.travel_rule_threshold));
    for t in rules.tiers.iter() {
        absorb(amount_field(env, t.per_payment));
        absorb(amount_field(env, t.daily));
    }
    absorb(rules.operator_key.x.clone());
    absorb(rules.operator_key.y.clone());
    h
}
