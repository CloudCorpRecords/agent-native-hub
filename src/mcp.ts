// MCP server surface for anh (Model Context Protocol, stdio transport).
// The plan is API and MCP first; until now the machine surfaces were the
// CLI and the HTTP inbox only. This module speaks newline delimited
// JSON-RPC 2.0 on stdio, the standard MCP stdio transport, with zero
// external dependencies.
//
// Tools exposed (anh_*):
//   anh_passport_list    list passports with scopes as repo|paths|rights
//   anh_intent_list      list intents with claim state and repo
//   anh_intent_create    file an intent (goal plus acceptance criteria)
//   anh_intent_claim     claim an intent with a passport; the same
//                        enforcement as the CLI claim path (passport
//                        usable, repo scope at propose rights when the
//                        intent names a repo, one live claim at a time)
//   anh_workroom_list    list workrooms
//   anh_inbox_list       proof packs awaiting a review decision
//   anh_proofpack_verify verify a stored proof pack by id (structure
//                        plus content hash, same check as the CLI)
//   anh_reputation_list  per passport reputation summaries and events
//   anh_review_decide    record a review decision through decideReview,
//                        the shared path used by the CLI and web inbox
//
// Deliberately NOT exposed: token issue, deliver, redeem, or verify.
// Raw tokens are shown once by the CLI on purpose; an MCP tool result
// is a loggable transcript, so no tool here mints, carries, or checks a
// raw token. The MCP surface is local stdio, spawned by the agent
// harness that owns the workspace, so it carries the same trust as the
// CLI on that machine; it is not a network surface and adds no auth of
// its own.

import { createInterface } from "node:readline";
import { assertPassportUsable, assertRepoScope } from "./enforce.ts";
import { newId, nowIso, verifyProofPack } from "./hash.ts";
import { decideReview } from "./review.ts";
import { pendingPacks, reputationView } from "./server.ts";
import { Store } from "./store.ts";
import { asIntent, asPassport } from "./validate.ts";
import type { FeedbackItem, Intent, Passport, ProofPack, Workroom } from "./types.ts";

export const MCP_PROTOCOL_VERSION = "2024-11-05";
export const MCP_SERVER_INFO = { name: "anh", version: "0.1.0" };

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const obj = (properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const str = (description: string): Record<string, unknown> => ({ type: "string", description });
const strList = (description: string): Record<string, unknown> => ({
  type: "array",
  items: { type: "string" },
  description,
});

export const MCP_TOOLS: McpToolDef[] = [
  {
    name: "anh_passport_list",
    description: "List all agent passports in the anh store, with scopes, limits, and status.",
    inputSchema: obj({}),
  },
  {
    name: "anh_intent_list",
    description: "List all intents in the anh store, with goal, repo, and claim state.",
    inputSchema: obj({}),
  },
  {
    name: "anh_intent_create",
    description: "File a new intent: a goal plus testable acceptance criteria. Optionally names the target repo slug, which intent claim then enforces passport propose scope against.",
    inputSchema: obj(
      {
        goal: str("The work to be done, in plain words."),
        criteria: strList("Acceptance criteria, one per item. An item may end with |test command to attach a test."),
        repo: str("Optional target repo slug, for example owner/repo or local/name."),
        contextRefs: strList("Optional context references (repos, files, notes)."),
        forbiddenAreas: strList("Optional paths or areas the work must not touch."),
        createdBy: str("Who is filing the intent. Defaults to mcp."),
      },
      ["goal", "criteria"],
    ),
  },
  {
    name: "anh_intent_claim",
    description: "Claim an intent with a passport. Fails when the passport is not usable, when it lacks propose scope on the intent repo, or when the intent is already claimed or completed.",
    inputSchema: obj(
      {
        intentId: str("Intent id to claim."),
        passportId: str("Passport id claiming the intent."),
      },
      ["intentId", "passportId"],
    ),
  },
  {
    name: "anh_workroom_list",
    description: "List all workrooms, with branch, worktree path, status, intent, and passport.",
    inputSchema: obj({}),
  },
  {
    name: "anh_inbox_list",
    description: "List proof packs awaiting a review decision (the review inbox).",
    inputSchema: obj({}),
  },
  {
    name: "anh_proofpack_verify",
    description: "Verify a stored proof pack by id: recomputes the content hash and validates the structure. A tampered pack reports ok false with the errors.",
    inputSchema: obj({ packId: str("Proof pack id.") }, ["packId"]),
  },
  {
    name: "anh_reputation_list",
    description: "Reputation ledger: per passport summaries (counts and acceptance rate from recorded events only) plus events newest first. Optionally filter to one passport.",
    inputSchema: obj({ passportId: str("Optional passport id filter.") }),
  },
  {
    name: "anh_review_decide",
    description: "Record a review decision on a proof pack through the shared review path (same code as the CLI and web inbox). A changes decision requires at least one feedback item. Writes the decision, the reputation event, and the intent state update.",
    inputSchema: obj(
      {
        packId: str("Proof pack id to decide on."),
        decision: { type: "string", enum: ["approve", "reject", "changes"], description: "The decision." },
        reviewer: str("Reviewer name."),
        feedback: {
          type: "array",
          description: "Structured feedback items, required for a changes decision.",
          items: {
            type: "object",
            properties: { category: { type: "string" }, message: { type: "string" } },
            required: ["category", "message"],
            additionalProperties: false,
          },
        },
      },
      ["packId", "decision", "reviewer"],
    ),
  },
];

type Args = Record<string, unknown>;

function needString(args: Args, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || !v) throw new Error(`tool argument ${key} must be a non-empty string`);
  return v;
}

function optString(args: Args, key: string): string | undefined {
  const v = args[key];
  if (v === undefined) return undefined;
  if (typeof v !== "string") throw new Error(`tool argument ${key} must be a string`);
  return v;
}

function optStringList(args: Args, key: string): string[] {
  const v = args[key];
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
    throw new Error(`tool argument ${key} must be an array of strings`);
  }
  return v as string[];
}

export function callMcpTool(store: Store, name: string, args: Args): unknown {
  switch (name) {
    case "anh_passport_list":
      return { passports: store.list<Passport>("passports") };
    case "anh_intent_list":
      return { intents: store.list<Intent>("intents") };
    case "anh_intent_create": {
      const criteria = optStringList(args, "criteria");
      if (!criteria.length) throw new Error("at least one acceptance criterion is required");
      const intent: Intent = {
        kind: "intent",
        id: newId("intent"),
        goal: needString(args, "goal"),
        ...(optString(args, "repo") ? { repo: optString(args, "repo") } : {}),
        acceptanceCriteria: criteria.map((c, i) => {
          const [description, test] = c.split("|");
          return { id: `c${i + 1}`, description, ...(test ? { test } : {}) };
        }),
        contextRefs: optStringList(args, "contextRefs"),
        forbiddenAreas: optStringList(args, "forbiddenAreas"),
        claim: { state: "unclaimed" },
        createdAt: nowIso(),
        createdBy: optString(args, "createdBy") ?? "mcp",
      };
      const checked = asIntent(intent);
      store.save("intents", checked);
      return { intent: checked };
    }
    case "anh_intent_claim": {
      const intentRaw = store.load<Intent>("intents", needString(args, "intentId"));
      if (!intentRaw) throw new Error(`intent not found: ${String(args.intentId)}`);
      const intent = asIntent(intentRaw);
      const passportRaw = store.load<Passport>("passports", needString(args, "passportId"));
      if (!passportRaw) throw new Error(`passport not found: ${String(args.passportId)}`);
      const passport = asPassport(passportRaw);
      assertPassportUsable(passport);
      if (intent.repo) assertRepoScope(passport, intent.repo, "propose");
      const claimExpired = intent.claim.expiresAt ? Date.parse(intent.claim.expiresAt) < Date.now() : false;
      if (intent.claim.state === "claimed" && !claimExpired) {
        throw new Error(`intent ${intent.id} already claimed by ${intent.claim.passportId}`);
      }
      if (intent.claim.state === "completed") throw new Error(`intent ${intent.id} is already completed`);
      intent.claim = { state: "claimed", passportId: passport.id, claimedAt: nowIso() };
      store.save("intents", intent);
      return { intent };
    }
    case "anh_workroom_list":
      return { workrooms: store.list<Workroom>("workrooms") };
    case "anh_inbox_list":
      return { pending: pendingPacks(store) };
    case "anh_proofpack_verify": {
      const packId = needString(args, "packId");
      const pack = store.load<ProofPack>("proofpacks", packId);
      if (!pack) throw new Error(`proof pack not found: ${packId}`);
      return verifyProofPack(pack);
    }
    case "anh_reputation_list": {
      const view = reputationView(store);
      const filter = optString(args, "passportId");
      if (!filter) return view;
      return {
        summaries: view.summaries.filter((s) => s.passportId === filter),
        events: view.events.filter((e) => e.passportId === filter),
      };
    }
    case "anh_review_decide": {
      const decision = needString(args, "decision");
      if (!["approve", "reject", "changes"].includes(decision)) {
        throw new Error(`decision must be approve, reject, or changes, got: ${decision}`);
      }
      const rawFeedback = args.feedback ?? [];
      if (!Array.isArray(rawFeedback)) throw new Error("tool argument feedback must be an array");
      const feedback: FeedbackItem[] = rawFeedback.map((f) => {
        const item = f as { category?: unknown; message?: unknown };
        if (typeof item?.category !== "string" || typeof item?.message !== "string") {
          throw new Error("feedback items must be objects with string category and message");
        }
        return { category: item.category, message: item.message };
      });
      const { decision: recorded, reputationEvent } = decideReview(store, {
        packId: needString(args, "packId"),
        decision: decision as "approve" | "reject" | "changes",
        reviewer: needString(args, "reviewer"),
        feedback,
      });
      return { decision: recorded, reputationEvent };
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

export interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

// Handle one JSON-RPC message. Returns the response object to write, or
// null for notifications (which never get a response).
export function handleMcpMessage(store: Store, msg: JsonRpcRequest): Record<string, unknown> | null {
  const isNotification = msg.id === undefined || msg.id === null;
  if (typeof msg.method !== "string") {
    if (isNotification) return null;
    return { jsonrpc: "2.0", id: msg.id ?? null, error: { code: -32600, message: "invalid request: method must be a string" } };
  }
  if (msg.method.startsWith("notifications/")) return null;
  const respond = (result: unknown): Record<string, unknown> => ({ jsonrpc: "2.0", id: msg.id ?? null, result });
  const fail = (code: number, message: string): Record<string, unknown> => ({
    jsonrpc: "2.0",
    id: msg.id ?? null,
    error: { code, message },
  });
  switch (msg.method) {
    case "initialize": {
      const requested = (msg.params as { protocolVersion?: unknown } | undefined)?.protocolVersion;
      return respond({
        protocolVersion: typeof requested === "string" && requested ? requested : MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: MCP_SERVER_INFO,
      });
    }
    case "ping":
      return respond({});
    case "tools/list":
      return respond({ tools: MCP_TOOLS });
    case "tools/call": {
      const params = (msg.params ?? {}) as { name?: unknown; arguments?: unknown };
      if (typeof params.name !== "string") return fail(-32602, "tools/call needs a tool name");
      const args = (params.arguments ?? {}) as Args;
      if (typeof args !== "object" || args === null || Array.isArray(args)) {
        return fail(-32602, "tools/call arguments must be an object");
      }
      try {
        const data = callMcpTool(store, params.name, args);
        return respond({
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
          structuredContent: data,
          isError: false,
        });
      } catch (e) {
        // Tool errors are results with isError, per the MCP spec, not
        // protocol errors: the caller agent can read and act on them.
        return respond({
          content: [{ type: "text", text: `error: ${e instanceof Error ? e.message : String(e)}` }],
          isError: true,
        });
      }
    }
    default:
      return fail(-32601, `method not found: ${msg.method}`);
  }
}

// Run the MCP server on stdio: newline delimited JSON in, newline
// delimited JSON out. Diagnostics go to stderr only; stdout is the
// protocol channel and carries nothing else.
export function runMcpServer(workspace: string): void {
  const store = new Store(workspace);
  const rl = createInterface({ input: process.stdin, terminal: false });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: JsonRpcRequest;
    try {
      msg = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }) + "\n");
      return;
    }
    try {
      const response = handleMcpMessage(store, msg);
      if (response) process.stdout.write(JSON.stringify(response) + "\n");
    } catch (e) {
      const id = (msg as JsonRpcRequest).id ?? null;
      process.stdout.write(
        JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32603, message: e instanceof Error ? e.message : String(e) } }) + "\n",
      );
    }
  });
  console.error(`anh mcp server ready (workspace ${workspace}, store ${store.root})`);
}
