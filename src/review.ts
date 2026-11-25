// Shared review decision path.
// The CLI (review decide) and the web inbox (POST /review) both call
// decideReview, so a decision made in a browser and a decision made on the
// command line go through identical validation, storage, intent updates,
// and reputation derivation.

import { newId, nowIso, verifyProofPack } from "./hash.ts";
import { deriveReputationEvent } from "./reputation.ts";
import type { Store } from "./store.ts";
import { asProofPack, validateReviewDecision } from "./validate.ts";
import type { FeedbackItem, Intent, ProofPack, ReputationEvent, ReviewDecision } from "./types.ts";

export interface DecideInput {
  packId: string;
  decision: ReviewDecision["decision"];
  reviewer: string;
  feedback: FeedbackItem[];
}

export interface DecideResult {
  decision: ReviewDecision;
  reputationEvent: ReputationEvent;
  decisionPath: string;
  reputationPath: string;
}

export function decideReview(store: Store, input: DecideInput): DecideResult {
  const packRaw = store.load<ProofPack>("proofpacks", input.packId);
  if (!packRaw) throw new Error(`proof pack not found: ${input.packId}`);
  const pack = asProofPack(packRaw);
  const check = verifyProofPack(pack);
  if (!check.ok) {
    throw new Error(`refusing to decide on an invalid proof pack: ${check.errors.join("; ")}`);
  }
  const existing = store.list<ReviewDecision>("decisions").find((d) => d.proofPackId === pack.id);
  if (existing) {
    throw new Error(`proof pack ${pack.id} already has decision ${existing.id} (${existing.decision})`);
  }
  const decision: ReviewDecision = {
    kind: "review_decision",
    id: newId("dec"),
    proofPackId: pack.id,
    intentId: pack.intentId,
    passportId: pack.passportId,
    decision: input.decision,
    feedback: input.feedback,
    reviewer: input.reviewer,
    decidedAt: nowIso(),
  };
  const errs = validateReviewDecision(decision);
  if (errs.length) throw new Error(`invalid decision: ${errs.join("; ")}`);
  const decisionPath = store.save("decisions", decision);
  const event = deriveReputationEvent(decision);
  const reputationPath = store.save("reputation", event);
  const intent = store.load<Intent>("intents", pack.intentId);
  if (intent) {
    intent.claim = {
      ...intent.claim,
      state: decision.decision === "approve" ? "completed" : "released",
    };
    store.save("intents", intent);
  }
  return { decision, reputationEvent: event, decisionPath, reputationPath };
}
