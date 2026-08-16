# Recidivist-endpoint detection — design

**Status:** proposed
**Date:** 2026-08-14
**Author:** abuse-signal round, 2026-08-14
**Supersedes nothing. Extends:** `2026-07-11-signup-abuse-detection-design.md`

## Problem

An operator whose partner account is suspended re-registers and re-enrols **the
same endpoints** under a fresh account. Every detector we ship today is blind to
this, because each one scores a partner against *its own* devices, scripts, or
card in isolation. Nothing correlates a new partner against the corpus of
already-suspended ones.

This is not hypothetical and it is not rare. It is the single most repeated shape
in our incident history:

| Date | Old (suspended) | New | How it was found |
|---|---|---|---|
| 2026-08-05 | Milofsky | palletessencehub | shared ScreenConnect thumbprint, by hand |
| 2026-08-11 | Remon Sino | Tua Tops | shared ScreenConnect thumbprint, by hand |
| 2026-08-14 | SSo (08-03) | zby | shared thumbprint **and** hostname **and** IP, by hand |

In the 2026-08-14 case the operator re-enrolled the *identical victim machine*
— hostname `DESKTOP-OK9NTO7`, egress `107.147.228.141`, ScreenConnect instance
`3a1a6364add6e7bb` — ten days after SSo was contained. The only signal that
fired was `rmm.session_intensity` at score 65 (`watch`), which is **below the
alert threshold and was never delivered**. We learned about it only because a
human ran the correlation query manually.

`abuse_screenconnect_thumbprint_correlation` has recorded for weeks that this
query is "decisive both ways; clears FPs AND finds unflagged accounts; still
manual". This spec ends the "still manual".

## Backtest

Run against both prod regions on 2026-08-14, over the entire historical corpus.

**Rule A — shared remote-tool instance fingerprint.** Extract the ScreenConnect
instance GUID from `software_inventory.name` (`ScreenConnect Client (<16 hex>)`)
and join partners on it.

- **US: 10 distinct fingerprints shared across partners.** Every one of the
  resulting pairs is suspended↔suspended: Pluto↔Oneal Studio (×3 fingerprints),
  pluto↔Pluto (×3), sarahcomputersllc↔HillComputerTechLLC, Remon Sino↔Tua Tops,
  cibrum↔palletessencehub, Coastal Titles↔Jzac Legal Group.
- **EU: 1 shared fingerprint** — SSo (suspended) ↔ zby (active). The live case.
- **False positives: zero.** Not one legitimate partner appears anywhere in the
  cross-partner fingerprint set, in either region.

That precision is not luck. A ScreenConnect instance GUID identifies one
*operator-controlled server instance*. Two unrelated MSPs never share one; the
only way the same GUID lands under two partners is that the same operator
planted it.

**Rule B — shared device hostname.** Four cross-partner hostnames total across
both regions: `VM-1128dd88-…` (Coastal Titles↔Jzac Legal, both suspended),
`HY-53494` (Boerum Hill↔King's Highway, both suspended), `DESKTOP-OK9NTO7`
(SSo↔zby), and `DESKTOP-5KPVT1P` (concretcimento [suspended] ↔ **loja do
mecanico [active]**).

The last one is the proof of the "finds unflagged accounts" claim: it surfaced a
surviving sibling of the suspended operator — a login on the *same email domain*
as the suspended account, created 07-02 and never flagged — that the 08-12
containment missed entirely. (The address itself is deliberately not reproduced
here: this repo is public, and `check-customer-pii.sh` blocks real customer
domains. The concrete identifiers live in the incident record.)

**Rule B false positives: zero**, but the sample is small and the mechanism is
weaker than Rule A — see Scoring.

## Design

### New signal: `rmm.recidivist_endpoint`

Fires on partner P when an endpoint identifier observed under P has previously
been observed under a **different** partner that is now non-`active`.

Three evidence axes, scored by strength of the underlying mechanism:

| Axis | Score | Severity | Rationale |
|---|---|---|---|
| `fingerprint` — shared remote-tool instance GUID | **100** | alert | Dispositive. Identifies one operator-controlled server. 10/10 historical pairs true, 0 FP. |
| `hostname_ip` — same hostname **and** same `last_seen_ip`/`enrollment_ip` | **90** | alert | Same physical machine on the same line. |
| `hostname` — same hostname alone | **60** | watch | `DESKTOP-XXXXXXX` has a 7-char random suffix so collisions are unlikely, but generic names (`WIN-…`, `PC`, `SERVER`) collide for real. |
| `ip` — same egress IP alone | **40** | info | CGNAT and shared-office NAT make this weak on its own. Contributes only as a multiplier on the axes above. |

Score is the **max** of the matched axes, not a sum — the axes are correlated
(zby matched all three), and summing would just saturate.

**Age decay does not apply.** The existing `rmm.*` heuristics zero out past
`sweep.young_zero_weight_days` (90d). That is wrong for this signal for the same
reason it is wrong for the content-based signals (`computeScriptSignals` is
already exempt): a resold or re-established account is *more* suspicious when
aged, not less. Follow the `scriptContent.ts` precedent and exempt it.

**Direction matters.** Only fire on the partner that is *currently* active or
pending. A suspended↔suspended pair is history, not a live lead — record it as
evidence on the corpus but do not open a signal row nobody can act on. This
directly avoids the `invariant.inactive_partner_with_agents` noise problem,
where every suspension manufactures a permanent alert on itself.

### Storage: `abuse_endpoint_fingerprints`

A new cross-partner corpus table, modelled exactly on `abuse_script_hosts`
(`2026-07-25-abuse-script-hosts.sql`).

```sql
CREATE TABLE IF NOT EXISTS abuse_endpoint_fingerprints (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id    uuid NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  kind          abuse_endpoint_fingerprint_kind NOT NULL,  -- 'remote_tool_guid' | 'hostname' | 'egress_ip'
  value         varchar(255) NOT NULL,
  device_id     uuid REFERENCES devices(id) ON DELETE SET NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now()
);
```

Unique on `(partner_id, kind, value)`; index on `(kind, value)` for the
correlation join. Forced RLS with a **system-only** policy, identical to
`abuse_script_hosts` — partners must never read the corpus, because it would
reveal what we correlate on.

**Why a table rather than joining `software_inventory` live.** The corpus must
outlive the devices it came from. When a suspended partner's org is erased or
its device rows are cascade-deleted, a live join loses exactly the history the
correlation depends on. `abuse_script_hosts` exists for this precise reason and
its header comment says so: rows "persist independently of partner status". In
the zby case the SSo device rows happened to survive only because the
`self_uninstall` failed and nobody cleaned up — that is luck, not a design we
should depend on. Note the `ON DELETE CASCADE` on `partner_id` still drops the
corpus if the *partner* row is hard-deleted; that is the accepted GDPR-erasure
boundary, same as `abuse_script_hosts`.

### Tenancy registration checklist (new table — do not skip)

Per CLAUDE.md, a new table is not done when RLS passes. `abuse_endpoint_fingerprints`
has **no `org_id`**, which resolves most of the list, but each row must be
consciously answered rather than assumed:

1. RLS enabled + forced + system-only policy **in the creating migration**. ✅ as specced.
2. Register in `rls-coverage.integration.test.ts` — this is a system-scoped
   table, so it belongs with `partner_abuse_signals` / `abuse_script_hosts` in
   whichever allowlist those two use, **not** in a tenant shape.
3. `CORE_ORG_CASCADE_DELETE_ORDER` — **not required**, no `org_id` column.
4. `CORE_DEVICE_CASCADE_DELETE_TABLES` — **required**, the table has a
   `device_id` column. This is the one that will get missed.
5. `CORE_DEVICE_ORG_DENORMALIZED_TABLES` — not required, no denormalised `org_id`.
6. `CORE_TENANT_EXPORT_POLICY` — not required, not in the org-cascade list.

Confirm 2 and 4 against the live allowlists at implementation time; the
device-cascade one fails in the **Test API** unit job, so it will catch itself
if forgotten — the RLS one will not.

### Extraction

Fingerprint extraction runs in the sweep's existing system DB context, alongside
`loadScriptFindings`. Patterns, most-specific first:

- ScreenConnect / ConnectWise Control: `/ScreenConnect Client \(([0-9a-f]{16})\)/`
- LogMeIn Resolve: `/LogMeIn Resolve Endpoint (\d{10,})/` — observed as
  `…Endpoint 7579707059599889961` on the zby victim box. Lower confidence than
  ScreenConnect; treat as `hostname`-tier (60) until backtested.

Start with ScreenConnect only. It is the one with a 10/10 backtest. Adding
patterns later is cheap; shipping an untested pattern at score 100 is not.

## Scope boundaries

**Cross-region correlation is out of scope and stays a known gap.** US and EU
are separate databases; this detector can only correlate within one. zby was
EU-only, but H and S Electric (US) shared the same operator ASN, and the ring
was only visible by running the query twice by hand.
`cross_region_identity_gap_prepositioned_accounts` already tracks this — the
right fix is a shared correlation corpus, which is a much larger piece of work
and should not block this one.

**Rule B (hostname) will eventually produce a false positive.** Golden-image
fleets and MDM-templated names collide legitimately. Mitigations: (a) hostname
alone caps at 60 = `watch`, never `alert`; (b) exclude a small deny-list of
degenerate names (`localhost`, `WIN-`-prefixed default names shorter than 12
chars, empty). Do not attempt to be clever beyond that — the score cap is doing
the real work.

## Verification

1. Unit tests in `heuristics.test.ts` style: each axis, the max-not-sum rule, the
   direction rule (no signal on suspended↔suspended), the age-decay exemption.
2. One integration test against real Postgres that seeds two partners sharing a
   fingerprint, suspends one, runs the sweep, and asserts exactly one signal row
   on the *active* partner at score 100.
3. **Replay the backtest in this document as an integration assertion**: the rule
   must produce zero hits against a corpus of only-active partners.
4. Post-deploy, expect it to immediately fire on any surviving pairs — as of
   2026-08-14 that is `loja do mecanico` (US) via hostname, plus zby (EU) if not
   yet finalised.

## Open questions

- Should `egress_ip` be recorded in the corpus at all given it never fires alone?
  Argument for: it is the cheapest way to raise `hostname` 60 → `hostname_ip` 90.
  Argument against: storing partner egress IPs in a cross-partner corpus is a
  privacy surface we do not otherwise have. **Recommend recording it**, since
  `devices.last_seen_ip` and `partners.signup_ip` already persist the same data
  in less-protected tables.
- Retention. `abuse_script_hosts` has none. A recidivist operator returning after
  12 months is still a recidivist, so indefinite retention is defensible, but it
  should be a deliberate decision rather than an oversight inherited from the
  script-host table.
