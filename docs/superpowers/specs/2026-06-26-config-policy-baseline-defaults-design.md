# Design: Virtual Baseline "Breeze Defaults" for Configuration Policies

**Issue:** [#1725 — Ship a default/baseline Configuration Policy that surfaces all out-of-the-box defaults](https://github.com/LanternOps/breeze/issues/1725)
**Date:** 2026-06-26
**Status:** Approved (design)

## Goal

When any tenant — a fresh install, or an existing one after upgrade — opens Configuration
Policies, they should see a **"Breeze Defaults"** entry that honestly shows *how their
devices behave out of the box with nothing configured*. To change any of it, they create
their own policy, which overrides the baseline through the normal assignment hierarchy. The
baseline is never edited, so every install shows the same truthful baseline and the only
thing that diverges device behavior is policies the admin deliberately added.

This closes the motivating gap from the issue: today, with no policy assigned, Remote
Desktop / VNC / Remote Tools are **ON** and nothing in the UI explains it. An admin has no
way to discover "what is Breeze doing to my devices right now if I haven't configured
anything?"

## Decisions (resolved during brainstorming)

| Fork | Decision |
|---|---|
| Mechanism | **Virtual baseline** — synthetic lowest-precedence layer derived from a canonical defaults module. No DB rows, no per-tenant backfill. Upgrade case is free. |
| Editability | **Read-only.** Editing a default deep-links into creating a real override policy; the baseline is never mutated. |
| Scope | **Config-policy feature types only** (the 17 in `configFeatureTypeEnum`). Out-of-band tenant defaults (AI, SSO, portal, OneDrive) deferred. |
| Semantics | **Runtime behavior** — what actually happens to an unassigned device (mostly "Not enforced", `remote_access` ON), not aspirational form-fill values. |
| Source of truth | **Single canonical module.** `remoteAccessPolicy.ts` and `pamSettings.ts` import their applied defaults from it (satisfies AC#1, no duplication). |
| UI | Baseline node in the per-device effective-config view **+** a dedicated read-only "Breeze Defaults" page with per-feature "Create override" actions. |

## Semantics: what "baseline" means per feature

The baseline represents the **runtime behavior of an unassigned device** — the truth, not
the values a new feature link would pre-fill with. For each feature type:

- `remote_access` → live permissive defaults (Remote Desktop / VNC / Remote Tools **ON**,
  `clipboardHostToViewer = !isHosted`, `clipboardViewerToHost` ON, proxy ON,
  `maxConcurrentTunnels` 5, idle 5 min, max session 8 hr).
- `pam` → `uacInterceptionEnabled: false` (UAC interception is **off / opt-in** — this
  corrects the issue's stale "ON by default" claim; the file was edited after the audit).
- Every other feature type (`patch`, `alert_rule`, `backup`, `security`, `monitoring`,
  `maintenance`, `compliance`, `automation`, `event_log`, `software_policy`,
  `sensitive_data`, `peripheral_control`, `warranty`, `helper`, `onedrive_helper`) →
  **"Not enforced"**, with a one-line description of the real-world effect (e.g. "No
  patching is performed", "No alerts fire").

> Verified during brainstorming: per-feature resolvers in `featureConfigResolver.ts`
> return `null`/`[]` on the no-policy path for all feature types **except** `remote_access`
> (and `pam`), which carry hard-coded applied defaults. So "Not enforced" is the honest
> baseline for the rest.

## Architecture

### 1. Canonical defaults module (single source of truth)

New file: **`apps/api/src/services/policyBaselineDefaults.ts`**

```ts
import type { ConfigFeatureType } from './configurationPolicy';
import type { RemoteAccessSettings } from './remoteAccessPolicy';

export type BaselineEntry = {
  /** Does anything actually apply to an unassigned device? */
  applied: boolean;
  /** Resolved settings when applied (remote_access / pam); null when "Not enforced". */
  inlineSettings: Record<string, unknown> | null;
  /** Human-readable behavior label for the UI. */
  behavior: string;
};

/** Env-dependent (isHosted) — computed, not a frozen const. */
export function getRemoteAccessBaseline(): RemoteAccessSettings;

/** Covers every member of configFeatureTypeEnum. Guarded by a contract test. */
export const POLICY_BASELINE_DEFAULTS: Record<ConfigFeatureType, BaselineEntry>;
```

- `remoteAccessPolicy.ts` deletes its inline `DEFAULTS` const and sources it from
  `getRemoteAccessBaseline()`. It keeps its own `clampSettings` / cache / Zod-validation
  logic unchanged.
- `pamSettings.ts` deletes its inline `PAM_DEFAULTS` and imports from the module.
- The module's `remote_access` and `pam` entries derive their `inlineSettings` from the same
  source the enforcement path uses, so display and runtime can never drift.

### 2. Resolver integration (opt-in, low blast radius)

`resolveEffectiveConfig(deviceId, auth, opts?)` in `configurationPolicy.ts` gains
`opts.includeBaseline` (default **`false`**):

- **`false`** (all existing callers — per-feature resolvers, `resolveRemoteAccessForDevice`):
  behavior is **unchanged**. The `features` map still contains only real winners.
- **`true`** (only the effective-config endpoint): for every feature type with no winning
  row, append a synthetic `ResolvedFeature` and an `inheritanceChain` node with
  `sourceLevel: 'default'`, `sourcePolicyName: 'Breeze Defaults'`, settings drawn from the
  canonical module.

`ResolvedFeature.sourceLevel` and the inheritance-chain level type widen to
`ConfigAssignmentLevel | 'default'`. **`ConfigAssignmentLevel` itself is NOT changed** — you
still cannot *assign* at `'default'`, so the assignment API, validators, and DB enum are
untouched. The synthetic layer is purely a resolution/display concept.

This opt-in shape is deliberate: it guarantees the existing per-feature resolvers (which
read `effective.features.<type>` and treat absence as "not enforced") keep working exactly
as before.

### 3. API surface

- `GET /configuration-policies/effective/:deviceId` passes `includeBaseline: true` so the
  response shows the baseline as the bottom of the inheritance chain.
- **New:** `GET /configuration-policies/baseline` → returns the full
  `POLICY_BASELINE_DEFAULTS` registry for the dedicated page. Read-only; returns no tenant
  data (static shipped defaults), so no RLS surface is added. Auth required (any
  authenticated user with config-policy read access).

### 4. Web UI

- **Effective-config / resolution view (per device):** render the `'default'` node at the
  bottom of the inheritance chain, labeled "Breeze Defaults", visually distinct
  (muted / read-only). A previously unexplained value now reads "Remote Desktop: ON —
  Breeze Defaults".
- **New read-only "Breeze Defaults" page** under Configuration Policies: lists every feature
  type with its baseline value + behavior label. Each row has a **"Create override policy"**
  action that deep-links into policy creation pre-seeded with that feature type. There is no
  inline editing anywhere — the only way to change behavior is to create a real policy.

## Testing

- **Contract test:** `POLICY_BASELINE_DEFAULTS` has an entry for every member of
  `configFeatureTypeEnum`. Fails when a new feature type is added without a baseline entry
  (same spirit as the RLS allowlist drift guards).
- **Resolver unit test:** unassigned device with `includeBaseline: true` returns
  `remote_access` ON via `sourceLevel: 'default'`; a feature *with* an assigned policy still
  wins over the baseline; `includeBaseline` omitted ⇒ `features` map identical to today.
- **Regression test (security-sensitive):** `resolveRemoteAccessForDevice` still returns the
  permissive defaults after sourcing `DEFAULTS` from the canonical module — the applied
  defaults must not flip. (Hardening/refactor PRs are the most common source of regressions;
  this path gates remote-session access.)
- **Web component tests:** Breeze Defaults page renders all feature rows + "Create override"
  actions; effective-config view renders the baseline node at the bottom of the chain.

## Out of scope (deferred follow-ups)

- **Out-of-band tenant defaults** that don't flow through the config-policy resolver:
  AI-enabled (`ai.ts`), SSO JIT auto-provisioning (`sso.ts`), public customer portal
  (`portal.ts`), OneDrive KFM silent opt-in (`onedriveHelper.ts`). These are arguably the
  most surprising defaults, but surfacing them is a separate, larger lift (they have no
  resolver to hook). Noted for a future issue.
- **Editable baseline** and **seeded per-partner rows** — explicitly rejected in favor of
  the read-only virtual layer.
- Consolidating the **form-fill / schema column defaults** (the "(b)" values a new feature
  link pre-fills with) into the canonical module. Not needed for runtime-behavior
  semantics; could be a later enhancement if we ever want a "recommended baseline" view.

## Related work: #1854 (kept separate)

[#1854 — Multiple Configuration Policy Features Not Functioning as Expected](https://github.com/LanternOps/breeze/issues/1854)
is a distinct class of problem: eight *enforcement* bugs ("I configured X and the device
ignored it") spread across the alert/monitoring/automation workers (the automation case logs
an RLS error), the Go agent (peripheral control, helper config propagation, PAM UAC
interception), and the compliance UI. It shares no code with this work and is tracked as its
own systematic-debugging track.

**Synergy worth noting:** the effective-config view built here is the diagnostic tool a user
in #1854's situation needs. If a feature resolves to `source = Breeze Defaults (Not
enforced)` despite the admin having assigned a policy, that points at an
assignment/resolution failure rather than a broken worker — narrowing #1854 triage. This
spec does **not** fix any #1854 enforcement bug.

## Acceptance criteria mapping (from #1725)

- [x] Canonical single-source-of-truth defaults module → `policyBaselineDefaults.ts`;
  `remoteAccessPolicy.ts` / `pamSettings.ts` import from it.
- [x] Config-policy UI shows a baseline "Breeze Defaults" as the bottom of the hierarchy →
  dedicated page + inheritance-chain node.
- [x] Effective-config for an unassigned device shows the baseline as explicit source →
  `sourceLevel: 'default'` via `includeBaseline`.
- [x] Every config-policy default represented and labeled → registry covers all 17 types,
  contract-tested.
- [x] Decision recorded for editable-vs-read-only and retroactive edits → read-only,
  edits create real overrides, baseline never mutates.
- [x] Remote-access ON-by-default surfaced and explained → primary motivating gap closed.
- [~] "Broader tenant defaults" (AI/SSO/portal/OneDrive) → **deferred** (documented above).
