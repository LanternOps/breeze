export interface TestDatabaseSafetyEnvironment {
  nodeEnv?: string;
  breezeTestDbUrl?: string;
}

const ALLOWED_TEST_DB_NAME_RE = /^breeze_test(_[a-z0-9]+)?$/u;
const ALLOWED_TEST_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '[::1]',
  'breeze-postgres-test',
  'postgres-test',
]);
const FORBIDDEN_TEST_PORTS = new Set(['5432']);

export function assertTestDatabaseUrlSafe(
  connectionUrl: string,
  operation: string,
  environment: TestDatabaseSafetyEnvironment = {
    nodeEnv: process.env.NODE_ENV,
    breezeTestDbUrl: process.env.BREEZE_TEST_DB_URL,
  },
): void {
  const failures: string[] = [];
  let parsed: URL | undefined;

  try {
    parsed = new URL(connectionUrl);
  } catch {
    failures.push('connection URL is not parseable');
  }

  if (parsed) {
    if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
      failures.push('connection URL must use postgres:// or postgresql://');
    }

    const databaseName = parsed.pathname.replace(/^\//u, '');
    if (!ALLOWED_TEST_DB_NAME_RE.test(databaseName)) {
      failures.push('database name must match /^breeze_test(_[a-z0-9]+)?$/');
    }
    if (!ALLOWED_TEST_HOSTS.has(parsed.hostname)) {
      failures.push('host is not in the local-test allowlist');
    }
    if (FORBIDDEN_TEST_PORTS.has(parsed.port || '5432')) {
      failures.push('port is the default development/production PostgreSQL port');
    }
  }

  if (
    environment.nodeEnv !== 'test'
    && environment.breezeTestDbUrl !== connectionUrl
  ) {
    failures.push(
      'operator opt-in requires NODE_ENV=test or BREEZE_TEST_DB_URL to exactly match the connection URL',
    );
  }

  if (failures.length > 0) {
    throw new Error(
      `Integration test ${operation} refused — database target failed safety checks:\n`
      + failures.map((failure) => `  - ${failure}`).join('\n'),
    );
  }
}
