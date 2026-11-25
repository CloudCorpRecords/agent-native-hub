// Node test runner reporter that writes testdelta result files.
//
// Usage (from the repo whose tests are being measured):
//   node --test --test-reporter /path/to/agent-native-github/scripts/testdelta-reporter.mjs test/
//   tsx --test --test-reporter /path/to/agent-native-github/scripts/testdelta-reporter.mjs test/*.test.ts
//
// `anh testdelta produce` sets ANH_TESTDELTA_OUT to the file each run must
// write (base.json for the base run, head.json for the head run) and
// ANH_TESTDELTA_REPORTER to this file's path, so the test command can
// reference the reporter as $ANH_TESTDELTA_REPORTER without hardcoding
// where anh is checked out.
//
// Output format: the flat map testdelta consumes, one entry per test,
// "<relative test file> :: <test name>" mapped to "pass", "fail", or
// "skip". Suite events are skipped; nested tests are recorded under their
// own name. The file is rewritten after every event, so a killed run
// still leaves the results gathered up to that point.

import { writeFileSync } from "node:fs";
import { relative } from "node:path";

export default async function* testdeltaReporter(source) {
  const out = process.env.ANH_TESTDELTA_OUT;
  const results = {};
  const flush = () => {
    if (!out) return;
    try {
      writeFileSync(out, JSON.stringify(results, null, 2) + "\n");
    } catch {
      // A reporter must never fail the test run it is measuring.
    }
  };
  for await (const event of source) {
    const type = event.type;
    if (type !== "test:pass" && type !== "test:fail" && type !== "test:skip" && type !== "test:todo") continue;
    const data = event.data ?? {};
    if (data.details && data.details.type === "suite") continue;
    if (!data.name) continue;
    const file = data.file ? relative(process.cwd(), data.file) : "unknown file";
    results[`${file} :: ${data.name}`] = type === "test:pass" ? "pass" : type === "test:fail" ? "fail" : "skip";
    flush();
  }
  flush();
  yield "";
}
