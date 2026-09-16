#!/usr/bin/env tsx
/** Trusted database-operator shell tool. Each invocation is scoped to one
 * explicit org/site and recorded in the sealed audit chain. Not an API auth
 * bypass: do not expose this entry point to application requests. */
import { randomUUID } from 'node:crypto';
import { userInfo } from 'node:os';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { db, closeDb, runOutsideDbContext, withDbAccessContext } from '../src/db';
import { auditLogs } from '../src/db/schema';
import { compareLegacyTopology, drainTopologyOutbox, getLegacyTopologyStatus, getTopologyCaptureStatus, importLegacyTopologySite } from '../src/services/topology/legacyImport';
import { legacyRevisionSchema } from '../src/services/topology/legacyProjection';
import { retryableTopologyTransaction } from '../src/jobs/topologyOutboxWorker';

const optionsSchema = z.object({ command: z.enum(['capture-status', 'backfill', 'drain', 'compare', 'status']),
  orgId: z.string().uuid(), siteId: z.string().uuid(), batchSize: z.coerce.number().int().min(1).max(1000).default(200),
  resumeToken: z.string().uuid().optional(), throughRevision: legacyRevisionSchema.optional(),
}).strict();
export type TopologyMigrationOptions = z.infer<typeof optionsSchema>;

export function parseTopologyMigrationArgs(argv: string[]): TopologyMigrationOptions {
  const values: Record<string, unknown> = { command: argv[0] };
  const names: Record<string, string> = { '--org': 'orgId', '--site': 'siteId', '--batch-size': 'batchSize', '--resume': 'resumeToken', '--through': 'throughRevision' };
  for (let index = 1; index < argv.length; index += 2) {
    const name = names[argv[index]!];
    if (!name || values[name] !== undefined || !argv[index + 1] || argv[index + 1]!.startsWith('--')) throw new Error('Invalid or duplicate topology migration option');
    values[name] = argv[index + 1];
  }
  const result = optionsSchema.parse(values);
  if (result.resumeToken && result.command !== 'backfill') throw new Error('--resume is only valid for backfill');
  if (result.throughRevision && !['drain', 'compare'].includes(result.command)) throw new Error('--through is only valid for drain or compare');
  return result;
}

export async function executeTopologyMigration(options: TopologyMigrationOptions): Promise<{ exitCode: number; report: unknown }> {
  const scope = { orgId: options.orgId, siteId: options.siteId };
  switch (options.command) {
    case 'capture-status': {
      const report = await getTopologyCaptureStatus(scope);
      return { exitCode: report.complete ? 0 : 2, report };
    }
    case 'backfill': {
      const report = await importLegacyTopologySite(scope, { batchSize: options.batchSize, resumeToken: options.resumeToken });
      return { exitCode: report.complete ? 0 : 2, report };
    }
    case 'drain': {
      const report = await drainTopologyOutbox(scope, { throughRevision: options.throughRevision, batchSize: options.batchSize });
      return { exitCode: report.complete ? 0 : 2, report };
    }
    case 'compare': {
      const report = await compareLegacyTopology(scope, { throughRevision: options.throughRevision });
      return { exitCode: report.ok ? 0 : 2, report };
    }
    case 'status': return { exitCode: 0, report: await getLegacyTopologyStatus(scope) };
  }
}

export async function runTopologyMigration(options: TopologyMigrationOptions) {
  const invocationId = randomUUID();
  const operator = userInfo().username.slice(0, 128);
  const context = { scope: 'organization' as const, orgId: options.orgId, accessibleOrgIds: [options.orgId], accessiblePartnerIds: [], userId: null };
  for (let attempt = 0; ; attempt++) {
    try {
      return await runOutsideDbContext(() => withDbAccessContext(context, async () => {
        const outcome = await executeTopologyMigration(options);
        await db.insert(auditLogs).values({ orgId: options.orgId, actorType: 'system', actorId: '00000000-0000-0000-0000-000000000000',
          action: `topology.migration.${options.command}`, resourceType: 'site', resourceId: options.siteId, initiatedBy: 'manual',
          result: outcome.exitCode === 0 ? 'success' : 'failure', details: { invocationId, operator, command: options.command,
            siteId: options.siteId, throughRevision: options.throughRevision ?? null, resumeToken: options.resumeToken ?? null, exitCode: outcome.exitCode } });
        return outcome;
      }));
    } catch (error) {
      if (attempt < 2 && retryableTopologyTransaction(error)) {
        await new Promise(resolve => setTimeout(resolve, 25 * (attempt + 1)));
        continue;
      }
      throw error;
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const outcome = await runTopologyMigration(parseTopologyMigrationArgs(process.argv.slice(2)));
    console.log(JSON.stringify(outcome.report));
    process.exitCode = outcome.exitCode;
  } catch (error) {
    // SQL/Zod errors may include rejected legacy content. Do not dump payloads
    // or database connection strings into an operator's JSON report.
    console.error(JSON.stringify({ error: 'topology_migration_failed', reason: error instanceof Error ? error.name : 'UnknownError',
      hint: 'Check explicit org/site, capture-status, status and the requested barrier. Backfill/drain are bounded; resume incomplete runs.' }));
    process.exitCode = 1;
  } finally {
    await closeDb();
  }
}
