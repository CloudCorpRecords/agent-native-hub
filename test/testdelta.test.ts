import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "../src/store.ts";
import { produceTestdelta, readTestdeltaResults } from "../src/testdelta.ts";
import { testdeltaCheck } from "../src/gates.ts";
import { newId, nowIso } from "../src/hash.ts";
import type { Workroom } from "../src/types.ts";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.ts");
const CMD = "node --test --test-reporter $ANH_TESTDELTA_REPORTER calc.test.mjs";

function gitFixture(cwd: string, args: string[]): string {
  return execFileSync("git", ["-c", "user.name=Anh Test", "-c", "user.email=anh-test@example.com", ...args], { cwd, encoding: "utf8" });
}

const TEST_FILE = `import { test } from "node:test";
import assert from "node:assert/strict";
import { add } from "./calc.mjs";

test("adds small numbers", () => { assert.equal(add(1, 2), 3); });
test("adds other numbers", () => { assert.equal(add(2, 2), 4); });
`;

function makeFixture(baseImpl: string, headImpl: string): { store: Store; repo: string; workroom: Workroom; outDir: string } {
  const root = mkdtempSync(join(tmpdir(), "anh-td-"));
  const workspace = join(root, "workspace");
  const repo = join(root, "repo");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(repo, { recursive: true });
  gitFixture(repo, ["init", "-q"]);
  writeFileSync(join(repo, "calc.mjs"), baseImpl);
  writeFileSync(join(repo, "calc.test.mjs"), TEST_FILE);
  gitFixture(repo, ["add", "."]);
  gitFixture(repo, ["commit", "-qm", "base"]);
  const baseSha = gitFixture(repo, ["rev-parse", "HEAD"]).trim();

  const store = new Store(workspace);
  const worktreePath = join(root, "wt");
  gitFixture(repo, ["worktree", "add", "-b", "anh/td-test", worktreePath, baseSha]);
  writeFileSync(join(worktreePath, "calc.mjs"), headImpl);
  gitFixture(worktreePath, ["add", "."]);
  gitFixture(worktreePath, ["commit", "-qm", "head work"]);
  const workroom: Workroom = {
    kind: "workroom", id: newId("wr"), repoPath: repo, branch: "anh/td-test",
    worktreePath, baseRef: "HEAD", baseSha, intentId: newId("intent"), passportId: newId("pass"),
    repoKey: "local/repo", status: "open",
    runLog: [{ at: nowIso(), event: "workroom_created", detail: "fixture" }],
    createdAt: nowIso(),
  };
  store.save("workrooms", workroom);
  return { store, repo, workroom, outDir: join(root, "results") };
}

const GOOD = "export function add(a, b) { return a + b; }\n";
const BAD = "export function add(a, b) { return a - b; }\n";

test("produce: a head regression yields real base and head files and a FAIL testdelta verdict", () => {
  const f = makeFixture(GOOD, BAD);
  const produced = produceTestdelta(f.workroom, { cmd: CMD, outDir: f.outDir });
  assert.equal(produced.baseCount, 2);
  assert.equal(produced.headCount, 2);
  const base = JSON.parse(readFileSync(produced.baseFile, "utf8")) as Record<string, string>;
  const head = JSON.parse(readFileSync(produced.headFile, "utf8")) as Record<string, string>;
  assert.deepEqual(Object.values(base).sort(), ["pass", "pass"]);
  assert.deepEqual(Object.values(head).sort(), ["fail", "fail"]);
  // Base and head keys must line up, or testdelta would see only adds and drops.
  assert.deepEqual(Object.keys(base).sort(), Object.keys(head).sort());
  const verdict = testdeltaCheck({ resultsDir: produced.resultsDir });
  assert.equal(verdict.verdict, "FAIL", verdict.detail);
});

test("produce: a head fix yields a PASS testdelta verdict", () => {
  const f = makeFixture(BAD, GOOD);
  const produced = produceTestdelta(f.workroom, { cmd: CMD, outDir: f.outDir });
  const verdict = testdeltaCheck({ resultsDir: produced.resultsDir });
  assert.equal(verdict.verdict, "PASS", verdict.detail);
});

test("produce: a command that writes no results is an error, not an empty result set", () => {
  const f = makeFixture(GOOD, BAD);
  assert.throws(
    () => produceTestdelta(f.workroom, { cmd: "true", outDir: f.outDir }),
    /ANH_TESTDELTA_OUT/,
  );
  assert.equal(existsSync(join(f.outDir, "base.json")), false);
});

test("produce: the temporary base worktree is removed afterwards", () => {
  const f = makeFixture(GOOD, BAD);
  produceTestdelta(f.workroom, { cmd: CMD, outDir: f.outDir });
  const list = gitFixture(f.repo, ["worktree", "list", "--porcelain"]);
  assert.equal(list.match(/worktree /g)?.length, 2, list);
});

test("readTestdeltaResults refuses an empty map and an invalid verdict value", () => {
  const dir = mkdtempSync(join(tmpdir(), "anh-td-read-"));
  const empty = join(dir, "empty.json");
  writeFileSync(empty, "{}\n");
  assert.throws(() => readTestdeltaResults(empty, "base"), /zero tests/);
  const bad = join(dir, "bad.json");
  writeFileSync(bad, JSON.stringify({ "some test": "maybe" }));
  assert.throws(() => readTestdeltaResults(bad, "base"), /expected pass, fail, or skip/);
});

function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync("node", [CLI, ...args], { encoding: "utf8" });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

test("CLI: proofpack bundle --test-cmd produces testdelta results inline and the pack verifies", { timeout: 120000 }, () => {
  const root = mkdtempSync(join(tmpdir(), "anh-td-cli-"));
  const workspace = join(root, "workspace");
  const repo = join(root, "repo");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(repo, { recursive: true });
  gitFixture(repo, ["init", "-q"]);
  writeFileSync(join(repo, "calc.mjs"), GOOD);
  writeFileSync(join(repo, "calc.test.mjs"), TEST_FILE);
  gitFixture(repo, ["add", "."]);
  gitFixture(repo, ["commit", "-qm", "base"]);

  const ws = ["--workspace", workspace, "--json"];
  const passport = JSON.parse(runCli(["passport", "create", "--agent", "td-cli", "--owner", "test-owner", "--scope", "local/repo|**|propose", ...ws]).stdout) as { id: string };
  const intent = JSON.parse(runCli(["intent", "create", "--goal", "bundle test-cmd fixture", "--criterion", "testdelta verdict is real", ...ws]).stdout) as { id: string };
  const claim = runCli(["intent", "claim", "--id", intent.id, "--passport", passport.id, ...ws]);
  assert.equal(claim.status, 0, claim.stderr);
  const workroom = JSON.parse(runCli(["workroom", "create", "--intent", intent.id, "--passport", passport.id, "--repo", repo, "--branch", "anh/td-cli", ...ws]).stdout) as { id: string; worktreePath: string };
  writeFileSync(join(workroom.worktreePath, "calc.mjs"), BAD);
  gitFixture(workroom.worktreePath, ["add", "."]);
  gitFixture(workroom.worktreePath, ["commit", "-qm", "break add"]);

  const bundle = runCli(["proofpack", "bundle", "--workroom", workroom.id, "--test-cmd", CMD, ...ws]);
  assert.equal(bundle.status, 0, bundle.stderr);
  const pack = JSON.parse(bundle.stdout) as { id: string; checks: { name: string; verdict: string }[] };
  const td = pack.checks.find((c) => c.name === "testdelta");
  assert.equal(td?.verdict, "FAIL", JSON.stringify(pack.checks));
  const verify = runCli(["proofpack", "verify", "--id", pack.id, ...ws]);
  assert.equal(verify.status, 0, verify.stderr);
});

test("CLI: testdelta produce runs through the anh binary and reports the verdict", { timeout: 120000 }, () => {
  const f = makeFixture(GOOD, BAD);
  const r = spawnSync("node", [CLI, "testdelta", "produce", "--workroom", f.workroom.id, "--cmd", CMD, "--workspace", join(f.store.root, ".."), "--json"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout) as { baseCount: number; headCount: number; verdict: { verdict: string } };
  assert.equal(parsed.baseCount, 2);
  assert.equal(parsed.headCount, 2);
  assert.equal(parsed.verdict.verdict, "FAIL");
});
