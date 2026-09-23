import { describe, expect, expectTypeOf, it } from 'vitest';
import type {
  BackupDeviceRow,
  BackupOverviewDto,
  DashboardDto,
  EnrichedPortalDevice,
  NetworkOverviewDto,
  PortalRunDto,
  SecurityDeviceRow,
  SecurityOverviewDto,
  SlaDto,
  SupportUsageDto,
  TileStatus,
} from './portalVisibility';

describe('portal visibility DTOs', () => {
  it('keeps tile and protection states closed unions', () => {
    expectTypeOf<TileStatus>().toEqualTypeOf<
      'ok' | 'no_data' | 'not_configured' | 'stale'
    >();

    expectTypeOf<SecurityDeviceRow['protection']>().toEqualTypeOf<
      'protected' | 'unprotected' | 'unknown'
    >();

    expectTypeOf<SlaDto['status']>().toEqualTypeOf<
      | 'breached'
      | 'at_risk'
      | 'paused'
      | 'on_track'
      | 'met'
      | 'not_configured'
    >();
  });

  it('exports every approved top-level DTO', () => {
    expectTypeOf<DashboardDto>().toBeObject();
    expectTypeOf<SecurityOverviewDto>().toBeObject();
    expectTypeOf<SecurityDeviceRow>().toBeObject();
    expectTypeOf<BackupOverviewDto>().toBeObject();
    expectTypeOf<BackupDeviceRow>().toBeObject();
    expectTypeOf<SupportUsageDto>().toBeObject();
    expectTypeOf<SlaDto>().toBeObject();
    expectTypeOf<PortalRunDto>().toBeObject();
    expectTypeOf<EnrichedPortalDevice>().toBeObject();

    const status: TileStatus = 'no_data';
    expect(status).toBe('no_data');
  });

  it('keeps network overview availability discriminated', () => {
    expectTypeOf<NetworkOverviewDto['dataStatus']>().toEqualTypeOf<
      'ok' | 'no_data' | 'not_enabled'
    >();

    expectTypeOf<
      Extract<NetworkOverviewDto, { dataStatus: 'ok' }>['totalAssets']
    >().toEqualTypeOf<number>();

    expectTypeOf<
      Exclude<NetworkOverviewDto, { dataStatus: 'ok' }>['totalAssets']
    >().toEqualTypeOf<null>();
  });

  it('excludes the #3198 business report types from the portal run union', () => {
    // A portal run row's type comes from the database, so this union is the
    // only place the compiler can be told what may appear. SLA attainment,
    // technician time and AR aging are the MSP's OWN numbers — technician
    // utilisation and money owed are not a customer's business — so they must
    // never become assignable here (spec §2, §3.5).
    expectTypeOf<PortalRunDto['type']>().not.toEqualTypeOf<'ticket_sla_attainment'>();
    type Listable = PortalRunDto['type'];
    type BusinessTypes = 'ticket_sla_attainment' | 'technician_time_billability' | 'ar_aging';
    type Leak = Extract<Listable, BusinessTypes>;
    expectTypeOf<Leak>().toEqualTypeOf<never>();
  });

});
