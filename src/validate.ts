// Hand rolled validators. Each returns a list of human readable errors.
// An empty list means valid. No external schema dependency.

import type { Passport, Intent, Workroom, ProofPack, ReviewDecision, VettingRecord } from "./types.ts";

const RIGHTS = ["read", "propose", "merge"];
const PASSPORT_STATUS = ["active", "suspended", "expired", "revoked"];
const CLAIM_STATES = ["unclaimed", "claimed", "released", "completed"];
const VERDICTS = ["PASS", "FAIL", "UNKNOWN"];
const DECISIONS = ["approve", "reject", "changes"];

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function reqString(obj: Record<string, unknown>, field: string, errors: string[], prefix = ""): void {
  const v = obj[field];
  if (typeof v !== "string" || v.trim() === "") {
    errors.push(`${prefix}${field} is required and must be a non-empty string`);
  }
}

function optString(obj: Record<string, unknown>, field: string, errors: string[], prefix = ""): void {
  const v = obj[field];
  if (v !== undefined && typeof v !== "string") {
    errors.push(`${prefix}${field} must be a string when present`);
  }
}

function stringArray(obj: Record<string, unknown>, field: string, errors: string[], prefix = ""): void {
  const v = obj[field];
  if (!Array.isArray(v) || v.some((e) => typeof e !== "string")) {
    errors.push(`${prefix}${field} must be an array of strings`);
  }
}

export function validatePassport(x: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(x)) return ["passport must be an object"];
  if (x.kind !== "passport") errors.push('kind must be "passport"');
  reqString(x, "id", errors);
  reqString(x, "agentId", errors);
  reqString(x, "humanOwner", errors);
  optString(x, "harness", errors);
  if (x.mcp !== undefined) {
    if (!isRecord(x.mcp)) {
      errors.push("mcp must be an object when present");
    } else {
      optString(x.mcp, "dir", errors, "mcp.");
      if (x.mcp.command !== undefined) {
        if (!Array.isArray(x.mcp.command) || x.mcp.command.length === 0 || x.mcp.command.some((e) => typeof e !== "string" || e.trim() === "")) {
          errors.push("mcp.command must be a non-empty array of non-empty strings when present");
        }
      }
      if (x.mcp.dir === undefined && x.mcp.command === undefined) {
        errors.push("mcp must name a dir, a command, or both when present");
      }
    }
  }
  reqString(x, "createdAt", errors);
  if (typeof x.status !== "string" || !PASSPORT_STATUS.includes(x.status)) {
    errors.push(`status must be one of: ${PASSPORT_STATUS.join(", ")}`);
  }
  if (!Array.isArray(x.scopes) || x.scopes.length === 0) {
    errors.push("scopes must be a non-empty array");
  } else {
    x.scopes.forEach((s, i) => {
      const p = `scopes[${i}].`;
      if (!isRecord(s)) {
        errors.push(`scopes[${i}] must be an object`);
        return;
      }
      reqString(s, "repo", errors, p);
      stringArray(s, "paths", errors, p);
      if (typeof s.rights !== "string" || !RIGHTS.includes(s.rights)) {
        errors.push(`${p}rights must be one of: ${RIGHTS.join(", ")}`);
      }
    });
  }
  if (x.limits !== undefined) {
    if (!isRecord(x.limits)) {
      errors.push("limits must be an object");
    } else {
      optString(x.limits, "expiresAt", errors, "limits.");
      for (const f of ["maxMinutes", "maxSpendUsd"]) {
        const v = x.limits[f];
        if (v !== undefined && (typeof v !== "number" || Number.isNaN(v) || v < 0)) {
          errors.push(`limits.${f} must be a non-negative number when present`);
        }
      }
    }
  }
  return errors;
}

export function validateIntent(x: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(x)) return ["intent must be an object"];
  if (x.kind !== "intent") errors.push('kind must be "intent"');
  reqString(x, "id", errors);
  reqString(x, "goal", errors);
  optString(x, "repo", errors);
  if (typeof x.repo === "string" && x.repo.trim() !== "" && !/^[^\s/]+\/[^\s/]+$/.test(x.repo.trim())) {
    errors.push("repo must be a repo slug like owner/repo when present");
  }
  if (typeof x.repo === "string" && x.repo.trim() === "") {
    errors.push("repo must be a non-empty repo slug when present");
  }
  reqString(x, "createdAt", errors);
  reqString(x, "createdBy", errors);
  if (!Array.isArray(x.acceptanceCriteria) || x.acceptanceCriteria.length === 0) {
    errors.push("acceptanceCriteria must be a non-empty array: an intent needs testable criteria");
  } else {
    x.acceptanceCriteria.forEach((c, i) => {
      if (!isRecord(c)) {
        errors.push(`acceptanceCriteria[${i}] must be an object`);
        return;
      }
      reqString(c, "id", errors, `acceptanceCriteria[${i}].`);
      reqString(c, "description", errors, `acceptanceCriteria[${i}].`);
      optString(c, "test", errors, `acceptanceCriteria[${i}].`);
    });
  }
  stringArray(x, "contextRefs", errors);
  stringArray(x, "forbiddenAreas", errors);
  if (!isRecord(x.claim)) {
    errors.push("claim must be an object");
  } else if (typeof x.claim.state !== "string" || !CLAIM_STATES.includes(x.claim.state)) {
    errors.push(`claim.state must be one of: ${CLAIM_STATES.join(", ")}`);
  }
  return errors;
}

export function validateWorkroom(x: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(x)) return ["workroom must be an object"];
  if (x.kind !== "workroom") errors.push('kind must be "workroom"');
  for (const f of ["id", "repoPath", "branch", "worktreePath", "baseRef", "baseSha", "intentId", "passportId", "createdAt"]) {
    reqString(x, f, errors);
  }
  if (x.status !== "open" && x.status !== "closed" && x.status !== "killed") {
    errors.push('status must be "open", "closed", or "killed"');
  }
  optString(x, "closedAt", errors);
  optString(x, "closeReason", errors);
  if (!Array.isArray(x.runLog)) errors.push("runLog must be an array");
  return errors;
}

export function validateProofPack(x: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(x)) return ["proof pack must be an object"];
  if (x.kind !== "proofpack") errors.push('kind must be "proofpack"');
  if (x.version !== 1) errors.push("version must be 1");
  for (const f of ["id", "intentId", "workroomId", "passportId", "repoPath", "baseRef", "headRef", "headSha", "diffSummary", "contentHash"]) {
    reqString(x, f, errors);
  }
  stringArray(x, "changedFiles", errors);
  stringArray(x, "riskFlags", errors);
  if (!Array.isArray(x.checks) || x.checks.length === 0) {
    errors.push("checks must be a non-empty array");
  } else {
    x.checks.forEach((c, i) => {
      if (!isRecord(c)) {
        errors.push(`checks[${i}] must be an object`);
        return;
      }
      reqString(c, "name", errors, `checks[${i}].`);
      reqString(c, "detail", errors, `checks[${i}].`);
      reqString(c, "source", errors, `checks[${i}].`);
      if (typeof c.verdict !== "string" || !VERDICTS.includes(c.verdict)) {
        errors.push(`checks[${i}].verdict must be one of: ${VERDICTS.join(", ")}`);
      }
    });
  }
  if (!isRecord(x.provenance)) {
    errors.push("provenance must be an object");
  } else {
    for (const f of ["bundledAt", "bundledByPassportId", "baseSha", "headSha"]) {
      reqString(x.provenance, f, errors, "provenance.");
    }
  }
  return errors;
}

export function validateReviewDecision(x: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(x)) return ["review decision must be an object"];
  if (x.kind !== "review_decision") errors.push('kind must be "review_decision"');
  for (const f of ["id", "proofPackId", "intentId", "passportId", "reviewer", "decidedAt"]) {
    reqString(x, f, errors);
  }
  if (typeof x.decision !== "string" || !DECISIONS.includes(x.decision)) {
    errors.push(`decision must be one of: ${DECISIONS.join(", ")}`);
  }
  if (!Array.isArray(x.feedback)) {
    errors.push("feedback must be an array");
  } else if (x.decision === "changes" && x.feedback.length === 0) {
    errors.push("a changes decision requires at least one structured feedback item");
  }
  return errors;
}

const VETTING_TRIGGERS = ["issue", "renew", "manual"];

export function validateVettingRecord(x: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(x)) return ["vetting record must be an object"];
  if (x.kind !== "vetting_record") errors.push('kind must be "vetting_record"');
  reqString(x, "id", errors);
  reqString(x, "passportId", errors);
  reqString(x, "at", errors);
  if (typeof x.trigger !== "string" || !VETTING_TRIGGERS.includes(x.trigger)) {
    errors.push(`trigger must be one of: ${VETTING_TRIGGERS.join(", ")}`);
  }
  if (typeof x.overall !== "string" || !VERDICTS.includes(x.overall)) {
    errors.push(`overall must be one of: ${VERDICTS.join(", ")}`);
  }
  if (!Array.isArray(x.checks) || x.checks.length === 0) {
    errors.push("checks must be a non-empty array");
  } else {
    x.checks.forEach((c, i) => {
      if (!isRecord(c)) {
        errors.push(`checks[${i}] must be an object`);
        return;
      }
      reqString(c, "name", errors, `checks[${i}].`);
      reqString(c, "detail", errors, `checks[${i}].`);
      reqString(c, "source", errors, `checks[${i}].`);
      if (typeof c.verdict !== "string" || !VERDICTS.includes(c.verdict)) {
        errors.push(`checks[${i}].verdict must be one of: ${VERDICTS.join(", ")}`);
      }
    });
  }
  return errors;
}

// Typed wrappers used after validation passes.
export function asPassport(x: unknown): Passport {
  const e = validatePassport(x);
  if (e.length) throw new Error(`invalid passport: ${e.join("; ")}`);
  return x as Passport;
}
export function asIntent(x: unknown): Intent {
  const e = validateIntent(x);
  if (e.length) throw new Error(`invalid intent: ${e.join("; ")}`);
  return x as Intent;
}
export function asWorkroom(x: unknown): Workroom {
  const e = validateWorkroom(x);
  if (e.length) throw new Error(`invalid workroom: ${e.join("; ")}`);
  return x as Workroom;
}
export function asProofPack(x: unknown): ProofPack {
  const e = validateProofPack(x);
  if (e.length) throw new Error(`invalid proof pack: ${e.join("; ")}`);
  return x as ProofPack;
}
export function asReviewDecision(x: unknown): ReviewDecision {
  const e = validateReviewDecision(x);
  if (e.length) throw new Error(`invalid review decision: ${e.join("; ")}`);
  return x as ReviewDecision;
}
export function asVettingRecord(x: unknown): VettingRecord {
  const e = validateVettingRecord(x);
  if (e.length) throw new Error(`invalid vetting record: ${e.join("; ")}`);
  return x as VettingRecord;
}
