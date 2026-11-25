// Reputation derivation: every review decision writes exactly one
// reputation event against the passport that did the work.

import { newId } from "./hash.ts";
import type { DecisionKind, ReputationEvent, ReputationOutcome, ReviewDecision } from "./types.ts";

export function outcomeForDecision(decision: DecisionKind): ReputationOutcome {
  if (decision === "approve") return "accepted";
  if (decision === "reject") return "rejected";
  return "rework_requested";
}

export interface ReputationSummary {
  passportId: string;
  agentId?: string;
  total: number;
  accepted: number;
  rejected: number;
  reworkRequested: number;
  acceptanceRate: number | null;
  lastOutcome?: ReputationOutcome;
  lastAt?: string;
}

// Aggregate reputation events per passport. Counts come only from events
// actually recorded in the store; a passport with no events gets total 0
// and a null acceptance rate, never an invented score.
export function summarizeReputation(
  events: ReputationEvent[],
  agentIdByPassport: Map<string, string> = new Map(),
): ReputationSummary[] {
  const byPassport = new Map<string, ReputationEvent[]>();
  for (const ev of events) {
    const list = byPassport.get(ev.passportId) ?? [];
    list.push(ev);
    byPassport.set(ev.passportId, list);
  }
  const summaries: ReputationSummary[] = [];
  for (const [passportId, list] of byPassport) {
    const sorted = [...list].sort((a, b) => a.at.localeCompare(b.at));
    const accepted = list.filter((e) => e.outcome === "accepted").length;
    const rejected = list.filter((e) => e.outcome === "rejected").length;
    const reworkRequested = list.filter((e) => e.outcome === "rework_requested").length;
    const last = sorted[sorted.length - 1];
    summaries.push({
      passportId,
      agentId: agentIdByPassport.get(passportId),
      total: list.length,
      accepted,
      rejected,
      reworkRequested,
      acceptanceRate: list.length ? accepted / list.length : null,
      lastOutcome: last?.outcome,
      lastAt: last?.at,
    });
  }
  return summaries.sort((a, b) => a.passportId.localeCompare(b.passportId));
}

export function deriveReputationEvent(decision: ReviewDecision): ReputationEvent {
  return {
    kind: "reputation_event",
    id: newId("rep"),
    passportId: decision.passportId,
    decisionId: decision.id,
    proofPackId: decision.proofPackId,
    outcome: outcomeForDecision(decision.decision),
    at: decision.decidedAt,
  };
}
