//! Real payments on Stellar testnet against the contracts in
//! deployments/testnet.json, submitted through the `stellar` CLI.
//!
//!   make deploy-testnet          # fresh pool (the driver expects empty trees)
//!   make testnet-demo            # this test, writes deployments/testnet-demo.json
//!
//! Proofs are built exactly as in the in-host tests (`Mirror`). After every
//! payment the driver reads the pool's and the budget tree's roots from chain
//! and checks them against its mirror, and each operator opens its sealed
//! record from the `sealed_record` event fetched from the network.

use super::world::*;
use anyhow::{Context, Result, bail, ensure};
use clearance_pool::ClearanceProof;
use pool_core::ExtData;
use serde_json::{Value, json};
use soroban_sdk::{Address, Env, String as SString};
use std::{path::PathBuf, process::Command};

/// Stands in at the pool's address in the local host, so the external-data
/// hash (which binds the pool's address) can be computed locally.
#[soroban_sdk::contract]
struct PoolAddress;
#[soroban_sdk::contractimpl]
impl PoolAddress {
    pub fn noop() {}
}

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..")
}
fn net() -> String {
    std::env::var("CLEARANCE_NETWORK").unwrap_or_else(|_| "clr-testnet".into())
}

/// Run the stellar CLI; returns (stdout, stderr).
fn stellar(args: &[&str]) -> Result<(String, String)> {
    let out = Command::new("stellar").args(args).output().context("run stellar")?;
    let (o, e) = (String::from_utf8_lossy(&out.stdout).trim().to_string(), String::from_utf8_lossy(&out.stderr).to_string());
    if !out.status.success() {
        bail!("stellar {}: {}", args.iter().take(8).cloned().collect::<Vec<_>>().join(" "), e.trim().chars().rev().take(1500).collect::<String>().chars().rev().collect::<String>());
    }
    Ok((o, e))
}
fn invoke(id: &str, source: &str, args: &[&str]) -> Result<(String, String)> {
    let n = net();
    let mut a = vec!["contract", "invoke", "--id", id, "--source", source, "--network", n.as_str(), "--"];
    a.extend_from_slice(args);
    stellar(&a)
}
fn addr(key: &str) -> Result<String> {
    Ok(stellar(&["keys", "address", key])?.0)
}
fn tx_hash(stderr: &str) -> Option<String> {
    stderr
        .split(|c: char| !c.is_ascii_hexdigit())
        .find(|w| w.len() == 64)
        .map(str::to_owned)
}
fn dec(x: ark_bn254::Fr) -> String {
    circuits::test::utils::general::scalar_to_bigint(x).to_string()
}
fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// A demo account: CLI identity, funded, trusting CLRUSD, minted `usd`.
fn account(alias: &str, usd: u64, d: &Value) -> Result<String> {
    if stellar(&["keys", "address", alias]).is_err() {
        stellar(&["keys", "generate", alias])?;
    }
    let a = addr(alias)?;
    // Friendbot (ignore "already funded")
    let _ = Command::new("curl").args(["-s", &format!("https://friendbot.stellar.org/?addr={a}")]).output();
    let asset = d["token"]["asset"].as_str().context("asset")?;
    let n = net();
    let _ = stellar(&["tx", "new", "change-trust", "--source", alias, "--line", asset, "--network", n.as_str()]);
    invoke(d["token"]["contract"].as_str().context("token")?, "clr-admin", &["mint", "--to", &a, "--amount", &(usd * USD).to_string()])?;
    Ok(a)
}

fn proof_json(p: &ClearanceProof) -> Value {
    let u = |x: &soroban_sdk::U256| dec(from_u256(x));
    let v = |xs: &soroban_sdk::Vec<soroban_sdk::U256>| xs.iter().map(|x| Value::String(u(&x))).collect::<Vec<_>>();
    json!({
        "proof": {
            "a": hex(&p.proof.a.to_bytes().to_array()),
            "b": hex(&p.proof.b.to_bytes().to_array()),
            "c": hex(&p.proof.c.to_bytes().to_array()),
        },
        "root": u(&p.root),
        "input_nullifiers": v(&p.input_nullifiers),
        "output_commitment0": u(&p.output_commitment0),
        "output_commitment1": u(&p.output_commitment1),
        "public_amount": u(&p.public_amount),
        "ext_data_hash": hex(&p.ext_data_hash.to_array()),
        "identity_root": u(&p.identity_root),
        "budget_root": u(&p.budget_root),
        "epoch": p.epoch,
        "sender_jurisdiction": p.sender_jurisdiction,
        "receiver_jurisdiction": p.receiver_jurisdiction,
        "sender_pack_hash": u(&p.sender_pack_hash),
        "receiver_pack_hash": u(&p.receiver_pack_hash),
        "budget_nullifier": u(&p.budget_nullifier),
        "new_budget_commitment": u(&p.new_budget_commitment),
        "enc_new_spent": u(&p.enc_new_spent),
        "record_r": v(&p.record_r),
        "record_c": v(&p.record_c),
    })
}
fn ext_json(e: &ExtData, recipient: &str) -> Value {
    json!({
        "recipient": recipient,
        "ext_amount": e.ext_amount.to_i128().expect("i128").to_string(),
        "encrypted_output0": "",
        "encrypted_output1": "",
    })
}

/// A contract's events from `start`, decoded by the CLI from the contract spec.
fn events(id: &str, start: u64) -> Result<Vec<Value>> {
    let n = net();
    let mut out = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let st = start.to_string();
        let mut args = vec!["events", "--id", id, "--network", n.as_str(), "--output", "json", "--count", "200"];
        let c;
        if let Some(cur) = &cursor { c = cur.clone(); args.extend(["--cursor", c.as_str()]); } else { args.extend(["--start-ledger", st.as_str()]); }
        let (o, _) = stellar(&args)?;
        let page: Vec<Value> = o.lines().filter(|l| l.trim_start().starts_with('{')).filter_map(|l| serde_json::from_str(l).ok()).collect();
        let more = page.len() == 200;
        cursor = page.last().and_then(|e| e["id"].as_str().map(str::to_owned));
        out.extend(page);
        if !more { break; }
    }
    Ok(out)
}
fn pdec(v: &Value) -> ark_bn254::Fr {
    match v {
        Value::String(s) => parse_dec(s),
        Value::Number(n) => s(n.as_u64().expect("u64")),
        other => panic!("not a number: {other}"),
    }
}
/// Leaves of an asp-membership tree, from its LeafAdded events, in index order.
fn tree_leaves(id: &str, start: u64) -> Result<Vec<ark_bn254::Fr>> {
    let mut v: Vec<(u64, ark_bn254::Fr)> = events(id, start)?
        .iter()
        .filter(|e| e["event_name"] == "LeafAddedEvent")
        .map(|e| (e["params"]["index"].as_u64().expect("index"), pdec(&e["params"]["leaf"])))
        .collect();
    v.sort_by_key(|x| x.0);
    for (k, (i, _)) in v.iter().enumerate() {
        ensure!(*i == k as u64, "gap in tree {id} at {k}");
    }
    Ok(v.into_iter().map(|x| x.1).collect())
}

/// Rebuild every mirror from chain events, as a fresh wallet would.
/// Returns the pool's SealedRecord events.
fn sync(m: &mut Mirror, pool: &str, budget_tree: &str, lists: &[String; 2], start: u64) -> Result<Vec<SealedRecordEvent>> {
    m.id_leaves[0].1 = tree_leaves(&lists[0], start)?;
    m.id_leaves[1].1 = tree_leaves(&lists[1], start)?;
    m.budget_leaves = tree_leaves(budget_tree, start)?;
    let evs = events(pool, start)?;
    let mut notes: Vec<(u64, ark_bn254::Fr)> = Vec::new();
    let mut records = Vec::new();
    m.budget_steps.clear();
    for e in &evs {
        let p = &e["params"];
        match e["event_name"].as_str() {
            Some("NewCommitmentEvent") => notes.push((p["index"].as_u64().context("index")?, pdec(&p["commitment"]))),
            Some("BudgetStep") => m.budget_steps.push((pdec(&p["nullifier"]), pdec(&p["commitment"]), pdec(&p["enc_new_spent"]))),
            Some("SealedRecord") => records.push(SealedRecordEvent {
                sender_jurisdiction: u32::try_from(p["sender_jurisdiction"].as_u64().context("sj")?)?,
                receiver_jurisdiction: u32::try_from(p["receiver_jurisdiction"].as_u64().context("rj")?)?,
                r: p["record_r"].as_array().context("record_r")?.iter().map(pdec).collect(),
                c: p["record_c"].as_array().context("record_c")?.iter().map(pdec).collect(),
                first_note_index: 0,
            }),
            _ => {}
        }
    }
    notes.sort_by_key(|x| x.0);
    m.notes = notes.into_iter().map(|x| x.1).collect();
    Ok(records)
}

#[test]
#[ignore = "talks to Stellar testnet: set CLEARANCE_TESTNET=1 (see make testnet-demo)"]
fn testnet_demo() -> Result<()> {
    if std::env::var("CLEARANCE_TESTNET").is_err() {
        eprintln!("skipping: CLEARANCE_TESTNET not set");
        return Ok(());
    }
    let d: Value = serde_json::from_str(&std::fs::read_to_string(root().join("deployments/testnet.json"))?)?;
    let pool = d["pool"].as_str().context("pool")?.to_owned();
    let token = d["token"]["contract"].as_str().context("token")?.to_owned();
    let budget_tree = d["budgetTree"].as_str().context("budgetTree")?.to_owned();
    let registry = d["ruleRegistry"].as_str().context("registry")?.to_owned();
    let lists = [d["jurisdictions"]["566"]["allowList"].as_str().context("ng list")?.to_owned(),
                 d["jurisdictions"]["288"]["allowList"].as_str().context("gh list")?.to_owned()];

    let env = Env::default();
    let pool_addr = Address::from_string(&SString::from_str(&env, &pool));
    let token_addr = Address::from_string(&SString::from_str(&env, &token));
    let run = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?.as_secs();
    env.register_at(&pool_addr, PoolAddress, ());
    let mut m = Mirror::new(&env, pool_addr, token_addr, run << 20);
    let chain_root = |id: &str| -> Result<ark_bn254::Fr> {
        let (o, _) = invoke(id, "clr-admin", &["get_root"])?;
        Ok(parse_dec(&o))
    };
    let start = d["startLedger"].as_u64().context("startLedger in deployments/testnet.json")?;
    sync(&mut m, &pool, &budget_tree, &lists, start)?;
    ensure!(chain_root(&pool)? == circuits::test::utils::merkle_tree::PrefixTree::new(&m.notes, POOL_LEVELS as usize).root(), "note root parity (synced from events)");
    ensure!(chain_root(&budget_tree)? == circuits::test::utils::merkle_tree::merkle_root_padded(&m.budget_leaves, BUDGET_LEVELS as usize), "budget root parity (synced from events)");

    // Real operator keys (gvkey-gen) from .secrets/, not the test keys.
    let op_key = |k: &str| -> Result<(ark_bn254::Fr, (ark_bn254::Fr, ark_bn254::Fr))> {
        let v: Value = serde_json::from_str(&std::fs::read_to_string(root().join(format!(".secrets/operator-{k}.json")))?)?;
        let h = |s: &str| parse_hex(s);
        let d = h(v["privateKey"].as_str().context("priv")?);
        let pk = (h(v["publicKey"]["x"].as_str().context("x")?), h(v["publicKey"]["y"].as_str().context("y")?));
        ensure!(
            circuits::test::utils::global_view_key::admin_public_key(d) == pk,
            "operator-{k}.json: private key does not match its public key as d * BASE8"
        );
        Ok((d, pk))
    };
    let (d_ng, k_ng) = op_key("ng")?;
    let (d_gh, k_gh) = op_key("gh")?;
    let ng = Pack { key: k_ng, ..ng_pack() };
    let gh = Pack { key: k_gh, ..gh_pack() };
    ensure!(dec(ng.hash()) == d["jurisdictions"]["566"]["packHash"].as_str().unwrap_or(""), "NG pack hash vs registry");
    ensure!(dec(gh.hash()) == d["jurisdictions"]["288"]["packHash"].as_str().unwrap_or(""), "GH pack hash vs registry");
    m.packs = [ng.clone(), gh.clone()];
    let epoch = |j: u32| -> Result<u64> { Ok(invoke(&registry, "clr-admin", &["epoch", "--jurisdiction", &j.to_string()])?.0.trim_matches('"').parse()?) };

    // People: Ada (Lagos, tier 1), Kofi (Accra, tier 1), Bob (Lagos).
    let secret = |n: u64| s((run << 8) + n);
    let mk = |alias: &str, n: u64, j: u32, usd: u64| -> Result<Person> {
        let a = account(alias, usd, &d)?;
        Ok(Person { id: secret(n), jurisdiction: j, tier: 1, account: Address::from_string(&SString::from_str(&env, &a)) })
    };
    let ada = mk("clr-ada", 1, NG, 100)?;
    let kofi = mk("clr-kofi", 2, GH, 0)?;
    let bob = mk("clr-bob", 3, NG, 0)?;
    for (p, list, op, k) in [(&ada, &lists[0], "clr-ng", 0usize), (&kofi, &lists[1], "clr-gh", 1)] {
        let leaf = tier_leaf(p.id, p.jurisdiction, p.tier);
        invoke(list, op, &["insert_leaf", "--leaf", &dec(leaf)])?;
        m.id_leaves[k].1 = tree_leaves(list, start)?;
        ensure!(m.id_leaves[k].1.contains(&leaf), "leaf not on chain");
        ensure!(chain_root(list)? == circuits::test::utils::merkle_tree::merkle_root_padded(&m.id_leaves[k].1, ID_LEVELS as usize), "allow-list root parity");
    }

    let mut report = Vec::new();
    let mut pay = |m: &mut Mirror, label: &str, who: &Person, alias: &str, spend: &[OwnedNote], to: (ark_bn254::Fr, u64), dep: u64, wd: u64, rp: &Pack, ops: &[(usize, ark_bn254::Fr)]| -> Result<(usize, Payment)> {
        let e = epoch(who.jurisdiction)?;
        let p = m.payment(who, spend, to, dep, wd, rp, &who.account, e);
        let t0 = std::time::Instant::now();
        let proof = m.prove(&p)?;
        let proving_ms = t0.elapsed().as_millis();
        let who_addr = addr(alias)?;
        let (_, err) = invoke(&pool, alias, &["transact", "--proof", &proof_json(&proof).to_string(), "--ext_data", &ext_json(&p.ext, &who_addr).to_string(), "--sender", &who_addr])?;
        let hash = tx_hash(&err).context("tx hash in CLI output")?;
        let records = sync(m, &pool, &budget_tree, &lists, start)?;
        ensure!(chain_root(&pool)? == circuits::test::utils::merkle_tree::PrefixTree::new(&m.notes, POOL_LEVELS as usize).root(), "note root parity after {label}");
        ensure!(chain_root(&budget_tree)? == circuits::test::utils::merkle_tree::merkle_root_padded(&m.budget_leaves, BUDGET_LEVELS as usize), "budget root parity after {label}");
        let ours: Vec<ark_bn254::Fr> = proof.record_r.iter().map(|x| from_u256(&x)).collect();
        let rec = records.iter().find(|r| r.r == ours).context("our sealed_record event on chain")?;
        let first = m.notes.iter().position(|c| *c == from_u256(&proof.output_commitment0)).context("our note on chain")?;
        let mut opened = Vec::new();
        for (k, dk) in ops {
            let (idc, rcv, sent, flag) = open_record(rec, *k, *dk);
            ensure!(idc == id_commitment(who.id) && rcv == to.0 && sent == to.1 + wd, "record {k} of {label} opened wrong");
            opened.push(json!({"record": k, "sent_usd": sent as f64 / USD as f64, "travel_rule_flag": flag}));
        }
        // Fee as the network charged it (Horizon).
        let fee = Command::new("curl").args(["-s", &format!("https://horizon-testnet.stellar.org/transactions/{hash}")]).output().ok()
            .and_then(|o| serde_json::from_slice::<Value>(&o.stdout).ok())
            .and_then(|v| v["fee_charged"].as_str().and_then(|f| f.parse::<u64>().ok()));
        println!("{label}: tx {hash} proving {proving_ms} ms fee {fee:?} stroops");
        report.push(json!({"step": label, "tx": hash, "explorer": format!("https://stellar.expert/explorer/testnet/tx/{hash}"), "proving_ms": proving_ms, "fee_charged_stroops": fee, "opened_by_operators": opened}));
        Ok((first, p))
    };

    let (i, p) = pay(&mut m, "Ada funds 25 CLRUSD (NG)", &ada, "clr-ada", &[], (ada.receive_key(), 0), 25 * USD, 0, &ng, &[(0, d_ng)])?;
    let note = OwnedNote { index: i + 1, ..p.change };
    let (i, p) = pay(&mut m, "Ada pays Bob 15 (NG -> NG)", &ada, "clr-ada", &[note], (bob.receive_key(), 15 * USD), 0, 0, &ng, &[(0, d_ng), (1, d_ng)])?;
    let note = OwnedNote { index: i + 1, ..p.change };
    let (i, p) = pay(&mut m, "Ada pays Kofi 3 (NG -> GH)", &ada, "clr-ada", &[note], (kofi.receive_key(), 3 * USD), 0, 0, &gh, &[(0, d_ng), (1, d_gh)])?;
    let kofi_note = OwnedNote { amount: p.sent_note.1, blinding: p.sent_note.2, index: i };
    pay(&mut m, "Kofi withdraws 3 (GH)", &kofi, "clr-kofi", &[kofi_note], (kofi.receive_key(), 0), 0, 3 * USD, &gh, &[(0, d_gh)])?;

    // Ada's budget, from the chain: 18 of 31.25 USD.
    let (_, spent, _) = m.budget_state(&ada, epoch(NG)?);
    ensure!(spent == 18 * USD, "budget {spent}");
    let out = json!({"network": "testnet", "pool": pool, "ranAt": run, "steps": report, "adaSpentTodayUsd": spent as f64 / USD as f64});
    std::fs::write(root().join("deployments/testnet-demo.json"), serde_json::to_string_pretty(&out)? + "\n")?;
    Ok(())
}

fn parse_dec(s: &str) -> ark_bn254::Fr {
    use ark_ff::PrimeField;
    let n: num_bigint::BigUint = s.trim().trim_matches('"').parse().expect("decimal");
    ark_bn254::Fr::from_be_bytes_mod_order(&n.to_bytes_be())
}
fn parse_hex(s: &str) -> ark_bn254::Fr {
    use ark_ff::PrimeField;
    let n = num_bigint::BigUint::parse_bytes(s.trim_start_matches("0x").as_bytes(), 16).expect("hex");
    ark_bn254::Fr::from_be_bytes_mod_order(&n.to_bytes_be())
}
