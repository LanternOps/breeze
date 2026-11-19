import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { containmentInlineSettingsSchema } from '@breeze/shared';
import { i18n } from '@/lib/i18n';
import { containmentIssueKey, type ContainmentField } from './containmentIssueKey';

type Issue = z.core.$ZodIssue;
const EXTRA_ALLOW = containmentInlineSettingsSchema.shape.extraAllow;

/** The first issue the real shared schema raises for one entry, unwrapped from the host/cidr union. */
function firstIssue(entry: Record<string, unknown>): Issue {
  const result = EXTRA_ALLOW.safeParse([entry]);
  if (result.success) throw new Error(`schema accepted ${JSON.stringify(entry)}`);
  const leaves = (issues: readonly Issue[]): Issue[] =>
    issues.flatMap((issue) => {
      if (issue.code !== 'invalid_union' || typeof issue.path[issue.path.length - 1] === 'string') return [issue];
      const branch = issue.errors.find((b) => !b.some((i) => i.code === 'unrecognized_keys'));
      return branch ? leaves(branch) : [issue];
    });
  const [issue] = leaves(result.error.issues);
  if (!issue) throw new Error('no issue');
  return issue;
}

const valid = { proto: 'tcp', ports: [443], label: 'Probe' };

// These run against the real schema on purpose. The refinements are told apart by message, so
// rewording one in @breeze/shared fails here instead of silently dropping to the generic fallback.
describe('containmentIssueKey against the shared schema', () => {
  it.each<[string, ContainmentField, Record<string, unknown>, string]>([
    ['0.0.0.0/0', 'target', { cidr: '0.0.0.0/0', ...valid }, 'errors.cidrBlanket'],
    ['::/0', 'target', { cidr: '::/0', ...valid }, 'errors.cidrBlanket'],
    ['a short IPv4 prefix', 'target', { cidr: '10.0.0.0/7', ...valid }, 'errors.cidrOutOfBounds'],
    ['a short IPv6 prefix', 'target', { cidr: '2001:db8::/31', ...valid }, 'errors.cidrOutOfBounds'],
    ['IPv4 loopback', 'target', { cidr: '127.0.0.1/32', ...valid }, 'errors.cidrOutOfBounds'],
    ['IPv6 loopback', 'target', { cidr: '::1/128', ...valid }, 'errors.cidrOutOfBounds'],
    ['a malformed range', 'target', { cidr: 'not-a-range', ...valid }, 'cidrInvalid'],
    ['a wildcard host', 'target', { host: '*.example.com', ...valid }, 'errors.hostInvalid'],
    ['an empty host', 'target', { host: '', ...valid }, 'errors.hostInvalid'],
    ['a host with an underscore', 'target', { host: 'my_host.example.com', ...valid }, 'errors.hostInvalid'],
    ['an address as a host', 'target', { host: '127.1', ...valid }, 'errors.hostIsAddress'],
    ['localhost', 'target', { host: 'localhost', ...valid }, 'errors.hostLoopback'],
    ['a localhost subdomain', 'target', { host: 'relay.localhost', ...valid }, 'errors.hostLoopback'],
    ['duplicate ports', 'ports', { host: 'a.example.com', ...valid, ports: [443, 443] }, 'errors.portsUnique'],
    ['an out-of-range port', 'ports', { host: 'a.example.com', ...valid, ports: [70000] }, 'portsInvalid'],
    ['no ports', 'ports', { host: 'a.example.com', ...valid, ports: [] }, 'portsInvalid'],
    ['a control character in the label', 'label', { host: 'a.example.com', ...valid, label: 'a\u0007b' }, 'errors.labelControlChars'],
    ['an empty label', 'label', { host: 'a.example.com', ...valid, label: '' }, 'labelInvalid'],
    ['an unknown protocol', 'proto', { host: 'a.example.com', ...valid, proto: 'icmp' }, 'protoInvalid'],
  ])('maps %s', (_name, field, entry, key) => {
    expect(containmentIssueKey(field, firstIssue(entry))).toBe(key);
    expect(i18n.exists(`configurationPolicies.featureTabs.containmentTab.${key}`, { ns: 'policies', lng: 'en' })).toBe(true);
  });
});

describe('containmentIssueKey fallback', () => {
  const unmapped = (code: string): Issue =>
    ({ code, path: [0, 'x'], message: 'a refusal this tab has never heard of', input: '' }) as unknown as Issue;

  it('has a generic message to fall back to', () => {
    expect(i18n.exists('configurationPolicies.featureTabs.containmentTab.errors.generic', { ns: 'policies', lng: 'en' })).toBe(true);
  });

  it.each<ContainmentField>(['target', 'ports', 'label'])('uses the generic key for an unmapped refinement on %s', (field) => {
    expect(containmentIssueKey(field, unmapped('custom'))).toBe('errors.generic');
  });

  it('uses the generic key for an unmapped non-refinement issue on the destination', () => {
    expect(containmentIssueKey('target', unmapped('invalid_type'))).toBe('errors.generic');
  });

  it('is not fooled by a message naming an Object.prototype member', () => {
    const issue = { code: 'custom', path: [0, 'host'], message: 'constructor', input: '' } as unknown as Issue;
    expect(containmentIssueKey('target', issue)).toBe('errors.generic');
  });
});
