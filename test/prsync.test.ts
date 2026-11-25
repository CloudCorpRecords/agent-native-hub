import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeProofPackHash } from "../src/hash.ts";
import { buildPrPayload, buildProofPackSection, GhCliTransport, syncPr, type CmdRunner, type PrTransport } from "../src/prsync.ts";
import { Store } from "../src/store.ts";
import type { Intent, Passport, ProofPack, Workroom } from "../src/types.ts";

function fixtures(scopes: Passport["scopes"]) {
  const store = new Store(mkdtempSync(join(tmpdir(), "anh-prsync-")));
  const passport: Passport = {
    kind: "passport", id: "pass_sync", agentId: "agent-sync", humanOwner: "owner",
    scopes, limits: {}, status: "active", createdAt: new Date().toISOString(),
  };
  const intent: Intent = {
    kind: "intent", id: "intent_sync", goal: "fix the thing",
    acceptanceCriteria: [{ id: "c1", description: "thing is fixed", test: "true" }],
    contextRefs: [], forbiddenAreas: [], claim: { state: "claimed", passportId: passport.id },
    createdAt: new Date().toISOString(), createdBy: "test",
  };
  const workroom: Workroom = {
    kind: "workroom", id: "wr_sync", repoPath: "/tmp/nope", branch: "anh/fix", worktreePath: "/tmp/nope-wt",
    baseRef: "HEAD", baseSha: "base123", intentId: intent.id, passportId: passport.id,
    status: "open", runLog: [], createdAt: new Date().toISOString(),
  };
  const pack: ProofPack = {
    kind: "proofpack", version: 1, id: "pack_sync", intentId: intent.id, workroomId: workroom.id,
    passportId: passport.id, repoPath: "/tmp/nope", baseRef: "HEAD", headRef: "anh/fix", headSha: "head456",
    diffSummary: "1 file changed", changedFiles: ["a.txt"],
    checks: [{ name: "diff", verdict: "PASS", detail: "ok", source: "git diff" }],
    riskFlags: [],
    provenance: { bundledAt: new Date().toISOString(), bundledByPassportId: passport.id, baseSha: "base123", headSha: "head456", tools: {} },
    contentHash: "",
  };
  pack.contentHash = computeProofPackHash(pack);
  store.save("passports", passport);
  store.save("intents", intent);
  store.save("workrooms", workroom);
  store.save("proofpacks", pack);
  return { store, passport, intent, workroom, pack };
}

const goodScopes: Passport["scopes"] = [{ repo: "owner/repo", paths: ["**"], rights: "propose" }];

test("payload builder carries the proof pack section with hash and verdicts", () => {
  const { intent, workroom, pack } = fixtures(goodScopes);
  const section = buildProofPackSection(pack, intent);
  assert.match(section, /Proof pack \(anh\)/);
  assert.match(section, new RegExp(pack.contentHash));
  assert.match(section, /diff: PASS/);
  const payload = buildPrPayload({ repoSlug: "owner/repo", base: "main", workroom, pack, intent });
  assert.equal(payload.head, "anh/fix");
  assert.equal(payload.base, "main");
  assert.match(payload.title, /fix the thing/);
  assert.equal(payload.body, section);
});

test("sync with an unavailable transport records UNKNOWN and no URL", () => {
  const { store, workroom } = fixtures(goodScopes);
  const transport: PrTransport = {
    name: "fake-down",
    check: () => ({ available: false, reason: "not authenticated in fixture" }),
    openOrUpdate: () => { throw new Error("must not be called"); },
  };
  const rec = syncPr(store, { workroomId: workroom.id, repoSlug: "owner/repo", base: "main", transport });
  assert.equal(rec.status, "unknown");
  assert.equal(rec.url, undefined);
  assert.match(rec.reason, /not authenticated in fixture/);
  const saved = store.list("prsyncs");
  assert.equal(saved.length, 1);
});

test("sync posted path: local bare remote push plus a confirming transport records posted with URL", () => {
  const { store, workroom } = fixtures(goodScopes);
  const root = mkdtempSync(join(tmpdir(), "anh-prsync-git-"));
  const bare = join(root, "remote.git");
  const repo = join(root, "repo");
  const git = (cwd: string, args: string[]) =>
    execFileSync("git", ["-c", "user.name=Anh Test", "-c", "user.email=anh-test@example.com", ...args], { cwd, stdio: "pipe" });
  execFileSync("git", ["init", "-q", "--bare", bare], { stdio: "pipe" });
  execFileSync("git", ["init", "-q", repo], { stdio: "pipe" });
  writeFileSync(join(repo, "a.txt"), "hi\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-qm", "base"]);
  git(repo, ["remote", "add", "origin", bare]);
  // Point the stored workroom at this real repo so the push step runs for real.
  const wr = store.load<Workroom>("workrooms", workroom.id) as Workroom;
  wr.worktreePath = repo;
  wr.repoPath = repo;
  store.save("workrooms", wr);
  let seenPayload: unknown = null;
  const transport: PrTransport = {
    name: "fake-up",
    check: () => ({ available: true, reason: "ok" }),
    openOrUpdate: (payload) => {
      seenPayload = payload;
      return { posted: true, url: "https://github.com/owner/repo/pull/7", prNumber: 7, reason: "confirmed by fixture transport" };
    },
  };
  const rec = syncPr(store, { workroomId: workroom.id, repoSlug: "owner/repo", base: "main", transport });
  assert.equal(rec.status, "posted");
  assert.equal(rec.url, "https://github.com/owner/repo/pull/7");
  assert.equal(rec.prNumber, 7);
  assert.ok(seenPayload, "transport received the payload");
  // The branch really landed on the remote.
  const refs = execFileSync("git", ["--git-dir", bare, "branch", "--list", "anh/fix"], { encoding: "utf8" });
  assert.match(refs, /anh\/fix/);
});

// A scripted gh: each entry maps a joined args string to a canned result.
// Any unscripted call fails loudly so a test cannot pass on a call it did
// not model.
function fakeGh(script: Record<string, { code: number; stdout?: string; stderr?: string }>): { run: CmdRunner; calls: string[] } {
  const calls: string[] = [];
  const run: CmdRunner = (_cmd, args) => {
    const key = args.join(" ");
    calls.push(key);
    const hit = script[key];
    if (!hit) return { code: 99, stdout: "", stderr: `unscripted gh call: ${key}` };
    return { code: hit.code, stdout: hit.stdout ?? "", stderr: hit.stderr ?? "" };
  };
  return { run, calls };
}

test("gh transport: missing gh binary reports unavailable without probing auth", () => {
  const { run, calls } = fakeGh({ "--version": { code: 1, stderr: "not found" } });
  const check = new GhCliTransport(run).check();
  assert.equal(check.available, false);
  assert.match(check.reason, /not found on PATH/);
  assert.deepEqual(calls, ["--version"]);
});

test("gh transport: clean auth status reports available and never calls the API", () => {
  const { run, calls } = fakeGh({
    "--version": { code: 0, stdout: "gh version 2.0.0" },
    "auth status": { code: 0, stdout: "Logged in" },
  });
  const check = new GhCliTransport(run).check();
  assert.equal(check.available, true);
  assert.deepEqual(calls, ["--version", "auth status"]);
});

test("gh transport: stale account entry in auth status falls back to gh api user and reports available", () => {
  const { run, calls } = fakeGh({
    "--version": { code: 0, stdout: "gh version 2.0.0" },
    "auth status": { code: 1, stderr: "Failed to log in to github.com account old-account (token invalid)" },
    "api user --jq .login": { code: 0, stdout: "CloudCorpRecords\n" },
  });
  const check = new GhCliTransport(run).check();
  assert.equal(check.available, true);
  assert.match(check.reason, /stale account entry/);
  assert.match(check.reason, /CloudCorpRecords/);
  assert.deepEqual(calls, ["--version", "auth status", "api user --jq .login"]);
});

test("gh transport: auth status fails and api user fails too, so the transport is unavailable", () => {
  const { run } = fakeGh({
    "--version": { code: 0, stdout: "gh version 2.0.0" },
    "auth status": { code: 1, stderr: "You are not logged into any GitHub hosts" },
    "api user --jq .login": { code: 1, stderr: "HTTP 401: Bad credentials" },
  });
  const check = new GhCliTransport(run).check();
  assert.equal(check.available, false);
  assert.match(check.reason, /not authenticated/);
  assert.match(check.reason, /not logged into any GitHub hosts/);
});

test("sync denies a passport with no scope on the target repo", () => {
  const { store, workroom } = fixtures([{ repo: "someone/else", paths: ["**"], rights: "merge" }]);
  const transport: PrTransport = {
    name: "fake-up",
    check: () => ({ available: true, reason: "ok" }),
    openOrUpdate: () => ({ posted: true, url: "https://example.invalid/pr/1", reason: "ok" }),
  };
  assert.throws(
    () => syncPr(store, { workroomId: workroom.id, repoSlug: "owner/repo", base: "main", transport }),
    /no scope granting propose on repo owner\/repo/,
  );
  assert.equal(store.list("prsyncs").length, 0);
});
