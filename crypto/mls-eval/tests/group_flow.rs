use openmls::prelude::*;
use openmls_basic_credential::SignatureKeyPair;
use openmls_libcrux_crypto::Provider;

const SUITE: Ciphersuite = Ciphersuite::MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519;

fn credential(provider: &Provider, name: &[u8]) -> (BasicCredential, SignatureKeyPair) {
    let credential = BasicCredential::new(name.to_vec());
    let signer = SignatureKeyPair::new(SUITE.signature_algorithm()).unwrap();
    signer.store(provider.storage()).unwrap();
    (credential, signer)
}

fn key_package(provider: &Provider, name: &[u8]) -> (KeyPackageBundle, SignatureKeyPair) {
    let (credential, signer) = credential(provider, name);
    let kp = KeyPackage::builder()
        .build(
            SUITE,
            provider,
            &signer,
            CredentialWithKey {
                credential: credential.into(),
                signature_key: signer.public().into(),
            },
        )
        .unwrap();
    (kp, signer)
}

#[test]
fn private_add_commit_and_removal_flow() {
    let alice_provider = Provider::new().unwrap();
    let bob_provider = Provider::new().unwrap();
    let carol_provider = Provider::new().unwrap();
    let (alice_credential, alice_signer) = credential(&alice_provider, b"group-actor-alice");
    let (bob_kp, _bob_signer) = key_package(&bob_provider, b"group-actor-bob");
    let (carol_kp, _carol_signer) = key_package(&carol_provider, b"group-actor-carol");

    let mut alice = MlsGroup::builder()
        .ciphersuite(SUITE)
        .use_ratchet_tree_extension(true)
        .build(
            &alice_provider,
            &alice_signer,
            CredentialWithKey {
                credential: alice_credential.into(),
                signature_key: alice_signer.public().into(),
            },
        )
        .unwrap();
    let (_add, bob_welcome, _) = alice
        .add_members(
            &alice_provider,
            &alice_signer,
            &[bob_kp.key_package().clone()],
        )
        .unwrap();
    alice.merge_pending_commit(&alice_provider).unwrap();
    let (carol_add, carol_welcome, _) = alice
        .add_members(
            &alice_provider,
            &alice_signer,
            &[carol_kp.key_package().clone()],
        )
        .unwrap();
    alice.merge_pending_commit(&alice_provider).unwrap();

    let bob_welcome: MlsMessageIn = bob_welcome.into();
    let bob_welcome = bob_welcome.into_welcome().unwrap();
    let mut bob = StagedWelcome::new_from_welcome(
        &bob_provider,
        &MlsGroupJoinConfig::default(),
        bob_welcome,
        None,
    )
    .unwrap()
    .into_group(&bob_provider)
    .unwrap();
    let carol_welcome: MlsMessageIn = carol_welcome.into();
    let carol_welcome = carol_welcome.into_welcome().unwrap();
    let mut carol = StagedWelcome::new_from_welcome(
        &carol_provider,
        &MlsGroupJoinConfig::default(),
        carol_welcome,
        None,
    )
    .unwrap()
    .into_group(&carol_provider)
    .unwrap();

    // Bob must process the second add commit to share Alice's current epoch.
    let carol_add: MlsMessageIn = carol_add.into();
    let carol_add = carol_add.into_protocol_message().unwrap();
    let bob_add = bob.process_message(&bob_provider, carol_add).unwrap();
    let ProcessedMessageContent::StagedCommitMessage(bob_add) = bob_add.into_content() else {
        panic!("expected Bob to stage Carol's add commit");
    };
    bob.merge_staged_commit(&bob_provider, *bob_add).unwrap();

    let before = alice
        .create_message(&alice_provider, &alice_signer, b"before removal")
        .unwrap();
    let before: MlsMessageIn = before.into();
    let before = before.into_protocol_message().unwrap();
    let bob_before = bob.process_message(&bob_provider, before.clone()).unwrap();
    let carol_before = carol.process_message(&carol_provider, before).unwrap();
    match bob_before.into_content() {
        ProcessedMessageContent::ApplicationMessage(app) => {
            assert_eq!(app.into_bytes(), b"before removal")
        }
        other => panic!("expected Bob application message, got {other:?}"),
    }
    match carol_before.into_content() {
        ProcessedMessageContent::ApplicationMessage(app) => {
            assert_eq!(app.into_bytes(), b"before removal")
        }
        other => panic!("expected Carol application message, got {other:?}"),
    }

    let bob_index = alice
        .members()
        .find(|m| m.credential.serialized_content() == b"group-actor-bob")
        .unwrap()
        .index;
    let (remove, _, _) = alice
        .remove_members(&alice_provider, &alice_signer, &[bob_index])
        .unwrap();
    alice.merge_pending_commit(&alice_provider).unwrap();
    let remove: MlsMessageIn = remove.into();
    let remove = remove.into_protocol_message().unwrap();
    let processed_remove = carol.process_message(&carol_provider, remove).unwrap();
    let ProcessedMessageContent::StagedCommitMessage(processed_remove) =
        processed_remove.into_content()
    else {
        panic!("expected Carol to stage Bob's removal commit");
    };
    carol
        .merge_staged_commit(&carol_provider, *processed_remove)
        .unwrap();

    let after = alice
        .create_message(&alice_provider, &alice_signer, b"after removal")
        .unwrap();
    let after: MlsMessageIn = after.into();
    let after = after.into_protocol_message().unwrap();
    let carol_after = carol
        .process_message(&carol_provider, after.clone())
        .unwrap();
    match carol_after.into_content() {
        ProcessedMessageContent::ApplicationMessage(app) => {
            assert_eq!(app.into_bytes(), b"after removal")
        }
        other => panic!("expected Carol post-removal application message, got {other:?}"),
    }
    assert!(
        bob.process_message(&bob_provider, after).is_err(),
        "removed member cannot decrypt current epoch application data"
    );
}
