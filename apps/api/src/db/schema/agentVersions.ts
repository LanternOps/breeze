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
  // Release edition ("self-host" | "hosted"): lets the same version/platform/
  // arch/component coexist as two distinct binaries (the public self-host
  // release build vs a privately-distributed hosted build). Each server only
  // serves/promotes rows matching its own BINARY_EDITION (binaryEdition.ts).
  edition: varchar('edition', { length: 20 }).notNull().default('self-host'),
  createdAt: timestamp('created_at').defaultNow().notNull()
}, (table) => ({
  // Composite unique constraint on (version, platform, architecture, component, edition)
  versionPlatformArchComponentUnique: unique('agent_versions_version_platform_arch_component_edition_unique').on(
    table.version,
    table.platform,
    table.architecture,
    table.component,
    table.edition
  ),
  // Index on isLatest for fast lookups of latest versions
  isLatestIdx: index('agent_versions_is_latest_idx').on(table.isLatest),
  editionIdx: index('agent_versions_edition_idx').on(table.edition)
}));
