import { createPrivateKey, generateKeyPairSync, sign } from 'node:crypto';

if (process.argv[2] === '--sign-rotation') {
  const currentSeedText = String(process.env.WATCH_SIGNING_PRIVATE_KEY || '');
  const nextPublicKey = String(process.argv[3] || '');
  const nextBytes = Buffer.from(nextPublicKey.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  const seed = Buffer.from(currentSeedText.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  if (nextBytes.length !== 32 || nextBytes.toString('base64url') !== nextPublicKey) {
    console.error('Pass a 32-byte base64url replacement public key.');
    process.exit(1);
  }
  if (seed.length !== 32 || seed.toString('base64url') !== currentSeedText) {
    console.error('Set WATCH_SIGNING_PRIVATE_KEY to the currently pinned 32-byte seed.');
    process.exit(1);
  }
  const privateKey = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' });
  const signature = sign(null, Buffer.from(`cipher-payment-watcher-key-rotation-v2\n${nextPublicKey}`), privateKey);
  console.log(signature.toString('base64url'));
} else {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const privateSeed = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32);
  const publicBytes = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  console.log('Store this private seed in the watcher environment; never paste it into Cipher:');
  console.log(`WATCH_SIGNING_PRIVATE_KEY=${privateSeed.toString('base64url')}`);
  console.log('Manually pin this public key in Cipher Connections:');
  console.log(publicBytes.toString('base64url'));
}
