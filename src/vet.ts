// Passport vetting: mcpvet and mcpaudit wired into passport issue and
// renewal (MVP build plan, Phase 3 follow-on).
//
// A passport may name the MCP surface its agent brings: a server
// directory (mcpvet, static pre-install scan) and a stdio launch command
// (mcpaudit, live audit). When a surface is configured, issuing or
// renewing the passport runs both tools and records a VettingRecord in
// the store. A decisive FAIL from either tool (mcpvet DO-NOT-INSTALL,
// mcpaudit FAIL) blocks the issue or renewal and nothing is saved.
// Every other non-clean outcome (mcpvet REVIEW, mcpaudit WARN or
// UNREACHABLE, a missing tool, unparseable output) records UNKNOWN with
// the reason named, never a pass: the same no fake verdict rule the
// proof pack gates follow.

import { existsSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { delimiter, join } from "node:path";
import { runCmd, type CmdResult } from "./git.ts";
import { newId, nowIso } from "./hash.ts";
import type { Store } from "./store.ts";
import { asVettingRecord } from "./validate.ts";
import type { CheckResult, Passport, Verdict, VettingRecord, VettingTrigger } from "./types.ts";

export type VetRunner = (cmd: string, args: string[], opts?: { cwd?: string; timeoutMs?: number }) => CmdResult;

export interface VetToolResolution {
  // How to invoke the tool: a command plus fixed leading args (the
  // fleet builds under ~/workspace/github-builds run through node).
  command: string | null;
  prefixArgs: string[];
  // Human readable path of the resolved tool, used as the check source.
  display: string;
  searched: string[];
}

// Vet tool discovery, same search shape as the proof pack gate tools:
// ANH_<TOOL>_BIN override, then the fleet build under
// ~/workspace/github-builds/<tool>/dist/cli.js (run through node), then
// $ANH_FLEET_BIN/<tool>, then PATH. The home parameter exists so tests
// can point discovery at an empty tree and prove the not-found path.
export function resolveVetTool(name: "mcpvet" | "mcpaudit", env: NodeJS.ProcessEnv = process.env, home: string = homedir()): VetToolResolution {
  const searched: string[] = [];
  const upper = name.toUpperCase();
  const candidates: { command: string; prefixArgs: string[]; display: string; exists: string }[] = [];
  const binOverride = env[`ANH_${upper}_BIN`];
  if (binOverride) candidates.push({ command: binOverride, prefixArgs: [], display: binOverride, exists: binOverride });
  const buildsCli = join(home, "workspace", "github-builds", name, "dist", "cli.js");
  candidates.push({ command: "node", prefixArgs: [buildsCli], display: buildsCli, exists: buildsCli });
  if (env["ANH_FLEET_BIN"]) {
    const p = join(env["ANH_FLEET_BIN"], name);
    candidates.push({ command: p, prefixArgs: [], display: p, exists: p });
  }
  for (const dir of (env["PATH"] ?? "").split(delimiter).filter(Boolean)) {
    const p = join(dir, name);
    candidates.push({ command: p, prefixArgs: [], display: p, exists: p });
  }
  for (const c of candidates) searched.push(c.display);
  for (const c of candidates) {
    if (existsSync(c.exists)) return { command: c.command, prefixArgs: c.prefixArgs, display: c.display, searched };
  }
  return { command: null, prefixArgs: [], display: name, searched };
}

export function vetToolNotFoundDetail(name: "mcpvet" | "mcpaudit", env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const { searched } = resolveVetTool(name, env, home);
  const upper = name.toUpperCase();
  return `${name} not found on this machine (${hostname()}); searched: ${searched.join(", ") || "no locations"}. Install the fleet security tools on this machine, put ${name} on PATH, or set ANH_${upper}_BIN to its path`;
}

function extractJson(stdout: string): Record<string, unknown> | null {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(stdout.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function unknown(name: string, source: string, reason: string): CheckResult {
  return { name, verdict: "UNKNOWN", detail: reason, source };
}

interface VetCounts { critical?: unknown; high?: unknown; medium?: unknown; low?: unknown; total?: unknown }

// Map a real mcpvet report onto the verdict scale. Decisive only:
// VETTED is PASS, DO-NOT-INSTALL is FAIL, REVIEW is UNKNOWN (a human
// has to look; it is not a pass and it does not block on its own).
export function mcpvetVerdictFromReport(parsed: Record<string, unknown>, source: string): CheckResult {
  const verdict = typeof parsed.verdict === "string" ? parsed.verdict : null;
  if (!verdict) return unknown("mcpvet", source, "mcpvet output had no verdict field; nothing decisive was reported");
  const counts = (parsed.counts ?? {}) as VetCounts;
  const num = (v: unknown) => (typeof v === "number" ? v : 0);
  const risk = (parsed.risk ?? {}) as { score?: unknown };
  const riskScore = typeof risk.score === "number" ? risk.score : null;
  const tally = `critical ${num(counts.critical)}, high ${num(counts.high)}, medium ${num(counts.medium)}, low ${num(counts.low)}${riskScore !== null ? `, risk score ${riskScore}` : ""}`;
  if (verdict === "VETTED") {
    return { name: "mcpvet", verdict: "PASS", detail: `mcpvet: VETTED (${tally})`, source };
  }
  if (verdict === "DO-NOT-INSTALL") {
    const findings = Array.isArray(parsed.findings) ? parsed.findings : [];
    const names = findings
      .filter((f) => isRecord(f) && f.severity === "critical")
      .map((f) => String((f as Record<string, unknown>).code ?? (f as Record<string, unknown>).title ?? "critical finding"))
      .slice(0, 5);
    return { name: "mcpvet", verdict: "FAIL", detail: `mcpvet: DO-NOT-INSTALL (${tally})${names.length ? `: ${names.join(", ")}` : ""}`, source };
  }
  if (verdict === "REVIEW") {
    return unknown("mcpvet", source, `mcpvet: REVIEW (${tally}); findings at or above medium severity need a human look before this surface is trusted, so vetting records no pass`);
  }
  return unknown("mcpvet", source, `mcpvet output had an unrecognized verdict: ${verdict}`);
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

export function mcpvetCheck(passport: Passport, runner: VetRunner = runCmd, env: NodeJS.ProcessEnv = process.env, home: string = homedir()): CheckResult | null {
  const dir = passport.mcp?.dir;
  if (!dir) return null;
  const res = resolveVetTool("mcpvet", env, home);
  if (!res.command) return unknown("mcpvet", "mcpvet", vetToolNotFoundDetail("mcpvet", env, home));
  if (!existsSync(dir)) {
    return unknown("mcpvet", res.display, `mcpvet target directory does not exist on this machine: ${dir}; nothing was scanned`);
  }
  const r = runner(res.command, [...res.prefixArgs, "vet", dir, "--json"], { timeoutMs: 120000 });
  const parsed = extractJson(r.stdout);
  if (!parsed) {
    return unknown("mcpvet", res.display, `mcpvet produced no parseable output (exit ${r.code}): ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
  }
  return mcpvetVerdictFromReport(parsed, res.display);
}

interface McpauditSummary { errors?: unknown; warnings?: unknown; toolCount?: unknown }

// Map a real mcpaudit report onto the verdict scale. Decisive only:
// PASS is PASS, FAIL is FAIL, WARN and UNREACHABLE are UNKNOWN with the
// cause named (a warning means the surface works but has issues a human
// should weigh; unreachable means the audit never ran).
export function mcpauditVerdictFromReport(parsed: Record<string, unknown>, source: string): CheckResult {
  const verdict = typeof parsed.verdict === "string" ? parsed.verdict : null;
  if (!verdict) return unknown("mcpaudit", source, "mcpaudit output had no verdict field; nothing decisive was reported");
  const score = typeof parsed.score === "number" ? parsed.score : null;
  const grade = typeof parsed.grade === "string" ? parsed.grade : null;
  const summary = (parsed.summary ?? {}) as McpauditSummary;
  const num = (v: unknown) => (typeof v === "number" ? v : 0);
  const scoreText = score !== null ? `score ${score}/100${grade ? `, grade ${grade}` : ""}, ` : "";
  const issues = Array.isArray(parsed.issues) ? parsed.issues : [];
  const issueNames = (sev: string) => issues
    .filter((i) => isRecord(i) && i.severity === sev)
    .map((i) => String((i as Record<string, unknown>).code ?? "issue"))
    .slice(0, 5);
  if (verdict === "PASS") {
    return { name: "mcpaudit", verdict: "PASS", detail: `mcpaudit: PASS (${scoreText}${num(summary.toolCount)} tool(s), ${num(summary.errors)} errors, ${num(summary.warnings)} warnings)`, source };
  }
  if (verdict === "FAIL") {
    const names = issueNames("error");
    return { name: "mcpaudit", verdict: "FAIL", detail: `mcpaudit: FAIL (${scoreText}${num(summary.errors)} error(s)${names.length ? `: ${names.join(", ")}` : ""})`, source };
  }
  if (verdict === "WARN") {
    const names = issueNames("warning");
    return unknown("mcpaudit", source, `mcpaudit: WARN (${scoreText}${num(summary.warnings)} warning(s)${names.length ? `: ${names.join(", ")}` : ""}); the surface works but has issues a human should weigh, so vetting records no pass`);
  }
  if (verdict === "UNREACHABLE") {
    const reason = typeof parsed.error === "string" ? parsed.error : "the server handshake never completed";
    return unknown("mcpaudit", source, `mcpaudit: UNREACHABLE (${reason}); the audit never ran, so there is no verdict`);
  }
  return unknown("mcpaudit", source, `mcpaudit output had an unrecognized verdict: ${verdict}`);
}

export function mcpauditCheck(passport: Passport, runner: VetRunner = runCmd, env: NodeJS.ProcessEnv = process.env, home: string = homedir()): CheckResult | null {
  const command = passport.mcp?.command;
  if (!command || !command.length) return null;
  const res = resolveVetTool("mcpaudit", env, home);
  if (!res.command) return unknown("mcpaudit", "mcpaudit", vetToolNotFoundDetail("mcpaudit", env, home));
  const r = runner(res.command, [...res.prefixArgs, "audit", ...command, "--json"], { timeoutMs: 180000 });
  const parsed = extractJson(r.stdout);
  if (!parsed) {
    return unknown("mcpaudit", res.display, `mcpaudit produced no parseable output (exit ${r.code}), likely a launch failure: ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
  }
  return mcpauditVerdictFromReport(parsed, res.display);
}

export function summarizeVetting(checks: CheckResult[]): Verdict {
  if (checks.some((c) => c.verdict === "FAIL")) return "FAIL";
  if (checks.some((c) => c.verdict === "UNKNOWN")) return "UNKNOWN";
  return "PASS";
}

// Run every configured vetting check for a passport, without recording
// anything. An empty list means the passport names no MCP surface.
export function vetPassport(
  passport: Passport,
  runner: VetRunner = runCmd,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): CheckResult[] {
  return [
    mcpvetCheck(passport, runner, env, home),
    mcpauditCheck(passport, runner, env, home),
  ].filter((c): c is CheckResult => c !== null);
}

// Record a completed vetting run in the store.
export function recordVetting(store: Store, passport: Passport, trigger: VettingTrigger, checks: CheckResult[]): VettingRecord {
  const record = asVettingRecord({
    kind: "vetting_record",
    id: newId("vet"),
    passportId: passport.id,
    trigger,
    checks,
    overall: summarizeVetting(checks),
    at: nowIso(),
  });
  store.save("vettings", record);
  return record;
}

// Run and record vetting in one step. Returns null when the passport
// names no MCP surface: nothing was run, and no record is invented.
export function runVetting(
  store: Store,
  passport: Passport,
  trigger: VettingTrigger,
  runner: VetRunner = runCmd,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): VettingRecord | null {
  const checks = vetPassport(passport, runner, env, home);
  if (!checks.length) return null;
  return recordVetting(store, passport, trigger, checks);
}

export function formatVettingLine(record: VettingRecord): string {
  const parts = record.checks.map((c) => `${c.name}=${c.verdict}`).join(" ");
  return `vetting ${record.id} [${record.trigger}] overall=${record.overall} ${parts} at ${record.at}`;
}

export function formatVettingDetail(record: VettingRecord): string {
  return record.checks.map((c) => `  ${c.name}: ${c.verdict} - ${c.detail}`).join("\n");
}
