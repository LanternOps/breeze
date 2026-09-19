import { describe, expect, it } from 'vitest';
import {
  addYears,
  buildAtAGlanceProse,
  buildOsProse,
  buildReplacementSchedule,
  cleanUserName,
  displayPersonName,
  rowLabel,
  rowMention,
  rowSecondary,
  shortHostname,
  buildHardwareLifecycleRecommendations,
  classifyOsSupport,
  classifyReplacement,
  displayOs,
  humanJoin,
  isPlausibleDate,
  lifeUsedFraction,
  quarterLabel,
  replaceByLabel,
  replacementDueDate,
  sortLifecycleRows,
  warrantyExtendsLife,
} from './hardwareLifecycle';
import type { HardwareLifecycleDeviceRow } from '../types/hardwareLifecycleReport';

const TODAY = '2026-06-10';

describe('replacementDueDate', () => {
  it('is purchase + replaceAgeYears when there is no active warranty', () => {
    expect(replacementDueDate('2021-07-15', null, { today: TODAY })).toBe('2025-07-15');
  });

  it('is the warranty end when active coverage runs longer than the age rule', () => {
    // LAW-SRV: bought Oct 2021, warranty to Nov 2026 → never "Replace now" while covered.
    expect(replacementDueDate('2021-10-01', '2026-11-30', { today: TODAY })).toBe('2026-11-30');
  });

  it('ignores an expired warranty — it proves nothing about replacement', () => {
    expect(replacementDueDate('2019-04-01', '2022-04-01', { today: TODAY })).toBe('2023-04-01');
    expect(replacementDueDate(null, '2022-04-01', { today: TODAY })).toBeNull();
  });

  it('uses an active warranty alone when the purchase date is unknown', () => {
    expect(replacementDueDate(null, '2027-05-01', { today: TODAY })).toBe('2027-05-01');
  });

  it('treats a future-dated purchase as unknown, not healthy — even with an active warranty', () => {
    expect(replacementDueDate('2027-01-01', null, { today: TODAY })).toBeNull();
    expect(replacementDueDate('2027-01-01', '2028-05-01', { today: TODAY })).toBeNull();
  });

  it('rejects epoch-era and far-future dates from RMM sources', () => {
    expect(isPlausibleDate('1970-01-01', TODAY)).toBe(false);
    expect(isPlausibleDate('1969-12-31', TODAY)).toBe(false);
    expect(isPlausibleDate('2040-01-01', TODAY)).toBe(false);
    expect(isPlausibleDate('not-a-date', TODAY)).toBe(false);
    expect(isPlausibleDate('2024-03-01', TODAY)).toBe(true);
  });

  it('honours a configured replacement age', () => {
    expect(replacementDueDate('2021-07-15', null, { today: TODAY, replaceAgeYears: 5 })).toBe('2026-07-15');
  });
});

describe('warrantyExtendsLife', () => {
  it('is false when the warranty end merely EQUALS the age-rule due date — it must run LONGER to count as extending', () => {
    // purchase 2021-07-15 + 4y = 2025-07-15; warranty ends exactly there too.
    expect(warrantyExtendsLife('2021-07-15', '2025-07-15', '2025-07-15', { today: TODAY })).toBe(false);
  });

  it('is true when the warranty end runs BEYOND the age-rule due date', () => {
    // purchase 2021-07-15 + 4y = 2025-07-15; warranty covers to 2026-01-01,
    // which is what replacementDueDate would report as the due date.
    expect(warrantyExtendsLife('2021-07-15', '2026-01-01', '2026-01-01', { today: TODAY })).toBe(true);
  });

  it('is true for an active warranty when the purchase date is unknown — nothing to compare against, so the coverage itself is trusted', () => {
    expect(warrantyExtendsLife(null, '2027-05-01', '2027-05-01', { today: TODAY })).toBe(true);
  });

  it('is false for an already-expired warranty even when it equals the due date', () => {
    // purchase 2019-04-01 + 4y = 2023-04-01; warranty expired 2022-04-01,
    // which does not run past the age-rule date.
    expect(warrantyExtendsLife('2019-04-01', '2022-04-01', '2022-04-01', { today: TODAY })).toBe(false);
  });
});

describe('addYears', () => {
  it('clamps Feb 29 to Feb 28 instead of rolling into March', () => {
    expect(addYears('2024-02-29', 1)).toBe('2025-02-28');
    expect(addYears('2024-02-29', 4)).toBe('2028-02-29');
  });
});

describe('classifyReplacement', () => {
  it('buckets by due date only', () => {
    expect(classifyReplacement(null, TODAY)).toBe('unknown');
    expect(classifyReplacement('2026-06-10', TODAY)).toBe('replace');
    expect(classifyReplacement('2025-01-01', TODAY)).toBe('replace');
    expect(classifyReplacement('2026-06-11', TODAY)).toBe('due_soon');
    expect(classifyReplacement('2027-06-10', TODAY)).toBe('due_soon');
    expect(classifyReplacement('2027-06-11', TODAY)).toBe('supported');
  });
});

describe('classifyOsSupport', () => {
  it('is conservative: unrecognised strings are unclassified, never ended', () => {
    expect(classifyOsSupport('linux', 'Ubuntu 24.04')).toBe('unclassified');
    expect(classifyOsSupport('windows', '')).toBe('unclassified');
    expect(classifyOsSupport(null, '')).toBe('na');
    expect(classifyOsSupport(null, null)).toBe('na');
  });

  it('classifies Windows client releases', () => {
    expect(classifyOsSupport('windows', 'Windows 11 Pro Edition')).toBe('supported');
    expect(classifyOsSupport('windows', 'Microsoft Windows 10 Pro')).toBe('ended');
    expect(classifyOsSupport('windows', 'Windows 7 Professional')).toBe('ended');
    expect(classifyOsSupport('windows', 'Windows 10 Enterprise LTSC 2021')).toBe('unclassified');
    expect(classifyOsSupport('windows', 'Windows 10 IoT Enterprise')).toBe('unclassified');
  });

  it('classifies Windows Server releases', () => {
    expect(classifyOsSupport('windows', 'Windows Server 2025 Standard')).toBe('supported');
    expect(classifyOsSupport('windows', 'Windows Server 2022 Datacenter')).toBe('supported');
    expect(classifyOsSupport('windows', 'Windows Server 2019 Small Business')).toBe('ending');
    expect(classifyOsSupport('windows', 'Windows Server 2016 Standard')).toBe('ending');
    expect(classifyOsSupport('windows', 'Windows Server 2012 R2')).toBe('ended');
    expect(classifyOsSupport('windows', 'Windows Server 2030')).toBe('unclassified');
  });

  it('classifies macOS by major version', () => {
    expect(classifyOsSupport('macos', 'macOS 26.3.1')).toBe('supported');
    expect(classifyOsSupport('macos', '14.5')).toBe('supported');
    expect(classifyOsSupport('macos', '13.6')).toBe('ended');
    expect(classifyOsSupport('macos', 'Sonoma')).toBe('unclassified');
  });
});

describe('displayOs', () => {
  it('cleans inventory strings for non-technical readers', () => {
    expect(displayOs('macos', 'macOS 26.3.1 (a) (25D77)')).toBe('macOS 26.3.1');
    expect(displayOs('windows', 'Microsoft Windows 11 Professional')).toBe('Windows 11 Pro');
    expect(displayOs('macos', '14.5')).toBe('macOS 14.5');
    expect(displayOs('windows', '10.0.19045')).toBe('Windows 10.0.19045');
  });
});

describe('labels', () => {
  it('quarterLabel + replaceByLabel', () => {
    expect(quarterLabel('2026-11-30')).toBe('Q4 2026');
    expect(quarterLabel('2027-05-01')).toBe('Q2 2027');
    expect(replaceByLabel(null, TODAY)).toBe('Unknown');
    expect(replaceByLabel('2026-06-10', TODAY)).toBe('Overdue');
    expect(replaceByLabel('2028-01-15', TODAY)).toBe('Q1 2028');
  });

  it('humanJoin', () => {
    expect(humanJoin([])).toBe('');
    expect(humanJoin(['a'])).toBe('a');
    expect(humanJoin(['a', 'b'])).toBe('a and b');
    expect(humanJoin(['a', 'b', 'c'])).toBe('a, b and c');
  });

  it('lifeUsedFraction is clamped to 1 and null without both dates', () => {
    expect(lifeUsedFraction('2019-04-01', '2023-04-01', TODAY)).toBe(1);
    expect(lifeUsedFraction('2024-03-01', '2028-03-01', TODAY)).toBeCloseTo(0.567, 2);
    expect(lifeUsedFraction(null, '2028-03-01', TODAY)).toBeNull();
    expect(lifeUsedFraction('2024-03-01', null, TODAY)).toBeNull();
  });
});

function row(partial: Partial<HardwareLifecycleDeviceRow> & { name: string }): HardwareLifecycleDeviceRow {
  return {
    id: partial.name,
    kind: 'device',
    os: 'Windows 11 Pro',
    osSupport: 'supported',
    purchaseDate: null,
    purchaseDateSource: null,
    warrantyEndDate: null,
    ageYears: null,
    replaceBy: null,
    replacement: 'unknown',
    warrantyExtended: false,
    lifeUsed: null,
    ...partial,
  };
}

describe('buildAtAGlanceProse', () => {
  it('does not claim health for a fleet with no dates at all', () => {
    const text = buildAtAGlanceProse([row({ name: 'a' }), row({ name: 'b' })], 0);
    expect(text).toBe('We are still confirming purchase records for all 2 of your computers, so no replacement dates are available yet.');
  });

  it('scopes the healthy claim to dated computers when some are unknown', () => {
    const text = buildAtAGlanceProse([row({ name: 'a', replaceBy: '2029-01-01', replacement: 'supported' }), row({ name: 'b' })], 1);
    expect(text).toBe('All 1 of your computer with known dates is within its expected service life. 1 computer is missing purchase records, which we are confirming. We also manage 1 other device (network and print hardware), listed at the end.');
  });

  it('reproduces the reference wording for a mixed fleet', () => {
    const rows = [
      ...[1, 2, 3, 4].map((i) => row({ name: `r${i}`, replaceBy: '2024-01-01', replacement: 'replace' })),
      ...[1, 2].map((i) => row({ name: `d${i}`, replaceBy: '2026-12-01', replacement: 'due_soon' })),
      row({ name: 's', replaceBy: '2028-01-01', replacement: 'supported' }),
      row({ name: 'u' }),
    ];
    expect(buildAtAGlanceProse(rows, 2)).toBe('4 of your 8 computers are past due for replacement. 2 more computers come due within the year. The other 1 is within its expected service life. 1 computer is missing purchase records, which we are confirming. We also manage 2 other devices (network and print hardware), listed at the end.');
  });
});

describe('sortLifecycleRows', () => {
  it('orders most urgent first, then no-date rows by name', () => {
    const rows = [
      row({ name: 'zed' }),
      row({ name: 'later', replaceBy: '2028-01-01', replacement: 'supported' }),
      row({ name: 'alpha' }),
      row({ name: 'soon', replaceBy: '2024-01-01', replacement: 'replace' }),
    ];
    expect(sortLifecycleRows(rows).map((r) => r.name)).toEqual(['soon', 'later', 'alpha', 'zed']);
  });
});

describe('buildHardwareLifecycleRecommendations', () => {
  it('reproduces the staged plan from the reference report', () => {
    const rows = [
      row({ name: 'SAM4', replaceBy: '2023-04-01', replacement: 'replace', ageYears: 7.1, os: 'Windows 10 Pro', osSupport: 'ended' }),
      row({ name: 'GBG-LT', replaceBy: '2025-01-01', replacement: 'replace', ageYears: 5.4 }),
      row({ name: 'llr', replaceBy: '2025-07-01', replacement: 'replace', ageYears: 4.9 }),
      row({ name: 'reception', replaceBy: '2025-07-01', replacement: 'replace', ageYears: 4.9 }),
      row({ name: 'LAW-SRV', replaceBy: '2026-11-30', replacement: 'due_soon', warrantyEndDate: '2026-11-30', warrantyExtended: true }),
      row({ name: 'SAM23', replaceBy: '2027-04-15', replacement: 'due_soon' }),
      row({ name: 'SEL-LT7640', replaceBy: '2028-03-01', replacement: 'supported' }),
      row({ name: 'MacBook-Air.local' }),
    ];
    expect(buildHardwareLifecycleRecommendations(rows, TODAY)).toEqual([
      'This quarter, plan replacements for SAM4, GBG-LT, llr and reception, starting with SAM4 (7 years old).',
      'SAM4 no longer receives security updates on the current operating system; prioritize this one when scheduling.',
      'LAW-SRV is covered by warranty until November 2026; budget to replace it when coverage ends.',
      'Budget for SAM23 around Q2 2027; no action needed yet.',
      'We are confirming purchase records for 1 computer; their timelines will appear in an upcoming report.',
    ]);
  });

  it('asks for the order when a due-soon machine is inside six months', () => {
    expect(buildHardwareLifecycleRecommendations([row({ name: 'kiosk-10', replaceBy: '2026-11-11', replacement: 'due_soon' })], TODAY)).toEqual([
      'Order a replacement for kiosk-10 this quarter; it comes due Q4 2026.',
    ]);
  });

  it('says so when nothing needs attention', () => {
    expect(buildHardwareLifecycleRecommendations([row({ name: 'x', replaceBy: '2029-01-01', replacement: 'supported' })], TODAY)).toEqual([
      'Nothing needs your attention right now. The first computer to come due is x, around Q1 2029; we will flag it in the report before then.',
    ]);
    expect(buildHardwareLifecycleRecommendations([], TODAY)).toEqual([
      'Nothing needs your attention right now; we will flag the first computer to come due in a future report.',
    ]);
  });

  it('collapses a long replace list', () => {
    const rows = Array.from({ length: 8 }, (_, i) => row({ name: `pc${i}`, replaceBy: '2024-01-01', replacement: 'replace' }));
    expect(buildHardwareLifecycleRecommendations(rows, TODAY)[0]).toBe(
      'This quarter, plan replacements for the 8 computers marked Replace now.',
    );
  });
});

describe('customer-facing identity', () => {
  it('cleanUserName strips domain prefixes and suffixes and drops service accounts', () => {
    expect(cleanUserName('CORP\\priya.n')).toBe('priya.n');
    expect(cleanUserName('priya@corp.local')).toBe('priya');
    expect(cleanUserName('AzureAD\\Priya Natarajan')).toBe('Priya Natarajan');
    expect(cleanUserName('  ')).toBeNull();
    expect(cleanUserName(null)).toBeNull();
    expect(cleanUserName('SYSTEM')).toBeNull();
    expect(cleanUserName('NT AUTHORITY\\SYSTEM')).toBeNull();
    expect(cleanUserName('root')).toBeNull();
  });

  it('shortHostname drops the domain suffix but keeps a plain name', () => {
    expect(shortHostname('branch-lt-12.corp.local')).toBe('branch-lt-12');
    expect(shortHostname('MacBook-Air.local')).toBe('MacBook-Air');
    expect(shortHostname('SAM4')).toBe('SAM4');
    expect(shortHostname('Reception PC (no agent)')).toBe('Reception PC (no agent)');
  });

  it('rowLabel leads with the person and model when a user is known', () => {
    expect(rowLabel(row({ name: 'branch-lt-12.corp.local', hostname: 'branch-lt-12.corp.local', user: 'priya.n', model: 'Latitude 7410' }))).toBe('Priya N');
    expect(rowSecondary(row({ name: 'branch-lt-12.corp.local', hostname: 'branch-lt-12.corp.local', user: 'priya.n', manufacturer: 'Dell Inc.', model: 'Latitude 7410' }))).toBe('branch-lt-12  ·  Dell Inc. Latitude 7410');
    expect(rowLabel(row({ name: 'branch-lt-12.corp.local', hostname: 'branch-lt-12.corp.local', user: 'priya.n' }))).toBe('Priya N');
    expect(rowLabel(row({ name: 'branch-lt-12.corp.local', hostname: 'branch-lt-12.corp.local' }))).toBe('branch-lt-12');
    expect(rowLabel(row({ name: 'Front desk', hostname: 'fd-01.corp.local' }))).toBe('Front desk');
  });

  it('displayPersonName turns a login into a name without inventing one', () => {
    expect(displayPersonName('CORP\\lena.k')).toBe('Lena K');
    expect(displayPersonName('marcus_o')).toBe('Marcus O');
    expect(displayPersonName('aisha')).toBe('Aisha');
    expect(displayPersonName('Dan Reyes')).toBe('Dan Reyes');
    expect(displayPersonName('NT AUTHORITY\\SYSTEM')).toBeNull();
  });

  it('buildReplacementSchedule groups now, next quarters, later and unknown', () => {
    const rows = [
      row({ name: 'a', replaceBy: '2021-04-01', replacement: 'replace' }),
      row({ name: 'b', replaceBy: '2026-06-01', replacement: 'replace' }),
      row({ name: 'c', replaceBy: '2026-11-11', replacement: 'due_soon' }),
      row({ name: 'd', replaceBy: '2027-03-01', replacement: 'due_soon' }),
      row({ name: 'e', replaceBy: '2029-01-01', replacement: 'supported' }),
      row({ name: 'f' }),
    ];
    expect(buildReplacementSchedule(rows, TODAY).map((g) => [g.label, g.rows.map((r) => r.name), g.countOnly])).toEqual([
      ['Now', ['a', 'b'], false],
      ['Q4 2026', ['c'], false],
      ['Q1 2027', ['d'], false],
      ['After Jun 2027', ['e'], true],
      ['Purchase date unknown', ['f'], true],
    ]);
  });

  it('recommends an OS upgrade, not a purchase, for on-track hardware without security updates', () => {
    const rows = [
      row({ name: 'new-lt', user: 'kim', model: 'Latitude 5550', replaceBy: '2029-01-01', replacement: 'supported', osSupport: 'ended' }),
    ];
    expect(buildHardwareLifecycleRecommendations(rows, TODAY)).toEqual([
      "Upgrade the operating system on Kim's Latitude 5550; the hardware itself is fine for now and does not need replacing yet.",
    ]);
  });

  it('keeps servers out of the workstation ask and gives them their own line', () => {
    const rows = [
      row({ name: 'srv-files-02', deviceKind: 'server', replaceBy: '2022-05-22', replacement: 'replace', ageYears: 9.3 }),
      row({ name: 'ops-lt-04', user: 'dan', model: 'EliteBook', replaceBy: '2023-03-15', replacement: 'replace', ageYears: 7.5 }),
      row({ name: 'srv-dc-01', deviceKind: 'server', replaceBy: '2027-08-01', replacement: 'due_soon' }),
    ];
    expect(buildHardwareLifecycleRecommendations(rows, TODAY)).toEqual([
      "This quarter, plan replacements for Dan's EliteBook, starting with Dan's EliteBook (7 years old).",
      'Your server srv-files-02 is 9 years old and is past its planned life; we will propose a replacement window outside business hours.',
      'Your server srv-dc-01 comes due Q3 2027; we will plan its replacement outside business hours.',
    ]);
  });

  it('buildOsProse can speak in counts only for customer copy', () => {
    const rows = [row({ name: 'a', osSupport: 'ended' }), row({ name: 'b', osSupport: 'supported' }), row({ name: 'c', osSupport: 'unclassified' })];
    expect(buildOsProse(rows, { names: false })).toBe('Operating systems: 1 current; 1 no longer receiving security updates.');
  });

  it('never truncates silently', () => {
    const rows = Array.from({ length: 5 }, (_, i) => row({ name: `d${i}`, replaceBy: '2026-12-01', replacement: 'due_soon' }));
    const lines = buildHardwareLifecycleRecommendations(rows, TODAY);
    expect(lines.filter((l) => l.startsWith('Order a replacement'))).toHaveLength(3);
    expect(lines).toContain('2 more computers come due within the year; see the schedule above.');
  });

  it('rowMention reads as a person would say it in a sentence', () => {
    expect(rowMention(row({ name: 'x.corp.local', user: 'Priya', model: 'ThinkPad T14' }))).toBe("Priya's ThinkPad T14");
    expect(rowMention(row({ name: 'x.corp.local', user: 'James', model: null }))).toBe("James's computer");
    expect(rowMention(row({ name: 'srv-files-02.corp.local' }))).toBe('srv-files-02');
  });

  it('recommendations name people, chunk at four, and lead with the oldest', () => {
    const rows = [
      row({ name: 'a.corp.local', user: 'Priya', model: 'T14', replaceBy: '2023-04-01', replacement: 'replace', ageYears: 7.1 }),
      row({ name: 'b.corp.local', replaceBy: '2025-01-01', replacement: 'replace', ageYears: 5.4 }),
      row({ name: 'c.corp.local', replaceBy: '2025-07-01', replacement: 'replace', ageYears: 4.9 }),
      row({ name: 'd.corp.local', replaceBy: '2025-07-01', replacement: 'replace', ageYears: 4.9 }),
      row({ name: 'e.corp.local', replaceBy: '2025-08-01', replacement: 'replace', ageYears: 4.8 }),
    ];
    expect(buildHardwareLifecycleRecommendations(rows, TODAY)[0]).toBe(
      "This quarter, plan replacements for the 5 computers marked Replace now, starting with Priya's T14 (7 years old).",
    );
    expect(buildHardwareLifecycleRecommendations(rows.slice(0, 2), TODAY)[0]).toBe(
      "This quarter, plan replacements for Priya's T14 and b, starting with Priya's T14 (7 years old).",
    );
  });

  it('at-a-glance frames the ask with what is fine and what is oldest', () => {
    const rows = [
      row({ name: 'a', replaceBy: '2021-04-01', replacement: 'replace', ageYears: 9.3, osSupport: 'ended' }),
      row({ name: 'b', replaceBy: '2025-01-01', replacement: 'replace', ageYears: 5.4 }),
      row({ name: 'c', replaceBy: '2026-12-01', replacement: 'due_soon', ageYears: 3.8 }),
      row({ name: 'd', replaceBy: '2029-01-01', replacement: 'supported', ageYears: 1 }),
      row({ name: 'e' }),
    ];
    expect(buildAtAGlanceProse(rows, 0)).toBe(
      '2 of your 5 computers are past due for replacement; the oldest is 9 years old and 1 no longer receives security updates. 1 more computer comes due within the year. The other 1 is within its expected service life. 1 computer is missing purchase records, which we are confirming.',
    );
  });
});
