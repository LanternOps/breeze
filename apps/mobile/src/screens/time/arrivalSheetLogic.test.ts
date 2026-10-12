import { describe, expect, it } from 'vitest';

import type { SiteCandidate } from '../../services/arrivalMatch';

import {
  SITE_VISIT_LABEL,
  afterSitePicked,
  arrivalCopy,
  candidateRowLabel,
  initialStep,
  openTicketsForOrg,
  stillHereCopy,
} from './arrivalSheetLogic';

const acme: SiteCandidate = {
  siteId: 's1',
  orgId: 'o1',
  orgName: 'Acme Corp',
  siteName: 'Main Office',
  distanceM: 43,
};
const annex: SiteCandidate = {
  siteId: 's2',
  orgId: 'o2',
  orgName: 'Globex',
  siteName: 'Annex',
  distanceM: 88,
};

const none = () => [];
const one = () => [{ id: 't1', label: 'T-1 · Printer' }];
const three = () => [
  { id: 't1', label: 'T-1 · Printer' },
  { id: 't2', label: 'T-2 · VPN' },
  { id: 't3', label: 'T-3 · Backup' },
];

describe('initialStep', () => {
  it('1 candidate, 0 tickets → confirm-no-ticket with the spec copy', () => {
    const step = initialStep([acme], null, none);
    expect(step).toEqual({ step: 'confirm-no-ticket', site: acme });
    expect(arrivalCopy(step)).toEqual({
      title: "Looks like you're at Acme Corp — Main Office.",
      primary: 'Start timer',
      secondary: 'Not now',
    });
  });

  it('1 candidate, 1 ticket → pick-ticket with that ticket preselected', () => {
    expect(initialStep([acme], null, one)).toEqual({
      step: 'pick-ticket',
      site: acme,
      tickets: one(),
      preselectedTicketId: 't1',
    });
  });

  it('1 candidate, 3 tickets → pick-ticket with none preselected', () => {
    const step = initialStep([acme], null, three);
    expect(step).toMatchObject({ step: 'pick-ticket', preselectedTicketId: null });
    expect(SITE_VISIT_LABEL).toBe('Site visit — no ticket');
  });

  it('asks tickets for the candidate org only', () => {
    const asked: string[] = [];
    initialStep([acme], null, (orgId) => {
      asked.push(orgId);
      return [];
    });
    expect(asked).toEqual(['o1']);
  });

  it('2 candidates → pick-site, highlighting the remembered pick', () => {
    const step = initialStep([acme, annex], 's2', none);
    expect(step).toEqual({ step: 'pick-site', candidates: [acme, annex], highlighted: 's2' });
    expect(arrivalCopy(step).title).toBe("You're near:");
  });

  it('afterSitePicked routes through the same ticket rules', () => {
    expect(afterSitePicked(annex, none).step).toBe('confirm-no-ticket');
    expect(afterSitePicked(annex, three).step).toBe('pick-ticket');
  });
});

describe('candidateRowLabel', () => {
  it('rounds distance to 10 m under 1 km', () => {
    expect(candidateRowLabel(acme)).toBe('Acme Corp — Main Office · 40 m');
    expect(candidateRowLabel({ ...acme, distanceM: 45 })).toBe('Acme Corp — Main Office · 50 m');
    expect(candidateRowLabel({ ...acme, distanceM: 3 })).toBe('Acme Corp — Main Office · 0 m');
  });

  it('switches to km from 1 km', () => {
    expect(candidateRowLabel({ ...acme, distanceM: 1240 })).toBe('Acme Corp — Main Office · 1.2 km');
  });
});

describe('openTicketsForOrg', () => {
  const t = (id: string, orgId: string, status: string, internalNumber: string | null = null) => ({
    id,
    orgId,
    status,
    internalNumber,
    subject: `Subject ${id}`,
  });

  it('keeps only this org\'s tickets that are not closed or resolved', () => {
    const out = openTicketsForOrg(
      [
        t('a', 'o1', 'open', 'T-1'),
        t('b', 'o1', 'resolved'),
        t('c', 'o1', 'closed'),
        t('d', 'o2', 'open'),
        t('e', 'o1', 'on_hold'),
      ],
      'o1'
    );
    expect(out).toEqual([
      { id: 'a', label: 'T-1 · Subject a' },
      { id: 'e', label: 'Subject e' },
    ]);
  });
});

describe('stillHereCopy', () => {
  it('formats the running time', () => {
    expect(stillHereCopy({ placeName: 'Acme Corp', runningMinutes: 148 })).toEqual({
      title: 'Still at Acme Corp? Timer has been running 2h 28m.',
      primary: 'Stop',
      secondary: 'Keep running',
    });
  });

  it('uses minutes under an hour', () => {
    expect(stillHereCopy({ placeName: 'Acme Corp', runningMinutes: 42 }).title).toBe(
      'Still at Acme Corp? Timer has been running 42m.'
    );
  });
});

describe('copy never says "tracking"', () => {
  it('holds for every sheet string', () => {
    const strings = [
      JSON.stringify(arrivalCopy(initialStep([acme], null, none))),
      JSON.stringify(arrivalCopy(initialStep([acme, annex], null, none))),
      JSON.stringify(stillHereCopy({ placeName: 'X', runningMinutes: 5 })),
      SITE_VISIT_LABEL,
    ];
    for (const s of strings) expect(s.toLowerCase()).not.toContain('track');
  });
});
