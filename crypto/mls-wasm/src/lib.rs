//! Compile-time check for the exact OpenMLS provider features evaluated by
//! the integration witness. This crate is not linked into the Cipher app.

pub use openmls;
pub use openmls_libcrux_crypto;

mod group_flow;
mod pinned_vectors;

pub use group_flow::private_add_commit_and_removal_flow;
pub mod session;

// Pinned IETF/OpenMLS 0.9.2 vector runner (plan item 18). Public so the
// npm-side runner and integration tests can execute the aggregate run.
pub use pinned_vectors::{run_all_pinned_vector_families, FamilyResult};

