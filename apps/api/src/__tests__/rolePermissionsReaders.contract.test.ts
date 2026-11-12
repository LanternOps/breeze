import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * CONTRACT (#11702): what a role grants is decided in ONE place.
 *
 * Since #9600 a role grants its own `role_permissions` rows plus every
 * validated ancestor's ("Inherit From"), through the walk in
 * services/roleInheritance.ts. Any other code that reads `role_permissions`
 * for a role id sees only the role's own rows, so it disagrees with the
 * runtime gate for an inherited-only grant: a forward check under-grants, a
 * reverse lookup ("who holds X") under-lists, an access review under-reports.
 * Fourteen such readers existed when #9600 landed; this ratchet stops the
 * fifteenth.
 *
 * Every non-test file that touches the table (comments stripped) must be
 * listed below with the number of touch sites it has and why it may touch the
 * table directly. A new reader fails here: route it through
 * getRolePermissionGrants / getRolesPermissionGrants / getRoleGrantRows /
 * expandToInheritingRoleIds / getRoleIdsHoldingPermission instead. A new
 * site in an allowlisted file fails too (the count is pinned), so a writer
 * cannot quietly grow a read.
 */
type Allowed = { sites: number; kind: 'resolver' | 'admin-crud' | 'writer'; reason: string };

const ALLOWED: Record<string, Allowed> = {
  'apps/api/src/services/roleInheritance.ts': {
    sites: 4,
    kind: 'resolver',
    reason: 'THE resolver: lineage grant reads, provenance for the role editor, and the wildcard-aware direct-grantor seed of the reverse lookup',
  },
  'apps/api/src/routes/roles.ts': {
    sites: 8,
    kind: 'admin-crud',
    reason: 'role CRUD: writes the role\'s own rows on create/update/delete, returns the role\'s own rows after a PATCH and a clone, and copies the source role\'s own rows on clone (a clone does not copy the parent link)',
  },
  'apps/api/src/services/roleDirectory.ts': {
    sites: 1,
    kind: 'admin-crud',
    reason: 'GET /roles/:id: the role\'s OWN rows, which the editor shows as its direct checks; inherited ones come from getRoleEffectivePermissions (resolver)',
  },
  'apps/api/src/services/partnerCreate.ts': {
    sites: 2,
    kind: 'writer',
    reason: 'new partner bootstrap: copies the global Partner Admin template\'s own rows into the partner\'s admin role',
  },
  'apps/api/src/db/seed.ts': {
    sites: 1,
    kind: 'writer',
    reason: 'seed: inserts built-in role grants',
  },
  'apps/api/src/db/schema/users.ts': {
    sites: 0,
    kind: 'writer',
    reason: 'table definition',
  },
};

const REPO = resolve(import.meta.dirname, '..', '..', '..', '..');
const ROOTS = ['apps/api/src', 'apps/api/scripts', 'ee'];

// Every way code can reach the table. Counted on comment-stripped source.
// The drizzle symbol is matched wherever it is USED as a table (bare, through
// a namespace such as `schema.rolePermissions`, or `db.query.rolePermissions`),
// raw SQL in any case, quoted or schema-qualified, including comma joins.
const SITE_PATTERNS: RegExp[] = [
  /\.(?:from|insert|delete|update)\(\s*(?:\w+\.)?rolePermissions\b/g,
  /\b(?:inner|left|right|full|cross)Join\(\s*(?:\w+\.)?rolePermissions\b/g,
  /\$\{\s*(?:\w+\.)?rolePermissions\s*\}/g,
  /\bquery\.rolePermissions\b/g,
  /\b(?:FROM|JOIN|INTO|UPDATE)\s+(?:"?public"?\.)?"?role_permissions"?/gi,
  /,\s*(?:"?public"?\.)?"?role_permissions"?\s+(?:AS\s+)?\w+/gi,
];
// A reference no site pattern counts (an import, an alias, a table
// definition) still marks the file, so an aliased reader cannot hide.
const MENTION = /(?:\bimport\b[^;]*\brolePermissions\b|\brolePermissions\s+as\s+\w+|pgTable\(\s*['"]role_permissions['"])/;

/** Touch sites in one file's source (also driven directly by the scanner self-test). */
function countSites(source: string): { sites: number; mentioned: boolean } {
  const code = stripComments(source);
  const sites = SITE_PATTERNS.reduce((n, re) => n + (code.match(re)?.length ?? 0), 0);
  return { sites, mentioned: sites > 0 || MENTION.test(code) };
}

function walk(dir: string, out: string[]): void {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '__tests__' || name === '__snapshots__' || name === 'dist') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|mts)$/.test(name) && !/\.(test|spec)\.(ts|tsx|mts)$/.test(name) && !name.endsWith('.d.ts')) out.push(full);
  }
}

function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
}

function scan(): Map<string, number> {
  const files: string[] = [];
  for (const root of ROOTS) walk(join(REPO, root), files);
  const found = new Map<string, number>();
  for (const file of files) {
    const { sites, mentioned } = countSites(readFileSync(file, 'utf8'));
    if (mentioned) found.set(relative(REPO, file), sites);
  }
  return found;
}

describe('role_permissions readers (#11702)', () => {
  const found = scan();

  it('the scanner catches every reader shape (self-test)', () => {
    const shapes = [
      'await db.select().from(rolePermissions).where(eq(rolePermissions.roleId, id));',
      'await db.select().from(schema.rolePermissions);',
      'await db.query.rolePermissions.findMany({});',
      'x.innerJoin(rolePermissions, eq(a, b));',
      'sql`SELECT 1 FROM ${rolePermissions} WHERE true`;',
      'sql`select 1 from role_permissions rp where rp.role_id = ${id}`;',
      'sql`SELECT 1 FROM "role_permissions" WHERE true`;',
      'sql`SELECT 1 FROM public."role_permissions" rp`;',
      'sql`SELECT 1 FROM roles r, role_permissions rp WHERE rp.role_id = r.id`;',
      'sql`SELECT 1 FROM roles r JOIN role_permissions AS rp ON rp.role_id = r.id`;',
    ];
    for (const shape of shapes) expect(countSites(shape).sites, shape).toBeGreaterThan(0);
    expect(countSites("import { rolePermissions as rp } from '../db/schema';").mentioned).toBe(true);
    // Comments and prose do not count.
    expect(countSites('// FROM role_permissions\n/* JOIN role_permissions */\nconst a = 1;').mentioned).toBe(false);
    expect(countSites("throw new Error('the ceiling reads role_permissions (FORCE RLS)');").mentioned).toBe(false);
  });

  it('finds the resolver itself (the scan works)', () => {
    expect(found.get('apps/api/src/services/roleInheritance.ts')).toBeGreaterThan(0);
  });

  it('every file that touches role_permissions is the resolver, admin CRUD or a writer, with a pinned site count', () => {
    const unclassified = [...found.keys()].filter((file) => !ALLOWED[file]).sort();
    expect(
      unclassified,
      'Read role grants through services/roleInheritance.ts (getRolePermissionGrants, getRolesPermissionGrants, '
        + 'getRoleGrantRows, expandToInheritingRoleIds, getRoleIdsHoldingPermission) so inherited grants count. '
        + 'Only a writer or role administration may touch role_permissions directly; add it to ALLOWED with a reason.',
    ).toEqual([]);
    const counts = Object.fromEntries([...found].filter(([file]) => ALLOWED[file]).sort());
    const pinned = Object.fromEntries(
      Object.entries(ALLOWED).filter(([file]) => found.has(file)).map(([file, a]) => [file, a.sites]).sort(),
    );
    expect(counts).toEqual(pinned);
  });

  it('has no stale allowlist entries', () => {
    const stale = Object.keys(ALLOWED).filter((file) => !found.has(file));
    expect(stale).toEqual([]);
  });
});
