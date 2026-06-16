import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  integer,
  boolean,
  jsonb,
  index,
  pgEnum,
} from 'drizzle-orm/pg-core';
import { users } from './users';

export const authenticatorKindEnum = pgEnum('authenticator_kind', [
  'mobile_hw_key',
  'webauthn_platform',
]);

export type AuthenticatorTransport =
  | 'ble' | 'cable' | 'hybrid' | 'internal' | 'nfc' | 'smart-card' | 'usb';

export const authenticatorDevices = pgTable(
  'authenticator_devices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    kind: authenticatorKindEnum('kind').notNull(),
    label: varchar('label', { length: 255 }),
    publicKey: text('public_key').notNull(),
    // WebAuthn credential id (web only); null for mobile_hw_key.
    credentialId: text('credential_id').unique(),
    // Anti-clone counter (web) / monotonic nonce counter (mobile).
    signCount: integer('sign_count').notNull().default(0),
    aaguid: varchar('aaguid', { length: 36 }),
    transports: jsonb('transports').$type<AuthenticatorTransport[]>(),
    // True = non-syncable hardware key (eligible for L4 critical). For
    // webauthn_platform this is derived from a verified attestation
    // (singleDevice && !backedUp). For mobile_hw_key it is CLIENT-ASSERTED, not
    // server-attested — future L4 gating that trusts this for mobile keys must
    // verify a platform attestation first.
    isPlatformBound: boolean('is_platform_bound').notNull(),
    // FK to mobile_devices added in the migration (kept loose here to avoid a
    // schema import cycle); null for webauthn_platform.
    mobileDeviceId: uuid('mobile_device_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
    disabledReason: text('disabled_reason'),
  },
  (t) => ({
    userIdx: index('authenticator_devices_user_id_idx').on(t.userId),
  }),
);

export type AuthenticatorDevice = typeof authenticatorDevices.$inferSelect;
export type NewAuthenticatorDevice = typeof authenticatorDevices.$inferInsert;
