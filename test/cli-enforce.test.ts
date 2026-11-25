import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

test("CLI enforcement: expired passport, out of scope workroom, token gate", { timeout: 120000 }, () => {
  const root = mkdtempSync(join(tmpdir(), "anh-cli-enforce-"));
  const workspace = join(root, "workspace");
  const repo = join(root, "repo");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(repo, { recursive: true });
  const git = (args: string[]) =>
    execFileSync("git", ["-c", "user.name=Anh Test", "-c", "user.email=anh-test@example.com", ...args], { cwd: repo, stdio: "pipe" });
  git(["init", "-q"]);
  writeFileSync(join(repo, "hello.txt"), "hello\n");
  git(["add", "."]);
  git(["commit", "-qm", "base"]);

  // Expired passport cannot claim.
  const expired = anhOk(workspace, [
    "passport", "create", "--agent", "agent-old", "--owner", "owner",
    "--scope", "local/repo|**|propose", "--expires", "2000-01-01T00:00:00.000Z",
  ]);
  const intent1 = anhOk(workspace, ["intent", "create", "--goal", "g1", "--criterion", "c1"]);
  const claimExpired = anhRaw(workspace, ["intent", "claim", "--id", String(intent1.id), "--passport", String(expired.id)]);
  assert.notEqual(claimExpired.status, 0);
  assert.match(claimExpired.stderr, /expired/);

  // Passport scoped to a different repo cannot create a workroom here.
  const wrongRepo = anhOk(workspace, [
    "passport", "create", "--agent", "agent-wrong", "--owner", "owner",
    "--scope", "other/repo|**|merge",
  ]);
  anhOk(workspace, ["intent", "claim", "--id", String(intent1.id), "--passport", String(wrongRepo.id)]);
  const wrDenied = anhRaw(workspace, [
    "workroom", "create", "--intent", String(intent1.id), "--passport", String(wrongRepo.id), "--repo", repo,
  ]);
  assert.notEqual(wrDenied.status, 0);
  assert.match(wrDenied.stderr, /no scope granting propose on repo local\/repo/);

  // Token gate: with ANH_REQUIRE_TOKEN=1 a claim without a token fails,
  // with the issued token it succeeds, and a bogus token fails.
  const agent2 = anhOk(workspace, [
    "passport", "create", "--agent", "agent-two", "--owner", "owner",
    "--scope", "local/repo|**|propose",
  ]);
  const intent2 = anhOk(workspace, ["intent", "create", "--goal", "g2", "--criterion", "c1"]);
  const noToken = anhRaw(workspace, ["intent", "claim", "--id", String(intent2.id), "--passport", String(agent2.id)], { ANH_REQUIRE_TOKEN: "1" });
  assert.notEqual(noToken.status, 0);
  assert.match(noToken.stderr, /token check failed/);
  const issued = anhOk(workspace, ["token", "issue", "--passport", String(agent2.id)]) as { token?: string };
  assert.ok(issued.token, "issue returns the raw token once");
  const badToken = anhRaw(workspace, ["intent", "claim", "--id", String(intent2.id), "--passport", String(agent2.id), "--token", "anh_bogus"], { ANH_REQUIRE_TOKEN: "1" });
  assert.notEqual(badToken.status, 0);
  const withToken = anhRaw(workspace, ["intent", "claim", "--id", String(intent2.id), "--passport", String(agent2.id), "--token", String(issued.token)], { ANH_REQUIRE_TOKEN: "1" });
  assert.equal(withToken.status, 0, withToken.stderr || withToken.stdout);

  // Spend limit through the CLI: record up to the limit, then denied.
  const spender = anhOk(workspace, [
    "passport", "create", "--agent", "agent-spend", "--owner", "owner",
    "--scope", "local/repo|**|propose", "--max-spend", "5",
  ]);
  anhOk(workspace, ["passport", "spend", "--id", String(spender.id), "--usd", "5"]);
  const over = anhRaw(workspace, ["passport", "spend", "--id", String(spender.id), "--usd", "1"]);
  assert.notEqual(over.status, 0);
  assert.match(over.stderr, /spend limit exceeded/);
});
