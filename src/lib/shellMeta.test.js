import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

// The page shell's metadata: index.html and public/manifest.json.
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

test('the viewport allows pinch zoom', () => {
  const viewport = html.match(/<meta[^>]+name="viewport"[^>]*>/)?.[0] || '';
  assert.ok(viewport, 'index.html carries a viewport meta');
  assert.ok(!/user-scalable\s*=\s*(no|0)/i.test(viewport), 'user-scalable must not be turned off');
  assert.ok(!/maximum-scale/i.test(viewport), 'maximum-scale must not cap zoom');
});
