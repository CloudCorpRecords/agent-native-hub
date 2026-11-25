#!/usr/bin/env node
// anh: agent native platform CLI (working codename agent-native-github).
// Commands: passport, intent, workroom, proofpack, inbox, review, serve.

import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import { computeProofPackHash, newId, nowIso, verifyProofPack } from "./hash.ts";
import { Store } from "./store.ts";
import { commitIdentityWarning, git, gitOrThrow, revParse } from "./git.ts";
import { cidiffCheck, diffCheck, reprocheckCheck, shipcheckCheck, testdeltaCheck, toolPaths } from "./gates.ts";
import {
  assertFilesInScope, assertPassportUsable, assertRepoScope, assertWorkroomTimeWithinLimits, recordSpend,
} from "./enforce.ts";
import { enforceTokenIfRequired, issueToken, revokeToken } from "./tokens.ts";
import { createDelivery, redeemDelivery } from "./delivery.ts";
import { GhCliTransport, syncPr } from "./prsync.ts";
import { decideReview } from "./review.ts";
import { summarizeReputation } from "./reputation.ts";
import { closeWorkroom, handoffWorkroom, killWorkroom, resumeWorkroom } from "./workroom.ts";
import { produceTestdelta } from "./testdelta.ts";
import { formatPassportLine } from "./display.ts";
import { pendingPacks, startServer } from "./server.ts";
import { runMcpServer } from "./mcp.ts";
import { checkStaleness, formatStaleness } from "./staleness.ts";
import { formatVettingDetail, formatVettingLine, recordVetting, runVetting, summarizeVetting, vetPassport } from "./vet.ts";
import { asIntent, asPassport, asProofPack, asWorkroom } from "./validate.ts";
import type {
  FeedbackItem, Intent, Passport, PassportMcpSurface, ProofPack, ReputationEvent, Rights, ScopedToken, TokenDelivery, VettingRecord, Workroom,
} from "./types.ts";

// The repo key a passport scope is checked against: an explicit slug when
// given, else the GitHub slug parsed from the origin remote, else
// local/<directory name> for purely local repos.
function deriveRepoKey(repoPath: string, slugFlag?: string): string {
  if (slugFlag) return slugFlag;
  const remote = git(["remote", "get-url", "origin"], repoPath);
  if (remote.code === 0) {
    const m = remote.stdout.trim().match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/);
    if (m) return `${m[1]}/${m[2]}`;
  }
  return `local/${basename(repoPath)}`;
}

function tokenGate(store: Store, flags: Flags, passportId: string): void {
  enforceTokenIfRequired(store, passportId, flags.single.get("token"), flags.single.has("require-token"));
}

interface Flags {
  multi: Map<string, string[]>;
  single: Map<string, string>;
  json: boolean;
  workspace: string;
}

function parseFlags(argv: string[]): Flags {
  const multi = new Map<string, string[]>();
  const single = new Map<string, string>();
  let json = false;
  let workspace = process.cwd();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") { json = true; continue; }
    if (a === "--require-token" || a === "--force" || a === "--delete-branch") {
      single.set(a.slice(2), "true");
      continue;
    }
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const val = argv[i + 1];
      if (val === undefined || val.startsWith("--")) throw new Error(`flag --${key} needs a value`);
      i++;
      if (key === "workspace") { workspace = val; continue; }
      single.set(key, val);
      const arr = multi.get(key) ?? [];
      arr.push(val);
      multi.set(key, arr);
    }
  }
  return { multi, single, json, workspace };
}

function need(flags: Flags, key: string): string {
  const v = flags.single.get(key);
  if (!v) throw new Error(`missing required flag --${key}`);
  return v;
}

function out(flags: Flags, human: string, data: unknown): void {
  console.log(flags.json ? JSON.stringify(data, null, 2) : human);
}

// The MCP surface named by --mcp-dir / --mcp-cmd flags, merged over any
// surface the passport already carries. The command is one flag value
// split on whitespace, for example --mcp-cmd "node src/cli.ts mcp".
function mcpSurfaceFromFlags(flags: Flags, base?: PassportMcpSurface): PassportMcpSurface | undefined {
  const dir = flags.single.get("mcp-dir");
  const cmdRaw = flags.single.get("mcp-cmd");
  if (dir === undefined && cmdRaw === undefined) return base;
  const surface: PassportMcpSurface = { ...base };
  if (dir !== undefined) surface.dir = dir;
  if (cmdRaw !== undefined) {
    const command = cmdRaw.split(/\s+/).filter(Boolean);
    if (!command.length) throw new Error("--mcp-cmd needs a launch command, for example \"node server.js mcp\"");
    surface.command = command;
  }
  return surface;
}

function cmdPassport(store: Store, sub: string, flags: Flags): void {
  if (sub === "create") {
    const scopes = (flags.multi.get("scope") ?? []).map((s) => {
      const parts = s.split("|");
      if (parts.length !== 3) throw new Error(`--scope must be "repo|path|rights", got: ${s}`);
      const [repo, path, rights] = parts;
      if (!["read", "propose", "merge"].includes(rights)) throw new Error(`scope rights must be read, propose, or merge, got: ${rights}`);
      return { repo, paths: [path], rights: rights as Rights };
    });
    if (!scopes.length) throw new Error("at least one --scope is required");
    const limits: Passport["limits"] = {};
    if (flags.single.has("expires")) limits.expiresAt = flags.single.get("expires");
    if (flags.single.has("max-minutes")) limits.maxMinutes = Number(flags.single.get("max-minutes"));
    if (flags.single.has("max-spend")) limits.maxSpendUsd = Number(flags.single.get("max-spend"));
    const passport: Passport = {
      kind: "passport",
      id: newId("pass"),
      agentId: need(flags, "agent"),
      humanOwner: need(flags, "owner"),
      harness: flags.single.get("harness"),
      mcp: mcpSurfaceFromFlags(flags),
      scopes,
      limits,
      status: "active",
      createdAt: nowIso(),
    };
    const checked = asPassport(passport);
    // Vetting is wired into issue: when the passport names an MCP
    // surface, both tools run before anything is saved, and a decisive
    // FAIL blocks the issue outright. UNKNOWN outcomes are recorded
    // and printed, never hidden and never treated as a pass.
    const checks = checked.mcp ? vetPassport(checked) : [];
    if (checks.length && summarizeVetting(checks) === "FAIL") {
      const failed = checks.filter((c) => c.verdict === "FAIL").map((c) => `${c.name}: ${c.detail}`).join("; ");
      throw new Error(`passport issue blocked by vetting: ${failed}. Nothing was saved; fix the MCP surface or drop the --mcp-dir / --mcp-cmd flags to issue without vetting`);
    }
    const path = store.save("passports", checked);
    let human = `passport ${checked.id} for agent ${checked.agentId} (owner ${checked.humanOwner}) saved to ${path}`;
    let data: unknown = checked;
    if (checks.length) {
      const record = recordVetting(store, checked, "issue", checks);
      human += `\n${formatVettingLine(record)}\n${formatVettingDetail(record)}`;
      data = { passport: checked, vetting: record };
    }
    out(flags, human, data);
    return;
  }
  if (sub === "renew") {
    const raw = store.load<Passport>("passports", need(flags, "id"));
    if (!raw) throw new Error(`passport not found: ${flags.single.get("id")}`);
    const passport = asPassport(raw);
    if (passport.status === "revoked") {
      throw new Error(`passport ${passport.id} is revoked; a revoked passport cannot be renewed`);
    }
    if (passport.status === "suspended") {
      throw new Error(`passport ${passport.id} is suspended; renewal does not lift a suspension, which is a separate trust decision`);
    }
    const surface = mcpSurfaceFromFlags(flags, passport.mcp);
    if (surface) passport.mcp = surface;
    let expiresAt: string;
    if (flags.single.has("expires")) {
      expiresAt = need(flags, "expires");
      if (Number.isNaN(Date.parse(expiresAt))) throw new Error(`--expires must be an ISO date, got: ${expiresAt}`);
    } else {
      const days = flags.single.has("extend-days") ? Number(flags.single.get("extend-days")) : 30;
      if (!(days > 0)) throw new Error(`--extend-days must be a positive number, got: ${flags.single.get("extend-days")}`);
      const current = passport.limits.expiresAt ? Date.parse(passport.limits.expiresAt) : Number.NaN;
      const base = Number.isNaN(current) ? Date.now() : Math.max(Date.now(), current);
      expiresAt = new Date(base + days * 86400000).toISOString();
    }
    passport.limits.expiresAt = expiresAt;
    if (passport.status === "expired") passport.status = "active";
    const checked = asPassport(passport);
    // Renewal re-runs vetting when a surface is configured, with the
    // same block rule as issue: a decisive FAIL saves nothing, so the
    // old expiry and status stay in force.
    const checks = checked.mcp ? vetPassport(checked) : [];
    if (checks.length && summarizeVetting(checks) === "FAIL") {
      const failed = checks.filter((c) => c.verdict === "FAIL").map((c) => `${c.name}: ${c.detail}`).join("; ");
      throw new Error(`passport renewal blocked by vetting: ${failed}. The passport was not renewed`);
    }
    store.save("passports", checked);
    let human = `passport ${checked.id} renewed: expires ${checked.limits.expiresAt}, status ${checked.status}`;
    let data: unknown = checked;
    if (checks.length) {
      const record = recordVetting(store, checked, "renew", checks);
      human += `\n${formatVettingLine(record)}\n${formatVettingDetail(record)}`;
      data = { passport: checked, vetting: record };
    }
    out(flags, human, data);
    return;
  }
  if (sub === "vet") {
    const raw = store.load<Passport>("passports", need(flags, "id"));
    if (!raw) throw new Error(`passport not found: ${flags.single.get("id")}`);
    const passport = asPassport(raw);
    if (!passport.mcp) {
      throw new Error(`passport ${passport.id} names no MCP surface; nothing to vet. Set one with --mcp-dir or --mcp-cmd on passport create or passport renew`);
    }
    const record = runVetting(store, passport, "manual");
    if (!record) throw new Error(`passport ${passport.id} names no MCP surface; nothing to vet`);
    out(flags, `${formatVettingLine(record)}\n${formatVettingDetail(record)}`, record);
    if (record.overall === "FAIL") {
      throw new Error(`vetting FAIL for passport ${passport.id}: see the failing check above`);
    }
    return;
  }
  if (sub === "vettings") {
    const id = need(flags, "id");
    const all = store.list<VettingRecord>("vettings")
      .filter((r) => r.passportId === id)
      .sort((a, b) => b.at.localeCompare(a.at));
    const human = all.length
      ? all.map((r) => formatVettingLine(r)).join("\n")
      : `no vetting records for passport ${id}`;
    out(flags, human, all);
    return;
  }
  if (sub === "list") {
    const all = store.list<Passport>("passports");
    const human = all.length
      ? all.map((p) => formatPassportLine(p)).join("\n")
      : "no passports";
    out(flags, human, all);
    return;
  }
  if (sub === "spend") {
    const raw = store.load<Passport>("passports", need(flags, "id"));
    if (!raw) throw new Error(`passport not found: ${flags.single.get("id")}`);
    const passport = asPassport(raw);
    assertPassportUsable(passport);
    const usd = Number(need(flags, "usd"));
    const total = recordSpend(passport, usd);
    store.save("passports", passport);
    const limit = passport.limits.maxSpendUsd;
    out(flags, `passport ${passport.id}: recorded ${usd} USD, total spend ${total} USD${limit !== undefined ? ` of limit ${limit} USD` : " (no spend limit set)"}`, passport);
    return;
  }
  throw new Error(`unknown passport subcommand: ${sub}`);
}

function cmdToken(store: Store, sub: string, flags: Flags): void {
  if (sub === "issue") {
    const raw = store.load<Passport>("passports", need(flags, "passport"));
    if (!raw) throw new Error(`passport not found: ${flags.single.get("passport")}`);
    const passport = asPassport(raw);
    assertPassportUsable(passport);
    const { record, rawToken } = issueToken(store, passport, {
      label: flags.single.get("label"),
      expiresAt: flags.single.get("expires"),
    });
    // The raw token is printed exactly once, here. Only its hash is stored.
    out(
      flags,
      `token ${record.id} issued for passport ${passport.id}\ntoken (shown once, store it now): ${rawToken}`,
      { ...record, token: rawToken },
    );
    return;
  }
  if (sub === "list") {
    const all = store.list<ScopedToken>("tokens");
    const human = all.length
      ? all.map((t) => `${t.id}  passport=${t.passportId} revoked=${t.revoked}${t.expiresAt ? ` expires=${t.expiresAt}` : ""}${t.label ? ` label=${t.label}` : ""}`).join("\n")
      : "no tokens";
    out(flags, human, all);
    return;
  }
  if (sub === "revoke") {
    const rec = revokeToken(store, need(flags, "id"));
    out(flags, `token ${rec.id} revoked`, rec);
    return;
  }
  if (sub === "verify") {
    enforceTokenGateOrThrow(store, need(flags, "passport"), need(flags, "token"));
    out(flags, `token valid for passport ${flags.single.get("passport")}`, { ok: true });
    return;
  }
  if (sub === "deliver") {
    const raw = store.load<Passport>("passports", need(flags, "passport"));
    if (!raw) throw new Error(`passport not found: ${flags.single.get("passport")}`);
    const passport = asPassport(raw);
    assertPassportUsable(passport);
    const ttl = flags.single.has("ttl-minutes") ? Number(flags.single.get("ttl-minutes")) : undefined;
    const { record, deliveryCode, tokenRecord } = createDelivery(store, passport, {
      label: flags.single.get("label"),
      tokenExpiresAt: flags.single.get("expires"),
      ttlMinutes: ttl,
    });
    // The delivery code is printed exactly once, here. Neither it nor the
    // raw token is stored anywhere: the envelope on disk holds ciphertext
    // only. Carry the code to the receiving agent out of band; it runs
    // token redeem to recover the raw token once.
    out(
      flags,
      `delivery ${record.id} created for passport ${passport.id} (token ${tokenRecord.id}, expires ${record.expiresAt})\n` +
        `delivery code (shown once, carry it out of band, never file it): ${deliveryCode}\n` +
        `receiving agent runs: anh token redeem --delivery ${record.id} --code <delivery code>`,
      { ...record, deliveryCode },
    );
    return;
  }
  if (sub === "redeem") {
    const { record, rawToken } = redeemDelivery(store, need(flags, "delivery"), need(flags, "code"));
    // The raw token is printed exactly once, here, to the receiving agent.
    out(
      flags,
      `token for passport ${record.passportId} (token ${record.tokenId})\ntoken (shown once, store it now): ${rawToken}`,
      { delivery: record, token: rawToken },
    );
    return;
  }
  if (sub === "deliveries") {
    const all = store.list<TokenDelivery>("deliveries");
    const human = all.length
      ? all.map((d) => `${d.id}  passport=${d.passportId} token=${d.tokenId} expires=${d.expiresAt}${d.consumedAt ? ` consumed=${d.consumedAt}` : " unconsumed"}${d.label ? ` label=${d.label}` : ""}`).join("\n")
      : "no deliveries";
    out(flags, human, all);
    return;
  }
  throw new Error(`unknown token subcommand: ${sub}`);
}

function enforceTokenGateOrThrow(store: Store, passportId: string, rawToken: string): void {
  enforceTokenIfRequired(store, passportId, rawToken, true);
}

function cmdIntent(store: Store, sub: string, flags: Flags): void {
  if (sub === "create") {
    const criteria = (flags.multi.get("criterion") ?? []).map((c, i) => {
      const [description, test] = c.split("|");
      return { id: `c${i + 1}`, description, ...(test ? { test } : {}) };
    });
    const intent: Intent = {
      kind: "intent",
      id: newId("intent"),
      goal: need(flags, "goal"),
      ...(flags.single.has("repo") ? { repo: flags.single.get("repo") } : {}),
      acceptanceCriteria: criteria,
      contextRefs: flags.multi.get("context") ?? [],
      forbiddenAreas: flags.multi.get("forbid") ?? [],
      claim: { state: "unclaimed" },
      createdAt: nowIso(),
      createdBy: flags.single.get("by") ?? "cli",
    };
    const checked = asIntent(intent);
    const path = store.save("intents", checked);
    out(flags, `intent ${checked.id} created: ${checked.goal} (saved to ${path})`, checked);
    return;
  }
  if (sub === "preflight") {
    const intentRaw = store.load<Intent>("intents", need(flags, "id"));
    if (!intentRaw) throw new Error(`intent not found: ${flags.single.get("id")}`);
    const intent = asIntent(intentRaw);
    const workrooms = store.list<Workroom>("workrooms");
    const repoPath = flags.single.has("repo") ? resolve(flags.single.get("repo") as string) : undefined;
    const result = checkStaleness(intent, workrooms, repoPath);
    out(flags, `intent ${intent.id} preflight: ${formatStaleness(result)}`, result);
    return;
  }
  if (sub === "claim") {
    const intentRaw = store.load<Intent>("intents", need(flags, "id"));
    if (!intentRaw) throw new Error(`intent not found: ${flags.single.get("id")}`);
    const intent = asIntent(intentRaw);
    const passportRaw = store.load<Passport>("passports", need(flags, "passport"));
    if (!passportRaw) throw new Error(`passport not found: ${flags.single.get("passport")}`);
    const passport = asPassport(passportRaw);
    assertPassportUsable(passport);
    tokenGate(store, flags, passport.id);
    // Staleness preflight (warning only, never a block): when a repo path
    // is supplied with --repo, or an existing workroom for this intent
    // names one, compare workroom bases and landed-work signals against
    // the repo's current HEAD and surface any warning in plain words.
    const staleness = flags.single.has("repo") || store.list<Workroom>("workrooms").some((w) => w.intentId === intent.id)
      ? checkStaleness(intent, store.list<Workroom>("workrooms"), flags.single.has("repo") ? resolve(flags.single.get("repo") as string) : undefined)
      : null;
    // When the intent names its repo, the claiming passport must hold
    // propose scope on that repo. Intents filed before the repo field
    // existed have no repo to check; that gap is why the field was added.
    if (intent.repo) assertRepoScope(passport, intent.repo, "propose");
    const claimExpired = intent.claim.expiresAt ? Date.parse(intent.claim.expiresAt) < Date.now() : false;
    if (intent.claim.state === "claimed" && !claimExpired) {
      throw new Error(`intent ${intent.id} already claimed by ${intent.claim.passportId}`);
    }
    if (intent.claim.state === "completed") throw new Error(`intent ${intent.id} is already completed`);
    intent.claim = { state: "claimed", passportId: passport.id, claimedAt: nowIso() };
    store.save("intents", intent);
    const staleNote = staleness && staleness.status !== "fresh" ? `\n${formatStaleness(staleness)}` : "";
    out(flags, `intent ${intent.id} claimed by passport ${passport.id}${staleNote}`, intent);
    return;
  }
  if (sub === "list") {
    const all = store.list<Intent>("intents");
    const human = all.length
      ? all.map((i) => `${i.id}  [${i.claim.state}]${i.repo ? ` repo=${i.repo}` : ""} ${i.goal}`).join("\n")
      : "no intents";
    out(flags, human, all);
    return;
  }
  throw new Error(`unknown intent subcommand: ${sub}`);
}

function cmdWorkroom(store: Store, sub: string, flags: Flags): void {
  if (sub === "list") {
    const all = store.list<Workroom>("workrooms");
    const human = all.length
      ? all.map((w) => `${w.id}  [${w.status}] branch=${w.branch} intent=${w.intentId} passport=${w.passportId} worktree=${w.worktreePath}`).join("\n")
      : "no workrooms";
    out(flags, human, all);
    return;
  }
  if (sub === "close" || sub === "kill") {
    const opts = {
      force: flags.single.has("force"),
      deleteBranch: flags.single.has("delete-branch"),
      reason: flags.single.get("reason"),
    };
    const result = sub === "close" ? closeWorkroom(store, need(flags, "id"), opts) : killWorkroom(store, need(flags, "id"), opts);
    out(
      flags,
      `workroom ${result.workroom.id} ${result.workroom.status}: worktree ${result.worktreeRemoved ? "removed" : "already absent"}, branch ${result.workroom.branch} ${result.branchDeleted ? "deleted" : "kept"}${result.branchNote ? ` (${result.branchNote})` : ""}`,
      result,
    );
    return;
  }
  if (sub === "resume") {
    const workroom = resumeWorkroom(store, need(flags, "id"));
    const warning = commitIdentityWarning(workroom.worktreePath);
    out(flags, `workroom ${workroom.id} resumed: branch ${workroom.branch} at ${workroom.worktreePath}${warning ? `\nwarning: ${warning}` : ""}`, workroom);
    return;
  }
  if (sub === "handoff") {
    const { workroom, intent } = handoffWorkroom(store, need(flags, "id"), need(flags, "to"));
    out(flags, `workroom ${workroom.id} handed off to passport ${workroom.passportId}; intent ${intent.id} claim transferred`, { workroom, intent });
    return;
  }
  if (sub !== "create") throw new Error(`unknown workroom subcommand: ${sub}`);
  const intentRaw = store.load<Intent>("intents", need(flags, "intent"));
  if (!intentRaw) throw new Error(`intent not found: ${flags.single.get("intent")}`);
  const intent = asIntent(intentRaw);
  const passportId = need(flags, "passport");
  if (intent.claim.state !== "claimed" || intent.claim.passportId !== passportId) {
    throw new Error(`intent ${intent.id} is not claimed by passport ${passportId} (claim state: ${intent.claim.state})`);
  }
  const passportRaw = store.load<Passport>("passports", passportId);
  if (!passportRaw) throw new Error(`passport not found: ${passportId}`);
  const passport = asPassport(passportRaw);
  assertPassportUsable(passport);
  tokenGate(store, flags, passport.id);
  const repoPath = resolve(need(flags, "repo"));
  if (!existsSync(repoPath)) throw new Error(`repo path does not exist: ${repoPath}`);
  const repoKey = deriveRepoKey(repoPath, flags.single.get("repo-slug"));
  assertRepoScope(passport, repoKey, "propose");
  const baseRef = flags.single.get("base") ?? "HEAD";
  const baseSha = revParse(repoPath, baseRef);
  const branch = flags.single.get("branch") ?? `anh/${intent.id}`;
  const worktreePath = flags.single.get("worktree") ?? `${repoPath}-anh-${branch.replace(/[^a-zA-Z0-9]+/g, "-")}`;
  const r = git(["worktree", "add", "-b", branch, worktreePath, baseSha], repoPath);
  if (r.code !== 0) throw new Error(`git worktree add failed: ${r.stderr.trim()}`);
  const workroom: Workroom = {
    kind: "workroom",
    id: newId("wr"),
    repoPath,
    branch,
    worktreePath,
    baseRef,
    baseSha,
    intentId: intent.id,
    passportId,
    repoKey,
    status: "open",
    runLog: [{ at: nowIso(), event: "workroom_created", detail: `branch ${branch} at ${baseSha} in ${worktreePath}` }],
    createdAt: nowIso(),
  };
  const identityWarning = commitIdentityWarning(worktreePath);
  if (identityWarning) {
    workroom.runLog.push({ at: nowIso(), event: "commit_identity_missing", detail: identityWarning });
  }
  const checked = asWorkroom(workroom);
  const path = store.save("workrooms", checked);
  out(flags, `workroom ${checked.id}: branch ${branch} at ${worktreePath} (saved to ${path})${identityWarning ? `\nwarning: ${identityWarning}` : ""}`, checked);
}

function cmdProofpack(store: Store, sub: string, flags: Flags): void {
  if (sub === "bundle") {
    const workroomRaw = store.load<Workroom>("workrooms", need(flags, "workroom"));
    if (!workroomRaw) throw new Error(`workroom not found: ${flags.single.get("workroom")}`);
    const workroom = asWorkroom(workroomRaw);
    if (workroom.status !== "open") {
      throw new Error(`workroom ${workroom.id} is ${workroom.status}, not open; resume it before bundling a proof pack`);
    }
    const intentRaw = store.load<Intent>("intents", workroom.intentId);
    if (!intentRaw) throw new Error(`intent for workroom not found: ${workroom.intentId}`);
    const intent = asIntent(intentRaw);
    const passportRaw = store.load<Passport>("passports", workroom.passportId);
    if (!passportRaw) throw new Error(`passport for workroom not found: ${workroom.passportId}`);
    const passport = asPassport(passportRaw);
    assertPassportUsable(passport);
    tokenGate(store, flags, passport.id);
    assertWorkroomTimeWithinLimits(passport, workroom);
    if (flags.single.has("spend-usd")) {
      const total = recordSpend(passport, Number(flags.single.get("spend-usd")));
      store.save("passports", passport);
      workroom.runLog.push({ at: nowIso(), event: "spend_recorded", detail: `proofpack bundle recorded spend, passport total now ${total} USD` });
    }
    const headSha = revParse(workroom.worktreePath, "HEAD");
    const diff = diffCheck(workroom, headSha);
    const repoKey = workroom.repoKey ?? deriveRepoKey(workroom.repoPath, flags.single.get("repo-slug"));
    assertFilesInScope(passport, repoKey, diff.files, "propose");
    let resultsDir = flags.single.get("results-dir");
    if (flags.single.has("test-cmd")) {
      // Produce real base and head test results for testdelta instead of
      // recording UNKNOWN for want of hand supplied files. An explicit
      // --results-dir still wins; production failure fails the bundle,
      // because the caller asked for produced results by name.
      if (!resultsDir) {
        const produced = produceTestdelta(workroom, {
          cmd: flags.single.get("test-cmd") as string,
          outDir: resolve(store.root, "testdelta", workroom.id),
        });
        resultsDir = produced.resultsDir;
        workroom.runLog.push({
          at: nowIso(),
          event: "testdelta_produced",
          detail: `test command produced ${produced.baseCount} base and ${produced.headCount} head test results in ${produced.resultsDir}`,
        });
      }
    }
    const opts = {
      resultsDir,
      reproCmd: flags.single.get("repro-cmd"),
      repoSlug: flags.single.get("repo-slug"),
    };
    const checks = [
      diff.check,
      testdeltaCheck(opts),
      reprocheckCheck(workroom, opts),
      cidiffCheck(workroom, headSha, opts),
      shipcheckCheck(opts),
    ];
    const riskFlags: string[] = [];
    for (const c of checks) if (c.verdict === "FAIL") riskFlags.push(`check_failed:${c.name}`);
    for (const f of diff.files) {
      for (const area of intent.forbiddenAreas) {
        if (f === area || f.startsWith(area.replace(/\/?$/, "/"))) riskFlags.push(`forbidden_area_touched:${f}`);
      }
    }
    if (diff.changedLines > 500) riskFlags.push(`large_diff:${diff.changedLines}_lines`);
    const pack: ProofPack = {
      kind: "proofpack",
      version: 1,
      id: newId("pack"),
      intentId: workroom.intentId,
      workroomId: workroom.id,
      passportId: workroom.passportId,
      repoPath: workroom.repoPath,
      baseRef: workroom.baseRef,
      headRef: workroom.branch,
      headSha,
      diffSummary: diff.summary,
      changedFiles: diff.files,
      checks,
      riskFlags,
      provenance: {
        bundledAt: nowIso(),
        bundledByPassportId: workroom.passportId,
        baseSha: workroom.baseSha,
        headSha,
        tools: toolPaths(),
      },
      contentHash: "",
    };
    pack.contentHash = computeProofPackHash(pack);
    const checked = asProofPack(pack);
    const path = store.save("proofpacks", checked);
    workroom.runLog.push({ at: nowIso(), event: "proofpack_bundled", detail: `pack ${checked.id} hash ${checked.contentHash.slice(0, 12)} at ${path}` });
    store.save("workrooms", workroom);
    const counts = checks.reduce<Record<string, number>>((acc, c) => ({ ...acc, [c.verdict]: (acc[c.verdict] ?? 0) + 1 }), {});
    out(flags, `proof pack ${checked.id} bundled to ${path}\nchecks: ${checks.map((c) => `${c.name}=${c.verdict}`).join(" ")}\nverdict counts: ${JSON.stringify(counts)}\nhash: ${checked.contentHash}`, checked);
    return;
  }
  if (sub === "verify") {
    let pack: unknown;
    if (flags.single.has("file")) {
      pack = store.loadFromFile(flags.single.get("file") as string);
    } else if (flags.single.has("id")) {
      pack = store.load("proofpacks", flags.single.get("id") as string);
      if (!pack) throw new Error(`proof pack not found: ${flags.single.get("id")}`);
    } else {
      throw new Error("pass --file <path> or --id <pack id>");
    }
    const result = verifyProofPack(pack);
    out(flags, result.ok ? "VALID: structure and content hash check out" : `INVALID: ${result.errors.join("; ")}`, result);
    if (!result.ok) process.exitCode = 1;
    return;
  }
  throw new Error(`unknown proofpack subcommand: ${sub}`);
}

function cmdTestdelta(store: Store, sub: string, flags: Flags): void {
  if (sub !== "produce") throw new Error(`unknown testdelta subcommand: ${sub}`);
  const workroomRaw = store.load<Workroom>("workrooms", need(flags, "workroom"));
  if (!workroomRaw) throw new Error(`workroom not found: ${flags.single.get("workroom")}`);
  const workroom = asWorkroom(workroomRaw);
  const outDir = flags.single.has("out")
    ? resolve(flags.single.get("out") as string)
    : resolve(store.root, "testdelta", workroom.id);
  const produced = produceTestdelta(workroom, { cmd: need(flags, "cmd"), outDir });
  workroom.runLog.push({
    at: nowIso(),
    event: "testdelta_produced",
    detail: `test command produced ${produced.baseCount} base and ${produced.headCount} head test results in ${produced.resultsDir}`,
  });
  store.save("workrooms", workroom);
  const verdict = testdeltaCheck({ resultsDir: produced.resultsDir });
  out(
    flags,
    `testdelta results produced for workroom ${workroom.id}: ${produced.baseCount} base tests, ${produced.headCount} head tests\nresults dir: ${produced.resultsDir} (pass it to proofpack bundle as --results-dir, or bundle with --test-cmd)\ntestdelta verdict on the produced files: ${verdict.verdict} (${verdict.detail})`,
    { ...produced, verdict },
  );
}

function cmdInbox(store: Store, sub: string, flags: Flags): void {
  if (sub !== "list") throw new Error(`unknown inbox subcommand: ${sub}`);
  const pending = pendingPacks(store);
  if (!pending.length) {
    out(flags, "inbox empty: no proof packs awaiting review", []);
    return;
  }
  const lines = pending.map((p) => {
    const intent = store.load<Intent>("intents", p.intentId);
    const counts = p.checks.reduce<Record<string, number>>((acc, c) => ({ ...acc, [c.verdict]: (acc[c.verdict] ?? 0) + 1 }), {});
    return `${p.id}  intent=${p.intentId} agent_passport=${p.passportId} head=${p.headSha.slice(0, 8)}\n  goal: ${intent ? intent.goal : "unknown intent"}\n  checks: ${p.checks.map((c) => `${c.name}=${c.verdict}`).join(" ")} (${JSON.stringify(counts)})${p.riskFlags.length ? `\n  risk: ${p.riskFlags.join(", ")}` : ""}\n  bundled: ${p.provenance.bundledAt}`;
  });
  out(flags, `awaiting review: ${pending.length}\n${lines.join("\n")}`, pending);
}

function cmdReview(store: Store, sub: string, flags: Flags): void {
  if (sub !== "decide") throw new Error(`unknown review subcommand: ${sub}`);
  const feedback: FeedbackItem[] = (flags.multi.get("feedback") ?? []).map((f) => {
    const idx = f.indexOf(":");
    if (idx < 0) throw new Error(`--feedback must be "category:message", got: ${f}`);
    return { category: f.slice(0, idx), message: f.slice(idx + 1) };
  });
  const decisionKind = need(flags, "decision");
  if (!["approve", "reject", "changes"].includes(decisionKind)) {
    throw new Error(`--decision must be approve, reject, or changes, got: ${decisionKind}`);
  }
  const { decision, reputationEvent: event, decisionPath: decPath, reputationPath: repPath } = decideReview(store, {
    packId: need(flags, "pack"),
    decision: decisionKind as "approve" | "reject" | "changes",
    reviewer: need(flags, "reviewer"),
    feedback,
  });
  out(
    flags,
    `decision ${decision.id}: ${decision.decision} on pack ${decision.proofPackId} by ${decision.reviewer} (saved to ${decPath})\nreputation event ${event.id}: ${event.outcome} for passport ${event.passportId} (saved to ${repPath})`,
    { decision, reputationEvent: event },
  );
}

function cmdReputation(store: Store, sub: string, flags: Flags): void {
  if (sub !== "list") throw new Error(`unknown reputation subcommand: ${sub}`);
  const filter = flags.single.get("passport");
  const all = store.list<ReputationEvent>("reputation");
  const events = (filter ? all.filter((e) => e.passportId === filter) : all)
    .sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id));
  const passports = store.list<Passport>("passports");
  const agentIdByPassport = new Map(passports.map((p) => [p.id, p.agentId]));
  const summaries = summarizeReputation(events, agentIdByPassport);
  if (!events.length) {
    out(flags, "no reputation events recorded yet", { summaries, events });
    return;
  }
  const lines = summaries.map((s) => {
    const rate = s.acceptanceRate === null ? "n/a" : `${Math.round(s.acceptanceRate * 100)}%`;
    return `${s.passportId}${s.agentId ? ` agent=${s.agentId}` : ""}  total=${s.total} accepted=${s.accepted} rejected=${s.rejected} rework=${s.reworkRequested} acceptance=${rate} last=${s.lastOutcome} at ${s.lastAt}`;
  });
  const eventLines = events.map((e) => `  ${e.at} ${e.outcome} pack=${e.proofPackId} decision=${e.decisionId}`);
  out(flags, `${lines.join("\n")}\n${eventLines.join("\n")}`, { summaries, events });
}

function cmdPr(store: Store, sub: string, flags: Flags): void {
  if (sub !== "sync") throw new Error(`unknown pr subcommand: ${sub}`);
  const rec = syncPr(store, {
    workroomId: need(flags, "workroom"),
    repoSlug: need(flags, "repo-slug"),
    base: flags.single.get("base") ?? "main",
    packId: flags.single.get("pack"),
    transport: new GhCliTransport(),
  });
  out(
    flags,
    rec.status === "posted"
      ? `PR posted for workroom ${rec.workroomId}: ${rec.url}`
      : `PR sync UNKNOWN for workroom ${rec.workroomId}: ${rec.reason}`,
    rec,
  );
}

const USAGE = `anh, agent native platform CLI (working codename)

usage: anh <command> [subcommand] [flags] [--json] [--workspace <dir>]

  passport create --agent <id> --owner <name> --scope "repo|path|rights" [--scope ...]
                  [--harness <name>] [--expires <iso>] [--max-minutes <n>] [--max-spend <usd>]
                  [--mcp-dir <path>] [--mcp-cmd "launch command"]
                  (with an MCP surface named, issue runs mcpvet on the dir
                   and mcpaudit on the command and records a vetting record;
                   a decisive FAIL from either tool blocks the issue)
  passport list   (scopes shown as repo|paths|rights for every scope)
  passport spend --id <passport id> --usd <amount>   (records spend, enforces the spend limit)
  passport renew --id <passport id> [--expires <iso>] [--extend-days <n>]
                  [--mcp-dir <path>] [--mcp-cmd "launch command"]
                  (extends expiry, default 30 days from the later of now and
                   the current expiry; reactivates an expired passport;
                   revoked and suspended passports cannot be renewed;
                   re-runs vetting when a surface is configured, and a
                   decisive FAIL blocks the renewal)
  passport vet --id <passport id>   (re-runs mcpvet and mcpaudit against the
                   passport's recorded MCP surface and records the run;
                   exits non-zero when the overall verdict is FAIL)
  passport vettings --id <passport id>   (lists recorded vetting runs, newest first)
  token issue --passport <id> [--label <text>] [--expires <iso>]   (raw token shown once)
  token list
  token revoke --id <token id>
  token verify --passport <id> --token <raw token>
  token deliver --passport <id> [--label <text>] [--expires <iso>] [--ttl-minutes <n>]
                  (seals a new token in a one time encrypted delivery envelope;
                   the delivery code is shown once and carried out of band, the
                   envelope on disk holds ciphertext only, never the raw token)
  token redeem --delivery <id> --code <delivery code>
                  (single use: decrypts the envelope, wipes it, and prints the
                   raw token once to the receiving agent)
  token deliveries   (lists delivery envelopes, metadata only, no secrets)
  intent create --goal <text> --criterion <text> [--criterion "text|test command"]
                [--repo <owner/repo>] [--context <ref>] [--forbid <path>] [--by <name>]
                (when --repo is given, intent claim enforces passport
                 propose scope on that repo)
  intent claim --id <intent id> --passport <passport id> [--token <raw token>]
                [--repo <path>]   (with a repo path, or an existing workroom
                 for the intent, claim also runs the staleness preflight and
                 prints any warning; warnings never block the claim)
  intent preflight --id <intent id> [--repo <path>]
                (compares existing workroom bases and landed-work signals
                 for the intent against the target repo's current HEAD and
                 warns in plain words when a base is stale or the work
                 appears already landed; status is fresh, stale, or
                 unknown, and unknown is never reported as fresh)
  intent list
  workroom create --intent <id> --passport <id> --repo <path>
                  [--branch <name>] [--base <ref>] [--worktree <path>] [--repo-slug owner/repo]
                  [--token <raw token>]   (passport scope for the repo is enforced)
  workroom list
  workroom close --id <workroom id> [--force] [--delete-branch] [--reason <text>]
                  (refuses to discard uncommitted changes unless --force;
                   branch is kept unless --delete-branch)
  workroom kill --id <workroom id> [--delete-branch] [--reason <text>]
                  (force removes the worktree, discarding uncommitted changes)
  workroom resume --id <workroom id>   (recreates the worktree from the branch)
  workroom handoff --id <workroom id> --to <passport id>
                  (transfers the workroom and its intent claim; the receiving
                   passport must hold propose scope on the workroom repo)
  proofpack bundle --workroom <id> [--results-dir <dir>] [--test-cmd <cmd>] [--repro-cmd <cmd>]
                  [--repo-slug owner/repo] [--token <raw token>] [--spend-usd <amount>]
                  (passport status, expiry, time limit, spend limit, and file scope enforced;
                   --test-cmd runs the suite on base and head first and feeds the
                   produced results to testdelta, see testdelta produce)
  proofpack verify (--file <path> | --id <pack id>)
  testdelta produce --workroom <id> --cmd <test command> [--out <dir>]
                  (runs the test command in a base checkout and in the workroom,
                   writing base.json and head.json in the testdelta format; the
                   command sees $ANH_TESTDELTA_REPORTER and $ANH_TESTDELTA_OUT,
                   for Node suites: --test-reporter $ANH_TESTDELTA_REPORTER)
  pr sync --workroom <id> --repo-slug owner/repo [--base <branch>] [--pack <pack id>]
                  (opens or updates a GitHub PR with the proof pack attached;
                   status is posted only with a confirmed PR URL, else UNKNOWN)
  inbox list
  reputation list [--passport <passport id>]
                (per passport counts and acceptance rate from recorded
                 events only, plus the events newest first)
  review decide --pack <id> --decision approve|reject|changes --reviewer <name>
                [--feedback "category:message"]
  serve [--port <n>]   (HTTP: /healthz, / web review inbox, /inbox JSON, /reputation JSON)
  mcp                  (MCP server on stdio, newline delimited JSON-RPC:
                        tools anh_passport_list, anh_intent_list,
                        anh_intent_create, anh_intent_claim, anh_workroom_list,
                        anh_inbox_list, anh_proofpack_verify,
                        anh_reputation_list, anh_review_decide; token tools
                        are deliberately not exposed, raw tokens never
                        travel in MCP transcripts)

  Guarded commands verify --token when one is supplied, and require one when
  ANH_REQUIRE_TOKEN=1 is set or --require-token is passed.

The local store lives in <workspace>/.anh/ as plain JSON files.`;

function main(): void {
  const argv = process.argv.slice(2);
  const [command, sub, ...rest] = argv;
  if (!command || command === "help" || command === "--help") {
    console.log(USAGE);
    return;
  }
  if (command === "serve") {
    // serve has no subcommand, so every argument after it is a flag.
    const serveFlags = parseFlags(argv.slice(1).filter((a) => a !== undefined));
    startServer(serveFlags.workspace, Number(serveFlags.single.get("port") ?? process.env.PORT ?? 8080));
    return;
  }
  if (command === "mcp") {
    // mcp has no subcommand either; stdout is the protocol channel, so
    // the server writes diagnostics to stderr only.
    const mcpFlags = parseFlags(argv.slice(1).filter((a) => a !== undefined));
    runMcpServer(mcpFlags.workspace);
    return;
  }
  const flags = parseFlags(rest);
  const store = new Store(flags.workspace);
  switch (command) {
    case "passport": cmdPassport(store, sub, flags); break;
    case "token": cmdToken(store, sub, flags); break;
    case "pr": cmdPr(store, sub, flags); break;
    case "intent": cmdIntent(store, sub, flags); break;
    case "workroom": cmdWorkroom(store, sub, flags); break;
    case "proofpack": cmdProofpack(store, sub, flags); break;
    case "testdelta": cmdTestdelta(store, sub, flags); break;
    case "inbox": cmdInbox(store, sub, flags); break;
    case "reputation": cmdReputation(store, sub, flags); break;
    case "review": cmdReview(store, sub, flags); break;
    default: throw new Error(`unknown command: ${command}\n\n${USAGE}`);
  }
}

try {
  main();
} catch (e) {
  console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
