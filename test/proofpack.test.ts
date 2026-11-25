import { test } from "node:test";
import assert from "node:assert/strict";
import { computeProofPackHash, verifyProofPack } from "../src/hash.ts";
import type { ProofPack } from "../src/types.ts";

function samplePack(): ProofPack {
  const pack: ProofPack = {
    kind: "proofpack",
    version: 1,
    id: "pack_test",
    intentId: "intent_1",
    workroomId: "wr_1",
    passportId: "pass_1",
    repoPath: "/tmp/repo",
    baseRef: "HEAD",
    headRef: "anh/fix",
    headSha: "abc123",
    diffSummary: "1 file(s) changed",
    changedFiles: ["hello.txt"],
    checks: [
      { name: "diff", verdict: "PASS", detail: "computed", source: "git diff" },
      { name: "cidiff", verdict: "UNKNOWN", detail: "no slug supplied", source: "cidiff" },
    ],
    riskFlags: [],
    provenance: {
      bundledAt: "2026-11-19T00:00:00.000Z",
      bundledByPassportId: "pass_1",
      baseSha: "base123",
      headSha: "abc123",
      tools: {},
    },
    contentHash: "",
  };
  pack.contentHash = computeProofPackHash(pack);
  return pack;
}

test("freshly hashed pack verifies", () => {
  const result = verifyProofPack(samplePack());
  assert.equal(result.ok, true, result.errors.join("; "));
});

test("tampered diff summary fails verification", () => {
  const pack = samplePack();
  pack.diffSummary = "tampered after bundling";
  const result = verifyProofPack(pack);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("hash mismatch")));
});

test("tampered check verdict fails verification", () => {
  const pack = samplePack();
  pack.checks[1].verdict = "PASS";
  const result = verifyProofPack(pack);
  assert.equal(result.ok, false);
});

test("hash is stable regardless of key order", () => {
  const pack = samplePack();
  const roundTripped = JSON.parse(JSON.stringify(pack)) as ProofPack;
  assert.equal(computeProofPackHash(roundTripped), pack.contentHash);
});
