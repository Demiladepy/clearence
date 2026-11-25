#![allow(clippy::unwrap_used, clippy::arithmetic_side_effects)]
extern crate std;

use super::*;
use soroban_sdk::{Bytes, BytesN, testutils::{Address as _, Ledger}, vec};

const NG: u32 = 566;
const GH: u32 = 288;
const KE: u32 = 404;
const ZA: u32 = 710;

/// USD -> stroops
fn usd(v: i128) -> i128 {
    v * 10_000_000
}

fn u256_hex(env: &Env, hex: &str) -> U256 {
    let mut b = [0u8; 32];
    for i in 0..32 {
        b[i] = u8::from_str_radix(&hex[2 * i..2 * i + 2], 16).unwrap();
    }
    U256::from_be_bytes(env, &Bytes::from_array(env, &b))
}

/// Baby JubJub BASE8 (prime-order generator) as a stand-in operator key.
fn base8(env: &Env) -> OperatorKey {
    OperatorKey {
        x: u256_hex(env, "0bb77a6ad63e739b4eacb2e09d6277c12ab8d8010534e0b62893f3f6bb957051"),
        y: u256_hex(env, "25797203f7a0b24925572e1cd16bf9edfce0051fb9e133774b3c257a872d7d8b"),
    }
}

fn pack(env: &Env, offset: i32, tiers: [(i128, i128); 3]) -> PackInput {
    PackInput {
        utc_offset_secs: offset,
        travel_rule_threshold: usd(1000),
        tiers: vec![
            env,
            TierLimits { per_payment: usd(tiers[0].0), daily: usd(tiers[0].1) },
            TierLimits { per_payment: usd(tiers[1].0), daily: usd(tiers[1].1) },
            TierLimits { per_payment: usd(tiers[2].0), daily: usd(tiers[2].1) },
        ],
        operator_key: base8(env),
    }
}

struct Setup<'a> {
    env: Env,
    reg: RuleRegistryClient<'a>,
    ng: Address,
    gh: Address,
}

fn setup() -> Setup<'static> {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let id = env.register(RuleRegistry, (admin,));
    let reg = RuleRegistryClient::new(&env, &id);
    let ng = Address::generate(&env);
    let gh = Address::generate(&env);
    reg.register_jurisdiction(&NG, &ng);
    reg.register_jurisdiction(&GH, &gh);
    Setup { env, reg, ng, gh }
}

#[test]
fn publishes_versioned_packs_and_tracks_active() {
    let s = setup();
    let h1 = s.reg.set_pack(&NG, &pack(&s.env, 3600, [(18, 31), (625, 1250), (3125, 6250)]));
    assert_eq!(s.reg.active_pack(&NG).version, 1);
    assert!(s.reg.is_active(&NG, &h1));

    let h2 = s.reg.set_pack(&NG, &pack(&s.env, 3600, [(20, 40), (625, 1250), (3125, 6250)]));
    assert_ne!(h1, h2);
    assert_eq!(s.reg.active_pack(&NG).version, 2);
    // AT-6: a proof made under the old pack no longer matches the active one
    assert!(!s.reg.is_active(&NG, &h1));
    assert!(s.reg.is_active(&NG, &h2));
    // history kept
    assert_eq!(s.reg.pack(&NG, &1).hash, h1);

    s.reg.activate_version(&NG, &1);
    assert!(s.reg.is_active(&NG, &h1));
}

#[test]
fn hash_is_bound_to_jurisdiction_and_every_value() {
    let s = setup();
    let p = pack(&s.env, 0, [(15, 25), (500, 1000), (2500, 5000)]);
    let ng = s.reg.set_pack(&NG, &p);
    let gh = s.reg.set_pack(&GH, &p);
    // identical numbers in two countries still give distinct hashes
    assert_ne!(ng, gh);
    // the stored hash is recomputable off-chain from the published values
    assert_eq!(pack_hash(&s.env, GH, 1, &p), gh);
    let mut q = p.clone();
    q.travel_rule_threshold = usd(999);
    assert_ne!(pack_hash(&s.env, GH, 1, &q), gh);
    let mut r = p.clone();
    r.utc_offset_secs = 3600;
    assert_ne!(pack_hash(&s.env, GH, 1, &r), gh);
}

#[test]
fn rejects_bad_packs() {
    let s = setup();
    let e = &s.env;
    let bad_order = pack(e, 0, [(100, 1000), (50, 2000), (3000, 6000)]);
    assert_eq!(s.reg.try_set_pack(&NG, &bad_order), Err(Ok(Error::TiersNotMonotonic)));
    let per_gt_daily = pack(e, 0, [(50, 40), (500, 1000), (3000, 6000)]);
    assert_eq!(s.reg.try_set_pack(&NG, &per_gt_daily), Err(Ok(Error::InvalidLimit)));
    let bad_offset = pack(e, 15 * 3600, [(15, 25), (500, 1000), (2500, 5000)]);
    assert_eq!(s.reg.try_set_pack(&NG, &bad_offset), Err(Ok(Error::InvalidUtcOffset)));
    let mut off_curve = pack(e, 0, [(15, 25), (500, 1000), (2500, 5000)]);
    off_curve.operator_key.x = U256::from_u32(e, 7);
    assert_eq!(s.reg.try_set_pack(&NG, &off_curve), Err(Ok(Error::InvalidOperatorKey)));
    let mut two_tiers = pack(e, 0, [(15, 25), (500, 1000), (2500, 5000)]);
    two_tiers.tiers.pop_back();
    assert_eq!(s.reg.try_set_pack(&NG, &two_tiers), Err(Ok(Error::WrongTierCount)));
    assert_eq!(s.reg.try_set_pack(&KE, &two_tiers), Err(Ok(Error::UnknownJurisdiction)));
}

#[test]
fn only_the_jurisdictions_own_admin_can_set_its_pack() {
    let env = Env::default();
    let admin = Address::generate(&env);
    let id = env.register(RuleRegistry, (admin.clone(),));
    let reg = RuleRegistryClient::new(&env, &id);
    let ng = Address::generate(&env);
    env.mock_all_auths();
    reg.register_jurisdiction(&NG, &ng);
    reg.set_pack(&NG, &pack(&env, 3600, [(18, 31), (625, 1250), (3125, 6250)]));
    let auths = env.auths();
    assert_eq!(auths.len(), 1);
    assert_eq!(auths[0].0, ng); // NG operator signed, not the registry admin
}

#[test]
fn epoch_rolls_at_local_midnight() {
    // 2026-11-22 23:30 UTC
    let ts: u64 = 1_795_390_200;
    let utc_day = ts / DAY_SECS;
    assert_eq!(epoch_at(ts, 0).unwrap(), utc_day); // Accra: still the 22nd
    assert_eq!(epoch_at(ts, 3600).unwrap(), utc_day + 1); // Lagos: already the 23rd
    assert_eq!(epoch_at(ts, 3 * 3600).unwrap(), utc_day + 1); // Nairobi
    assert_eq!(epoch_at(10, -3600), Err(Error::BeforeEpochZero));

    let s = setup();
    s.env.ledger().set_timestamp(ts);
    s.reg.set_pack(&NG, &pack(&s.env, 3600, [(18, 31), (625, 1250), (3125, 6250)]));
    s.reg.set_pack(&GH, &pack(&s.env, 0, [(15, 25), (500, 1000), (2500, 5000)]));
    assert_eq!(s.reg.epoch(&NG), utc_day + 1);
    assert_eq!(s.reg.epoch(&GH), utc_day);
}

#[test]
fn corridors_need_both_sides() {
    let s = setup();
    assert!(s.reg.corridor_open(&NG, &NG)); // domestic
    assert!(!s.reg.corridor_open(&NG, &GH));
    s.reg.open_corridor(&NG, &GH);
    assert!(!s.reg.corridor_open(&NG, &GH)); // Ghana hasn't accepted
    s.reg.accept_corridor(&NG, &GH);
    assert!(s.reg.corridor_open(&NG, &GH));
    assert!(!s.reg.corridor_open(&GH, &NG)); // one-way
    s.reg.close_corridor(&s.gh, &NG, &GH);
    assert!(!s.reg.corridor_open(&NG, &GH));
    assert_eq!(s.reg.try_open_corridor(&NG, &NG), Err(Ok(Error::SameJurisdiction)));
    assert_eq!(s.reg.try_open_corridor(&NG, &ZA), Err(Ok(Error::UnknownJurisdiction)));
    let stranger = Address::generate(&s.env);
    assert_eq!(s.reg.try_close_corridor(&stranger, &NG, &GH), Err(Ok(Error::UnknownJurisdiction)));
    let _ = (&s.ng, BytesN::<32>::from_array(&s.env, &[0; 32]));
}

#[test]
fn onboards_kenya_and_south_africa_without_code_changes() {
    let s = setup();
    let ke = Address::generate(&s.env);
    let za = Address::generate(&s.env);
    s.reg.register_jurisdiction(&KE, &ke);
    s.reg.register_jurisdiction(&ZA, &za);
    s.reg.set_pack(&KE, &pack(&s.env, 3 * 3600, [(20, 40), (700, 1400), (3500, 7000)]));
    s.reg.set_pack(&ZA, &pack(&s.env, 2 * 3600, [(25, 50), (800, 1600), (4000, 8000)]));
    assert_eq!(s.reg.active_pack(&ZA).jurisdiction, ZA);
    assert_eq!(s.reg.try_register_jurisdiction(&KE, &ke), Err(Ok(Error::JurisdictionExists)));
}

/// Golden vector shared with circuits/test/rust/clearance_pack_hash.rs: the NG and GH
/// v1 packs as published to the testnet registry. If this and the circuit test
/// both pass, contract, Rust reference and circuit agree.
#[test]
fn pack_hash_matches_testnet_and_circuit_golden_values() {
    let s = setup();
    let key = |x: &str, y: &str| OperatorKey { x: u256_hex(&s.env, x), y: u256_hex(&s.env, y) };
    let mk = |offset: i32, tiers: [(i128, i128); 3], k: OperatorKey| PackInput {
        utc_offset_secs: offset,
        travel_rule_threshold: usd(1000),
        tiers: vec![
            &s.env,
            TierLimits { per_payment: tiers[0].0, daily: tiers[0].1 },
            TierLimits { per_payment: tiers[1].0, daily: tiers[1].1 },
            TierLimits { per_payment: tiers[2].0, daily: tiers[2].1 },
        ],
        operator_key: k,
    };
    let ng = mk(
        3600,
        [(187_500_000, 312_500_000), (usd(625), usd(1250)), (usd(3125), usd(6250))],
        key(
            "2fc5abae81b0271fadeb747ef10ceb622c3a25d618c83b7c3791fb5ac39aa7e0",
            "17b6f1f1c0310c052bed7fb45f82ca7002abf8875b86e97938a10341bdd04dc3",
        ),
    );
    let gh = mk(
        0,
        [(usd(15), usd(25)), (usd(500), usd(1000)), (usd(2500), usd(5000))],
        key(
            "039099996fea0e2f95b59776448da792335475da894d4da84372c143d28c45e4",
            "003e4c7c5954dbad5c83d876ce0be5400f0a72a4cb1aaa834d0fa4c49c8d264b",
        ),
    );
    let dec = |d: &str| {
        let n = num_bigint::BigUint::parse_bytes(d.as_bytes(), 10).unwrap();
        let mut b = [0u8; 32];
        let v = n.to_bytes_be();
        b[32 - v.len()..].copy_from_slice(&v);
        U256::from_be_bytes(&s.env, &Bytes::from_array(&s.env, &b))
    };
    assert_eq!(
        s.reg.set_pack(&NG, &ng),
        dec("793274114535773168330462619525225772468182337604504132993004277258700724562")
    );
    assert_eq!(
        s.reg.set_pack(&GH, &gh),
        dec("15352878594874501808841481184584733912846590580291801597728574576845088907239")
    );
}
