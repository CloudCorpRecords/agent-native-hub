import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.ts");

function anh(workspace: string, args: string[]): Record<string, unknown> {
  const r = spawnSync("node", [CLI, ...args, "--json", "--workspace", workspace], { encoding: "utf8" });
  assert.equal(r.status, 0, `anh ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  return JSON.parse(r.stdout) as Record<string, unknown>;
}

function gitFixture(cwd: string, args: string[]): void {
  execFileSync("git", ["-c", "user.name=Anh Test", "-c", "user.email=anh-test@example.com", ...args], { cwd, stdio: "pipe" });
}

test("end to end: passport, intent, claim, workroom, commit, proof pack, verify, review", { timeout: 240000 }, () => {
  const root = mkdtempSync(join(tmpdir(), "anh-e2e-"));
  const workspace = join(root, "workspace");
  const repo = join(root, "repo");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(repo, { recursive: true });

  gitFixture(repo, ["init", "-q"]);
  writeFileSync(join(repo, "hello.txt"), "hello base\n");
  gitFixture(repo, ["add", "."]);
  gitFixture(repo, ["commit", "-qm", "base"]);

  const passport = anh(workspace, ["passport", "create", "--agent", "agent-e2e", "--owner", "test-owner", "--scope", "local/repo|**|propose"]);
  const intent = anh(workspace, ["intent", "create", "--goal", "make hello say fixed", "--criterion", "hello.txt contains fixed|grep -q fixed hello.txt", "--by", "test"]);
  anh(workspace, ["intent", "claim", "--id", String(intent.id), "--passport", String(passport.id)]);

  const workroom = anh(workspace, ["workroom", "create", "--intent", String(intent.id), "--passport", String(passport.id), "--repo", repo, "--branch", "anh/fix-hello"]);
  const worktree = String(workroom.worktreePath);
  assert.ok(existsSync(worktree), "worktree directory exists");
  assert.ok(existsSync(join(worktree, "hello.txt")), "worktree has the repo files");

  writeFileSync(join(worktree, "hello.txt"), "hello fixed\n");
  gitFixture(worktree, ["add", "."]);
  gitFixture(worktree, ["commit", "-qm", "fix hello"]);

  const resultsDir = join(root, "results");
  mkdirSync(resultsDir, { recursive: true });
  writeFileSync(join(resultsDir, "base.json"), JSON.stringify({ "test-hello": "fail" }));
  writeFileSync(join(resultsDir, "head.json"), JSON.stringify({ "test-hello": "pass" }));

  const pack = anh(workspace, [
    "proofpack", "bundle", "--workroom", String(workroom.id),
    "--results-dir", resultsDir,
    "--repro-cmd", "grep -q fixed hello.txt",
  ]) as unknown as {
    id: string; contentHash: string; changedFiles: string[];
    checks: { name: string; verdict: string }[];
  };
  assert.deepEqual(pack.changedFiles, ["hello.txt"]);
  const byName = Object.fromEntries(pack.checks.map((c) => [c.name, c.verdict]));
  assert.equal(byName.diff, "PASS");
  assert.equal(byName.testdelta, "PASS");
  assert.equal(byName.reprocheck, "PASS");
  // No GitHub slug in a local fixture: these must be UNKNOWN, never a fake pass.
  assert.equal(byName.cidiff, "UNKNOWN");
  assert.equal(byName.shipcheck, "UNKNOWN");

  const packFile = join(workspace, ".anh", "proofpacks", `${pack.id}.json`);
  assert.ok(existsSync(packFile), "proof pack file exists in the store");

  const verify = spawnSync("node", [CLI, "proofpack", "verify", "--file", packFile, "--workspace", workspace], { encoding: "utf8" });
  assert.equal(verify.status, 0, verify.stderr || verify.stdout);
  assert.match(verify.stdout, /VALID/);

  const tampered = JSON.parse(readFileSync(packFile, "utf8")) as { diffSummary: string };
  tampered.diffSummary = "tampered";
  const tamperedFile = join(root, "tampered.json");
  writeFileSync(tamperedFile, JSON.stringify(tampered));
  const verifyBad = spawnSync("node", [CLI, "proofpack", "verify", "--file", tamperedFile, "--workspace", workspace], { encoding: "utf8" });
  assert.equal(verifyBad.status, 1);
  assert.match(verifyBad.stdout + verifyBad.stderr, /INVALID/);

  const inboxBefore = spawnSync("node", [CLI, "inbox", "list", "--workspace", workspace], { encoding: "utf8" });
  assert.match(inboxBefore.stdout, new RegExp(pack.id));

  const decided = anh(workspace, ["review", "decide", "--pack", pack.id, "--decision", "approve", "--reviewer", "test-reviewer"]) as unknown as {
    decision: { decision: string };
    reputationEvent: { outcome: string; passportId: string };
  };
  assert.equal(decided.decision.decision, "approve");
  assert.equal(decided.reputationEvent.outcome, "accepted");
  assert.equal(decided.reputationEvent.passportId, passport.id);

  const inboxAfter = spawnSync("node", [CLI, "inbox", "list", "--workspace", workspace], { encoding: "utf8" });
  assert.doesNotMatch(inboxAfter.stdout, new RegExp(pack.id));
});
