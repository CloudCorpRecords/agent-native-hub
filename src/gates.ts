// Gate runners for proof pack bundling.
// Hard rule, from the fleet gate policy: a tool that is unavailable, errors,
// or produces no parseable verdict records UNKNOWN with the reason.
// UNREACHABLE is UNKNOWN, never a pass.

import { existsSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { delimiter, join } from "node:path";
import { git, runCmd } from "./git.ts";
import type { CheckResult, Workroom } from "./types.ts";

const FLEET_BIN = join(homedir(), "workspace", "fleet-tools", "node_modules", ".bin");
const SHIPCHECK_CLI = join(homedir(), "workspace", "github-builds", "shipcheck", "dist", "cli.js");

export interface GateOptions {
  resultsDir?: string;
  reproCmd?: string;
  repoSlug?: string;
}

// Portable gate tool discovery. The fleet install under ~/workspace is only
// one possible home: on a machine without it (the Razer, a fresh laptop) the
// same tools may live on PATH or behind an explicit override. Search order
// per tool: ANH_<TOOL>_BIN, then $ANH_FLEET_BIN/<tool>, then the default
// fleet install, then each PATH entry. shipcheck also accepts
// ANH_SHIPCHECK_CLI (a dist/cli.js run through node) before PATH.
// A miss records UNKNOWN with every searched location and the override to
// set, never a bare "not found" that only makes sense on the VM.
export interface GateToolResolution { path: string | null; searched: string[]; viaNode: boolean }

export function resolveGateTool(name: string, env: NodeJS.ProcessEnv = process.env): GateToolResolution {
  const searched: string[] = [];
  const upper = name.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  const candidates: { path: string; viaNode: boolean }[] = [];
  const binOverride = env[`ANH_${upper}_BIN`];
  if (binOverride) candidates.push({ path: binOverride, viaNode: false });
  if (name === "shipcheck") {
    const cliOverride = env["ANH_SHIPCHECK_CLI"];
    if (cliOverride) candidates.push({ path: cliOverride, viaNode: true });
  }
  if (env["ANH_FLEET_BIN"]) candidates.push({ path: join(env["ANH_FLEET_BIN"], name), viaNode: false });
  if (name === "shipcheck") candidates.push({ path: SHIPCHECK_CLI, viaNode: true });
  else candidates.push({ path: join(FLEET_BIN, name), viaNode: false });
  for (const dir of (env["PATH"] ?? "").split(delimiter).filter(Boolean)) {
    candidates.push({ path: join(dir, name), viaNode: false });
  }
  for (const c of candidates) searched.push(c.path);
  for (const c of candidates) {
    if (existsSync(c.path)) return { path: c.path, searched, viaNode: c.viaNode };
  }
  return { path: null, searched, viaNode: false };
}

export function gateNotFoundDetail(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const { searched } = resolveGateTool(name, env);
  const upper = name.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  return `${name} not found on this machine (${hostname()}); searched: ${searched.join(", ") || "no locations"}. Install the fleet gate tools on this machine, put ${name} on PATH, or set ANH_${upper}_BIN to its path`;
}

export function toolPaths(env: NodeJS.ProcessEnv = process.env): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const name of ["cidiff", "reprocheck", "testdelta", "shipcheck"]) {
    out[name] = resolveGateTool(name, env).path;
  }
  return out;
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

export function diffCheck(workroom: Workroom, headSha: string): { check: CheckResult; files: string[]; summary: string; changedLines: number } {
  const nameArgs = ["diff", "--name-only", workroom.baseSha, headSha];
  const statArgs = ["diff", "--stat", workroom.baseSha, headSha];
  const numArgs = ["diff", "--numstat", workroom.baseSha, headSha];
  const names = git(nameArgs, workroom.repoPath);
  const stat = git(statArgs, workroom.repoPath);
  const num = git(numArgs, workroom.repoPath);
  if (names.code !== 0 || stat.code !== 0 || num.code !== 0) {
    return {
      check: unknown("diff", "git diff", `git diff failed: ${(names.stderr || stat.stderr || num.stderr).trim()}`),
      files: [],
      summary: "diff could not be computed",
      changedLines: 0,
    };
  }
  const files = names.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  let changedLines = 0;
  for (const line of num.stdout.split("\n")) {
    const parts = line.split("\t");
    const add = Number.parseInt(parts[0] ?? "0", 10);
    const del = Number.parseInt(parts[1] ?? "0", 10);
    if (!Number.isNaN(add)) changedLines += add;
    if (!Number.isNaN(del)) changedLines += del;
  }
  const log = git(["log", "--format=%s", `${workroom.baseSha}..${headSha}`], workroom.repoPath);
  const subjects = log.code === 0 ? log.stdout.split("\n").map((s) => s.trim()).filter(Boolean) : [];
  const summary = files.length
    ? `${files.length} file(s) changed, ${changedLines} line(s) touched. Commits: ${subjects.join("; ") || "none recorded"}. Files: ${files.join(", ")}`
    : "no changes between base and head";
  return {
    check: {
      name: "diff",
      verdict: files.length ? "PASS" : "FAIL",
      detail: files.length ? summary : "empty diff: the workroom produced no change against the base",
      source: "git diff",
    },
    files,
    summary,
    changedLines,
  };
}

export function testdeltaCheck(opts: GateOptions): CheckResult {
  const bin = resolveGateTool("testdelta").path;
  if (!bin) return unknown("testdelta", "testdelta", gateNotFoundDetail("testdelta"));
  if (!opts.resultsDir) {
    return unknown("testdelta", bin, "no test result files supplied (pass --results-dir with base.json and head.json); nothing was run");
  }
  const r = runCmd(bin, ["diff", opts.resultsDir, "--json"], { timeoutMs: 60000 });
  const parsed = extractJson(r.stdout);
  if (!parsed || typeof parsed.verdict !== "string") {
    return unknown("testdelta", bin, `testdelta produced no parseable verdict (exit ${r.code}): ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
  }
  const counts = (parsed.counts ?? {}) as Record<string, unknown>;
  const detail = `verdict ${parsed.verdict}; base ${counts.base ?? "?"} tests, head ${counts.head ?? "?"} tests, regressions ${counts.regressions ?? "?"}, fixes ${counts.fixes ?? "?"}, still failing ${counts.stillFailing ?? "?"}`;
  if (parsed.verdict === "NO-REGRESSION") return { name: "testdelta", verdict: "PASS", detail, source: bin };
  if (parsed.verdict === "REGRESSED") return { name: "testdelta", verdict: "FAIL", detail, source: bin };
  return unknown("testdelta", bin, `unrecognized testdelta verdict: ${parsed.verdict}`);
}

export function reprocheckCheck(workroom: Workroom, opts: GateOptions): CheckResult {
  const bin = resolveGateTool("reprocheck").path;
  if (!bin) return unknown("reprocheck", "reprocheck", gateNotFoundDetail("reprocheck"));
  if (!opts.reproCmd) {
    return unknown("reprocheck", bin, "no repro command supplied (pass --repro-cmd); nothing was run");
  }
  const r = runCmd(
    bin,
    ["run", "--repo", workroom.worktreePath, "--base", workroom.baseSha, "--head", "HEAD", "--cmd", opts.reproCmd, "--json"],
    { timeoutMs: 180000 },
  );
  const parsed = extractJson(r.stdout);
  if (!parsed || typeof parsed.verdict !== "string") {
    return unknown("reprocheck", bin, `reprocheck produced no parseable verdict (exit ${r.code}): ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
  }
  const detail = typeof parsed.detail === "string" ? parsed.detail : `verdict ${parsed.verdict}`;
  if (parsed.verdict === "VERIFIED") return { name: "reprocheck", verdict: "PASS", detail, source: bin };
  const head = parsed.head as Record<string, unknown> | undefined;
  if (head && typeof head.exitCode === "number") {
    return { name: "reprocheck", verdict: "FAIL", detail: `verdict ${parsed.verdict}: ${detail}`, source: bin };
  }
  return unknown("reprocheck", bin, `reprocheck verdict ${parsed.verdict} without a completed head run`);
}

// Is the head commit reachable from any remote tracking branch known to
// this clone? cidiff reads CI runs from GitHub, so a head that was never
// pushed cannot have runs. A failed git call reads as not pushed only when
// the branch list itself came back empty; errors stay visible in the reason
// through the empty report path, never as a pass.
export function headIsPushed(workroom: Workroom, headSha: string): boolean {
  const r = git(["branch", "-r", "--contains", headSha], workroom.repoPath);
  if (r.code !== 0) return false;
  return r.stdout.split("\n").map((s) => s.trim()).filter(Boolean).length > 0;
}

interface CidiffVerdictEntry { name?: unknown; category?: unknown }
interface CidiffCounts { introduced?: unknown; pending?: unknown; indeterminate?: unknown; passing?: unknown; fixed?: unknown; "pre-existing"?: unknown; external?: unknown }

// Map a real cidiff report (verdicts list plus per category counts, no top
// level verdict field) onto the proof pack verdict scale. Decisive only:
// introduced failures are FAIL, a completed report with no introduced,
// pending, or indeterminate entries is PASS, everything else is UNKNOWN
// with the cause named in plain words.
export function cidiffVerdictFromReport(parsed: Record<string, unknown>, source: string, pushed: boolean, branch: string, headSha: string): CheckResult {
  const legacy = typeof parsed.verdict === "string" ? parsed.verdict : null;
  if (legacy) {
    const summary = typeof parsed.summary === "string" ? parsed.summary : legacy;
    if (/pass|no.new|no_new/i.test(legacy)) return { name: "cidiff", verdict: "PASS", detail: summary, source };
    if (/fail|regress/i.test(legacy)) return { name: "cidiff", verdict: "FAIL", detail: summary, source };
    return unknown("cidiff", source, `cidiff output had no decisive verdict: ${summary}`);
  }
  const verdicts = Array.isArray(parsed.verdicts) ? (parsed.verdicts as CidiffVerdictEntry[]) : null;
  if (!verdicts) return unknown("cidiff", source, "cidiff output had no verdicts list; nothing decisive was reported");
  const counts = (parsed.counts ?? {}) as CidiffCounts;
  const num = (v: unknown) => (typeof v === "number" ? v : 0);
  const namesIn = (cat: string) => verdicts.filter((v) => v.category === cat).map((v) => String(v.name ?? "unnamed check"));
  const warnings = Array.isArray(parsed.warnings) ? parsed.warnings.map(String).filter(Boolean) : [];
  if (verdicts.length === 0) {
    const cause = pushed
      ? `GitHub returned no CI check runs for head ${headSha.slice(0, 12)} on the pushed branch ${branch}; the repo may have no CI configured for this commit`
      : `the workroom branch ${branch} is not pushed, so GitHub has no CI runs for head ${headSha.slice(0, 12)}; push the branch (anh pr sync) and rebundle to get a cidiff verdict`;
    return unknown("cidiff", source, `cidiff found no check runs: ${cause}${warnings.length ? `. Warnings: ${warnings.join("; ")}` : ""}`);
  }
  const introduced = Math.max(num(counts.introduced), namesIn("introduced").length);
  if (introduced > 0) {
    return { name: "cidiff", verdict: "FAIL", detail: `cidiff: ${introduced} introduced CI failure(s): ${namesIn("introduced").join(", ") || "unnamed"} (passing ${num(counts.passing)}, pre-existing ${num(counts["pre-existing"])}, fixed ${num(counts.fixed)})`, source };
  }
  const pending = Math.max(num(counts.pending), namesIn("pending").length);
  if (pending > 0) return unknown("cidiff", source, `cidiff: ${pending} check(s) still pending (${namesIn("pending").join(", ")}); CI has not finished for head ${headSha.slice(0, 12)}, so there is no decisive verdict yet`);
  const indet = Math.max(num(counts.indeterminate), namesIn("indeterminate").length);
  if (indet > 0) return unknown("cidiff", source, `cidiff: ${indet} check(s) indeterminate (${namesIn("indeterminate").join(", ")}); cidiff could not attribute them to base or head, so there is no decisive verdict`);
  return { name: "cidiff", verdict: "PASS", detail: `cidiff: no introduced CI failures across ${verdicts.length} check(s) (passing ${num(counts.passing)}, pre-existing ${num(counts["pre-existing"])}, fixed ${num(counts.fixed)}, external ${num(counts.external)})`, source };
}

export function cidiffCheck(workroom: Workroom, headSha: string, opts: GateOptions): CheckResult {
  const bin = resolveGateTool("cidiff").path;
  if (!bin) return unknown("cidiff", "cidiff", gateNotFoundDetail("cidiff"));
  if (!opts.repoSlug) {
    return unknown("cidiff", bin, "no GitHub repo slug supplied (pass --repo-slug owner/repo); cidiff needs a GitHub repo, nothing was run");
  }
  const r = runCmd(bin, ["runs", opts.repoSlug, "--head", headSha, "--base", workroom.baseSha, "--json"], { timeoutMs: 120000 });
  const parsed = extractJson(r.stdout);
  if (!parsed) {
    return unknown("cidiff", bin, `cidiff produced no parseable output (exit ${r.code}), likely a fetch failure: ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
  }
  return cidiffVerdictFromReport(parsed, bin, headIsPushed(workroom, headSha), workroom.branch, headSha);
}

export function shipcheckCheck(opts: GateOptions): CheckResult {
  const res = resolveGateTool("shipcheck");
  if (!res.path) return unknown("shipcheck", "shipcheck", gateNotFoundDetail("shipcheck"));
  const src = res.path;
  if (!opts.repoSlug) {
    return unknown("shipcheck", src, "no GitHub repo slug supplied (pass --repo-slug owner/repo); nothing was run");
  }
  const r = res.viaNode
    ? runCmd("node", [src, "check", opts.repoSlug, "--json"], { timeoutMs: 120000 })
    : runCmd(src, ["check", opts.repoSlug, "--json"], { timeoutMs: 120000 });
  const parsed = extractJson(r.stdout);
  if (!parsed) {
    return unknown("shipcheck", src, `shipcheck produced no parseable output (exit ${r.code}), treated as a fetch failure: ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
  }
  const verdict = typeof parsed.verdict === "string" ? parsed.verdict : null;
  const summary = typeof parsed.summary === "string" ? parsed.summary : JSON.stringify(parsed).slice(0, 300);
  if (verdict === "GO") return { name: "shipcheck", verdict: "PASS", detail: summary, source: src };
  if (verdict && /no.go/i.test(verdict)) return { name: "shipcheck", verdict: "FAIL", detail: summary, source: src };
  return unknown("shipcheck", src, `shipcheck output had no decisive verdict: ${summary}`);
}
