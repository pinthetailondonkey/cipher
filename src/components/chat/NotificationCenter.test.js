import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const COMPONENT = readFileSync(new URL('./NotificationCenter.jsx', import.meta.url), 'utf8').replace(/\s+/g, ' ');
const DB = readFileSync(new URL('../../db.js', import.meta.url), 'utf8').replace(/\s+/g, ' ');

test('notification navigation waits for a durable read marker under its captured account fence', () => {
  assert.match(COMPONENT, /export default function NotificationCenter\(\{ identity, onClose, onJump \}\)/);
  const action = COMPONENT.slice(COMPONENT.indexOf('const openNotification'), COMPONENT.indexOf('return ('));
  assert.match(action, /const securityFence = identity\?\.securityFence; try \{ assertSecurityContextOwner\(securityFence, identity\?\.pk\); \} catch \{ return; \}/);
  assert.match(action, /await persistNotificationRead\(item\.id, securityFence, identity\?\.pk\); try \{ assertSecurityContextOwner\(securityFence, identity\?\.pk\); \} catch \{ return; \}/);
  assert.match(COMPONENT, /function persistNotificationRead\(chatId, securityFence, owner\) \{ if \(import\.meta\.env\?\.VITE_TEST_HOOKS === '1'[\s\S]*?return window\.__cipherNotificationRead\(chatId, securityFence, owner\); \} return markChatRead\(chatId, Math\.floor\(Date\.now\(\) \/ 1000\), securityFence, owner\); \}/);
  assert.match(action, /setUnreadCounts\([\s\S]*?onJump\?\.\(item\.type, item\.id\)/);
});

test('read-marker persistence checks the supplied owner fence inside its transaction', () => {
  const marker = DB.slice(DB.indexOf('export const markChatRead'), DB.indexOf('// Settles temporary send rows'));
  assert.match(marker, /securityFence = null, owner = securityFence\?\.context\?\.owner/);
  assert.match(marker, /await db\.transaction\('rw', 'chatReads', async \(\) => \{ if \(securityFence\) assertSecurityContextOwner\(securityFence, owner\); const current = await db\.chatReads\.get\(chatId\); if \(securityFence\) assertSecurityContextOwner\(securityFence, owner\);/);
  assert.match(marker, /await db\.chatReads\.put\([\s\S]*?\); \}\); if \(securityFence\) assertSecurityContextOwner\(securityFence, owner\)/);
});
