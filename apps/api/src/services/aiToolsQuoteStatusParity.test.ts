import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { quoteStatusSchema } from '@breeze/shared';

/**
 * Drift guard: the `list_quotes` AI tool declares its `status` filter in THREE
 * hand-written places, each in a different shape (JSON Schema for the legacy
 * registry, Zod for the validator map, Zod again for the Agent-SDK tool). None
 * of them derives from `quoteStatusSchema`, and the existing registry-parity
 * suites only assert the tool is REGISTERED — never that these arrays agree.
 *
 * That gap is not hypothetical: adding the 'superseded' status updated one copy
 * and left the other two behind, and only a manual grep caught it. An agent
 * filtering by a status the database can emit would have hit a Zod validation
 * error. This test is what makes the next status addition fail loudly instead.
 *
 * Deliberately source-scanned rather than imported. Two of the three literals
 * are buried inside a `tool(...)` call and a JSON-Schema object with no exported
 * handle, and reaching them at runtime would mean either refactoring production
 * code purely for testability or reflecting through Zod internals (`._def`) that
 * change between minor versions. Reading the text is the stable option, and it
 * follows the precedent set by queryParams.test.ts, which scans route sources
 * for a forbidden validator. Fragile only against reformatting of these exact
 * lines, which is the thing we want to notice anyway.
 */

const API_SRC = join(__dirname, '..', '..', 'src', 'services');

interface Copy {
  file: string;
  /** Anchor identifying the list_quotes declaration; the enum must follow it. */
  anchor: string;
  /** Matches the status enum literal that follows the anchor. */
  pattern: RegExp;
}

const COPIES: Copy[] = [
  {
    file: 'aiToolsQuotes.ts',
    anchor: "'list_quotes'",
    // JSON Schema form: enum: ['draft', ...]
    pattern: /enum:\s*\[([^\]]*)\]/,
  },
  {
    file: 'aiToolSchemas.ts',
    anchor: 'list_quotes: z.object({',
    // Zod form: status: z.enum([...]).optional()
    pattern: /status:\s*z\.enum\(\[([^\]]*)\]\)/,
  },
  {
    file: 'aiAgentSdkTools.ts',
    anchor: "'list_quotes'",
    pattern: /status:\s*z\.enum\(\[([^\]]*)\]\)/,
  },
];

/** Pull the status enum members declared for list_quotes out of one source file. */
function readDeclaredStatuses(copy: Copy): string[] {
  const src = readFileSync(join(API_SRC, copy.file), 'utf8');
  const anchorAt = src.indexOf(copy.anchor);
  expect(
    anchorAt,
    `${copy.file}: could not find the list_quotes anchor ${copy.anchor} — this guard needs updating`,
  ).toBeGreaterThan(-1);

  const match = copy.pattern.exec(src.slice(anchorAt));
  expect(
    match,
    `${copy.file}: found list_quotes but no status enum after it — this guard needs updating`,
  ).not.toBeNull();

  const members = match?.[1];
  expect(
    members,
    `${copy.file}: status enum matched but captured nothing — this guard needs updating`,
  ).toBeDefined();

  return members!
    .split(',')
    .map((raw) => raw.trim().replace(/^['"]|['"]$/g, ''))
    .filter((value) => value.length > 0);
}

describe('list_quotes status enum parity across all AI tool declarations', () => {
  const canonical = [...quoteStatusSchema.options].sort();

  it.each(COPIES.map((copy) => [copy.file, copy] as const))(
    '%s declares exactly the shared quoteStatusSchema statuses',
    (_file, copy) => {
      expect([...readDeclaredStatuses(copy)].sort()).toEqual(canonical);
    },
  );

  it('all three copies agree with each other', () => {
    const [first, ...rest] = COPIES.map((copy) => [...readDeclaredStatuses(copy)].sort());
    for (const other of rest) expect(other).toEqual(first);
  });

  it('the guard is actually reading enums, not matching an empty array', () => {
    // Guards the regexes themselves: a pattern that silently matched nothing
    // would make every assertion above vacuously compare [] to [].
    expect(canonical.length).toBeGreaterThan(1);
    for (const copy of COPIES) {
      expect(readDeclaredStatuses(copy).length, `${copy.file} parsed no statuses`).toBe(canonical.length);
    }
  });
});
