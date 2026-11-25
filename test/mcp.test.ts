import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { handleMcpMessage, MCP_TOOLS } from "../src/mcp.ts";
import { Store } from "../src/store.ts";
import { computeProofPackHash } from "../src/hash.ts";
import type { Intent, Passport, ProofPack } from "../src/types.ts";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.ts");

function tmpStore(): { workspace: string; store: Store } {
  const workspace = mkdtempSync(join(tmpdir(), "anh-mcp-"));
  mkdirSync(workspace, { recursive: true });
  return { workspace, store: new Store(workspace) };
}

function seedPassport(store: Store, scopes: Passport["scopes"]): Passport {
  const passport: Passport = {
    kind: "passport",
    id: "pass_mcp_test",
    agentId: "mcp-agent",
    humanOwner: "test-owner",
    scopes,
    limits: {},
    status: "active",
    createdAt: "2026-11-24T00:00:00.000Z",
  };
  store.save("passports", passport);
  return passport;
}

function call(store: Store, name: string, args: Record<string, unknown> = {}): Record<string, unknown> {
  const res = handleMcpMessage(store, { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name, arguments: args } });
  assert.ok(res, "tools/call always responds");
  return res as unknown as Record<string, unknown>;
}

function toolData(store: Store, name: string, args: Record<string, unknown> = {}): Record<string, unknown> {
  const res = call(store, name, args);
  const result = res.result as { isError: boolean; structuredContent: Record<string, unknown> };
  assert.equal(result.isError, false, JSON.stringify(res));
  return result.structuredContent;
}

function toolError(store: Store, name: string, args: Record<string, unknown> = {}): string {
  const res = call(store, name, args);
  const result = res.result as { isError: boolean; content: { text: string }[] };
  assert.equal(result.isError, true, JSON.stringify(res));
  return result.content[0].text;
}

test("mcp: initialize negotiates the protocol and names the server", () => {
  const { store } = tmpStore();
  const res = handleMcpMessage(store, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } },
  }) as { result: { protocolVersion: string; serverInfo: { name: string }; capabilities: { tools: unknown } } };
  assert.equal(res.result.protocolVersion, "2024-11-05");
  assert.equal(res.result.serverInfo.name, "anh");
  assert.ok("tools" in res.result.capabilities);
});

test("mcp: notifications get no response, ping does, unknown methods error", () => {
  const { store } = tmpStore();
  assert.equal(handleMcpMessage(store, { method: "notifications/initialized" }), null);
  const ping = handleMcpMessage(store, { jsonrpc: "2.0", id: 2, method: "ping" }) as { result: unknown };
  assert.deepEqual(ping.result, {});
  const bad = handleMcpMessage(store, { jsonrpc: "2.0", id: 3, method: "nope/nope" }) as { error: { code: number } };
  assert.equal(bad.error.code, -32601);
});

test("mcp: tools/list exposes the anh tools and no token tool", () => {
  const { store } = tmpStore();
  const res = handleMcpMessage(store, { jsonrpc: "2.0", id: 4, method: "tools/list" }) as {
    result: { tools: { name: string }[] };
  };
  const names = res.result.tools.map((t) => t.name);
  assert.deepEqual(names, MCP_TOOLS.map((t) => t.name));
  for (const expected of ["anh_passport_list", "anh_intent_create", "anh_intent_claim", "anh_inbox_list", "anh_proofpack_verify", "anh_reputation_list", "anh_review_decide"]) {
    assert.ok(names.includes(expected), `missing tool ${expected}`);
  }
  assert.ok(!names.some((n) => n.includes("token")), "no MCP tool may carry raw tokens");
});

test("mcp: intent create, claim enforcement, and list round trip", () => {
  const { store } = tmpStore();
  seedPassport(store, [{ repo: "local/other", paths: ["**"], rights: "propose" }]);
  const created = toolData(store, "anh_intent_create", {
    goal: "ship the mcp surface",
    criteria: ["tools/list returns the anh tools"],
    repo: "local/agent-native-github",
    createdBy: "test",
  });
  const intent = created.intent as Intent;
  assert.equal(intent.repo, "local/agent-native-github");
  assert.equal(intent.claim.state, "unclaimed");

  // A passport scoped to a different repo is denied, with the repo named.
  const denied = toolError(store, "anh_intent_claim", { intentId: intent.id, passportId: "pass_mcp_test" });
  assert.match(denied, /local\/agent-native-github/);

  seedPassport(store, [{ repo: "local/agent-native-github", paths: ["**"], rights: "propose" }]);
  // Same passport id, now covering the repo: reseeding replaces the file.
  const claimed = toolData(store, "anh_intent_claim", { intentId: intent.id, passportId: "pass_mcp_test" });
  assert.equal((claimed.intent as Intent).claim.state, "claimed");

  const again = toolError(store, "anh_intent_claim", { intentId: intent.id, passportId: "pass_mcp_test" });
  assert.match(again, /already claimed/);

  const listed = toolData(store, "anh_intent_list");
  assert.equal((listed.intents as Intent[]).length, 1);
  const passports = toolData(store, "anh_passport_list");
  assert.equal((passports.passports as Passport[]).length, 1);
});

test("mcp: inbox, proofpack verify, reputation, and review decide share the store path", () => {
  const { store } = tmpStore();
  const passport = seedPassport(store, [{ repo: "local/repo", paths: ["**"], rights: "propose" }]);
  const intent: Intent = {
    kind: "intent",
    id: "intent_mcp_test",
    goal: "mcp review flow",
    acceptanceCriteria: [{ id: "c1", description: "works" }],
    contextRefs: [],
    forbiddenAreas: [],
    claim: { state: "claimed", passportId: passport.id, claimedAt: "2026-11-24T00:00:00.000Z" },
    createdAt: "2026-11-24T00:00:00.000Z",
    createdBy: "test",
  };
  store.save("intents", intent);
  const pack: ProofPack = {
    kind: "proofpack",
    version: 1,
    id: "pack_mcp_test",
    intentId: intent.id,
    workroomId: "wr_mcp_test",
    passportId: passport.id,
    repoPath: "/tmp/repo",
    baseRef: "HEAD",
    headRef: "anh/test",
    headSha: "abc123",
    diffSummary: "1 file",
    changedFiles: ["hello.txt"],
    checks: [{ name: "diff", verdict: "PASS", detail: "ok", source: "test" }],
    riskFlags: [],
    provenance: {
      bundledAt: "2026-11-24T00:00:00.000Z",
      bundledByPassportId: passport.id,
      baseSha: "base123",
      headSha: "abc123",
      tools: {},
    },
    contentHash: "",
  };
  pack.contentHash = computeProofPackHash(pack);
  store.save("proofpacks", pack);

  const inbox = toolData(store, "anh_inbox_list");
  assert.deepEqual((inbox.pending as ProofPack[]).map((p) => p.id), [pack.id]);

  const verified = toolData(store, "anh_proofpack_verify", { packId: pack.id }) as unknown as { ok: boolean };
  assert.equal(verified.ok, true);
  assert.match(toolError(store, "anh_proofpack_verify", { packId: "pack_missing" }), /not found/);

  // changes without feedback is a tool error and records nothing.
  assert.match(
    toolError(store, "anh_review_decide", { packId: pack.id, decision: "changes", reviewer: "test-reviewer" }),
    /feedback/,
  );
  assert.equal(store.list("decisions").length, 0);

  const decided = toolData(store, "anh_review_decide", { packId: pack.id, decision: "approve", reviewer: "test-reviewer" });
  assert.equal((decided.decision as { decision: string }).decision, "approve");
  assert.equal((decided.reputationEvent as { outcome: string }).outcome, "accepted");

  const rep = toolData(store, "anh_reputation_list", { passportId: passport.id }) as unknown as {
    summaries: { total: number; accepted: number; acceptanceRate: number | null }[];
  };
  assert.equal(rep.summaries.length, 1);
  assert.equal(rep.summaries[0].total, 1);
  assert.equal(rep.summaries[0].acceptanceRate, 1);

  const inboxAfter = toolData(store, "anh_inbox_list");
  assert.equal((inboxAfter.pending as ProofPack[]).length, 0);
});

test("mcp: stdio transport answers initialize and tools/list as JSON lines", { timeout: 30000 }, async () => {
  const { workspace } = tmpStore();
  const child = spawn("node", [CLI, "mcp", "--workspace", workspace], { stdio: ["pipe", "pipe", "pipe"] });
  try {
    const lines: Record<string, unknown>[] = [];
    let buffer = "";
    const done = new Promise<void>((resolvePromise, rejectPromise) => {
      child.stdout.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        while (buffer.includes("\n")) {
          const idx = buffer.indexOf("\n");
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (line) lines.push(JSON.parse(line) as Record<string, unknown>);
        }
        if (lines.length >= 2) resolvePromise();
      });
      child.on("error", rejectPromise);
      setTimeout(() => rejectPromise(new Error(`timed out waiting for mcp output, got ${lines.length} lines`)), 25000);
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } }) + "\n");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
    await done;
    const init = lines.find((l) => l.id === 1) as { result: { serverInfo: { name: string } } };
    assert.equal(init.result.serverInfo.name, "anh");
    const list = lines.find((l) => l.id === 2) as { result: { tools: { name: string }[] } };
    assert.ok(list.result.tools.some((t) => t.name === "anh_inbox_list"));
  } finally {
    child.kill();
  }
});
