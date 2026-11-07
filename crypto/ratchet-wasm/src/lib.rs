use serde::Serialize;
use vodozemac::Curve25519PublicKey;
use vodozemac::olm::{
    Account, AccountPickle, OlmMessage, Session as OlmSession, SessionConfig, SessionPickle,
};
use wasm_bindgen::prelude::*;

const PROTOCOL_VERSION: u8 = 2;

fn error(message: impl ToString) -> JsValue {
    JsValue::from_str(&message.to_string())
}

fn pickle_key(bytes: &[u8]) -> Result<[u8; 32], JsValue> {
    bytes
        .try_into()
        .map_err(|_| error("Ratchet pickle key must be exactly 32 bytes."))
}

#[derive(Serialize)]
struct PublicIdentity {
    protocol: &'static str,
    version: u8,
    ed25519: String,
    curve25519: String,
}

#[wasm_bindgen]
pub struct DeviceAccount {
    inner: Account,
}

#[wasm_bindgen]
impl DeviceAccount {
    #[wasm_bindgen(constructor)]
    pub fn new() -> DeviceAccount {
        DeviceAccount {
            inner: Account::new(),
        }
    }

    pub fn identity_json(&self) -> Result<String, JsValue> {
        serde_json::to_string(&PublicIdentity {
            protocol: "cipher-olm-ratchet",
            version: PROTOCOL_VERSION,
            ed25519: self.inner.ed25519_key().to_base64(),
            curve25519: self.inner.curve25519_key().to_base64(),
        })
        .map_err(error)
    }

    pub fn generate_one_time_keys_json(&mut self, count: u32) -> Result<String, JsValue> {
        if count == 0 || count > 50 {
            return Err(error("Generate between 1 and 50 one-time keys."));
        }
        let result = self.inner.generate_one_time_keys(count as usize);
        let keys: Vec<String> = result.created.iter().map(|key| key.to_base64()).collect();
        serde_json::to_string(&keys).map_err(error)
    }

    pub fn generate_fallback_key(&mut self) -> Result<String, JsValue> {
        self.inner.generate_fallback_key();
        self.inner
            .fallback_key()
            .values()
            .next()
            .map(|key| key.to_base64())
            .ok_or_else(|| error("The fallback key was not generated."))
    }

    pub fn mark_keys_as_published(&mut self) {
        self.inner.mark_keys_as_published();
    }

    pub fn stored_one_time_key_count(&self) -> u32 {
        self.inner.stored_one_time_key_count() as u32
    }

    pub fn encrypt_state(&self, key: &[u8]) -> Result<String, JsValue> {
        let key = pickle_key(key)?;
        Ok(self.inner.pickle().encrypt(&key))
    }

    pub fn restore(ciphertext: &str, key: &[u8]) -> Result<DeviceAccount, JsValue> {
        let key = pickle_key(key)?;
        let pickle = AccountPickle::from_encrypted(ciphertext, &key).map_err(error)?;
        Ok(DeviceAccount {
            inner: Account::from_pickle(pickle),
        })
    }

    pub fn create_outbound_session(
        &self,
        peer_identity_key: &str,
        peer_one_time_key: &str,
    ) -> Result<RatchetSession, JsValue> {
        let identity = Curve25519PublicKey::from_base64(peer_identity_key).map_err(error)?;
        let one_time = Curve25519PublicKey::from_base64(peer_one_time_key).map_err(error)?;
        let session = self
            .inner
            .create_outbound_session(SessionConfig::version_2(), identity, one_time)
            .map_err(error)?;
        Ok(RatchetSession { inner: session })
    }

    pub fn accept_initial_message(
        &mut self,
        expected_peer_identity_key: &str,
        message_json: &str,
    ) -> Result<ReceiveInitial, JsValue> {
        let expected =
            Curve25519PublicKey::from_base64(expected_peer_identity_key).map_err(error)?;
        let message: OlmMessage = serde_json::from_str(message_json).map_err(error)?;
        let OlmMessage::PreKey(prekey) = message else {
            return Err(error("A new session must begin with a pre-key message."));
        };
        let used_one_time_key = prekey.one_time_key().to_base64();
        let received = self
            .inner
            .create_inbound_session(SessionConfig::version_2(), expected, &prekey)
            .map_err(error)?;
        let plaintext = String::from_utf8(received.plaintext)
            .map_err(|_| error("Ratchet plaintext is not valid UTF-8."))?;
        Ok(ReceiveInitial {
            session: RatchetSession {
                inner: received.session,
            },
            plaintext,
            used_one_time_key,
        })
    }
}

impl Default for DeviceAccount {
    fn default() -> Self {
        Self::new()
    }
}

#[wasm_bindgen]
pub struct RatchetSession {
    inner: OlmSession,
}

#[wasm_bindgen]
impl RatchetSession {
    pub fn session_id(&self) -> String {
        self.inner.session_id()
    }

    pub fn encrypt(&mut self, plaintext: &str) -> Result<String, JsValue> {
        let message = self.inner.encrypt(plaintext.as_bytes()).map_err(error)?;
        serde_json::to_string(&message).map_err(error)
    }

    pub fn decrypt(&mut self, message_json: &str) -> Result<String, JsValue> {
        let message: OlmMessage = serde_json::from_str(message_json).map_err(error)?;
        let plaintext = self.inner.decrypt(&message).map_err(error)?;
        String::from_utf8(plaintext).map_err(|_| error("Ratchet plaintext is not valid UTF-8."))
    }

    pub fn encrypt_state(&self, key: &[u8]) -> Result<String, JsValue> {
        let key = pickle_key(key)?;
        Ok(self.inner.pickle().encrypt(&key))
    }

    pub fn restore(ciphertext: &str, key: &[u8]) -> Result<RatchetSession, JsValue> {
        let key = pickle_key(key)?;
        let pickle = SessionPickle::from_encrypted(ciphertext, &key).map_err(error)?;
        let session = OlmSession::from_pickle(pickle);
        if session.session_config() != SessionConfig::version_2() {
            return Err(error("Refusing a non-v2 ratchet session."));
        }
        Ok(RatchetSession { inner: session })
    }
}

#[wasm_bindgen]
pub struct ReceiveInitial {
    session: RatchetSession,
    plaintext: String,
    used_one_time_key: String,
}

#[wasm_bindgen]
impl ReceiveInitial {
    pub fn plaintext(&self) -> String {
        self.plaintext.clone()
    }

    pub fn used_one_time_key(&self) -> String {
        self.used_one_time_key.clone()
    }

    pub fn session_id(&self) -> String {
        self.session.session_id()
    }

    pub fn encrypt_session_state(&self, key: &[u8]) -> Result<String, JsValue> {
        self.session.encrypt_state(key)
    }

    pub fn into_session(self) -> RatchetSession {
        self.session
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn one_key(account: &mut Account) -> Curve25519PublicKey {
        account.generate_one_time_keys(1).created.remove(0)
    }

    #[test]
    fn v2_initial_message_and_bidirectional_ratchet_round_trip() {
        let alice = Account::new();
        let mut bob = Account::new();
        let bob_otk = one_key(&mut bob);
        let mut alice_session = alice
            .create_outbound_session(SessionConfig::version_2(), bob.curve25519_key(), bob_otk)
            .expect("create outbound session");

        let first = alice_session
            .encrypt("first message")
            .expect("encrypt first");
        assert!(matches!(first, OlmMessage::PreKey(_)));
        let first_json = serde_json::to_string(&first).expect("serialize prekey message");
        let prekey: OlmMessage = serde_json::from_str(&first_json).expect("parse prekey message");
        let OlmMessage::PreKey(prekey) = prekey else {
            panic!("expected prekey message")
        };
        let accepted = bob
            .create_inbound_session(SessionConfig::version_2(), alice.curve25519_key(), &prekey)
            .expect("accept initial message");
        assert_eq!(accepted.plaintext, b"first message");
        let mut bob_session = accepted.session;

        let reply = bob_session.encrypt("reply").expect("encrypt reply");
        assert!(matches!(reply, OlmMessage::Normal(_)));
        assert_eq!(
            alice_session.decrypt(&reply).expect("decrypt reply"),
            b"reply"
        );

        let next = alice_session
            .encrypt("after ratchet")
            .expect("encrypt next");
        assert_eq!(
            bob_session.decrypt(&next).expect("decrypt next"),
            b"after ratchet"
        );
    }

    #[test]
    fn v2_skipped_message_keys_allow_bounded_out_of_order_delivery_once() {
        let alice = Account::new();
        let mut bob = Account::new();
        let bob_otk = one_key(&mut bob);
        let mut alice_session = alice
            .create_outbound_session(SessionConfig::version_2(), bob.curve25519_key(), bob_otk)
            .expect("create outbound session");

        let first = alice_session
            .encrypt("message zero")
            .expect("encrypt first");
        let OlmMessage::PreKey(prekey) = first else {
            panic!("expected initial pre-key message");
        };
        let accepted = bob
            .create_inbound_session(SessionConfig::version_2(), alice.curve25519_key(), &prekey)
            .expect("accept initial message");
        let mut bob_session = accepted.session;
        assert_eq!(accepted.plaintext, b"message zero");

        let one = alice_session.encrypt("message one").expect("encrypt one");
        let two = alice_session.encrypt("message two").expect("encrypt two");
        assert_eq!(
            bob_session.decrypt(&two).expect("decrypt two"),
            b"message two"
        );
        assert_eq!(
            bob_session.decrypt(&one).expect("decrypt skipped one"),
            b"message one"
        );
        assert!(
            bob_session.decrypt(&one).is_err(),
            "a consumed message key must not be reusable"
        );
    }

    #[test]
    fn v2_configuration_is_not_compatible_with_truncated_mac_mode() {
        let mut bob = Account::new();
        let alice = Account::new();
        let bob_otk = one_key(&mut bob);
        let mut legacy = alice
            .create_outbound_session(SessionConfig::version_1(), bob.curve25519_key(), bob_otk)
            .expect("create legacy outbound session");
        let initial = legacy
            .encrypt("legacy config")
            .expect("encrypt legacy config");
        let OlmMessage::PreKey(prekey) = initial else {
            panic!("expected prekey message")
        };

        let result =
            bob.create_inbound_session(SessionConfig::version_2(), alice.curve25519_key(), &prekey);
        assert!(result.is_err(), "v2 must reject compatibility-mode session");
    }

    #[test]
    fn consumed_one_time_key_cannot_create_a_second_initial_session() {
        let alice = Account::new();
        let mut bob = Account::new();
        let bob_otk = one_key(&mut bob);
        let mut session = alice
            .create_outbound_session(SessionConfig::version_2(), bob.curve25519_key(), bob_otk)
            .expect("create outbound session");
        let initial = session.encrypt("once").expect("encrypt initial");
        let OlmMessage::PreKey(prekey) = initial else {
            panic!("expected prekey message")
        };
        bob.create_inbound_session(SessionConfig::version_2(), alice.curve25519_key(), &prekey)
            .expect("consume one-time key");
        assert!(bob
            .create_inbound_session(
                SessionConfig::version_2(),
                alice.curve25519_key(),
                &prekey,
            )
            .is_err());
    }

    #[test]
    fn account_pickle_round_trip_requires_its_unique_storage_key() {
        let mut account = Account::new();
        account.generate_one_time_keys(2);
        let key = [42u8; 32];
        let ciphertext = account.pickle().encrypt(&key);
        assert!(!ciphertext.contains("ed25519"));
        let restored = Account::from_pickle(
            AccountPickle::from_encrypted(&ciphertext, &key).expect("decrypt account pickle"),
        );
        assert_eq!(restored.identity_keys(), account.identity_keys(),);
        assert!(AccountPickle::from_encrypted(&ciphertext, &[41u8; 32]).is_err());
    }
}
