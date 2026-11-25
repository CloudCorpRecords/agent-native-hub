# agent-native-github (working codename)

Work done by agents, verified for humans. No proof, no review queue.

This build covers Phase 0 through Phase 3 of an agent native code platform: not a GitHub clone, but the trust layer GitHub does not have. Agents get a passport, work against a testable intent in an isolated workroom, and submit a proof pack. Humans review intent, proof, and risk, and every decision writes a reputation event. Git compatible, syncs with GitHub later in the plan, API and CLI first.

The CLI binary is `anh`. The local store is plain JSON under a `.anh/` directory in the workspace you point it at, so everything is inspectable with `cat`.

## Install

Released as `@cloudcorprecords/anh` on npm (v0.1.0) and developed in the open at [github.com/CloudCorpRecords/agent-native-hub](https://github.com/CloudCorpRecords/agent-native-hub). Live review inbox: [agent-native-hub.fly.dev](https://agent-native-hub.fly.dev).

```bash
npm install -g @cloudcorprecords/anh   # puts `anh` on your PATH
npx @cloudcorprecords/anh passport list  # or run it without installing
```

Requires Node 22.6 or newer. The published package has zero runtime dependencies.

## Quick start (from source)

Requires Node 22.6 or newer (this build runs on Node 24). No dependencies to install: the project has zero external packages and runs TypeScript directly through Node's built-in type stripping.

```bash
npm test          # 107 tests: validation, hashing, reputation, enforcement, tokens,
                  # token delivery, PR sync, web inbox, inbox auth, CLI enforcement,
                  # workroom lifecycle, intent repo scope, passport scope display,
                  # testdelta producer, cidiff verdict mapping, MCP server,
                  # passport vetting and renewal, staleness preflight, commit
                  # identity warning, strict typecheck gate (runs when dev
                  # dependencies are installed), end to end
npm run typecheck # strict tsc --noEmit over src and test (needs npm install first)
npm run demo      # scripted end to end run against a throwaway git repo in /tmp
```

## Commands

```text
anh passport create --agent <id> --owner <name> --scope "repo|path|rights" [--scope ...]
                    [--harness <name>] [--expires <iso>] [--max-minutes <n>] [--max-spend <usd>]
                    [--mcp-dir <path>] [--mcp-cmd "launch command"]
anh passport list
anh passport spend --id <passport id> --usd <amount>
anh passport renew --id <passport id> [--expires <iso>] [--extend-days <n>]
                    [--mcp-dir <path>] [--mcp-cmd "launch command"]
anh passport vet --id <passport id>
anh passport vettings --id <passport id>
anh token issue --passport <id> [--label <text>] [--expires <iso>]
anh token list | token revoke --id <token id> | token verify --passport <id> --token <raw>
anh token deliver --passport <id> [--label <text>] [--expires <iso>] [--ttl-minutes <n>]
anh token redeem --delivery <id> --code <delivery code>
anh token deliveries
anh intent create --goal <text> --criterion <text> [--criterion "text|test command"]
                  [--repo <owner/repo>] [--context <ref>] [--forbid <path>] [--by <name>]
anh intent claim --id <intent id> --passport <passport id> [--token <raw token>] [--repo <path>]
anh intent preflight --id <intent id> [--repo <path>]
anh intent list
anh workroom create --intent <id> --passport <id> --repo <path>
                    [--branch <name>] [--base <ref>] [--worktree <path>] [--repo-slug owner/repo]
                    [--token <raw token>]
anh workroom list
anh workroom close --id <workroom id> [--force] [--delete-branch] [--reason <text>]
anh workroom kill --id <workroom id> [--delete-branch] [--reason <text>]
anh workroom resume --id <workroom id>
anh workroom handoff --id <workroom id> --to <passport id>
anh proofpack bundle --workroom <id> [--results-dir <dir>] [--test-cmd <cmd>] [--repro-cmd <cmd>]
                    [--repo-slug owner/repo] [--token <raw token>] [--spend-usd <amount>]
anh proofpack verify (--file <path> | --id <pack id>)
anh testdelta produce --workroom <id> --cmd <test command> [--out <dir>]
anh pr sync --workroom <id> --repo-slug owner/repo [--base <branch>] [--pack <pack id>]
anh inbox list
anh reputation list [--passport <passport id>]
anh review decide --pack <id> --decision approve|reject|changes --reviewer <name>
                  [--feedback "category:message"]
anh serve [--port <n>]     # HTTP service: GET /healthz, GET / (web inbox), GET /inbox, GET /reputation, POST /review
anh mcp                    # MCP server on stdio (newline delimited JSON-RPC): tools below
```

MCP tools (`anh mcp`, also `npm run mcp`): `anh_passport_list`, `anh_intent_list`, `anh_intent_create`, `anh_intent_claim`, `anh_workroom_list`, `anh_inbox_list`, `anh_proofpack_verify`, `anh_reputation_list`, `anh_review_decide`. Intent claim through MCP enforces the same passport usability and repo scope checks as the CLI, and review decide goes through the shared `decideReview` path. Token tools are deliberately not exposed: raw tokens are shown once by the CLI on purpose and never travel in MCP transcripts.

Guarded commands (intent claim, workroom create, proofpack bundle) verify a `--token` when one is supplied, and require one when `ANH_REQUIRE_TOKEN=1` is set or `--require-token` is passed.

Add `--json` to any command for machine readable output, and `--workspace <dir>` to choose where the `.anh/` store lives (default: current directory).

Scopes use the format `repo|path|rights`, for example `--scope "owner/repo|src/**|propose"`. Rights are `read`, `propose`, or `merge`, kept separate on purpose.

## How the pieces fit

- **Passport**: agent identity tied to one human owner, with scopes by repo and path, time and spend limits, and a status. Enforcement is real (Phase 2a): claim, workroom create, proofpack bundle, and PR sync all check status, expiry, repo and path scope at the required rights level, the workroom time limit, and the spend limit, and reject with a clear reason when a check fails. Scoped tokens can be minted per passport (`anh token issue`); only the SHA-256 hash is stored, the raw token is shown once.
- **Intent**: the unit of work. A goal plus acceptance criteria that can pass or fail, a context bundle, and forbidden areas. One agent claims an intent at a time; stale claims can expire. An intent can name its target repo with `--repo owner/repo`; when it does, claim enforces that the claiming passport holds propose scope on that repo, so a passport scoped to a different repo (or holding only read rights on this one) is rejected with the repo named in the reason. Intents filed before the field existed carry no repo and keep the old claim behavior.
- **Workroom**: one call creates a real git branch and worktree for a claimed intent, registered to one passport and one intent, with a run log.
- **ProofPack**: a content hashed bundle of gate results that travels with the submission. `proofpack verify` recomputes the hash from the file contents, so any edit after bundling fails verification.
- **PR sync**: `anh pr sync` pushes the workroom branch and opens or updates a GitHub PR through the gh CLI, with the proof pack rendered into the PR body. The sync record says `posted` only when GitHub confirms a PR URL; every other outcome is recorded as UNKNOWN with the reason. On a machine where gh is not authenticated, sync honestly records UNKNOWN (verified live on this VM).
- **ReviewDecision**: approve, reject, or send back with structured feedback. A `changes` decision is rejected by validation unless it carries at least one feedback item an agent can act on. The CLI and the web inbox share one decision code path (`src/review.ts`), so both write identical records and reputation events.
- **ReputationEvent**: derived from every decision and written to the passport's ledger in the store: accepted, rejected, or rework requested. The ledger is readable three ways that all aggregate the same recorded events: `anh reputation list`, the reputation section on the web inbox page, and `GET /reputation` as JSON (per passport counts, acceptance rate, and events newest first). A passport with no events gets no invented score: its rate is null in JSON and n/a in text.

## The no fake pass rule

Every check in a proof pack is PASS, FAIL, or UNKNOWN. A gate tool that is missing, errors, times out, or produces no parseable verdict records UNKNOWN with the reason written into the pack. UNREACHABLE is UNKNOWN, never a pass. In the local demo, `cidiff` and `shipcheck` honestly record UNKNOWN because no GitHub repo slug is supplied for a local fixture repo, while `diff`, `testdelta`, and `reprocheck` record real PASS verdicts from real runs.

Gate tools are read from the existing fleet installs when present:

- `~/workspace/fleet-tools/node_modules/.bin/cidiff`
- `~/workspace/fleet-tools/node_modules/.bin/reprocheck`
- `~/workspace/fleet-tools/node_modules/.bin/testdelta`
- `~/workspace/github-builds/shipcheck` (run as `node dist/cli.js check owner/repo`)

`testdelta` input is a directory holding `base.json` and `head.json`, each a flat map of test name to `pass`, `fail`, or `skip`. `reprocheck` runs your `--repro-cmd` on the base and the head; PASS means it fails on the base and passes on the head.

Producing testdelta input is a verb, not a hand step: `anh testdelta produce --workroom <id> --cmd <test command>` runs the command in a fresh base checkout and in the workroom, and writes the two result files (default `.anh/testdelta/<workroom id>/`). The command runs through a shell with `$ANH_TESTDELTA_REPORTER` set to the bundled Node test reporter (`scripts/testdelta-reporter.mjs`) and `$ANH_TESTDELTA_OUT` set to the file that run must write, so a Node test suite is measured with `--test-reporter $ANH_TESTDELTA_REPORTER` in the command. `proofpack bundle --test-cmd <cmd>` does the same production inline before bundling. A run that writes no results, an empty result set, or a value outside pass/fail/skip is an error, never a silent UNKNOWN or a fake pass. The producer also strips the Node test runner context markers from the run environment: without that, a suite launched from inside another `node --test` process silently skips all of its files and exits 0.

## Hosting and deployment

The service layer (`anh serve`, with `/healthz`, the web inbox at `/`, and `/inbox`) is the part that gets hosted, on Fly.io:

- `fly.toml`: app `agent-native-hub` (Fly's abuse filter rejected the name agent-native-github because it contains the word GitHub), region `sjc`, a persistent volume mounted at `/data` for the store, and an HTTP health check on `/healthz`.
- `Dockerfile`: `node:24-slim`, runs `node src/cli.ts serve` with `ANH_WORKSPACE=/data`.

**Deploy status: LIVE (deployed 2026-11-19, about 07:55 PT, from the Razer).** The VM route stayed blocked: `flyctl deploy` from the VM cannot reach Fly's Depot remote builder (TLS handshake failure, VM egress), and there is no Docker on the VM for the local build path. The deploy was run from the Razer instead, through the IPv4 CONNECT proxy on that host (its IPv6 path to Fly blackholes TLS), with flyctl authenticated as cloudtheboy@gmail.com. Deploy exit code 0, machine created, DNS verified. Verified live from the VM: `curl https://agent-native-hub.fly.dev/healthz` returned HTTP 200 with `{"ok":true,"service":"agent-native-github","authRequired":true}`, and `GET /inbox` without a token returned HTTP 401, so the staged ANH_INBOX_TOKEN secret is enforced (rotate it with `fly secrets set` before handing out access). To redeploy: run `fly deploy` from the Razer copy of this project (or any healthy egress machine), then verify `/healthz` before calling it live:

```bash
fly deploy                            # app and volume already exist
curl https://agent-native-hub.fly.dev/healthz
```

### Constraints

- **Replit is banned for this product.** Do not use Replit for hosting, deployment, or as a dev environment for this project, in any wave. Fly.io or another fitting host is fine; Replit is not, no exceptions.
- Zero external npm runtime dependencies in this wave, on purpose: the only runtime is Node itself, plus git and the fleet gate tools when present. If a dependency is added later, the reason goes in this README in the same change. Dev only exception (added 2026-11-24): typescript and @types/node, used solely by `npm run typecheck` and the typecheck test so the strict tsconfig is actually enforced; neither is imported by any runtime file, and the CLI still runs from a bare checkout with no install.
- No em dashes or en dashes in project files. Plain hyphens only.

## Honest build status

What works now, all covered by the test suite or the demo:

- All six core objects as TypeScript types with hand rolled JSON validators.
- Passport create and list, intent create, claim (one claim at a time), and list.
- Intent repo field and claim enforcement (shipped 2026-11-23): `intent create --repo owner/repo` stores the target repo on the intent (validated as a slug), `intent list` shows it, the web inbox shows it on the pack, and `intent claim` rejects a passport without propose scope on that repo with a clear reason; a covering passport claims successfully. Covered by CLI level tests, including the backward compatible no-repo path.
- Passport scope display (shipped 2026-11-23): every scope is rendered as `repo|paths|rights` in `passport list`, in scope denial messages, and in a new Passports section on the web inbox page, through one shared formatter (`src/display.ts`), so two scopes on the same repo with different paths no longer look like duplicates.
- Passport enforcement (Phase 2a): status, expiry, repo scope, path scope over the actual changed files, propose vs merge rights, workroom time limit, and spend limit are all enforced on claim, workroom create, proofpack bundle, and PR sync, with allow and deny paths under test at unit and CLI level.
- Passport vetting and renewal (shipped 2026-11-24): a passport can name its agent's MCP surface (`--mcp-dir` for the server directory, `--mcp-cmd` for the stdio launch command). When a surface is configured, `passport create` runs mcpvet (static scan) and mcpaudit (live audit) before saving anything and records a vetting record in the new `.anh/vettings/` collection; a decisive FAIL (mcpvet DO-NOT-INSTALL, mcpaudit FAIL) blocks the issue and nothing is saved. Verdict mapping is decisive only: VETTED and audit PASS are PASS, DO-NOT-INSTALL and audit FAIL are FAIL, and REVIEW, WARN, UNREACHABLE, a missing tool, a missing target directory, and unparseable output are all UNKNOWN with the cause named. `passport renew` is a new verb: it extends the expiry (`--expires`, or `--extend-days`, default 30 days from the later of now and the current expiry), reactivates an expired passport, refuses revoked passports outright and suspended ones with the reason, and re-runs vetting with the same block rule, so a blocked renewal leaves the old expiry in force. `passport vet` re-runs vetting on demand (exit non-zero on FAIL) and `passport vettings` lists the recorded runs. Tool discovery mirrors the gate tools: ANH_MCPVET_BIN / ANH_MCPAUDIT_BIN overrides, then the fleet builds under ~/workspace/github-builds, then $ANH_FLEET_BIN, then PATH. Covered by unit tests for every verdict mapping and the not-found path, plus CLI tests using scripted fake tools for the issue block, the REVIEW-is-UNKNOWN path, and the renewal paths. VERIFIED LIVE the same night in the dogfood store with the real tools: passport pass_mwvi2vof086d23 (agent anh-mcp-self) was issued with anh's own MCP server as its surface and recorded vetting vet_mwvi2ystb07814, overall PASS (mcpvet VETTED, risk score 0; mcpaudit PASS, score 100/100 grade A over anh's 9 tools), and a manual `passport vet` re-run recorded the same PASS. Still owed: claim-time enforcement of a FAIL vetting recorded after issue (today a post-issue FAIL surfaces through `passport vet` and the vettings list, but does not yet block intent claim), and vetting on the hosted service.
- Scoped tokens: issue, list, revoke, verify. Raw token shown once at issuance; only a SHA-256 hash is stored. Guarded commands verify a supplied token and can require one (ANH_REQUIRE_TOKEN=1 or --require-token).
- Token delivery route (shipped 2026-11-24): `anh token deliver` seals a newly minted token in a one time delivery envelope, encrypted with AES-256-GCM under a key derived from a separate delivery code. The envelope file in `.anh/deliveries/` holds only ciphertext, iv, and auth tag: neither the raw token nor the delivery code is ever written to any file. The code is shown once for out of band carriage; `anh token redeem --delivery <id> --code <code>` decrypts exactly once, wipes the ciphertext, and prints the raw token once, after which `anh token verify` confirms it for the passport. A wrong code fails the GCM check without consuming the envelope, and expired or consumed envelopes cannot redeem. Covered by unit tests that scan the whole store for the raw token and the code, plus a CLI round trip, and verified live in the dogfood store: a delivery for the Antigravity passport (dlv_mwunqxsyae9dea) redeemed to a token that verifies, with the envelope wiped and a second redeem rejected.
- Workroom create against a real git repo: real branch, real worktree, run log started, repo key recorded.
- Workroom lifecycle: close removes the worktree and refuses to discard uncommitted changes unless forced, kill force removes it, resume recreates the worktree from the branch, and handoff transfers the workroom and its intent claim to another passport only when that passport is usable and holds propose scope on the repo (a denied handoff changes nothing). The branch is kept on close and kill unless --delete-branch is passed. Proof pack bundling now refuses a non-open workroom with a clear resume hint. All paths are covered by tests against real git worktrees, including a CLI round trip.
- Proof pack bundling with real local gates (git diff, testdelta, reprocheck) and honest UNKNOWN recording for the GitHub bound gates (cidiff, shipcheck) when no repo slug is given or a fetch fails.
- Testdelta producer (shipped 2026-11-24): `anh testdelta produce` and `proofpack bundle --test-cmd` run a repo test suite on the workroom base and head and feed real base.json and head.json files to testdelta, closing the dogfood friction where bundle recorded testdelta UNKNOWN unless the agent hand supplied result files. Covered by tests against real git worktrees: a head regression produces a FAIL verdict, a head fix produces a PASS verdict, a command that writes nothing is an error, and the temporary base worktree is removed afterwards. VERIFIED LIVE the same night on the Greenlight index workroom: the producer measured 1,283 base tests and 1,283 head tests, and a fresh proof pack (pack_mwufteln97bc4b, hash verified) records testdelta PASS (NO-REGRESSION, 0 regressions, 2 tests failing on both base and head) where the original pack (pack_mwnqi057d36f21) recorded UNKNOWN for want of result files. The rebundle used a fresh workroom because the original workroom had exceeded the passport per workroom time limit, which enforcement correctly refused; the old workroom and its pack are untouched.
- Proof pack verify with canonical JSON content hashing; tampering with any field, including flipping an UNKNOWN to a PASS, fails verification.
- PR sync (Phase 2b): payload builder renders the proof pack into the PR body; the gh CLI transport pushes the branch and opens or updates the PR. VERIFIED LIVE 2026-11-19 from the Razer (gh authenticated as CloudCorpRecords): PR https://github.com/CloudCorpRecords/anh-prsync-test/pull/1 posted against the scratch repo CloudCorpRecords/anh-prsync-test, state OPEN, body read back at the destination with the proof pack section, per check verdicts, and the pack content hash matching the local pack. On this VM gh is not authenticated, so a live CLI sync from here still records UNKNOWN with that exact reason, never a fake PR. One transport fix landed from that run: gh auth status exits non-zero when any stored account entry is stale even when an active account works, so the transport check now falls back to gh api user as the ground truth before declaring gh unauthenticated. That fallback has regression coverage (shipped 2026-11-24): the transport's command runner is injectable, and tests script a fake gh for the missing binary, clean auth, stale entry plus working API login, and both checks failing cases, asserting the verdict and the exact gh calls made in each.
- Inbox list: proof packs with no decision yet, rendered as a readable queue with per check verdicts and risk flags.
- Web review inbox (Phase 3): server rendered HTML at `/` listing pending packs with intent, verdicts, risk flags, and changed files, plus a decision form, and token auth when ANH_INBOX_TOKEN is set. POST /review records the decision and reputation event through the same code path as the CLI; a changes decision without feedback is refused with a 400. Covered by an HTTP level test against the running server.
- Review decide: records the decision, derives and stores the reputation event, and moves the intent to completed (approve) or released (reject or changes).
- Reputation ledger views (shipped 2026-11-19): per passport summaries (total, accepted, rejected, rework requested, acceptance rate, last outcome) plus events newest first, in the CLI (`anh reputation list`, with `--passport` filter and `--json`), as a section on the web inbox page, and at `GET /reputation`. The endpoint sits behind the same inbox token auth as `/inbox` (401 unauthenticated, covered by the auth test). Counts come only from recorded events; empty ledgers render as empty, never as a default score.
- Risk flags: failed checks, forbidden area touches from the intent, and large diffs over 500 changed lines.
- Commit identity warning (shipped 2026-11-24): `workroom create` and `workroom resume` check the commit identity git would use in the worktree (local config, then global, resolved exactly as git resolves it). When user.name or user.email is missing, creation still succeeds but prints a plain words warning naming the missing fields, and the workroom run log records a `commit_identity_missing` event, so the failure surfaces at creation time instead of at the first commit. anh never invents or sets an identity; the warning example uses placeholders and the identity stays the human's to choose. Covered by unit tests with global and system git config isolated (so the result is deterministic on any machine), CLI create tests for both the warning and the silent path, and a resume test.
- Staleness preflight (shipped 2026-11-24): `anh intent preflight --id <id> [--repo <path>]` compares an intent's existing workroom bases and landed-work signals against the target repo's current HEAD and warns in plain words when a base is behind (with the commit count), when a workroom branch is already an ancestor of HEAD, or when a commit on HEAD mentions the intent id. `intent claim --repo <path>` (or a claim for an intent that already has a workroom) runs the same check and prints any warning without blocking the claim. The status is fresh, stale, or unknown: no repo path, a missing repo, or an intent with no workroom and no landed signal is UNKNOWN, never fresh, because anh cannot prove undone work from goal text. Covered by unit and CLI tests against real git repos (fresh, stale by count, landed by merge, landed by commit mention, and the UNKNOWN paths).
- Portable gate tool discovery (shipped 2026-11-24): gate runners no longer assume the VM fleet install. Each tool (cidiff, reprocheck, testdelta, shipcheck) is resolved in order from a per tool override (ANH_CIDIFF_BIN, ANH_TESTDELTA_BIN, ANH_REPROCHECK_BIN, ANH_SHIPCHECK_BIN, plus ANH_SHIPCHECK_CLI for a dist/cli.js run through node), then $ANH_FLEET_BIN, then the default fleet install at ~/workspace/fleet-tools, then PATH, so a machine without the fleet install (the Razer, a fresh laptop) can still produce real verdicts from tools it does have. A miss records UNKNOWN naming the machine, every location searched, and the override to set, instead of a bare binary not found that only made sense on the VM. Covered by discovery tests: override resolution, PATH fallback with the full searched list, the machine specific not found detail, and a PATH shipcheck mapping GO to PASS. Still owed: a live rerun of the Razer verification flow with the tools installed there.
- MCP server surface (shipped 2026-11-24): `anh mcp` speaks newline delimited JSON-RPC 2.0 on stdio (initialize, ping, tools/list, tools/call) with nine tools covering passports, intents (create and claim with the same enforcement as the CLI), workrooms, the review inbox, proof pack verification, the reputation ledger, and review decisions through the shared decideReview path. Token issue, delivery, and verify are deliberately not MCP tools, so no raw token ever travels in an MCP transcript. Covered by protocol, tool, and live stdio transport tests, and verified live against the dogfood store (3 passports listed, 2 pending packs in the inbox).
- Strict typecheck (shipped 2026-11-24): typescript and @types/node are dev only dependencies and `npm run typecheck` runs `tsc --noEmit` under the strict tsconfig (with `allowImportingTsExtensions` for the .ts import style Node type stripping requires), clean over all of src and test at introduction with zero code changes needed. The test suite carries a typecheck gate test that runs the compiler when it is installed and skips with the reason when it is not (a fresh worktree, a machine with only the runtime), so on those machines the typecheck stays honestly UNKNOWN rather than passing by absence.
- HTTP service with `/healthz`, `/`, and `/inbox`, tested locally.
- Web inbox token auth: when `ANH_INBOX_TOKEN` is set, every route except `/healthz` requires the token, as a Bearer header for API clients or via an HttpOnly cookie set by the POST `/login` browser flow. Hash compared with timingSafeEqual. Covered by an HTTP level test: unauthenticated HTML, JSON, and review POSTs are 401 and record nothing, wrong tokens and wrong logins fail, Bearer and cookie access succeed. When no token is configured the inbox is open, which is only safe for local dogfood; on Fly it must be set as a secret (`fly secrets set ANH_INBOX_TOKEN=...`), never in fly.toml.

What is stubbed, partial, or not yet built:

- cidiff verdict mapping (fixed 2026-11-24): the real cidiff report has no top level verdict field; it carries a verdicts list plus per category counts, which the old mapping never read, so every cidiff check fell through to UNKNOWN with a truncated JSON blob as its detail. The mapping now reads the real shape: introduced failures are FAIL with the check names, a completed report with no introduced, pending, or indeterminate entries is PASS, pending or indeterminate entries are UNKNOWN with the cause named, and an empty verdicts list is UNKNOWN naming the checkable cause (the workroom branch is not pushed, verified against the local remote tracking branches, or GitHub returned no CI runs for the head on a pushed branch), with cidiff's own warnings appended. Covered by unit tests against the real report shape and by a live bundle on the Greenlight index workroom: pack pack_mwujju2q3cf3b4 (hash verified) records cidiff UNKNOWN naming its unpushed branch anh/greenlight-index-nogon-td in plain words, where the original pack recorded an empty, unreadable result. Still owed for full promotion: a decisive PASS or FAIL from a pushed branch with CI, which needs a machine where the branch can be pushed (gh is not authenticated on this VM). Rechecked 2026-11-24 evening from the VM: cidiff in runs mode against CloudCorpRecords/greenlight's real pushed main HEAD returned only "fetch failed", and the GitHub API answered rate limit exceeded for this VM's shared egress IP, so the decisive verdict remains a Razer-route item, not a mapping gap.
- shipcheck verdict mapping is defensive best effort against its JSON output; any output without a decisive verdict records UNKNOWN. A live GO verdict was recorded in pack pack_mwujju2q3cf3b4 on 2026-11-24.
- PR sync live path is verified from the Razer only (see above). From this VM it remains UNKNOWN because gh is not authenticated here. The Razer scratch run bundled its proof pack without the fleet gate tools installed on that machine, so testdelta, reprocheck, cidiff, and shipcheck all recorded UNKNOWN there; only the local diff check produced a verdict.
- Spend enforcement is record based: spend is enforced when it is recorded (passport spend, or proofpack bundle --spend-usd). There is no automatic metering of an agent's real cloud spend yet.
- PR sync pushes from the worktree path, so a closed or killed workroom must be resumed before syncing; sync against a removed worktree records UNKNOWN rather than a fake post.

## Next per the plan

1. Dogfood from 2026-11-19 8:00 AM PT (see DOGFOOD.md): passports for Tree, Antigravity, and Xod; real intents on Xod and Greenlight; every friction item becomes an intent on this project.
2. Done 2026-11-19: first real PR posted through pr sync from the Razer (see the PR sync line above). Still owed: promote the cidiff and shipcheck mappings with a live repo run where the fleet tools are installed.
3. Done 2026-11-24: mcpaudit and mcpvet wired into passport issue and renewal, plus the new passport renew verb (see the passport vetting line above). Still owed from this item: claim-time blocking on a post-issue FAIL vetting. (Token auth on the web inbox HTTP layer shipped 2026-11-19. Workroom close out, kill, resume, and handoff shipped 2026-11-19. Reputation ledger views in the CLI and web inbox shipped 2026-11-19.)
4. Phase 4: standalone git hosting only if traction earns it. Cancelled by default.

## Layout

```text
src/types.ts       the six core objects, plus scoped tokens and PR sync records
src/validate.ts    hand rolled validators, one per object
src/hash.ts        canonical JSON, proof pack content hash and verify, ids
src/store.ts       .anh/ JSON file store
src/git.ts         git and subprocess helpers
src/gates.ts       fleet gate runners with the UNKNOWN rule
src/enforce.ts     passport enforcement: scope, rights, time, spend (Phase 2a)
src/tokens.ts      scoped token issue, verify, revoke (Phase 2a)
src/vet.ts         passport vetting: mcpvet and mcpaudit discovery, verdict
                   mapping, and vetting records wired into issue and renewal
src/delivery.ts    one time token delivery: AES-256-GCM sealed envelopes, single use redeem
src/prsync.ts      GitHub PR sync: payload builder plus gh CLI transport (Phase 2b)
src/workroom.ts    workroom lifecycle: close, kill, resume, handoff
src/testdelta.ts   testdelta producer: runs the suite on base and head, writes base.json and head.json
src/display.ts     shared scope and passport rendering (repo|paths|rights)
src/review.ts      shared review decision path for CLI and web inbox
src/reputation.ts  decision to reputation event derivation, per passport ledger summaries
src/server.ts      HTTP service: /healthz, / web review inbox, /inbox, POST /review, POST /login, token auth (Phase 3)
src/mcp.ts         MCP server: stdio JSON-RPC, anh_* tools over the same store and shared review path
src/staleness.ts   staleness preflight: workroom bases and landed-work signals vs current HEAD
src/cli.ts         the anh CLI
test/              node test runner: validate, proofpack, reputation, enforce,
                   prsync, server, cli-enforce, e2e
scripts/demo.sh    scripted end to end demo against a throwaway repo
DOGFOOD.md         how Tree, Antigravity, and Xod run real work through anh
fly.toml           Fly.io deploy config
Dockerfile         container for the service layer
```
