// Canonical JSON hashing for proof packs.
// The content hash covers every field except contentHash itself, with object
// keys sorted recursively, so a pack verifies regardless of key order in the
// file and any tampering with content changes the hash.

import { createHash, randomBytes } from "node:crypto";
import type { ProofPack } from "./types.ts";
import { validateProofPack } from "./validate.ts";

export function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(",")}]`;
  const rec = value as Record<string, unknown>;
  const keys = Object.keys(rec).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalStringify(rec[k])}`).join(",")}}`;
}

export function computeProofPackHash(pack: ProofPack): string {
  const rest: Record<string, unknown> = { ...(pack as unknown as Record<string, unknown>) };
  delete rest.contentHash;
  return createHash("sha256").update(canonicalStringify(rest)).digest("hex");
}

export function verifyProofPack(pack: unknown): { ok: boolean; errors: string[] } {
  const errors = validateProofPack(pack);
  if (errors.length) return { ok: false, errors };
  const p = pack as ProofPack;
  const recomputed = computeProofPackHash(p);
  if (recomputed !== p.contentHash) {
    return { ok: false, errors: [`content hash mismatch: file claims ${p.contentHash}, recomputed ${recomputed}`] };
  }
  return { ok: true, errors: [] };
}

export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}
