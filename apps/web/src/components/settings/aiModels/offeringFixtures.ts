import type { AiModelsSnapshotDto, AiOfferingDto } from '@breeze/shared';
import { SNAPSHOT } from './testFixtures';

export const OFF = '22222222-2222-4222-8222-222222222222';
export const PM = '33333333-3333-4333-8333-333333333333';
export const RATES = { inputCentsPerM: 300, outputCentsPerM: 1500, cacheReadCentsPerM: 30, cacheWriteCentsPerM: 375 };

export function offeringRow(over: Partial<AiOfferingDto> = {}): AiOfferingDto {
  return {
    id: OFF, platformModelId: null, connectionId: null, source: 'platform', modelId: 'm-1', displayName: 'Model One',
    displayNameOverride: null, enabled: false, lifecycle: 'available', funding: 'platform', rates: RATES, fastRates: null,
    priceSource: 'platform', ownPrices: null, pricesEditable: true, thinkingMode: 'adaptive', supportsTools: true,
    contextTokens: 200000, optionSupport: { effort: [], thinkingDisplay: [], speed: ['standard'], inferenceGeo: [] },
    defaultOptions: null, allowedOptions: null, requiredPermission: null, refusalFallbackOfferingId: null,
    enableBlocker: null, defaultFor: [], updatedAt: '2026-10-01T00:00:00.000Z', ...over,
  };
}

export const synthRow = (over: Partial<AiOfferingDto> = {}) =>
  offeringRow({ id: null, enabled: false, updatedAt: null, ...over });

export const snapWith = (offerings: AiOfferingDto[]): AiModelsSnapshotDto => ({ ...SNAPSHOT, offerings });
