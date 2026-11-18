import { describe, expect, it } from 'vitest';
import {
  ALERT_TICKETING_SEVERITIES,
  DEFAULT_ALERT_TICKETING_MIN_SEVERITY,
  alertTicketingSchemaFor,
  alertTicketingSeverityMeetsMinimum,
  connectwiseAlertTicketingSchema,
  connectwiseAlertTicketingStoredSchema,
  psaAlertTicketingPutSchema,
} from './psaAlertTicketing';
import * as barrel from './index';

const enabledConfig = {
  enabled: true,
  boardId: 12,
  openStatusId: 101,
  closedStatusId: 109,
};

describe('connectwiseAlertTicketingSchema', () => {
  it('accepts a partial config while disabled', () => {
    expect(connectwiseAlertTicketingSchema.safeParse({ enabled: false }).success).toBe(true);
    expect(connectwiseAlertTicketingSchema.safeParse({ enabled: false, boardId: 12 }).success).toBe(true);
  });

  it.each(['boardId', 'openStatusId', 'closedStatusId'] as const)('requires %s once enabled', (field) => {
    const { [field]: _dropped, ...rest } = enabledConfig;
    const result = connectwiseAlertTicketingSchema.safeParse(rest);
    expect(result.success).toBe(false);
    expect(result.error?.issues.some((issue) => issue.path[0] === field)).toBe(true);
  });

  it('fills the documented defaults', () => {
    expect(connectwiseAlertTicketingSchema.parse(enabledConfig)).toEqual({
      ...enabledConfig,
      priorityBySeverity: {},
      minSeverity: 'low',
      closeOnResolve: false,
      noteOnAcknowledge: false,
      hourlyCreateCap: 100,
      lookbackHours: 24,
    });
  });

  it('defaults the minimum severity low enough that warning-grade alerts are ticketed (#10528)', () => {
    // Breeze has no `warning` alert severity: a monitor author maps a
    // warning-level condition onto medium or low. The default must keep both.
    expect(DEFAULT_ALERT_TICKETING_MIN_SEVERITY).toBe('low');
    expect(alertTicketingSeverityMeetsMinimum('medium', DEFAULT_ALERT_TICKETING_MIN_SEVERITY)).toBe(true);
    expect(alertTicketingSeverityMeetsMinimum('low', DEFAULT_ALERT_TICKETING_MIN_SEVERITY)).toBe(true);
    expect(alertTicketingSeverityMeetsMinimum('info', DEFAULT_ALERT_TICKETING_MIN_SEVERITY)).toBe(false);
  });

  it('orders severities from least to most severe', () => {
    expect(ALERT_TICKETING_SEVERITIES).toEqual(['info', 'low', 'medium', 'high', 'critical']);
    expect(alertTicketingSeverityMeetsMinimum('critical', 'high')).toBe(true);
    expect(alertTicketingSeverityMeetsMinimum('medium', 'high')).toBe(false);
    expect(alertTicketingSeverityMeetsMinimum('unknown', 'info')).toBe(false);
  });

  it.each(['apiKey', 'privateKey', 'password', 'publicKey', 'token', 'companyLinksConfirmedFor'])(
    'is strict: rejects the unknown key %s',
    (key) => {
      expect(connectwiseAlertTicketingSchema.safeParse({ ...enabledConfig, [key]: 'x' }).success).toBe(false);
    },
  );

  it('rejects non-integer, zero, negative and out-of-range ids', () => {
    for (const boardId of [0, -1, 1.5, '12', 2 ** 31]) {
      expect(connectwiseAlertTicketingSchema.safeParse({ ...enabledConfig, boardId }).success).toBe(false);
    }
  });

  it('accepts a priority per severity and rejects unknown severities in the map', () => {
    expect(connectwiseAlertTicketingSchema.safeParse({
      ...enabledConfig,
      priorityBySeverity: { critical: 1, high: 2, medium: 3 },
    }).success).toBe(true);
    expect(connectwiseAlertTicketingSchema.safeParse({
      ...enabledConfig,
      priorityBySeverity: { warning: 3 },
    }).success).toBe(false);
  });

  it('bounds the create cap, lookback and filter lists', () => {
    expect(connectwiseAlertTicketingSchema.safeParse({ ...enabledConfig, hourlyCreateCap: 0 }).success).toBe(false);
    expect(connectwiseAlertTicketingSchema.safeParse({ ...enabledConfig, hourlyCreateCap: 1001 }).success).toBe(false);
    expect(connectwiseAlertTicketingSchema.safeParse({ ...enabledConfig, lookbackHours: 0 }).success).toBe(false);
    expect(connectwiseAlertTicketingSchema.safeParse({ ...enabledConfig, lookbackHours: 169 }).success).toBe(false);
    expect(connectwiseAlertTicketingSchema.safeParse({ ...enabledConfig, ruleIds: ['not-a-uuid'] }).success).toBe(false);
    const tooMany = Array.from({ length: 201 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    expect(connectwiseAlertTicketingSchema.safeParse({ ...enabledConfig, monitorIds: tooMany }).success).toBe(false);
  });
});

describe('connectwiseAlertTicketingStoredSchema', () => {
  it('additionally carries the server-written company-link confirmation', () => {
    const parsed = connectwiseAlertTicketingStoredSchema.parse({
      ...enabledConfig,
      companyLinksConfirmedFor: 'sha256:abc',
    });
    expect(parsed.companyLinksConfirmedFor).toBe('sha256:abc');
  });

  it('parses the row the W2-A migration writes from settings.defaultBoardId', () => {
    expect(connectwiseAlertTicketingStoredSchema.safeParse({ enabled: false, boardId: 7 }).success).toBe(true);
  });

  it('stays strict for any other key', () => {
    expect(connectwiseAlertTicketingStoredSchema.safeParse({ enabled: false, secret: 'x' }).success).toBe(false);
  });
});

describe('alertTicketingSchemaFor', () => {
  it('has a schema only for ConnectWise in W2', () => {
    expect(alertTicketingSchemaFor('connectwise')).toBe(connectwiseAlertTicketingSchema);
    for (const provider of ['autotask', 'jira', 'servicenow', 'freshservice', 'zendesk'] as const) {
      expect(alertTicketingSchemaFor(provider)).toBeNull();
    }
  });
});

describe('psaAlertTicketingPutSchema', () => {
  it('requires a non-negative integer expectedRev and an object config', () => {
    expect(psaAlertTicketingPutSchema.safeParse({ config: { enabled: false }, expectedRev: 0 }).success).toBe(true);
    expect(psaAlertTicketingPutSchema.safeParse({ config: { enabled: false } }).success).toBe(false);
    expect(psaAlertTicketingPutSchema.safeParse({ config: { enabled: false }, expectedRev: -1 }).success).toBe(false);
    expect(psaAlertTicketingPutSchema.safeParse({ config: 'x', expectedRev: 0 }).success).toBe(false);
  });

  it('accepts an optional confirmCompanyLinks flag and nothing else', () => {
    expect(psaAlertTicketingPutSchema.safeParse({ config: {}, expectedRev: 3, confirmCompanyLinks: true }).success).toBe(true);
    expect(psaAlertTicketingPutSchema.safeParse({ config: {}, expectedRev: 3, rev: 4 }).success).toBe(false);
  });
});

describe('validators barrel', () => {
  it('re-exports the alert ticketing validators', () => {
    expect(barrel.connectwiseAlertTicketingSchema).toBe(connectwiseAlertTicketingSchema);
    expect(barrel.alertTicketingSchemaFor).toBe(alertTicketingSchemaFor);
  });
});
