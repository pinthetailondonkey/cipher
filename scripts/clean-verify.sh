#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

if ! git diff --quiet; then
  printf '%s\n' 'Refusing clean verification: the working tree has unstaged tracked changes.' >&2
  exit 2
fi
if [[ -n "$(git ls-files --others --exclude-standard)" ]]; then
  printf '%s\n' 'Refusing clean verification: the working tree has untracked files.' >&2
  exit 2
fi
git diff --cached --check

# Signal-file guard (plan v2 §5 I12): a changed AGENTS.md signal file must
# carry a recorded reason in the guard's ledger, or clean verification stops.
node scripts/signal-file-guard.mjs

run_base="${CIPHER_CLEAN_VERIFY_ROOT:-/home/aegis/.cache/cipher-clean-verify}"
mkdir -p "$run_base"
run_dir="$(mktemp -d "$run_base/run.XXXXXX")"
worktree="$run_dir/worktree"
mkdir "$worktree"
mkdir -p "$repo_root/docs/evidence"

run_id="$(date -u +%Y%m%dT%H%M%SZ)"
log_path="$repo_root/docs/evidence/clean-verify-$run_id.log"
manifest_path="$repo_root/docs/evidence/clean-verify-$run_id.json"
aggregate_log="$run_dir/clean-verify.log"
head_oid="$(git rev-parse HEAD)"
index_tree="$(git write-tree)"
tracked_count="$(git ls-files | wc -l | tr -d ' ')"

git checkout-index -a --prefix="$worktree/"
if [[ -e "$worktree/.grok/app-env.json" ]]; then
  printf '%s\n' 'The clean index export unexpectedly contains .grok/app-env.json; refusing to run a build that carries its secret configuration.' >&2
  rm -rf "$run_dir"
  exit 2
fi

declare -a result_names=()
declare -a result_codes=()
failed=0

run_check() {
  local name="$1"
  shift
  local output="$run_dir/$name.log"
  local code=0
  printf 'Running %s\n' "$name"
  if (cd "$worktree" && "$@") >"$output" 2>&1; then
    code=0
  else
    code=$?
    failed=1
  fi
  result_names+=("$name")
  result_codes+=("$code")
  {
    printf '\n===== %s (exit %s) =====\n' "$name" "$code"
    cat "$output"
    printf '\n'
  } >>"$aggregate_log"
  if [[ "$code" -eq 0 ]]; then
    printf 'PASS %s\n' "$name"
  else
    printf 'FAIL %s (exit %s); see %s\n' "$name" "$code" "$log_path"
    tail -n 60 "$output"
  fi
}

run_check npm_ci npm ci
run_check lint npm run lint
run_check build npm run build
run_check unit npm test
if [[ "$failed" -eq 0 ]]; then
  run_check protocol_unit npm run test:protocol-mode
  run_check protocol_build env VITE_PROTOCOL_TEST_RELAYS=ws://127.0.0.1:18888 npm run build:protocol-test
  run_check protocol_browser npm run test:protocol-mode-browser
fi

cat "$aggregate_log" >"$log_path"
# Preserve readable runner output while avoiding ANSI table padding making the
# retained evidence fail git's whitespace check. The digest below covers these
# exact normalized bytes.
sed -i 's/[[:blank:]]*$//' "$log_path"
perl -0pi -e 's/\n+\z/\n/' "$log_path"
log_hash="$(sha256sum "$log_path" | awk '{print $1}')"
results_json=""
for index in "${!result_names[@]}"; do
  results_json+="${result_names[$index]}=${result_codes[$index]}"$'\n'
done

ROOT_PATH="$repo_root" \
MANIFEST_PATH="$manifest_path" \
RUN_ID="$run_id" \
HEAD_OID="$head_oid" \
INDEX_TREE="$index_tree" \
TRACKED_COUNT="$tracked_count" \
LOG_PATH="$log_path" \
LOG_HASH="$log_hash" \
RESULTS="$results_json" \
OVERALL_STATUS="$([[ "$failed" -eq 0 ]] && printf pass || printf fail)" \
node --input-type=module -e '
import { writeFile } from "node:fs/promises";
const results = process.env.RESULTS.trim().split("\n").filter(Boolean).map((entry) => {
  const split = entry.lastIndexOf("=");
  return { check: entry.slice(0, split), exit_code: Number(entry.slice(split + 1)) };
});
const manifest = {
  run_id: process.env.RUN_ID,
  status: process.env.OVERALL_STATUS,
  head: process.env.HEAD_OID,
  index_tree: process.env.INDEX_TREE,
  tracked_paths: Number(process.env.TRACKED_COUNT),
  source: "git checkout-index export of the staged index",
  checks: results,
  combined_log: process.env.LOG_PATH,
  combined_log_sha256: process.env.LOG_HASH,
  combined_log_normalization: "trailing horizontal whitespace removed per line; ANSI sequences retained",
  guard_carrier: "The exported index contains tracked files only; ignored or untracked local build carriers are excluded.",
};
await writeFile(process.env.MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
'

printf 'Manifest: %s\nCombined log SHA-256: %s\n' "$manifest_path" "$log_hash"
rm -rf "$run_dir"
exit "$failed"
