import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

// The page shell's metadata: index.html and public/manifest.json.
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'manifest.json'), 'utf8'));

test('the viewport allows pinch zoom', () => {
  const viewport = html.match(/<meta[^>]+name="viewport"[^>]*>/)?.[0] || '';
  assert.ok(viewport, 'index.html carries a viewport meta');
  assert.ok(!/user-scalable\s*=\s*(no|0)/i.test(viewport), 'user-scalable must not be turned off');
  assert.ok(!/maximum-scale/i.test(viewport), 'maximum-scale must not cap zoom');
});

test('one theme colour, the app background', () => {
  const metas = html.match(/<meta[^>]+name="theme-color"[^>]*>/g) || [];
  assert.equal(metas.length, 1, 'index.html states theme-color exactly once');
  assert.match(metas[0], /content="#050505"/, 'the theme colour is the app background');
  assert.equal(manifest.theme_color, '#050505', 'manifest theme_color agrees with the meta');
});

test('each manifest icon is declared once per purpose, never both at once', () => {
  const purposes = new Map();
  for (const icon of manifest.icons) {
    const tokens = (icon.purpose || 'any').split(/\s+/).sort();
    assert.ok(!tokens.includes('any') || !tokens.includes('maskable'),
      `icon ${icon.src} must not claim any and maskable in one entry — a launcher that honours maskable crops it`);
    const key = `${icon.src}|${tokens.join(' ')}`;
    purposes.set(key, (purposes.get(key) || 0) + 1);
    assert.equal(purposes.get(key), 1, `icon ${icon.src} declares purpose '${icon.purpose}' more than once`);
  }
  for (const size of ['192x192', '512x512']) {
    const at = manifest.icons.filter((i) => i.sizes === size);
    assert.ok(at.some((i) => (i.purpose || 'any') === 'any'), `size ${size} has an any icon`);
    assert.ok(at.some((i) => i.purpose === 'maskable'), `size ${size} has a maskable icon`);
  }
});
