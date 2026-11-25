import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "../src/store.ts";
import { checkStaleness } from "../src/staleness.ts";
import { newId, nowIso } from "../src/hash.ts";
import type { Intent, Workroom } from "../src/types.ts";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.ts");

function gitFixture(cwd: string, args: string[]): string {
  return execFileSync("git", ["-c", "user.name=Anh Test", "-c", "user.email=anh-test@example.com", ...args], { cwd, encoding: "utf8" });
}

interface Fixture {
  store: Store;
  workspace: string;
  repo: string;
  intent: Intent;
  workroom: Workroom;
  baseSha: string;
}

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "anh-stale-"));
  const workspace = join(root, "workspace");
  const repo = join(root, "repo");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(repo, { recursive: true });
  gitFixture(repo, ["init", "-q"]);
  writeFileSync(join(repo, "hello.txt"), "hello base\n");
  gitFixture(repo, ["add", "."]);
  gitFixture(repo, ["commit", "-qm", "base"]);
  const baseSha = gitFixture(repo, ["rev-parse", "HEAD"]).trim();

  const store = new Store(workspace);
  const intent: Intent = {
    kind: "intent", id: newId("intent"), goal: "staleness fixture",
    acceptanceCriteria: [{ id: "c1", description: "staleness works" }],
    contextRefs: [], forbiddenAreas: [],
    claim: { state: "unclaimed" },
    createdAt: nowIso(), createdBy: "test",
  };
  store.save("intents", intent);
  const worktreePath = join(root, "wt");
  gitFixture(repo, ["worktree", "add", "-b", "anh/stale-test", worktreePath, baseSha]);
  const workroom: Workroom = {
    kind: "workroom", id: newId("wr"), repoPath: repo, branch: "anh/stale-test",
    worktreePath, baseRef: "HEAD", baseSha, intentId: intent.id, passportId: "pass_fixture",
    repoKey: "local/repo", status: "open",
    runLog: [{ at: nowIso(), event: "workroom_created", detail: "fixture" }],
    createdAt: nowIso(),
  };
  store.save("workrooms", workroom);
  return { store, workspace, repo, intent, workroom, baseSha };
}

function commitOnMain(f: Fixture, name: string, text: string, message: string): string {
  writeFileSync(join(f.repo, name), text);
  gitFixture(f.repo, ["add", "."]);
  gitFixture(f.repo, ["commit", "-qm", message]);
  return gitFixture(f.repo, ["rev-parse", "HEAD"]).trim();
}

test("fresh: workroom base at current HEAD reports fresh with no warnings", () => {
  const f = makeFixture();
  const r = checkStaleness(f.intent, [f.workroom], f.repo);
  assert.equal(r.status, "fresh");
  assert.equal(r.currentHead, f.baseSha);
  assert.deepEqual(r.warnings, []);
});

test("stale: advancing HEAD past the workroom base warns with the commit count", () => {
  const f = makeFixture();
  commitOnMain(f, "a.txt", "a\n", "advance one");
  commitOnMain(f, "b.txt", "b\n", "advance two");
  const r = checkStaleness(f.intent, [f.workroom], f.repo);
  assert.equal(r.status, "stale");
  assert.ok(r.warnings.some((w) => /stale base/.test(w) && /2 commit\(s\) behind/.test(w)), r.warnings.join("\n"));
});

test("already landed: a workroom branch merged into HEAD is named", () => {
  const f = makeFixture();
  writeFileSync(join(f.workroom.worktreePath, "done.txt"), "done\n");
  gitFixture(f.workroom.worktreePath, ["add", "."]);
  gitFixture(f.workroom.worktreePath, ["commit", "-qm", "the work itself"]);
  gitFixture(f.repo, ["merge", "-q", "--ff-only", "anh/stale-test"]);
  const r = checkStaleness(f.intent, [f.workroom], f.repo);
  assert.equal(r.status, "stale");
  assert.ok(r.warnings.some((w) => /already landed/.test(w) && /anh\/stale-test/.test(w)), r.warnings.join("\n"));
});

test("already landed: a commit on HEAD mentioning the intent id is named", () => {
  const f = makeFixture();
  commitOnMain(f, "landed.txt", "landed\n", `land the work for ${f.intent.id} outside anh`);
  const r = checkStaleness(f.intent, [f.workroom], f.repo);
  assert.equal(r.status, "stale");
  assert.ok(r.warnings.some((w) => /already landed/.test(w) && w.includes(f.intent.id)), r.warnings.join("\n"));
});

test("unknown: no repo path and no workroom is UNKNOWN, never fresh", () => {
  const f = makeFixture();
  const r = checkStaleness(f.intent, [], undefined);
  assert.equal(r.status, "unknown");
  assert.match(r.warnings[0], /staleness UNKNOWN/);
});

test("unknown: a missing repo path is UNKNOWN with the path named", () => {
  const f = makeFixture();
  const r = checkStaleness(f.intent, [f.workroom], join(f.repo, "does-not-exist"));
  assert.equal(r.status, "unknown");
  assert.match(r.warnings[0], /does not exist/);
});

test("unknown: an intent with no workroom reports current HEAD but not fresh", () => {
  const f = makeFixture();
  const r = checkStaleness(f.intent, [], f.repo);
  assert.equal(r.status, "unknown");
  assert.equal(r.currentHead, f.baseSha);
  assert.match(r.warnings[0], /no existing workroom/);
});

test("CLI: intent preflight reports stale in JSON and claim with --repo warns but still claims", { timeout: 120000 }, () => {
  const f = makeFixture();
  commitOnMain(f, "a.txt", "a\n", "advance one");

  const pre = spawnSync("node", [CLI, "intent", "preflight", "--id", f.intent.id, "--repo", f.repo, "--json", "--workspace", f.workspace], { encoding: "utf8" });
  assert.equal(pre.status, 0, pre.stderr || pre.stdout);
  const parsed = JSON.parse(pre.stdout) as { status: string; warnings: string[] };
  assert.equal(parsed.status, "stale");
  assert.ok(parsed.warnings.some((w) => /stale base/.test(w)));

  // A second, unclaimed intent claimed with --repo prints the warning in
  // human output (its workroom-free state is UNKNOWN, not fresh) and the
  // claim itself still succeeds: preflight warns, it never blocks.
  const intent2: Intent = { ...f.intent, id: newId("intent"), goal: "second intent", claim: { state: "unclaimed" } };
  f.store.save("intents", intent2);
  const passport = spawnSync("node", [CLI, "passport", "create", "--agent", "stale-agent", "--owner", "test-owner", "--scope", "local/repo|**|propose", "--json", "--workspace", f.workspace], { encoding: "utf8" });
  assert.equal(passport.status, 0, passport.stderr);
  const passportId = (JSON.parse(passport.stdout) as { id: string }).id;
  const claim = spawnSync("node", [CLI, "intent", "claim", "--id", intent2.id, "--passport", passportId, "--repo", f.repo, "--workspace", f.workspace], { encoding: "utf8" });
  assert.equal(claim.status, 0, claim.stderr || claim.stdout);
  assert.match(claim.stdout, /claimed by passport/);
  assert.match(claim.stdout, /staleness warning: staleness UNKNOWN/);
});
