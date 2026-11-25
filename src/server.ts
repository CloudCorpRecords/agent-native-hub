// Hosted review inbox (Phase 3).
// Dependency free, server rendered HTML from Node stdlib http.
// Endpoints:
//   GET  /healthz   JSON health check (the Fly.io deploy target)
//   GET  /          HTML review inbox: pending proof packs with verdicts,
//                   risk flags, and an approve / reject / changes form
//   GET  /inbox     JSON of proof packs awaiting review (Phase 1 surface)
//   GET  /reputation JSON reputation ledger: per passport summaries plus
//                   events newest first; the HTML inbox renders the same
//                   ledger as a section below the pending packs
//   POST /review    form encoded decision; records a ReviewDecision and a
//                   ReputationEvent through decideReview, the same code
//                   path as the CLI, then redirects back to /
//   POST /login     browser login: checks the inbox token and sets it as
//                   an HttpOnly cookie so the HTML inbox stays usable
//
// Auth: when ANH_INBOX_TOKEN is set (or an inboxToken is passed to
// startServer), every route except GET /healthz requires that token,
// presented as an Authorization: Bearer header (API clients) or as the
// anh_inbox_token cookie (browsers, set by POST /login). When no token
// is configured the server is open, which is only safe for local or
// single tenant dogfood use. The comparison is done on SHA-256 hashes
// with timingSafeEqual so the raw token never leaks through timing.

import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { formatScope } from "./display.ts";
import { decideReview } from "./review.ts";
import { summarizeReputation, type ReputationSummary } from "./reputation.ts";
import { Store } from "./store.ts";
import type { FeedbackItem, Intent, Passport, ProofPack, ReputationEvent, ReviewDecision } from "./types.ts";

export function reputationView(store: Store): { summaries: ReputationSummary[]; events: ReputationEvent[] } {
  const events = store.list<ReputationEvent>("reputation");
  const passports = store.list<Passport>("passports");
  const agentIdByPassport = new Map(passports.map((p) => [p.id, p.agentId]));
  const sorted = [...events].sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id));
  return { summaries: summarizeReputation(events, agentIdByPassport), events: sorted };
}

export function renderReputationSection(store: Store): string {
  const { summaries, events } = reputationView(store);
  const parts: string[] = [];
  parts.push("<section><h2>Reputation ledger</h2>");
  if (!summaries.length) {
    parts.push("<p>No reputation events recorded yet.</p>");
  } else {
    parts.push("<ul>");
    for (const s of summaries) {
      const rate = s.acceptanceRate === null ? "n/a" : `${Math.round(s.acceptanceRate * 100)}%`;
      parts.push(
        `<li>passport <code>${escapeHtml(s.passportId)}</code>${s.agentId ? ` agent ${escapeHtml(s.agentId)}` : ""}: ` +
          `${s.total} event(s), accepted ${s.accepted}, rejected ${s.rejected}, rework requested ${s.reworkRequested}, ` +
          `acceptance rate ${rate}, last ${escapeHtml(s.lastOutcome ?? "none")} at ${escapeHtml(s.lastAt ?? "never")}</li>`,
      );
    }
    parts.push("</ul>");
    parts.push("<ul>");
    for (const ev of events.slice(0, 20)) {
      parts.push(
        `<li>${escapeHtml(ev.at)} ${escapeHtml(ev.outcome)} passport <code>${escapeHtml(ev.passportId)}</code> ` +
          `pack <code>${escapeHtml(ev.proofPackId)}</code> decision <code>${escapeHtml(ev.decisionId)}</code></li>`,
      );
    }
    parts.push("</ul>");
  }
  parts.push("</section>");
  return parts.join("\n");
}

export function renderPassportsSection(store: Store): string {
  const passports = store.list<Passport>("passports");
  const parts: string[] = [];
  parts.push("<section><h2>Passports</h2>");
  if (!passports.length) {
    parts.push("<p>No passports issued yet.</p>");
  } else {
    parts.push("<ul>");
    for (const p of passports) {
      const scopes = p.scopes.map((s) => escapeHtml(formatScope(s))).join(", ");
      parts.push(
        `<li>passport <code>${escapeHtml(p.id)}</code> agent ${escapeHtml(p.agentId)} owner ${escapeHtml(p.humanOwner)} ` +
          `status ${escapeHtml(p.status)} scopes: ${scopes}</li>`,
      );
    }
    parts.push("</ul>");
  }
  parts.push("</section>");
  return parts.join("\n");
}

export function pendingPacks(store: Store): ProofPack[] {
  const decisions = store.list<ReviewDecision>("decisions");
  const decided = new Set(decisions.map((d) => d.proofPackId));
  return store.list<ProofPack>("proofpacks").filter((p) => !decided.has(p.id));
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function verdictCounts(pack: ProofPack): Record<string, number> {
  return pack.checks.reduce<Record<string, number>>(
    (acc, c) => ({ ...acc, [c.verdict]: (acc[c.verdict] ?? 0) + 1 }),
    {},
  );
}

export function renderInboxHtml(store: Store): string {
  const pending = pendingPacks(store);
  const parts: string[] = [];
  parts.push("<!doctype html>");
  parts.push('<html lang="en"><head><meta charset="utf-8">');
  parts.push("<title>anh review inbox</title>");
  parts.push(
    "<style>body{font-family:system-ui,sans-serif;margin:2rem;max-width:60rem}" +
      "article{border:1px solid #8884;border-radius:8px;padding:1rem;margin:1rem 0}" +
      ".PASS{color:#137333}.FAIL{color:#b3261e}.UNKNOWN{color:#8a6d00}" +
      "code{background:#8882;padding:0 .3em;border-radius:4px}label{display:block;margin:.4rem 0}" +
      "textarea,input,select{width:100%;max-width:32rem}</style>",
  );
  parts.push("</head><body>");
  parts.push("<h1>anh review inbox</h1>");
  parts.push(`<p>${pending.length} proof pack(s) awaiting review. No proof, no review queue.</p>`);
  if (!pending.length) parts.push("<p>Inbox empty.</p>");
  for (const pack of pending) {
    const intent = store.load<Intent>("intents", pack.intentId);
    const counts = verdictCounts(pack);
    parts.push(`<article data-pack="${escapeHtml(pack.id)}">`);
    parts.push(`<h2>${escapeHtml(intent ? intent.goal : "unknown intent")}</h2>`);
    parts.push(
      `<p>pack <code>${escapeHtml(pack.id)}</code> intent <code>${escapeHtml(pack.intentId)}</code> ` +
        `passport <code>${escapeHtml(pack.passportId)}</code> head <code>${escapeHtml(pack.headSha.slice(0, 10))}</code>` +
        `${intent && intent.repo ? ` repo <code>${escapeHtml(intent.repo)}</code>` : ""}</p>`,
    );
    parts.push(
      `<p>verdicts: PASS ${counts.PASS ?? 0}, FAIL ${counts.FAIL ?? 0}, UNKNOWN ${counts.UNKNOWN ?? 0}</p>`,
    );
    parts.push("<ul>");
    for (const c of pack.checks) {
      parts.push(
        `<li><span class="${c.verdict}">${escapeHtml(c.verdict)}</span> ${escapeHtml(c.name)}: ${escapeHtml(c.detail)}</li>`,
      );
    }
    parts.push("</ul>");
    parts.push(
      `<p>risk flags: ${pack.riskFlags.length ? escapeHtml(pack.riskFlags.join(", ")) : "none"}</p>`,
    );
    parts.push(
      `<p>changed files: ${pack.changedFiles.length ? escapeHtml(pack.changedFiles.join(", ")) : "none"}</p>`,
    );
    parts.push(`<p>diff: ${escapeHtml(pack.diffSummary)}</p>`);
    parts.push(`<p>content hash: <code>${escapeHtml(pack.contentHash)}</code></p>`);
    parts.push('<form method="post" action="/review">');
    parts.push(`<input type="hidden" name="pack" value="${escapeHtml(pack.id)}">`);
    parts.push('<label>Reviewer <input name="reviewer" required></label>');
    parts.push(
      '<label>Decision <select name="decision">' +
        '<option value="approve">approve</option>' +
        '<option value="reject">reject</option>' +
        '<option value="changes">changes</option></select></label>',
    );
    parts.push(
      '<label>Feedback, one per line as category:message (required for changes) ' +
        '<textarea name="feedback" rows="3"></textarea></label>',
    );
    parts.push('<button type="submit">Record decision</button>');
    parts.push("</form>");
    parts.push("</article>");
  }
  parts.push(renderPassportsSection(store));
  parts.push(renderReputationSection(store));
  parts.push('<p><a href="/reputation">Reputation ledger as JSON</a></p>');
  parts.push("</body></html>");
  return parts.join("\n");
}

function parseFeedback(text: string): FeedbackItem[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const idx = l.indexOf(":");
      if (idx < 0) throw new Error(`feedback line must be "category:message", got: ${l}`);
      return { category: l.slice(0, idx).trim(), message: l.slice(idx + 1).trim() };
    });
}

function tokenMatches(candidate: string, expectedHash: Buffer): boolean {
  const digest = createHash("sha256").update(candidate).digest();
  return timingSafeEqual(digest, expectedHash);
}

function presentedToken(req: IncomingMessage): string | null {
  const auth = req.headers.authorization;
  if (auth && auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  const cookie = req.headers.cookie ?? "";
  for (const part of cookie.split(";")) {
    const idx = part.indexOf("=");
    if (idx > 0 && part.slice(0, idx).trim() === "anh_inbox_token") {
      return decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return null;
}

function renderLoginHtml(error: string = ""): string {
  return (
    "<!doctype html><html><body><h1>anh review inbox</h1>" +
    (error ? `<p>${escapeHtml(error)}</p>` : "") +
    "<p>This inbox requires its access token.</p>" +
    '<form method="post" action="/login"><label>Token <input type="password" name="token" required></label> ' +
    '<button type="submit">Open inbox</button></form></body></html>'
  );
}

export function startServer(
  workspace: string,
  port: number,
  opts: { inboxToken?: string } = {},
): Server {
  const store = new Store(workspace);
  const configured = opts.inboxToken ?? process.env.ANH_INBOX_TOKEN ?? "";
  const expectedHash = configured
    ? createHash("sha256").update(configured).digest()
    : null;
  const authorized = (req: IncomingMessage): boolean => {
    if (!expectedHash) return true;
    const presented = presentedToken(req);
    return presented !== null && tokenMatches(presented, expectedHash);
  };
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && url.pathname === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, service: "agent-native-github", authRequired: expectedHash !== null }));
      return;
    }
    if (req.method === "POST" && url.pathname === "/login") {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const params = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
        const candidate = params.get("token") ?? "";
        if (expectedHash && tokenMatches(candidate, expectedHash)) {
          res.writeHead(303, {
            location: "/",
            "set-cookie": `anh_inbox_token=${encodeURIComponent(candidate)}; HttpOnly; SameSite=Strict; Path=/`,
          });
          res.end();
        } else {
          res.writeHead(401, { "content-type": "text/html; charset=utf-8" });
          res.end(renderLoginHtml("That token did not match."));
        }
      });
      return;
    }
    if (!authorized(req)) {
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/inbox.html")) {
        res.writeHead(401, { "content-type": "text/html; charset=utf-8" });
        res.end(renderLoginHtml());
      } else {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized: inbox token required" }));
      }
      return;
    }
    if (req.method === "GET" && url.pathname === "/reputation") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(reputationView(store), null, 2));
      return;
    }
    if (req.method === "GET" && url.pathname === "/inbox") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ pending: pendingPacks(store) }, null, 2));
      return;
    }
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/inbox.html")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(renderInboxHtml(store));
      return;
    }
    if (req.method === "POST" && url.pathname === "/review") {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        try {
          const params = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
          const packId = params.get("pack") ?? "";
          const reviewer = params.get("reviewer") ?? "";
          const decision = params.get("decision") ?? "";
          if (!["approve", "reject", "changes"].includes(decision)) {
            throw new Error(`decision must be approve, reject, or changes, got: ${decision}`);
          }
          const result = decideReview(store, {
            packId,
            decision: decision as ReviewDecision["decision"],
            reviewer,
            feedback: parseFeedback(params.get("feedback") ?? ""),
          });
          console.log(
            `web review: ${result.decision.decision} on ${packId} by ${reviewer}, reputation ${result.reputationEvent.outcome}`,
          );
          res.writeHead(303, { location: "/" });
          res.end();
        } catch (e) {
          res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
          res.end(
            `<!doctype html><html><body><h1>decision not recorded</h1><p>${escapeHtml(e instanceof Error ? e.message : String(e))}</p><p><a href="/">back to inbox</a></p></body></html>`,
          );
        }
      });
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
  server.listen(port, () => {
    console.log(
      `agent-native-github service listening on port ${port} (inbox auth ${expectedHash ? "required" : "not configured"})`,
    );
  });
  return server;
}
