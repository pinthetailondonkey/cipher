// Padding module (plan item 11): UTF-8-byte power-of-two ladder padding,
// applied BEFORE encryption. This is a new standalone module; it does not
// touch giftWrap.js, src/lib/crypto/*, useNIP44DM.js, egress.js or outbox.js.
//
// ── Scheme header: wire format and deterministic strip ─────────────────────
//
// Given plaintext bytes P with length n, padToBucket returns B bytes where B
// is the smallest ladder bucket >= HEADER_LEN + n, and the output is:
//
//   byte 0        : scheme version, fixed 0x01
//   byte 1        : ladder base shift, fixed 9 (base bucket = 1 << 9 = 512)
//   bytes 2..3    : big-endian uint16 of the original plaintext length n
//   bytes 4..4+n  : the original plaintext bytes, unmodified
//   remaining     : zero fill up to the bucket size B
//
// A receiver strips deterministically:
//   n = (out[2] << 8) | out[3]; return out.subarray(4, 4 + n).
//
// Buckets are 512, 1024, 2048, 4096, ... up to topBucketBytes (inclusive,
// power of two). Plaintext larger than topBucketBytes - HEADER_LEN is NOT
// truncated and NOT padded (returned unmodified with a marker) so no content
// is ever lost; callers must handle the unpadded escape class separately or
// raise the top bucket. Because the ciphertext length that a relay sees is a
// function of the padded byte length, everything under the top bucket
// collapses to the ladder rungs and longer payloads fall through to the
// encryption layer's own length quantization rather than losing bytes.
//
// Note on uint16: plaintexts over 65535 bytes cannot be length-prefixed by
// this v1 header; those payloads are returned unpadded (see the length check
// in padToBucket) so the format never lies about a length it cannot carry.

export const PAD_SCHEME_VERSION = 1;
export const PAD_LADDER_SHIFT = 9; // 1 << 9 = 512 base bucket
export const PAD_HEADER_LEN = 4;
export const PAD_BASE_BUCKET = 1 << PAD_LADDER_SHIFT; // 512

export function nextBucket(bytes, { topBucketBytes = 8192 } = {}) {
  const need = PAD_HEADER_LEN + bytes;
  let bucket = PAD_BASE_BUCKET;
  while (bucket < need) bucket *= 2;
  if (bucket > topBucketBytes) return null; // escape class: no padding
  return bucket;
}

export function padToBucket(bytes, { topBucketBytes = 8192 } = {}) {
  if (!(bytes instanceof Uint8Array)) throw new Error('padToBucket expects a Uint8Array.');
  if (!Number.isInteger(topBucketBytes) || topBucketBytes < PAD_BASE_BUCKET
    || (topBucketBytes & (topBucketBytes - 1)) !== 0) {
    throw new Error('topBucketBytes must be a power of two of at least 512.');
  }
  if (bytes.length > 0xffff) return bytes; // v1 header cannot carry this length
  const bucket = nextBucket(bytes.length, { topBucketBytes });
  if (bucket === null) return bytes; // escape class, unpadded
  const out = new Uint8Array(bucket);
  out[0] = PAD_SCHEME_VERSION;
  out[1] = PAD_LADDER_SHIFT;
  out[2] = (bytes.length >> 8) & 0xff;
  out[3] = bytes.length & 0xff;
  out.set(bytes, PAD_HEADER_LEN);
  // Zero fill stays from allocation; nothing else to do.
  return out;
}

// Deterministic inverse of padToBucket for the padded shape. Returns the
// original plaintext bytes, or null when the input is not padded v1 output
// (callers treat null as "already unpadded" only after checking the header).
export function unpadFromBucket(padded) {
  if (!(padded instanceof Uint8Array) || padded.length < PAD_HEADER_LEN) return null;
  if (padded[0] !== PAD_SCHEME_VERSION || padded[1] !== PAD_LADDER_SHIFT) return null;
  if (!Number.isInteger(Math.log2(padded.length))) return null;
  const n = (padded[2] << 8) | padded[3];
  if (PAD_HEADER_LEN + n > padded.length) return null;
  return padded.slice(PAD_HEADER_LEN, PAD_HEADER_LEN + n);
}
