# Dogfooding plan: anh runs our own work first

Starting 2026-11-19, 8:00 AM PT, the first real users of anh are our own
agents working on Rene's own projects. No external users until the loop
below has run clean on real work.

## Who gets a passport

One passport per agent identity, each tied to Rene as human owner, scoped
as narrowly as the work allows:

- **Tree** (this agent, main lane): scopes on the repos it actually works,
  propose rights by default, merge only where Rene has already granted
  standing merge authority. Time limit per workroom day, spend limit set.
- **Antigravity** (on the Razer, working the Xod project): its own
  passport, scoped to the Xod repo paths it touches, propose only. Its
  work enters the same review inbox as everyone else's. No side channel.
- **Xod itself** (the product's built-in agent): a passport like any
  other agent. Xod does not get special trust because it is ours; its
  proof packs gate its PRs the same way.

Passports are issued with `anh passport create`, tokens with
`anh token issue`. Tokens are shown once and kept out of every file,
log, and chat. Guarded runs set ANH_REQUIRE_TOKEN=1.

## How work flows

1. Work starts as an **intent** filed against a real project: Xod,
   Greenlight, or anh itself. Goal plus testable acceptance criteria,
   forbidden areas named up front.
2. The agent claims the intent with its passport. Out of scope, expired,
   or over limit passports are rejected by enforcement, and that
   rejection is a filed friction item, not something to route around.
3. The agent works in a **workroom**: a real git worktree and branch,
   nothing edited in a shared checkout.
4. Before anything is proposed, the agent bundles a **proof pack**:
   diff, testdelta, reprocheck, cidiff and shipcheck where a GitHub slug
   exists. UNKNOWN verdicts stay UNKNOWN and are reviewed as unknowns.
5. `anh pr sync` opens or updates the GitHub PR with the proof pack
   attached, once gh auth is available on the working machine. Until
   then sync records UNKNOWN with the reason, and the PR is opened by
   the existing campaign route with the pack pasted in.
6. A human (Rene, or Tree under his standing rules) decides in the
   **review inbox**: approve, reject, or changes with structured
   feedback. Every decision writes a reputation event on the passport.

## The feedback loop

Every friction found while dogfooding becomes a filed intent against
this project itself, in the same system:

- an enforcement rejection that should have passed,
- a gate verdict that was wrong, missing, or unreadable,
- a missing CLI verb, a confusing error, a slow step,
- a proof pack field a reviewer needed and did not have,
- an inbox screen that took more than two minutes to decide from.

Rule: if it slowed real work down, it is an intent with acceptance
criteria, not a note in a chat. The anh backlog is anh's own inbox.

## First day checklist (from 8:00 AM PT)

- Issue passports for Tree, Antigravity, and Xod; record ids in the
  lane notes, tokens nowhere.
- File the first intents against Xod and Greenlight from their real
  backlogs.
- Run one full loop per agent: intent, claim, workroom, commit, proof
  pack, review decision.
- File every friction item hit during those loops as intents on anh.
- Report to Rene: packs bundled, verdicts by check, decisions made,
  friction intents filed. Numbers from the store, not from memory.

## What success looks like

- Agent PRs on Rene's own repos carry proof packs a reviewer can decide
  on in about two minutes.
- Zero agent work lands without a pack, including Xod's own changes.
- The anh backlog is mostly dogfood friction intents, which means the
  loop is feeding itself.
