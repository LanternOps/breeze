import './setup';
import { describe, expect, it } from 'vitest';
import { db, withSystemDbAccessContext } from '../../db';
import { scripts } from '../../db/schema';
import { listCatalogScripts } from '../../services/fixMemory/catalog';
import { SYSTEM_LIBRARY_SCRIPTS } from '../../services/systemScriptLibrary';
import { createOrganization, createPartner } from './db-utils';

describe('fix memory catalog (real Postgres, system context = app-layer filter only)', () => {
  it('returns system + own-partner-wide + own-org scripts runnable on the OS, nothing else', async () => {
    const pA = await createPartner();
    const pB = await createPartner();
    const a1 = await createOrganization({ partnerId: pA.id });
    const a2 = await createOrganization({ partnerId: pA.id });
    const tag = `cat-${Date.now()}`;
    const s = (name: string, v: Partial<typeof scripts.$inferInsert>) =>
      ({ name: `${tag} ${name}`, language: 'bash' as const, content: 'echo ok', osTypes: ['linux'], ...v });
    await withSystemDbAccessContext(() => db.insert(scripts).values([
      s('system linux', { isSystem: true, osTypes: ['windows', 'linux'] }),
      s('partner A linux', { partnerId: pA.id }),
      s('partner A windows', { partnerId: pA.id, osTypes: ['windows'], language: 'powershell' }),
      s('org A1', { orgId: a1.id, partnerId: pA.id }),
      s('org A1 deleted', { orgId: a1.id, partnerId: pA.id, deletedAt: new Date() }),
      s('org A2', { orgId: a2.id, partnerId: pA.id }),
      s('partner B', { partnerId: pB.id }),
      { name: SYSTEM_LIBRARY_SCRIPTS[0]!.name, language: 'bash' as const, content: 'echo lifecycle', osTypes: ['linux'], isSystem: true },
    ]));
    const rows = await withSystemDbAccessContext(() =>
      listCatalogScripts({ orgId: a1.id, partnerId: pA.id, deviceOs: 'linux' }, 500));
    const mine = rows.map((r) => r.name).filter((n) => n.startsWith(tag)).sort();
    expect(mine).toEqual([`${tag} org A1`, `${tag} partner A linux`, `${tag} system linux`]);
    expect(rows.map((r) => r.name)).not.toContain(SYSTEM_LIBRARY_SCRIPTS[0]!.name);
  });
});
