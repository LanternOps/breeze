import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ db: null as any, partnerAxis: vi.fn() }));
vi.mock('../../db', () => ({ db: new Proxy({}, { get: (_, key) => m.db[key] }) }));
vi.mock('../../db/partnerAxisRead', () => ({ readWithPartnerAxisVisibility: (fn: () => unknown) => { m.partnerAxis(); return fn(); } }));

import { makeDbMock } from './testing';
import { callerHelperBranding, safeLogo } from './helperBranding';

describe('safeLogo', () => {
  it.each(['javascript:alert(1)', 'http://example.com/logo.png', 'data:image/svg+xml,x', '', null, 'https://user:pw@example.com/x.png', 'not a url'])(
    'rejects %s', (value) => expect(safeLogo(value)).toBeNull(),
  );
  it('permits an HTTPS logo', () => expect(safeLogo('https://example.com/logo.png')).toBe('https://example.com/logo.png'));
});

describe('callerHelperBranding', () => {
  let state: ReturnType<typeof makeDbMock>;
  beforeEach(() => {
    vi.clearAllMocks();
    state = makeDbMock(); m.db = state.db;
  });

  it('resolves the partner from the authenticated device org, then reads partner-axis branding', async () => {
    state.results.push([{ partnerId: 'p1' }], [{ name: '  Northwind IT  ', logo: 'https://cdn.example.com/n.png' }]);
    expect(await callerHelperBranding('org-1')).toEqual({ partnerName: 'Northwind IT', logoUrl: 'https://cdn.example.com/n.png' });
    expect(m.partnerAxis).toHaveBeenCalledTimes(1);
  });

  it('drops an unsafe logo but keeps the name', async () => {
    state.results.push([{ partnerId: 'p1' }], [{ name: 'Northwind', logo: 'http://insecure.example.com/n.png' }]);
    expect(await callerHelperBranding('org-1')).toEqual({ partnerName: 'Northwind', logoUrl: null });
  });

  it('returns null without an org/partner or a usable name', async () => {
    state.results.push([]);
    expect(await callerHelperBranding('org-1')).toBeNull();
    state.results.push([{ partnerId: null }]);
    expect(await callerHelperBranding('org-1')).toBeNull();
    state.results.push([{ partnerId: 'p1' }], [{ name: '   ', logo: null }]);
    expect(await callerHelperBranding('org-1')).toBeNull();
  });
});
