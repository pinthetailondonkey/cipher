import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const BUILD_ID_PLACEHOLDER = '__BUILD_ID__';

// The shell cache name carries the build, so a deploy's activate step deletes
// every earlier build's cache instead of reusing one fixed name forever. The id
// is a hash of the built index.html, which names every hashed asset, so it
// changes exactly when the build does.
export function stampServiceWorker(source, indexHtml) {
  if (!source.includes(BUILD_ID_PLACEHOLDER)) {
    throw new Error(`sw.js has no ${BUILD_ID_PLACEHOLDER} to stamp`);
  }
  const id = crypto.createHash('sha256').update(indexHtml).digest('hex').slice(0, 12);
  return source.split(BUILD_ID_PLACEHOLDER).join(id);
}

export function stampServiceWorkerFile(outDir) {
  const swPath = path.join(outDir, 'sw.js');
  const html = fs.readFileSync(path.join(outDir, 'index.html'), 'utf8');
  fs.writeFileSync(swPath, stampServiceWorker(fs.readFileSync(swPath, 'utf8'), html));
}
