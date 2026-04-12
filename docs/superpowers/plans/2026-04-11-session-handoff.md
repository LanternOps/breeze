# Session handoff — first-customers triage (2026-04-11)

You are picking up after a multi-hour production triage session that was kicked
off by reviewing activity from the first real paying signups on `us.2breeze.app`
and `eu.2breeze.app`. Read this first, then read
`docs/superpowers/plans/2026-04-11-first-customers-triage-followups.md` for the
complete state of what shipped and what's still open. This doc is just
orientation.

## Where things stand

**Issue #387 — CLOSED.** Full 7-layer fix for the agent desktop-helper reconnect
storm on headless Windows Server shipped via two PRs:

- **PR #388** (squash `ac5612c5`) — Parts A–F: reconnect hardening, Windows
  binary path fix, SID retry, explicit pre-auth rejections, fatal-exit plumbing,
  lifecycle cooldown. 29 new tests.
- **PR #389** (squash `64d51ad0`) — Part G: heartbeat watchdog, `timedRWMutex`
  with wait+hold instrumentation, atomic `sessionSnapshot` refactor. 9 new tests.
  `~157 ns/op` hot-path reads under 10-goroutine write-storm.

**`breeze-billing` — two critical prod fixes shipped.** Stripe API version
`2026-03-25.dahlia` broke `customer.subscription.updated` (subscription period
fields moved to `items.data[0]`). Also, the US region had never had a webhook
endpoint registered at all — silent failure waiting for the first US payment.
Both fixed. See the tracking doc for detail.

**EU prod — cleaned.** 10 synthetic `@breeze.local` test partners hard-deleted
in a single transaction. Real partners preserved.

## Immediate next moves (user chooses, roughly priority-ordered)

1. **`file_list` / `file_list_drives` command timeout investigation. — DONE.**
   Investigated against EU prod logs. Root cause was **client-side DNS
   flakiness** on the customer's Win11 box: her local resolver logged 9×
   `dial tcp: lookup eu.2breeze.app: no such host` in the 37 min before her
   click. No other EU device saw a single DNS failure in the same window;
   `eu.2breeze.app` resolves fine via 1.1.1.1 / 8.8.8.8 / 9.9.9.9. The agent
   was unreachable at the moment she clicked, the API still considered her
   device `online` (offline threshold not yet crossed), so the commands were
   queued and timed out (15 s / 30 s) with a misleading "device may be
   offline" message.

   The pre-existing `sessionbroker: auth missing SID on Windows` warnings
   firing every 30 s on her device are real but **unrelated** — the file_list
   handler is a trivial sync call that doesn't touch the broker, and #387's
   SID retry fix was committed 4 hours **after** her timeout anyway (her
   agent 0.62.11 doesn't have it).

   Three secondary product issues filed as **issue #391**:
   - File browser routes return generic "device may be offline" on any
     failure — should distinguish timeout vs offline.
   - `executeCommand` accepts commands for devices whose WS is actually dead
     because `devices.status='online'` lags by the offline-threshold window.
     Should pre-check live WS for interactive commands.
   - `sendCommandToAgent` failure releases the claim and waits for the full
     15–30 s timeout. Should retry 3× 500 ms before giving up.

2. **Systemic test infrastructure** (tracking doc: "Open — not yet scheduled").
   Highest leverage for preventing the next class of bugs:
   - Synthetic customer-journey nightly test (signup → Stripe test-mode → webhook → activation)
   - Headless Windows pre-launch matrix (would have caught #387 before prod)
   - `breeze-billing` CI grep for deprecated Stripe fields on SDK bumps
   - Agent log-storm protection (generalize `helperWarnLimiter` across all log sites)
   - Customer onboarding watcher (pending >24h → email operator)

3. **Implement issue #391** (file browser timeout UX). Three changes scoped
   in the issue body. Good "ship a real customer-facing improvement in one
   PR" candidate.

4. **Deferred PR #388 review suggestions.** Type-design polish. Low urgency,
   good for a quiet session. See the "Deferred" section in the tracker.

The user's original session backlog (abandoned-cart recovery worker, region
picker UX on `breezermm.com`) are both now DONE and crossed off.

## Non-obvious facts

- **`breeze-billing` is a separate repo** at `/Users/toddhebebrand/breeze-billing`.
  The main `breeze` repo is open-source and billing code is intentionally
  excluded. Don't grep for billing logic in the main repo.
- **`agent/` vs `apps/agent/`**: the real Go agent source is `agent/`, NOT
  `apps/agent/`. Both directories exist but `apps/agent/` is unrelated.
- **Customer data anonymization rule**: GitHub issues, PR descriptions, and
  public-repo docs must be scrubbed of customer identifiers (names, emails,
  partner IDs, hostnames). Internal tracking docs under
  `docs/superpowers/plans/` can use generic descriptors ("a paying customer")
  but avoid real names. This is hard-learned — I once put customer details in
  issue #387 and had to scrub them.
- **Prod DB access is firewall-gated per-droplet.** To query the managed
  Postgres from your laptop, you need to temporarily add your IP to the
  cluster's trusted sources, then remove it when done. Pattern:
  ```bash
  doctl databases firewalls append <cluster-id> --rule "ip_addr:$(curl -s ifconfig.me)"
  # do your work via docker exec -i breeze-postgres psql "postgresql://doadmin:..."
  doctl databases firewalls remove <cluster-id> --uuid <rule-uuid>
  ```
  Cluster IDs:
  - EU: `8fd25532-1a21-4a37-89b8-7a2713eb7046` (fra1)
  - US: `730d4ce4-f883-4c64-8e28-8b572195daa9` (sfo3)
- **Stripe API access** lives in the `breeze-billing` container on the `breeze-us`
  droplet (`root@143.198.144.173`). Exec into `breeze-billing` and the live
  Stripe secret is in env; can run inline Node scripts for one-off queries.
- **Production has exactly TWO paying customers as of 2026-04-11.** Everything
  is high-signal. One-off bugs affect individual customers directly, and any
  prod operation should assume someone is actively watching.

## Tool reminders for new agent

- **`gh`** for GitHub (PRs, issues, reviews, comments)
- **`doctl`** for DigitalOcean (databases, droplets, firewalls, domains)
- **`Agent` tool** for delegation — use `isolation: "worktree"` for implementation
  work so changes don't pollute the main checkout. Use `model: sonnet` for most
  tasks; upgrade to `opus` when a real design decision is involved
  (e.g., concurrency primitives, API shape choices)
- **Memory system** at `~/.claude/projects/-Users-toddhebebrand-breeze/memory/`
  already has useful entries about agent architecture, session broker, macOS
  permissions, etc. Check `MEMORY.md` before re-discovering things
- **`CLAUDE.md`** in the repo root has project conventions (schema migrations,
  tests, docker compose modes, codex delegation patterns, PR merge process)
- **Use TodoWrite** (TaskCreate/TaskUpdate) for multi-step work so the user can
  see progress and the work survives context compression

## Merge workflow reminder

Branch protection on this repo is enforced but the owner uses `--admin` to
bypass. Pattern:
```bash
gh pr ready <N> --repo LanternOps/breeze
gh pr merge <N> --repo LanternOps/breeze --squash --admin
```
Merge commits are disabled — always use `--squash`. Never force-push main.

## One gotcha from this session

Worktrees created from a locally-ahead `main` inherit the local extra commits.
PR #388's branch accidentally picked up 4 unrelated commits from my local state
because `main` had diverged from `origin/main`. The fix was a temp-worktree
rebase `--onto origin/main`, dropping the extras, force-pushing, then merging.
If you start work from a worktree and see unexpected files in the PR diff, this
is probably why — check `git log --oneline origin/main..HEAD` and rebase.

---

**Suggested first message to a new session:**

> Read `docs/superpowers/plans/2026-04-11-session-handoff.md` and
> `docs/superpowers/plans/2026-04-11-first-customers-triage-followups.md`, then
> tell me what's open and what you'd recommend tackling first.
