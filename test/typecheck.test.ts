// Strict typecheck gate: the runtime is Node type stripping, which erases
// types without checking them, so a type error can only be caught by
// running tsc. This test runs the project's own typecheck when the
// compiler is installed (dev dependencies present) and skips with the
// reason when it is not, for example in a fresh worktree or on a machine
// that only runs the zero dependency runtime. A skip here means the
// typecheck is UNKNOWN on that machine, never a pass.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tscBin = join(root, "node_modules", ".bin", "tsc");

test("typecheck: tsc --noEmit is clean under the strict tsconfig", (t) => {
  if (!existsSync(tscBin)) {
    t.skip("typescript not installed in this checkout; run npm install, then npm run typecheck");
    return;
  }
  let out = "";
  try {
    execFileSync(tscBin, ["--noEmit"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
    assert.fail(`tsc --noEmit reported errors:\n${out}`);
  }
});
