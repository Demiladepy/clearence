//! Clearance pool, end to end. Every payment is a real proof verified on
//! "chain" (the Soroban test host) by the real verifier and pool.

use super::world::*;
use anyhow::Result;
use clearance_pool::Error;
use soroban_sdk::{Address, testutils::{Address as _, Ledger as _}};
use std::fmt::Write as _;

/// Testnet per-transaction limits, read with `stellar network settings` on
/// 27 Nov 2026 (contract_compute_v0.tx_max_instructions, tx_memory_limit).
const TX_INSTRUCTION_LIMIT: i64 = 400_000_000;
const TX_MEMORY_LIMIT: i64 = 41_943_040;

#[test]
#[ignore = "needs `make circuits` artifacts and the clearance_tx_2_2 proving key"]
fn nigeria_to_ghana_end_to_end() -> Result<()> {
    let mut w = World::new();
    let ada = w.onboard(42, NG, 1, 100);
    let kofi = w.onboard(43, GH, 1, 100);
    let bob = w.onboard(44, NG, 1, 0);
    let mut costs = String::new();

    // 1. Ada funds her private balance with 25 USD: nothing is "sent".
    let p = w.payment(&ada, &[], (ada.receive_key(), 0), 25 * USD, 0, &ng_pack(), &ada.account);
    let proof = w.prove(&p)?;
    let r = w.submit(&ada, &proof, &p.ext).expect("deposit accepted");
    let note = r.change(&p);
    assert_eq!(note.amount, 25 * USD);
    assert_eq!(open_record(&r.record, 0, d_ng()).2, 0);
    writeln!(costs, "| deposit 25 USD (NG) | {} | {} |", r.instructions, r.mem_bytes)?;
    assert!(r.instructions < TX_INSTRUCTION_LIMIT, "deposit: {} instructions", r.instructions);
    assert!(r.mem_bytes < TX_MEMORY_LIMIT, "deposit: {} bytes", r.mem_bytes);

    // 2. Ada pays Bob 15 USD inside Nigeria. NG's operator opens the record.
    let p = w.payment(&ada, &[note], (bob.receive_key(), 15 * USD), 0, 0, &ng_pack(), &ada.account);
    let proof = w.prove(&p)?;
    let r = w.submit(&ada, &proof, &p.ext).expect("domestic payment accepted");
    let expected = (id_commitment(ada.id), bob.receive_key(), 15 * USD, false);
    assert_eq!((r.record.sender_jurisdiction, r.record.receiver_jurisdiction), (NG, NG));
    assert_eq!(open_record(&r.record, 0, d_ng()), expected);
    assert_eq!(open_record(&r.record, 1, d_ng()), expected);
    writeln!(costs, "| pay 15 USD NG -> NG | {} | {} |", r.instructions, r.mem_bytes)?;
    assert!(r.instructions < TX_INSTRUCTION_LIMIT);
    let note = r.change(&p); // 10 USD left

    // 3. Ada pays Kofi 3 USD in Ghana. Each operator opens only its own copy.
    let p = w.payment(&ada, &[note], (kofi.receive_key(), 3 * USD), 0, 0, &gh_pack(), &ada.account);
    let proof = w.prove(&p)?;
    let r = w.submit(&ada, &proof, &p.ext).expect("cross-border payment accepted");
    let expected = (id_commitment(ada.id), kofi.receive_key(), 3 * USD, false);
    assert_eq!((r.record.sender_jurisdiction, r.record.receiver_jurisdiction), (NG, GH));
    assert_eq!(open_record(&r.record, 0, d_ng()), expected, "NG opens its copy");
    assert_eq!(open_record(&r.record, 1, d_gh()), expected, "GH opens its copy");
    assert_ne!(open_record(&r.record, 1, d_ng()), expected, "NG cannot open GH's copy");
    writeln!(costs, "| pay 3 USD NG -> GH | {} | {} |", r.instructions, r.mem_bytes)?;
    assert!(r.instructions < TX_INSTRUCTION_LIMIT);
    let kofi_note = r.received(&p);
    let note = r.change(&p); // 7 USD left

    // 4. Ada's budget, recovered from chain events alone: 18 of 31.25 USD.
    assert_eq!(w.budget_state(&ada).1, 18 * USD);
    // 13.26 more would exceed it: no proof can be made.
    let p = w.payment(&ada, &[note], (bob.receive_key(), cents(1326)), 13 * USD, 0, &ng_pack(), &ada.account);
    assert!(w.prove(&p).is_err(), "over the daily budget");
    // 13.25 reaches it exactly (deposit 13 to cover it).
    let p = w.payment(&ada, &[note], (bob.receive_key(), cents(1325)), 13 * USD, 0, &ng_pack(), &ada.account);
    let proof = w.prove(&p)?;
    w.submit(&ada, &proof, &p.ext).expect("exactly at the daily limit");
    assert_eq!(w.budget_state(&ada).1, cents(3125));

    // 5. Kofi withdraws what he received to his Stellar account.
    let before = soroban_sdk::token::TokenClient::new(&w.env, &w.token).balance(&kofi.account);
    let p = w.payment(&kofi, &[kofi_note], (kofi.receive_key(), 0), 0, 3 * USD, &gh_pack(), &kofi.account);
    let proof = w.prove(&p)?;
    let r = w.submit(&kofi, &proof, &p.ext).expect("withdrawal accepted");
    let after = soroban_sdk::token::TokenClient::new(&w.env, &w.token).balance(&kofi.account);
    assert_eq!(after - before, i128::from(3 * USD));
    assert_eq!(open_record(&r.record, 0, d_gh()).2, 3 * USD, "withdrawal counted as sent");
    writeln!(costs, "| withdraw 3 USD (GH) | {} | {} |", r.instructions, r.mem_bytes)?;

    write_costs(&costs)?;
    Ok(())
}

#[test]
#[ignore = "needs `make circuits` artifacts and the clearance_tx_2_2 proving key"]
fn the_pool_enforces_what_the_circuit_cannot() -> Result<()> {
    let mut w = World::new();
    let ada = w.onboard(42, NG, 1, 100);
    let kofi = w.onboard(43, GH, 1, 100);
    let fund = |w: &mut World, p: &Person| w.payment(p, &[], (p.receive_key(), 0), 10 * USD, 0, &ng_pack(), &p.account);

    // Replayed proof: note and budget nullifiers already spent.
    let p = fund(&mut w, &ada);
    let proof = w.prove(&p)?;
    w.submit(&ada, &proof, &p.ext).expect("first submission");
    assert_eq!(w.submit(&ada, &proof, &p.ext).err(), Some(Error::AlreadySpentNullifier));

    // Second wallet starting today's budget afresh (stale state, seq 0): the
    // proof is valid, the budget nullifier is not.
    let mut stale = w.payment(&ada, &[], (ada.receive_key(), 0), 5 * USD, 0, &ng_pack(), &ada.account);
    stale.inputs.set("budgetSeq", num_bigint::BigInt::from(0u64));
    stale.inputs.set("budgetSpent", num_bigint::BigInt::from(0u64));
    let proof = w.prove(&stale)?;
    assert_eq!(w.submit(&ada, &proof, &stale.ext).err(), Some(Error::BudgetNullifierSpent));

    // Tampered public signal (the sealed record): the proof no longer verifies.
    let p = fund(&mut w, &ada);
    let good = w.prove(&p)?;
    let mut bad = good.clone();
    bad.record_c.set(2, w.pool.get_root()); // any other value
    assert_eq!(w.submit(&ada, &bad, &p.ext).err(), Some(Error::InvalidProof));
    // Changed external data (recipient): hash mismatch.
    let mut ext = p.ext.clone();
    ext.recipient = Address::generate(&w.env);
    assert_eq!(w.submit(&ada, &good, &ext).err(), Some(Error::WrongExtHash));
    w.submit(&ada, &good, &p.ext).expect("untampered proof accepted");

    // Kofi (GH) pays Ada (NG): the GH -> NG corridor was never opened.
    let p = w.payment(&kofi, &[], (ada.receive_key(), 2 * USD), 5 * USD, 0, &ng_pack(), &kofi.account);
    let proof = w.prove(&p)?;
    assert_eq!(w.submit(&kofi, &proof, &p.ext).err(), Some(Error::CorridorClosed));
    w.registry.open_corridor(&GH, &NG);
    w.registry.accept_corridor(&GH, &NG);
    w.submit(&kofi, &proof, &p.ext).expect("accepted once both operators open GH -> NG");

    // NG publishes v2 while Ada's proof (made under v1) is in flight: rejected (AT-6).
    let p = fund(&mut w, &ada);
    let proof = w.prove(&p)?;
    let mut v2 = ng_pack();
    v2.version = 2;
    v2.tiers[0] = (cents(2000), cents(4000));
    w.registry.set_pack(&NG, &v2.input(&w.env));
    assert_eq!(w.submit(&ada, &proof, &p.ext).err(), Some(Error::PackNotActive));
    w.registry.activate_version(&NG, &1);
    w.submit(&ada, &proof, &p.ext).expect("accepted under v1 again");

    // Proof made before local midnight, submitted after it: wrong epoch.
    let p = fund(&mut w, &ada);
    let proof = w.prove(&p)?;
    w.env.ledger().set_timestamp(NOON_27_NOV + 12 * 3600); // 01:00 in Lagos on the 28th
    assert_eq!(w.submit(&ada, &proof, &p.ext).err(), Some(Error::WrongEpoch));
    w.env.ledger().set_timestamp(NOON_27_NOV);
    w.submit(&ada, &proof, &p.ext).expect("accepted on the same local day");

    // Eve was never listed on chain. She builds a proof against her own copy
    // of the allow-list with her leaf added: valid proof, unknown root.
    use circuits::test::utils::{general::scalar_to_bigint as b, merkle_tree as mt};
    let eve = w.unlisted(66, NG, 1, 100);
    let mut p = w.payment(&eve, &[], (eve.receive_key(), 0), 5 * USD, 0, &ng_pack(), &eve.account);
    let mut forged = w.id_leaves[0].1.clone();
    forged.push(tier_leaf(eve.id, NG, 1));
    let (path, bits) = mt::merkle_proof_padded(&forged, forged.len() - 1, ID_LEVELS as usize);
    p.inputs.set("identityRoot", b(mt::merkle_root_padded(&forged, ID_LEVELS as usize)));
    p.inputs.set("idPathElements", path.iter().map(|e| b(*e)).collect::<Vec<_>>());
    p.inputs.set("idPathIndices", num_bigint::BigInt::from(bits));
    let proof = w.prove(&p)?;
    assert_eq!(w.submit(&eve, &proof, &p.ext).err(), Some(Error::UnknownIdentityRoot));
    Ok(())
}

fn write_costs(rows: &str) -> Result<()> {
    let out = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../target/clearance-pool-costs.md");
    std::fs::write(
        &out,
        format!(
            "| Call | CPU instructions | Memory bytes |\n|---|---:|---:|\n{rows}\nTestnet per-transaction limits (stellar network settings, 27 Nov 2026): {TX_INSTRUCTION_LIMIT} instructions, {TX_MEMORY_LIMIT} bytes memory.\n"
        ),
    )?;
    Ok(())
}
