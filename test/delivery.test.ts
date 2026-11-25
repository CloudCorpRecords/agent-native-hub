import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDelivery, redeemDelivery } from "../src/delivery.ts";
import { Store } from "../src/store.ts";
import { tokenInvalidReason } from "../src/tokens.ts";
import type { Passport, TokenDelivery } from "../src/types.ts";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.ts");

function anhRaw(workspace: string, args: string[]) {
  return spawnSync("node", [CLI, ...args, "--workspace", workspace], { encoding: "utf8" });
}

function anhOk(workspace: string, args: string[]): Record<string, unknown> {
  const r = anhRaw(workspace, [...args, "--json"]);
  assert.equal(r.status, 0, `anh ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  return JSON.parse(r.stdout) as Record<string, unknown>;
}

function makePassport(store: Store): Passport {
  const passport: Passport = {
    kind: "passport",
    id: "pass_delivery",
    agentId: "agent-delivery",
    humanOwner: "owner",
    scopes: [{ repo: "local/agent-native-github", paths: ["**"], rights: "propose" }],
    limits: {},
    status: "active",
    createdAt: new Date().toISOString(),
  };
  store.save("passports", passport);
  return passport;
}

function allStoreText(store: Store): string {
  const parts: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else parts.push(readFileSync(p, "utf8"));
    }
  };
  walk(store.root);
  return parts.join("\n");
}

test("deliver and redeem: the redeemed token verifies for the passport", () => {
  const workspace = mkdtempSync(join(tmpdir(), "anh-delivery-"));
  const store = new Store(workspace);
  const passport = makePassport(store);
  const { record, deliveryCode } = createDelivery(store, passport);
  const { rawToken } = redeemDelivery(store, record.id, deliveryCode);
  assert.equal(tokenInvalidReason(store, passport.id, rawToken), null);
});

test("the store never holds the raw token or the delivery code", () => {
  const workspace = mkdtempSync(join(tmpdir(), "anh-delivery-secret-"));
  const store = new Store(workspace);
  const passport = makePassport(store);
  const { record, deliveryCode } = createDelivery(store, passport);
  const before = allStoreText(store);
  assert.ok(!before.includes(deliveryCode), "delivery code must not be written to the store");
  const { rawToken } = redeemDelivery(store, record.id, deliveryCode);
  const after = allStoreText(store);
  assert.ok(!after.includes(rawToken), "raw token must not be written to the store");
  assert.ok(!after.includes(deliveryCode), "delivery code must not be written to the store");
  const saved = store.load<TokenDelivery>("deliveries", record.id);
  assert.ok(saved);
  assert.equal(saved.ciphertext, "");
  assert.ok(saved.consumedAt);
});

test("redeem is single use and a wrong code does not consume the envelope", () => {
  const workspace = mkdtempSync(join(tmpdir(), "anh-delivery-once-"));
  const store = new Store(workspace);
  const passport = makePassport(store);
  const { record, deliveryCode } = createDelivery(store, passport);
  assert.throws(
    () => redeemDelivery(store, record.id, "anhd_000000000000000000000000000000000000000000000000"),
    /does not match/,
  );
  const { rawToken } = redeemDelivery(store, record.id, deliveryCode);
  assert.ok(rawToken.startsWith("anh_"));
  assert.throws(() => redeemDelivery(store, record.id, deliveryCode), /already redeemed/);
});

test("an expired delivery cannot be redeemed", () => {
  const workspace = mkdtempSync(join(tmpdir(), "anh-delivery-expired-"));
  const store = new Store(workspace);
  const passport = makePassport(store);
  const t0 = Date.now();
  const { record, deliveryCode } = createDelivery(store, passport, { ttlMinutes: 5, nowMs: t0 });
  assert.throws(
    () => redeemDelivery(store, record.id, deliveryCode, t0 + 6 * 60_000),
    /expired/,
  );
});

test("CLI: token deliver, redeem, and verify round trip through the anh binary", { timeout: 120000 }, () => {
  const workspace = mkdtempSync(join(tmpdir(), "anh-delivery-cli-"));
  const passport = anhOk(workspace, [
    "passport", "create", "--agent", "agent-remote", "--owner", "owner",
    "--scope", "local/agent-native-github|**|propose",
  ]);
  const delivered = anhOk(workspace, ["token", "deliver", "--passport", String(passport.id)]);
  const deliveryId = String(delivered.id);
  const code = String(delivered.deliveryCode);
  assert.ok(code.startsWith("anhd_"));

  // The deliveries listing shows metadata only, never the code.
  const list = anhRaw(workspace, ["token", "deliveries"]);
  assert.equal(list.status, 0);
  assert.ok(list.stdout.includes(deliveryId));
  assert.ok(!list.stdout.includes(code));

  const redeemed = anhOk(workspace, ["token", "redeem", "--delivery", deliveryId, "--code", code]);
  const rawToken = String(redeemed.token);
  const verified = anhOk(workspace, ["token", "verify", "--passport", String(passport.id), "--token", rawToken]);
  assert.equal(verified.ok, true);

  // Second redeem through the CLI fails.
  const again = anhRaw(workspace, ["token", "redeem", "--delivery", deliveryId, "--code", code]);
  assert.notEqual(again.status, 0);
  assert.match(again.stderr, /already redeemed/);
});
