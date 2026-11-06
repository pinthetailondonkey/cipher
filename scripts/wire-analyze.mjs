// The analyzer half of the wire capture (docs/LAUNCH-LOG.md Phase 11).
//
//   node scripts/wire-analyze.mjs <outPrefix>.jsonl <account-pk-hex> [pins.csv]
//
// Input: one JSONL file recorded by wire-capture.mjs (frames verbatim, each
// recv row tagged by the box it crossed: 'group' or 'general'), the account
// pubkey, and every actor pin the run saw.
//
// The claim it witnesses — scoped exactly as the log states it: NO frame
// crossing a GROUP relay names the account key, and every event published
// there signs with an alias. The GENERAL box is reported informationally
// only: DM, profile and search relays legitimately carry author filters and
// NIP-65 metadata naming the account, by design (PRIVACY-REVIEW D1). Frames
// are judged from the recv-app-to-relay rows: those are the bytes as they
// crossed each box, not the browser-side mirror, so fragmentation quirks on
// either side cannot double-count one frame.
//
// Exit 0 means GREEN; every failure names its own cause.
//
// One accepted residual, recognized rather than failed: the kind-9007 create
// event names the creator-account as admin in a plaintext `p` tag (Phase 11:
// "an open group must let anyone reading it learn who governs without holding
// a doc, which is what that tag is for"). An account-key appearance inside a
// published event's TAG ARRAY on that one kind is reported as the residual;
// any other context (signer field, REQ filter author, content) fails.

import fs from 'node:fs';

const [capturePath, pkArgRaw, pinsRaw] = process.argv.slice(2);
if (!capturePath || !pkArgRaw) {
  console.error('usage: analyze.mjs <capture.jsonl> <account-pk-hex> [pins.csv]');
  process.exit(1);
}
const pk = String(pkArgRaw).toLowerCase();
const extraPins = (pinsRaw || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

const rows = fs.readFileSync(capturePath, 'utf8').split('\n').filter(Boolean)
  .map((line) => { try { return JSON.parse(line); } catch { return null; } })
  .filter(Boolean);

const byBox = { group: [], general: [], other: [] };
for (const r of rows) {
  if (r.dir !== 'recv-app-to-relay') continue;
  const role = r.url === 'group' || r.url === 'general' ? r.url : 'other';
  byBox[role].push(r);
}

function audit(name, rs) {
  const foundPins = new Set();
  const signerRows = [];
  const pkHits = [];
  const realPkHits = [];
  for (const r of rs) {
    const d = typeof r.data === 'string' ? r.data.replace(/\\/g, '') : '';
    if (!d) continue;
    const low = d.toLowerCase();
    if (low.includes(pk)) pkHits.push(r.seq);
    let cmd;
    try { cmd = JSON.parse(d); } catch { continue; }
    if (!Array.isArray(cmd)) continue;
    const ev = cmd[0] === 'EVENT' && cmd[1] && typeof cmd[1] === 'object' ? cmd[1] : null;
    if (ev) {
      const who = String(ev.pubkey || '').toLowerCase();
      signerRows.push({ seq: r.seq, kind: ev.kind, signer: who });
      if (who !== pk) foundPins.add(who);
      // Author-tag pins ride control kinds and pool AUTH answers too.
      for (const t of Array.isArray(ev.tags) ? ev.tags : []) {
        if ((t[0] === 'author' || t[0] === 'p') && /^[0-9a-f]{66}$/i.test(t[1])) foundPins.add(String(t[1]).toLowerCase());
      }
    }
    // REQ/AUTH framing also carries pubkeys inside filters.
    if (cmd[0] === 'AUTH' && typeof cmd[1]?.pubkey === 'string') foundPins.add(cmd[1].pubkey.toLowerCase());
  }
  // Split raw hits into the accepted residual (the kind-9007 create event's
  // own admin p-tag) versus everything else: remove the event's own tags
  // from the frame text and the account key must not survive anywhere else.
  const residualSeqs = [];
  for (const seq of pkHits) {
    const r = rs.find((x) => x.seq === seq);
    const d = typeof r?.data === 'string' ? r.data.replace(/\\/g, '') : '';
    let ev = null;
    try { const c = JSON.parse(d); if (Array.isArray(c) && c[0] === 'EVENT') ev = c[1]; } catch {}
    if (ev?.kind === 9007 && Array.isArray(ev.tags)) {
      const tagText = JSON.stringify(ev.tags).replace(/\\/g, '');
      const withoutTags = d.replaceAll(tagText, '');
      if (!withoutTags.toLowerCase().includes(pk) && !String(ev.content || '').toLowerCase().includes(pk)) {
        residualSeqs.push(seq);
        continue;
      }
    }
    realPkHits.push(seq);
  }
  const withAccountSigner = signerRows.filter((s) => s.signer === pk);
  return { name, frames: rs.length, signerRows, withAccountSigner, pkHits, realPkHits, residualSeqs, foundPins };
}

const group = audit('GROUP', byBox.group);
const gen = audit('GENERAL', byBox.general);

console.log(`rows: ${rows.length} | group-box frames: ${group.frames} | general-box frames: ${gen.frames}`);
console.log(`group-box events published: ${group.signerRows.length}`);
for (const s of group.signerRows) console.log(`  seq ${s.seq} kind ${s.kind} signer ${s.signer.slice(0, 12)}…`);
for (const pin of [...new Set([...extraPins, ...[...group.foundPins]])]) {
  console.log(`alias seen: ${pin.slice(0, 12)}…`);
}
console.log(`group-box account-key appearances: ${group.pkHits.length}${group.pkHits.length ? ' (seqs ' + group.pkHits.join(',') + ')' : ''}`);
if (group.residualSeqs.length) console.log(`accepted residual (create-event admin p-tag): ${group.residualSeqs.length} (seqs ${group.residualSeqs.join(',')})`);
console.log(`group-box events signed by the ACCOUNT key: ${group.withAccountSigner.length}`);
console.log(`(informational) general-box account-key appearances: ${gen.pkHits.length}`);

let ok = true;
if (group.frames === 0) { console.log('RED: no group-box frames captured — the run did not reach a group relay.'); ok = false; }
else {
  if (group.signerRows.length === 0) { console.log('RED: no EVENT reached the group box — publishing was not exercised.'); ok = false; }
  if (group.withAccountSigner.length > 0) { console.log(`RED: ${group.withAccountSigner.length} group-box events name the account key as signer.`); ok = false; }
  if (group.realPkHits.length > 0) { console.log(`RED: the account pubkey appears in group-box bytes outside the accepted create-tag residual (seqs ${group.realPkHits.join(',')}).`); ok = false; }
  if ([...group.foundPins].length === 0) { console.log('RED: no alias key ever appeared on the group box.'); ok = false; }
}
if (ok) console.log('GREEN: no group-box frame names the account key; everything there signs with aliases.');
process.exit(ok ? 0 : 1);
