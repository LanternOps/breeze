import { config } from 'dotenv';
// Load .env from monorepo root (when running from apps/api) or cwd (when running from root)
config({ path: '../../.env' });
config(); // Also try cwd

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

const connectionString = process.env.DATABASE_URL || 'postgresql://breeze:breeze@localhost:5432/breeze';

const client = postgres(connectionString);

export const db = drizzle(client, { schema });

export type Database = typeof db;
