// Core data objects for the agent native platform prototype.
// Six objects only, per the MVP build plan: Passport, Intent, Workroom,
// ProofPack, ReviewDecision, ReputationEvent.

export type Verdict = "PASS" | "FAIL" | "UNKNOWN";
export type Rights = "read" | "propose" | "merge";
export type PassportStatus = "active" | "suspended" | "expired" | "revoked";
export type ClaimState = "unclaimed" | "claimed" | "released" | "completed";
export type DecisionKind = "approve" | "reject" | "changes";
export type ReputationOutcome = "accepted" | "rejected" | "rework_requested";

export interface PassportScope {
  repo: string;
  paths: string[];
  rights: Rights;
}

export interface PassportLimits {
  expiresAt?: string;
  maxMinutes?: number;
  maxSpendUsd?: number;
}

export interface PassportUsage {
  spendUsd: number;
  updatedAt?: string;
}

// The MCP surface an agent brings with it: the server directory mcpvet
// scans statically before install, and the stdio launch command mcpaudit
// audits live. Both are optional; a passport with no surface configured
// is issued and renewed without vetting, exactly as before this existed.
export interface PassportMcpSurface {
  dir?: string;
  command?: string[];
}

export interface Passport {
  kind: "passport";
  id: string;
  agentId: string;
  humanOwner: string;
  harness?: string;
  mcp?: PassportMcpSurface;
  scopes: PassportScope[];
  limits: PassportLimits;
  usage?: PassportUsage;
  status: PassportStatus;
  createdAt: string;
}

export type VettingTrigger = "issue" | "renew" | "manual";

// One recorded vetting run against a passport's MCP surface. Each check
// is a CheckResult on the usual PASS / FAIL / UNKNOWN scale: only a
// decisive tool verdict maps to PASS or FAIL, everything else (REVIEW,
// WARN, UNREACHABLE, a missing tool, unparseable output) is UNKNOWN with
// the reason in the detail. The overall verdict is FAIL when any check
// fails, UNKNOWN when none fails but at least one is unknown, else PASS.
export interface VettingRecord {
  kind: "vetting_record";
  id: string;
  passportId: string;
  trigger: VettingTrigger;
  checks: CheckResult[];
  overall: Verdict;
  at: string;
}

// A scoped token is a credential minted for one passport. Only the SHA-256
// hash is stored; the raw token is shown once at issuance and never saved.
export interface ScopedToken {
  kind: "scoped_token";
  id: string;
  passportId: string;
  tokenHash: string;
  label?: string;
  createdAt: string;
  expiresAt?: string;
  revoked: boolean;
}

// A one time token delivery envelope. The raw token is encrypted with a
// key derived from a separate delivery code; the envelope on disk holds
// only ciphertext, never the raw token and never the delivery code. The
// code is shown once at creation and handed to the receiving agent out of
// band; redeeming is single use and wipes the ciphertext.
export interface TokenDelivery {
  kind: "token_delivery";
  id: string;
  passportId: string;
  tokenId: string;
  label?: string;
  ciphertext: string;
  iv: string;
  authTag: string;
  createdAt: string;
  expiresAt: string;
  consumedAt?: string;
}

export interface AcceptanceCriterion {
  id: string;
  description: string;
  test?: string;
}

export interface IntentClaim {
  state: ClaimState;
  passportId?: string;
  claimedAt?: string;
  expiresAt?: string;
}

export interface Intent {
  kind: "intent";
  id: string;
  goal: string;
  // Repo slug this intent targets, for example "CloudCorpRecords/xod" or
  // "local/agent-native-github". Optional for backward compatibility with
  // intents filed before this field existed; when present, intent claim
  // enforces passport repo scope against it at propose rights.
  repo?: string;
  acceptanceCriteria: AcceptanceCriterion[];
  contextRefs: string[];
  forbiddenAreas: string[];
  claim: IntentClaim;
  createdAt: string;
  createdBy: string;
}

export interface RunLogEntry {
  at: string;
  event: string;
  detail: string;
}

export type WorkroomStatus = "open" | "closed" | "killed";

export interface Workroom {
  kind: "workroom";
  id: string;
  repoPath: string;
  branch: string;
  worktreePath: string;
  baseRef: string;
  baseSha: string;
  intentId: string;
  passportId: string;
  repoKey?: string;
  status: WorkroomStatus;
  runLog: RunLogEntry[];
  createdAt: string;
  closedAt?: string;
  closeReason?: string;
}

export interface CheckResult {
  name: string;
  verdict: Verdict;
  detail: string;
  source: string;
}

export interface ProofPackProvenance {
  bundledAt: string;
  bundledByPassportId: string;
  baseSha: string;
  headSha: string;
  tools: Record<string, string | null>;
}

export interface ProofPack {
  kind: "proofpack";
  version: 1;
  id: string;
  intentId: string;
  workroomId: string;
  passportId: string;
  repoPath: string;
  baseRef: string;
  headRef: string;
  headSha: string;
  diffSummary: string;
  changedFiles: string[];
  checks: CheckResult[];
  riskFlags: string[];
  provenance: ProofPackProvenance;
  contentHash: string;
}

export interface FeedbackItem {
  category: string;
  message: string;
}

export interface ReviewDecision {
  kind: "review_decision";
  id: string;
  proofPackId: string;
  intentId: string;
  passportId: string;
  decision: DecisionKind;
  feedback: FeedbackItem[];
  reviewer: string;
  decidedAt: string;
}

// Result of one GitHub PR sync attempt. Status is "posted" only when the
// transport confirmed a live PR URL; anything else is "unknown" with the
// reason recorded. A sync record never claims a PR that was not confirmed.
export interface PrSyncRecord {
  kind: "pr_sync";
  id: string;
  workroomId: string;
  proofPackId: string;
  repoSlug: string;
  branch: string;
  base: string;
  status: "posted" | "unknown";
  url?: string;
  prNumber?: number;
  reason: string;
  transport: string;
  at: string;
}

export interface ReputationEvent {
  kind: "reputation_event";
  id: string;
  passportId: string;
  decisionId: string;
  proofPackId: string;
  outcome: ReputationOutcome;
  at: string;
}
