// cidiff verdict mapping: the real cidiff report carries a verdicts list
// and per category counts, never a top level verdict string. These tests
// pin the mapping, including the dogfood case that filed the friction
// intent: an empty verdicts list on an unpushed workroom branch.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cidiffVerdictFromReport, gateNotFoundDetail, headIsPushed, resolveGateTool, shipcheckCheck, testdeltaCheck, toolPaths } from "../src/gates.ts";
import type { Workroom } from "../src/types.ts";

const SRC = "cidiff-test";
const HEAD = "abcdef1234567890abcdef1234567890abcdef12";

function report(verdicts: unknown[], counts: Record<string, number>) {
  return { verdicts, counts, warnings: [] } as Record<string, unknown>;
}
const zero = { introduced: 0, "pre-existing": 0, external: 0, fixed: 0, passing: 0, indeterminate: 0, pending: 0 };

test("cidiff: empty verdicts on an unpushed branch is UNKNOWN naming the unpushed cause", () => {
  const r = cidiffVerdictFromReport(report([], zero), SRC, false, "anh/wr-1", HEAD);
  assert.equal(r.verdict, "UNKNOWN");
  assert.match(r.detail, /not pushed/);
  assert.match(r.detail, /anh\/wr-1/);
});

test("cidiff: empty verdicts on a pushed branch is UNKNOWN naming no CI runs", () => {
  const r = cidiffVerdictFromReport(report([], zero), SRC, true, "anh/wr-1", HEAD);
  assert.equal(r.verdict, "UNKNOWN");
  assert.match(r.detail, /no CI check runs/);
  assert.doesNotMatch(r.detail, /not pushed/);
});

test("cidiff: introduced failures are FAIL with the check names in the detail", () => {
  const r = cidiffVerdictFromReport(
    report([{ name: "unit", category: "introduced" }, { name: "lint", category: "passing" }], { ...zero, introduced: 1, passing: 1 }),
    SRC, true, "anh/wr-1", HEAD);
  assert.equal(r.verdict, "FAIL");
  assert.match(r.detail, /unit/);
});

test("cidiff: completed report with no introduced failures is PASS", () => {
  const r = cidiffVerdictFromReport(
    report([{ name: "unit", category: "passing" }, { name: "old", category: "pre-existing" }], { ...zero, passing: 1, "pre-existing": 1 }),
    SRC, true, "anh/wr-1", HEAD);
  assert.equal(r.verdict, "PASS");
  assert.match(r.detail, /no introduced CI failures/);
});

test("cidiff: pending checks are UNKNOWN, never a pass", () => {
  const r = cidiffVerdictFromReport(
    report([{ name: "unit", category: "pending" }], { ...zero, pending: 1 }),
    SRC, true, "anh/wr-1", HEAD);
  assert.equal(r.verdict, "UNKNOWN");
  assert.match(r.detail, /still pending/);
});

test("cidiff: indeterminate checks are UNKNOWN, never a pass", () => {
  const r = cidiffVerdictFromReport(
    report([{ name: "unit", category: "indeterminate" }], { ...zero, indeterminate: 1 }),
    SRC, true, "anh/wr-1", HEAD);
  assert.equal(r.verdict, "UNKNOWN");
  assert.match(r.detail, /indeterminate/);
});

test("cidiff: a report with no verdicts list is UNKNOWN", () => {
  const r = cidiffVerdictFromReport({ counts: zero }, SRC, true, "anh/wr-1", HEAD);
  assert.equal(r.verdict, "UNKNOWN");
});

test("headIsPushed: a commit with no remote branch containing it reads false, with one reads true", () => {
  const dir = mkdtempSync(join(tmpdir(), "anh-gates-"));
  try {
    const g = (args: string[], cwd = dir) => execFileSync("git", args, { cwd, encoding: "utf8" });
    g(["init", "-q", "-b", "main"]);
    g(["config", "user.email", "t@example.com"]); g(["config", "user.name", "T"]);
    execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "one"], { cwd: dir });
    const sha = g(["rev-parse", "HEAD"]).trim();
    const wr = { repoPath: dir, branch: "main" } as Workroom;
    assert.equal(headIsPushed(wr, sha), false);
    const remote = join(dir, "remote.git");
    g(["init", "-q", "--bare", remote]);
    g(["remote", "add", "origin", remote]);
    g(["push", "-q", "origin", "main"]);
    g(["fetch", "-q", "origin"]);
    assert.equal(headIsPushed(wr, sha), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("gate discovery: PATH fallback finds a tool with no fleet install", () => {
  const dir = mkdtempSync(join(tmpdir(), "anh-gatepath-"));
  try {
    const binDir = join(dir, "bin"); mkdirSync(binDir);
    const fake = join(binDir, "testdelta");
    writeFileSync(fake, "#!/bin/sh\necho '{\"verdict\":\"NO-REGRESSION\",\"counts\":{\"base\":2,\"head\":2,\"regressions\":0,\"fixes\":0,\"stillFailing\":0}}'\n");
    chmodSync(fake, 0o755);
    const env = { PATH: binDir, HOME: join(dir, "nohome") } as NodeJS.ProcessEnv;
    // HOME does not redirect homedir() on all platforms, so assert through the
    // env-driven paths: the override and PATH candidates are what move.
    assert.equal(resolveGateTool("testdelta", { ...env, ANH_TESTDELTA_BIN: fake }).path, fake);
    const res = resolveGateTool("testdelta", env);
    assert.ok(res.searched.some((s) => s === fake), `searched should include PATH candidate, got ${res.searched.join(",")}`);
    if (!res.searched.some((s) => s.includes("fleet-tools"))) assert.fail("searched should include the fleet install");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("gate discovery: a missing tool detail names the machine, searched paths, and the override", () => {
  const dir = mkdtempSync(join(tmpdir(), "anh-gatemiss-"));
  try {
    const detail = gateNotFoundDetail("testdelta", { PATH: dir } as NodeJS.ProcessEnv);
    assert.match(detail, /not found on this machine/);
    assert.match(detail, /ANH_TESTDELTA_BIN/);
    assert.match(detail, /fleet-tools/);
    const check = testdeltaCheck({});
    assert.equal(check.verdict, "UNKNOWN");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("gate discovery: shipcheck on PATH runs directly and maps GO to PASS", () => {
  const dir = mkdtempSync(join(tmpdir(), "anh-ship-"));
  try {
    const fake = join(dir, "shipcheck");
    writeFileSync(fake, "#!/bin/sh\necho '{\"verdict\":\"GO\",\"summary\":\"ready\"}'\n");
    chmodSync(fake, 0o755);
    const prev = process.env.ANH_SHIPCHECK_BIN;
    process.env.ANH_SHIPCHECK_BIN = fake;
    try {
      const r = shipcheckCheck({ repoSlug: "owner/repo" });
      assert.equal(r.verdict, "PASS");
      assert.equal(r.source, fake);
    } finally { if (prev === undefined) delete process.env.ANH_SHIPCHECK_BIN; else process.env.ANH_SHIPCHECK_BIN = prev; }
    assert.equal(toolPaths({ ANH_CIDIFF_BIN: "/nope/cidiff", PATH: dir }).shipcheck ?? null, toolPaths({ ANH_CIDIFF_BIN: "/nope/cidiff", PATH: dir }).shipcheck);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
