// Scoped tokens (Phase 2a).
// anh mints a local token tied to one passport. The raw token is returned
// once at issuance and never stored; at rest in .anh/tokens/ there is only
// a SHA-256 hash. Operations can require a token (ANH_REQUIRE_TOKEN=1 or a
// --token flag on the command); verification checks hash, passport binding,
// revocation, and expiry.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { newId, nowIso } from "./hash.ts";
import type { Store } from "./store.ts";
import type { Passport, ScopedToken } from "./types.ts";

export function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export function issueToken(
  store: Store,
  passport: Passport,
  opts: { label?: string; expiresAt?: string } = {},
): { record: ScopedToken; rawToken: string } {
  const rawToken = `anh_${randomBytes(24).toString("hex")}`;
  const record: ScopedToken = {
    kind: "scoped_token",
    id: newId("tok"),
    passportId: passport.id,
    tokenHash: hashToken(rawToken),
    label: opts.label,
    createdAt: nowIso(),
    expiresAt: opts.expiresAt,
    revoked: false,
  };
  store.save("tokens", record);
  return { record, rawToken };
}

function hashesEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

// Returns null when the token is valid for the passport, or a reason string.
export function tokenInvalidReason(
  store: Store,
  passportId: string,
  rawToken: string | undefined,
  nowMs: number = Date.now(),
): string | null {
  if (!rawToken) return "no token supplied";
  const wanted = hashToken(rawToken);
  const mine = store.list<ScopedToken>("tokens").filter((t) => t.passportId === passportId);
  const match = mine.find((t) => hashesEqual(t.tokenHash, wanted));
  if (!match) return `token does not match any token issued for passport ${passportId}`;
  if (match.revoked) return `token ${match.id} has been revoked`;
  if (match.expiresAt && Date.parse(match.expiresAt) <= nowMs) {
    return `token ${match.id} expired at ${match.expiresAt}`;
  }
  return null;
}

export function assertTokenValid(store: Store, passportId: string, rawToken: string | undefined): void {
  const reason = tokenInvalidReason(store, passportId, rawToken);
  if (reason) throw new Error(`token check failed for passport ${passportId}: ${reason}`);
}

// Gate used by guarded commands: when a token is supplied it must verify;
// when one is demanded (ANH_REQUIRE_TOKEN=1 or --require-token) it must
// be present and valid.
export function enforceTokenIfRequired(
  store: Store,
  passportId: string,
  rawToken: string | undefined,
  requiredFlag: boolean = false,
): void {
  const required = requiredFlag || process.env.ANH_REQUIRE_TOKEN === "1";
  if (rawToken || required) assertTokenValid(store, passportId, rawToken);
}

export function revokeToken(store: Store, tokenId: string): ScopedToken {
  const rec = store.load<ScopedToken>("tokens", tokenId);
  if (!rec) throw new Error(`token not found: ${tokenId}`);
  rec.revoked = true;
  store.save("tokens", rec);
  return rec;
}
