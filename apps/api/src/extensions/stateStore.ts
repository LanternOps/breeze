import { eq, sql } from 'drizzle-orm';
import { gt, valid as validSemver } from 'semver';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import {
  installedExtensions,
  extensionSchemaHistory,
  type ExtensionLifecycleState,
} from '../db/schema/extensions';

/**
 * Persistent state layer for the runtime-extension platform.
 *
 * `installed_extensions` and `extension_schema_history` are core-owned GLOBAL
 * operational tables with a FORCE-RLS system-only policy (see
 * migrations/2026-08-01-e-runtime-extensions.sql). A tenant-scoped connection
 * cannot read or write them, so EVERY persistence operation runs under system
 * DB scope — that is the whole reason the store talks to the database through a
 * {@link ExtensionStateBackend} whose Drizzle implementation wraps each call in
 * `runOutsideDbContext(() => withSystemDbAccessContext(...))` (see
 * `DrizzleExtensionStateBackend.asSystem` for why the bare form is unsafe).
 *
 * The backend seam also makes the store unit-testable without Postgres: the unit
 * runner has no database, so tests inject an in-memory backend. The store itself
 * holds the domain logic (field mapping, the enabled-only mutation contract, the
 * failure-state mapping, and the semver "highest floor" computation).
 */

/** A persisted extension row, mapped to camelCase domain fields. */
export interface ExtensionStateRecord {
  name: string;
  configuredVersion: string | null;
  activeVersion: string | null;
  artifactDigest: string | null;
  publisherId: string | null;
  manifestApiVersion: string | null;
  serverSdkVersion: string | null;
  webSdkVersion: string | null;
  enabled: boolean;
  lifecycleState: ExtensionLifecycleState;
  lastErrorCategory: string | null;
  lastErrorMessage: string | null;
  migratedAt: Date | null;
  activatedAt: Date | null;
  updatedAt: Date;
}

/**
 * Facts OBSERVED about an extension from the deployment config + verified
 * bundle. Every field except `name` is optional: `upsertObserved` updates only
 * the fields actually supplied and never disturbs the runtime `enabled` flag or
 * the lifecycle state of an existing row.
 */
export interface ObservedExtensionInput {
  name: string;
  configuredVersion?: string | null;
  activeVersion?: string | null;
  digest?: string | null;
  publisher?: string | null;
  manifestApiVersion?: string | null;
  serverSdkVersion?: string | null;
  webSdkVersion?: string | null;
}

/** A lifecycle failure to record against an extension. */
export interface ExtensionFailureInput {
  category: string;
  message: string;
  /** true → lifecycle_state 'incompatible'; otherwise 'failed'. */
  incompatible?: boolean;
}

/**
 * The persistence seam. The store never touches the database directly; a backend
 * either wraps Drizzle + system DB scope (production/integration) or an in-memory
 * map (unit tests). Backends persist raw rows; the store owns the logic.
 */
export interface ExtensionStateBackend {
  /**
   * Insert a new row (enabled=true, lifecycle_state='discovered') or, if one
   * already exists, update ONLY the supplied observed fields + updated_at —
   * leaving `enabled` and `lifecycle_state` untouched.
   */
  upsertObserved(input: ObservedExtensionInput): Promise<void>;
  /** Update ONLY `enabled` and `updated_at`. No-op if the row is absent. */
  setEnabled(name: string, enabled: boolean): Promise<void>;
  getRow(name: string): Promise<ExtensionStateRecord | null>;
  /**
   * Every persisted row, ordered by name. Powers the platform-admin list
   * endpoint; system-scoped like every other backend read.
   */
  listRows(): Promise<ExtensionStateRecord[]>;
  /**
   * Record a failure: set lifecycle_state to the given failure state, the error
   * category/message, and updated_at. Does NOT touch `enabled`. No-op if absent.
   */
  recordFailure(
    name: string,
    state: Extract<ExtensionLifecycleState, 'failed' | 'incompatible'>,
    category: string,
    message: string,
  ): Promise<void>;
  /**
   * Mark active: lifecycle_state='active', activated_at=now, updated_at=now,
   * clear the last error, and set active_version when supplied. No-op if absent.
   */
  recordActive(name: string, activeVersion: string | null): Promise<void>;
  /** Upsert the schema-compatibility floor recorded for (name, version). */
  insertSchemaFloor(name: string, version: string, floor: string): Promise<void>;
  /** Every schema-compatibility floor ever recorded for the extension. */
  listSchemaFloors(name: string): Promise<string[]>;
}

export class ExtensionStateStore {
  constructor(private readonly backend: ExtensionStateBackend) {}

  /** See {@link ExtensionStateBackend.upsertObserved}. */
  async upsertObserved(input: ObservedExtensionInput): Promise<void> {
    await this.backend.upsertObserved(input);
  }

  /** Flip the runtime enabled flag (and only that + updated_at). */
  async setEnabled(name: string, enabled: boolean): Promise<void> {
    await this.backend.setEnabled(name, enabled);
  }

  /** Current enabled flag; false when the extension is unknown. */
  async isEnabled(name: string): Promise<boolean> {
    const row = await this.backend.getRow(name);
    return row?.enabled ?? false;
  }

  /** Full persisted record, or null when the extension is unknown. */
  async get(name: string): Promise<ExtensionStateRecord | null> {
    return this.backend.getRow(name);
  }

  /**
   * Every persisted record, ordered by name. Read-only enumeration for the
   * platform-admin surface; it performs no mutation and no filtering, so an
   * operator sees failed and disabled extensions too (exactly the rows they
   * need to diagnose).
   */
  async listAll(): Promise<ExtensionStateRecord[]> {
    return this.backend.listRows();
  }

  /** Record a lifecycle failure (mapped to 'incompatible' or 'failed'). */
  async recordFailure(name: string, failure: ExtensionFailureInput): Promise<void> {
    await this.backend.recordFailure(
      name,
      failure.incompatible ? 'incompatible' : 'failed',
      failure.category,
      failure.message,
    );
  }

  /** Mark the extension active, optionally pinning the now-active version. */
  async recordActive(name: string, activeVersion: string | null = null): Promise<void> {
    await this.backend.recordActive(name, activeVersion);
  }

  /** Append/refresh the schema-compatibility floor a bundle version applied. */
  async recordSchemaFloor(name: string, version: string, floor: string): Promise<void> {
    await this.backend.insertSchemaFloor(name, version, floor);
  }

  /**
   * The semver-highest schema-compatibility floor ever recorded for the
   * extension, or null when none exist. Uses semver ordering (not lexical), so
   * '10.0.0' correctly outranks '9.0.0'; non-semver floors are ignored.
   */
  async highestSchemaFloor(name: string): Promise<string | null> {
    const floors = await this.backend.listSchemaFloors(name);
    let highest: string | null = null;
    for (const floor of floors) {
      if (validSemver(floor) === null) continue;
      if (highest === null || gt(floor, highest)) highest = floor;
    }
    return highest;
  }
}

/**
 * The production/integration backend: Drizzle against the shared `db` pool, with
 * every operation forced into system DB scope so the FORCE-RLS system-only
 * policy admits it.
 */
export class DrizzleExtensionStateBackend implements ExtensionStateBackend {
  /**
   * Run one operation under a GENUINELY system-scoped DB context.
   *
   * `withDbAccessContext` short-circuits (`return fn()`) when a context is
   * already open, so a bare `withSystemDbAccessContext` inside an ambient
   * TENANT context does NOT escalate — it silently inherits the caller's scope.
   * `installed_extensions` / `extension_schema_history` are FORCE-RLS with a
   * system-only policy, so every read would then be filtered to ZERO ROWS and
   * every write would match zero rows, both WITHOUT erroring: `isEnabled` would
   * return false forever on the request path (agent routes, AI-tool gate) and a
   * platform-admin enable/disable would no-op while returning 200.
   *
   * `runOutsideDbContext` exits both the tx-routing and metadata stores first,
   * so the nested `withSystemDbAccessContext` opens a real fresh transaction
   * that actually sets `breeze.scope='system'`. This is the repo's canonical
   * escalation idiom (see oauth/adapter.ts, routes/lifecycle.ts,
   * jobs/contractWorker.ts, services/scriptBuilderTools.ts).
   */
  private asSystem<T>(fn: () => Promise<T>): Promise<T> {
    return runOutsideDbContext(() => withSystemDbAccessContext(fn));
  }

  async upsertObserved(input: ObservedExtensionInput): Promise<void> {
    // Only the fields the caller actually supplied are written on conflict, so
    // an observation carrying just a digest can't null out a previously-recorded
    // version. `updated_at` always advances; `enabled`/`lifecycle_state` are
    // never in the conflict SET, so they survive re-observation untouched.
    const set = {
      updatedAt: sql`now()`,
      ...(input.configuredVersion !== undefined ? { configuredVersion: input.configuredVersion } : {}),
      ...(input.activeVersion !== undefined ? { activeVersion: input.activeVersion } : {}),
      ...(input.digest !== undefined ? { artifactDigest: input.digest } : {}),
      ...(input.publisher !== undefined ? { publisherId: input.publisher } : {}),
      ...(input.manifestApiVersion !== undefined ? { manifestApiVersion: input.manifestApiVersion } : {}),
      ...(input.serverSdkVersion !== undefined ? { serverSdkVersion: input.serverSdkVersion } : {}),
      ...(input.webSdkVersion !== undefined ? { webSdkVersion: input.webSdkVersion } : {}),
    };

    await this.asSystem(async () => {
      await db
        .insert(installedExtensions)
        .values({
          name: input.name,
          configuredVersion: input.configuredVersion ?? null,
          activeVersion: input.activeVersion ?? null,
          artifactDigest: input.digest ?? null,
          publisherId: input.publisher ?? null,
          manifestApiVersion: input.manifestApiVersion ?? null,
          serverSdkVersion: input.serverSdkVersion ?? null,
          webSdkVersion: input.webSdkVersion ?? null,
          lifecycleState: 'discovered',
        })
        .onConflictDoUpdate({ target: installedExtensions.name, set });
    });
  }

  async setEnabled(name: string, enabled: boolean): Promise<void> {
    await this.asSystem(async () => {
      await db
        .update(installedExtensions)
        .set({ enabled, updatedAt: sql`now()` })
        .where(eq(installedExtensions.name, name));
    });
  }

  async getRow(name: string): Promise<ExtensionStateRecord | null> {
    return this.asSystem(async () => {
      const [row] = await db
        .select()
        .from(installedExtensions)
        .where(eq(installedExtensions.name, name))
        .limit(1);
      return row ?? null;
    });
  }

  async listRows(): Promise<ExtensionStateRecord[]> {
    return this.asSystem(async () => {
      return db
        .select()
        .from(installedExtensions)
        .orderBy(installedExtensions.name);
    });
  }

  async recordFailure(
    name: string,
    state: Extract<ExtensionLifecycleState, 'failed' | 'incompatible'>,
    category: string,
    message: string,
  ): Promise<void> {
    await this.asSystem(async () => {
      await db
        .update(installedExtensions)
        .set({
          lifecycleState: state,
          lastErrorCategory: category,
          lastErrorMessage: message,
          updatedAt: sql`now()`,
        })
        .where(eq(installedExtensions.name, name));
    });
  }

  async recordActive(name: string, activeVersion: string | null): Promise<void> {
    // Only pin active_version when the caller supplied one — a bare "it's live"
    // signal must not blank an already-recorded active version.
    const set = {
      lifecycleState: 'active' as const,
      lastErrorCategory: null,
      lastErrorMessage: null,
      activatedAt: sql`now()`,
      updatedAt: sql`now()`,
      ...(activeVersion !== null ? { activeVersion } : {}),
    };

    await this.asSystem(async () => {
      await db
        .update(installedExtensions)
        .set(set)
        .where(eq(installedExtensions.name, name));
    });
  }

  async insertSchemaFloor(name: string, version: string, floor: string): Promise<void> {
    await this.asSystem(async () => {
      await db
        .insert(extensionSchemaHistory)
        .values({
          extensionName: name,
          bundleVersion: version,
          schemaCompatibilityFloor: floor,
        })
        .onConflictDoUpdate({
          target: [extensionSchemaHistory.extensionName, extensionSchemaHistory.bundleVersion],
          set: { schemaCompatibilityFloor: floor, appliedAt: sql`now()` },
        });
    });
  }

  async listSchemaFloors(name: string): Promise<string[]> {
    return this.asSystem(async () => {
      const rows = await db
        .select({ floor: extensionSchemaHistory.schemaCompatibilityFloor })
        .from(extensionSchemaHistory)
        .where(eq(extensionSchemaHistory.extensionName, name));
      return rows.map((r) => r.floor);
    });
  }
}

/** Convenience: a store backed by the shared Drizzle `db` pool (system-scoped). */
export function createExtensionStateStore(): ExtensionStateStore {
  return new ExtensionStateStore(new DrizzleExtensionStateBackend());
}
