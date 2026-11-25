// Thin git helpers over child_process. No external dependencies.

import { execFileSync } from "node:child_process";

export interface CmdResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function runCmd(cmd: string, args: string[], opts: { cwd?: string; timeoutMs?: number; env?: Record<string, string> } = {}): CmdResult {
  try {
    const stdout = execFileSync(cmd, args, {
      cwd: opts.cwd,
      timeout: opts.timeoutMs ?? 120000,
      ...(opts.env ? { env: { ...process.env, ...opts.env } } : {}),
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stdout, stderr: "" };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string; message?: string };
    return {
      code: typeof err.status === "number" ? err.status : 1,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? err.message ?? "unknown error",
    };
  }
}

export function git(args: string[], cwd: string): CmdResult {
  return runCmd("git", args, { cwd });
}

export function gitOrThrow(args: string[], cwd: string, what: string): string {
  const r = git(args, cwd);
  if (r.code !== 0) throw new Error(`${what} failed: ${r.stderr.trim() || r.stdout.trim()}`);
  return r.stdout.trim();
}

export function revParse(repoPath: string, ref: string): string {
  return gitOrThrow(["rev-parse", ref], repoPath, `git rev-parse ${ref}`);
}

export interface CommitIdentity {
  name: string | null;
  email: string | null;
  missing: string[];
}

// The commit identity git itself would use for a new commit in this repo,
// resolved exactly as git resolves it (local config, then global, then
// system). anh never invents or sets an identity; it only reports what is
// configured, so a missing identity surfaces at workroom creation time
// instead of as a failed commit later (dogfood friction, 2026-11-19).
export function commitIdentity(repoPath: string, env?: Record<string, string>): CommitIdentity {
  const read = (key: string): string | null => {
    const r = runCmd("git", ["config", key], { cwd: repoPath, ...(env ? { env } : {}) });
    const v = r.code === 0 ? r.stdout.trim() : "";
    return v ? v : null;
  };
  const name = read("user.name");
  const email = read("user.email");
  const missing: string[] = [];
  if (!name) missing.push("user.name");
  if (!email) missing.push("user.email");
  return { name, email, missing };
}

// Plain words warning when a commit in this repo would fail for want of an
// identity, or null when one is configured. The example uses placeholders:
// the identity is the human's to choose, never anh's to invent.
export function commitIdentityWarning(repoPath: string, env?: Record<string, string>): string | null {
  const id = commitIdentity(repoPath, env);
  if (!id.missing.length) return null;
  return `no git commit identity is configured for this workroom (missing ${id.missing.join(" and ")}); commits will fail until an identity is set, for example: git config user.name "<your name>" and git config user.email "<your email>", run in the worktree`;
}
