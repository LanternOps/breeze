import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { TierOverviewMatrix } from './TierOverviewMatrix';
import { TIER_DEFINITIONS } from './tierConfig';
import { formatToolName } from '../../lib/utils';

// Acronyms as a naive title-case renders them (#10197).
const NAIVE_ACRONYM = /\b(Edr|Dns|Ai|Dr|Ioc|Iocs|Sla|Vm|Vms|Psa|Cis|Pam|Hyperv|Snmp|Ip|Rca|Mssql|Unifi)\b/;

describe('TierOverviewMatrix — tier names from the catalogue (#10134)', () => {
  it('renders the four tier names from the catalogue', () => {
    const { container } = render(<TierOverviewMatrix />);
    const text = container.textContent ?? '';
    for (const name of ['Tier 1 — Reads', 'Tier 2 — Acts and logs', 'Tier 3 — Asks first', 'Tier 4 — Blocked']) {
      expect(text).toContain(name);
    }
    expect(text).not.toContain('Auto-Execute');
    expect(text).not.toContain('Requires Approval');
  });
});

describe('TierOverviewMatrix — tool display names (#10197)', () => {
  it('keeps acronyms upper-case and never shows the retired "Operator" noun', () => {
    const { container } = render(<TierOverviewMatrix />);
    // Tool names render in the bold span of each row (tier 1 starts collapsed).
    const names = Array.from(container.querySelectorAll('p > span.font-medium')).map((el) => el.textContent ?? '');
    expect(names).toContain('Sync EDR Data');
    expect(names).toContain('AI Task Plan');
    expect(names).toContain('Manage AI Agents (Authorize Supervised Key)');
    expect(names.filter((n) => NAIVE_ACRONYM.test(n))).toEqual([]);
    expect(names.some((n) => n.includes('Operator'))).toBe(false);
  });

  it('formats every catalogued tool (all four tiers, incl. collapsed tier 1) without naive acronyms or "Operator"', () => {
    const labels = TIER_DEFINITIONS.flatMap((tier) => tier.tools.map((tool) => formatToolName(tool.name)));
    expect(labels.length).toBeGreaterThan(300);
    expect(labels.filter((label) => NAIVE_ACRONYM.test(label))).toEqual([]);
    expect(labels.filter((label) => label.includes('Operator'))).toEqual([]);
  });
});
