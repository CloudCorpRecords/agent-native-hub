import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { formatScope } from "../src/display.ts";
import { renderInboxHtml } from "../src/server.ts";
import { Store } from "../src/store.ts";
import type { Passport } from "../src/types.ts";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.ts");

function anhRaw(workspace: string, args: string[]) {
  return spawnSync("node", [CLI, ...args, "--workspace", workspace], { encoding: "utf8" });
}

function anhOk(workspace: string, args: string[]): Record<string, unknown> {
  const r = anhRaw(workspace, [...args, "--json"]);
  assert.equal(r.status, 0, `anh ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  return JSON.parse(r.stdout) as Record<string, unknown>;
}

function anhText(workspace: string, args: string[]): string {
  const r = anhRaw(workspace, args);
  assert.equal(r.status, 0, `anh ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  return r.stdout;
}

test("formatScope shows repo, paths, and rights", () => {
  assert.equal(
    formatScope({ repo: "CloudCorpRecords/xod", paths: ["app/**"], rights: "propose" }),
    "CloudCorpRecords/xod|app/**|propose",
  );
  assert.equal(
    formatScope({ repo: "CloudCorpRecords/xod", paths: ["app/**", "tests/**"], rights: "read" }),
    "CloudCorpRecords/xod|app/**,tests/**|read",
  );
});

test("intent repo: claim enforces passport repo scope at propose rights", { timeout: 120000 }, () => {
  const workspace = mkdtempSync(join(tmpdir(), "anh-intent-repo-"));

  const scopedOut = anhOk(workspace, [
    "passport", "create", "--agent", "agent-xod-only", "--owner", "owner",
    "--scope", "CloudCorpRecords/xod|**|propose",
  ]);
  const readOnly = anhOk(workspace, [
    "passport", "create", "--agent", "agent-reader", "--owner", "owner",
    "--scope", "CloudCorpRecords/greenlight|**|read",
  ]);
  const covering = anhOk(workspace, [
    "passport", "create", "--agent", "agent-greenlight", "--owner", "owner",
    "--scope", "CloudCorpRecords/greenlight|**|propose",
  ]);

  const intent = anhOk(workspace, [
    "intent", "create", "--goal", "greenlight work", "--criterion", "c1",
    "--repo", "CloudCorpRecords/greenlight",
  ]);
  assert.equal(intent.repo, "CloudCorpRecords/greenlight");

  // A passport scoped to a different repo is denied, with the repo named.
  const denied = anhRaw(workspace, ["intent", "claim", "--id", String(intent.id), "--passport", String(scopedOut.id)]);
  assert.notEqual(denied.status, 0);
  assert.match(denied.stderr, /no scope granting propose on repo CloudCorpRecords\/greenlight/);

  // Read rights on the right repo are not enough: propose is required.
  const deniedRead = anhRaw(workspace, ["intent", "claim", "--id", String(intent.id), "--passport", String(readOnly.id)]);
  assert.notEqual(deniedRead.status, 0);
  assert.match(deniedRead.stderr, /no scope granting propose on repo CloudCorpRecords\/greenlight/);

  // The denied claims changed nothing: a covering passport still claims.
  const claimed = anhOk(workspace, ["intent", "claim", "--id", String(intent.id), "--passport", String(covering.id)]);
  const claim = claimed.claim as { state: string; passportId: string };
  assert.equal(claim.state, "claimed");
  assert.equal(claim.passportId, String(covering.id));

  // An intent with no repo field keeps the old behavior: any usable
  // passport can claim it (backward compatibility for filed intents).
  const legacy = anhOk(workspace, ["intent", "create", "--goal", "legacy work", "--criterion", "c1"]);
  assert.equal(legacy.repo, undefined);
  const legacyClaim = anhOk(workspace, ["intent", "claim", "--id", String(legacy.id), "--passport", String(scopedOut.id)]);
  assert.equal((legacyClaim.claim as { state: string }).state, "claimed");

  // Intent list shows the repo when one is set.
  const listText = anhText(workspace, ["intent", "list"]);
  assert.match(listText, /repo=CloudCorpRecords\/greenlight/);
});

test("passport list: distinct path scopes on one repo do not look like duplicates", { timeout: 120000 }, () => {
  const workspace = mkdtempSync(join(tmpdir(), "anh-passport-list-"));
  anhOk(workspace, [
    "passport", "create", "--agent", "antigravity-like", "--owner", "owner",
    "--scope", "CloudCorpRecords/xod|app/**|propose",
    "--scope", "CloudCorpRecords/xod|tests/**|propose",
  ]);
  const text = anhText(workspace, ["passport", "list"]);
  assert.match(text, /CloudCorpRecords\/xod\|app\/\*\*\|propose/);
  assert.match(text, /CloudCorpRecords\/xod\|tests\/\*\*\|propose/);
});

test("web inbox: passports section shows repo, path, and rights for every scope", () => {
  const workspace = mkdtempSync(join(tmpdir(), "anh-passport-web-"));
  const store = new Store(workspace);
  const passport: Passport = {
    kind: "passport", id: "pass_paths", agentId: "agent-paths", humanOwner: "owner",
    scopes: [
      { repo: "CloudCorpRecords/xod", paths: ["app/**"], rights: "propose" },
      { repo: "CloudCorpRecords/xod", paths: ["tests/**"], rights: "propose" },
    ],
    limits: {}, status: "active", createdAt: new Date().toISOString(),
  };
  store.save("passports", passport);
  const html = renderInboxHtml(store);
  assert.match(html, /Passports/);
  assert.match(html, /CloudCorpRecords\/xod\|app\/\*\*\|propose/);
  assert.match(html, /CloudCorpRecords\/xod\|tests\/\*\*\|propose/);
});
