import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { computeProofPackHash } from "../src/hash.ts";
import { pendingPacks, startServer } from "../src/server.ts";
import { Store } from "../src/store.ts";
import type { Intent, Passport, ProofPack } from "../src/types.ts";

test("web inbox: HTML lists the pending pack, POST /review records decision and reputation", { timeout: 60000 }, async () => {
  const workspace = mkdtempSync(join(tmpdir(), "anh-server-"));
  const store = new Store(workspace);
  const passport: Passport = {
    kind: "passport", id: "pass_web", agentId: "agent-web", humanOwner: "owner",
    scopes: [{ repo: "local/repo", paths: ["**"], rights: "propose" }],
    limits: {}, status: "active", createdAt: new Date().toISOString(),
  };
  const intent: Intent = {
    kind: "intent", id: "intent_web", goal: "web inbox goal",
    acceptanceCriteria: [{ id: "c1", description: "it works" }],
    contextRefs: [], forbiddenAreas: [], claim: { state: "claimed", passportId: passport.id },
    createdAt: new Date().toISOString(), createdBy: "test",
  };
  const pack: ProofPack = {
    kind: "proofpack", version: 1, id: "pack_web", intentId: intent.id, workroomId: "wr_web",
    passportId: passport.id, repoPath: "/tmp/repo", baseRef: "HEAD", headRef: "anh/x", headSha: "head789",
    diffSummary: "1 file changed", changedFiles: ["a.txt"],
    checks: [
      { name: "diff", verdict: "PASS", detail: "ok", source: "git diff" },
      { name: "cidiff", verdict: "UNKNOWN", detail: "no slug", source: "cidiff" },
    ],
    riskFlags: ["large_diff:900_lines"],
    provenance: { bundledAt: new Date().toISOString(), bundledByPassportId: passport.id, baseSha: "base0", headSha: "head789", tools: {} },
    contentHash: "",
  };
  pack.contentHash = computeProofPackHash(pack);
  store.save("passports", passport);
  store.save("intents", intent);
  store.save("proofpacks", pack);

  const server = startServer(workspace, 0);
  await new Promise<void>((resolveListen) => server.once("listening", resolveListen));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  try {
    const health = await fetch(`${base}/healthz`);
    assert.equal(health.status, 200);
    assert.equal(((await health.json()) as { ok: boolean }).ok, true);

    const home = await fetch(`${base}/`);
    assert.equal(home.status, 200);
    const html = await home.text();
    assert.match(html, /web inbox goal/);
    assert.match(html, /pack_web/);
    assert.match(html, /UNKNOWN/);
    assert.match(html, /large_diff:900_lines/);
    assert.match(html, /action="\/review"/);

    const inboxJson = await fetch(`${base}/inbox`);
    const inboxBody = (await inboxJson.json()) as { pending: { id: string }[] };
    assert.deepEqual(inboxBody.pending.map((p) => p.id), ["pack_web"]);

    // A changes decision without feedback must be refused by the shared path.
    const bad = await fetch(`${base}/review`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ pack: "pack_web", reviewer: "web-reviewer", decision: "changes", feedback: "" }),
      redirect: "manual",
    });
    assert.equal(bad.status, 400);
    assert.equal(store.list("decisions").length, 0);

    const good = await fetch(`${base}/review`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ pack: "pack_web", reviewer: "web-reviewer", decision: "approve", feedback: "" }),
      redirect: "manual",
    });
    assert.equal(good.status, 303);
    const decisions = store.list<{ decision: string; reviewer: string }>("decisions");
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0].decision, "approve");
    assert.equal(decisions[0].reviewer, "web-reviewer");
    const reputation = store.list<{ outcome: string; passportId: string }>("reputation");
    assert.equal(reputation.length, 1);
    assert.equal(reputation[0].outcome, "accepted");
    assert.equal(reputation[0].passportId, "pass_web");

    const after = await fetch(`${base}/inbox`);
    const afterBody = (await after.json()) as { pending: unknown[] };
    assert.equal(afterBody.pending.length, 0);
    const homeAfter = await (await fetch(`${base}/`)).text();
    assert.match(homeAfter, /Inbox empty/);
    assert.match(homeAfter, /Reputation ledger/);
    assert.match(homeAfter, /accepted 1/);

    const rep = await fetch(`${base}/reputation`);
    assert.equal(rep.status, 200);
    const repBody = (await rep.json()) as {
      summaries: { passportId: string; total: number; accepted: number; acceptanceRate: number | null }[];
      events: { outcome: string; passportId: string }[];
    };
    assert.equal(repBody.summaries.length, 1);
    assert.equal(repBody.summaries[0].passportId, "pass_web");
    assert.equal(repBody.summaries[0].total, 1);
    assert.equal(repBody.summaries[0].accepted, 1);
    assert.equal(repBody.summaries[0].acceptanceRate, 1);
    assert.equal(repBody.events.length, 1);
    assert.equal(repBody.events[0].outcome, "accepted");
  } finally {
    server.close();
  }
});

test("web inbox auth: token required when configured, healthz stays public", { timeout: 60000 }, async () => {
  const workspace = mkdtempSync(join(tmpdir(), "anh-server-auth-"));
  const store = new Store(workspace);
  const passport: Passport = {
    kind: "passport", id: "pass_auth", agentId: "agent-auth", humanOwner: "owner",
    scopes: [{ repo: "local/repo", paths: ["**"], rights: "propose" }],
    limits: {}, status: "active", createdAt: new Date().toISOString(),
  };
  const intent: Intent = {
    kind: "intent", id: "intent_auth", goal: "auth inbox goal",
    acceptanceCriteria: [{ id: "c1", description: "it works" }],
    contextRefs: [], forbiddenAreas: [], claim: { state: "claimed", passportId: passport.id },
    createdAt: new Date().toISOString(), createdBy: "test",
  };
  const pack: ProofPack = {
    kind: "proofpack", version: 1, id: "pack_auth", intentId: intent.id, workroomId: "wr_auth",
    passportId: passport.id, repoPath: "/tmp/repo", baseRef: "HEAD", headRef: "anh/x", headSha: "head123",
    diffSummary: "1 file changed", changedFiles: ["a.txt"],
    checks: [{ name: "diff", verdict: "PASS", detail: "ok", source: "git diff" }],
    riskFlags: [],
    provenance: { bundledAt: new Date().toISOString(), bundledByPassportId: passport.id, baseSha: "base0", headSha: "head123", tools: {} },
    contentHash: "",
  };
  pack.contentHash = computeProofPackHash(pack);
  store.save("passports", passport);
  store.save("intents", intent);
  store.save("proofpacks", pack);
  assert.equal(pendingPacks(store).length, 1);

  const server = startServer(workspace, 0, { inboxToken: "test-inbox-secret" });
  await new Promise<void>((resolveListen) => server.once("listening", resolveListen));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  const bearer = { authorization: "Bearer test-inbox-secret" };
  try {
    const health = await fetch(`${base}/healthz`);
    assert.equal(health.status, 200);
    assert.equal(((await health.json()) as { authRequired: boolean }).authRequired, true);

    assert.equal((await fetch(`${base}/`)).status, 401);
    assert.equal((await fetch(`${base}/inbox`)).status, 401);
    assert.equal((await fetch(`${base}/reputation`)).status, 401);
    const repAuthed = await fetch(`${base}/reputation`, { headers: bearer });
    assert.equal(repAuthed.status, 200);
    const repEmpty = (await repAuthed.json()) as { summaries: unknown[]; events: unknown[] };
    assert.deepEqual(repEmpty.summaries, []);
    assert.deepEqual(repEmpty.events, []);
    assert.equal((await fetch(`${base}/inbox`, { headers: { authorization: "Bearer wrong" } })).status, 401);

    const blockedReview = await fetch(`${base}/review`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ pack: "pack_auth", reviewer: "r", decision: "approve", feedback: "" }),
      redirect: "manual",
    });
    assert.equal(blockedReview.status, 401);
    assert.equal(store.list("decisions").length, 0);

    const home = await fetch(`${base}/`, { headers: bearer });
    assert.equal(home.status, 200);
    assert.match(await home.text(), /auth inbox goal/);
    const inboxJson = await fetch(`${base}/inbox`, { headers: bearer });
    assert.equal(inboxJson.status, 200);

    const badLogin = await fetch(`${base}/login`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: "wrong" }),
      redirect: "manual",
    });
    assert.equal(badLogin.status, 401);

    const login = await fetch(`${base}/login`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: "test-inbox-secret" }),
      redirect: "manual",
    });
    assert.equal(login.status, 303);
    const cookie = login.headers.get("set-cookie") ?? "";
    assert.match(cookie, /anh_inbox_token=/);
    assert.match(cookie, /HttpOnly/);
    const viaCookie = await fetch(`${base}/`, { headers: { cookie: cookie.split(";")[0] } });
    assert.equal(viaCookie.status, 200);

    const good = await fetch(`${base}/review`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", ...bearer },
      body: new URLSearchParams({ pack: "pack_auth", reviewer: "web-reviewer", decision: "approve", feedback: "" }),
      redirect: "manual",
    });
    assert.equal(good.status, 303);
    assert.equal(store.list("decisions").length, 1);
  } finally {
    server.close();
  }
});
