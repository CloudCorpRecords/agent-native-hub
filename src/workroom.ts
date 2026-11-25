// Workroom lifecycle: close, kill, resume, and handoff (Phase 2 follow on).
// Creation lives in the CLI; this module owns everything after creation.
//
// Semantics, kept deliberately plain:
// - close: remove the git worktree. Refused while the worktree has
//   uncommitted changes unless force is set, so a clean close never
//   silently discards work. The branch is kept unless deleteBranch is
//   set, because proof packs and PR sync still point at it.
// - kill: force remove the worktree even when dirty. Uncommitted work is
//   discarded on purpose; that is what kill means, and the run log says so.
// - resume: recreate the worktree from the existing branch at the
//   recorded path, for a closed or killed workroom. Fails clearly when
//   the branch is gone or the path is occupied.
// - handoff: move an open workroom (and its intent claim) to another
//   passport. The receiving passport must be usable and hold propose
//   scope on the workroom repo; a denied handoff changes nothing.

import { existsSync } from "node:fs";
import type { Store } from "./store.ts";
import { commitIdentityWarning, git } from "./git.ts";
import { nowIso } from "./hash.ts";
import { asIntent, asPassport, asWorkroom } from "./validate.ts";
import { assertPassportUsable, assertRepoScope } from "./enforce.ts";
import type { Intent, Passport, Workroom } from "./types.ts";

export interface CloseOptions {
  force?: boolean;
  deleteBranch?: boolean;
  reason?: string;
}

export interface CloseResult {
  workroom: Workroom;
  worktreeRemoved: boolean;
  branchDeleted: boolean;
  branchNote?: string;
}

function loadWorkroom(store: Store, id: string): Workroom {
  const raw = store.load<Workroom>("workrooms", id);
  if (!raw) throw new Error(`workroom not found: ${id}`);
  return asWorkroom(raw);
}

// Uncommitted changes in the worktree, one porcelain line per change.
// A missing worktree directory reads as no changes: removal is then a
// bookkeeping close of an already gone tree, which git prune handles.
export function dirtyEntries(workroom: Workroom): string[] {
  if (!existsSync(workroom.worktreePath)) return [];
  const r = git(["status", "--porcelain"], workroom.worktreePath);
  if (r.code !== 0) throw new Error(`git status failed in worktree ${workroom.worktreePath}: ${r.stderr.trim()}`);
  return r.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
}

function removeWorktree(workroom: Workroom, force: boolean): boolean {
  if (!existsSync(workroom.worktreePath)) {
    git(["worktree", "prune"], workroom.repoPath);
    return false;
  }
  const args = ["worktree", "remove", ...(force ? ["--force"] : []), workroom.worktreePath];
  const r = git(args, workroom.repoPath);
  if (r.code !== 0) throw new Error(`git worktree remove failed: ${r.stderr.trim() || r.stdout.trim()}`);
  return true;
}

function maybeDeleteBranch(workroom: Workroom, force: boolean): { deleted: boolean; note?: string } {
  if (!workroom.branch) return { deleted: false };
  const args = ["branch", force ? "-D" : "-d", workroom.branch];
  const r = git(args, workroom.repoPath);
  if (r.code === 0) return { deleted: true };
  return { deleted: false, note: `branch ${workroom.branch} kept: ${(r.stderr.trim() || r.stdout.trim()).split("\n")[0]}` };
}

function finishClose(
  store: Store,
  workroom: Workroom,
  status: "closed" | "killed",
  event: string,
  detail: string,
  opts: CloseOptions,
): CloseResult {
  const removed = removeWorktree(workroom, status === "killed" || (opts.force ?? false));
  let branchDeleted = false;
  let branchNote: string | undefined;
  if (opts.deleteBranch) {
    const res = maybeDeleteBranch(workroom, opts.force ?? false);
    branchDeleted = res.deleted;
    branchNote = res.note;
  }
  workroom.status = status;
  workroom.closedAt = nowIso();
  if (opts.reason) workroom.closeReason = opts.reason;
  workroom.runLog.push({
    at: nowIso(),
    event,
    detail: `${detail}; worktree ${removed ? "removed" : "already absent"} at ${workroom.worktreePath}; branch ${workroom.branch} ${branchDeleted ? "deleted" : "kept"}${branchNote ? ` (${branchNote})` : ""}`,
  });
  const checked = asWorkroom(workroom);
  store.save("workrooms", checked);
  return { workroom: checked, worktreeRemoved: removed, branchDeleted, branchNote };
}

export function closeWorkroom(store: Store, id: string, opts: CloseOptions = {}): CloseResult {
  const workroom = loadWorkroom(store, id);
  if (workroom.status !== "open") {
    throw new Error(`workroom ${id} is ${workroom.status}, not open; only an open workroom can be closed`);
  }
  const dirty = dirtyEntries(workroom);
  if (dirty.length && !opts.force) {
    throw new Error(
      `workroom ${id} has ${dirty.length} uncommitted change(s) in ${workroom.worktreePath}: ${dirty.slice(0, 5).join(", ")}${dirty.length > 5 ? ", ..." : ""}. Commit them, or close with force to discard, or kill the workroom.`,
    );
  }
  return finishClose(store, workroom, "closed", "workroom_closed", opts.force && dirty.length ? `closed with force, ${dirty.length} uncommitted change(s) discarded` : "closed clean", opts);
}

export function killWorkroom(store: Store, id: string, opts: CloseOptions = {}): CloseResult {
  const workroom = loadWorkroom(store, id);
  if (workroom.status !== "open") {
    throw new Error(`workroom ${id} is ${workroom.status}, not open; only an open workroom can be killed`);
  }
  const dirty = dirtyEntries(workroom);
  return finishClose(
    store, workroom, "killed", "workroom_killed",
    `killed, worktree force removed${dirty.length ? `, ${dirty.length} uncommitted change(s) discarded` : ""}`,
    { ...opts, force: true },
  );
}

export function resumeWorkroom(store: Store, id: string): Workroom {
  const workroom = loadWorkroom(store, id);
  if (workroom.status === "open") {
    throw new Error(`workroom ${id} is already open at ${workroom.worktreePath}`);
  }
  const branchCheck = git(["rev-parse", "--verify", `refs/heads/${workroom.branch}`], workroom.repoPath);
  if (branchCheck.code !== 0) {
    throw new Error(`cannot resume workroom ${id}: branch ${workroom.branch} no longer exists in ${workroom.repoPath}`);
  }
  if (existsSync(workroom.worktreePath)) {
    throw new Error(`cannot resume workroom ${id}: path ${workroom.worktreePath} already exists and is not this workroom's registered worktree`);
  }
  const r = git(["worktree", "add", workroom.worktreePath, workroom.branch], workroom.repoPath);
  if (r.code !== 0) throw new Error(`git worktree add failed: ${r.stderr.trim() || r.stdout.trim()}`);
  workroom.status = "open";
  delete workroom.closedAt;
  delete workroom.closeReason;
  workroom.runLog.push({ at: nowIso(), event: "workroom_resumed", detail: `worktree recreated at ${workroom.worktreePath} on branch ${workroom.branch}` });
  const identityWarning = commitIdentityWarning(workroom.worktreePath);
  if (identityWarning) {
    workroom.runLog.push({ at: nowIso(), event: "commit_identity_missing", detail: identityWarning });
  }
  const checked = asWorkroom(workroom);
  store.save("workrooms", checked);
  return checked;
}

export function handoffWorkroom(store: Store, id: string, toPassportId: string): { workroom: Workroom; intent: Intent } {
  const workroom = loadWorkroom(store, id);
  if (workroom.status !== "open") {
    throw new Error(`workroom ${id} is ${workroom.status}, not open; only an open workroom can be handed off`);
  }
  if (toPassportId === workroom.passportId) {
    throw new Error(`workroom ${id} already belongs to passport ${toPassportId}`);
  }
  const targetRaw = store.load<Passport>("passports", toPassportId);
  if (!targetRaw) throw new Error(`passport not found: ${toPassportId}`);
  const target = asPassport(targetRaw);
  assertPassportUsable(target);
  const repoKey = workroom.repoKey ?? "";
  if (repoKey) assertRepoScope(target, repoKey, "propose");
  const intentRaw = store.load<Intent>("intents", workroom.intentId);
  if (!intentRaw) throw new Error(`intent for workroom not found: ${workroom.intentId}`);
  const intent = asIntent(intentRaw);
  if (intent.claim.state !== "claimed" || intent.claim.passportId !== workroom.passportId) {
    throw new Error(`intent ${intent.id} is not claimed by workroom passport ${workroom.passportId} (claim state: ${intent.claim.state}), so the claim cannot transfer`);
  }
  const from = workroom.passportId;
  workroom.passportId = toPassportId;
  workroom.runLog.push({ at: nowIso(), event: "workroom_handed_off", detail: `handed off from passport ${from} to passport ${toPassportId}` });
  intent.claim = { ...intent.claim, passportId: toPassportId };
  const checkedWorkroom = asWorkroom(workroom);
  const checkedIntent = asIntent(intent);
  store.save("workrooms", checkedWorkroom);
  store.save("intents", checkedIntent);
  return { workroom: checkedWorkroom, intent: checkedIntent };
}
