#!/usr/bin/env bash
# Scripted demo: full Phase 0 + Phase 1 flow against a throwaway git repo.
# Creates everything under a temp dir, prints each step, cleans nothing up
# so you can inspect the store and the proof pack afterwards.
set -euo pipefail

PROJECT="$(cd "$(dirname "$0")/.." && pwd)"
ANH="node $PROJECT/src/cli.ts"
ROOT="$(mktemp -d /tmp/anh-demo-XXXXXX)"
WS="$ROOT/workspace"
REPO="$ROOT/repo"
mkdir -p "$WS" "$REPO"

echo "== demo root: $ROOT"

GIT="git -c user.name=AnhDemo -c user.email=anh-demo@example.com"
$GIT -C "$REPO" init -q
printf 'hello base\n' > "$REPO/hello.txt"
$GIT -C "$REPO" add .
$GIT -C "$REPO" commit -qm base

echo "== 1. passport create"
$ANH passport create --agent demo-agent --owner demo-owner --harness cli-demo \
  --scope "local/repo|**|propose" --max-minutes 120 --workspace "$WS" --json > "$ROOT/passport.json"
PASS_ID=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$ROOT/passport.json','utf8')).id)")
echo "passport: $PASS_ID"

echo "== 2. intent create"
$ANH intent create --goal "make hello say fixed" \
  --criterion "hello.txt contains fixed|grep -q fixed hello.txt" \
  --by demo --workspace "$WS" --json > "$ROOT/intent.json"
INTENT_ID=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$ROOT/intent.json','utf8')).id)")
echo "intent: $INTENT_ID"

echo "== 3. intent claim"
$ANH intent claim --id "$INTENT_ID" --passport "$PASS_ID" --workspace "$WS"

echo "== 4. workroom create (real git worktree and branch)"
$ANH workroom create --intent "$INTENT_ID" --passport "$PASS_ID" --repo "$REPO" \
  --branch anh/fix-hello --workspace "$WS" --json > "$ROOT/workroom.json"
WR_ID=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$ROOT/workroom.json','utf8')).id)")
WT=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$ROOT/workroom.json','utf8')).worktreePath)")
echo "workroom: $WR_ID at $WT"

echo "== 5. agent work: one commit in the worktree"
printf 'hello fixed\n' > "$WT/hello.txt"
$GIT -C "$WT" add .
$GIT -C "$WT" commit -qm "fix hello"

mkdir -p "$ROOT/results"
printf '{"test-hello":"fail"}' > "$ROOT/results/base.json"
printf '{"test-hello":"pass"}' > "$ROOT/results/head.json"

echo "== 6. proofpack bundle (fleet gates where available, UNKNOWN where not)"
$ANH proofpack bundle --workroom "$WR_ID" --results-dir "$ROOT/results" \
  --repro-cmd "grep -q fixed hello.txt" --workspace "$WS" --json > "$ROOT/pack.json"
PACK_ID=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$ROOT/pack.json','utf8')).id)")
PACK_FILE="$WS/.anh/proofpacks/$PACK_ID.json"
echo "pack: $PACK_ID"
echo "pack file: $PACK_FILE"

echo "== 7. proofpack verify"
$ANH proofpack verify --file "$PACK_FILE" --workspace "$WS"

echo "== 8. inbox list"
$ANH inbox list --workspace "$WS"

echo "== 9. review decide (approve) and reputation event"
$ANH review decide --pack "$PACK_ID" --decision approve --reviewer demo-reviewer --workspace "$WS"

echo "== 10. inbox after decision"
$ANH inbox list --workspace "$WS"

echo "== demo done. Store: $WS/.anh  Pack: $PACK_FILE"
