//! Clearance crypto and prover, compiled to WebAssembly for the SDK.
//!
//! Every field element crosses the JS boundary as a decimal string. Hashes
//! follow the circuits in circuits/src exactly; they are the same functions
//! the end-to-end and testnet runs use (e2e/src/tests/world.rs), and the
//! parity tests in `packages/sdk` check them against those runs' values.
#![allow(clippy::arithmetic_side_effects)] // field arithmetic

use ark_bn254::Fr as Scalar;
use ark_ff::{BigInteger, PrimeField};
use circuits::core::merkle::{PrefixTree, merkle_proof_padded, merkle_root_padded};
use num_bigint::BigUint;
use stellar_private_payments::zk::{
    babyjub::{base8, mul8, point_from_coords, point_to_coords, scalar_mul},
    prover::Prover as SppProver,
};
use taceo_poseidon2::bn254::{t2, t3, t4};
use wasm_bindgen::prelude::*;

fn err(e: impl core::fmt::Display) -> JsError {
    JsError::new(&e.to_string())
}
fn sc(s: &str) -> Result<Scalar, JsError> {
    let n: BigUint = s.trim().parse().map_err(|_| err(format!("not a decimal field element: {s}")))?;
    Ok(Scalar::from_be_bytes_mod_order(&n.to_bytes_be()))
}
fn st(x: Scalar) -> String {
    BigUint::from_bytes_be(&x.into_bigint().to_bytes_be()).to_string()
}
fn scs(v: &[String]) -> Result<Vec<Scalar>, JsError> {
    v.iter().map(|s| sc(s)).collect()
}

// ---------------- Poseidon2, as in circuits/src/poseidon2 ----------------

/// Poseidon2(a, b; dom): t=3 permutation over [a, b, dom], lane 0.
#[wasm_bindgen]
pub fn hash2(a: &str, b: &str, dom: u32) -> Result<String, JsError> {
    Ok(st(t3::permutation(&[sc(a)?, sc(b)?, Scalar::from(dom)])[0]))
}

/// Poseidon2(a, b, c; dom): t=4 permutation over [a, b, c, dom], lane 0.
#[wasm_bindgen]
pub fn hash3(a: &str, b: &str, c: &str, dom: u32) -> Result<String, JsError> {
    Ok(st(t4::permutation(&[sc(a)?, sc(b)?, sc(c)?, Scalar::from(dom)])[0]))
}

/// Merkle node: Poseidon2 compression (t=2 permutation + feed-forward, lane 0).
#[wasm_bindgen]
pub fn compress(left: &str, right: &str) -> Result<String, JsError> {
    let (l, r) = (sc(left)?, sc(right)?);
    Ok(st(t2::permutation(&[l, r])[0] + l))
}

// ---------------- Merkle trees (as the contracts build them) ----------------

/// Root of the pool's note tree (upstream MerkleTreeWithHistory).
#[wasm_bindgen(js_name = noteTreeRoot)]
pub fn note_tree_root(leaves: Vec<String>, depth: usize) -> Result<String, JsError> {
    Ok(st(PrefixTree::new(&scs(&leaves)?, depth).root()))
}

/// Path of leaf `index` in the note tree: [bits, sibling_0, ..., sibling_{depth-1}].
#[wasm_bindgen(js_name = noteTreeProof)]
pub fn note_tree_proof(leaves: Vec<String>, index: usize, depth: usize) -> Result<Vec<String>, JsError> {
    let (path, bits) = PrefixTree::new(&scs(&leaves)?, depth).proof(index);
    Ok(core::iter::once(bits.to_string()).chain(path.into_iter().map(st)).collect())
}

/// Root of an asp-membership tree (allow-lists, budget tree).
#[wasm_bindgen(js_name = listTreeRoot)]
pub fn list_tree_root(leaves: Vec<String>, depth: usize) -> Result<String, JsError> {
    Ok(st(merkle_root_padded(&scs(&leaves)?, depth)))
}

/// Path in an asp-membership tree: [bits, sibling_0, ..., sibling_{depth-1}].
#[wasm_bindgen(js_name = listTreeProof)]
pub fn list_tree_proof(leaves: Vec<String>, index: usize, depth: usize) -> Result<Vec<String>, JsError> {
    let (path, bits) = merkle_proof_padded(&scs(&leaves)?, index, depth);
    Ok(core::iter::once(bits.to_string()).chain(path.into_iter().map(st)).collect())
}

// ---------------- Baby JubJub: operator keys and sealed records ----------------

/// Operator public key D = d * BASE8, as [x, y].
#[wasm_bindgen(js_name = operatorPublicKey)]
pub fn operator_public_key(d: &str) -> Result<Vec<String>, JsError> {
    let p = scalar_mul(base8(), sc(d)?).ok_or_else(|| err("bad scalar"))?;
    let (x, y) = point_to_coords(p);
    Ok(vec![st(x), st(y)])
}

/// Open a sealed record (R, c1..c3) with operator private key d.
/// Returns [idCommitment, receiverPubKey, 2*sent + travelRuleFlag].
#[wasm_bindgen(js_name = openRecord)]
pub fn open_record(rx: &str, ry: &str, c1: &str, c2: &str, c3: &str, d: &str) -> Result<Vec<String>, JsError> {
    let r = point_from_coords(sc(rx)?, sc(ry)?);
    let s = mul8(scalar_mul(r, sc(d)?).ok_or_else(|| err("bad point"))?).ok_or_else(|| err("bad point"))?;
    let (sx, sy) = point_to_coords(s);
    let k = t4::permutation(&[sx, sy, Scalar::from(0u64), Scalar::from(6u64)]);
    Ok(vec![st(sc(c1)? - k[0]), st(sc(c2)? - k[1]), st(sc(c3)? - k[2])])
}

// ---------------- Groth16 prover ----------------

/// Groth16 prover for clearance_tx_2_2 (upstream's prover, arkworks).
#[wasm_bindgen]
pub struct Prover(SppProver);

#[wasm_bindgen]
impl Prover {
    /// `pk`: compressed arkworks proving key (testdata/clearance_tx_2_2_proving_key.bin),
    /// `r1cs`: circom R1CS of the circuit.
    #[wasm_bindgen(constructor)]
    pub fn new(pk: &[u8], r1cs: &[u8]) -> Result<Prover, JsError> {
        SppProver::new(pk, r1cs).map(Prover).map_err(err)
    }

    /// `witness`: the full witness, 32-byte little-endian field elements.
    /// Returns the proof in Soroban encoding (A 64 || B 128 || C 64 bytes).
    pub fn prove(&self, witness: &[u8]) -> Result<Vec<u8>, JsError> {
        self.0.prove_bytes_uncompressed(witness).map_err(err)
    }

    /// Public signals of the witness, as decimal strings, in circuit order.
    #[wasm_bindgen(js_name = publicSignals)]
    pub fn public_signals(&self, witness: &[u8]) -> Result<Vec<String>, JsError> {
        let bytes = self.0.extract_public_inputs(witness).map_err(err)?;
        Ok(bytes.chunks(32).map(|c| st(Scalar::from_le_bytes_mod_order(c))).collect())
    }
}
