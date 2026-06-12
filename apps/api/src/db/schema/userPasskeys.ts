import { pgTable, uuid, varchar, text, timestamp, bigint, boolean, jsonb, index } from 'drizzle-orm/pg-core';
import { users } from './users';

export type PasskeyTransport = 'ble' | 'cable' | 'hybrid' | 'internal' | 'nfc' | 'smart-card' | 'usb';

export const userPasskeys = pgTable(
  'user_passkeys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    credentialId: text('credential_id').notNull().unique(),
    publicKey: text('public_key').notNull(),
    counter: bigint('counter', { mode: 'number' }).notNull().default(0),
    deviceType: varchar('device_type', { length: 32 }).notNull(),
    backedUp: boolean('backed_up').notNull().default(false),
    transports: jsonb('transports').$type<PasskeyTransport[]>(),
    name: varchar('name', { length: 255 }),
    aaguid: varchar('aaguid', { length: 36 }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull()
  },
  (t) => ({
    userIdx: index('user_passkeys_user_id_idx').on(t.userId)
  })
);
