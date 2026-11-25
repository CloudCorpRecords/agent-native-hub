// GitHub PR sync (Phase 2b).
// Given a workroom and its proof pack, build a PR payload and hand it to a
// transport. The only built-in transport is the gh CLI. A sync is recorded
// as "posted" only when the transport returns a confirmed PR URL from
// GitHub; every other outcome is recorded as "unknown" with the reason.
// Nothing here ever fabricates a PR.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertPassportUsable, assertRepoScope } from "./enforce.ts";
import { git, runCmd, type CmdResult } from "./git.ts";
import { newId, nowIso } from "./hash.ts";
import type { Store } from "./store.ts";
import { asIntent, asPassport, asProofPack, asWorkroom } from "./validate.ts";
import type { Intent, Passport, PrSyncRecord, ProofPack, Workroom } from "./types.ts";

export interface PrPayload {
  repoSlug: string;
  title: string;
  head: string;
  base: string;
  body: string;
}

export interface TransportCheck {
  available: boolean;
  reason: string;
}

export interface TransportResult {
  posted: boolean;
  url?: string;
  prNumber?: number;
  reason: string;
}

export interface PrTransport {
  name: string;
  check(): TransportCheck;
  openOrUpdate(payload: PrPayload): TransportResult;
}

// The markdown section that carries the proof pack into the PR.
export function buildProofPackSection(pack: ProofPack, intent: Intent): string {
  const lines: string[] = [];
  lines.push("## Proof pack (anh)");
  lines.push("");
  lines.push(`Intent: ${intent.goal}`);
  lines.push(`Pack: ${pack.id}`);
  lines.push(`Content hash: ${pack.contentHash}`);
  lines.push(`Base: ${pack.provenance.baseSha}  Head: ${pack.headSha}`);
  lines.push("");
  lines.push("Acceptance criteria:");
  for (const c of intent.acceptanceCriteria) lines.push(`- ${c.description}`);
  lines.push("");
  lines.push("Checks:");
  for (const c of pack.checks) lines.push(`- ${c.name}: ${c.verdict} (${c.detail})`);
  lines.push("");
  lines.push(`Risk flags: ${pack.riskFlags.length ? pack.riskFlags.join(", ") : "none"}`);
  lines.push("");
  lines.push(`Changed files: ${pack.changedFiles.length ? pack.changedFiles.join(", ") : "none"}`);
  lines.push("");
  lines.push(`Diff summary: ${pack.diffSummary}`);
  lines.push("");
  lines.push("Verify this pack locally with: anh proofpack verify");
  return lines.join("\n");
}

export function buildPrPayload(args: {
  repoSlug: string;
  base: string;
  workroom: Workroom;
  pack: ProofPack;
  intent: Intent;
}): PrPayload {
  const { repoSlug, base, workroom, pack, intent } = args;
  return {
    repoSlug,
    title: `anh: ${intent.goal}`,
    head: workroom.branch,
    base,
    body: buildProofPackSection(pack, intent),
  };
}

// The command runner the gh transport shells out through. Injectable so
// tests can simulate gh outcomes (missing binary, stale account entries,
// a working API login) without a real gh install or account.
export type CmdRunner = (
  cmd: string,
  args: string[],
  opts?: { cwd?: string; timeoutMs?: number; env?: Record<string, string> },
) => CmdResult;

// gh CLI transport. Available only when gh exists and is authenticated.
export class GhCliTransport implements PrTransport {
  name = "gh-cli";
  private run: CmdRunner;

  constructor(run: CmdRunner = runCmd) {
    this.run = run;
  }

  check(): TransportCheck {
    const probe = this.run("gh", ["--version"], { timeoutMs: 15000 });
    if (probe.code !== 0) return { available: false, reason: "gh CLI not found on PATH" };
    const auth = this.run("gh", ["auth", "status"], { timeoutMs: 30000 });
    if (auth.code !== 0) {
      // gh auth status exits non-zero when ANY stored account entry is stale,
      // even when an active account (for example via GH_TOKEN) works fine.
      // The API is the ground truth: if gh can call it as a logged in user,
      // the transport is usable.
      const api = this.run("gh", ["api", "user", "--jq", ".login"], { timeoutMs: 30000 });
      if (api.code === 0 && api.stdout.trim()) {
        return {
          available: true,
          reason: `gh auth status reported a stale account entry, but gh api user confirms login as ${api.stdout.trim()}`,
        };
      }
      return {
        available: false,
        reason: `gh CLI is not authenticated: ${(auth.stderr || auth.stdout).trim().split("\n")[0] ?? "auth status failed"}`,
      };
    }
    return { available: true, reason: "gh CLI present and authenticated" };
  }

  openOrUpdate(payload: PrPayload): TransportResult {
    const dir = mkdtempSync(join(tmpdir(), "anh-pr-"));
    const bodyFile = join(dir, "body.md");
    writeFileSync(bodyFile, payload.body);
    const list = this.run(
      "gh",
      ["pr", "list", "--repo", payload.repoSlug, "--head", payload.head, "--json", "number,url", "--limit", "1"],
      { timeoutMs: 60000 },
    );
    if (list.code !== 0) {
      return { posted: false, reason: `gh pr list failed: ${(list.stderr || list.stdout).trim().slice(0, 300)}` };
    }
    let existing: { number: number; url: string }[] = [];
    try {
      existing = JSON.parse(list.stdout) as { number: number; url: string }[];
    } catch {
      return { posted: false, reason: "gh pr list returned unparseable output" };
    }
    if (existing.length) {
      const num = String(existing[0].number);
      const edit = this.run(
        "gh",
        ["pr", "edit", num, "--repo", payload.repoSlug, "--title", payload.title, "--body-file", bodyFile],
        { timeoutMs: 60000 },
      );
      if (edit.code !== 0) {
        return { posted: false, reason: `gh pr edit failed: ${(edit.stderr || edit.stdout).trim().slice(0, 300)}` };
      }
      return { posted: true, url: existing[0].url, prNumber: existing[0].number, reason: "existing PR updated with the latest proof pack" };
    }
    const create = this.run(
      "gh",
      ["pr", "create", "--repo", payload.repoSlug, "--title", payload.title, "--head", payload.head, "--base", payload.base, "--body-file", bodyFile],
      { timeoutMs: 60000 },
    );
    if (create.code !== 0) {
      return { posted: false, reason: `gh pr create failed: ${(create.stderr || create.stdout).trim().slice(0, 300)}` };
    }
    const url = create.stdout.trim().split("\n").filter(Boolean).pop() ?? "";
    if (!/^https?:\/\//.test(url)) {
      return { posted: false, reason: `gh pr create returned no PR URL: ${create.stdout.trim().slice(0, 200)}` };
    }
    const numMatch = url.match(/\/pull\/(\d+)/);
    return {
      posted: true,
      url,
      prNumber: numMatch ? Number(numMatch[1]) : undefined,
      reason: "PR created and URL confirmed by gh",
    };
  }
}

export interface SyncArgs {
  workroomId: string;
  repoSlug: string;
  base: string;
  packId?: string;
  transport: PrTransport;
}

// Runs one sync attempt and always records the outcome in the store,
// including unknown outcomes. Throws only on local misuse (missing
// objects, invalid pack, passport enforcement failures).
export function syncPr(store: Store, args: SyncArgs): PrSyncRecord {
  const workroomRaw = store.load<Workroom>("workrooms", args.workroomId);
  if (!workroomRaw) throw new Error(`workroom not found: ${args.workroomId}`);
  const workroom = asWorkroom(workroomRaw);
  const intentRaw = store.load<Intent>("intents", workroom.intentId);
  if (!intentRaw) throw new Error(`intent for workroom not found: ${workroom.intentId}`);
  const intent = asIntent(intentRaw);
  const passportRaw = store.load<Passport>("passports", workroom.passportId);
  if (!passportRaw) throw new Error(`passport for workroom not found: ${workroom.passportId}`);
  const passport = asPassport(passportRaw);
  // Syncing a PR is a propose action against the target repo.
  assertPassportUsable(passport);
  assertRepoScope(passport, args.repoSlug, "propose");

  const packs = store.list<ProofPack>("proofpacks").filter((p) => p.workroomId === workroom.id);
  const packRaw = args.packId ? packs.find((p) => p.id === args.packId) : packs[packs.length - 1];
  if (!packRaw) throw new Error(`no proof pack found for workroom ${workroom.id}; bundle one first`);
  const pack = asProofPack(packRaw);

  const payload = buildPrPayload({ repoSlug: args.repoSlug, base: args.base, workroom, pack, intent });

  const record = (status: "posted" | "unknown", reason: string, url?: string, prNumber?: number): PrSyncRecord => {
    const rec: PrSyncRecord = {
      kind: "pr_sync",
      id: newId("sync"),
      workroomId: workroom.id,
      proofPackId: pack.id,
      repoSlug: args.repoSlug,
      branch: workroom.branch,
      base: args.base,
      status,
      url,
      prNumber,
      reason,
      transport: args.transport.name,
      at: nowIso(),
    };
    store.save("prsyncs", rec);
    workroom.runLog.push({
      at: nowIso(),
      event: "pr_sync",
      detail: `${status} via ${args.transport.name}: ${reason}${url ? ` ${url}` : ""}`,
    });
    store.save("workrooms", workroom);
    return rec;
  };

  const check = args.transport.check();
  if (!check.available) {
    return record("unknown", `transport ${args.transport.name} unavailable: ${check.reason}`);
  }
  // The branch has to exist on the remote before a PR can point at it.
  const remote = git(["remote", "get-url", "origin"], workroom.worktreePath);
  if (remote.code !== 0) {
    return record("unknown", `workroom repo has no origin remote to push to: ${remote.stderr.trim()}`);
  }
  const push = git(["push", "origin", `HEAD:${workroom.branch}`], workroom.worktreePath);
  if (push.code !== 0) {
    return record("unknown", `git push of branch ${workroom.branch} failed: ${(push.stderr || push.stdout).trim().slice(0, 300)}`);
  }
  const result = args.transport.openOrUpdate(payload);
  if (!result.posted || !result.url) {
    return record("unknown", result.reason);
  }
  return record("posted", result.reason, result.url, result.prNumber);
}
