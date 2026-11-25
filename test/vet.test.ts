import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "../src/store.ts";
import type { Passport, VettingRecord } from "../src/types.ts";
import { validatePassport, validateVettingRecord } from "../src/validate.ts";
import {
  mcpauditVerdictFromReport, mcpvetCheck, mcpvetVerdictFromReport, resolveVetTool, summarizeVetting, vetToolNotFoundDetail,
} from "../src/vet.ts";
import type { CmdResult } from "../src/git.ts";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.ts");

function anhRaw(workspace: string, args: string[], env: Record<string, string> = {}) {
  return spawnSync("node", [CLI, ...args, "--workspace", workspace], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

function anhOk(workspace: string, args: string[], env: Record<string, string> = {}): Record<string, unknown> {
  const r = anhRaw(workspace, [...args, "--json"], env);
  assert.equal(r.status, 0, `anh ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  return JSON.parse(r.stdout) as Record<string, unknown>;
}

// Fake vet tools: real executables whose JSON output is scripted by an
// environment variable, so the CLI tests exercise the true subprocess
// path (discovery by ANH_<TOOL>_BIN, argument passing, JSON parsing)
// without depending on the fleet installs being present.
function writeFakeTools(dir: string): { mcpvet: string; mcpaudit: string } {
  const mcpvet = join(dir, "fake-mcpvet");
  writeFileSync(mcpvet, `#!/usr/bin/env node
const verdict = process.env.FAKE_MCPVET_VERDICT || "VETTED";
const counts = verdict === "DO-NOT-INSTALL"
  ? { critical: 1, high: 0, medium: 0, low: 0, total: 1 }
  : verdict === "REVIEW"
    ? { critical: 0, high: 1, medium: 0, low: 0, total: 1 }
    : { critical: 0, high: 0, medium: 0, low: 0, total: 0 };
const findings = verdict === "DO-NOT-INSTALL" ? [{ severity: "critical", code: "REVERSE-SHELL" }] : [];
console.log(JSON.stringify({ tool: "mcpvet", version: "fake", verdict, counts, findings, risk: { score: 0 } }));
process.exit(verdict === "VETTED" ? 0 : 1);
`);
  chmodSync(mcpvet, 0o755);
  const mcpaudit = join(dir, "fake-mcpaudit");
  writeFileSync(mcpaudit, `#!/usr/bin/env node
const verdict = process.env.FAKE_MCPAUDIT_VERDICT || "PASS";
const base = { verdict, score: verdict === "PASS" ? 100 : 50, grade: verdict === "PASS" ? "A" : "F" };
if (verdict === "PASS") console.log(JSON.stringify({ ...base, summary: { toolCount: 3, errors: 0, warnings: 0 }, issues: [] }));
else if (verdict === "WARN") console.log(JSON.stringify({ ...base, summary: { toolCount: 3, errors: 0, warnings: 1 }, issues: [{ severity: "warning", code: "DESC_SHORT" }] }));
else if (verdict === "FAIL") console.log(JSON.stringify({ ...base, summary: { toolCount: 3, errors: 1, warnings: 0 }, issues: [{ severity: "error", code: "BAD_ERROR_HANDLING" }] }));
else console.log(JSON.stringify({ ...base, verdict: "UNREACHABLE", error: "handshake timed out" }));
process.exit(verdict === "PASS" || verdict === "WARN" ? 0 : 1);
`);
  chmodSync(mcpaudit, 0o755);
  return { mcpvet, mcpaudit };
}

function fakeSetup() {
  const root = mkdtempSync(join(tmpdir(), "anh-vet-"));
  const tools = writeFakeTools(root);
  const serverDir = mkdtempSync(join(tmpdir(), "anh-vet-server-"));
  const env = { ANH_MCPVET_BIN: tools.mcpvet, ANH_MCPAUDIT_BIN: tools.mcpaudit };
  return { root, tools, serverDir, env };
}

test("mcpvet verdict mapping: only VETTED passes and only DO-NOT-INSTALL fails", () => {
  const vetted = mcpvetVerdictFromReport({ verdict: "VETTED", counts: { critical: 0, high: 0, medium: 0, low: 0 }, risk: { score: 0 } }, "fake");
  assert.equal(vetted.verdict, "PASS");
  const review = mcpvetVerdictFromReport({ verdict: "REVIEW", counts: { critical: 0, high: 1, medium: 0, low: 0 }, risk: { score: 40 } }, "fake");
  assert.equal(review.verdict, "UNKNOWN");
  assert.match(review.detail, /REVIEW/);
  const dni = mcpvetVerdictFromReport(
    { verdict: "DO-NOT-INSTALL", counts: { critical: 2, high: 0, medium: 0, low: 0 }, findings: [{ severity: "critical", code: "REVERSE-SHELL" }], risk: { score: 90 } },
    "fake",
  );
  assert.equal(dni.verdict, "FAIL");
  assert.match(dni.detail, /REVERSE-SHELL/);
  assert.equal(mcpvetVerdictFromReport({}, "fake").verdict, "UNKNOWN");
  assert.equal(mcpvetVerdictFromReport({ verdict: "SOMETHING-ELSE" }, "fake").verdict, "UNKNOWN");
});

test("mcpaudit verdict mapping: PASS passes, FAIL fails, WARN and UNREACHABLE are UNKNOWN", () => {
  const pass = mcpauditVerdictFromReport({ verdict: "PASS", score: 100, grade: "A", summary: { toolCount: 9, errors: 0, warnings: 0 }, issues: [] }, "fake");
  assert.equal(pass.verdict, "PASS");
  assert.match(pass.detail, /score 100\/100/);
  const fail = mcpauditVerdictFromReport(
    { verdict: "FAIL", score: 40, summary: { errors: 1, warnings: 0 }, issues: [{ severity: "error", code: "BAD_ERROR_HANDLING" }] },
    "fake",
  );
  assert.equal(fail.verdict, "FAIL");
  assert.match(fail.detail, /BAD_ERROR_HANDLING/);
  const warn = mcpauditVerdictFromReport({ verdict: "WARN", score: 90, summary: { errors: 0, warnings: 1 }, issues: [{ severity: "warning", code: "DESC_SHORT" }] }, "fake");
  assert.equal(warn.verdict, "UNKNOWN");
  assert.match(warn.detail, /WARN/);
  const unreach = mcpauditVerdictFromReport({ verdict: "UNREACHABLE", error: "handshake timed out" }, "fake");
  assert.equal(unreach.verdict, "UNKNOWN");
  assert.match(unreach.detail, /handshake timed out/);
  assert.equal(mcpauditVerdictFromReport({}, "fake").verdict, "UNKNOWN");
});

test("summarizeVetting: any FAIL fails, else any UNKNOWN is UNKNOWN, else PASS", () => {
  const c = (verdict: "PASS" | "FAIL" | "UNKNOWN") => ({ name: "x", verdict, detail: "d", source: "s" });
  assert.equal(summarizeVetting([c("PASS"), c("PASS")]), "PASS");
  assert.equal(summarizeVetting([c("PASS"), c("UNKNOWN")]), "UNKNOWN");
  assert.equal(summarizeVetting([c("UNKNOWN"), c("FAIL")]), "FAIL");
});

test("vet tool discovery: an empty machine reports not found with the searched list and the override", () => {
  const emptyHome = mkdtempSync(join(tmpdir(), "anh-vet-home-"));
  const env = { PATH: "" } as NodeJS.ProcessEnv;
  const res = resolveVetTool("mcpvet", env, emptyHome);
  assert.equal(res.command, null);
  assert.ok(res.searched.some((s) => s.includes("github-builds")));
  assert.match(vetToolNotFoundDetail("mcpvet", env, emptyHome), /ANH_MCPVET_BIN/);
});

test("mcpvetCheck: missing target dir and missing tool are UNKNOWN with the cause named, never a pass", () => {
  const passport: Passport = {
    kind: "passport", id: "pass_vet_unit", agentId: "a", humanOwner: "o",
    mcp: { dir: "/nonexistent/anh-vet-target" },
    scopes: [{ repo: "o/r", paths: ["**"], rights: "propose" }],
    limits: {}, status: "active", createdAt: new Date().toISOString(),
  };
  const runner = (): CmdResult => ({ code: 0, stdout: "{}", stderr: "" });
  const missingDir = mcpvetCheck(passport, runner, { ...process.env, ANH_MCPVET_BIN: process.execPath });
  assert.equal(missingDir?.verdict, "UNKNOWN");
  assert.match(missingDir?.detail ?? "", /does not exist/);
  const emptyHome = mkdtempSync(join(tmpdir(), "anh-vet-home-"));
  const missingTool = mcpvetCheck(passport, runner, { PATH: "" } as NodeJS.ProcessEnv, emptyHome);
  assert.equal(missingTool?.verdict, "UNKNOWN");
  assert.match(missingTool?.detail ?? "", /not found on this machine/);
  const garbage = mcpvetCheck(
    { ...passport, mcp: { dir: emptyHome } },
    (): CmdResult => ({ code: 1, stdout: "not json at all", stderr: "boom" }),
    { ...process.env, ANH_MCPVET_BIN: process.execPath },
  );
  assert.equal(garbage?.verdict, "UNKNOWN");
  assert.match(garbage?.detail ?? "", /no parseable output/);
});

test("validators: passport MCP surface and vetting records", () => {
  const base: Passport = {
    kind: "passport", id: "pass_v", agentId: "a", humanOwner: "o",
    scopes: [{ repo: "o/r", paths: ["**"], rights: "propose" }],
    limits: {}, status: "active", createdAt: new Date().toISOString(),
  };
  assert.deepEqual(validatePassport({ ...base, mcp: { dir: "/tmp/x", command: ["node", "s.js"] } }), []);
  assert.ok(validatePassport({ ...base, mcp: {} }).length > 0);
  assert.ok(validatePassport({ ...base, mcp: { command: [] } }).length > 0);
  const record: VettingRecord = {
    kind: "vetting_record", id: "vet_1", passportId: "pass_v", trigger: "issue",
    checks: [{ name: "mcpvet", verdict: "PASS", detail: "d", source: "s" }],
    overall: "PASS", at: new Date().toISOString(),
  };
  assert.deepEqual(validateVettingRecord(record), []);
  assert.ok(validateVettingRecord({ ...record, overall: "FINE" }).length > 0);
  assert.ok(validateVettingRecord({ ...record, checks: [] }).length > 0);
});

test("CLI: passport create with a clean MCP surface issues and records vetting", { timeout: 120000 }, () => {
  const { root, serverDir, env } = fakeSetup();
  const workspace = mkdtempSync(join(tmpdir(), "anh-vet-ws-"));
  void root;
  const created = anhOk(workspace, [
    "passport", "create", "--agent", "agent-vetted", "--owner", "owner",
    "--scope", "o/r|**|propose", "--mcp-dir", serverDir, "--mcp-cmd", "node server.js mcp",
  ], env);
  const passport = created.passport as Record<string, unknown>;
  const vetting = created.vetting as Record<string, unknown>;
  assert.ok(passport.id);
  assert.equal(vetting.overall, "PASS");
  assert.equal(vetting.trigger, "issue");
  assert.equal((vetting.checks as unknown[]).length, 2);
  const store = new Store(workspace);
  assert.equal(store.list("passports").length, 1);
  assert.equal(store.list<VettingRecord>("vettings").length, 1);
  const listed = anhOk(workspace, ["passport", "vettings", "--id", String(passport.id)], env);
  assert.equal((listed as unknown as VettingRecord[]).length, 1);
});

test("CLI: a DO-NOT-INSTALL vetting blocks passport issue and nothing is saved", { timeout: 120000 }, () => {
  const { serverDir, env } = fakeSetup();
  const workspace = mkdtempSync(join(tmpdir(), "anh-vet-ws-"));
  const r = anhRaw(workspace, [
    "passport", "create", "--agent", "agent-bad", "--owner", "owner",
    "--scope", "o/r|**|propose", "--mcp-dir", serverDir,
  ], { ...env, FAKE_MCPVET_VERDICT: "DO-NOT-INSTALL" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /passport issue blocked by vetting/);
  assert.match(r.stderr, /DO-NOT-INSTALL/);
  const store = new Store(workspace);
  assert.equal(store.list("passports").length, 0);
  assert.equal(store.list("vettings").length, 0);
});

test("CLI: a REVIEW vetting issues the passport with an UNKNOWN record, not a pass", { timeout: 120000 }, () => {
  const { serverDir, env } = fakeSetup();
  const workspace = mkdtempSync(join(tmpdir(), "anh-vet-ws-"));
  const created = anhOk(workspace, [
    "passport", "create", "--agent", "agent-review", "--owner", "owner",
    "--scope", "o/r|**|propose", "--mcp-dir", serverDir,
  ], { ...env, FAKE_MCPVET_VERDICT: "REVIEW" });
  const vetting = created.vetting as Record<string, unknown>;
  assert.equal(vetting.overall, "UNKNOWN");
  const store = new Store(workspace);
  assert.equal(store.list("passports").length, 1);
});

test("CLI: passport create without a surface is unchanged and records no vetting", { timeout: 120000 }, () => {
  const { env } = fakeSetup();
  const workspace = mkdtempSync(join(tmpdir(), "anh-vet-ws-"));
  const created = anhOk(workspace, [
    "passport", "create", "--agent", "agent-plain", "--owner", "owner", "--scope", "o/r|**|propose",
  ], env);
  assert.equal(created.kind, "passport");
  assert.equal(created.vetting, undefined);
  const store = new Store(workspace);
  assert.equal(store.list("vettings").length, 0);
});

test("CLI: renew extends an expired passport and reactivates it; revoked refuses", { timeout: 120000 }, () => {
  const { env } = fakeSetup();
  const workspace = mkdtempSync(join(tmpdir(), "anh-vet-ws-"));
  const created = anhOk(workspace, [
    "passport", "create", "--agent", "agent-old", "--owner", "owner",
    "--scope", "o/r|**|propose", "--expires", "2020-01-01T00:00:00.000Z",
  ], env);
  const renewed = anhOk(workspace, ["passport", "renew", "--id", String(created.id), "--extend-days", "10"], env);
  const limits = renewed.limits as { expiresAt: string };
  assert.ok(Date.parse(limits.expiresAt) > Date.now(), "renewed expiry is in the future");
  assert.equal(renewed.status, "active");
  // Revoke on disk, then renewal must refuse.
  const store = new Store(workspace);
  const stored = store.load<Passport>("passports", String(created.id));
  assert.ok(stored);
  if (stored) {
    stored.status = "revoked";
    store.save("passports", stored);
  }
  const r = anhRaw(workspace, ["passport", "renew", "--id", String(created.id)], env);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /revoked/);
});

test("CLI: renewal re-runs vetting and a FAIL blocks it, leaving the old expiry in force", { timeout: 120000 }, () => {
  const { serverDir, env } = fakeSetup();
  const workspace = mkdtempSync(join(tmpdir(), "anh-vet-ws-"));
  const created = anhOk(workspace, [
    "passport", "create", "--agent", "agent-renew-vet", "--owner", "owner",
    "--scope", "o/r|**|propose", "--expires", "2020-01-01T00:00:00.000Z",
    "--mcp-dir", serverDir, "--mcp-cmd", "node server.js mcp",
  ], env);
  const passport = created.passport as Record<string, unknown>;
  const blocked = anhRaw(workspace, ["passport", "renew", "--id", String(passport.id), "--extend-days", "10"],
    { ...env, FAKE_MCPAUDIT_VERDICT: "FAIL" });
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /renewal blocked by vetting/);
  const store = new Store(workspace);
  const stored = store.load<Passport>("passports", String(passport.id));
  assert.equal(stored?.limits.expiresAt, "2020-01-01T00:00:00.000Z");
  // A clean audit renews and records a renew-triggered vetting.
  const renewed = anhOk(workspace, ["passport", "renew", "--id", String(passport.id), "--extend-days", "10"], env);
  const vetting = renewed.vetting as Record<string, unknown>;
  assert.equal(vetting.trigger, "renew");
  assert.equal(vetting.overall, "PASS");
});

test("CLI: passport vet errors clearly without a surface, and records a manual run with one", { timeout: 120000 }, () => {
  const { serverDir, env } = fakeSetup();
  const workspace = mkdtempSync(join(tmpdir(), "anh-vet-ws-"));
  const plain = anhOk(workspace, [
    "passport", "create", "--agent", "agent-nosurface", "--owner", "owner", "--scope", "o/r|**|propose",
  ], env);
  const noSurface = anhRaw(workspace, ["passport", "vet", "--id", String(plain.id)], env);
  assert.notEqual(noSurface.status, 0);
  assert.match(noSurface.stderr, /no MCP surface/);
  const created = anhOk(workspace, [
    "passport", "create", "--agent", "agent-manual", "--owner", "owner",
    "--scope", "o/r|**|propose", "--mcp-cmd", "node server.js mcp",
  ], env);
  const passport = created.passport as Record<string, unknown>;
  const vet = anhOk(workspace, ["passport", "vet", "--id", String(passport.id)], env);
  assert.equal(vet.trigger, "manual");
  assert.equal(vet.overall, "PASS");
  const failing = anhRaw(workspace, ["passport", "vet", "--id", String(passport.id)],
    { ...env, FAKE_MCPAUDIT_VERDICT: "FAIL" });
  assert.notEqual(failing.status, 0);
  assert.match(failing.stderr, /vetting FAIL/);
});
