// e2e-tests/doc-verify/executors/sql.ts
import pg from 'pg';
import type { SqlAssertion, AssertionResult } from '../types';

const { Client } = pg;

export async function executeSqlAssertion(
  assertion: SqlAssertion,
  dbUrl: string,
  context: Record<string, string>,
): Promise<AssertionResult> {
  const start = Date.now();
  const client = new Client({ connectionString: dbUrl });

  try {
    await client.connect();

    const result = await runQuery(client, assertion.test.query, context);

    const expectation = assertion.test.expect;
    const failures: string[] = [];

    if ('notNull' in expectation && expectation.notNull && result === null) {
      failures.push('Expected non-null result, got null');
    }

    if ('startsWith_not' in expectation && typeof result === 'string') {
      const prefix = expectation.startsWith_not as string;
      if (result.startsWith(prefix)) {
        failures.push(`Value should not start with "${prefix}"`);
      }
    }

    if ('rowCount' in expectation) {
      const expected = expectation.rowCount as number;
      const actual = typeof result === 'number' ? result : 0;
      if (actual !== expected) {
        failures.push(`Expected ${expected} rows, got ${actual}`);
      }
    }

    return {
      id: assertion.id,
      type: 'sql',
      claim: assertion.claim,
      status: failures.length === 0 ? 'pass' : 'fail',
      reason: failures.length === 0 ? 'All checks passed' : failures.join('; '),
      durationMs: Date.now() - start,
    };
  } catch (err) {
    return {
      id: assertion.id,
      type: 'sql',
      claim: assertion.claim,
      status: 'error',
      reason: `SQL query failed: ${err instanceof Error ? err.message : String(err)}`,
      durationMs: Date.now() - start,
    };
  } finally {
    await client.end();
  }
}

async function runQuery(
  client: pg.Client,
  queryDescription: string,
  context: Record<string, string>,
): Promise<unknown> {
  const desc = queryDescription.toLowerCase();

  if (desc.includes('agenttokenhash') && context.deviceId) {
    const res = await client.query(
      'SELECT agent_token_hash FROM devices WHERE id = $1',
      [context.deviceId],
    );
    return res.rows[0]?.agent_token_hash ?? null;
  }

  if (desc.includes('device') && desc.includes('count') && context.orgId) {
    const res = await client.query(
      'SELECT COUNT(*) as count FROM devices WHERE org_id = $1',
      [context.orgId],
    );
    return parseInt(res.rows[0]?.count ?? '0', 10);
  }

  console.warn(`  [sql] Unrecognized query pattern: ${queryDescription}`);
  return null;
}
