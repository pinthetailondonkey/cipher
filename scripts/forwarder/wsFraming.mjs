// Shared raw-WebSocket framing for the forwarder prototype (plan item 10).
// Node's bundled WebSocket clients are available globally in Node >= 21;
// this repo pins Node 20, so the prototype frames WebSocket over plain TCP
// sockets with no new npm dependency. Server side accepts the upgrade
// handshake; client side dials and sends masked text frames.

export const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export function encodeFrame(text) {
  const payload = Buffer.from(text);
  let header;
  if (payload.length < 126) header = Buffer.from([0x81, payload.length]);
  else if (payload.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  return Buffer.concat([header, payload]);
}

export function encodeClientFrame(text) {
  const payload = Buffer.from(text);
  const mask = Buffer.from([0x37, 0xa1, 0x55, 0xd3]); // fixed prototype mask
  let lenByte;
  let extra;
  if (payload.length < 126) {
    lenByte = 0x80 | payload.length;
    extra = Buffer.alloc(0);
  } else {
    lenByte = 0x80 | 126;
    extra = Buffer.alloc(2);
    extra.writeUInt16BE(payload.length, 0);
  }
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i += 1) masked[i] ^= mask[i % 4];
  return Buffer.concat([Buffer.from([0x81, lenByte]), extra, mask, masked]);
}

export function takeServerFrame(buffer) {
  // Unmasked server-to-client frame.
  if (buffer.length < 2) return null;
  const opcode = buffer[0] & 0x0f;
  let length = buffer[1] & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) return null;
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return null;
    length = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }
  if ((buffer[1] & 0x80) !== 0) throw new Error('Unexpected masked server frame.');
  if (buffer.length < offset + length) return null;
  return { opcode, payload: buffer.subarray(offset, offset + length),
    rest: buffer.subarray(offset + length) };
}

export function takeClientFrame(buffer) {
  // Masked client-to-server frame.
  if (buffer.length < 2) return null;
  const opcode = buffer[0] & 0x0f;
  let length = buffer[1] & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) return null;
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return null;
    length = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }
  if ((buffer[1] & 0x80) === 0) throw new Error('Expected masked client frame.');
  if (buffer.length < offset + 4 + length) return null;
  const mask = buffer.subarray(offset, offset + 4);
  offset += 4;
  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
  return { opcode, payload: Buffer.from(payload),
    rest: buffer.subarray(offset + length) };
}
