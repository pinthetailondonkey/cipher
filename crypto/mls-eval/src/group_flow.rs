use openmls::prelude::*;
use openmls_basic_credential::SignatureKeyPair;
use openmls_libcrux_crypto::CryptoProvider;
use openmls_memory_storage::MemoryStorage;
use openmls_traits::OpenMlsProvider;
use openmls_traits::storage::StorageProvider;
use std::io::Cursor;

const SUITE: Ciphersuite = Ciphersuite::MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519;

struct EvalProvider {
    crypto: CryptoProvider,
    storage: MemoryStorage,
}

impl EvalProvider {
    fn new() -> Self {
        Self {
            crypto: CryptoProvider::new().unwrap(),
            storage: MemoryStorage::default(),
        }
    }

    fn fork(&self) -> Self {
        let mut snapshot = Vec::new();
        self.storage.serialize(&mut snapshot).unwrap();
        Self {
            crypto: CryptoProvider::new().unwrap(),
            storage: MemoryStorage::deserialize(&mut Cursor::new(snapshot)).unwrap(),
        }
    }
}

impl OpenMlsProvider for EvalProvider {
    type CryptoProvider = CryptoProvider;
    type RandProvider = CryptoProvider;
    type StorageProvider = MemoryStorage;

    fn storage(&self) -> &Self::StorageProvider {
        &self.storage
    }

    fn crypto(&self) -> &Self::CryptoProvider {
        &self.crypto
    }

    fn rand(&self) -> &Self::RandProvider {
        &self.crypto
    }
}

fn credential(provider: &EvalProvider, name: &[u8]) -> (BasicCredential, SignatureKeyPair) {
    let credential = BasicCredential::new(name.to_vec());
    let signer = SignatureKeyPair::new(SUITE.signature_algorithm()).unwrap();
    signer.store(provider.storage()).unwrap();
    (credential, signer)
}

fn key_package(provider: &EvalProvider, name: &[u8]) -> (KeyPackageBundle, SignatureKeyPair) {
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

fn accept_welcome_transactionally(
    provider: &mut EvalProvider,
    config: &MlsGroupJoinConfig,
    welcome: Welcome,
    ratchet_tree: Option<RatchetTreeIn>,
) -> Result<MlsGroup, String> {
    let candidate = provider.fork();
    let staged = StagedWelcome::new_from_welcome(&candidate, config, welcome, ratchet_tree)
        .map_err(|error| format!("{error:?}"))?;
    let group = staged
        .into_group(&candidate)
        .map_err(|error| format!("{error:?}"))?;
    // Commit the candidate only after the group has been fully accepted and
    // stored. A failed stage or conversion discards the consumed KeyPackage.
    provider.storage = candidate.storage;
    Ok(group)
}

fn welcome_for(key_package: &KeyPackageBundle, include_ratchet_tree: bool) -> Welcome {
    let provider = EvalProvider::new();
    let (credential, signer) = credential(&provider, b"group-actor-owner");
    let mut group = MlsGroup::builder()
        .ciphersuite(SUITE)
        .use_ratchet_tree_extension(include_ratchet_tree)
        .build(
            &provider,
            &signer,
            CredentialWithKey {
                credential: credential.into(),
                signature_key: signer.public().into(),
            },
        )
        .unwrap();
    let (_, welcome, _) = group
        .add_members(&provider, &signer, &[key_package.key_package().clone()])
        .unwrap();
    group.merge_pending_commit(&provider).unwrap();
    match MlsMessageIn::from(welcome).extract() {
        openmls::framing::MlsMessageBodyIn::Welcome(welcome) => welcome,
        _ => panic!("expected Welcome message"),
    }
}

fn failed_welcome_retry_preserves_one_time_key() -> bool {
    let join_config = MlsGroupJoinConfig::default();

    // Reproduce OpenMLS 0.9.2's behavior without an application transaction:
    // the invalid Welcome fails after the KeyPackage has been deleted.
    let vulnerable_joiner = EvalProvider::new();
    let (vulnerable_key_package, _) = key_package(&vulnerable_joiner, b"group-actor-vulnerable");
    let vulnerable_key_package_ref = vulnerable_key_package
        .key_package()
        .hash_ref(vulnerable_joiner.crypto())
        .unwrap();
    let invalid_welcome = welcome_for(&vulnerable_key_package, false);
    let valid_welcome = welcome_for(&vulnerable_key_package, true);
    let error = match StagedWelcome::new_from_welcome(
        &vulnerable_joiner,
        &join_config,
        invalid_welcome,
        None,
    ) {
        Ok(_) => panic!("Welcome without a ratchet tree should fail closed"),
        Err(error) => format!("{error:?}"),
    };
    assert!(
        error.contains("MissingRatchetTree"),
        "unexpected failure: {error}"
    );
    assert!(
        vulnerable_joiner
            .storage()
            .key_package::<_, KeyPackageBundle>(&vulnerable_key_package_ref)
            .unwrap()
            .is_none(),
        "the pinned upstream path reproduces KeyPackage consumption on failed Welcome staging"
    );
    let retry_error = match StagedWelcome::new_from_welcome(
        &vulnerable_joiner,
        &join_config,
        valid_welcome,
        None,
    ) {
        Ok(_) => panic!("the direct upstream retry should fail after its key was consumed"),
        Err(error) => format!("{error:?}"),
    };
    assert!(
        retry_error.contains("NoMatchingKeyPackage"),
        "unexpected retry result: {retry_error}"
    );

    // A copy-on-write application transaction discards the failed candidate.
    let mut joiner = EvalProvider::new();
    let (key_package, _) = key_package(&joiner, b"group-actor-transactional");
    let key_package_ref = key_package.key_package().hash_ref(joiner.crypto()).unwrap();
    let invalid_welcome = welcome_for(&key_package, false);
    let valid_welcome = welcome_for(&key_package, true);
    let error =
        match accept_welcome_transactionally(&mut joiner, &join_config, invalid_welcome, None) {
            Ok(_) => panic!("Welcome without a ratchet tree should fail closed"),
            Err(error) => error,
        };
    assert!(
        error.contains("MissingRatchetTree"),
        "unexpected transactional failure: {error}"
    );
    let _group = accept_welcome_transactionally(&mut joiner, &join_config, valid_welcome, None)
        .expect("a later valid Welcome using the retained key must succeed");
    assert!(
        joiner
            .storage()
            .key_package::<_, KeyPackageBundle>(&key_package_ref)
            .unwrap()
            .is_none(),
        "successful Welcome acceptance consumes the one-time KeyPackage"
    );
    true
}

fn conflicting_commit_from_stale_epoch_is_rejected(
    alice_provider: &EvalProvider,
    alice_signer: &SignatureKeyPair,
    alice: &MlsGroup,
    carol_provider: &EvalProvider,
) -> bool {
    let group_id = alice.group_id().clone();
    let branch_a_provider = alice_provider.fork();
    let branch_b_provider = alice_provider.fork();
    let mut branch_a = MlsGroup::load(branch_a_provider.storage(), &group_id)
        .unwrap()
        .unwrap();
    let mut branch_b = MlsGroup::load(branch_b_provider.storage(), &group_id)
        .unwrap()
        .unwrap();

    let bob_index = branch_a
        .members()
        .find(|member| member.credential.serialized_content() == b"group-actor-bob")
        .unwrap()
        .index;
    let (remove_bob, _, _) = branch_a
        .remove_members(&branch_a_provider, alice_signer, &[bob_index])
        .unwrap();
    branch_a.merge_pending_commit(&branch_a_provider).unwrap();

    let eve_provider = EvalProvider::new();
    let (eve_key_package, _) = key_package(&eve_provider, b"group-actor-eve");
    let (add_eve, _, _) = branch_b
        .add_members(
            &branch_b_provider,
            alice_signer,
            &[eve_key_package.key_package().clone()],
        )
        .unwrap();
    branch_b.merge_pending_commit(&branch_b_provider).unwrap();

    // Carol accepts one of the two commits built from the same stored epoch.
    // When the relay later presents the competing branch, its prior epoch no
    // longer matches and OpenMLS refuses the message.
    let reader_provider = carol_provider.fork();
    let mut reader = MlsGroup::load(reader_provider.storage(), &group_id)
        .unwrap()
        .unwrap();
    let add_eve: MlsMessageIn = add_eve.into();
    let add_eve = add_eve.try_into_protocol_message().unwrap();
    let staged = reader.process_message(&reader_provider, add_eve).unwrap();
    let ProcessedMessageContent::StagedCommitMessage(staged) = staged.into_content() else {
        panic!("expected the first concurrent commit to stage");
    };
    reader
        .merge_staged_commit(&reader_provider, *staged)
        .unwrap();

    let remove_bob: MlsMessageIn = remove_bob.into();
    let remove_bob = remove_bob.try_into_protocol_message().unwrap();
    assert!(
        reader
            .process_message(&reader_provider, remove_bob)
            .is_err(),
        "a conflicting commit from a stale epoch must not roll back the accepted branch"
    );
    true
}

const GOVERNANCE_BINDING_EXTENSION: u16 = 0xffca;

fn governance_binding(revision: u64, document_hash: [u8; 32]) -> Vec<u8> {
    let mut payload = b"cipher-mls-governance-binding-v1".to_vec();
    payload.extend_from_slice(&revision.to_be_bytes());
    payload.extend_from_slice(&document_hash);
    payload
}

fn governance_binding_extensions(payload: Vec<u8>) -> Extensions<GroupContext> {
    let required = Extension::RequiredCapabilities(RequiredCapabilitiesExtension::new(
        &[ExtensionType::Unknown(GOVERNANCE_BINDING_EXTENSION)],
        &[],
        &[],
    ));
    Extensions::from_vec(vec![
        Extension::Unknown(GOVERNANCE_BINDING_EXTENSION, UnknownExtension(payload)),
        required,
    ])
    .unwrap()
}

fn held_governance_binding(
    group: &MlsGroup,
    provider: &EvalProvider,
    signer: &SignatureKeyPair,
) -> Vec<u8> {
    let group_info = group
        .export_group_info(provider.crypto(), signer, false)
        .unwrap();
    let group_info: MlsMessageIn = group_info.into();
    let group_info = match group_info.extract() {
        openmls::framing::MlsMessageBodyIn::GroupInfo(group_info) => group_info,
        _ => panic!("expected signed GroupInfo"),
    };
    group_info
        .group_context()
        .extensions()
        .iter()
        .find_map(|extension| match extension {
            Extension::Unknown(GOVERNANCE_BINDING_EXTENSION, UnknownExtension(payload)) => {
                Some(payload.clone())
            }
            _ => None,
        })
        .expect("group context carries the governance binding")
}

fn authenticated_governance_binding_round_trip() -> bool {
    let owner_provider = EvalProvider::new();
    let mut bob_provider = EvalProvider::new();
    let (owner_credential, owner_signer) = credential(&owner_provider, b"group-actor-owner");
    let (bob_credential, bob_signer) = credential(&bob_provider, b"group-actor-bob");
    let required_extensions = [ExtensionType::Unknown(GOVERNANCE_BINDING_EXTENSION)];
    let capabilities = Capabilities::new(None, None, Some(&required_extensions), None, None);
    let bob_key_package = KeyPackage::builder()
        .leaf_node_capabilities(capabilities.clone())
        .build(
            SUITE,
            &bob_provider,
            &bob_signer,
            CredentialWithKey {
                credential: bob_credential.into(),
                signature_key: bob_signer.public().into(),
            },
        )
        .unwrap();

    let first_binding = governance_binding(4, [0x41; 32]);
    let mut owner = MlsGroup::builder()
        .ciphersuite(SUITE)
        .with_capabilities(capabilities)
        .with_group_context_extensions(governance_binding_extensions(first_binding.clone()))
        .build(
            &owner_provider,
            &owner_signer,
            CredentialWithKey {
                credential: owner_credential.into(),
                signature_key: owner_signer.public().into(),
            },
        )
        .unwrap();
    assert_eq!(
        held_governance_binding(&owner, &owner_provider, &owner_signer),
        first_binding
    );

    let (_, welcome, _) = owner
        .add_members(
            &owner_provider,
            &owner_signer,
            &[bob_key_package.key_package().clone()],
        )
        .unwrap();
    owner.merge_pending_commit(&owner_provider).unwrap();
    let welcome: MlsMessageIn = welcome.into();
    let welcome = match welcome.extract() {
        openmls::framing::MlsMessageBodyIn::Welcome(welcome) => welcome,
        _ => panic!("expected Bob Welcome"),
    };
    let mut bob = accept_welcome_transactionally(
        &mut bob_provider,
        &MlsGroupJoinConfig::default(),
        welcome,
        Some(owner.export_ratchet_tree().into()),
    )
    .unwrap();
    assert_eq!(
        held_governance_binding(&bob, &bob_provider, &bob_signer),
        first_binding
    );

    let next_binding = governance_binding(5, [0x52; 32]);
    let (commit, _, _) = owner
        .update_group_context_extensions(
            &owner_provider,
            governance_binding_extensions(next_binding.clone()),
            &owner_signer,
        )
        .unwrap();
    owner.merge_pending_commit(&owner_provider).unwrap();
    let commit: MlsMessageIn = commit.into();
    let commit = commit.try_into_protocol_message().unwrap();
    let staged = bob.process_message(&bob_provider, commit).unwrap();
    let ProcessedMessageContent::StagedCommitMessage(staged) = staged.into_content() else {
        panic!("expected governance-binding update commit");
    };
    bob.merge_staged_commit(&bob_provider, *staged).unwrap();
    assert_eq!(
        held_governance_binding(&owner, &owner_provider, &owner_signer),
        next_binding
    );
    assert_eq!(
        held_governance_binding(&bob, &bob_provider, &bob_signer),
        next_binding
    );
    true
}

fn two_person_exchange_and_removal() -> bool {
    let alice_provider = EvalProvider::new();
    let mut bob_provider = EvalProvider::new();
    let (alice_credential, alice_signer) = credential(&alice_provider, b"two-person-alice");
    let (bob_kp, bob_signer) = key_package(&bob_provider, b"two-person-bob");
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
    let (_, welcome, _) = alice
        .add_members(
            &alice_provider,
            &alice_signer,
            &[bob_kp.key_package().clone()],
        )
        .unwrap();
    alice.merge_pending_commit(&alice_provider).unwrap();
    let welcome: MlsMessageIn = welcome.into();
    let welcome = match welcome.extract() {
        openmls::framing::MlsMessageBodyIn::Welcome(welcome) => welcome,
        _ => panic!("expected Bob Welcome"),
    };
    let mut bob = accept_welcome_transactionally(
        &mut bob_provider,
        &MlsGroupJoinConfig::default(),
        welcome,
        Some(alice.export_ratchet_tree().into()),
    )
    .unwrap();

    let one = alice
        .create_message(&alice_provider, &alice_signer, b"two-person-one")
        .unwrap();
    let two = alice
        .create_message(&alice_provider, &alice_signer, b"two-person-two")
        .unwrap();
    let one: MlsMessageIn = one.into();
    let one = one.try_into_protocol_message().unwrap();
    let two: MlsMessageIn = two.into();
    let two = two.try_into_protocol_message().unwrap();
    let replay = one.clone();

    for (message, expected) in [
        (two, b"two-person-two".as_slice()),
        (one, b"two-person-one".as_slice()),
    ] {
        match bob
            .process_message(&bob_provider, message)
            .unwrap()
            .into_content()
        {
            ProcessedMessageContent::ApplicationMessage(app) => {
                assert_eq!(app.into_bytes(), expected)
            }
            other => panic!("expected two-person application message, got {other:?}"),
        }
    }
    assert!(
        bob.process_message(&bob_provider, replay).is_err(),
        "an already consumed two-person MLS application message cannot be replayed"
    );

    let reply = bob
        .create_message(&bob_provider, &bob_signer, b"two-person-reply")
        .unwrap();
    let reply: MlsMessageIn = reply.into();
    let reply = reply.try_into_protocol_message().unwrap();
    match alice
        .process_message(&alice_provider, reply)
        .unwrap()
        .into_content()
    {
        ProcessedMessageContent::ApplicationMessage(app) => {
            assert_eq!(app.into_bytes(), b"two-person-reply")
        }
        other => panic!("expected two-person reply, got {other:?}"),
    }

    let bob_index = alice
        .members()
        .find(|member| member.credential.serialized_content() == b"two-person-bob")
        .unwrap()
        .index;
    alice
        .remove_members(&alice_provider, &alice_signer, &[bob_index])
        .unwrap();
    alice.merge_pending_commit(&alice_provider).unwrap();
    let after = alice
        .create_message(&alice_provider, &alice_signer, b"two-person-after-removal")
        .unwrap();
    let after: MlsMessageIn = after.into();
    let after = after.try_into_protocol_message().unwrap();
    assert!(
        bob.process_message(&bob_provider, after).is_err(),
        "a removed two-person member cannot process a post-removal application message"
    );
    true
}

#[wasm_bindgen::prelude::wasm_bindgen]
pub fn private_add_commit_and_removal_flow() -> bool {
    assert!(failed_welcome_retry_preserves_one_time_key());
    assert!(authenticated_governance_binding_round_trip());
    assert!(two_person_exchange_and_removal());
    let alice_provider = EvalProvider::new();
    let mut bob_provider = EvalProvider::new();
    let mut carol_provider = EvalProvider::new();
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
    let bob_welcome = match bob_welcome.extract() {
        openmls::framing::MlsMessageBodyIn::Welcome(welcome) => welcome,
        _ => panic!("expected Bob welcome"),
    };
    let mut bob = accept_welcome_transactionally(
        &mut bob_provider,
        &MlsGroupJoinConfig::default(),
        bob_welcome,
        None,
    )
    .unwrap();
    let carol_welcome: MlsMessageIn = carol_welcome.into();
    let carol_welcome = match carol_welcome.extract() {
        openmls::framing::MlsMessageBodyIn::Welcome(welcome) => welcome,
        _ => panic!("expected Carol welcome"),
    };
    let mut carol = accept_welcome_transactionally(
        &mut carol_provider,
        &MlsGroupJoinConfig::default(),
        carol_welcome,
        None,
    )
    .unwrap();

    // Bob must process the second add commit to share Alice's current epoch.
    let carol_add: MlsMessageIn = carol_add.into();
    let carol_add = carol_add.try_into_protocol_message().unwrap();
    let bob_add = bob.process_message(&bob_provider, carol_add).unwrap();
    let ProcessedMessageContent::StagedCommitMessage(bob_add) = bob_add.into_content() else {
        panic!("expected Bob to stage Carol's add commit");
    };
    bob.merge_staged_commit(&bob_provider, *bob_add).unwrap();
    assert!(conflicting_commit_from_stale_epoch_is_rejected(
        &alice_provider,
        &alice_signer,
        &alice,
        &carol_provider,
    ));

    let before = alice
        .create_message(&alice_provider, &alice_signer, b"before removal")
        .unwrap();
    let before: MlsMessageIn = before.into();
    let before = before.try_into_protocol_message().unwrap();
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
    let remove = remove.try_into_protocol_message().unwrap();
    let replayed_remove = remove.clone();
    let processed_remove = carol.process_message(&carol_provider, remove).unwrap();
    let ProcessedMessageContent::StagedCommitMessage(processed_remove) =
        processed_remove.into_content()
    else {
        panic!("expected Carol to stage Bob's removal commit");
    };
    carol
        .merge_staged_commit(&carol_provider, *processed_remove)
        .unwrap();
    assert!(
        carol
            .process_message(&carol_provider, replayed_remove)
            .is_err(),
        "an already merged removal commit cannot be replayed"
    );

    let after = alice
        .create_message(&alice_provider, &alice_signer, b"after removal")
        .unwrap();
    let after: MlsMessageIn = after.into();
    let after = after.try_into_protocol_message().unwrap();
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
    true
}
