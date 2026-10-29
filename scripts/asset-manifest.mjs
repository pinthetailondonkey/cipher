// Writes dist/asset-manifest.json: every file the build put under /assets/.
//
// The service worker caches an asset only after it has been fetched, so a
// person who loses signal before opening a screen never downloads that
// screen's code and cannot open the app offline. A hand-written list of the
// modules that might be needed is not a fix — it is a promise that has to be
// kept on every future lazy import, and its failure mode is a locked-out
// person with no network. The list is generated from the build instead, so a
// new lazy import is covered the day it lands.
//
// No dependency: this reads a directory the build already produced.
import { readdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const MANIFEST_NAME = 'asset-manifest.json';

// Every regular file directly under <dist>/assets, as an absolute path on the
// site, sorted so the manifest is stable between builds of the same input.
export async function collectAssetFiles(distDir) {
  let entries;
  try {
    entries = await readdir(path.join(distDir, 'assets'), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => `/assets/${entry.name}`)
    .sort();
}

export async function writeManifest(distDir) {
  const files = await collectAssetFiles(distDir);
  const manifest = { version: 1, files };
  await writeFile(path.join(distDir, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

// The both-directions check: a file the build produced but the manifest does
// not name would never be cached, and a name the build did not produce would
// make the service worker ask for something that is not there.
export async function verifyManifest(distDir) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(path.join(distDir, MANIFEST_NAME), 'utf8'));
  } catch {
    return { ok: false, missingManifest: true, missingFromManifest: [], notInBuild: [] };
  }
  const listed = new Set(Array.isArray(manifest?.files) ? manifest.files : []);
  const present = new Set(await collectAssetFiles(distDir));
  const missingFromManifest = [...present].filter((file) => !listed.has(file)).sort();
  const notInBuild = [...listed].filter((file) => !present.has(file)).sort();
  return { ok: missingFromManifest.length === 0 && notInBuild.length === 0, missingFromManifest, notInBuild };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const distDir = process.argv[2] || 'dist';
  const manifest = await writeManifest(distDir);
  console.log(`[assets] ${manifest.files.length} files listed in ${path.join(distDir, MANIFEST_NAME)}`);
}
