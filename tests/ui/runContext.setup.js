import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';

// This project runs before every browser spec. Its job is to refuse to test
// the wrong thing: a bundle built without the test seam, a page served from a
// server this run did not start, or a tree that moved since the run began.
// Evidence beats assumption, so the record it writes says which SHA, which
// build and which port actually answered.

const PORT = 8081;

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

test('the run has one known SHA, one build, one port', async ({ request }) => {
  const head = git(['rev-parse', 'HEAD']);
  const dirty = git(['status', '--porcelain']).length > 0;

  const response = await request.get(`http://localhost:${PORT}/`);
  expect(response.ok(), `nothing answered on port ${PORT}`).toBe(true);
  const html = await response.text();

  const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]);
  expect(assets.length, 'the served page names no built assets').toBeGreaterThan(0);

  let seam = false;
  for (const asset of assets.filter((path) => path.endsWith('.js'))) {
    const body = await (await request.get(`http://localhost:${PORT}${asset}`)).text();
    if (body.includes('__cipherStore')) seam = true;
  }
  // A shipping build carries no seam. Running the specs against one would make
  // every seeding step silently do nothing, so this is a failure, not a warning.
  expect(seam, 'the served bundle has no test seam: build with npm run build:ui-test').toBe(true);

  const record = {
    sha: head,
    dirty,
    port: PORT,
    builtAt: new Date().toISOString(),
    assets,
    testSeam: seam,
  };
  mkdirSync('test-results', { recursive: true });
  writeFileSync('test-results/run-context.json', `${JSON.stringify(record, null, 2)}\n`);

  // Printed, not merely stored: the run's own log then carries the SHA.
  console.log(`[run-context] sha=${head} dirty=${dirty} port=${PORT} assets=${assets.length}`);
  expect(readFileSync('test-results/run-context.json', 'utf8')).toContain(head);
});
