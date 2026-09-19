import { describe, expect, expectTypeOf, it } from 'vitest';
import type {
  BackupDeviceRow,
  BackupOverviewDto,
  DashboardDto,
  EnrichedPortalDevice,
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
});
