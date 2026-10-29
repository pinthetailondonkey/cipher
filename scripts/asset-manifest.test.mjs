import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { collectAssetFiles, writeManifest, verifyManifest, MANIFEST_NAME } from './asset-manifest.mjs';

async function fixture(assets) {
  const dir = await mkdtemp(path.join(tmpdir(), 'cipher-manifest-'));
  if (assets !== null) {
    await mkdir(path.join(dir, 'assets'), { recursive: true });
    for (const name of assets) await writeFile(path.join(dir, 'assets', name), 'x');
  }
  return dir;
}

test('the manifest names every file the build produced under /assets, sorted', async () => {
  const dir = await fixture(['b.css', 'a.js', 'z.woff2']);
  try {
    assert.deepEqual(await collectAssetFiles(dir), ['/assets/a.js', '/assets/b.css', '/assets/z.woff2']);
    const manifest = await writeManifest(dir);
    assert.deepEqual(manifest, { version: 1, files: ['/assets/a.js', '/assets/b.css', '/assets/z.woff2'] });
    const onDisk = JSON.parse(await readFile(path.join(dir, MANIFEST_NAME), 'utf8'));
    assert.deepEqual(onDisk.files, manifest.files);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the written manifest verifies against the build it was made from', async () => {
  const dir = await fixture(['one.js', 'two.js']);
  try {
    await writeManifest(dir);
    assert.deepEqual(await verifyManifest(dir), { ok: true, missingFromManifest: [], notInBuild: [] });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a file present but unlisted fails, because it would never be cached', async () => {
  const dir = await fixture(['one.js']);
  try {
    await writeManifest(dir);
    await writeFile(path.join(dir, 'assets', 'late-chunk.js'), 'x');
    const check = await verifyManifest(dir);
    assert.equal(check.ok, false);
    assert.deepEqual(check.missingFromManifest, ['/assets/late-chunk.js']);
    assert.deepEqual(check.notInBuild, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a name listed that the build did not produce fails, because it would be asked for and missing', async () => {
  const dir = await fixture(['one.js']);
  try {
    await writeManifest(dir);
    await rm(path.join(dir, 'assets', 'one.js'));
    const check = await verifyManifest(dir);
    assert.equal(check.ok, false);
    assert.deepEqual(check.notInBuild, ['/assets/one.js']);
    assert.deepEqual(check.missingFromManifest, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a build with no assets directory produces an empty manifest rather than a crash', async () => {
  const dir = await fixture(null);
  try {
    assert.deepEqual(await collectAssetFiles(dir), []);
    const manifest = await writeManifest(dir);
    assert.deepEqual(manifest.files, []);
    assert.equal((await verifyManifest(dir)).ok, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a missing manifest is reported, not thrown', async () => {
  const dir = await fixture(['one.js']);
  try {
    const check = await verifyManifest(dir);
    assert.equal(check.ok, false);
    assert.equal(check.missingManifest, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
