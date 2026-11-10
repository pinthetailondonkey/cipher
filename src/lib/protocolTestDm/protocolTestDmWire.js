// Pure JSON canonicalization for the DM test profile v1 operation plaintext.
//
// Implements the RFC 8785 (JCS) subset frozen in docs/DM-TEST-PROFILE-V1.md
// section 3. Only the value classes that section lists are canonically
// encodable; anything else fails closed with a thrown error instead of guessing
// at a byte encoding, because the digest of an operation must be reproducible
// by an independent verifier byte-for-byte.
//
// Encodable value classes (exact):
// - null, true, false;
// - safe integers only (-9007199254740991..9007199254740991), rendered by
//   JavaScript number-to-shortest-string (JSON.stringify semantics);
// - strings (any string JSON.stringify can emit), including decimal amounts
//   carried as quoted strings so money never becomes a float;
// - arrays of encodable values in array order;
// - objects whose keys are strings, serialized sorted by UTF-16 code unit order
//   (the JCS sort).
//
// NOT encodable (throws): non-safe-int numbers (floats, NaN, Infinity,
// -0 is normalized to 0 but 0.5 etc refuse), undefined (objects drop it only if
// the caller pre-cleans; this module refuses it outright), functions, symbols,
// BigInt, boxed primitives, Date, Map/Set, Uint8Array (binary fields ride as
// lowercase hex STRINGS chosen by the caller), duplicate behavior beyond plain
// JS object semantics.

function canonicalString(value) {
  // JSON.stringify's escaping matches JCS string serialization exactly.
  return JSON.stringify(value);
}

export function assertEncodable(value, path = '$') {
  if (value === null) return;
  const type = typeof value;
  if (type === 'boolean' || type === 'string') return;
  if (type === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`Canonical encoding refused: non-finite number at ${path}`);
    }
    if (!Number.isSafeInteger(value)) {
      throw new Error(
        `Canonical encoding refused: ${String(value)} at ${path} is not a safe integer.`
          + ' Amounts ride as decimal STRINGS per docs/DM-TEST-PROFILE-V1.md.',
      );
    }
    return;
  }
  if (type !== 'object') {
    throw new Error(`Canonical encoding refused: type ${type} at ${path}`);
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertEncodable(entry, `${path}[${index}]`));
    return;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new Error(`Canonical encoding refused: non-plain object at ${path}`);
  }
  for (const key of Object.keys(value)) {
    for (const char of key) {
      const code = char.charCodeAt(0);
      if (code >= 0xd800 && code <= 0xdfff
        && !(code >= 0xdc00 && code <= 0xdfff)
        && (() => { const next = key[key.indexOf(char) + 1]; return !next || next.charCodeAt(0) < 0xdc00 || next.charCodeAt(0) > 0xdfff; })()) {
        throw new Error(`Canonical encoding refused: lone surrogate in key at ${path}.${key}`);
      }
    }
    assertEncodable(value[key], `${path}.${key}`);
  }
}

// The JCS property sort: UTF-16 code unit order on raw string keys. Array
// prototype sort without a comparator is NOT guaranteed stable ordering-wise
// across engines here we need determinism, so an explicit comparator pins it.
const utf16Compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export function jcsEncode(value) {
  assertEncodable(value, '$');
  return encodeChecked(value);
}

function encodeChecked(value) {
  if (value === null) return 'null';
  if (value === true) return 'true';
  if (value === false) return 'false';
  const type = typeof value;
  if (type === 'string') return canonicalString(value);
  if (type === 'number') return String(value); // safe integer checked already
  if (Array.isArray(value)) {
    return `[${value.map((entry) => encodeChecked(entry)).join(',')}]`;
  }
  const keys = Object.keys(value).sort(utf16Compare);
  const parts = keys.map((key) => `${canonicalString(key)}:${encodeChecked(value[key])}`);
  return `{${parts.join(',')}}`;
}

// SHA-256 over the canonical bytes lives in protocolTestDmOperations.js so
// this file stays dependency-free and trivially auditable.
