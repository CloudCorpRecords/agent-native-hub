// Passport enforcement (Phase 2a).
// Every guarded operation runs these checks before doing work. A failure
// throws an Error with a clear, human readable reason, and the operation
// does not proceed. There is no silent downgrade: out of scope is denied.

import type { Passport, Rights, Workroom } from "./types.ts";

export const RIGHTS_RANK: Record<Rights, number> = { read: 0, propose: 1, merge: 2 };

// Returns a reason string when the passport cannot be used at all
// (not active, or past its expiry), or null when it is usable.
export function passportUnusableReason(passport: Passport, nowMs: number = Date.now()): string | null {
  if (passport.status !== "active") {
    return `passport ${passport.id} is ${passport.status}, not active`;
  }
  if (passport.limits.expiresAt && Date.parse(passport.limits.expiresAt) <= nowMs) {
    return `passport ${passport.id} expired at ${passport.limits.expiresAt}`;
  }
  return null;
}

export function assertPassportUsable(passport: Passport, nowMs: number = Date.now()): void {
  const reason = passportUnusableReason(passport, nowMs);
  if (reason) throw new Error(reason);
}

// A scope matches a repo when its repo field is the repo key itself or "*".
export function scopesForRepo(passport: Passport, repoKey: string, minRights: Rights): Passport["scopes"] {
  return passport.scopes.filter(
    (s) => (s.repo === repoKey || s.repo === "*") && RIGHTS_RANK[s.rights] >= RIGHTS_RANK[minRights],
  );
}

export function assertRepoScope(passport: Passport, repoKey: string, minRights: Rights): void {
  if (!scopesForRepo(passport, repoKey, minRights).length) {
    const have = passport.scopes.map((s) => `${s.repo}|${s.paths.join(",")}|${s.rights}`).join(", ") || "none";
    throw new Error(
      `passport ${passport.id} has no scope granting ${minRights} on repo ${repoKey} (scopes: ${have})`,
    );
  }
}

// Glob-ish path matching for scope paths.
// "**" matches everything, "src/**" matches anything under src/, "src/*"
// matches one level under src/, "*" inside a segment matches within that
// segment, and a plain path matches itself or anything under it as a dir.
export function pathMatches(pattern: string, file: string): boolean {
  const pat = pattern.replace(/^\.\//, "");
  const f = file.replace(/^\.\//, "");
  if (pat === "**" || pat === "**/**") return true;
  if (pat.endsWith("/**")) {
    const dir = pat.slice(0, -3);
    return f === dir || f.startsWith(`${dir}/`);
  }
  if (pat.includes("*")) {
    const re = new RegExp(
      `^${pat.split("**").map((seg) => seg.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")).join(".*")}$`,
    );
    return re.test(f);
  }
  return f === pat || f.startsWith(`${pat.replace(/\/?$/, "/")}`);
}

// Every changed file must be covered by at least one in-scope path pattern
// at the required rights level. Files outside scope are denied by name.
export function assertFilesInScope(
  passport: Passport,
  repoKey: string,
  files: string[],
  minRights: Rights,
): void {
  const scopes = scopesForRepo(passport, repoKey, minRights);
  if (!scopes.length) {
    assertRepoScope(passport, repoKey, minRights);
    return;
  }
  const patterns = scopes.flatMap((s) => s.paths);
  const outside = files.filter((f) => !patterns.some((p) => pathMatches(p, f)));
  if (outside.length) {
    throw new Error(
      `passport ${passport.id} scope does not cover changed file(s) on ${repoKey}: ${outside.join(", ")} (allowed paths: ${patterns.join(", ") || "none"})`,
    );
  }
}

// Time limit: a workroom that has been open longer than the passport's
// maxMinutes cannot bundle new proof. The clock starts at workroom creation.
export function assertWorkroomTimeWithinLimits(
  passport: Passport,
  workroom: Workroom,
  nowMs: number = Date.now(),
): void {
  const max = passport.limits.maxMinutes;
  if (max === undefined) return;
  const started = Date.parse(workroom.createdAt);
  if (Number.isNaN(started)) return;
  const elapsedMinutes = (nowMs - started) / 60000;
  if (elapsedMinutes > max) {
    throw new Error(
      `passport ${passport.id} time limit exceeded: workroom ${workroom.id} has been open ${elapsedMinutes.toFixed(1)} minutes, limit is ${max}`,
    );
  }
}

// Spend limit: recording spend that would push the passport total over
// maxSpendUsd is denied and nothing is recorded. Returns the new total.
export function recordSpend(passport: Passport, usd: number): number {
  if (!(usd >= 0)) throw new Error(`spend amount must be a non-negative number, got ${usd}`);
  const current = passport.usage?.spendUsd ?? 0;
  const next = current + usd;
  const max = passport.limits.maxSpendUsd;
  if (max !== undefined && next > max) {
    throw new Error(
      `passport ${passport.id} spend limit exceeded: recorded ${current} USD plus ${usd} USD would pass the limit of ${max} USD`,
    );
  }
  passport.usage = { spendUsd: next, updatedAt: new Date().toISOString() };
  return next;
}
