import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const SOURCE = readFileSync(new URL('./Wallet.jsx', import.meta.url), 'utf8').replace(/\s+/g, ' ');

test('wallet media upload and profile save carry the captured incarnation through completion', () => {
  const upload = SOURCE.slice(SOURCE.indexOf('const handleImageUpload'), SOURCE.indexOf('const copyNpub'));
  assert.match(upload, /securityFence = assertWalletContext\(\)/);
  assert.match(upload, /const upload = import\.meta\.env\?\.VITE_TEST_HOOKS === '1'[\s\S]*?\? window\.__cipherMediaUpload : uploadAttachment; const entry = await upload\([\s\S]*?\); securityFence\.assertCurrent\(\)/);
  assert.match(upload, /await saveProfile\(null, entry\); securityFence\.assertCurrent\(\)/);
  assert.match(upload, /if \(securityFence\.isCurrent\(\)\) \{ setUploadingImage\(false\)/);
  const profile = SOURCE.slice(SOURCE.indexOf('const saveProfile'), SOURCE.indexOf('const publishProduct'));
  assert.match(profile, /await publishCipherProfile\([\s\S]*?\) securityFence\.assertCurrent\(\)/);
  assert.match(profile, /if \(securityFence\.isCurrent\(\)\) \{ setIsPublishing\(false\)/);
});

test('vendor activation passes its captured account fence to the public card publisher', () => {
  assert.match(SOURCE, /publishVendorCard\(\{ isVendor: true, identity, profile: myProfile, securityFence, owner: identity\.pk \}\)/);
  const image = SOURCE.slice(SOURCE.indexOf('const handleImageUpload'), SOURCE.indexOf('const copyNpub'));
  assert.match(image, /if \(!securityFence\.isCurrent\(\)\) return/);
});

test('wallet preference writers check the captured account context before storage and UI updates', () => {
  const preferences = SOURCE.slice(SOURCE.indexOf('const setPreferredPaymentMethod'), SOURCE.indexOf('const [isPublishing'));
  assert.match(preferences, /const setPreferredPaymentMethod = useCallback\(\(method\) => \{[\s\S]*?assertWalletContext\(\)[\s\S]*?securityFence\.assertCurrent\(\)[\s\S]*?scopedSet\('preferred_payment_method'/);
  assert.match(preferences, /const saveConfirmations = useCallback\(\(event\) => \{[\s\S]*?assertWalletContext\(\)[\s\S]*?securityFence\.assertCurrent\(\)[\s\S]*?scopedSet\('confirmations'/);
  assert.match(preferences, /const toggleAutoVouch = useCallback\(\(\) => \{[\s\S]*?assertWalletContext\(\)[\s\S]*?securityFence\.assertCurrent\(\)[\s\S]*?scopedSet\('auto_vouch_on_delivery'/);
  assert.match(SOURCE, /onConfirm=\{async \(\) => \{[\s\S]*?await identity\.panicWipe\(\)/);
  assert.doesNotMatch(SOURCE, /db\.messages\.clear\(\)/);
});
