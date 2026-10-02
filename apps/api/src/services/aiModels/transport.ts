/**
 * Which wire options a dispatch transport can carry TODAY. W01's adapters
 * throw UnsupportedWireOptionError for thinkingDisplay 'updates', speed and
 * inferenceGeo until its spike (D1–D3) enables them; probing the adapters
 * themselves keeps this in lockstep with what dispatch will actually send.
 */
import { TOOL_REQUIRING_SURFACES, type AiSurface } from '@breeze/shared';
import { UnsupportedWireOptionError, toAgentSdkOptions, toMessagesApiParams, type WireParams } from './wireParams';

export type DispatchTransport = 'agent_sdk' | 'messages_api';
export interface TransportCarriage { speed: boolean; inferenceGeo: boolean; thinkingDisplayUpdates: boolean; budgetThinking: boolean }

export function defaultTransport(surface: AiSurface): DispatchTransport {
  return (TOOL_REQUIRING_SURFACES as readonly string[]).includes(surface) ? 'agent_sdk' : 'messages_api';
}

const carriageCache = new Map<DispatchTransport, TransportCarriage>();

export function transportCarries(transport: DispatchTransport): TransportCarriage {
  const cached = carriageCache.get(transport);
  if (cached) return cached;
  const accepts = (wire: Partial<WireParams>): boolean => {
    const probe = { betas: [], applied: {}, ...wire } as WireParams;
    try {
      if (transport === 'agent_sdk') toAgentSdkOptions(probe);
      else toMessagesApiParams(probe, { thinksWhenOmitted: true });
      return true;
    } catch (error) {
      if (error instanceof UnsupportedWireOptionError) return false;
      throw error;
    }
  };
  const carriage: TransportCarriage = {
    speed: accepts({ speed: 'fast' }),
    inferenceGeo: accepts({ inferenceGeo: 'probe' }),
    thinkingDisplayUpdates: accepts({ thinking: { type: 'adaptive', display: 'updates' } }),
    // W05: toMessagesApiParams only ever REDUCES thinking on a one-shot
    // (#7587) — it accepts an enabled budget and silently sends nothing — so
    // probing cannot see this; a manual budget reaches the wire only through query().
    budgetThinking: transport === 'agent_sdk',
  };
  carriageCache.set(transport, carriage);
  return carriage;
}
