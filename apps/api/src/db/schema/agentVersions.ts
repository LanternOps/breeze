import { pgTable, uuid, varchar, text, timestamp, boolean, bigint, unique, index } from 'drizzle-orm/pg-core';

export const agentVersions = pgTable('agent_versions', {
  id: uuid('id').primaryKey().defaultRandom(),
  version: varchar('version', { length: 20 }).notNull(),
  platform: varchar('platform', { length: 20 }).notNull(), // windows, macos, linux
  architecture: varchar('architecture', { length: 20 }).notNull(), // amd64, arm64
  downloadUrl: text('download_url').notNull(),
  checksum: varchar('checksum', { length: 64 }).notNull(), // SHA256
  releaseManifest: text('release_manifest'),
  manifestSignature: text('manifest_signature'),
  signingKeyId: varchar('signing_key_id', { length: 128 }),
  fileSize: bigint('file_size', { mode: 'bigint' }),
  releaseNotes: text('release_notes'),
  isLatest: boolean('is_latest').notNull().default(false),
  component: varchar('component', { length: 20 }).notNull().default('agent'), // agent, helper, viewer
  createdAt: timestamp('created_at').defaultNow().notNull()
}, (table) => ({
  // Composite unique constraint on (version, platform, architecture, component)
  versionPlatformArchComponentUnique: unique('agent_versions_version_platform_arch_component_unique').on(
    table.version,
    table.platform,
    table.architecture,
    table.component
  ),
  // Index on isLatest for fast lookups of latest versions
  isLatestIdx: index('agent_versions_is_latest_idx').on(table.isLatest)
}));
