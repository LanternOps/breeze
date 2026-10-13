// Self-provisions a throwaway DB when DATABASE_URL is unset (#3475). When the
// URL is already set (CI job env, or a .env.test from `pnpm test-stack up`)
// this is a no-op and the suites run against exactly that database.
import { provisionTestDb } from './src/__tests__/support/provisionTestDb';

export default async function globalSetup(): Promise<(() => Promise<void>) | void> {
  if (process.env.DATABASE_URL) return;
  if (process.env.DATABASE_URL_APP) {
    throw new Error('DATABASE_URL_APP is set but DATABASE_URL is not — set both or neither');
  }

  const db = await provisionTestDb();
  process.env.DATABASE_URL = db.databaseUrl;
  process.env.DATABASE_URL_APP = db.databaseUrlApp;
  console.log(`[ee/workspace integration] provisioned ${db.dbName}`);

  return async () => {
    await db.drop();
    console.log(`[ee/workspace integration] dropped ${db.dbName}`);
  };
}
