import { describe, it, expect, beforeEach } from 'vitest';
import { ExtensionStateStore, type ExtensionStateBackend } from './stateStore';
import type { ExtensionStateRecord, ObservedExtensionInput } from './stateStore';
import type { ExtensionLifecycleState } from '../db/schema/extensions';

/**
 * Unit tests run on the no-DB unit runner, so the store is exercised through an
 * in-memory backend that mirrors the Drizzle backend's row semantics exactly:
 * upsert preserves `enabled`/`lifecycle_state` on an existing row, setEnabled
 * touches only `enabled` (+ updated_at), failures don't disturb `enabled`, and
 * schema floors are keyed (name, version). The cross-connection / RLS behaviour
 * of the real backend is proven separately in
 * __tests__/integration/extensionState.integration.test.ts.
 */
class InMemoryExtensionStateBackend implements ExtensionStateBackend {
  private readonly rows = new Map<string, ExtensionStateRecord>();
  private readonly floors = new Map<string, Map<string, string>>();

  async upsertObserved(input: ObservedExtensionInput): Promise<void> {
    const existing = this.rows.get(input.name);
    if (existing) {
      // Merge only supplied observed fields; never touch enabled/lifecycle.
      if (input.configuredVersion !== undefined) existing.configuredVersion = input.configuredVersion;
      if (input.activeVersion !== undefined) existing.activeVersion = input.activeVersion;
      if (input.digest !== undefined) existing.artifactDigest = input.digest;
      if (input.publisher !== undefined) existing.publisherId = input.publisher;
      if (input.manifestApiVersion !== undefined) existing.manifestApiVersion = input.manifestApiVersion;
      if (input.serverSdkVersion !== undefined) existing.serverSdkVersion = input.serverSdkVersion;
      if (input.webSdkVersion !== undefined) existing.webSdkVersion = input.webSdkVersion;
      existing.updatedAt = new Date();
      return;
    }
    this.rows.set(input.name, {
      name: input.name,
      configuredVersion: input.configuredVersion ?? null,
      activeVersion: input.activeVersion ?? null,
      artifactDigest: input.digest ?? null,
      publisherId: input.publisher ?? null,
      manifestApiVersion: input.manifestApiVersion ?? null,
      serverSdkVersion: input.serverSdkVersion ?? null,
      webSdkVersion: input.webSdkVersion ?? null,
      enabled: true,
      lifecycleState: 'discovered',
      lastErrorCategory: null,
      lastErrorMessage: null,
      migratedAt: null,
      activatedAt: null,
      updatedAt: new Date(),
    });
  }

  async setEnabled(name: string, enabled: boolean): Promise<void> {
    const row = this.rows.get(name);
    if (!row) return;
    row.enabled = enabled;
    row.updatedAt = new Date();
  }

  async getRow(name: string): Promise<ExtensionStateRecord | null> {
    const row = this.rows.get(name);
    return row ? { ...row } : null;
  }

  async listRows(): Promise<ExtensionStateRecord[]> {
    return [...this.rows.values()]
      .map((row) => ({ ...row }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async recordFailure(
    name: string,
    state: Extract<ExtensionLifecycleState, 'failed' | 'incompatible'>,
    category: string,
    message: string,
  ): Promise<void> {
    const row = this.rows.get(name);
    if (!row) return;
    row.lifecycleState = state;
    row.lastErrorCategory = category;
    row.lastErrorMessage = message;
    row.updatedAt = new Date();
  }

  async recordActive(name: string, activeVersion: string | null): Promise<void> {
    const row = this.rows.get(name);
    if (!row) return;
    row.lifecycleState = 'active';
    row.lastErrorCategory = null;
    row.lastErrorMessage = null;
    row.activatedAt = new Date();
    row.updatedAt = new Date();
    if (activeVersion !== null) row.activeVersion = activeVersion;
  }

  async insertSchemaFloor(name: string, version: string, floor: string): Promise<void> {
    let byVersion = this.floors.get(name);
    if (!byVersion) {
      byVersion = new Map();
      this.floors.set(name, byVersion);
    }
    byVersion.set(version, floor);
  }

  async listSchemaFloors(name: string): Promise<string[]> {
    return [...(this.floors.get(name)?.values() ?? [])];
  }
}

describe('ExtensionStateStore', () => {
  let db: InMemoryExtensionStateBackend;

  beforeEach(() => {
    db = new InMemoryExtensionStateBackend();
  });

  it('changes only enabled state at runtime', async () => {
    const store = new ExtensionStateStore(db);
    await store.upsertObserved({ name: 'demo', configuredVersion: '2.0.0', digest: 'sha256:abc', publisher: 'breeze' });
    await store.setEnabled('demo', false);
    expect(await store.get('demo')).toMatchObject({ configuredVersion: '2.0.0', enabled: false });
  });

  it('upsertObserved seeds a discovered, enabled row with the observed facts', async () => {
    const store = new ExtensionStateStore(db);
    await store.upsertObserved({
      name: 'demo',
      configuredVersion: '2.0.0',
      digest: 'sha256:abc',
      publisher: 'breeze',
    });

    expect(await store.get('demo')).toMatchObject({
      name: 'demo',
      configuredVersion: '2.0.0',
      artifactDigest: 'sha256:abc',
      publisherId: 'breeze',
      enabled: true,
      lifecycleState: 'discovered',
    });
    expect(await store.isEnabled('demo')).toBe(true);
  });

  it('re-observing merges supplied fields and preserves the runtime enabled flag', async () => {
    const store = new ExtensionStateStore(db);
    await store.upsertObserved({ name: 'demo', configuredVersion: '2.0.0', digest: 'sha256:abc', publisher: 'breeze' });
    await store.setEnabled('demo', false);

    // A later observation supplies only a new digest; it must not resurrect
    // enabled or blank the previously-observed version.
    await store.upsertObserved({ name: 'demo', digest: 'sha256:def' });

    expect(await store.get('demo')).toMatchObject({
      configuredVersion: '2.0.0',
      artifactDigest: 'sha256:def',
      enabled: false,
    });
  });

  it('isEnabled and get report false/null for an unknown extension', async () => {
    const store = new ExtensionStateStore(db);
    expect(await store.isEnabled('nope')).toBe(false);
    expect(await store.get('nope')).toBeNull();
  });

  it('recordFailure sets the failed state + error without touching enabled', async () => {
    const store = new ExtensionStateStore(db);
    await store.upsertObserved({ name: 'demo', configuredVersion: '2.0.0' });
    await store.recordFailure('demo', { category: 'migration', message: 'boom' });

    expect(await store.get('demo')).toMatchObject({
      lifecycleState: 'failed',
      lastErrorCategory: 'migration',
      lastErrorMessage: 'boom',
      enabled: true,
    });
  });

  it('recordFailure with incompatible maps to the incompatible lifecycle state', async () => {
    const store = new ExtensionStateStore(db);
    await store.upsertObserved({ name: 'demo', configuredVersion: '2.0.0' });
    await store.recordFailure('demo', { category: 'compat', message: 'host too old', incompatible: true });

    expect(await store.get('demo')).toMatchObject({
      lifecycleState: 'incompatible',
      lastErrorCategory: 'compat',
      lastErrorMessage: 'host too old',
    });
  });

  it('recordActive marks active, pins the version, and clears prior errors', async () => {
    const store = new ExtensionStateStore(db);
    await store.upsertObserved({ name: 'demo', configuredVersion: '2.0.0' });
    await store.recordFailure('demo', { category: 'migration', message: 'boom' });
    await store.recordActive('demo', '2.0.0');

    expect(await store.get('demo')).toMatchObject({
      lifecycleState: 'active',
      activeVersion: '2.0.0',
      lastErrorCategory: null,
      lastErrorMessage: null,
    });
  });

  it('highestSchemaFloor returns null before any floor is recorded', async () => {
    const store = new ExtensionStateStore(db);
    await store.upsertObserved({ name: 'demo', configuredVersion: '2.0.0' });
    expect(await store.highestSchemaFloor('demo')).toBeNull();
  });

  it('highestSchemaFloor compares floors by semver, not lexically', async () => {
    const store = new ExtensionStateStore(db);
    await store.recordSchemaFloor('demo', '1.0.0', '1.0.0');
    await store.recordSchemaFloor('demo', '2.0.0', '9.0.0');
    // Lexical MAX would wrongly pick '9.0.0' over '10.0.0'.
    await store.recordSchemaFloor('demo', '3.0.0', '10.0.0');

    expect(await store.highestSchemaFloor('demo')).toBe('10.0.0');
  });

  it('recordSchemaFloor is keyed by (name, version) and updates in place', async () => {
    const store = new ExtensionStateStore(db);
    await store.recordSchemaFloor('demo', '1.0.0', '1.0.0');
    // Same version re-applied with a corrected floor must replace, not append a
    // second, higher-looking entry.
    await store.recordSchemaFloor('demo', '1.0.0', '1.2.0');

    expect(await store.highestSchemaFloor('demo')).toBe('1.2.0');
  });

  it('schema floors are isolated per extension', async () => {
    const store = new ExtensionStateStore(db);
    await store.recordSchemaFloor('demo', '1.0.0', '5.0.0');
    await store.recordSchemaFloor('other', '1.0.0', '1.0.0');

    expect(await store.highestSchemaFloor('other')).toBe('1.0.0');
  });
});
