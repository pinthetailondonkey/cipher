//! Pinned IETF/OpenMLS 0.9.2 test-vector aggregate run (plan item 18).
//!
//! Every family must report exactly its vendored count as CHECKED, except the
//! two families whose OpenMLS 0.9.2 symbols are crate-private (secret-tree,
//! treekem), which must report SKIPPED loudly with a reason.

use cipher_openmls_wasm_smoke::{run_all_pinned_vector_families, FamilyResult};

fn expected_counts() -> Vec<(&'static str, usize)> {
    vec![
        ("welcome", 1),
        ("transcript-hashes", 100),
        ("key-schedule", 1),
        ("messages", 100),
        ("psk_secret", 10),
        ("passive-client-welcome", 8),
    ]
}

#[test]
fn run_ietf_mls_pinned_vectors() {
    let results: Vec<FamilyResult> = run_all_pinned_vector_families()
        .unwrap_or_else(|e| panic!("pinned vector run failed: {e}"));

    let mut by_name = results
        .iter()
        .map(|r| (r.family, r))
        .collect::<std::collections::BTreeMap<_, _>>();

    // Every runnable family checked == vendored count and skipped == 0.
    for (family, count) in expected_counts() {
        let r = by_name
            .remove(family)
            .unwrap_or_else(|| panic!("missing family result for {family}"));
        assert_eq!(r.checked, count, "family {family}: wrong checked count");
        assert_eq!(r.skipped, 0, "family {family}: unexpected skips");
        assert!(
            r.skip_reason.is_none(),
            "family {family}: unexpected skip reason {:?}",
            r.skip_reason
        );
    }

    // Crate-private families must be skipped LOUDLY with reasons.
    for family in ["secret-tree", "treekem"] {
        let r = by_name
            .remove(family)
            .unwrap_or_else(|| panic!("missing family result for {family}"));
        assert!(r.skip_reason.is_some(), "family {family} must state its skip reason");
        let counted = r.checked + r.skipped;
        assert!(counted > 0, "family {family}: no vectors counted at all");
    }

    assert!(
        by_name.is_empty(),
        "unexpected extra families: {:?}",
        by_name.keys().collect::<Vec<_>>()
    );
}
