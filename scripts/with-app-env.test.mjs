import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import {
  APP_ENV_REL_PATH,
  mergeAppEnv,
  parseAppEnv,
  projectRoot,
  readAppEnv,
} from "./with-app-env.mjs";

const execFileAsync = promisify(execFile);
const WRAPPER = join(projectRoot(), "scripts/with-app-env.mjs");
const PRINT_FLAG = "process.stdout.write(String(process.env.VITE_AUTH_ENABLED));";

// The wrapper resolves its root from its own path, so a copy of it inside a
// scratch directory reads that directory's .grok/app-env.json and nothing
// else. The tests below use this instead of the repo's own app-env file: that
// file is untracked, so a test reading it is green on a machine that has one
// and red on a clean checkout — which is how three of these tests passed for
// months on one box and would have failed in CI the first day it ran.
// The parent process's own env, minus the key under test, so a machine that
// happens to export VITE_AUTH_ENABLED cannot decide a result here.
function cleanEnv() {
  const env = { ...process.env };
  delete env.VITE_AUTH_ENABLED;
  return env;
}

function fixture(t, appEnvJson) {
  const root = mkdtempSync(join(tmpdir(), "app-env-root-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "scripts"), { recursive: true });
  copyFileSync(WRAPPER, join(root, "scripts", "with-app-env.mjs"));
  if (appEnvJson !== undefined) {
    mkdirSync(join(root, ".grok"), { recursive: true });
    writeFileSync(join(root, APP_ENV_REL_PATH), appEnvJson);
  }
  return { root, wrapper: join(root, "scripts", "with-app-env.mjs") };
}

function makeWorkspace(appEnvJson) {
  const root = mkdtempSync(join(tmpdir(), "app-env-"));
  if (appEnvJson !== undefined) {
    mkdirSync(join(root, ".grok"), { recursive: true });
    writeFileSync(join(root, APP_ENV_REL_PATH), appEnvJson);
  }
  return root;
}

test("keeps VITE_-prefixed string entries", () => {
  assert.deepEqual(parseAppEnv('{"VITE_AUTH_ENABLED":"false"}'), {
    VITE_AUTH_ENABLED: "false",
  });
});

test("drops non-VITE keys, non-string values and malformed documents", () => {
  assert.deepEqual(parseAppEnv('{"DATABASE_URL":"postgres://x","VITE_N":1,"VITE_OK":"y"}'), {
    VITE_OK: "y",
  });
  assert.deepEqual(parseAppEnv("not json"), {});
  assert.deepEqual(parseAppEnv('["VITE_AUTH_ENABLED"]'), {});
  assert.deepEqual(parseAppEnv("null"), {});
});

test("a missing app-env.json is a clean no-op", () => {
  assert.deepEqual(readAppEnv(makeWorkspace()), {});
});

test("reads the app env from a workspace", () => {
  const root = makeWorkspace('{"VITE_AUTH_ENABLED":"false"}');
  assert.deepEqual(readAppEnv(root), { VITE_AUTH_ENABLED: "false" });
});

test("an explicit process-env override wins over the file", () => {
  const merged = mergeAppEnv(
    { VITE_AUTH_ENABLED: "false" },
    { VITE_AUTH_ENABLED: "true", PATH: "/usr/bin" },
  );
  assert.equal(merged.VITE_AUTH_ENABLED, "true");
  assert.equal(merged.PATH, "/usr/bin");
});

test("the wrapper reads the root it lives in, and only that root", async (t) => {
  // A copy of the wrapper in a scratch root reads that root's app env. The
  // point of running the copy rather than the repo's own script: this asserts
  // the wrapper's rule, not the state of an untracked file on one machine.
  const lit = fixture(t, '{"VITE_AUTH_ENABLED":"false"}');
  const { stdout } = await execFileAsync(process.execPath, [lit.wrapper, process.execPath, "-e", PRINT_FLAG], { env: cleanEnv() });
  assert.equal(stdout, "false");
  // And a root with no file is the clean no-op, not an inherited value: the
  // repo's own app-env cannot leak into it.
  const dark = fixture(t);
  const none = await execFileAsync(process.execPath, [dark.wrapper, process.execPath, "-e", PRINT_FLAG], { env: cleanEnv() });
  assert.equal(none.stdout, "undefined");
});

test("vite loadEnv resolves the wrapped value", () => {
  // What `import.meta.env.VITE_AUTH_ENABLED` becomes: loadEnv prefix-matches
  // process.env, so the wrapper's merge has to land before Vite starts.
  // Do not `import { loadEnv } from "vite"` here — Vite 8 loads rolldown
  // native bindings that SIGSEGV the test worker under qemu-user.
  const root = makeWorkspace('{"VITE_AUTH_ENABLED":"false"}');
  const merged = mergeAppEnv(readAppEnv(root), { PATH: "/usr/bin" });
  assert.equal(merged.VITE_AUTH_ENABLED, "false");
});

test("the wrapped command runs with the app env applied", async (t) => {
  const { wrapper } = fixture(t, '{"VITE_AUTH_ENABLED":"false"}');
  const { stdout } = await execFileAsync(process.execPath, [wrapper, process.execPath, "-e", PRINT_FLAG], { env: cleanEnv() });
  assert.equal(stdout, "false");
});

test("the wrapped command sees an explicit override, not the file value", async (t) => {
  const { wrapper } = fixture(t, '{"VITE_AUTH_ENABLED":"false"}');
  const { stdout } = await execFileAsync(
    process.execPath,
    [wrapper, process.execPath, "-e", PRINT_FLAG],
    { env: { ...cleanEnv(), VITE_AUTH_ENABLED: "true" } },
  );
  assert.equal(stdout, "true");
});

test("the wrapper propagates the command's exit code", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [WRAPPER, process.execPath, "-e", "process.exit(3)"]),
    (err) => err.code === 3,
  );
});

test("a signal-killed command is never reported as success", async () => {
  // The wrapper's own SIGTERM handler must not swallow the re-raised signal:
  // a cancelled build reporting exit 0 is a silently passing gate.
  await assert.rejects(
    execFileAsync(process.execPath, [
      WRAPPER,
      process.execPath,
      "-e",
      "process.kill(process.pid, 'SIGTERM');setTimeout(() => {}, 1000);",
    ]),
    (err) => err.signal === "SIGTERM" || err.code !== 0,
  );
});

test("the CLI still runs when invoked through a symlinked path", async (t) => {
  // node realpaths import.meta.url but not process.argv[1], so a raw comparison
  // turns the wrapper into a no-op that exits 0 without starting anything.
  const { root } = fixture(t, '{"VITE_AUTH_ENABLED":"false"}');
  const linkDir = mkdtempSync(join(tmpdir(), "app-env-link-"));
  t.after(() => rmSync(linkDir, { recursive: true, force: true }));
  const link = join(linkDir, "scripts");
  symlinkSync(join(root, "scripts"), link);
  const { stdout } = await execFileAsync(process.execPath, [join(link, "with-app-env.mjs"), process.execPath, "-e", PRINT_FLAG], { env: cleanEnv() });
  assert.equal(stdout, "false");
});
