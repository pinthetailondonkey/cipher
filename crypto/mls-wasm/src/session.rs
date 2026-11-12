// Real MLS session bridge for Cipher groups: one OpenMLS 0.9.2 MlsGroup per
// engine handle, held in a registry behind opaque numeric handles. The JS
// layer moves only opaque wire bytes (base64 in JSON envelopes) and opaque
// state snapshots, never MLS internals. A snapshot serializes the whole
// provider storage (ratchet tree, epochs, keypairs, key packages), which the
// app persists transactionally alongside its account data exactly like
// src/lib/mlsStateTransactions.js demands.
//
// Every fallible entry point returns Err("ERR:<machine-reason>") — stable,
// prefix-matched strings — mirroring the fail-closed discipline of
// src/lib/mlsTest/relayEnvelope.js. Nothing here best-effort accepts.
use std::collections::HashMap;
use std::io::Cursor;

use openmls::prelude::*;
use tls_codec::{Serialize as TlsSerializeTrait, Deserialize as TlsDeserializeTrait};
use openmls_basic_credential::SignatureKeyPair;
use openmls_libcrux_crypto::CryptoProvider;
use openmls_memory_storage::MemoryStorage;
use openmls_traits::OpenMlsProvider;
use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

use crate::group_flow::SUITE;

const SNAPSHOT_TAG: &str = "cipherMlsEngineSnapshot";
pub(crate) struct BridgeProvider {
    pub crypto: CryptoProvider,
    pub storage: MemoryStorage,
}

impl BridgeProvider {
    fn new() -> Self {
        Self {
            crypto: CryptoProvider::new().expect("libcrux provider"),
            storage: MemoryStorage::default(),
        }
    }

    fn from_parts(crypto: CryptoProvider, storage: MemoryStorage) -> Self {
        Self { crypto, storage }
    }
}

impl OpenMlsProvider for BridgeProvider {
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
        self.rand_provider()
    }
}

impl BridgeProvider {
    fn rand_provider(&self) -> &CryptoProvider {
        &self.crypto
    }
}

struct Engine {
    provider: BridgeProvider,
    signer: SignatureKeyPair,
    // Account-facing credential label (Cipher pubkey hex): appears in the
    // MLS member roster so JS maps leaf indexes back to accounts.
    identity_label: String,
    // The one MLS group this engine currently holds, as raw GroupId bytes.
    // None until mls_group_create or mls_group_join runs. Persisted in the
    // snapshot envelope so restore rebuilds it without reading storage.
    group_id: Option<Vec<u8>>,
}

#[derive(Serialize, Deserialize)]
struct EngineSnapshotV1 {
    v: u32,
    t: String,
    // Provider storage, serialized by MemoryStorage's own wire format.
    #[serde(with = "b64bytes")]
    storage: Vec<u8>,
    // Ed25519 MLS signature secret; restored through SignatureKeyPair::read
    // which looks it up against its stored public half.
    #[serde(with = "b64bytes")]
    signer_secret: Vec<u8>,
    #[serde(with = "b64bytes")]
    signer_public: Vec<u8>,
    identity_label: String,
    // Present once the engine holds an MLS group. Hex-free transport: base64
    // of the opaque GroupId bytes.
    group_id_b64: Option<String>,
}

mod b64bytes {
    use base64::Engine as _;
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(value: &[u8], s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&base64::engine::general_purpose::STANDARD.encode(value))
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<u8>, D::Error> {
        let text = String::deserialize(d)?;
        base64::engine::general_purpose::STANDARD
            .decode(text)
            .map_err(serde::de::Error::custom)
    }
}

fn b64(bytes: &[u8]) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn unb64(text: &str) -> Result<Vec<u8>, String> {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD
        .decode(text.trim())
        .map_err(|e| err(format!("invalid-base64:{e}")))
}

fn err(reason: impl Into<String>) -> String {
    format!("ERR:{}", reason.into())
}

fn ok_json<T: Serialize>(value: &T) -> Result<String, String> {
    serde_json::to_string(value).map_err(|e| err(format!("serialize:{e}")))
}

// Single-threaded wasm bindings state. Cross-thread access is rejected by
// wasm-bindgen's own TLS guard for #[wasm_bindgen] types; this registry is
// only touched from those entry points.
thread_local! {
    static REGISTRY: std::cell::RefCell<HashMap<u64, Engine>> = std::cell::RefCell::new(HashMap::new());
    static NEXT_HANDLE: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
}

fn next_handle() -> u64 {
    NEXT_HANDLE.with(|n| n.set(n.get() + 1));
    NEXT_HANDLE.with(|n| n.get())
}

fn with_engine<R>(handle: u64, body: impl FnOnce(&mut Engine) -> Result<R, String>) -> Result<R, String> {
    REGISTRY.with(|registry| {
        let mut registry = registry.borrow_mut();
        let engine = registry.get_mut(&handle).ok_or_else(|| err("unknown-handle"))?;
        body(engine)
    })
}

/// Fresh engine handle holding a new Ed25519 MLS signing identity for one
/// device. The label (Cipher account pubkey hex) rides on every credential.
pub fn mls_engine_create_core(identity_label: String) -> Result<String, String> {
    if identity_label.trim().is_empty() || !identity_label.chars().all(|c| c.is_ascii()) {
        return Err(err("bad-identity-label"));
    }
    if identity_label.len() > 128 {
        return Err(err("long-identity-label"));
    }
    let provider = BridgeProvider::new();
    let signer = SignatureKeyPair::new(SUITE.signature_algorithm())
        .map_err(|e| err(format!("keygen:{e:?}")))?;
    signer
        .store(provider.storage())
        .map_err(|e| err(format!("signer-store:{e:?}")))?;
    let handle = next_handle();
    REGISTRY.with(|registry| {
        registry.borrow_mut().insert(
            handle,
            Engine { provider, signer, identity_label, group_id: None },
        );
    });
    ok_json(&serde_json::json!({ "handle": handle, "scheme": "ed25519" }))
}

#[wasm_bindgen]
pub fn mls_engine_create(identity_label: String) -> Result<wasm_bindgen::JsValue, wasm_bindgen::JsValue> {
    match mls_engine_create_core(identity_label) {
        Ok(json) => Ok(wasm_bindgen::JsValue::from_str(&json)),
        Err(reason) => Err(wasm_bindgen::JsValue::from_str(&reason)),
    }
}

pub fn mls_engine_snapshot_core(handle: u64) -> Result<String, String> {
    with_engine(handle, |engine| {
        let mut storage_bytes: Vec<u8> = Vec::new();
        engine
            .provider
            .storage
            .serialize(&mut storage_bytes)
            .map_err(|e| err(format!("storage-serialize:{e:?}")))?;
        ok_json(&EngineSnapshotV1 {
            v: 1,
            t: SNAPSHOT_TAG.to_string(),
            storage: storage_bytes,
            signer_secret: engine.signer.private().to_vec(),
            signer_public: engine.signer.public().to_vec(),
            identity_label: engine.identity_label.clone(),
            group_id_b64: engine.group_id.as_deref().map(b64),
        })
    })
}

#[wasm_bindgen]
pub fn mls_engine_snapshot(handle: u64) -> Result<wasm_bindgen::JsValue, wasm_bindgen::JsValue> {
    match mls_engine_snapshot_core(handle) {
        Ok(json) => Ok(wasm_bindgen::JsValue::from_str(&json)),
        Err(reason) => Err(wasm_bindgen::JsValue::from_str(&reason)),
    }
}

pub fn mls_engine_restore_core(snapshot_json: &str) -> Result<String, String> {
    let snapshot: EngineSnapshotV1 =
        serde_json::from_str(snapshot_json).map_err(|e| err(format!("snapshot-schema:{e}")))?;
    if snapshot.t != SNAPSHOT_TAG || snapshot.v != 1 {
        return Err(err("snapshot-tag-mismatch"));
    }
    let mut cursor = Cursor::new(snapshot.storage.as_slice());
    let storage =
        MemoryStorage::deserialize(&mut cursor).map_err(|e| err(format!("storage-deser:{e:?}")))?;
    // Restore consistency: reconstruct the crypto instance and re-read the
    // signing key pair through its own storage id path so future reads hit
    // identical entries.
    let crypto = CryptoProvider::new().map_err(|e| err(format!("provider-init:{e:?}")))?;
    let signer = SignatureKeyPair::read(
        &storage,
        &snapshot.signer_public,
        SUITE.signature_algorithm(),
    )
    .ok_or_else(|| err("signer-absent-in-storage"))?;
    let group_id = match &snapshot.group_id_b64 {
        Some(text) => Some(unb64(text)?),
        None => None,
    };
    let handle = next_handle();
    REGISTRY.with(|registry| {
        registry.borrow_mut().insert(
            handle,
            Engine {
                provider: BridgeProvider::from_parts(crypto, storage),
                signer,
                identity_label: snapshot.identity_label,
                group_id,
            },
        );
    });
    ok_json(&serde_json::json!({ "handle": handle }))
}

#[wasm_bindgen]
pub fn mls_engine_restore(snapshot_json: &str) -> Result<wasm_bindgen::JsValue, wasm_bindgen::JsValue> {
    match mls_engine_restore_core(snapshot_json) {
        Ok(json) => Ok(wasm_bindgen::JsValue::from_str(&json)),
        Err(reason) => Err(wasm_bindgen::JsValue::from_str(&reason)),
    }
}

pub fn mls_engine_drop_core(handle: u64) -> bool {
    REGISTRY.with(|registry| registry.borrow_mut().remove(&handle).is_some())
}

#[wasm_bindgen]
pub fn mls_engine_drop(handle: u64) -> bool {
    mls_engine_drop_core(handle)
}

// ---------------------------------------------------------------------------
// Group operations. One engine may hold multiple groups (each Cipher device
// is a member of many group chats); every group op addresses its group by
// the opaque group_id handle it returned at creation or join time.
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize)]
struct StoredGroup {
    v: u32,
    t: String,
    #[serde(with = "b64bytes")]
    group_id: Vec<u8>,
}

const GROUP_TAG: &str = "cipherMlsGroupRef";

fn stored_group(group_id: &[u8]) -> String {
    serde_json::to_string(&StoredGroup { v: 1, t: GROUP_TAG.to_string(), group_id: group_id.to_vec() })
        .expect("stored group ref")
}

#[allow(dead_code)]
fn parse_stored_group(text: &str) -> Result<Vec<u8>, String> {
    let parsed: StoredGroup =
        serde_json::from_str(text).map_err(|e| err(format!("group-ref-schema:{e}")))?;
    if parsed.t != GROUP_TAG || parsed.v != 1 || parsed.group_id.is_empty() {
        return Err(err("group-ref-mismatch"));
    }
    Ok(parsed.group_id)
}

fn load_group(engine: &Engine, group_id_bytes: &[u8]) -> Result<MlsGroup, String> {
    let group_id = GroupId::from_slice(group_id_bytes);
    MlsGroup::load(&engine.provider.storage, &group_id)
        .map_err(|e| err(format!("group-load:{e:?}")))?
        .ok_or_else(|| err("group-not-found"))
}

/// Create a fresh MLS group this engine owns. Returns the opaque group ref
/// the JS side stores and passes back for every later operation.
pub fn mls_group_create_core(handle: u64) -> Result<String, String> {
    with_engine(handle, |engine| {
        if engine.group_id.is_some() {
            return Err(err("engine-already-holds-group"));
        }
        let signer = &engine.signer;
        let mut group = MlsGroup::builder()
            .ciphersuite(SUITE)
            .use_ratchet_tree_extension(true)
            .build(
                &engine.provider,
                signer,
                CredentialWithKey {
                    credential: BasicCredential::new(engine.identity_label.as_bytes().to_vec()).into(),
                    signature_key: signer.public().into(),
                },
            )
            .map_err(|e| err(format!("group-build:{e:?}")))?;
        // Persist the created group into provider storage so snapshot and
        // reload work without holding the MlsGroup in the registry.
        let group_id = group.group_id().to_vec();
        group
            .merge_pending_commit(&engine.provider)
            .map_err(|e| err(format!("create-merge:{e:?}")))?;
        drop(group);
        engine.group_id = Some(group_id.clone());
        ok_json(&serde_json::json!({ "group_ref": stored_group(&group_id) }))
    })
}

#[wasm_bindgen]
pub fn mls_group_create(handle: u64) -> Result<wasm_bindgen::JsValue, wasm_bindgen::JsValue> {
    match mls_group_create_core(handle) {
        Ok(json) => Ok(wasm_bindgen::JsValue::from_str(&json)),
        Err(reason) => Err(wasm_bindgen::JsValue::from_str(&reason)),
    }
}

/// Export a key package: opaque base64 another member feeds to mls_group_add
/// (or persists to invite someone offline).
pub fn mls_engine_key_package_core(handle: u64) -> Result<String, String> {
    with_engine(handle, |engine| {
        let bundle = KeyPackage::builder()
            .build(
                SUITE,
                &engine.provider,
                &engine.signer,
                CredentialWithKey {
                    credential: BasicCredential::new(engine.identity_label.as_bytes().to_vec()).into(),
                    signature_key: engine.signer.public().into(),
                },
            )
            .map_err(|e| err(format!("keypackage:{e:?}")))?;
        let bytes = bundle
            .key_package()
            .tls_serialize_detached()
            .map_err(|e| err(format!("kp-serialize:{e:?}")))?;
        ok_json(&serde_json::json!({ "key_package": b64(&bytes) }))
    })
}

#[wasm_bindgen]
pub fn mls_engine_key_package(handle: u64) -> Result<wasm_bindgen::JsValue, wasm_bindgen::JsValue> {
    match mls_engine_key_package_core(handle) {
        Ok(json) => Ok(wasm_bindgen::JsValue::from_str(&json)),
        Err(reason) => Err(wasm_bindgen::JsValue::from_str(&reason)),
    }
}

/// Owner adds a member from their exported key package. Returns
/// `commit` (wire bytes every EXISTING member feeds to mls_process) and
/// `welcome` (wire bytes only the JOINING member feeds to mls_join). The
/// owner's own state merges the commit immediately.
pub fn mls_group_add_core(handle: u64, key_package_b64: &str) -> Result<String, String> {
    with_engine(handle, |engine| {
        let (group_id_bytes, mut group) = load_engine_group(engine)?;
        let kp_bytes = unb64(key_package_b64)?;
        let key_package_in =
            KeyPackageIn::tls_deserialize_exact(&kp_bytes).map_err(|e| err(format!("kp-parse:{e:?}")))?;
        let key_package = key_package_in
            .validate(&engine.provider.crypto, ProtocolVersion::Mls10)
            .map_err(|e| err(format!("kp-invalid:{e:?}")))?;
        let (out, welcome, _group_info) = group
            .add_members(&engine.provider, &engine.signer, &[key_package])
            .map_err(|e| err(format!("add-members:{e:?}")))?;
        group
            .merge_pending_commit(&engine.provider)
            .map_err(|e| err(format!("merge:{e:?}")))?;
        drop(group);
        let commit = out.tls_serialize_detached().map_err(|e| err(format!("out-ser:{e:?}")))?;
        let welcome_bytes = welcome.tls_serialize_detached().map_err(|e| err(format!("welcome-ser:{e:?}")))?;
        ok_json(&serde_json::json!({
            "group_ref": stored_group(&group_id_bytes),
            "commit": b64(&commit),
            "welcome": b64(&welcome_bytes),
        }))
    })
}

#[wasm_bindgen]
pub fn mls_group_add(handle: u64, key_package_b64: &str) -> Result<wasm_bindgen::JsValue, wasm_bindgen::JsValue> {
    match mls_group_add_core(handle, key_package_b64) {
        Ok(json) => Ok(wasm_bindgen::JsValue::from_str(&json)),
        Err(reason) => Err(wasm_bindgen::JsValue::from_str(&reason)),
    }
}


/// Load this engine's held MLS group (single-group bridge scope: one Cipher
/// device carries one MLS-secured roster at a time for founder testing;
/// widening is a registry refactor behind the same entry points).
fn load_engine_group(engine: &mut Engine) -> Result<(Vec<u8>, MlsGroup), String> {
    let group_id_bytes = engine.group_id.clone().ok_or_else(|| err("no-engine-group"))?;
    let group = load_group(engine, &group_id_bytes)?;
    Ok((group_id_bytes, group))
}

/// Join as the invited member: consume welcome wire bytes (ratchet tree
/// extension required inside; fail closed on anything else). The engine then
/// holds the joined group.
pub fn mls_group_join_core(handle: u64, welcome_b64: &str) -> Result<String, String> {
    with_engine(handle, |engine| {
        if engine.group_id.is_some() {
            return Err(err("engine-already-holds-group"));
        }
        // The welcome travels as a full MLS message envelope (the exact
        // bytes mls_group_add serialized from its MlsMessageOut), so parse
        // the envelope and extract the Welcome body; anything else fails.
        let welcome_envelope = unb64(welcome_b64)?;
        let message_in = MlsMessageIn::tls_deserialize_exact(&welcome_envelope)
            .map_err(|e| err(format!("welcome-envelope:{e:?}")))?;
        let welcome = match message_in.extract() {
            MlsMessageBodyIn::Welcome(welcome) => welcome,
            _ => return Err(err("not-a-welcome")),
        };
        let config = MlsGroupJoinConfig::builder()
            .use_ratchet_tree_extension(true)
            .build();
        let staged = StagedWelcome::new_from_welcome(&engine.provider, &config, welcome, None)
            .map_err(|e| err(format!("welcome-stage:{e:?}")))?;
        let group = staged
            .into_group(&engine.provider)
            .map_err(|e| err(format!("group-build:{e:?}")))?;
        let group_id = group.group_id().to_vec();
        drop(group);
        engine.group_id = Some(group_id.clone());
        ok_json(&serde_json::json!({ "group_ref": stored_group(&group_id) }))
    })
}

#[wasm_bindgen]
pub fn mls_group_join(handle: u64, welcome_b64: &str) -> Result<wasm_bindgen::JsValue, wasm_bindgen::JsValue> {
    match mls_group_join_core(handle, welcome_b64) {
        Ok(json) => Ok(wasm_bindgen::JsValue::from_str(&json)),
        Err(reason) => Err(wasm_bindgen::JsValue::from_str(&reason)),
    }
}

fn load_group_by_ref(engine: &mut Engine) -> Result<MlsGroup, String> {
    let bytes = engine.group_id.clone().ok_or_else(|| err("no-engine-group"))?;
    load_group(engine, &bytes)
}

/// Feed one wire message (app payload or commit from a peer action like an
/// add/remove) to the held group. Returns the plaintext for application
/// messages and a descriptor for commits/proposals/own messages.
pub fn mls_process_core(handle: u64, message_b64: &str) -> Result<String, String> {
    with_engine(handle, |engine| {
        let mut group = load_group_by_ref(engine)?;
        let wire = unb64(message_b64)?;
        let message_in = MlsMessageIn::tls_deserialize_exact(&wire)
            .map_err(|e| err(format!("message-parse:{e:?}")))?;
        let protocol = message_in
            .try_into_protocol_message()
            .map_err(|e| err(format!("message-kind:{e:?}")))?;
        let processed = match group.process_message(&engine.provider, protocol) {
            Ok(processed) => processed,
            // An own commit fanned back through the relay is expected: we
            // already merged it locally before publishing.
            Err(ProcessMessageError::GroupStateError(MlsGroupStateError::UseAfterEviction)) => {
                return ok_json(&serde_json::json!({ "kind": "evicted" }));
            }
            Err(error) => return Err(err(format!("process:{error:?}"))),
        };
        match processed.into_content() {
            ProcessedMessageContent::ApplicationMessage(application) => {
                let plaintext = application.into_bytes();
                ok_json(&serde_json::json!({
                    "kind": "application",
                    "plaintext": b64(&plaintext),
                }))
            }
            ProcessedMessageContent::StagedCommitMessage(staged_commit) => {
                group
                    .merge_staged_commit(&engine.provider, *staged_commit)
                    .map_err(|e| err(format!("merge-commit:{e:?}")))?;
                ok_json(&serde_json::json!({ "kind": "commit-merged" }))
            }
            ProcessedMessageContent::ProposalMessage(proposal) => {
                group
                    .store_pending_proposal(&engine.provider.storage, *proposal)
                    .map_err(|e| err(format!("store-proposal:{e:?}")))?;
                ok_json(&serde_json::json!({ "kind": "proposal-stored" }))
            }
            ProcessedMessageContent::ExternalJoinProposalMessage(proposal) => {
                group
                    .store_pending_proposal(&engine.provider.storage, *proposal)
                    .map_err(|e| err(format!("store-proposal:{e:?}")))?;
                ok_json(&serde_json::json!({ "kind": "external-proposal-stored" }))
            }
            ProcessedMessageContent::OwnPendingCommit => {
                ok_json(&serde_json::json!({ "kind": "own-commit-echo" }))
            }
            ProcessedMessageContent::OwnPrivateMessage => {
                ok_json(&serde_json::json!({ "kind": "own-message-echo" }))
            }
        }
    })
}

#[wasm_bindgen]
pub fn mls_process(handle: u64, message_b64: &str) -> Result<wasm_bindgen::JsValue, wasm_bindgen::JsValue> {
    match mls_process_core(handle, message_b64) {
        Ok(json) => Ok(wasm_bindgen::JsValue::from_str(&json)),
        Err(reason) => Err(wasm_bindgen::JsValue::from_str(&reason)),
    }
}

/// Encrypt an application payload for every member of the held group.
/// Returns opaque MLS wire bytes; replay protection is inside the epoch keys.
pub fn mls_encrypt_core(handle: u64, plaintext_b64: &str) -> Result<String, String> {
    with_engine(handle, |engine| {
        let mut group = load_group_by_ref(engine)?;
        let plaintext = unb64(plaintext_b64)?;
        let out = group
            .create_message(&engine.provider, &engine.signer, &plaintext)
            .map_err(|e| err(format!("encrypt:{e:?}")))?;
        let wire = out
            .tls_serialize_detached()
            .map_err(|e| err(format!("out-ser:{e:?}")))?;
        drop(group);
        ok_json(&serde_json::json!({ "message": b64(&wire) }))
    })
}

#[wasm_bindgen]
pub fn mls_encrypt(handle: u64, plaintext_b64: &str) -> Result<wasm_bindgen::JsValue, wasm_bindgen::JsValue> {
    match mls_encrypt_core(handle, plaintext_b64) {
        Ok(json) => Ok(wasm_bindgen::JsValue::from_str(&json)),
        Err(reason) => Err(wasm_bindgen::JsValue::from_str(&reason)),
    }
}

/// Enumerate the held group's member roster: (leaf index, credential label,
/// signature key hex). The label is what JS maps back to account pubkeys.
pub fn mls_members_core(handle: u64) -> Result<String, String> {
    with_engine(handle, |engine| {
        let group = load_group_by_ref(engine)?;
        let rows: Vec<_> = group
            .members()
            .map(|member| {
                serde_json::json!({
                    "index": member.index.u32(),
                    "label": String::from_utf8_lossy(member.credential.serialized_content()).into_owned(),
                    "signature_key": hex_encode(&member.signature_key),
                })
            })
            .collect();
        let epoch = group.epoch();
        ok_json(&serde_json::json!({ "epoch": epoch.as_u64(), "members": rows }))
    })
}

#[wasm_bindgen]
pub fn mls_members(handle: u64) -> Result<wasm_bindgen::JsValue, wasm_bindgen::JsValue> {
    match mls_members_core(handle) {
        Ok(json) => Ok(wasm_bindgen::JsValue::from_str(&json)),
        Err(reason) => Err(wasm_bindgen::JsValue::from_str(&reason)),
    }
}

fn hex_encode(bytes: &[u8]) -> String {
    let mut text = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        text.push_str(&format!("{byte:02x}"));
    }
    text
}
