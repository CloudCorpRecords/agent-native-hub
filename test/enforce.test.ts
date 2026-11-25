import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertFilesInScope, assertRepoScope, assertWorkroomTimeWithinLimits, pathMatches, recordSpend,
} from "../src/enforce.ts";
import { Store } from "../src/store.ts";
import { enforceTokenIfRequired, issueToken, revokeToken, tokenInvalidReason } from "../src/tokens.ts";
import type { Passport, Workroom } from "../src/types.ts";

function passport(over: Partial<Passport> = {}): Passport {
  return {
    kind: "passport",
    id: "pass_test",
    agentId: "agent-test",
    humanOwner: "owner-test",
    scopes: [{ repo: "local/repo", paths: ["src/**"], rights: "propose" }],
    limits: {},
    status: "active",
    createdAt: new Date().toISOString(),
    ...over,
  };
}

function workroom(over: Partial<Workroom> = {}): Workroom {
  return {
    kind: "workroom",
    id: "wr_test",
    repoPath: "/tmp/repo",
    branch: "anh/x",
    worktreePath: "/tmp/repo-wt",
    baseRef: "HEAD",
    baseSha: "abc",
    intentId: "intent_test",
    passportId: "pass_test",
    status: "open",
    runLog: [],
    createdAt: new Date().toISOString(),
    ...over,
  };
}

test("path matching: glob, prefix, and plain dir patterns", () => {
  assert.equal(pathMatches("**", "any/thing.txt"), true);
  assert.equal(pathMatches("src/**", "src/a/b.ts"), true);
  assert.equal(pathMatches("src/**", "docs/a.md"), false);
  assert.equal(pathMatches("src/*", "src/a.ts"), true);
  assert.equal(pathMatches("src/*", "src/a/b.ts"), false);
  assert.equal(pathMatches("src", "src/a.ts"), true);
  assert.equal(pathMatches("src", "srcx/a.ts"), false);
});

test("repo scope: matching repo and rights pass, wrong repo or weak rights denied", () => {
  const p = passport();
  assert.doesNotThrow(() => assertRepoScope(p, "local/repo", "propose"));
  assert.throws(() => assertRepoScope(p, "local/repo", "merge"), /no scope granting merge/);
  assert.throws(() => assertRepoScope(p, "other/repo", "propose"), /no scope granting propose on repo other\/repo/);
});

test("file scope: files inside scope pass, files outside are denied by name", () => {
  const p = passport();
  assert.doesNotThrow(() => assertFilesInScope(p, "local/repo", ["src/a.ts", "src/deep/b.ts"], "propose"));
  assert.throws(
    () => assertFilesInScope(p, "local/repo", ["src/a.ts", "secrets/key.pem"], "propose"),
    /does not cover changed file\(s\).*secrets\/key\.pem/,
  );
});

test("time limit: workroom older than maxMinutes is denied", () => {
  const p = passport({ limits: { maxMinutes: 30 } });
  const old = workroom({ createdAt: new Date(Date.now() - 90 * 60000).toISOString() });
  assert.throws(() => assertWorkroomTimeWithinLimits(p, old), /time limit exceeded/);
  const fresh = workroom();
  assert.doesNotThrow(() => assertWorkroomTimeWithinLimits(p, fresh));
  const noLimit = passport();
  assert.doesNotThrow(() => assertWorkroomTimeWithinLimits(noLimit, old));
});

test("spend limit: recording up to the limit passes, past it is denied and not recorded", () => {
  const p = passport({ limits: { maxSpendUsd: 10 } });
  assert.equal(recordSpend(p, 4), 4);
  assert.equal(recordSpend(p, 6), 10);
  assert.throws(() => recordSpend(p, 0.01), /spend limit exceeded/);
  assert.equal(p.usage?.spendUsd, 10);
});

test("tokens: issue, verify, wrong passport, revoke, expiry", () => {
  const store = new Store(mkdtempSync(join(tmpdir(), "anh-tokens-")));
  const p = passport();
  store.save("passports", p);
  const { record, rawToken } = issueToken(store, p, { label: "test" });
  assert.ok(rawToken.startsWith("anh_"));
  // Only the hash is at rest: the stored record must not contain the raw token.
  const stored = JSON.stringify(store.load("tokens", record.id));
  assert.ok(!stored.includes(rawToken), "raw token must never be stored");
  assert.equal(tokenInvalidReason(store, p.id, rawToken), null);
  assert.match(tokenInvalidReason(store, "pass_other", rawToken) ?? "", /does not match/);
  assert.match(tokenInvalidReason(store, p.id, "anh_deadbeef") ?? "", /does not match/);
  assert.doesNotThrow(() => enforceTokenIfRequired(store, p.id, rawToken, true));
  assert.throws(() => enforceTokenIfRequired(store, p.id, undefined, true), /no token supplied/);
  revokeToken(store, record.id);
  assert.match(tokenInvalidReason(store, p.id, rawToken) ?? "", /revoked/);
  const expiring = issueToken(store, p, { expiresAt: new Date(Date.now() - 1000).toISOString() });
  assert.match(tokenInvalidReason(store, p.id, expiring.rawToken) ?? "", /expired/);
});
