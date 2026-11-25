import { test } from "node:test";
import assert from "node:assert/strict";
import { validateIntent, validatePassport, validateProofPack, validateReviewDecision } from "../src/validate.ts";

const goodPassport = {
  kind: "passport",
  id: "pass_1",
  agentId: "agent-1",
  humanOwner: "rene",
  scopes: [{ repo: "owner/repo", paths: ["src/**"], rights: "propose" }],
  limits: { maxMinutes: 60 },
  status: "active",
  createdAt: "2026-11-19T00:00:00.000Z",
};

test("valid passport passes", () => {
  assert.deepEqual(validatePassport(goodPassport), []);
});

test("passport without a human owner fails", () => {
  const bad = { ...goodPassport, humanOwner: "" };
  assert.ok(validatePassport(bad).some((e) => e.includes("humanOwner")));
});

test("passport with unknown rights fails", () => {
  const bad = { ...goodPassport, scopes: [{ repo: "o/r", paths: ["x"], rights: "admin" }] };
  assert.ok(validatePassport(bad).some((e) => e.includes("rights")));
});

test("passport with no scopes fails", () => {
  const bad = { ...goodPassport, scopes: [] };
  assert.ok(validatePassport(bad).length > 0);
});

test("passport with negative spend limit fails", () => {
  const bad = { ...goodPassport, limits: { maxSpendUsd: -5 } };
  assert.ok(validatePassport(bad).some((e) => e.includes("maxSpendUsd")));
});

const goodIntent = {
  kind: "intent",
  id: "intent_1",
  goal: "fix the thing",
  acceptanceCriteria: [{ id: "c1", description: "the thing works" }],
  contextRefs: [],
  forbiddenAreas: [],
  claim: { state: "unclaimed" },
  createdAt: "2026-11-19T00:00:00.000Z",
  createdBy: "test",
};

test("valid intent passes", () => {
  assert.deepEqual(validateIntent(goodIntent), []);
});

test("intent without acceptance criteria fails", () => {
  const bad = { ...goodIntent, acceptanceCriteria: [] };
  assert.ok(validateIntent(bad).some((e) => e.includes("acceptanceCriteria")));
});

test("intent with a repo slug passes", () => {
  assert.deepEqual(validateIntent({ ...goodIntent, repo: "CloudCorpRecords/xod" }), []);
  assert.deepEqual(validateIntent({ ...goodIntent, repo: "local/agent-native-github" }), []);
});

test("intent with a malformed repo fails", () => {
  assert.ok(validateIntent({ ...goodIntent, repo: "no-slash-here" }).some((e) => e.includes("repo")));
  assert.ok(validateIntent({ ...goodIntent, repo: "has space/repo" }).some((e) => e.includes("repo")));
  assert.ok(validateIntent({ ...goodIntent, repo: "" }).some((e) => e.includes("repo")));
  assert.ok(validateIntent({ ...goodIntent, repo: 42 }).some((e) => e.includes("repo")));
});

test("intent with a bad claim state fails", () => {
  const bad = { ...goodIntent, claim: { state: "stolen" } };
  assert.ok(validateIntent(bad).length > 0);
});

test("proof pack with a fake verdict value fails", () => {
  const pack = {
    kind: "proofpack",
    version: 1,
    id: "pack_1",
    intentId: "intent_1",
    workroomId: "wr_1",
    passportId: "pass_1",
    repoPath: "/tmp/x",
    baseRef: "HEAD",
    headRef: "anh/x",
    headSha: "abc",
    diffSummary: "one file",
    changedFiles: ["a.txt"],
    checks: [{ name: "diff", verdict: "PASSED", detail: "x", source: "git" }],
    riskFlags: [],
    provenance: { bundledAt: "2026-11-19T00:00:00.000Z", bundledByPassportId: "pass_1", baseSha: "a", headSha: "b", tools: {} },
    contentHash: "deadbeef",
  };
  assert.ok(validateProofPack(pack).some((e) => e.includes("verdict")));
});

test("changes decision without feedback fails", () => {
  const dec = {
    kind: "review_decision",
    id: "dec_1",
    proofPackId: "pack_1",
    intentId: "intent_1",
    passportId: "pass_1",
    decision: "changes",
    feedback: [],
    reviewer: "rene",
    decidedAt: "2026-11-19T00:00:00.000Z",
  };
  assert.ok(validateReviewDecision(dec).some((e) => e.includes("feedback")));
});
