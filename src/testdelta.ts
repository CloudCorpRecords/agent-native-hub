// testdelta producer: run a repo's test suite on the workroom base and on
// the workroom head, and write the base.json and head.json result files
// that testdeltaCheck consumes.
//
// Before this existed, proofpack bundle recorded testdelta UNKNOWN unless
// the agent hand supplied result files, and there was no verb to produce
// them (dogfood friction intent intent_mwnqj12q897cbd).
//
// The test command runs through a shell in each checkout with two env
// vars set: ANH_TESTDELTA_REPORTER (absolute path of the bundled Node
// test reporter, scripts/testdelta-reporter.mjs) and ANH_TESTDELTA_OUT
// (the result file for that run). For a Node test runner suite the
// command looks like:
//   node --test --test-reporter $ANH_TESTDELTA_REPORTER test/
// Any command that writes the flat testdelta map (test name to pass,
// fail, or skip) to $ANH_TESTDELTA_OUT works; a run that writes nothing
// usable is an error here, never a silent empty result.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { git, runCmd } from "./git.ts";
import type { Workroom } from "./types.ts";

export function testdeltaReporterPath(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "testdelta-reporter.mjs");
}

export interface ProduceTestdeltaOptions {
  cmd: string;
  outDir: string;
  timeoutMs?: number;
}

export interface ProduceTestdeltaResult {
  resultsDir: string;
  baseFile: string;
  headFile: string;
  baseCount: number;
  headCount: number;
  baseExitCode: number;
  headExitCode: number;
}

const VALID_RESULTS = new Set(["pass", "fail", "skip"]);

export function readTestdeltaResults(file: string, label: string): Record<string, string> {
  if (!existsSync(file)) {
    throw new Error(`${label} run produced no result file at ${file}; the test command must write testdelta results to $ANH_TESTDELTA_OUT (for Node test suites, pass --test-reporter $ANH_TESTDELTA_REPORTER)`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new Error(`${label} run result file ${file} is not valid JSON`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} run result file ${file} is not a flat map of test name to result`);
  }
  const map = parsed as Record<string, unknown>;
  for (const [name, value] of Object.entries(map)) {
    if (typeof value !== "string" || !VALID_RESULTS.has(value)) {
      throw new Error(`${label} run result for "${name}" is ${JSON.stringify(value)}, expected pass, fail, or skip`);
    }
  }
  if (!Object.keys(map).length) {
    throw new Error(`${label} run recorded zero tests in ${file}; an empty result set would read as a fake pass downstream, so it is refused`);
  }
  return map as Record<string, string>;
}

// The base checkout is a fresh worktree and neither it nor the head
// worktree carries node_modules. When the main repo has one, link it in
// for the run so dependency backed suites can execute; links created
// here are removed again before returning.
function linkNodeModules(repoPath: string, targetDir: string): string | null {
  const source = join(repoPath, "node_modules");
  const link = join(targetDir, "node_modules");
  if (!existsSync(source) || existsSync(link)) return null;
  symlinkSync(source, link, "dir");
  return link;
}

function runSuite(cwd: string, cmd: string, outFile: string, label: string, timeoutMs: number): { count: number; exitCode: number } {
  // When anh itself runs inside a node --test process (our own test suite
  // does this), the runner's NODE_TEST_CONTEXT marker is in the
  // environment, and a nested node --test run reads it as a recursive
  // run() call: it silently skips every test file and still exits 0.
  // That would measure an empty suite and call it real. The measured
  // suite is an independent top level run, so the markers are removed
  // for the duration of the run and restored afterwards.
  const savedContext = process.env.NODE_TEST_CONTEXT;
  const savedWorker = process.env.NODE_TEST_WORKER_ID;
  delete process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_WORKER_ID;
  let r;
  try {
    r = runCmd("sh", ["-c", cmd], {
      cwd,
      timeoutMs,
      env: { ANH_TESTDELTA_REPORTER: testdeltaReporterPath(), ANH_TESTDELTA_OUT: outFile },
    });
  } finally {
    if (savedContext !== undefined) process.env.NODE_TEST_CONTEXT = savedContext;
    if (savedWorker !== undefined) process.env.NODE_TEST_WORKER_ID = savedWorker;
  }
  let results: Record<string, string>;
  try {
    results = readTestdeltaResults(outFile, label);
  } catch (e) {
    const tail = (r.stderr || r.stdout).trim().slice(-300);
    throw new Error(`${e instanceof Error ? e.message : String(e)} (suite exit code ${r.code}${tail ? `, output tail: ${tail}` : ""})`);
  }
  return { count: Object.keys(results).length, exitCode: r.code };
}

export function produceTestdelta(workroom: Workroom, opts: ProduceTestdeltaOptions): ProduceTestdeltaResult {
  if (workroom.status !== "open") {
    throw new Error(`workroom ${workroom.id} is ${workroom.status}, not open; resume it before producing testdelta results`);
  }
  if (!existsSync(workroom.worktreePath)) {
    throw new Error(`workroom worktree is missing: ${workroom.worktreePath}; resume the workroom first`);
  }
  const timeoutMs = opts.timeoutMs ?? 600000;
  mkdirSync(opts.outDir, { recursive: true });
  const baseFile = join(opts.outDir, "base.json");
  const headFile = join(opts.outDir, "head.json");
  const baseWorktree = mkdtempSync(join(tmpdir(), "anh-testdelta-base-"));
  let headLink: string | null = null;
  try {
    const add = git(["worktree", "add", "--detach", baseWorktree, workroom.baseSha], workroom.repoPath);
    if (add.code !== 0) throw new Error(`git worktree add for the base checkout failed: ${add.stderr.trim()}`);
    linkNodeModules(workroom.repoPath, baseWorktree);
    const base = runSuite(baseWorktree, opts.cmd, baseFile, "base", timeoutMs);
    headLink = linkNodeModules(workroom.repoPath, workroom.worktreePath);
    const head = runSuite(workroom.worktreePath, opts.cmd, headFile, "head", timeoutMs);
    return {
      resultsDir: opts.outDir,
      baseFile,
      headFile,
      baseCount: base.count,
      headCount: head.count,
      baseExitCode: base.exitCode,
      headExitCode: head.exitCode,
    };
  } finally {
    if (headLink) {
      try { unlinkSync(headLink); } catch { /* link already gone */ }
    }
    git(["worktree", "remove", "--force", baseWorktree], workroom.repoPath);
    git(["worktree", "prune"], workroom.repoPath);
  }
}
