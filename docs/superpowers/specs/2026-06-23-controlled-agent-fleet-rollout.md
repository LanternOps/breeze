# Controlled Agent Fleet Rollout

**Date:** 2026-06-23
**Status:** Implemented
**Branch:** `feat/controlled-agent-fleet-rollout`

## Problem

`apps/api/src/services/binarySync.ts` (both the local-binary path and the GitHub
path, the demote+upsert block) unconditionally demotes the current
`agent_versions.isLatest` rows and promotes the newest version to
`isLatest=true`. `apps/api/src/routes/agents/heartbeat.ts` then offers every
agent `upgradeTo=<isLatest>`. So publishing a release = instant uncontrolled
fleet update. Fix: make promotion explicit.

## Design

### 1. Config flag `AGENT_AUTO_PROMOTE`

Boolean, **default TRUE** (preserves current self-host behavior).

- Validation/parsing in `apps/api/src/config/validate.ts` next to
  `BINARY_SOURCE`/`IS_HOSTED` (boolean-format check in all environments so a
  typo is caught at boot rather than silently parsing to a surprising default).
- Runtime getter `getAgentAutoPromote(): boolean` in
  `apps/api/src/services/binarySource.ts` next to `getBinarySource()`, reading
  the env, default true.

### 2. binarySync — gate promotion, never registration

In BOTH the local-binary path and the GitHub path (`upsertVersion`):

- When `getAgentAutoPromote() === true`: behavior UNCHANGED (byte-for-byte
  equivalent to today — demote old `isLatest`, upsert with `isLatest:true`).
- When false: do NOT run the "demote existing isLatest" UPDATE; upsert the
  binary with `isLatest:false`; in the `onConflictDoUpdate.set`, update
  downloadUrl/checksum/fileSize/manifest fields but OMIT `isLatest` entirely
  (never touch it). Net: new binaries downloadable, current target unchanged
  until explicit promote.

### 3. Promote endpoint

`apps/api/src/routes/agentVersions.ts`, platform-admin-only (reuse
`apps/api/src/middleware/platformAdmin.ts`).

- `POST /api/v1/agent-versions/promote` body
  `{ version: string, component?: 'agent'|'helper'|'user-helper'|'watchdog'|'viewer' }`.
  Omitting `component` promotes ALL components of that version.
- Single transaction: per affected (component, platform, architecture), demote
  current `isLatest=true` rows, then set `isLatest=true` for the target
  version's rows. 404 if the version has no registered rows (for the requested
  component). Audit-logged (`agent_version.promote`, resourceName=version,
  details=components/counts/prior demoted target). Returns promoted rows + the
  prior demoted target.
- `GET /api/v1/agent-versions` — platform-admin list of registered versions and
  which is currently promoted per component/platform/arch.

### 4. Heartbeat / org agent-update policy

Unchanged. Heartbeat continues to offer `upgradeTo` based on `isLatest=true`;
gating an un-promoted version is achieved purely by NOT setting `isLatest` on it.

### 5. Migration

None — `is_latest` already exists on `agent_versions`.

## Ops note

To enable controlled rollout on the EU + US droplets:

1. Set `AGENT_AUTO_PROMOTE=false` in `/opt/breeze/.env`.
2. Map it explicitly in the `api` service `environment:` block of
   `/opt/breeze/docker-compose.yml` (compose interpolation only happens for
   listed vars — value in `.env` is necessary but not sufficient).
3. New runbook step: after a release is registered (binarySync / `sync-github`),
   verify the new version on a canary, then **promote** it with
   `POST /api/v1/agent-versions/promote { "version": "<x.y.z>" }` (platform
   admin). Until promoted, the fleet stays on the prior target.

Leaving `AGENT_AUTO_PROMOTE` unset/true preserves today's behavior (sync =
instant fleet upgrade target), so self-host deploys are unaffected.
