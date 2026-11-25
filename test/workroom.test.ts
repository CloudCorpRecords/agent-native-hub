import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "../src/store.ts";
import { closeWorkroom, handoffWorkroom, killWorkroom, resumeWorkroom } from "../src/workroom.ts";
import { newId, nowIso } from "../src/hash.ts";
import type { Intent, Passport, Workroom } from "../src/types.ts";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.ts");

function gitFixture(cwd: string, args: string[]): string {
  return execFileSync("git", ["-c", "user.name=Anh Test", "-c", "user.email=anh-test@example.com", ...args], { cwd, encoding: "utf8" });
}

interface Fixture {
  store: Store;
  repo: string;
  workroom: Workroom;
  passport: Passport;
  intent: Intent;
}

function makeFixture(scopes: Passport["scopes"] = [{ repo: "local/repo", paths: ["**"], rights: "propose" }]): Fixture {
  const root = mkdtempSync(join(tmpdir(), "anh-wr-"));
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
  const passport: Passport = {
    kind: "passport", id: newId("pass"), agentId: "agent-wr", humanOwner: "test-owner",
    scopes, limits: {}, status: "active", createdAt: nowIso(),
  };
  store.save("passports", passport);
  const intent: Intent = {
    kind: "intent", id: newId("intent"), goal: "workroom lifecycle fixture",
    acceptanceCriteria: [{ id: "c1", description: "lifecycle works" }],
    contextRefs: [], forbiddenAreas: [],
    claim: { state: "claimed", passportId: passport.id, claimedAt: nowIso() },
    createdAt: nowIso(), createdBy: "test",
  };
  store.save("intents", intent);
  const worktreePath = join(root, "wt");
  gitFixture(repo, ["worktree", "add", "-b", "anh/wr-test", worktreePath, baseSha]);
  const workroom: Workroom = {
    kind: "workroom", id: newId("wr"), repoPath: repo, branch: "anh/wr-test",
    worktreePath, baseRef: "HEAD", baseSha, intentId: intent.id, passportId: passport.id,
    repoKey: "local/repo", status: "open",
    runLog: [{ at: nowIso(), event: "workroom_created", detail: "fixture" }],
    createdAt: nowIso(),
  };
  store.save("workrooms", workroom);
  return { store, repo, workroom, passport, intent };
}

function commitInWorktree(f: Fixture, text: string): void {
  writeFileSync(join(f.workroom.worktreePath, "hello.txt"), text);
  gitFixture(f.workroom.worktreePath, ["add", "."]);
  gitFixture(f.workroom.worktreePath, ["commit", "-qm", "work"]);
}

test("close: clean workroom removes the worktree, keeps the branch, records closed", () => {
  const f = makeFixture();
  commitInWorktree(f, "hello done\n");
  const res = closeWorkroom(f.store, f.workroom.id);
  assert.equal(res.workroom.status, "closed");
  assert.ok(res.workroom.closedAt);
  assert.equal(res.worktreeRemoved, true);
  assert.equal(res.branchDeleted, false);
  assert.equal(existsSync(f.workroom.worktreePath), false, "worktree directory is gone");
  const branch = spawnSync("git", ["rev-parse", "--verify", "refs/heads/anh/wr-test"], { cwd: f.repo, encoding: "utf8" });
  assert.equal(branch.status, 0, "branch survives close");
  const stored = f.store.load<Workroom>("workrooms", f.workroom.id);
  assert.equal(stored?.status, "closed");
  assert.ok(stored?.runLog.some((e) => e.event === "workroom_closed"));
  assert.throws(() => closeWorkroom(f.store, f.workroom.id), /not open/);
});

test("close: dirty worktree is refused without force and nothing is removed", () => {
  const f = makeFixture();
  writeFileSync(join(f.workroom.worktreePath, "hello.txt"), "uncommitted\n");
  assert.throws(() => closeWorkroom(f.store, f.workroom.id), /uncommitted change/);
  assert.equal(existsSync(f.workroom.worktreePath), true, "worktree still there after refused close");
  assert.equal(readFileSync(join(f.workroom.worktreePath, "hello.txt"), "utf8"), "uncommitted\n");
  assert.equal(f.store.load<Workroom>("workrooms", f.workroom.id)?.status, "open");
  const res = closeWorkroom(f.store, f.workroom.id, { force: true });
  assert.equal(res.workroom.status, "closed");
  assert.equal(existsSync(f.workroom.worktreePath), false);
});

test("kill: dirty worktree is force removed and recorded as killed", () => {
  const f = makeFixture();
  writeFileSync(join(f.workroom.worktreePath, "scratch.txt"), "throwaway\n");
  const res = killWorkroom(f.store, f.workroom.id, { reason: "abandoned run" });
  assert.equal(res.workroom.status, "killed");
  assert.equal(res.workroom.closeReason, "abandoned run");
  assert.equal(existsSync(f.workroom.worktreePath), false);
  assert.ok(res.workroom.runLog.some((e) => e.event === "workroom_killed"));
});

test("resume: closed workroom recreates the worktree on its branch with its commits", () => {
  const f = makeFixture();
  commitInWorktree(f, "hello resumed\n");
  closeWorkroom(f.store, f.workroom.id);
  assert.equal(existsSync(f.workroom.worktreePath), false);
  const resumed = resumeWorkroom(f.store, f.workroom.id);
  assert.equal(resumed.status, "open");
  assert.equal(resumed.closedAt, undefined);
  assert.equal(readFileSync(join(f.workroom.worktreePath, "hello.txt"), "utf8"), "hello resumed\n");
  assert.throws(() => resumeWorkroom(f.store, f.workroom.id), /already open/);
});

test("close with deleteBranch: resume then fails clearly because the branch is gone", () => {
  const f = makeFixture();
  commitInWorktree(f, "hello branchgone\n");
  const res = closeWorkroom(f.store, f.workroom.id, { deleteBranch: true, force: true });
  assert.equal(res.branchDeleted, true);
  assert.throws(() => resumeWorkroom(f.store, f.workroom.id), /no longer exists/);
});

test("handoff: claim and workroom move to a scoped passport", () => {
  const f = makeFixture();
  const target: Passport = {
    kind: "passport", id: newId("pass"), agentId: "agent-two", humanOwner: "test-owner",
    scopes: [{ repo: "local/repo", paths: ["**"], rights: "propose" }],
    limits: {}, status: "active", createdAt: nowIso(),
  };
  f.store.save("passports", target);
  const { workroom, intent } = handoffWorkroom(f.store, f.workroom.id, target.id);
  assert.equal(workroom.passportId, target.id);
  assert.equal(intent.claim.passportId, target.id);
  assert.equal(intent.claim.state, "claimed");
  assert.ok(workroom.runLog.some((e) => e.event === "workroom_handed_off"));
  assert.throws(() => handoffWorkroom(f.store, f.workroom.id, target.id), /already belongs/);
});

test("handoff: a passport without repo scope is denied and nothing changes", () => {
  const f = makeFixture();
  const outsider: Passport = {
    kind: "passport", id: newId("pass"), agentId: "agent-out", humanOwner: "test-owner",
    scopes: [{ repo: "other/repo", paths: ["**"], rights: "merge" }],
    limits: {}, status: "active", createdAt: nowIso(),
  };
  f.store.save("passports", outsider);
  assert.throws(() => handoffWorkroom(f.store, f.workroom.id, outsider.id), /no scope granting propose/);
  assert.equal(f.store.load<Workroom>("workrooms", f.workroom.id)?.passportId, f.passport.id);
  assert.equal(f.store.load<Intent>("intents", f.intent.id)?.claim.passportId, f.passport.id);
});

test("CLI: workroom list, close, resume round trip through the anh binary", { timeout: 120000 }, () => {
  const root = mkdtempSync(join(tmpdir(), "anh-wr-cli-"));
  const workspace = join(root, "workspace");
  const repo = join(root, "repo");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(repo, { recursive: true });
  gitFixture(repo, ["init", "-q"]);
  writeFileSync(join(repo, "a.txt"), "a\n");
  gitFixture(repo, ["add", "."]);
  gitFixture(repo, ["commit", "-qm", "base"]);

  const run = (args: string[], expectOk = true) => {
    const r = spawnSync("node", [CLI, ...args, "--json", "--workspace", workspace], { encoding: "utf8" });
    assert.equal(r.status === 0, expectOk, `anh ${args.join(" ")}: ${r.stderr || r.stdout}`);
    return expectOk ? JSON.parse(r.stdout) : r;
  };
  const passport = run(["passport", "create", "--agent", "cli-agent", "--owner", "test-owner", "--scope", "local/repo|**|propose"]) as { id: string };
  const intent = run(["intent", "create", "--goal", "cli lifecycle", "--criterion", "works"]) as { id: string };
  run(["intent", "claim", "--id", intent.id, "--passport", passport.id]);
  const wr = run(["workroom", "create", "--intent", intent.id, "--passport", passport.id, "--repo", repo, "--branch", "anh/cli-wr"]) as { id: string; worktreePath: string };
  assert.ok(existsSync(wr.worktreePath));

  const listed = run(["workroom", "list"]) as { id: string; status: string }[];
  assert.equal(listed.find((w) => w.id === wr.id)?.status, "open");

  const closed = run(["workroom", "close", "--id", wr.id]) as { workroom: { status: string }; branchDeleted: boolean };
  assert.equal(closed.workroom.status, "closed");
  assert.equal(closed.branchDeleted, false);
  assert.equal(existsSync(wr.worktreePath), false);

  const resumed = run(["workroom", "resume", "--id", wr.id]) as { status: string };
  assert.equal(resumed.status, "open");
  assert.ok(existsSync(wr.worktreePath));

  const killed = run(["workroom", "kill", "--id", wr.id, "--delete-branch"]) as { workroom: { status: string }; branchDeleted: boolean };
  assert.equal(killed.workroom.status, "killed");
  assert.equal(existsSync(wr.worktreePath), false);
});
