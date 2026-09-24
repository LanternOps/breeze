import { expect, expectTypeOf, it } from 'vitest';
import type { db } from '../../db';
import { chooseBmcAsset, normalizeBmcMac, type BmcCandidate, type BmcLinkTx } from './agentReportedBmcLink';

it('accepts both ambient db and Drizzle transactions with only select/update capabilities', () => {
  type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];
  expectTypeOf<typeof db>().toMatchTypeOf<BmcLinkTx>();
  expectTypeOf<DbTx>().toMatchTypeOf<BmcLinkTx>();
  expectTypeOf<keyof BmcLinkTx>().toEqualTypeOf<'select' | 'update'>();
});
const report = { deviceId: '11111111-1111-4111-8111-111111111111',
  orgId: '22222222-2222-4222-8222-222222222222', siteId: '33333333-3333-4333-8333-333333333333',
  mac: '02:00:00:00:00:10', ip: '192.0.2.10' };
const asset: BmcCandidate = { id: '44444444-4444-4444-8444-444444444444',
  orgId: report.orgId, siteId: report.siteId, macAddress: report.mac, ipAddress: report.ip,
  linkedDeviceId: null, autoLinkSuppressedAt: null };
it.each([
  [[], 'no_asset'],
  [[asset], 'linked'],
  [[{ ...asset, siteId: null }], 'linked'],
  [[{ ...asset, siteId: '55555555-5555-4555-8555-555555555555' }], 'other_site'],
  [[{ ...asset, orgId: '66666666-6666-4666-8666-666666666666' }], 'no_asset'],
  [[{ ...asset, macAddress: '02:00:00:00:00:11' }], 'no_asset'],
  [[{ ...asset, autoLinkSuppressedAt: new Date() }], 'suppressed'],
  [[{ ...asset, linkedDeviceId: report.deviceId }], 'already_linked'],
  [[{ ...asset, linkedDeviceId: '77777777-7777-4777-8777-777777777777' }], 'already_linked'],
  [[asset, { ...asset, id: '88888888-8888-4888-8888-888888888888' }], 'no_asset'],
] as const)('decides %j as %s', (rows, status) => {
  expect(chooseBmcAsset([...rows], report).status).toBe(status);
});
it('uses reported IP only to disambiguate matching MACs and prefers same site', () => {
  const second = { ...asset, id: '88888888-8888-4888-8888-888888888888', ipAddress: '192.0.2.11' };
  expect(chooseBmcAsset([asset, second], report).asset?.id).toBe(asset.id);
  expect(chooseBmcAsset([asset, { ...second, siteId: null }], { ...report, ip: null }).asset?.id).toBe(asset.id);
  expect(chooseBmcAsset([second], { ...report, mac: '' }).status).toBe('no_asset');
});
it.each([
 ['02-00-00-00-00-10','020000000010'], ['0200.0000.0010','020000000010'],
 [' 02:00:00:00:00:10 ','020000000010'], ['00:00:00:00:00:00',null],
 ['ff:ff:ff:ff:ff:ff',null], ['bad',null], ['',null], ['02:zz:00:00:00:10',null],
])('normalizes %s', (raw, expected) => expect(normalizeBmcMac(raw)).toBe(expected));
