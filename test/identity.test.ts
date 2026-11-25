import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "../src/store.ts";
import { commitIdentity, commitIdentityWarning } from "../src/git.ts";
import { resumeWorkroom } from "../src/workroom.ts";
import { newId, nowIso } from "../src/hash.ts";
import type { Intent, Passport, Workroom } from "../src/types.ts";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.ts");

function gitFixture(cwd: string, args: string[]): string {
  return execFileSync("git", ["-c", "user.name=Anh Test", "-c", "user.email=anh-test@example.com", ...args], { cwd, encoding: "utf8" });
}

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "anh-id-"));
  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  gitFixture(repo, ["init", "-q"]);
  writeFileSync(join(repo, "hello.txt"), "hello base\n");
  gitFixture(repo, ["add", "."]);
  gitFixture(repo, ["commit", "-qm", "base"]);
  return repo;
}

// An env where git sees no global or system config at all, so a repo with
// no local identity is deterministically identity-less on any machine.
function isolatedEnv(): Record<string, string> {
  const dir = mkdtempSync(join(tmpdir(), "anh-id-env-"));
  const empty = join(dir, "empty-config");
  writeFileSync(empty, "");
  return { HOME: dir, XDG_CONFIG_HOME: dir, GIT_CONFIG_GLOBAL: empty, GIT_CONFIG_SYSTEM: empty, GIT_CONFIG_NOSYSTEM: "1" };
}

test("commitIdentity: local config is read back, nothing missing", () => {
  const repo = makeRepo();
  execFileSync("git", ["config", "user.name", "Repo Local"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "local@example.com"], { cwd: repo });
  const id = commitIdentity(repo, isolatedEnv());
  assert.equal(id.name, "Repo Local");
  assert.equal(id.email, "local@example.com");
  assert.deepEqual(id.missing, []);
  assert.equal(commitIdentityWarning(repo, isolatedEnv()), null);
});

test("commitIdentity: no identity anywhere reports both fields missing and warns in plain words", () => {
  const repo = makeRepo();
  const env = isolatedEnv();
  const id = commitIdentity(repo, env);
  assert.equal(id.name, null);
  assert.equal(id.email, null);
  assert.deepEqual(id.missing, ["user.name", "user.email"]);
  const warning = commitIdentityWarning(repo, env);
  assert.ok(warning, "a warning is produced");
  assert.match(warning, /no git commit identity is configured/);
  assert.match(warning, /user\.name/);
  assert.match(warning, /user\.email/);
  assert.match(warning, /commits will fail/);
});

test("commitIdentity: a name without an email reports only user.email missing", () => {
  const repo = makeRepo();
  execFileSync("git", ["config", "user.name", "Name Only"], { cwd: repo });
  const env = isolatedEnv();
  const id = commitIdentity(repo, env);
  assert.equal(id.name, "Name Only");
  assert.deepEqual(id.missing, ["user.email"]);
  const warning = commitIdentityWarning(repo, env);
  assert.ok(warning);
  assert.match(warning, /missing user\.email/);
  assert.doesNotMatch(warning, /missing user\.name/);
});

test("CLI: workroom create warns at creation time when no commit identity is configured", { timeout: 120000 }, () => {
  const root = mkdtempSync(join(tmpdir(), "anh-id-cli-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  const repo = makeRepo();
  const env = { ...process.env, ...isolatedEnv() };
  const run = (args: string[], json = true) => {
    const r = spawnSync("node", [CLI, ...args, ...(json ? ["--json"] : []), "--workspace", workspace], { encoding: "utf8", env });
    assert.equal(r.status, 0, `anh ${args.join(" ")}: ${r.stderr || r.stdout}`);
    return r.stdout;
  };
  const passport = JSON.parse(run(["passport", "create", "--agent", "id-agent", "--owner", "test-owner", "--scope", "local/repo|**|propose"])) as { id: string };
  const intent = JSON.parse(run(["intent", "create", "--goal", "identity warning", "--criterion", "warns"])) as { id: string };
  run(["intent", "claim", "--id", intent.id, "--passport", passport.id]);

  const text = run(["workroom", "create", "--intent", intent.id, "--passport", passport.id, "--repo", repo, "--branch", "anh/id-warn"], false);
  assert.match(text, /warning: no git commit identity is configured/);
  assert.match(text, /user\.name/);

  const listed = JSON.parse(run(["workroom", "list"])) as Workroom[];
  const created = listed.find((w) => w.branch === "anh/id-warn");
  assert.ok(created, "workroom was created despite the missing identity");
  const event = created.runLog.find((e) => e.event === "commit_identity_missing");
  assert.ok(event, "the missing identity is recorded in the workroom run log");
  assert.match(event.detail, /commits will fail/);
});

test("CLI: workroom create is silent when a commit identity is configured", { timeout: 120000 }, () => {
  const root = mkdtempSync(join(tmpdir(), "anh-id-cli-ok-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  const repo = makeRepo();
  execFileSync("git", ["config", "user.name", "Repo Local"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "local@example.com"], { cwd: repo });
  const env = { ...process.env, ...isolatedEnv() };
  const run = (args: string[], json = true) => {
    const r = spawnSync("node", [CLI, ...args, ...(json ? ["--json"] : []), "--workspace", workspace], { encoding: "utf8", env });
    assert.equal(r.status, 0, `anh ${args.join(" ")}: ${r.stderr || r.stdout}`);
    return r.stdout;
  };
  const passport = JSON.parse(run(["passport", "create", "--agent", "id-agent", "--owner", "test-owner", "--scope", "local/repo|**|propose"])) as { id: string };
  const intent = JSON.parse(run(["intent", "create", "--goal", "identity present", "--criterion", "silent"])) as { id: string };
  run(["intent", "claim", "--id", intent.id, "--passport", passport.id]);

  const text = run(["workroom", "create", "--intent", intent.id, "--passport", passport.id, "--repo", repo, "--branch", "anh/id-ok"], false);
  assert.doesNotMatch(text, /warning:/);
  const listed = JSON.parse(run(["workroom", "list"])) as Workroom[];
  const created = listed.find((w) => w.branch === "anh/id-ok");
  assert.ok(created);
  assert.equal(created.runLog.some((e) => e.event === "commit_identity_missing"), false);
});

test("resume: a resumed workroom records the missing identity in its run log", () => {
  const root = mkdtempSync(join(tmpdir(), "anh-id-resume-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  const repo = makeRepo();
  const baseSha = gitFixture(repo, ["rev-parse", "HEAD"]).trim();
  gitFixture(repo, ["branch", "anh/id-resume", baseSha]);

  const store = new Store(workspace);
  const passport: Passport = {
    kind: "passport", id: newId("pass"), agentId: "agent-id", humanOwner: "test-owner",
    scopes: [{ repo: "local/repo", paths: ["**"], rights: "propose" }], limits: {}, status: "active", createdAt: nowIso(),
  };
  store.save("passports", passport);
  const intent: Intent = {
    kind: "intent", id: newId("intent"), goal: "resume identity fixture",
    acceptanceCriteria: [{ id: "c1", description: "warns" }], contextRefs: [], forbiddenAreas: [],
    claim: { state: "claimed", passportId: passport.id, claimedAt: nowIso() }, createdAt: nowIso(), createdBy: "test",
  };
  store.save("intents", intent);
  const workroom: Workroom = {
    kind: "workroom", id: newId("wr"), repoPath: repo, branch: "anh/id-resume",
    worktreePath: join(root, "wt"), baseRef: "HEAD", baseSha, intentId: intent.id, passportId: passport.id,
    repoKey: "local/repo", status: "closed", closedAt: nowIso(),
    runLog: [{ at: nowIso(), event: "workroom_created", detail: "fixture" }], createdAt: nowIso(),
  };
  store.save("workrooms", workroom);

  const env = isolatedEnv();
  const saved = { ...process.env };
  Object.assign(process.env, env);
  try {
    const resumed = resumeWorkroom(store, workroom.id);
    assert.equal(resumed.status, "open");
    assert.ok(existsSync(workroom.worktreePath));
    const event = resumed.runLog.find((e) => e.event === "commit_identity_missing");
    assert.ok(event, "resume records the missing identity");
    assert.match(event.detail, /no git commit identity is configured/);
  } finally {
    for (const key of Object.keys(env)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});
