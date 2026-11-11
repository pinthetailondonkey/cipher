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

// The entry chunk and its static-import closure, one level deep: the built
// HTML names the entry with a script tag, and each built chunk names its own
// static imports in import statements the bundler rewrote to /assets/ names.
// Reading the graph out of the produced files keeps every name a file the
// build actually emitted; a hand-listed chunk is the 404 that waits for a
// cold load. One level is the point: the browser's own resolver fetches the
// next level the moment it parses the first, on its own connection pool.
export async function entryPreloadList(files, html, distDir) {
  const chunks = files.filter((file) => file.endsWith('.js'));
  const entry = html.match(/<script\b[^>]*\bsrc="(\/assets\/[^"]+\.js)"/)?.[1] || null;
  if (!entry || !chunks.includes(entry)) return [];
  const seen = new Set([entry]);
  const imports = new Set();
  const scan = async (chunk) => {
    for (const match of (await readChunkSource(distDir, chunk)).matchAll(/(?:^|[^\w.])import[\s(]*"(\.[^"]+\.js)"/g)) {
      const resolved = path.posix.join(path.posix.dirname(chunk), match[1]);
      if (chunks.includes(resolved) && !imports.has(resolved)) {
        imports.add(resolved);
        await scan(resolved);
      }
    }
  };
  await scan(entry);
  return [entry, ...imports];
}

// One built chunk's source, from dist. Chunk paths are /assets/ URLs; the
// missing-extension form readChunkSource resolves keeps the caller honest:
// only files collectAssetFiles listed are ever read.
import { readFile as readNodeFile } from 'node:fs/promises';
function readChunkSource(distDir, assetPath) {
  return readNodeFile(path.join(distDir, assetPath.replace(/^\//, '')), 'utf8');
}

export async function writeManifest(distDir) {
  const files = await collectAssetFiles(distDir);
  const manifest = { version: 1, files };
  await writeFile(path.join(distDir, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`);
  // Slow links start three fetches before any code runs: HTML, then the
  // entry chunk, then its imports. The preload hints move the entry's
  // static imports onto the HTML fetch's connection pool, which is the
  // only parallelism a cold load gets before the module graph exists.
  const htmlPath = path.join(distDir, 'index.html');
  try {
    const html = await readFile(htmlPath, 'utf8');
    const preloadTargets = await entryPreloadList(files, html, distDir);
    if (preloadTargets.length) {
      const hints = preloadTargets.map((file) => `<link rel="modulepreload" href="${file}" />`).join('\n    ');
      const rewritten = html.replace('</head>', `    ${hints}\n  </head>`);
      await writeFile(htmlPath, rewritten);
    }
  } catch (error) {
    console.error('[assets] Could not inject modulepreload hints:', error);
  }
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
