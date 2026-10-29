import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { EGRESS, listEgress } from './egress.js';

// The copy law for the wall's own words: each row's `sees` line is a plain
// account of what a host learns, written for the person to read on the
// Connections screen — but nothing renders it today, and that is deliberate.
// It is read by tests and by the row's own reviewers, not drawn on a screen.
//
// "No reader today" is not the same as "cannot be read tomorrow". These two
// tests make the difference a fact rather than an accident: add a component
// that draws a row's sees text and the first fails; let a row lose its sees
// text and the second fails.

const SRC = fileURLToPath(new URL('..', import.meta.url));

function sourceFiles(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.(js|jsx)$/.test(name) && !/\.test\./.test(name)) out.push(full);
  }
  return out;
}

// A component reads the text either as `row.sees` or by destructuring it.
const READS_SEES = /\.sees\b|[{,]\s*sees\s*[,}]/;

test('no screen renders a row\'s sees text', () => {
  const offenders = sourceFiles(SRC)
    .filter((file) => !file.endsWith(`${path.sep}egress.js`))
    .filter((file) => READS_SEES.test(fs.readFileSync(file, 'utf8')))
    .map((file) => path.relative(SRC, file));
  assert.deepEqual(offenders, [], 'a component reads `sees`; the wall copy is internal and must stay off the screen');
});

test('every row still carries its sees text, and listEgress passes it through', () => {
  for (const row of EGRESS) {
    assert.equal(typeof row.sees, 'string', `${row.id} lost its sees line`);
    assert.ok(row.sees.trim().length > 20, `${row.id} has a sees line too short to mean anything`);
  }
  // What the screen consumes keeps the field, so a future renderer would find
  // it rather than draw undefined — the pair fails loudly instead of blankly.
  for (const row of listEgress({ overrides: {}, lists: {} })) {
    assert.equal(typeof row.sees, 'string', `${row.id} lost its sees line in listEgress`);
  }
});
