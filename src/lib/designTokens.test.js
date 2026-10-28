import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const css = fs.readFileSync(path.join(ROOT, 'src', 'index.css'), 'utf8');
const rootBlock = css.slice(css.indexOf(':root {'), css.indexOf('@font-face'));

// Every custom property declared in :root, as written.
const declared = new Map(
  [...rootBlock.matchAll(/^\s*(--[a-z0-9-]+):\s*([^;]+);/gm)].map((match) => [match[1], match[2].trim()]),
);

// Resolve a token through var(--other) hops down to a #rrggbb.
function resolve(name, seen = new Set()) {
  assert.ok(declared.has(name), `${name} is not declared in :root`);
  assert.ok(!seen.has(name), `${name} loops`);
  seen.add(name);
  const value = declared.get(name);
  const hop = value.match(/^var\((--[a-z0-9-]+)\)$/);
  return hop ? resolve(hop[1], seen) : value;
}

function luminance(hex) {
  const channel = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * channel[0] + 0.7152 * channel[1] + 0.0722 * channel[2];
}

export function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const AA = 4.5;
const SURFACES = ['--bg', '--surface', '--surface-2'];

test('the spec palette is what :root declares', () => {
  const expected = {
    '--bg': '#050505', '--surface': '#101010', '--surface-2': '#171717', '--pressed': '#202020',
    '--border-solid': '#282828', '--separator': '#1d1d1d', '--text-1': '#f5f6f8', '--text-2': '#969ba6',
    '--blue': '#2463f5', '--blue-bright': '#3987ff', '--success-solid': '#37c98b',
    '--warning-solid': '#f0b85a', '--destructive': '#ff5b64',
  };
  for (const [name, hex] of Object.entries(expected)) assert.equal(resolve(name).toLowerCase(), hex, name);
  // text-3 is the one small adjustment: #707784 reads 4.0:1 on surface-2, so
  // it is lifted until it clears AA there.
  assert.equal(resolve('--text-3').toLowerCase(), '#7a8190');
});

test('text roles clear WCAG AA (4.5:1) on every surface they sit on', () => {
  for (const role of ['--text-1', '--text-2', '--text-3', '--blue-bright', '--success-solid', '--warning-solid', '--destructive']) {
    for (const surface of SURFACES) {
      const ratio = contrast(resolve(role), resolve(surface));
      assert.ok(ratio >= AA, `${role} on ${surface} is ${ratio.toFixed(2)}:1`);
    }
  }
});

test('text on a solid fill clears AA', () => {
  const pairs = [['--on-blue', '--blue'], ['--on-blue-2', '--blue'], ['--on-destructive', '--destructive']];
  for (const [text, fill] of pairs) {
    const ratio = contrast(resolve(text), resolve(fill));
    assert.ok(ratio >= AA, `${text} on ${fill} is ${ratio.toFixed(2)}:1`);
  }
});

test('the old token names still resolve to a colour', () => {
  for (const name of [
    '--bg-soft', '--panel', '--panel-strong', '--panel-alt', '--border', '--border-strong', '--text',
    '--text-muted', '--text-subtle', '--accent', '--accent-text', '--accent-ink', '--success', '--danger', '--focus',
  ]) {
    assert.match(resolve(name), /^#[0-9a-f]{6}$/i, name);
  }
});

test('old text names mean the same role as the new ones', () => {
  assert.equal(resolve('--text-muted'), resolve('--text-2'));
  assert.equal(resolve('--text-subtle'), resolve('--text-3'));
  assert.equal(resolve('--accent'), resolve('--blue'));
  assert.equal(resolve('--accent-text'), resolve('--blue-bright'));
});

test('every var() the tailwind config reads is declared in :root', () => {
  const config = fs.readFileSync(path.join(ROOT, 'tailwind.config.cjs'), 'utf8');
  const names = new Set([...config.matchAll(/var\((--[a-z0-9-]+)\)/g)].map((match) => match[1]));
  // the -rgb names are triplets, not colours
  for (const name of [...config.matchAll(/var\((--[a-z0-9-]+-rgb)\)/g)].map((match) => match[1])) names.add(name);
  const missing = [...names].filter((name) => !declared.has(name));
  assert.deepEqual(missing, []);
});

test('radii sit in the spec ranges and spacing steps are 4-point', () => {
  const px = (name) => Number(declared.get(name).replace('px', ''));
  assert.ok(px('--r-control') >= 8 && px('--r-control') <= 12);
  assert.ok(px('--r-card') >= 12 && px('--r-card') <= 16);
  assert.ok(px('--r-hero') >= 14 && px('--r-hero') <= 18);
  for (const [name] of declared) {
    if (/^--sp-\d+$/.test(name)) assert.equal(px(name) % 4, 0, `${name} is off the 4-point scale`);
  }
});
