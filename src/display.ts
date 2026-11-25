// Shared human readable rendering for passports and scopes.
// One format everywhere (CLI text, error messages, web inbox) so a scope
// is never shown without its repo, its paths, and its rights. Two scopes
// on the same repo with different paths must not look like duplicates.

import type { Passport, PassportScope } from "./types.ts";

// Mirrors the passport create input format: "repo|path,path|rights".
export function formatScope(scope: PassportScope): string {
  return `${scope.repo}|${scope.paths.join(",")}|${scope.rights}`;
}

export function formatScopes(passport: Passport): string {
  return passport.scopes.map(formatScope).join(", ");
}

export function formatPassportLine(passport: Passport): string {
  return `${passport.id}  agent=${passport.agentId} owner=${passport.humanOwner} status=${passport.status} scopes=${formatScopes(passport)}`;
}
