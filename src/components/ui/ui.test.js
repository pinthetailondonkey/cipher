import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UI_DIR = HERE;
const OUT = path.resolve(HERE, '..', '..', '..', 'node_modules', '.luit-ui-test');

// Build the primitives with the project's own bundler so the test imports the
// real modules — the way vite will import them — and render what the browser
// will render. Relative imports are bundled in; package deps stay external.
async function build(entries) {
  const raw = await import('rolldown');
  const { rolldown } = raw;
  const bundle = await rolldown({
    input: entries,
    external: (id) => !id.startsWith('.') && !path.isAbsolute(id),
    platform: 'node',
  });
  await bundle.write({
    dir: OUT,
    format: 'esm',
    entryFileNames: '[name].mjs',
    chunkFileNames: '[name]-chunk.js',
  });
}

const COMPONENT_FILES = fs.readdirSync(UI_DIR).filter((file) => file.endsWith('.jsx'));

test('every ui component file carries no hex colors — tokens only', () => {
  const hex = /#[0-9a-fA-F]{3,8}\b/;
  const hits = [];
  for (const file of COMPONENT_FILES.concat(['index.js', 'toast.js', 'modal.js'])) {
    for (const [index, line] of fs.readFileSync(path.join(UI_DIR, file), 'utf8').split('\n').entries()) {
      const noComment = line.split('//')[0].replace(/\/\*.*?\*\//g, '');
      if (hex.test(noComment)) hits.push(`${file}:${index + 1}: ${line.trim()}`);
    }
  }
  assert.deepEqual(hits, [], 'a hex slipped past the token sheet');
});

test('every ui component file carries no z-index literals — tokens only', () => {
  const literal = /z-\[\d+\]/;
  const hits = [];
  for (const file of COMPONENT_FILES.concat(['index.js', 'toast.js', 'modal.js'])) {
    for (const [index, line] of fs.readFileSync(path.join(UI_DIR, file), 'utf8').split('\n').entries()) {
      const noComment = line.split('//')[0];
      if (literal.test(noComment)) hits.push(`${file}:${index + 1}: ${line.trim()}`);
    }
  }
  assert.deepEqual(hits, [], 'a z-[...] literal slipped past the sheet');
});

test('the ui library labels stay inside the word bans', () => {
  const banned = /\b(nostr|relay|private key|seed)\b/i;
  const hits = [];
  for (const file of COMPONENT_FILES.concat(['index.js', 'toast.js', 'modal.js'])) {
    for (const [index, line] of fs.readFileSync(path.join(UI_DIR, file), 'utf8').split('\n').entries()) {
      if (banned.test(line)) hits.push(`${file}:${index + 1}: ${line.trim()}`);
    }
  }
  assert.deepEqual(hits, []);
});

// Three entries cover the whole library: the barrel carries every component,
// Skeleton ships row/list/grid/card presets beyond its default, and smoke
// renders the modal primitives through react-dom/server.
const INPUTS = {
  barrel: path.join(UI_DIR, 'index.js'),
  skeleton: path.join(UI_DIR, 'Skeleton.jsx'),
  toast: path.join(UI_DIR, 'toast.js'),
  smoke: path.join(UI_DIR, 'smoke.test.jsx'),
};

let imports = null;

test('every ui component builds and exports', async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  await build(INPUTS);

  imports = {};
  for (const name of Object.keys(INPUTS)) {
    imports[name] = await import(path.join(OUT, `${name}.mjs`).replaceAll('\\', '/'));
  }

  const barrelNames = [
    'Button', 'IconButton', 'Sheet', 'Dialog', 'Segmented', 'ListRow', 'Badge',
    'Chip', 'Skeleton', 'EmptyState', 'Toast', 'Switch', 'Keypad', 'Input',
    'Textarea', 'PinField', 'Avatar',
  ];
  for (const name of barrelNames) {
    assert.equal(typeof imports.barrel[name], 'function', `the barrel must export a ${name} component`);
  }
  assert.equal(typeof imports.barrel.pressable, 'string', 'the barrel must export the pressable util');
  assert.equal(typeof imports.barrel.pushToast, 'function');
  assert.equal(typeof imports.barrel.dropToast, 'function');
  assert.equal(typeof imports.barrel.useModalA11y, 'function');
  for (const [name, component] of Object.entries(imports.barrel)) {
    assert.ok(component !== undefined && component !== null, `barrel must re-export ${name}`);
  }
  assert.equal(typeof imports.skeleton.SkeletonRow, 'function');
  assert.equal(typeof imports.skeleton.SkeletonList, 'function');
  assert.equal(typeof imports.skeleton.SkeletonGrid, 'function');
  assert.equal(typeof imports.skeleton.SkeletonCard, 'function');
  // The queue is data, so tests can watch it while the component stays the
  // only renderer.
  imports.toast.pushToast({ type: 'success', message: 'test banner' });
  assert.equal(imports.toast.queued().at(-1).type, 'success');
  assert.equal(imports.toast.queued().at(-1).message, 'test banner');
  imports.toast.dropToast(imports.toast.queued().at(-1).id);
  assert.equal(imports.toast.queued().length, 0);
});

test('the sheet and the dialog render role=dialog, aria-modal', async () => {
  const { smoke, sheetHtml, dialogHtml } = imports.smoke;
  const html = smoke();
  const dialogCount = [...html.matchAll(/role="dialog"/g)].length;
  assert.equal(dialogCount, 2, 'Sheet and Dialog must each render role=dialog');
  assert.match(sheetHtml(), /aria-modal="true"/);
  assert.match(dialogHtml(), /aria-modal="true"/);
});

after(() => {
  fs.rmSync(OUT, { recursive: true, force: true });
});
