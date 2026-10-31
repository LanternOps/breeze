import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { BreezeEvent } from '../eventBus';
const { select } = vi.hoisted(() => ({ select: vi.fn() }));
vi.mock('../../db', () => ({ db: { select }, withSystemDbAccessContext: (fn: () => unknown) => fn() }));
vi.mock('../sentry', () => ({ captureException: vi.fn() }));
vi.mock('../alertSubject', () => ({ enrichAlertSubjects: vi.fn(async () => []) }));
import { ALERT_V2_EVENT_TYPES, isAlertV2EventType, alertWebhookDataV2Schema, alertWebhookDataV2PartnerSchema } from './alertV2';
import { buildAlertWebhookProjections } from './alertEnrichment';

const FROZEN_V2_KEYS = {
  alertId: 'string|null', ruleId: 'string|null', monitorId: 'string|null', deviceId: 'string|null', episodeId: 'string|null',
  owner: 'object{kind:enum(device,topology_site,backup_workload),ref:string|null}|null',
  ownerKind: 'enum(device,topology_site,backup_workload)|null', ownerLabel: 'string|null', subjectName: 'string|null',
  status: 'enum(active,acknowledged,resolved,suppressed)', severity: 'enum(critical,high,medium,low,info)|null',
  title: 'string|null', message: 'string|null', triggeredAt: 'string(datetime)|null', acknowledgedAt: 'string(datetime)|null', resolvedAt: 'string(datetime)|null',
  deviceHostname: 'string|null', siteId: 'string|null', siteName: 'string|null', orgName: 'string|null', alertUrl: 'string',
  externalTickets: 'array<object{externalId:string,externalNumber:string|null,externalUrl:string|null,source:string}>', acknowledgedByPrincipalId: 'string|null', resolvedByPrincipalId: 'string|null', enrichmentIncomplete: 'boolean',
  subjectKey: 'string|null', resolutionNote: 'string|null', resolvedBy: 'string|null', resolutionReason: 'string|null',
  acknowledgedBy: 'string|null', suppressedBy: 'string|null', suppressedUntil: 'string(datetime)|null', responsesOwner: 'boolean|null',
  kind: 'string|null', source: 'string|null', details: 'record',
} as const;

function describeType(type: z.ZodType): string {
  if (type instanceof z.ZodNullable) return `${describeType(type.unwrap() as z.ZodType)}|null`;
  if (type instanceof z.ZodEnum) return `enum(${type.options.join(',')})`;
  if (type instanceof z.ZodString) return type.format ? `string(${type.format})` : 'string';
  if (type instanceof z.ZodBoolean) return 'boolean';
  if (type instanceof z.ZodArray) return `array<${describeType(type.element as z.ZodType)}>`;
  if (type instanceof z.ZodObject) {
    const fields = Object.entries(type.shape).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, field]) => `${key}:${describeType(field as z.ZodType)}`);
    return `object{${fields.join(',')}}`;
  }
  if (type instanceof z.ZodRecord) return 'record';
  return `unexpected:${type.constructor.name}`;
}
const fixturePath = resolve(import.meta.dirname, '../../workers/__fixtures__/webhookV1');
const fixtures = readdirSync(fixturePath).filter((name) => name.startsWith('alert.')).map((name) => ({
  name,
  ...JSON.parse(readFileSync(resolve(fixturePath, name), 'utf8')) as { event: { id: string; type: BreezeEvent['type']; orgId: string; timestamp: string; data: Record<string, unknown> } },
}));
beforeEach(() => {
  select.mockImplementation(() => {
    const chain = { from: () => chain, leftJoin: () => chain, where: () => chain, limit: () => chain, then: (resolve: (value: unknown) => unknown) => Promise.resolve([]).then(resolve) };
    return chain;
  });
  vi.stubEnv('DASHBOARD_URL', 'https://app.example.com');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('frozen alert v2 contract', () => {
  it('pins every field and type, rejecting unknown top-level keys', () => {
    expect(Object.keys(alertWebhookDataV2Schema.shape).sort()).toEqual(Object.keys(FROZEN_V2_KEYS).sort());
    for (const [key, tag] of Object.entries(FROZEN_V2_KEYS)) {
      expect(describeType(alertWebhookDataV2Schema.shape[key as keyof typeof FROZEN_V2_KEYS]), key).toBe(tag);
    }
  });
  it('pins the explicit event allowlist', () => {
    expect(ALERT_V2_EVENT_TYPES).toEqual(['alert.triggered', 'alert.acknowledged', 'alert.resolved', 'alert.suppressed']);
    for (const type of ALERT_V2_EVENT_TYPES) expect(isAlertV2EventType(type)).toBe(true);
    for (const type of ['alert.correlation_group.created', 'alert.escalated', 'device.offline']) expect(isAlertV2EventType(type)).toBe(false);
  });
  it('limits the partner contract to v2 plus external IDs', () => {
    expect(Object.keys(alertWebhookDataV2PartnerSchema.shape).sort()).toEqual([...Object.keys(FROZEN_V2_KEYS), 'orgExternalIds'].sort());
    expect(describeType(alertWebhookDataV2PartnerSchema.shape.orgExternalIds)).toBe('array<object{externalId:string,system:string}>');
  });
  it('preserves the subject-key triggered variant at the top level', async () => {
    const fixture = fixtures.find(({ name }) => name === 'alert.triggered.json')!.event;
    const payload = { ...fixture.data, episodeId: '66666666-6666-4666-8666-666666666666', subjectKey: 'disk:primary', responsesOwner: false };
    const { org } = await buildAlertWebhookProjections({ id: fixture.id, type: fixture.type, orgId: fixture.orgId, metadata: { timestamp: fixture.timestamp }, payload, source: 'contract', priority: 'normal' });
    expect(org).toMatchObject({ episodeId: payload.episodeId, subjectKey: payload.subjectKey, responsesOwner: false });
    expect(org.details).not.toHaveProperty('episodeId');
    expect(org.details).not.toHaveProperty('subjectKey');
    expect(org.details).not.toHaveProperty('responsesOwner');
    expect(alertWebhookDataV2Schema.parse(org)).toEqual(org);
  });
  it.each(fixtures)('preserves every v1 producer key for $name', async ({ event }) => {
    const { org, partner } = await buildAlertWebhookProjections({
      id: event.id, type: event.type, orgId: event.orgId, metadata: { timestamp: event.timestamp },
      payload: event.data, source: 'contract', priority: 'normal',
    });
    expect(Object.keys(org).sort()).toEqual(Object.keys(FROZEN_V2_KEYS).sort());
    expect(alertWebhookDataV2Schema.parse(org)).toEqual(org);
    expect(alertWebhookDataV2PartnerSchema.parse(partner)).toEqual(partner);
    expect(org).not.toHaveProperty('orgExternalIds');
    expect(org.externalTickets).toEqual([]);
    expect(org.acknowledgedByPrincipalId).toBeNull();
    expect(org.resolvedByPrincipalId).toBeNull();
    for (const [key, value] of Object.entries(event.data)) {
      if (key in FROZEN_V2_KEYS) expect(org[key as keyof typeof org], key).toEqual(value);
      else expect(org.details[key], key).toEqual(value);
    }
    expect(alertWebhookDataV2Schema.safeParse({ ...org, surprise: true }).success).toBe(false);
    expect(alertWebhookDataV2PartnerSchema.safeParse({ ...partner, orgExternalIds: [{ system: 'x', externalId: 'y', surprise: true }] }).success).toBe(false);
  });
});
