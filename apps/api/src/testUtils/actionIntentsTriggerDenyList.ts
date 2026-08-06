/**
 * Shared derivation of the `action_intents_block_content_update()` deny-list.
 *
 * The immutability trigger's function is CREATE OR REPLACE'd by more than one
 * migration (2026-07-18 created it; 2026-08-06-e added the origin-principal
 * columns; 2026-08-14 added approval_scope/classification_version/
 * effect_digest). Reading only the 2026-07-18 file tests the trigger as it
 * existed in July, not as it exists today, and that is exactly how
 * origin_principal_kind/origin_principal_id shipped with zero immutability
 * coverage.
 *
 * So: DISCOVER every migration that (re)defines the function, in localeCompare
 * (= apply) order, and treat the LAST one as the effective definition. A future
 * migration that extends the deny-list is picked up automatically.
 *
 * This lives in `testUtils/` rather than being duplicated into the two suites
 * that need it on purpose. Two consumers derive the deny-list:
 *
 *   - `src/db/migration-action-intents.test.ts` (unit runner, blocking
 *     `test-api` job) asserts the parsed list EQUALS a hand-written one.
 *   - `src/__tests__/integration/actionIntentsImmutabilityTrigger.integration.test.ts`
 *     (blocking `integration-test` job) asserts it has one live-Postgres
 *     rejecting-UPDATE case per column, and that the function actually
 *     installed in the database agrees with the migration file.
 *
 * Two divergent copies of this parser would let one of those suites go
 * silently vacuous — precisely the drift class the whole arrangement exists
 * to prevent — so it is one module with two importers.
 *
 * Test-only: imported exclusively from `*.test.ts` files. Nothing in the
 * request/worker path reads the migrations directory at runtime.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const MIGRATIONS_DIR = join(__dirname, '../../migrations');

export const TRIGGER_FUNCTION_NAME = 'action_intents_block_content_update';

export const CREATE_TRIGGER_FUNCTION_RE = new RegExp(
  `CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+${TRIGGER_FUNCTION_NAME}`,
  'i',
);

/** Drops `--` comment lines so prose about the trigger is never mistaken for a definition. */
export function stripSqlComments(source: string): string {
  return source
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
}

/** Every migration that CREATEs or CREATE OR REPLACEs the trigger function, in apply order. */
export const TRIGGER_MIGRATION_FILES = readdirSync(MIGRATIONS_DIR)
  .filter((filename) => /^\d{4}-.*\.sql$/.test(filename))
  .sort((a, b) => a.localeCompare(b))
  .filter((filename) =>
    CREATE_TRIGGER_FUNCTION_RE.test(
      stripSqlComments(readFileSync(join(MIGRATIONS_DIR, filename), 'utf8')),
    ),
  );

/** The last (= effective) definition of the trigger function. */
export const EFFECTIVE_TRIGGER_MIGRATION =
  TRIGGER_MIGRATION_FILES[TRIGGER_MIGRATION_FILES.length - 1]!;

/**
 * Slices out the body of a `action_intents_block_content_update()` definition,
 * from the CREATE ... FUNCTION header up to the RAISE EXCEPTION that ends the
 * guard condition. Deliberately anchored on the RAISE rather than the
 * `$$ LANGUAGE plpgsql;` terminator: the original 2026-07-18 definition ends
 * `END $$ LANGUAGE plpgsql;` and the later ones end `END;\n$$ LANGUAGE plpgsql;`,
 * so the RAISE is the only marker common to every version.
 */
export function extractTriggerGuard(source: string): string {
  const start = source.search(CREATE_TRIGGER_FUNCTION_RE);
  const end = source.indexOf("RAISE EXCEPTION 'action_intents content is immutable'", start);
  if (start < 0 || end < 0) {
    throw new Error(
      `could not locate the ${TRIGGER_FUNCTION_NAME}() guard body — the definition's shape changed, ` +
        'update extractTriggerGuard() rather than deleting the drift gate it feeds',
    );
  }
  return source.slice(start, end);
}

/**
 * The set of columns the trigger actually guards, parsed out of a definition
 * body. This is what makes the suites drift-proof: the hand-written expected
 * list (unit suite) and the behavioral-case map (integration suite) are each
 * asserted EQUAL to this, so the next column added to the trigger fails a test
 * instead of silently going untested.
 */
export function parseDenyListedColumns(guardBody: string): string[] {
  const matches = guardBody.matchAll(/NEW\.(\w+)\s+IS\s+DISTINCT\s+FROM\s+OLD\.\1\b/gi);
  return [...matches].map((match) => match[1]!.toLowerCase()).sort();
}

/** The deny-list as of the LAST migration that defines the trigger function. */
export const DENY_LISTED_COLUMNS = parseDenyListedColumns(
  extractTriggerGuard(readFileSync(join(MIGRATIONS_DIR, EFFECTIVE_TRIGGER_MIGRATION), 'utf8')),
);
