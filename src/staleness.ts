// Staleness preflight for intent claim.
// Dogfood friction (2026-11-24): anh could not tell when a filed intent's
// work already landed on the target repo outside anh, or when an existing
// workroom base had fallen behind the repo's current HEAD, so an agent
// could start (or bundle) against a stale base and redo landed work.
//
// The check is warning only and honest about its limits: it compares real
// git state (current HEAD, workroom bases, branch ancestry, and commit
// messages that name the intent id). It never guesses that work is done
// from the goal text. When it cannot compare (no local repo path, or the
// repo does not answer), the status is "unknown" with the reason named,
// never "fresh".

import { existsSync } from "node:fs";
import { git } from "./git.ts";
import type { Intent, Workroom } from "./types.ts";

export type StalenessStatus = "fresh" | "stale" | "unknown";

export interface StalenessResult {
  status: StalenessStatus;
  intentId: string;
  repoPath: string | null;
  currentHead: string | null;
  workroomsChecked: number;
  warnings: string[];
}

function short(sha: string): string {
  return sha.slice(0, 12);
}

function isAncestor(repoPath: string, ancestor: string, descendant: string): boolean | null {
  const r = git(["merge-base", "--is-ancestor", ancestor, descendant], repoPath);
  if (r.code === 0) return true;
  if (r.code === 1) return false;
  return null;
}

// Find a commit on the current HEAD history whose message names the
// intent id. That is the one already-landed signal that is deterministic
// from git data alone; goal text matching would be a guess.
function commitMentioningIntent(repoPath: string, intentId: string): string | null {
  const r = git(["log", "--format=%H %s", "-n", "500", "HEAD"], repoPath);
  if (r.code !== 0) return null;
  for (const line of r.stdout.split("\n")) {
    if (line.includes(intentId)) return line.slice(0, 40).trim();
  }
  // Bodies can carry the id too; grep the full log as a fallback.
  const g = git(["log", "--format=%H", "-n", "500", "--grep", intentId, "HEAD"], repoPath);
  if (g.code === 0) {
    const first = g.stdout.split("\n").map((s) => s.trim()).filter(Boolean)[0];
    if (first) return first;
  }
  return null;
}

export function checkStaleness(intent: Intent, workrooms: Workroom[], repoPath?: string): StalenessResult {
  const own = workrooms.filter((w) => w.intentId === intent.id);
  const resolvedRepo = repoPath ?? own[0]?.repoPath;
  if (!resolvedRepo) {
    return {
      status: "unknown",
      intentId: intent.id,
      repoPath: null,
      currentHead: null,
      workroomsChecked: 0,
      warnings: [
        `staleness UNKNOWN: no local repo path was supplied (pass --repo <path>) and intent ${intent.id} has no workroom to take a repo path from, so the target repo current HEAD could not be compared`,
      ],
    };
  }
  if (!existsSync(resolvedRepo)) {
    return {
      status: "unknown",
      intentId: intent.id,
      repoPath: resolvedRepo,
      currentHead: null,
      workroomsChecked: own.length,
      warnings: [`staleness UNKNOWN: repo path does not exist: ${resolvedRepo}, so no comparison was run`],
    };
  }
  const headR = git(["rev-parse", "HEAD"], resolvedRepo);
  if (headR.code !== 0) {
    return {
      status: "unknown",
      intentId: intent.id,
      repoPath: resolvedRepo,
      currentHead: null,
      workroomsChecked: own.length,
      warnings: [`staleness UNKNOWN: git rev-parse HEAD failed in ${resolvedRepo}: ${headR.stderr.trim() || "unknown git error"}`],
    };
  }
  const currentHead = headR.stdout.trim();
  const warnings: string[] = [];

  const mentioning = commitMentioningIntent(resolvedRepo, intent.id);
  if (mentioning) {
    warnings.push(
      `already landed: commit ${short(mentioning)} on the current HEAD history of ${resolvedRepo} mentions intent ${intent.id}; check whether this intent's work already landed outside anh before starting`,
    );
  }

  for (const w of own) {
    // Landed via this workroom's own branch: its head is already an
    // ancestor of the current HEAD and it moved past its base.
    const branchHeadR = git(["rev-parse", "--verify", `refs/heads/${w.branch}`], resolvedRepo);
    if (branchHeadR.code === 0) {
      const branchHead = branchHeadR.stdout.trim();
      if (branchHead !== w.baseSha && isAncestor(resolvedRepo, branchHead, currentHead) === true) {
        warnings.push(
          `already landed: workroom ${w.id} branch ${w.branch} head ${short(branchHead)} is already an ancestor of current HEAD ${short(currentHead)}; the work appears already merged into the target repo`,
        );
      }
    }
    if (w.baseSha === currentHead) continue;
    const anc = isAncestor(resolvedRepo, w.baseSha, currentHead);
    if (anc === true) {
      const countR = git(["rev-list", "--count", `${w.baseSha}..${currentHead}`], resolvedRepo);
      const count = countR.code === 0 ? countR.stdout.trim() : "an unknown number of";
      warnings.push(
        `stale base: workroom ${w.id} base ${short(w.baseSha)} is ${count} commit(s) behind current HEAD ${short(currentHead)} in ${resolvedRepo}; create a fresh workroom or rebase before bundling, or the proof pack will measure against an old base`,
      );
    } else if (anc === false) {
      warnings.push(
        `stale base: workroom ${w.id} base ${short(w.baseSha)} is not an ancestor of current HEAD ${short(currentHead)} in ${resolvedRepo}; the repo history may have moved to another line or been rewritten, so this workroom does not measure against the current code`,
      );
    } else {
      warnings.push(
        `staleness UNKNOWN for workroom ${w.id}: git could not decide whether base ${short(w.baseSha)} is an ancestor of current HEAD ${short(currentHead)}`,
      );
    }
  }

  if (warnings.length) {
    return { status: "stale", intentId: intent.id, repoPath: resolvedRepo, currentHead, workroomsChecked: own.length, warnings };
  }
  if (!own.length) {
    return {
      status: "unknown",
      intentId: intent.id,
      repoPath: resolvedRepo,
      currentHead,
      workroomsChecked: 0,
      warnings: [
        `staleness UNKNOWN for already-done detection: intent ${intent.id} has no existing workroom and no commit on current HEAD ${short(currentHead)} mentions it, so anh can only report the current HEAD, not prove the work is undone`,
      ],
    };
  }
  return { status: "fresh", intentId: intent.id, repoPath: resolvedRepo, currentHead, workroomsChecked: own.length, warnings: [] };
}

export function formatStaleness(result: StalenessResult): string {
  if (result.status === "fresh") {
    return `staleness: fresh (current HEAD ${result.currentHead ? short(result.currentHead) : "?"}, ${result.workroomsChecked} workroom base(s) at HEAD, no landed-work signal)`;
  }
  return result.warnings.map((w) => `staleness warning: ${w}`).join("\n");
}
