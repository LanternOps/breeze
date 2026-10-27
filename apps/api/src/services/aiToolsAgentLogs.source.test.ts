import { describe, expect, it, vi } from 'vitest';

vi.mock('../db', async (importOriginal) => ({ ...(await importOriginal<object>()), db: {} }));

import { PgDialect } from 'drizzle-orm/pg-core';
import { and } from 'drizzle-orm';
import type { AuthContext } from '../middleware/auth';
import { buildAgentLogConditions } from './aiToolsAgentLogs';

const ORG = '00000000-0000-4000-8000-0000000000c1';
const auth = { orgCondition: () => undefined, allowedSiteIds: undefined, allowedDeviceIds: undefined } as unknown as AuthContext;
const render = (conds: unknown) => new PgDialect().sqlToQuery(and(...(conds as never[]))!);

describe('search_agent_logs source filter (W13, #6783)', () => {
  it('watchdog keeps only watchdog.* components, agent excludes them, absent adds nothing', async () => {
    const watchdog = render(await buildAgentLogConditions(ORG, auth, { source: 'watchdog' }));
    expect(watchdog.sql).toMatch(/"component" ilike \$\d/);
    expect(watchdog.sql).not.toMatch(/not ilike/);
    expect(watchdog.params).toContain('watchdog.%');

    const agent = render(await buildAgentLogConditions(ORG, auth, { source: 'agent' }));
    expect(agent.sql).toMatch(/"component" not ilike \$\d/);
    expect(agent.params).toContain('watchdog.%');

    const none = render(await buildAgentLogConditions(ORG, auth, {}));
    expect(none.params).not.toContain('watchdog.%');
  });
});
