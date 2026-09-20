// M1 Task 2 — mechanical registry contract for the collection persistence
// tables (topology_interfaces, topology_collection_sources,
// topology_collection_runs, topology_observations,
// topology_relationship_support). Per CLAUDE.md's "Cascade registration"
// contract, this is the check code review has caught 0/5 times and contract
// tests 5/5 — asserted here so it fails fast in the unit job, not only under
// the real-DB tenantCascade.integration.test.ts / tenant-export-policy
// integration suites. Modeled on
// apps/api/src/db/schema/aiAgentOpEvidence.registry.test.ts.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { LIFECYCLE_VALUES } from '@breeze/shared';
import { getOrgCascadeDeleteOrder, ORG_CASCADE_DELETE_ORDER } from '../services/tenantCascade';
import { CORE_TENANT_EXPORT_POLICY } from '../services/tenantExportPolicyRegistry';
import { __testOnly as orgMergeRegistryTestOnly } from '../services/orgMergeRegistry';
import { checkConstraintLiterals } from './schema/checkConstraintTestHelpers';
import {
  topologyInterfaces,
  topologyCollectionSources,
  topologyCollectionRuns,
  topologyObservations,
  topologyRelationshipSupport,
} from './schema/topologyCollections';

const M1_COLLECTION_TABLES = [
  'topology_interfaces',
  'topology_collection_sources',
  'topology_collection_runs',
  'topology_observations',
  'topology_relationship_support',
] as const;

const MIGRATION_SQL = readFileSync(
  new URL('../../migrations/2026-10-22-170400-topology-m1-collection.sql', import.meta.url),
  'utf8',
);

describe('Topology M1 collection persistence registries (Task 2)', () => {
  it('getOrgCascadeDeleteOrder() contains every M1 collection table exactly once, sorted with organizations last', () => {
    const order = getOrgCascadeDeleteOrder();
    for (const table of M1_COLLECTION_TABLES) {
      const occurrences = order.filter((t) => t === table);
      expect(occurrences, `${table} should appear exactly once`).toHaveLength(1);
    }
    const withoutLast = order.slice(0, -1);
    const sorted = [...withoutLast].sort((a, b) => a.localeCompare(b));
    expect(withoutLast).toEqual(sorted);
    expect(order[order.length - 1]).toBe('organizations');
  });

  it('the raw CORE_ORG_CASCADE_DELETE_ORDER list does not insert any M1 collection table twice', () => {
    for (const table of M1_COLLECTION_TABLES) {
      const occurrences = ORG_CASCADE_DELETE_ORDER.filter((t) => t === table);
      expect(occurrences, `${table} should appear exactly once in the raw list`).toHaveLength(1);
    }
  });

  it('CORE_TENANT_EXPORT_POLICY has an entry for every M1 collection table', () => {
    for (const table of M1_COLLECTION_TABLES) {
      expect(CORE_TENANT_EXPORT_POLICY[table], `${table} missing an export policy entry`).toBeDefined();
    }
  });

  // The export-policy row is the one that fires on a new COLUMN, not just a
  // new table (CLAUDE.md). Every open-ended JSON/JSONB column on these
  // tables must be excludedOpen: a scope/capability-shaped jsonb column
  // cannot be `included` even when its contents look harmless.
  it('every jsonb column on the M1 collection tables is classified excludedOpen', () => {
    const openColumnsByTable: Record<string, string[]> = {
      topology_interfaces: ['addresses'],
      topology_collection_sources: ['current_baseline', 'published_baseline', 'pending_misses', 'retry_candidate'],
      topology_collection_runs: ['completion_scope', 'snapshot'],
      topology_observations: ['attributes'],
      topology_relationship_support: [],
    };
    for (const [table, columns] of Object.entries(openColumnsByTable)) {
      const policy = CORE_TENANT_EXPORT_POLICY[table];
      expect(policy, `${table} missing an export policy entry`).toBeDefined();
      for (const column of columns) {
        expect(policy!.columns[column]?.decision, `${table}.${column} should be excluded`).toBe('exclude');
        expect(
          policy!.columns[column]?.openContainerReviewed,
          `${table}.${column} should be reviewed as an open container`,
        ).toBe(true);
      }
    }
  });

  it('topologyInterfaces exposes every column named in the migration', () => {
    const expectedKeys = [
      'id', 'orgId', 'siteId', 'ownerNodeId', 'interfaceKey', 'epoch', 'kind', 'role', 'name', 'alias',
      'osIndex', 'addresses', 'controllerPortKey', 'parentInterfaceId', 'lastObservedAt', 'lastOutcome',
      'createdAt', 'updatedAt',
    ];
    for (const key of expectedKeys) {
      expect(topologyInterfaces, `topologyInterfaces.${key} should exist`).toHaveProperty(key);
    }
  });

  it('topologyCollectionSources exposes every column named in the migration', () => {
    const expectedKeys = [
      'id', 'orgId', 'siteId', 'producerId', 'producerKind', 'producerEpoch', 'epochIssuedAt',
      'configurationRevision', 'protocol', 'contextKey', 'addressFamily', 'acceptedSequence',
      'materializedSequence', 'confirmedSequence', 'contentDigest', 'publishedDigest', 'digestVersion',
      'baseSnapshotId', 'currentBaseline', 'publishedBaseline', 'pendingMisses', 'firstBaselineAt',
      'lastFullValidationAt', 'confirmedThroughAt', 'freshUntil', 'expectedIntervalSeconds', 'lastOutcome',
      'lastReceivedAt', 'admissionTokens', 'admissionRefillAt', 'quotaRejectedCount', 'retryCandidate',
      'revokedAt', 'createdAt', 'updatedAt',
    ];
    for (const key of expectedKeys) {
      expect(topologyCollectionSources, `topologyCollectionSources.${key} should exist`).toHaveProperty(key);
    }
  });

  it('topologyCollectionRuns exposes every column named in the migration', () => {
    const expectedKeys = [
      'id', 'orgId', 'siteId', 'sourceId', 'producerId', 'producerEpoch', 'sequence', 'snapshotId',
      'contentDigest', 'digestVersion', 'parentJobId', 'parentCommandId', 'observedAt', 'effectiveAt',
      'receivedAt', 'outcome', 'completionScope', 'snapshot', 'rowCount', 'omittedRowCount',
      'normalizedBytes', 'expectedIntervalSeconds', 'materializedAt', 'createdAt', 'updatedAt',
    ];
    for (const key of expectedKeys) {
      expect(topologyCollectionRuns, `topologyCollectionRuns.${key} should exist`).toHaveProperty(key);
    }
  });

  it('topologyObservations exposes every column named in the migration', () => {
    const expectedKeys = [
      'id', 'orgId', 'siteId', 'runId', 'observationKey', 'subjectNodeId', 'subjectInterfaceId',
      'relationshipId', 'method', 'evidenceClass', 'attributes', 'observedAt', 'effectiveAt', 'receivedAt',
      'freshUntil', 'withdrawnAt', 'createdAt', 'updatedAt',
    ];
    for (const key of expectedKeys) {
      expect(topologyObservations, `topologyObservations.${key} should exist`).toHaveProperty(key);
    }
  });

  it('topologyRelationshipSupport exposes every column named in the migration', () => {
    const expectedKeys = [
      'orgId', 'siteId', 'relationshipId', 'sourceId', 'latestObservationId', 'producerEpoch', 'sequence',
      'contentDigest', 'firstPositiveAt', 'lastPositiveAt', 'effectiveAt', 'freshUntil', 'completeMissCount',
      'lastMissSequence', 'lastMissAt', 'lifecycle', 'createdAt', 'updatedAt',
    ];
    for (const key of expectedKeys) {
      expect(topologyRelationshipSupport, `topologyRelationshipSupport.${key} should exist`).toHaveProperty(key);
    }
  });

  // org-merge registration (5th list, per the tenancy section): every M1
  // collection table must be classified so a merge either repoints org_id or
  // is explicitly reviewed — an unregistered table would abort the merge
  // (missing) or silently strand rows (wrongly omitted).
  it('orgMergeRegistry classifies every M1 collection table (repoint or explicit SPECIAL policy)', () => {
    const { SPECIAL, REPOINT_TABLES } = orgMergeRegistryTestOnly;
    for (const table of M1_COLLECTION_TABLES) {
      const inRepoint = REPOINT_TABLES.includes(table);
      const inSpecial = Object.prototype.hasOwnProperty.call(SPECIAL, table);
      expect(
        inRepoint || inSpecial,
        `${table} must be registered in orgMergeRegistry (REPOINT_TABLES default rewrite, or SPECIAL with an explicit policy)`,
      ).toBe(true);
      // A table should not be double-registered under both lists.
      expect(inRepoint && inSpecial, `${table} is registered in both REPOINT_TABLES and SPECIAL`).toBe(false);
    }
  });

  // Pin the migration's shared CHECK constraint against the @breeze/shared
  // enum the Drizzle `.$type<Lifecycle>()` narrowing relies on.
  describe('CHECK constraints match @breeze/shared literals exactly', () => {
    it('topology_support_lifecycle_chk matches LIFECYCLE_VALUES', () => {
      const literals = checkConstraintLiterals(MIGRATION_SQL, 'topology_support_lifecycle_chk', 'lifecycle');
      expect([...literals].sort()).toEqual([...LIFECYCLE_VALUES].sort());
    });
  });
});
