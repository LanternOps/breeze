# Self-Host Manifest Signing + Auto-Update Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore agent auto-update for self-hosted deployments using `BINARY_SOURCE=local` (broken in v0.65.8 by #568) by adding per-deployment manifest signing + pinned-key trust delivery, plus three defenses (boot-time self-test, CI smoke test, stuck-fleet recovery hatch) that prevent recurrence.

**Architecture:** API generates an Ed25519 signing keypair on first boot in local-binary mode and stores it encrypted in a new `manifest_signing_keys` table. `syncBinaries` signs every locally-registered manifest with this key. The current public key is delivered to agents via two authenticated channels: enrollment response (new agents) and WS heartbeat response (existing agents, TOFU-pinned). Agents persist pinned keys in `agent.yaml` and merge them with the build-time embedded LanternOps trust root when verifying update manifests. To bootstrap the v0.65.8-stuck fleet that has no pinned-key mechanism, a recovery CLI pushes v0.65.9 binaries over the existing authenticated `dev_update` WS command (extending #615); once on v0.65.9 those agents learn the pinned key via heartbeat and self-heal.

**Tech Stack:** TypeScript (Hono, Drizzle, Vitest), Go (agent updater, viper config, ed25519), Ed25519 signing (Node `crypto` + Go `crypto/ed25519`), Postgres (encrypted column via existing `secretCrypto`).

---

## File Structure

**Created:**
- `apps/api/migrations/2026-05-09-manifest-signing-keys.sql` — `manifest_signing_keys` table
- `apps/api/src/services/manifestSigning.ts` — keypair lifecycle + `signManifest()` + `getActivePublicKeys()`
- `apps/api/src/services/manifestSigning.test.ts` — unit tests
- `apps/api/src/services/binarySync.selftest.ts` — boot-time round-trip self-test
- `apps/api/src/services/binarySync.selftest.test.ts` — unit tests for self-test
- `apps/api/src/db/schema/manifestSigningKeys.ts` — Drizzle schema
- `agent/internal/config/manifestkeys.go` — pinned manifest pubkey persistence helpers
- `agent/internal/config/manifestkeys_test.go` — tests
- `agent/cmd/breeze-rmm/recover_update.go` — admin CLI subcommand `recover-update`
- `agent/cmd/breeze-rmm/recover_update_test.go` — tests
- `.github/workflows/ci-smoke-binary-source-local.yml` — CI smoke test job
- `docs/deploy/agent-update-trust-bootstrap.md` — operator-facing runbook

**Modified:**
- `apps/api/src/services/binarySync.ts` — sign manifests during local-mode upsert
- `apps/api/src/routes/agents.ts` — include `manifestTrustKeys` in enrollment response
- `apps/api/src/routes/agentWs.ts` — include `manifestTrustKeys` in heartbeat response
- `apps/api/src/index.ts` — invoke boot-time self-test after `syncBinaries`
- `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` — allowlist new system-scoped table
- `agent/internal/config/config.go` — add `PinnedManifestPubKeys []string` field
- `agent/internal/updater/updater.go` — `trustedManifestKeys()` reads pinned keys from config
- `agent/internal/heartbeat/heartbeat.go` — TOFU-pin keys delivered in heartbeat response
- `agent/internal/enrollment/enrollment.go` — pin keys delivered in enrollment response
- `RELEASE_NOTES.md` (or release notes mechanism) — v0.65.9 entry

---

## Phase A — API Signing Infrastructure

### Task A1: Migration for `manifest_signing_keys` table

**Files:**
- Create: `apps/api/migrations/2026-05-09-manifest-signing-keys.sql`
- Create: `apps/api/src/db/schema/manifestSigningKeys.ts`
- Modify: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` (allowlist update)

- [ ] **Step 1: Write failing schema-drift test**

The repo's `pnpm db:check-drift` is the contract. Add a Vitest test that imports the new schema and asserts the migration creates a matching table — then run drift check.

Run: `pnpm db:check-drift`

Expected: drift detected (`manifest_signing_keys` defined in schema but missing in migrations).

- [ ] **Step 2: Write the migration**

```sql
-- 2026-05-09-manifest-signing-keys.sql
-- Per-deployment Ed25519 signing key for self-host (BINARY_SOURCE=local)
-- agent update manifests. System-scoped (no tenant column): one key per deployment.

CREATE TABLE IF NOT EXISTS manifest_signing_keys (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key_id          text NOT NULL UNIQUE,                  -- short opaque ID, e.g. "deploy-2026-05-09-a1b2"
  algorithm       text NOT NULL DEFAULT 'ed25519',
  public_key_b64  text NOT NULL,                         -- raw 32-byte Ed25519 pubkey, base64
  private_key_enc text NOT NULL,                         -- enc:v1: ciphertext via secretCrypto
  status          text NOT NULL DEFAULT 'active',        -- 'active' | 'retired'
  created_at      timestamptz NOT NULL DEFAULT now(),
  retired_at      timestamptz
);

CREATE INDEX IF NOT EXISTS idx_manifest_signing_keys_status
  ON manifest_signing_keys(status);

-- System-scoped: agent-update infrastructure, not tenant-scoped.
-- Forced RLS with no policies — only system context can read/write.
ALTER TABLE manifest_signing_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE manifest_signing_keys FORCE ROW LEVEL SECURITY;
```

- [ ] **Step 3: Write the Drizzle schema**

```typescript
// apps/api/src/db/schema/manifestSigningKeys.ts
import { pgTable, uuid, text, timestamp, index } from 'drizzle-orm/pg-core';

export const manifestSigningKeys = pgTable(
  'manifest_signing_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    keyId: text('key_id').notNull().unique(),
    algorithm: text('algorithm').notNull().default('ed25519'),
    publicKeyB64: text('public_key_b64').notNull(),
    privateKeyEnc: text('private_key_enc').notNull(),
    status: text('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    retiredAt: timestamp('retired_at', { withTimezone: true }),
  },
  (t) => ({ statusIdx: index('idx_manifest_signing_keys_status').on(t.status) }),
);
```

Add export in `apps/api/src/db/schema/index.ts`.

- [ ] **Step 4: Add to RLS coverage allowlist as INTENTIONAL_UNSCOPED**

Open `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts`, find the `INTENTIONAL_UNSCOPED` array (where `device_commands` lives), add:

```typescript
'manifest_signing_keys', // System-scoped: per-deployment agent-update signing key. Forced RLS, no policies → only system context.
```

- [ ] **Step 5: Run drift check + RLS contract test**

Run: `pnpm db:check-drift && pnpm test --filter=@breeze/api -- rls-coverage`

Expected: PASS for both.

- [ ] **Step 6: Verify as `breeze_app` user that table is locked down**

```bash
docker exec -it breeze-postgres psql -U breeze_app -d breeze \
  -c "SELECT * FROM manifest_signing_keys;"
```

Expected: `permission denied for table manifest_signing_keys` OR zero rows due to forced RLS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/migrations/2026-05-09-manifest-signing-keys.sql \
  apps/api/src/db/schema/manifestSigningKeys.ts \
  apps/api/src/db/schema/index.ts \
  apps/api/src/__tests__/integration/rls-coverage.integration.test.ts
git commit -m "feat(api): add manifest_signing_keys table for per-deployment update signing"
```

---

### Task A2: `manifestSigning` service

**Files:**
- Create: `apps/api/src/services/manifestSigning.ts`
- Create: `apps/api/src/services/manifestSigning.test.ts`

- [ ] **Step 1: Write failing test for key generation + signing round-trip**

```typescript
// apps/api/src/services/manifestSigning.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ensureActiveSigningKey, signManifest, getActivePublicKeys } from './manifestSigning';

vi.mock('./secretCrypto', () => ({
  encryptSecret: (s: string) => `enc:v1:${Buffer.from(s).toString('base64')}`,
  decryptSecret: (s: string) => Buffer.from(s.replace('enc:v1:', ''), 'base64').toString('utf8'),
  isEncryptedSecret: (s: string) => s.startsWith('enc:v1:'),
}));

const dbState: { rows: any[] } = { rows: [] };
vi.mock('../db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => dbState.rows.filter((r: any) => r.status === 'active').slice(0, 1) }),
      }),
    }),
    insert: () => ({ values: async (v: any) => { dbState.rows.push(v); return v; } }),
  },
  withSystemDbAccessContext: async (fn: any) => fn(),
}));

describe('manifestSigning', () => {
  beforeEach(() => { dbState.rows = []; });

  it('generates a fresh key when none active', async () => {
    const key = await ensureActiveSigningKey();
    expect(key.publicKeyB64).toMatch(/^[A-Za-z0-9+/=]{43,44}$/);
    expect(dbState.rows).toHaveLength(1);
  });

  it('signs a manifest and returns base64 ed25519 signature verifiable with the pubkey', async () => {
    await ensureActiveSigningKey();
    const manifest = JSON.stringify({ version: '0.65.9', component: 'agent', platform: 'windows', arch: 'amd64', url: 'https://x', checksum: 'abc', size: 100 });
    const sig = await signManifest(manifest);

    const { createPublicKey, verify } = await import('node:crypto');
    const [pub] = await getActivePublicKeys();
    const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(pub, 'base64')]);
    const publicKey = createPublicKey({ key: spki, format: 'der', type: 'spki' });
    const ok = verify(null, Buffer.from(manifest, 'utf8'), publicKey, Buffer.from(sig, 'base64'));
    expect(ok).toBe(true);
  });

  it('reuses the active key on subsequent calls', async () => {
    const a = await ensureActiveSigningKey();
    const b = await ensureActiveSigningKey();
    expect(a.keyId).toBe(b.keyId);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test --filter=@breeze/api -- manifestSigning`

Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the service**

```typescript
// apps/api/src/services/manifestSigning.ts
import { generateKeyPairSync, createPrivateKey, sign, randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../db';
import { manifestSigningKeys } from '../db/schema/manifestSigningKeys';
import { encryptSecret, decryptSecret } from './secretCrypto';

export interface ActiveSigningKey {
  keyId: string;
  publicKeyB64: string;
}

const RAW_KEY_LEN = 32;

function rawPubFromSpki(spki: Buffer): string {
  // SPKI prefix for Ed25519 is 12 bytes; the last 32 are the raw key.
  return spki.subarray(spki.length - RAW_KEY_LEN).toString('base64');
}

function rawPrivFromPkcs8(pkcs8: Buffer): string {
  // PKCS8 Ed25519: last 32 bytes are the raw seed.
  return pkcs8.subarray(pkcs8.length - RAW_KEY_LEN).toString('base64');
}

async function loadActive(): Promise<{ keyId: string; publicKeyB64: string; privateKeyEnc: string } | null> {
  return withSystemDbAccessContext(async () => {
    const rows = await db
      .select()
      .from(manifestSigningKeys)
      .where(eq(manifestSigningKeys.status, 'active'))
      .limit(1);
    return rows[0] ?? null;
  });
}

export async function ensureActiveSigningKey(): Promise<ActiveSigningKey> {
  const existing = await loadActive();
  if (existing) {
    return { keyId: existing.keyId, publicKeyB64: existing.publicKeyB64 };
  }
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' });
  const publicKeyB64 = rawPubFromSpki(spki);
  const privateKeyB64 = rawPrivFromPkcs8(pkcs8);
  const keyId = `deploy-${new Date().toISOString().slice(0, 10)}-${randomBytes(4).toString('hex')}`;
  await withSystemDbAccessContext(async () => {
    await db.insert(manifestSigningKeys).values({
      keyId,
      publicKeyB64,
      privateKeyEnc: encryptSecret(privateKeyB64),
      status: 'active',
    });
  });
  console.log(`[manifestSigning] Generated new deployment signing key ${keyId}`);
  return { keyId, publicKeyB64 };
}

function privateKeyFromRawSeed(seedB64: string) {
  const seed = Buffer.from(seedB64, 'base64');
  if (seed.length !== RAW_KEY_LEN) throw new Error('invalid Ed25519 seed length');
  // Wrap raw seed back into PKCS8 for Node crypto.
  const prefix = Buffer.from('302e020100300506032b657004220420', 'hex');
  return createPrivateKey({ key: Buffer.concat([prefix, seed]), format: 'der', type: 'pkcs8' });
}

export async function signManifest(manifestJson: string): Promise<string> {
  const active = await loadActive();
  if (!active) throw new Error('no active manifest signing key');
  const seedB64 = decryptSecret(active.privateKeyEnc);
  const key = privateKeyFromRawSeed(seedB64);
  return sign(null, Buffer.from(manifestJson, 'utf8'), key).toString('base64');
}

export async function getActivePublicKeys(): Promise<string[]> {
  const active = await loadActive();
  return active ? [active.publicKeyB64] : [];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test --filter=@breeze/api -- manifestSigning`

Expected: PASS for all three tests.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/manifestSigning.ts apps/api/src/services/manifestSigning.test.ts
git commit -m "feat(api): add per-deployment Ed25519 manifest signing service"
```

---

### Task A3: Sign manifests in `syncBinaries` local path

**Files:**
- Modify: `apps/api/src/services/binarySync.ts:325-372`
- Modify: `apps/api/src/services/binarySync.test.ts`

- [ ] **Step 1: Write failing test asserting local-mode upsert populates manifest fields**

In `apps/api/src/services/binarySync.test.ts`, find the existing `BINARY_SOURCE=local` test block (line 175), add a new test:

```typescript
it('populates releaseManifest, manifestSignature, signingKeyId in local-binary mode', async () => {
  process.env.BINARY_SOURCE = 'local';
  // ... existing setup that scaffolds binaries dir + version file ...
  await syncBinaries();
  const rows = await db.select().from(agentVersions).where(eq(agentVersions.version, '0.65.9'));
  expect(rows.length).toBeGreaterThan(0);
  for (const r of rows) {
    expect(r.releaseManifest).toBeTruthy();
    expect(r.manifestSignature).toBeTruthy();
    expect(r.signingKeyId).toMatch(/^deploy-/);
    const manifest = JSON.parse(r.releaseManifest!);
    expect(manifest.version).toBe('0.65.9');
    expect(manifest.checksum).toBe(r.checksum);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test --filter=@breeze/api -- binarySync`

Expected: FAIL — manifest fields are null.

- [ ] **Step 3: Modify `syncBinaries` upsert loop**

Replace the upsert block at `apps/api/src/services/binarySync.ts:343-370` with:

```typescript
import { ensureActiveSigningKey, signManifest } from './manifestSigning';

// ... inside the for-loop (after demoting isLatest):

const manifestObj = {
  schemaVersion: 0,        // legacy single-asset schema
  version,
  component: 'agent',
  platform: bin.platform,
  arch: bin.architecture,
  url: downloadUrl,
  checksum: bin.checksum,
  size: Number(bin.fileSize),
};
const releaseManifest = JSON.stringify(manifestObj);
const { keyId } = await ensureActiveSigningKey();
const manifestSignature = await signManifest(releaseManifest);

await tx
  .insert(agentVersions)
  .values({
    version,
    platform: bin.platform,
    architecture: bin.architecture,
    downloadUrl,
    checksum: bin.checksum,
    fileSize: bin.fileSize,
    isLatest: true,
    releaseManifest,
    manifestSignature,
    signingKeyId: keyId,
  })
  .onConflictDoUpdate({
    target: [agentVersions.version, agentVersions.platform, agentVersions.architecture, agentVersions.component],
    set: {
      downloadUrl,
      checksum: bin.checksum,
      fileSize: bin.fileSize,
      isLatest: true,
      releaseManifest,
      manifestSignature,
      signingKeyId: keyId,
    },
  });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test --filter=@breeze/api -- binarySync`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/binarySync.ts apps/api/src/services/binarySync.test.ts
git commit -m "fix(api): sign manifests in BINARY_SOURCE=local sync path (closes #625)"
```

---

## Phase B — Trust Delivery Channels

### Task B1: Heartbeat response carries `manifestTrustKeys`

**Files:**
- Modify: `apps/api/src/routes/agentWs.ts` around the heartbeat handler at line 1807-1820
- Modify: `apps/api/src/routes/agentWs.test.ts` (existing test file for this WS module)

- [ ] **Step 1: Write failing test asserting heartbeat ack includes `manifestTrustKeys`**

In the agentWs test file, add a test that mocks an authenticated agent sending `{ type: 'heartbeat' }` and asserts the server's response message includes `manifestTrustKeys: [{ keyId, publicKeyB64, validFrom }]`.

```typescript
it('heartbeat ack includes manifestTrustKeys array', async () => {
  // ... existing test scaffolding to set up authenticated agent + WS
  await sendMessage({ type: 'heartbeat' });
  const ack = await receiveMessage();
  expect(ack.manifestTrustKeys).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ keyId: expect.stringMatching(/^deploy-/), publicKeyB64: expect.any(String) }),
    ]),
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test --filter=@breeze/api -- agentWs`

Expected: FAIL — field absent.

- [ ] **Step 3: Modify heartbeat ack construction**

In `agentWs.ts` around line 1807 (`case 'heartbeat':`), find where the heartbeat ack is constructed and merged. Add (in the response payload):

```typescript
import { getActiveTrustKeyset } from '../services/manifestSigning';

// Inside the heartbeat case, when building the response:
const manifestTrustKeys = await getActiveTrustKeyset();
// ... merge into the existing ack response object:
const ack = {
  type: 'heartbeat_ack',
  // ... existing fields ...
  manifestTrustKeys,  // [{ keyId, publicKeyB64, validFrom: ISO string }]
};
```

Add to `manifestSigning.ts`:

```typescript
export interface ManifestTrustKey { keyId: string; publicKeyB64: string; validFrom: string; }

export async function getActiveTrustKeyset(): Promise<ManifestTrustKey[]> {
  return withSystemDbAccessContext(async () => {
    const rows = await db
      .select()
      .from(manifestSigningKeys)
      .where(eq(manifestSigningKeys.status, 'active'));
    return rows.map((r) => ({ keyId: r.keyId, publicKeyB64: r.publicKeyB64, validFrom: r.createdAt.toISOString() }));
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test --filter=@breeze/api -- agentWs manifestSigning`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/agentWs.ts apps/api/src/routes/agentWs.test.ts apps/api/src/services/manifestSigning.ts apps/api/src/services/manifestSigning.test.ts
git commit -m "feat(api): include manifestTrustKeys in heartbeat ack for self-host trust delivery"
```

---

### Task B2: Enrollment response carries `manifestTrustKeys`

**Files:**
- Modify: `apps/api/src/routes/agents.ts` (POST `/agents/enroll` handler)
- Modify: `apps/api/src/routes/agents.test.ts:226-500` (existing enrollment test block)

- [ ] **Step 1: Write failing test asserting enroll response includes `manifestTrustKeys`**

In `apps/api/src/routes/agents.test.ts`, add to the existing `describe('POST /agents/enroll', ...)` block:

```typescript
it('returns manifestTrustKeys in enrollment response', async () => {
  // ... existing scaffold for valid enrollment request ...
  const res = await app.request('/agents/enroll', { method: 'POST', body: JSON.stringify(validBody), headers });
  const json = await res.json();
  expect(json.manifestTrustKeys).toEqual(
    expect.arrayContaining([expect.objectContaining({ keyId: expect.any(String), publicKeyB64: expect.any(String) })]),
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test --filter=@breeze/api -- agents.test`

Expected: FAIL — field absent.

- [ ] **Step 3: Modify enrollment handler response**

In `apps/api/src/routes/agents.ts`, find the `c.json(...)` call that returns the enrollment success response. Add `manifestTrustKeys: await getActiveTrustKeyset()` to the returned object.

```typescript
import { getActiveTrustKeyset } from '../services/manifestSigning';

// In the handler:
return c.json({
  // ... existing fields (deviceId, authToken, mtls, etc.) ...
  manifestTrustKeys: await getActiveTrustKeyset(),
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test --filter=@breeze/api -- agents.test`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/agents.ts apps/api/src/routes/agents.test.ts
git commit -m "feat(api): include manifestTrustKeys in enrollment response"
```

---

## Phase C — Agent-Side Trust Pinning

### Task C1: Add `PinnedManifestPubKeys` to agent config + persistence helpers

**Files:**
- Modify: `agent/internal/config/config.go` (add field around line 116)
- Create: `agent/internal/config/manifestkeys.go`
- Create: `agent/internal/config/manifestkeys_test.go`

- [ ] **Step 1: Write failing test for `PinManifestKeys`**

```go
// agent/internal/config/manifestkeys_test.go
package config

import (
	"path/filepath"
	"testing"
)

func TestPinManifestKeys_AppendsAndDeduplicates(t *testing.T) {
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "agent.yaml")
	cfg := &Config{AgentID: "test", ServerURL: "http://localhost"}
	if err := SaveAt(cfg, cfgPath); err != nil {
		t.Fatalf("save: %v", err)
	}

	if err := PinManifestKeys(cfgPath, []ManifestTrustKey{
		{KeyID: "deploy-2026-05-09-abcd", PublicKeyB64: "AAAA"},
	}); err != nil {
		t.Fatalf("pin: %v", err)
	}
	if err := PinManifestKeys(cfgPath, []ManifestTrustKey{
		{KeyID: "deploy-2026-05-09-abcd", PublicKeyB64: "AAAA"}, // duplicate
		{KeyID: "deploy-2026-05-09-efgh", PublicKeyB64: "BBBB"}, // new
	}); err != nil {
		t.Fatalf("pin: %v", err)
	}

	loaded, err := Load(cfgPath)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if got := len(loaded.PinnedManifestPubKeys); got != 2 {
		t.Fatalf("expected 2 pinned keys, got %d", got)
	}
}

func TestPinManifestKeys_RejectsRotationByDefault(t *testing.T) {
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "agent.yaml")
	cfg := &Config{AgentID: "test", PinnedManifestPubKeys: []string{"deploy-x:AAAA"}}
	if err := SaveAt(cfg, cfgPath); err != nil {
		t.Fatalf("save: %v", err)
	}
	// New key with same keyId but different bytes — must not silently overwrite (TOFU).
	err := PinManifestKeys(cfgPath, []ManifestTrustKey{{KeyID: "deploy-x", PublicKeyB64: "ZZZZ"}})
	if err == nil {
		t.Fatal("expected rotation rejection error, got nil")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd agent && go test -race ./internal/config/...`

Expected: FAIL — `PinManifestKeys`, `ManifestTrustKey`, `SaveAt`, `PinnedManifestPubKeys` not defined.

- [ ] **Step 3: Add config field**

In `agent/internal/config/config.go`, add to the `Config` struct (after `AutoUpdate bool`):

```go
// PinnedManifestPubKeys are deployment-specific Ed25519 pubkeys delivered via
// enrollment/heartbeat and pinned TOFU-style. Format: "<keyId>:<base64-raw-pubkey>".
// Merged with embedded LanternOps trust roots in updater.trustedManifestKeys().
PinnedManifestPubKeys []string `mapstructure:"pinned_manifest_pub_keys" yaml:"pinned_manifest_pub_keys"`
```

- [ ] **Step 4: Implement `manifestkeys.go`**

```go
// agent/internal/config/manifestkeys.go
package config

import (
	"fmt"
	"strings"
)

type ManifestTrustKey struct {
	KeyID        string
	PublicKeyB64 string
}

// SaveAt is a test-friendly wrapper that lets callers override the config path.
func SaveAt(cfg *Config, path string) error {
	// existing Save() reads viper.ConfigFileUsed(); for tests we set it explicitly.
	// implementation: marshal cfg to YAML and write to path
	// (delegates to a refactored helper if needed)
	return saveYAML(cfg, path)
}

// PinManifestKeys merges the supplied trust keys into the on-disk config,
// deduplicating by keyId+pubkey. Returns an error if a different pubkey is
// supplied for an already-pinned keyId (TOFU — no silent rotation).
func PinManifestKeys(cfgPath string, keys []ManifestTrustKey) error {
	cfg, err := Load(cfgPath)
	if err != nil {
		return fmt.Errorf("load config: %w", err)
	}
	existing := map[string]string{} // keyId -> pubkey
	for _, entry := range cfg.PinnedManifestPubKeys {
		parts := strings.SplitN(entry, ":", 2)
		if len(parts) == 2 {
			existing[parts[0]] = parts[1]
		}
	}
	changed := false
	for _, k := range keys {
		if cur, ok := existing[k.KeyID]; ok {
			if cur != k.PublicKeyB64 {
				return fmt.Errorf("manifest key rotation rejected for keyId=%s: pinned pubkey differs from new value", k.KeyID)
			}
			continue
		}
		existing[k.KeyID] = k.PublicKeyB64
		changed = true
	}
	if !changed {
		return nil
	}
	pinned := make([]string, 0, len(existing))
	for id, pub := range existing {
		pinned = append(pinned, id+":"+pub)
	}
	cfg.PinnedManifestPubKeys = pinned
	return SaveAt(cfg, cfgPath)
}
```

(`saveYAML` may already exist as the body of `Save`. If not, refactor `Save` to call `saveYAML(cfg, viper.ConfigFileUsed())`.)

- [ ] **Step 5: Run test to verify it passes**

Run: `cd agent && go test -race ./internal/config/...`

Expected: PASS for both new tests + all existing config tests still pass.

- [ ] **Step 6: Commit**

```bash
git add agent/internal/config/config.go agent/internal/config/manifestkeys.go agent/internal/config/manifestkeys_test.go
git commit -m "feat(agent): add PinnedManifestPubKeys with TOFU pin/rotation guard"
```

---

### Task C2: Updater merges pinned keys into `trustedManifestKeys()`

**Files:**
- Modify: `agent/internal/updater/updater.go:165-184`
- Modify: `agent/internal/updater/updater_test.go` (existing tests)

- [ ] **Step 1: Write failing test asserting pinned keys are honored**

```go
// agent/internal/updater/updater_test.go (new test)
func TestTrustedManifestKeys_IncludesPinnedFromConfig(t *testing.T) {
	// Build an updater wired to a config with one pinned key.
	cfg := &config.Config{
		PinnedManifestPubKeys: []string{"deploy-x:" + base64.StdEncoding.EncodeToString(make([]byte, 32))},
	}
	u := &Updater{config: cfg}
	keys := u.trustedManifestKeys()
	// At minimum the embedded LanternOps key + the one pinned key.
	if len(keys) < 2 {
		t.Fatalf("expected >= 2 keys, got %d", len(keys))
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd agent && go test -race ./internal/updater/...`

Expected: FAIL — `trustedManifestKeys` is package-level, doesn't read config.

- [ ] **Step 3: Make `trustedManifestKeys` a method that reads config**

Refactor `agent/internal/updater/updater.go:165`:

```go
// Replace the package-level function with a method.
func (u *Updater) trustedManifestKeys() []ed25519.PublicKey {
	configured := strings.TrimSpace(os.Getenv("BREEZE_UPDATE_MANIFEST_PUBLIC_KEYS"))
	rawKeys := append([]string{}, trustedUpdateManifestPublicKeys...)
	if configured != "" {
		rawKeys = append(rawKeys, strings.Split(configured, ",")...)
	}
	if u != nil && u.config != nil {
		for _, entry := range u.config.PinnedManifestPubKeys {
			parts := strings.SplitN(entry, ":", 2)
			if len(parts) == 2 {
				rawKeys = append(rawKeys, parts[1])
			}
		}
	}

	keys := make([]ed25519.PublicKey, 0, len(rawKeys))
	for _, raw := range rawKeys {
		decoded, err := base64.StdEncoding.DecodeString(strings.TrimSpace(raw))
		if err != nil || len(decoded) != ed25519.PublicKeySize {
			continue
		}
		keys = append(keys, ed25519.PublicKey(decoded))
	}
	return keys
}
```

Update the only call site at line 349 from `trustedManifestKeys()` to `u.trustedManifestKeys()`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd agent && go test -race ./internal/updater/...`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add agent/internal/updater/updater.go agent/internal/updater/updater_test.go
git commit -m "feat(agent): merge pinned manifest pubkeys into trustedManifestKeys()"
```

---

### Task C3: Heartbeat handler pins keys delivered by server

**Files:**
- Modify: `agent/internal/heartbeat/heartbeat.go` (heartbeat-ack handler)
- Modify: `agent/internal/heartbeat/heartbeat_test.go`

- [ ] **Step 1: Write failing test for heartbeat ack pinning**

```go
func TestHeartbeatAck_PinsManifestTrustKeys(t *testing.T) {
	cfgPath := filepath.Join(t.TempDir(), "agent.yaml")
	if err := config.SaveAt(&config.Config{AgentID: "x"}, cfgPath); err != nil {
		t.Fatal(err)
	}
	h := &Heartbeat{cfgPath: cfgPath}
	ack := serverAck{
		ManifestTrustKeys: []manifestTrustKeyMsg{
			{KeyID: "deploy-2026-05-09-aaaa", PublicKeyB64: base64.StdEncoding.EncodeToString(make([]byte, 32))},
		},
	}
	if err := h.handleAck(ack); err != nil {
		t.Fatal(err)
	}
	loaded, _ := config.Load(cfgPath)
	if len(loaded.PinnedManifestPubKeys) != 1 {
		t.Fatalf("expected 1 pinned key, got %d", len(loaded.PinnedManifestPubKeys))
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd agent && go test -race ./internal/heartbeat/...`

Expected: FAIL — `manifestTrustKeyMsg`, `handleAck` ack pinning not implemented.

- [ ] **Step 3: Implement ack-side pinning**

In `agent/internal/heartbeat/heartbeat.go`, add to the heartbeat-ack struct (find the existing struct used to JSON-decode the server response):

```go
type manifestTrustKeyMsg struct {
	KeyID        string `json:"keyId"`
	PublicKeyB64 string `json:"publicKeyB64"`
	ValidFrom    string `json:"validFrom"`
}

type serverAck struct {
	// ... existing fields ...
	ManifestTrustKeys []manifestTrustKeyMsg `json:"manifestTrustKeys"`
}

func (h *Heartbeat) handleAck(ack serverAck) error {
	if len(ack.ManifestTrustKeys) > 0 {
		keys := make([]config.ManifestTrustKey, 0, len(ack.ManifestTrustKeys))
		for _, k := range ack.ManifestTrustKeys {
			if k.KeyID == "" || k.PublicKeyB64 == "" {
				continue
			}
			keys = append(keys, config.ManifestTrustKey{KeyID: k.KeyID, PublicKeyB64: k.PublicKeyB64})
		}
		if err := config.PinManifestKeys(h.cfgPath, keys); err != nil {
			// Log and continue; rotation rejection is non-fatal at heartbeat-time.
			log.Warn("manifest trust key pin rejected", "error", err.Error())
		}
	}
	// ... existing ack handling continues ...
	return nil
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd agent && go test -race ./internal/heartbeat/...`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add agent/internal/heartbeat/heartbeat.go agent/internal/heartbeat/heartbeat_test.go
git commit -m "feat(agent): TOFU-pin manifest trust keys delivered via heartbeat ack"
```

---

### Task C4: Enrollment pins keys from registration response

**Files:**
- Modify: `agent/internal/enrollment/enrollment.go` (response parsing)
- Modify: `agent/internal/enrollment/enrollment_test.go`

- [ ] **Step 1: Write failing test**

```go
func TestEnroll_PinsManifestTrustKeysFromResponse(t *testing.T) {
	cfgPath := filepath.Join(t.TempDir(), "agent.yaml")
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, `{
			"deviceId": "dev-1",
			"authToken": "brz_xxx",
			"manifestTrustKeys": [{"keyId":"deploy-x","publicKeyB64":"`+base64.StdEncoding.EncodeToString(make([]byte, 32))+`"}]
		}`)
	}))
	defer srv.Close()
	if _, err := Enroll(srv.URL, "key", cfgPath); err != nil {
		t.Fatal(err)
	}
	loaded, _ := config.Load(cfgPath)
	if len(loaded.PinnedManifestPubKeys) != 1 {
		t.Fatalf("expected 1 pinned key, got %d", len(loaded.PinnedManifestPubKeys))
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd agent && go test -race ./internal/enrollment/...`

Expected: FAIL.

- [ ] **Step 3: Add field to enrollment response struct + pin call**

In `agent/internal/enrollment/enrollment.go`, locate the response struct (the one decoding the `/agents/enroll` JSON). Add:

```go
type enrollResponse struct {
	// ... existing fields ...
	ManifestTrustKeys []struct {
		KeyID        string `json:"keyId"`
		PublicKeyB64 string `json:"publicKeyB64"`
	} `json:"manifestTrustKeys"`
}

// After successful enroll + config save, call:
if len(resp.ManifestTrustKeys) > 0 {
	keys := make([]config.ManifestTrustKey, 0, len(resp.ManifestTrustKeys))
	for _, k := range resp.ManifestTrustKeys {
		if k.KeyID != "" && k.PublicKeyB64 != "" {
			keys = append(keys, config.ManifestTrustKey{KeyID: k.KeyID, PublicKeyB64: k.PublicKeyB64})
		}
	}
	if err := config.PinManifestKeys(cfgPath, keys); err != nil {
		return nil, fmt.Errorf("pin manifest trust keys: %w", err)
	}
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd agent && go test -race ./internal/enrollment/...`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add agent/internal/enrollment/enrollment.go agent/internal/enrollment/enrollment_test.go
git commit -m "feat(agent): pin manifest trust keys from enrollment response"
```

---

## Phase D — Defenses

### Task D1: Boot-time self-test for `BINARY_SOURCE=local`

**Files:**
- Create: `apps/api/src/services/binarySync.selftest.ts`
- Create: `apps/api/src/services/binarySync.selftest.test.ts`
- Modify: `apps/api/src/index.ts:1262-1267` (post-`syncBinaries` hook)

- [ ] **Step 1: Write failing test for round-trip self-test**

```typescript
// apps/api/src/services/binarySync.selftest.test.ts
import { describe, it, expect, vi } from 'vitest';
import { runManifestSelfTest } from './binarySync.selftest';

vi.mock('./manifestSigning', () => ({
  ensureActiveSigningKey: async () => ({ keyId: 'deploy-test', publicKeyB64: 'AAA=' }),
  signManifest: async () => 'sig-not-valid',
  getActivePublicKeys: async () => ['AAA='],
}));

describe('runManifestSelfTest', () => {
  it('throws if validateReleaseManifest rejects a freshly-signed manifest', async () => {
    await expect(runManifestSelfTest()).rejects.toThrow(/self-test failed/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test --filter=@breeze/api -- binarySync.selftest`

Expected: FAIL — module missing.

- [ ] **Step 3: Implement the self-test**

```typescript
// apps/api/src/services/binarySync.selftest.ts
import { ensureActiveSigningKey, signManifest } from './manifestSigning';
import { validateReleaseManifestForSelfTest } from '../routes/agentVersions';

export async function runManifestSelfTest(): Promise<void> {
  const manifest = JSON.stringify({
    schemaVersion: 0,
    version: '0.0.0-selftest',
    component: 'agent',
    platform: 'linux',
    arch: 'amd64',
    url: 'http://selftest.local/agent',
    checksum: 'a'.repeat(64),
    size: 0,
  });
  await ensureActiveSigningKey();
  const sig = await signManifest(manifest);
  const result = await validateReleaseManifestForSelfTest({
    manifest,
    signature: sig,
    version: '0.0.0-selftest',
    platform: 'linux',
    arch: 'amd64',
    component: 'agent',
    downloadUrl: 'http://selftest.local/agent',
    checksum: 'a'.repeat(64),
    fileSize: 0,
  });
  if (!result.ok) {
    throw new Error(`[binarySync] manifest self-test failed: ${result.reason}. ` +
      `BINARY_SOURCE=local cannot serve agent updates. Refusing to start.`);
  }
}
```

Export `validateReleaseManifestForSelfTest` from `apps/api/src/routes/agentVersions.ts` (alias of the existing private `validateReleaseManifest`):

```typescript
// apps/api/src/routes/agentVersions.ts (end of file)
export { validateReleaseManifest as validateReleaseManifestForSelfTest };
```

Wire into startup at `apps/api/src/index.ts:1265`:

```typescript
import { runManifestSelfTest } from './services/binarySync.selftest';
import { getBinarySource } from './services/binarySource';

// After syncBinaries:
await syncBinaries();
if (getBinarySource() === 'local') {
  await runManifestSelfTest();   // Throws and aborts startup if signing→verification round-trip fails.
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test --filter=@breeze/api -- binarySync.selftest`

Expected: PASS.

- [ ] **Step 5: Add a positive integration test**

```typescript
it('passes when manifestSigning and validateReleaseManifest agree', async () => {
  vi.unmock('./manifestSigning');
  await expect(runManifestSelfTest()).resolves.not.toThrow();
});
```

Run: `pnpm test --filter=@breeze/api -- binarySync.selftest`

Expected: PASS for both tests.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/binarySync.selftest.ts \
  apps/api/src/services/binarySync.selftest.test.ts \
  apps/api/src/routes/agentVersions.ts \
  apps/api/src/index.ts
git commit -m "feat(api): boot-time manifest signing self-test (fail-fast for BINARY_SOURCE=local)"
```

---

### Task D2: CI smoke test for BINARY_SOURCE=local agent download path

**Files:**
- Create: `.github/workflows/ci-smoke-binary-source-local.yml`

- [ ] **Step 1: Write the workflow**

```yaml
# .github/workflows/ci-smoke-binary-source-local.yml
name: smoke-binary-source-local

on:
  pull_request:
    paths:
      - 'apps/api/src/services/binarySync.ts'
      - 'apps/api/src/services/binarySync.selftest.ts'
      - 'apps/api/src/services/manifestSigning.ts'
      - 'apps/api/src/routes/agentVersions.ts'
      - 'apps/api/migrations/**'
  push:
    branches: [main]

jobs:
  smoke:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_USER: breeze
          POSTGRES_PASSWORD: breeze
          POSTGRES_DB: breeze
        ports: ['5432:5432']
        options: >-
          --health-cmd pg_isready --health-interval 10s
          --health-timeout 5s --health-retries 5

    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v6
      - uses: actions/setup-node@v4
        with: { node-version: '22' }
      - run: pnpm install --frozen-lockfile

      - name: Stage fake local agent binary
        run: |
          mkdir -p tmp/agent/bin
          dd if=/dev/urandom of=tmp/agent/bin/breeze-rmm-linux-amd64 bs=1k count=4
          echo "0.65.9" > tmp/VERSION

      - name: Boot API in BINARY_SOURCE=local mode
        env:
          BINARY_SOURCE: local
          AGENT_BINARY_DIR: ${{ github.workspace }}/tmp/agent/bin
          BINARY_VERSION_FILE: ${{ github.workspace }}/tmp/VERSION
          BREEZE_VERSION: '0.65.9'
          DATABASE_URL: postgres://breeze:breeze@localhost:5432/breeze
          APP_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
          NODE_ENV: production
        run: |
          pnpm --filter=@breeze/api start &
          API_PID=$!
          for i in {1..30}; do
            curl -sf http://localhost:3001/health && break || sleep 2
          done
          # If self-test failed at boot, /health never comes up — this fails CI.
          curl -sf http://localhost:3001/health || (echo "API never became healthy"; exit 1)

      - name: Hit the download endpoint and assert 200
        run: |
          STATUS=$(curl -s -o /tmp/body.json -w '%{http_code}' \
            'http://localhost:3001/api/v1/agent-versions/0.65.9/download?platform=linux&arch=amd64&component=agent')
          if [ "$STATUS" != "200" ]; then
            echo "Expected 200, got $STATUS"; cat /tmp/body.json; exit 1
          fi
          jq -e '.manifest != null and .manifestSignature != null' /tmp/body.json
```

- [ ] **Step 2: Validate the workflow locally**

Run: `act -W .github/workflows/ci-smoke-binary-source-local.yml -j smoke` (if `act` installed; otherwise push branch and observe CI).

Expected: PASS — endpoint returns 200 with non-null manifest fields.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci-smoke-binary-source-local.yml
git commit -m "ci: smoke test for BINARY_SOURCE=local agent download path"
```

---

## Phase E — Stuck-Fleet Recovery

### Task E1: Recovery CLI to push v0.65.9 to v0.65.8-stuck agents

**Files:**
- Create: `agent/cmd/breeze-rmm/recover_update.go` (new subcommand on the existing breeze-rmm CLI)
- Create: `agent/cmd/breeze-rmm/recover_update_test.go`
- Modify: `apps/api/src/routes/admin.ts` or equivalent (new endpoint `POST /admin/devices/recover-stuck-updates`)

- [ ] **Step 1: Write failing test for the API admin endpoint**

```typescript
// apps/api/src/routes/admin.test.ts (or wherever admin tests live)
it('POST /admin/devices/recover-stuck-updates pushes dev_update to v0.65.8 agents', async () => {
  // Seed: two devices, one on 0.65.8 (stuck), one on 0.65.9 (healthy).
  // ... seed setup ...
  const res = await app.request('/admin/devices/recover-stuck-updates', {
    method: 'POST',
    body: JSON.stringify({ targetVersion: '0.65.9', stuckBeforeVersion: '0.65.9' }),
    headers: adminAuth,
  });
  const json = await res.json();
  expect(json.queued).toBe(1); // Only the stuck device.
  expect(json.skipped).toBe(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test --filter=@breeze/api -- admin`

Expected: FAIL.

- [ ] **Step 3: Implement the endpoint**

```typescript
// In the admin routes file (find the admin routes mount in index.ts):
adminRoutes.post('/devices/recover-stuck-updates', adminAuthMiddleware, async (c) => {
  const { targetVersion, stuckBeforeVersion } = await c.req.json();
  const stuckDevices = await db
    .select({ id: devices.id, lastVersion: devices.agentVersion })
    .from(devices)
    .where(lt(devices.agentVersion, stuckBeforeVersion));

  let queued = 0, skipped = 0;
  for (const d of stuckDevices) {
    try {
      // Re-use #615's dev_update mechanism. The command body includes the
      // server-relative download URL — agents poll heartbeat, see the
      // command, and self-update.
      await sendCommandToAgent(d.id, {
        type: 'dev_update',
        targetVersion,
      });
      queued++;
    } catch {
      skipped++;
    }
  }
  return c.json({ queued, skipped });
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test --filter=@breeze/api -- admin`

Expected: PASS.

- [ ] **Step 5: Add CLI helper for operators**

```go
// agent/cmd/breeze-rmm/recover_update.go
package main

import (
	"flag"
	"fmt"
	"net/http"
)

func recoverUpdateCmd(args []string) error {
	fs := flag.NewFlagSet("recover-update", flag.ExitOnError)
	server := fs.String("server", "", "Breeze server URL")
	token := fs.String("token", "", "admin API token")
	target := fs.String("target", "", "target agent version, e.g. 0.65.9")
	before := fs.String("before", "", "stuck-before version, e.g. 0.65.9")
	_ = fs.Parse(args)

	if *server == "" || *token == "" || *target == "" || *before == "" {
		return fmt.Errorf("usage: recover-update --server URL --token TOKEN --target 0.65.9 --before 0.65.9")
	}
	body := fmt.Sprintf(`{"targetVersion":"%s","stuckBeforeVersion":"%s"}`, *target, *before)
	req, _ := http.NewRequest("POST", *server+"/admin/devices/recover-stuck-updates", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+*token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	io.Copy(os.Stdout, resp.Body)
	return nil
}
```

Wire into the existing CLI dispatcher in `agent/cmd/breeze-rmm/main.go` alongside other subcommands.

- [ ] **Step 6: Document the recovery procedure**

Create `docs/deploy/agent-update-trust-bootstrap.md`:

```markdown
# Recovering Stuck Agents After v0.65.9 Upgrade

If your fleet upgraded through v0.65.8 with `BINARY_SOURCE=local`, agents are
stuck on v0.65.7 and won't auto-update. After deploying v0.65.9:

1. Confirm at least one healthy agent is on v0.65.9 (e.g. a fresh enrollment).
2. Run the recovery CLI from any host with admin credentials:

   breeze-rmm recover-update \
     --server https://your.host \
     --token $ADMIN_TOKEN \
     --target 0.65.9 \
     --before 0.65.9

3. Stuck agents receive a dev_update command on their next heartbeat and
   upgrade in-place. Once on v0.65.9 they receive the per-deployment
   manifest pubkey via heartbeat ack and self-heal. No further action.

If you can't reach v0.65.9 yet, roll BREEZE_VERSION back to 0.65.7 in
/opt/breeze/.env until v0.65.9 is available.
```

- [ ] **Step 7: Commit**

```bash
git add agent/cmd/breeze-rmm/recover_update.go \
  agent/cmd/breeze-rmm/recover_update_test.go \
  agent/cmd/breeze-rmm/main.go \
  apps/api/src/routes/admin.ts \
  apps/api/src/routes/admin.test.ts \
  docs/deploy/agent-update-trust-bootstrap.md
git commit -m "feat: stuck-fleet recovery CLI + admin endpoint for v0.65.8 → v0.65.9"
```

---

## Phase F — Release Plumbing

### Task F1: End-to-end smoke against a docker compose dev stack

- [ ] **Step 1: Boot dev stack with BINARY_SOURCE=local**

```bash
docker compose -f docker-compose.yml -f docker-compose.override.yml.dev up --build -d
```

Wait for `/health` to return 200.

- [ ] **Step 2: Confirm signed manifest in DB**

```bash
docker exec -i breeze-postgres psql -U breeze -d breeze -c "
SELECT version, signing_key_id IS NOT NULL AS has_keyid,
       release_manifest IS NOT NULL AS has_manifest,
       manifest_signature IS NOT NULL AS has_sig
  FROM agent_versions WHERE is_latest = true;"
```

Expected: all three flags `t`.

- [ ] **Step 3: Hit the download endpoint**

```bash
curl -sf 'http://localhost:3001/api/v1/agent-versions/0.65.9/download?platform=linux&arch=amd64&component=agent' | jq
```

Expected: JSON with non-null `manifest` and `manifestSignature`.

- [ ] **Step 4: Run a fresh agent enrollment and confirm pinned key persists**

```bash
cd agent && make build
./bin/breeze-rmm enroll --server http://localhost:3001 --key TEST_ENROLLMENT_KEY
grep pinned_manifest_pub_keys ~/.config/breeze-rmm/agent.yaml
```

Expected: one entry of form `deploy-...:<base64>`.

- [ ] **Step 5: Trigger an update and confirm the agent verifies + installs**

```bash
# Bump BREEZE_VERSION, recompose, observe agent logs
```

Expected: agent log shows `update verified, installing` (or equivalent), no `signed_release_manifest_required` errors.

- [ ] **Step 6: Commit nothing (smoke notes only). Document outcome in PR description.**

---

### Task F2: Release notes + version bump

**Files:**
- Modify: release notes mechanism (root `RELEASE_NOTES.md` or similar)
- Modify: version source (e.g. `package.json`, `agent/internal/buildinfo/version.go`)

- [ ] **Step 1: Bump version to 0.65.9**

Use the project's existing version-bump procedure. Confirm the version surfaces in:
- `apps/api/package.json` (or wherever `APP_VERSION` is sourced)
- `agent/internal/buildinfo/version.go`

- [ ] **Step 2: Add release notes entry**

```markdown
## v0.65.9 — Self-Host Update Path Restored

**Fixes:** #625 — `BINARY_SOURCE=local` agent updates were broken in v0.65.8
because the strict-signing check from #568 had no signing path for locally
sourced binaries. v0.65.9 generates a per-deployment Ed25519 signing key
on first boot and signs every locally-registered manifest. Agents pin the
public key TOFU-style via enrollment + heartbeat.

**For operators on v0.65.7 or v0.65.8:** Existing fleets need a one-time
recovery run after upgrading the API to v0.65.9. See
`docs/deploy/agent-update-trust-bootstrap.md`.

**Hardening:** Boot-time self-test refuses to start the API in `BINARY_SOURCE=local`
mode if the signing → verification round-trip fails. CI now exercises this
path on every PR that touches `binarySync` or `agentVersions`.
```

- [ ] **Step 3: Commit + tag**

```bash
git add RELEASE_NOTES.md apps/api/package.json agent/internal/buildinfo/version.go
git commit -m "release: v0.65.9 (closes #625)"
git tag v0.65.9
```

- [ ] **Step 4: Open PR**

PR title: `fix(api,agent): per-deployment manifest signing for BINARY_SOURCE=local (closes #625)`

Body mentions:
- the regression and root cause
- the trust model trade-off (signing key on same host as API → defends against DB-only compromise, weaker than build-time-baked LanternOps trust roots — by design)
- the recovery procedure for stuck v0.65.8 fleets
- the three defenses (boot self-test, CI smoke, recovery CLI)

---

## Self-Review Checklist (run before handing off)

- [ ] Every task has actual code — no `// TODO` or `// implement`.
- [ ] `signManifest` signature in Task A2 matches its call site in Task A3.
- [ ] `getActiveTrustKeyset()` defined in Task B1 used identically in Task B2.
- [ ] `PinManifestKeys`/`ManifestTrustKey` types in Task C1 match consumers in C3 + C4.
- [ ] `validateReleaseManifestForSelfTest` export in Task D1 is the same function used in production at `agentVersions.ts:322`.
- [ ] `manifest_signing_keys` is on the `INTENTIONAL_UNSCOPED` allowlist (Task A1 step 4).
- [ ] Migration filename sorts after `2026-05-06` and before any same-day siblings (Task A1).
- [ ] CI smoke job (Task D2) actually exercises the production code path, not a mock.
- [ ] Recovery CLI (Task E1) is invocable without modifying the agent code itself.
- [ ] No edits to shipped migrations.
- [ ] Release notes (Task F2) state the trust-model trade-off so self-host operators understand what they are accepting.
