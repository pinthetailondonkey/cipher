import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const SRC = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const codeFiles = walk(SRC).filter((file) => /\.(js|jsx)$/.test(file));

test('no amber or yellow Tailwind class survives anywhere in src', () => {
  const re = /(?:text|bg|border)-(?:amber|yellow)/;
  const hits = [];
  for (const file of codeFiles) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (re.test(line)) hits.push(`${path.relative(SRC, file)}: ${line.trim()}`);
    }
  }
  assert.deepEqual(hits, []);
});

test('the brass accent hex is gone from src', () => {
  // The guard's own source has to spell the hex to check it; test files are
  // out of scope, same as the egress guard skips itself.
  const hits = walk(SRC).filter((file) => !file.endsWith('.test.js') && /c9a227/i.test(fs.readFileSync(file, 'utf8')));
  assert.deepEqual(hits.map((file) => path.relative(SRC, file)), []);
});

test('the theme registry stays retired', () => {
  assert.equal(fs.existsSync(path.join(SRC, 'lib', 'theme.js')), false);
});

test('the stylesheet wears one look: no per-theme selector in index.css', () => {
  const css = fs.readFileSync(path.join(SRC, 'index.css'), 'utf8');
  assert.equal(/\[data-theme/.test(css), false);
});

test('the class-based dark strategy stays retired in the tailwind config', () => {
  const configPath = path.resolve(SRC, '..', 'tailwind.config.cjs');
  assert.equal(/darkMode\s*:\s*['"]class['"]/.test(fs.readFileSync(configPath, 'utf8')), false);
});
