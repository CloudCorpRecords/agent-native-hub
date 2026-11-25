// One time token delivery (dogfood friction fix).
// Problem: a scoped token could not be handed to an agent on another
// machine without writing the raw token into a file, a log, or a chat.
// Route built here: `anh token deliver` mints the token as usual (only
// its SHA-256 hash is stored in the token record) and seals the raw
// token inside a delivery envelope. The envelope is encrypted with
// AES-256-GCM under a key derived from a separate one time delivery
// code. The envelope file holds only ciphertext, iv, and auth tag:
// neither the raw token nor the delivery code is ever written to disk.
// The delivery code is shown exactly once, at creation, for the operator
// to carry out of band. `anh token redeem` with that code decrypts the
// envelope exactly once, wipes the ciphertext, and prints the raw token
// once to the receiving agent, which can then check it with
// `anh token verify`. A wrong code fails the GCM auth check and does
// not consume the envelope; an expired or consumed envelope cannot be
// redeemed.

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { newId, nowIso } from "./hash.ts";
import { issueToken } from "./tokens.ts";
import type { Store } from "./store.ts";
import type { Passport, ScopedToken, TokenDelivery } from "./types.ts";

export const DEFAULT_DELIVERY_TTL_MINUTES = 60;

function keyFromCode(code: string): Buffer {
  return createHash("sha256").update(code).digest();
}

export function createDelivery(
  store: Store,
  passport: Passport,
  opts: { label?: string; tokenExpiresAt?: string; ttlMinutes?: number; nowMs?: number } = {},
): { record: TokenDelivery; deliveryCode: string; tokenRecord: ScopedToken } {
  const nowMs = opts.nowMs ?? Date.now();
  const ttlMinutes = opts.ttlMinutes ?? DEFAULT_DELIVERY_TTL_MINUTES;
  if (!Number.isFinite(ttlMinutes) || ttlMinutes <= 0) {
    throw new Error(`delivery ttl must be a positive number of minutes, got: ${opts.ttlMinutes}`);
  }
  const { record: tokenRecord, rawToken } = issueToken(store, passport, {
    label: opts.label,
    expiresAt: opts.tokenExpiresAt,
  });
  const deliveryCode = `anhd_${randomBytes(24).toString("hex")}`;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFromCode(deliveryCode), iv);
  const ciphertext = Buffer.concat([cipher.update(rawToken, "utf8"), cipher.final()]);
  const record: TokenDelivery = {
    kind: "token_delivery",
    id: newId("dlv"),
    passportId: passport.id,
    tokenId: tokenRecord.id,
    label: opts.label,
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    createdAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + ttlMinutes * 60_000).toISOString(),
  };
  store.save("deliveries", record);
  return { record, deliveryCode, tokenRecord };
}

export function redeemDelivery(
  store: Store,
  deliveryId: string,
  deliveryCode: string,
  nowMs: number = Date.now(),
): { record: TokenDelivery; rawToken: string } {
  const record = store.load<TokenDelivery>("deliveries", deliveryId);
  if (!record) throw new Error(`delivery not found: ${deliveryId}`);
  if (record.consumedAt) throw new Error(`delivery ${deliveryId} was already redeemed at ${record.consumedAt}`);
  if (Date.parse(record.expiresAt) <= nowMs) {
    throw new Error(`delivery ${deliveryId} expired at ${record.expiresAt}`);
  }
  if (!record.ciphertext || !record.iv || !record.authTag) {
    throw new Error(`delivery ${deliveryId} holds no sealed token`);
  }
  let rawToken: string;
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      keyFromCode(deliveryCode),
      Buffer.from(record.iv, "base64"),
    );
    decipher.setAuthTag(Buffer.from(record.authTag, "base64"));
    rawToken = Buffer.concat([
      decipher.update(Buffer.from(record.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new Error(`delivery code does not match delivery ${deliveryId}; the envelope was not consumed`);
  }
  if (!rawToken.startsWith("anh_")) {
    throw new Error(`delivery ${deliveryId} did not decrypt to a token; the envelope was not consumed`);
  }
  // Single use: wipe the sealed material before returning the raw token,
  // so the envelope on disk can never be replayed or decrypted again.
  record.consumedAt = nowIso();
  record.ciphertext = "";
  record.iv = "";
  record.authTag = "";
  store.save("deliveries", record);
  return { record, rawToken };
}
