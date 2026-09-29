import { expect, it, vi } from 'vitest';
import { resolveExpectedTimezone } from './expectedTimezone';
const site = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Main',
  timezone: 'America/Detroit',
};
it('resolves aliases in Windows space and retains site provenance', () => {
  expect(resolveExpectedTimezone({ site })).toEqual({
    iana: 'America/Detroit',
    windowsId: 'Eastern Standard Time',
    source: 'site',
    sourceId: site.id,
    sourceName: 'Main',
  });
});
it.each(['UTC', 'Etc/UTC', null])('treats site %s as unset', (timezone) => {
  expect(resolveExpectedTimezone({ site: { ...site, timezone } })).toBeNull();
});
it('handles no site and warns once for an unmapped zone', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  expect(resolveExpectedTimezone({ site: null })).toBeNull();
  for (let i = 0; i < 2; i++)
    expect(
      resolveExpectedTimezone({ site: { ...site, timezone: 'Unmapped/Test' } }),
    ).toBeNull();
  expect(warn).toHaveBeenCalledTimes(1);
  warn.mockRestore();
});
it('reserves pinned policy precedence, including pinned UTC, with site fallback', () => {
  const policy = {
    policyId: '22222222-2222-4222-8222-222222222222',
    policyName: 'Regional',
    expected: 'pinned' as const,
    pinnedTimezone: 'UTC',
  };
  expect(resolveExpectedTimezone({ site, policy })).toMatchObject({
    windowsId: 'UTC',
    source: 'policy',
    sourceId: policy.policyId,
  });
  expect(
    resolveExpectedTimezone({
      site,
      policy: { ...policy, pinnedTimezone: null },
    }),
  ).toMatchObject({ source: 'site' });
});
