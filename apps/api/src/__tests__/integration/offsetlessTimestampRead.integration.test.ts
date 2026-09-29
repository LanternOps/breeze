import './setup';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db, withSystemDbAccessContext } from '../../db';
import { users } from '../../db/schema';
import { isTokenIssuedBeforePasswordChange } from '../../services/tokenRevocation';
import { dateFromSqlValue, sqlTimestamp } from '../../services/portal/sqlTimestamp';
import { withHostTimeZone } from '../../testUtils/hostTimeZone';
import { createPartner, createUser } from './db-utils';
import { getTestDb } from './setup';

/**
 * How the API's `db` decodes a `timestamp` column declared WITHOUT
 * `withTimezone: true` (the default shape in `db/schema`), on hosts west and
 * east of UTC, against a real Postgres.
 *
 * Postgres sends such a value as an offsetless wall clock
 * (`2026-08-25 18:34:15.123`). Drizzle's postgres-js driver replaces
 * postgres.js's parser for that type with a pass-through, and the column
 * mapper then reads the string as UTC (`new Date(value + '+0000')`). A typed
 * read therefore yields the stored instant whatever the API host's zone is,
 * and code must compare it with `.getTime()` as is. Adjusting it by the
 * host's `getTimezoneOffset()` moves it away from the stored instant.
 *
 * A raw `db.execute(sql...)` result is different: it is the text itself.
 * Parse it with `sqlTimestamp` or `dateFromSqlValue` (both read it as UTC),
 * never with `new Date(text)`, which reads it in the host's zone.
 *
 * `users.password_changed_at` stands in for every offsetless column; the
 * decode is per type, not per column.
 *
 * Precondition: the stored wall clock is UTC. Drizzle writes a Date as its
 * UTC wall clock, and `defaultNow()` / `now()` store the wall clock of the
 * Postgres session's `TimeZone`, which is UTC in the stock Postgres image and
 * is not overridden by the API's connection options. The `defaultNow()` case
 * below fails if that stops being true.
 */

const STORED_WALL_CLOCK = '2026-08-25 18:34:15.123';
const STORED_INSTANT = Date.UTC(2026, 7, 25, 18, 34, 15, 123);

const HOSTS = [
  { zone: 'America/Denver', side: 'west of UTC' },
  { zone: 'Asia/Tokyo', side: 'east of UTC' },
] as const;

async function seedUserWithPasswordChangedAt(wallClock: string): Promise<string> {
  const partner = await createPartner();
  const user = await createUser({ partnerId: partner.id });
  // Written as a SQL literal, so the stored value does not depend on how the
  // API serializes a Date: this isolates the read path.
  await getTestDb().execute(
    sql`UPDATE users SET password_changed_at = ${wallClock}::timestamp WHERE id = ${user.id}`,
  );
  return user.id;
}

async function readPasswordChangedAt(userId: string): Promise<Date | null> {
  const [row] = await withSystemDbAccessContext(() =>
    db.select({ passwordChangedAt: users.passwordChangedAt }).from(users).where(eq(users.id, userId)),
  );
  return row?.passwordChangedAt ?? null;
}

async function storedText(userId: string): Promise<string> {
  const rows = await getTestDb().execute<{ text: string }>(
    sql`SELECT password_changed_at::text AS text FROM users WHERE id = ${userId}`,
  );
  return rows[0]!.text;
}

describe.each(HOSTS)('offsetless timestamp columns on an API host $side ($zone)', ({ zone }) => {
  it('a typed select returns the stored instant', async () => {
    const userId = await seedUserWithPasswordChangedAt(STORED_WALL_CLOCK);

    await withHostTimeZone(zone, async () => {
      const changedAt = await readPasswordChangedAt(userId);

      expect(changedAt).toBeInstanceOf(Date);
      expect(changedAt!.toISOString()).toBe('2026-08-25T18:34:15.123Z');
      expect(changedAt!.getTime()).toBe(STORED_INSTANT);
    });
  });

  it('a Date written through Drizzle is stored as its UTC wall clock and returned unchanged', async () => {
    const userId = await seedUserWithPasswordChangedAt(STORED_WALL_CLOCK);
    const written = Date.UTC(2026, 0, 15, 7, 5, 9, 250);

    await withHostTimeZone(zone, async () => {
      const [returned] = await withSystemDbAccessContext(() =>
        db
          .update(users)
          .set({ passwordChangedAt: new Date(written) })
          .where(eq(users.id, userId))
          .returning({ passwordChangedAt: users.passwordChangedAt }),
      );

      expect(returned!.passwordChangedAt!.getTime()).toBe(written);
      expect((await readPasswordChangedAt(userId))!.getTime()).toBe(written);
    });
    expect(await storedText(userId)).toBe('2026-01-15 07:05:09.25');
  });

  it('a column filled by defaultNow() reads back as the current instant', async () => {
    await withHostTimeZone(zone, async () => {
      const partner = await createPartner();
      const user = await createUser({ partnerId: partner.id });
      const [row] = await withSystemDbAccessContext(() =>
        db.select({ createdAt: users.createdAt }).from(users).where(eq(users.id, user.id)),
      );

      // Minutes of slack for a slow runner; a zone error is hours.
      expect(Math.abs(row!.createdAt.getTime() - Date.now())).toBeLessThan(5 * 60_000);
    });
  });

  it('a raw db.execute returns the offsetless text, which the sqlTimestamp helpers read as UTC', async () => {
    const userId = await seedUserWithPasswordChangedAt(STORED_WALL_CLOCK);

    await withHostTimeZone(zone, async () => {
      const rows = await withSystemDbAccessContext(() =>
        db.execute<{ password_changed_at: unknown }>(
          sql`SELECT password_changed_at FROM users WHERE id = ${userId}`,
        ),
      );
      const raw = rows[0]!.password_changed_at;

      expect(raw).toBe(STORED_WALL_CLOCK);
      expect(sqlTimestamp(raw as string)!.getTime()).toBe(STORED_INSTANT);
      expect(dateFromSqlValue(raw as string).getTime()).toBe(STORED_INSTANT);
      // `new Date(text)` reads the same text in the host's zone instead.
      expect(new Date(raw as string).getTime() - STORED_INSTANT)
        .toBe(new Date(STORED_INSTANT).getTimezoneOffset() * 60_000);
    });
  });

  it('password-change checks compare a token against the stored change instant', async () => {
    const userId = await seedUserWithPasswordChangedAt(STORED_WALL_CLOCK);
    const changeSeconds = Math.floor(STORED_INSTANT / 1000);

    await withHostTimeZone(zone, async () => {
      const changedAt = await readPasswordChangedAt(userId);

      // Issued an hour before the change: must be rejected.
      expect(isTokenIssuedBeforePasswordChange(changeSeconds - 3600, changedAt)).toBe(true);
      // Issued an hour after the change: must be accepted.
      expect(isTokenIssuedBeforePasswordChange(changeSeconds + 3600, changedAt)).toBe(false);
    });
  });
});
