import {
  pgTable,
  uuid,
  boolean,
  varchar,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { organizations } from './orgs';
import { configPolicyFeatureLinks } from './configurationPolicies';

export const configPolicyOnedriveSettings = pgTable('config_policy_onedrive_settings', {
  id: uuid('id').primaryKey().defaultRandom(),
  featureLinkId: uuid('feature_link_id').notNull()
    .references(() => configPolicyFeatureLinks.id, { onDelete: 'cascade' }),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  silentAccountConfig: boolean('silent_account_config').notNull().default(true),
  filesOnDemand: boolean('files_on_demand').notNull().default(true),
  kfmSilentOptIn: boolean('kfm_silent_opt_in').notNull().default(false),
  kfmFolders: jsonb('kfm_folders').notNull().default(['Desktop', 'Documents', 'Pictures']),
  kfmBlockOptOut: boolean('kfm_block_opt_out').notNull().default(false),
  tenantAssociationId: varchar('tenant_association_id', { length: 64 }),
  restartOnChange: boolean('restart_on_change').notNull().default(true),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (t) => ({
  featureLinkUniq: uniqueIndex('onedrive_settings_feature_link_uniq').on(t.featureLinkId),
  orgIdx: index('onedrive_settings_org_idx').on(t.orgId),
}));
