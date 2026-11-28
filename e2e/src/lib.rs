//! Clearance end-to-end tests: proofs from the circuit, verified and enforced
//! by the contracts. See `tests/`.
// Test-only crate: field and amount arithmetic here is on known small test
// values, as in upstream's own test modules.
#![cfg_attr(test, allow(clippy::arithmetic_side_effects, clippy::cast_precision_loss))]

#[cfg(test)]
mod tests;
