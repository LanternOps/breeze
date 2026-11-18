import { AI_TOOL_PROFILED_SURFACES, type AiModelsSnapshotDto, type AiOfferingDto, type AiOfferingToolProfileDto, type AiOfferingToolSurfaceDto, type AiToolProfiledSurface } from '@breeze/shared';
import { SNAPSHOT } from './testFixtures';

export const OFF = '22222222-2222-4222-8222-222222222222';
export const PM = '33333333-3333-4333-8333-333333333333';
export const RATES = { inputCentsPerM: 300, outputCentsPerM: 1500, cacheReadCentsPerM: 30, cacheWriteCentsPerM: 375 };

/** #11397: a gateway verification with no surface turn recorded on any surface. */
const NO_SURFACE_TURN = { state: 'absent', at: null, profile: null, promptTokens: null, cachedTokens: null, summary: null } as const;
export const NO_SURFACE_TURNS: NonNullable<AiOfferingDto['verification']>['surfaces'] = {
  chat: NO_SURFACE_TURN, helper: NO_SURFACE_TURN, script_builder: NO_SURFACE_TURN, ai_agents: NO_SURFACE_TURN, office_chat: NO_SURFACE_TURN,
};

type SurfaceOver = Partial<Omit<AiOfferingToolSurfaceDto, 'surface'>>;

/** #11398: a tool profile DTO, `auto` + unknown window (every surface full) unless overridden. */
export function toolProfileFor(
  over: Partial<AiOfferingToolProfileDto> = {},
  surfaces: Partial<Record<AiToolProfiledSurface, SurfaceOver>> = {},
): AiOfferingToolProfileDto {
  return {
    profile: 'auto', allowlist: null, droppedCustomNames: [], windowOverrideSupported: false,
    surfaces: AI_TOOL_PROFILED_SURFACES.map((surface) => ({
      surface, resolved: 'full', reason: surface === 'office_chat' ? 'auto_unmeasured' : 'auto_unknown_window',
      autoProfile: null, missingRequired: [], ...surfaces[surface],
    })),
    ...over,
  };
}

export function offeringRow(over: Partial<AiOfferingDto> = {}): AiOfferingDto {
  return {
    id: OFF, platformModelId: null, connectionId: null, source: 'platform', modelId: 'm-1', displayName: 'Model One',
    displayNameOverride: null, enabled: false, lifecycle: 'available', funding: 'platform', rates: RATES, fastRates: null,
    priceSource: 'platform', ownPrices: null, pricesEditable: true, thinkingMode: 'adaptive', supportsTools: true,
    contextTokens: 200000, optionSupport: { effort: [], thinkingDisplay: [], speed: ['standard'], inferenceGeo: [] },
    defaultOptions: null, allowedOptions: null, requiredPermission: null, refusalFallbackOfferingId: null,
    enableBlocker: null, defaultFor: [], updatedAt: '2026-10-01T00:00:00.000Z', verification: null, contextWindow: null, toolProfile: toolProfileFor(), ...over,
  };
}

export const synthRow = (over: Partial<AiOfferingDto> = {}) =>
  offeringRow({ id: null, enabled: false, updatedAt: null, ...over });

export const snapWith = (offerings: AiOfferingDto[]): AiModelsSnapshotDto => ({ ...SNAPSHOT, offerings });
