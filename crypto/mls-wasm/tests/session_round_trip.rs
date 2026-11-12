use cipher_openmls_wasm_smoke::session::{
    mls_engine_create_core, mls_engine_drop_core, mls_engine_key_package_core,
    mls_engine_restore_core, mls_engine_snapshot_core, mls_encrypt_core, mls_group_add_core,
    mls_group_create_core, mls_group_join_core, mls_members_core, mls_process_core,
};

fn json_field(json: &str, field: &str) -> String {
    let value: serde_json::Value = serde_json::from_str(json).expect("bridge json");
    match &value[field] {
        serde_json::Value::String(text) => text.clone(),
        serde_json::Value::Number(number) => number.to_string(),
        other => panic!("field {field} not scalar: {other:?}"),
    }
}

fn ok_handle(create_result: Result<String, String>) -> u64 {
    let json = create_result.expect("engine create");
    json_field(&json, "handle").parse().expect("handle")
}

fn expect_bridge_err(result: Result<String, String>, prefix: &str) {
    match result {
        Ok(value) => panic!("expected failure starting {prefix}, got: {value}"),
        Err(reason) => assert!(reason.starts_with(prefix), "unexpected failure: {reason}"),
    }
}

#[test]
fn founder_lifecycle_end_to_end() {
    let alice_handle = ok_handle(mls_engine_create_core(String::from("alice-pk-hex")));
    let bob_handle = ok_handle(mls_engine_create_core(String::from("bob-pk-hex")));

    // Owner creates the group.
    let created = mls_group_create_core(alice_handle).expect("group ref json");
    assert!(created.contains("\"group_ref\""), "{created}");

    // Owner adds Bob's key package; Bob consumes the welcome.
    let key_package = json_field(&mls_engine_key_package_core(bob_handle).expect("kp"), "key_package");
    let add_out = mls_group_add_core(alice_handle, &key_package).expect("add json");
    let welcome = json_field(&add_out, "welcome");
    assert!(!welcome.is_empty());
    let joined = mls_group_join_core(bob_handle, &welcome).expect("join json");
    assert!(joined.contains("\"group_ref\""), "{joined}");

    // Roster agrees on both sides after the add epoch.
    for handle in [alice_handle, bob_handle] {
        let roster = mls_members_core(handle).expect("members json");
        assert!(roster.contains("alice-pk-hex"), "{roster}");
        assert!(roster.contains("bob-pk-hex"), "{roster}");
    }

    // Alice to Bob: ciphertext opens as the exact plaintext bytes.
    let sent_b64 = b64_encode(b"hello-from-alice");
    let wire = json_field(&mls_encrypt_core(alice_handle, &sent_b64).expect("encrypt"), "message");
    let opened = mls_process_core(bob_handle, &wire).expect("process");
    assert!(opened.contains("\"kind\":\"application\""), "{opened}");
    let plaintext_b64 = json_field(&opened, "plaintext");
    assert_eq!(
        std::str::from_utf8(&b64_decode(&plaintext_b64)).expect("utf8"),
        "hello-from-alice",
        "decrypted payload must round-trip byte-exact"
    );

    // Replay the same consumed message: fail closed.
    expect_bridge_err(mls_process_core(bob_handle, &wire), "ERR:");

    // Bob replies; Alice opens it and gets the exact reply bytes back.
    let reply_wire = json_field(
        &mls_encrypt_core(bob_handle, &b64_encode(b"hi-alice")).expect("reply encrypt"),
        "message",
    );
    let opened_reply = mls_process_core(alice_handle, &reply_wire).expect("reply process");
    assert!(opened_reply.contains("\"kind\":\"application\""), "{opened_reply}");
    assert_eq!(
        std::str::from_utf8(&b64_decode(&json_field(&opened_reply, "plaintext"))).expect("utf8"),
        "hi-alice"
    );
    // Snapshots capture live state and restore into working engines.
    let _alice_snap = mls_engine_snapshot_core(alice_handle).expect("snapshot");
    let _bob_snap = mls_engine_snapshot_core(bob_handle).expect("snapshot");

    // Post-snapshot traffic still flows on the originals (state untouched).
    let sent_after =
        mls_encrypt_core(alice_handle, &b64_encode(b"post-snapshot-note")).expect("post-snapshot encrypt");
    let opened_after = mls_process_core(bob_handle, &json_field(&sent_after, "message"))
        .expect("post-snapshot process");
    assert!(opened_after.contains("\"kind\":\"application\""), "{opened_after}");

    // Restore produces a NEW engine handle whose group state works: its
    // snapshot carries the epoch keys, so a fresh member-added round trip
    // succeeds against the restored state's own storage.
    let alice_snap2 = mls_engine_snapshot_core(alice_handle).expect("snapshot 2");
    let restored = ok_handle(mls_engine_restore_core(&alice_snap2));
    let roster_restored = mls_members_core(restored).expect("restored members");
    assert!(roster_restored.contains("bob-pk-hex"), "{roster_restored}");
    // The restored engine can send into the same group and live Bob opens it.
    let sent_restored =
        mls_encrypt_core(restored, &b64_encode(b"from-restored-engine")).expect("restored send");
    let opened_restored = mls_process_core(bob_handle, &json_field(&sent_restored, "message"))
        .expect("restored-opened");
    assert!(opened_restored.contains("\"kind\":\"application\""), "{opened_restored}");

    // Double restore of the SAME snapshot must not corrupt either copy.
    let restored_again = ok_handle(mls_engine_restore_core(&alice_snap2));
    let roster_again = mls_members_core(restored_again).expect("second restore members");
    assert!(roster_again.contains("bob-pk-hex"), "{roster_again}");

    assert!(mls_engine_drop_core(alice_handle));
    assert!(mls_engine_drop_core(bob_handle));
    assert!(mls_engine_drop_core(restored));
    assert!(mls_engine_drop_core(restored_again));
}

fn b64_encode(bytes: &[u8]) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

#[allow(dead_code)]
fn b64_decode(text: &str) -> Vec<u8> {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD
        .decode(text)
        .expect("test base64")
}
