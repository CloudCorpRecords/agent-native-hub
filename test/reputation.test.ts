import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveReputationEvent, outcomeForDecision, summarizeReputation } from "../src/reputation.ts";
import type { ReputationEvent, ReviewDecision } from "../src/types.ts";

test("decision outcomes map correctly", () => {
  assert.equal(outcomeForDecision("approve"), "accepted");
  assert.equal(outcomeForDecision("reject"), "rejected");
  assert.equal(outcomeForDecision("changes"), "rework_requested");
});

function decision(kind: ReviewDecision["decision"]): ReviewDecision {
  return {
    kind: "review_decision",
    id: "dec_1",
    proofPackId: "pack_1",
    intentId: "intent_1",
    passportId: "pass_1",
    decision: kind,
    feedback: kind === "changes" ? [{ category: "tests", message: "add a test" }] : [],
    reviewer: "rene",
    decidedAt: "2026-11-19T00:00:00.000Z",
  };
}

function ev(id: string, passportId: string, outcome: ReputationEvent["outcome"], at: string): ReputationEvent {
  return { kind: "reputation_event", id, passportId, decisionId: `dec_${id}`, proofPackId: `pack_${id}`, outcome, at };
}

test("summary counts outcomes per passport and picks the latest event", () => {
  const summaries = summarizeReputation([
    ev("rep_1", "pass_a", "accepted", "2026-11-19T01:00:00.000Z"),
    ev("rep_2", "pass_a", "rejected", "2026-11-19T03:00:00.000Z"),
    ev("rep_3", "pass_a", "accepted", "2026-11-19T02:00:00.000Z"),
    ev("rep_4", "pass_b", "rework_requested", "2026-11-19T01:30:00.000Z"),
  ], new Map([["pass_a", "agent-a"]]));
  assert.equal(summaries.length, 2);
  const a = summaries.find((s) => s.passportId === "pass_a");
  assert.ok(a);
  assert.equal(a.agentId, "agent-a");
  assert.equal(a.total, 3);
  assert.equal(a.accepted, 2);
  assert.equal(a.rejected, 1);
  assert.equal(a.reworkRequested, 0);
  assert.equal(a.acceptanceRate, 2 / 3);
  assert.equal(a.lastOutcome, "rejected");
  assert.equal(a.lastAt, "2026-11-19T03:00:00.000Z");
  const b = summaries.find((s) => s.passportId === "pass_b");
  assert.ok(b);
  assert.equal(b.reworkRequested, 1);
  assert.equal(b.acceptanceRate, 0);
});

test("summary of no events is empty, never an invented score", () => {
  assert.deepEqual(summarizeReputation([]), []);
});

test("derived event carries passport, decision, and outcome", () => {
  const ev = deriveReputationEvent(decision("approve"));
  assert.equal(ev.passportId, "pass_1");
  assert.equal(ev.decisionId, "dec_1");
  assert.equal(ev.proofPackId, "pack_1");
  assert.equal(ev.outcome, "accepted");
  assert.ok(ev.id.startsWith("rep_"));
});
