import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import { randomUUID } from 'node:crypto';

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgresql://breeze_test:breeze_test@localhost:5433/breeze_test';
const APP_URL = process.env.DATABASE_URL_APP ?? 'postgresql://breeze_app:breeze_test@localhost:5433/breeze_test';
if (new URL(ADMIN_URL).port === '5432') throw new Error('refusing to run against :5432 — use the test stack (:5433)');

let admin: postgres.Sql;
let app: postgres.Sql;
let partnerA: string, partnerB: string, orgA: string, orgB: string, sourceA: string, sourceB: string;
let userA: string, userB: string, fileA: string, fileB: string;

beforeAll(async () => {
  admin = postgres(ADMIN_URL, { max: 1 });
  app = postgres(APP_URL, { max: 1 });
  partnerA = randomUUID(); partnerB = randomUUID();
  orgA = randomUUID(); orgB = randomUUID();
  const fixtureSuffix = randomUUID();
  await admin`INSERT INTO partners (id, name, slug)
              VALUES (${partnerA}, 'wsp-rls-a', ${`wsp-rls-a-${fixtureSuffix}`}),
                     (${partnerB}, 'wsp-rls-b', ${`wsp-rls-b-${fixtureSuffix}`})`;
  await admin`INSERT INTO organizations (id, partner_id, name, slug)
              VALUES (${orgA}, ${partnerA}, 'wsp-org-a', ${`wsp-org-a-${fixtureSuffix}`}),
                     (${orgB}, ${partnerB}, 'wsp-org-b', ${`wsp-org-b-${fixtureSuffix}`})`;
  userA = randomUUID();
  userB = randomUUID();
  await admin`INSERT INTO users (id, partner_id, org_id, email, name)
              VALUES (${userA}, ${partnerA}, ${orgA}, ${`wsp-rls-a-${fixtureSuffix}@example.test`}, 'wsp user a'),
                     (${userB}, ${partnerB}, ${orgB}, ${`wsp-rls-b-${fixtureSuffix}@example.test`}, 'wsp user b')`;
  sourceA = randomUUID();
  sourceB = randomUUID();
  await admin`INSERT INTO workspace_sources (id, org_id, kind, display_name, root_path)
              VALUES (${sourceA}, ${orgA}, 'smb_share', 'a share', '\\\\srv\\a'),
                     (${sourceB}, ${orgB}, 'smb_share', 'b share', '\\\\srv\\b')`;
  fileA = randomUUID();
  fileB = randomUUID();
  await admin`INSERT INTO workspace_file_index (id, org_id, source_id, rel_path, name)
              VALUES (${fileA}, ${orgA}, ${sourceA}, 'activity/file-a.txt', 'file-a.txt'),
                     (${fileB}, ${orgB}, ${sourceB}, 'activity/file.txt', 'file.txt')`;
});

afterAll(async () => {
  await admin`DELETE FROM workspace_file_activity WHERE org_id IN (${orgA}, ${orgB})`;
  await admin`DELETE FROM workspace_crawl_runs WHERE org_id IN (${orgA}, ${orgB})`;
  await admin`DELETE FROM workspace_file_index WHERE org_id IN (${orgA}, ${orgB})`;
  await admin`DELETE FROM workspace_sources WHERE org_id IN (${orgA}, ${orgB})`;
  await admin`DELETE FROM memory_blocks WHERE org_id IN (${orgA}, ${orgB})`;
  await admin`DELETE FROM users WHERE id IN (${userA}, ${userB})`;
  await admin`DELETE FROM organizations WHERE id IN (${orgA}, ${orgB})`;
  await admin`DELETE FROM partners WHERE id IN (${partnerA}, ${partnerB})`;
  await admin.end(); await app.end();
});

/** Run fn as breeze_app inside org A's access context (mirrors withDbAccessContext set_configs). */
async function asOrgA<T>(fn: (sql: postgres.TransactionSql) => Promise<T>): Promise<T> {
  return app.begin(async (tx) => {
    await tx`SELECT set_config('breeze.scope', 'organization', true),
                    set_config('breeze.org_id', ${orgA}, true),
                    set_config('breeze.accessible_org_ids', ${orgA}, true),
                    set_config('breeze.accessible_partner_ids', ${partnerA}, true),
                    set_config('breeze.user_id', '', true),
                    set_config('breeze.current_partner_id', '', true)`;
    return fn(tx);
  }) as Promise<T>;
}

async function expectRlsViolation(p: Promise<unknown>, table: string) {
  await expect(p).rejects.toThrow(
    new RegExp(`row-level security policy for table "${table}"`)
  );
}

describe('workspace extension RLS (cross-tenant forge as breeze_app)', () => {
  it('workspace_sources: org A context cannot insert an org B row', async () => {
    await expectRlsViolation(
      asOrgA((tx) => tx`INSERT INTO workspace_sources (org_id, kind, display_name, root_path)
                        VALUES (${orgB}, 'smb_share', 'forged', '\\\\srv\\x')`),
      'workspace_sources'
    );
  });

  it('workspace_file_index: forged org B row is rejected', async () => {
    await expectRlsViolation(
      asOrgA((tx) => tx`INSERT INTO workspace_file_index (org_id, source_id, rel_path, name)
                        VALUES (${orgB}, ${sourceB}, 'a/b.docx', 'b.docx')`),
      'workspace_file_index'
    );
  });

  it('workspace_file_index: org A context cannot READ org B rows', async () => {
    const seededId = randomUUID();
    await admin`INSERT INTO workspace_file_index (id, org_id, source_id, rel_path, name)
                VALUES (${seededId}, ${orgB}, ${sourceB}, 'secret/doc.pdf', 'doc.pdf')`;
    const rows = await asOrgA((tx) => tx`SELECT id FROM workspace_file_index WHERE id = ${seededId}`);
    expect(rows).toHaveLength(0); // RLS silent-0-row read, not an error
    await admin`DELETE FROM workspace_file_index WHERE id = ${seededId}`;
  });

  it('workspace_file_index: insert without device fields defaults device_key', async () => {
    const id = randomUUID();
    const rows = await asOrgA((tx) => tx`INSERT INTO workspace_file_index (id, org_id, source_id, rel_path, name)
                                         VALUES (${id}, ${orgA}, ${sourceA}, 'default-device/file.txt', 'file.txt')
                                         RETURNING device_key`);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.device_key).toBe('00000000-0000-0000-0000-000000000000');
    await admin`DELETE FROM workspace_file_index WHERE id = ${id}`;
  });

  it('workspace_crawl_runs: forged org B row is rejected', async () => {
    await expectRlsViolation(
      asOrgA((tx) => tx`INSERT INTO workspace_crawl_runs (org_id, source_id)
                        VALUES (${orgB}, ${sourceB})`),
      'workspace_crawl_runs'
    );
  });

  it('workspace_crawl_runs: same-org insert succeeds (policies are not deny-all)', async () => {
    const id = randomUUID();
    await asOrgA((tx) => tx`INSERT INTO workspace_crawl_runs (id, org_id, source_id)
                            VALUES (${id}, ${orgA}, ${sourceA})`);
    await admin`DELETE FROM workspace_crawl_runs WHERE id = ${id}`;
  });

  it('workspace_crawl_runs: org A context cannot READ org B rows', async () => {
    const seededId = randomUUID();
    await admin`INSERT INTO workspace_crawl_runs (id, org_id, source_id)
                VALUES (${seededId}, ${orgB}, ${sourceB})`;
    const rows = await asOrgA((tx) => tx`SELECT id FROM workspace_crawl_runs WHERE id = ${seededId}`);
    expect(rows).toHaveLength(0); // RLS silent-0-row read, not an error
    await admin`DELETE FROM workspace_crawl_runs WHERE id = ${seededId}`;
  });

  it('workspace_file_activity: forged org B row is rejected', async () => {
    await expectRlsViolation(
      asOrgA((tx) => tx`INSERT INTO workspace_file_activity (org_id, user_id, file_index_id, action)
                        VALUES (${orgB}, ${userB}, ${fileB}, 'open')`),
      'workspace_file_activity'
    );
  });

  it('memory_blocks: forged org B row is rejected', async () => {
    await expectRlsViolation(
      asOrgA((tx) => tx`INSERT INTO memory_blocks (org_id, block_type, subject_key, content)
                        VALUES (${orgB}, 'reference', 'doc:forged', '{"note":"x"}'::jsonb)`),
      'memory_blocks'
    );
  });

  it('memory_blocks: same-org insert succeeds (policies are not deny-all)', async () => {
    const id = randomUUID();
    await asOrgA((tx) => tx`INSERT INTO memory_blocks (id, org_id, block_type, subject_key, content)
                            VALUES (${id}, ${orgA}, 'reference', 'doc:ok', '{"note":"ok"}'::jsonb)`);
    await admin`DELETE FROM memory_blocks WHERE id = ${id}`;
  });

  it('workspace_file_activity: same-org insert succeeds (policies are not deny-all)', async () => {
    const id = randomUUID();
    await asOrgA((tx) => tx`INSERT INTO workspace_file_activity (id, org_id, user_id, file_index_id, action)
                            VALUES (${id}, ${orgA}, ${userA}, ${fileA}, 'open')`);
    await admin`DELETE FROM workspace_file_activity WHERE id = ${id}`;
  });
});

// Every table × every operation: a SELECT/UPDATE/DELETE policy regression on
// any one table must fail here, not survive because only INSERT was forged.
describe('workspace extension RLS matrix (READ/UPDATE/DELETE isolation, all tables)', () => {
  type MatrixCase = {
    table: string;
    seedOrgB: (id: string) => Promise<unknown>;
    forgeUpdate: (tx: postgres.TransactionSql, id: string) => Promise<postgres.RowList<postgres.Row[]>>;
    cleanup: (id: string) => Promise<unknown>;
  };

  // Closures read the beforeAll-assigned fixtures at call time.
  const cases: MatrixCase[] = [
    {
      table: 'workspace_sources',
      seedOrgB: (id) => admin`INSERT INTO workspace_sources (id, org_id, kind, display_name, root_path)
                              VALUES (${id}, ${orgB}, 'smb_share', 'matrix', '\\\\srv\\m')`,
      forgeUpdate: (tx, id) => tx`UPDATE workspace_sources SET display_name = 'forged' WHERE id = ${id}`,
      cleanup: (id) => admin`DELETE FROM workspace_sources WHERE id = ${id}`,
    },
    {
      table: 'workspace_file_index',
      seedOrgB: (id) => admin`INSERT INTO workspace_file_index (id, org_id, source_id, rel_path, name)
                              VALUES (${id}, ${orgB}, ${sourceB}, ${`matrix/${id}.txt`}, 'm.txt')`,
      forgeUpdate: (tx, id) => tx`UPDATE workspace_file_index SET name = 'forged' WHERE id = ${id}`,
      cleanup: (id) => admin`DELETE FROM workspace_file_index WHERE id = ${id}`,
    },
    {
      table: 'workspace_crawl_runs',
      seedOrgB: (id) => admin`INSERT INTO workspace_crawl_runs (id, org_id, source_id)
                              VALUES (${id}, ${orgB}, ${sourceB})`,
      forgeUpdate: (tx, id) => tx`UPDATE workspace_crawl_runs SET status = 'abandoned' WHERE id = ${id}`,
      cleanup: (id) => admin`DELETE FROM workspace_crawl_runs WHERE id = ${id}`,
    },
    {
      table: 'workspace_file_activity',
      seedOrgB: (id) => admin`INSERT INTO workspace_file_activity (id, org_id, user_id, file_index_id, action)
                              VALUES (${id}, ${orgB}, ${userB}, ${fileB}, 'open')`,
      forgeUpdate: (tx, id) => tx`UPDATE workspace_file_activity SET action = 'reveal' WHERE id = ${id}`,
      cleanup: (id) => admin`DELETE FROM workspace_file_activity WHERE id = ${id}`,
    },
    {
      table: 'memory_blocks',
      seedOrgB: (id) => admin`INSERT INTO memory_blocks (id, org_id, block_type, subject_key, content)
                              VALUES (${id}, ${orgB}, 'reference', 'doc:matrix', '{}'::jsonb)`,
      forgeUpdate: (tx, id) => tx`UPDATE memory_blocks SET confidence = 'high' WHERE id = ${id}`,
      cleanup: (id) => admin`DELETE FROM memory_blocks WHERE id = ${id}`,
    },
  ];

  for (const c of cases) {
    it(`${c.table}: org A context cannot READ an org B row`, async () => {
      const id = randomUUID();
      await c.seedOrgB(id);
      try {
        const rows = await asOrgA((tx) => tx`SELECT id FROM ${tx(c.table)} WHERE id = ${id}`);
        expect(rows).toHaveLength(0); // RLS silent-0-row read, not an error
      } finally {
        await c.cleanup(id);
      }
    });

    it(`${c.table}: org A context cannot UPDATE an org B row`, async () => {
      const id = randomUUID();
      await c.seedOrgB(id);
      try {
        const result = await asOrgA((tx) => c.forgeUpdate(tx, id));
        expect(result.count).toBe(0); // USING filters the row: silent no-op
      } finally {
        await c.cleanup(id);
      }
    });

    it(`${c.table}: org A context cannot DELETE an org B row`, async () => {
      const id = randomUUID();
      await c.seedOrgB(id);
      try {
        const result = await asOrgA((tx) => tx`DELETE FROM ${tx(c.table)} WHERE id = ${id}`);
        expect(result.count).toBe(0);
        const survivors = await admin`SELECT id FROM ${admin(c.table)} WHERE id = ${id}`;
        expect(survivors).toHaveLength(1); // the row must still exist
      } finally {
        await c.cleanup(id);
      }
    });
  }
});

// workspace_org_settings (W2): org_id IS the primary key (one settings row
// per org), so it doesn't fit the id-keyed MatrixCase shape above — a
// dedicated probe instead.
describe('workspace_org_settings RLS (W2 governance settings, cross-tenant)', () => {
  it('org A context cannot READ org B settings row', async () => {
    await admin`INSERT INTO workspace_org_settings (org_id, content_enabled, dlp_config)
                VALUES (${orgB}, true, '{"detectors":{"ssn":"redact"}}'::jsonb)`;
    try {
      const rows = await asOrgA((tx) => tx`SELECT org_id FROM workspace_org_settings WHERE org_id = ${orgB}`);
      expect(rows).toHaveLength(0); // RLS silent-0-row read, not an error
    } finally {
      await admin`DELETE FROM workspace_org_settings WHERE org_id = ${orgB}`;
    }
  });

  it('org A context cannot forge an insert for org B', async () => {
    await expectRlsViolation(
      asOrgA((tx) => tx`INSERT INTO workspace_org_settings (org_id, content_enabled)
                        VALUES (${orgB}, true)`),
      'workspace_org_settings'
    );
  });

  it('org A context cannot UPDATE an org B settings row', async () => {
    await admin`INSERT INTO workspace_org_settings (org_id, content_enabled)
                VALUES (${orgB}, false)`;
    try {
      const result = await asOrgA((tx) => tx`UPDATE workspace_org_settings
                                             SET content_enabled = true WHERE org_id = ${orgB}`);
      expect(result.count).toBe(0); // USING filters the row: silent no-op
    } finally {
      await admin`DELETE FROM workspace_org_settings WHERE org_id = ${orgB}`;
    }
  });

  it('org A context cannot DELETE an org B settings row', async () => {
    await admin`INSERT INTO workspace_org_settings (org_id, content_enabled)
                VALUES (${orgB}, false)`;
    try {
      const result = await asOrgA((tx) => tx`DELETE FROM workspace_org_settings WHERE org_id = ${orgB}`);
      expect(result.count).toBe(0);
      const survivors = await admin`SELECT org_id FROM workspace_org_settings WHERE org_id = ${orgB}`;
      expect(survivors).toHaveLength(1); // the row must still exist
    } finally {
      await admin`DELETE FROM workspace_org_settings WHERE org_id = ${orgB}`;
    }
  });

  it('same-org insert succeeds (policy is not deny-all)', async () => {
    await asOrgA((tx) => tx`INSERT INTO workspace_org_settings (org_id, content_enabled)
                            VALUES (${orgA}, true)`);
    await admin`DELETE FROM workspace_org_settings WHERE org_id = ${orgA}`;
  });
});
