/**
 * #9457 — API-side guard for the W09 agent Retry-After ceiling.
 *
 * W09 agents honour a loop-level `Retry-After` with x1.3 jitter, capped at 300 s.
 * 300 s is only a safe ceiling because no API source that the agent reaches
 * through the loop-level `httputil.Do` path emits more than 230 s (230 x 1.3 =
 * 299). This pins the maximum of every such source so a future bump cannot
 * silently exceed it.
 *
 * Exempt (not guarded): the three cert-renew limiters in routes/agents/mtls.ts
 * (/renew-cert success window up to 3600 s, /renew-cert/challenge and /confirm
 * 300 s). They are served by the agent's raw mTLS renewal client, which ignores
 * `Retry-After` (W09 plan amendment PR #9440, section A13).
 *
 * Documented, not guarded: `retryAfterSeconds: 300` in the body of
 * services/topology/interfaceSamples.ts and collectionIngest.ts is a body field
 * that clamps on the agent, not the HTTP header. Also not table-pinned: runtime-
 * derived storage-session throttle waits (routes/agents/storageSessions.ts, bounded
 * by the refill/settle horizons), the globalRateLimit default 60 s window, and the
 * inline literals in download.ts (30), helperAuth.ts (30) and inventory.ts (5).
 */
import { describe, expect, it } from 'vitest';
import {
  AGENT_RETRY_AFTER_MAX_SECONDS,
  RETRY_AFTER_OVERRIDES,
  RETRY_AFTER_SECONDS,
  WS_RETRY_AFTER_BOUNDS,
} from './agentRouteClasses';
import { DB_SATURATION_RETRY_AFTER_SECONDS } from '../../middleware/dbSaturationResponse';
import { AGENT_PER_IP_RATE_WINDOW_SECONDS, AGENT_RATE_WINDOW_SECONDS } from '../../middleware/agentAuth';
import { AGENT_ORG_RATE_WINDOW_SECONDS } from '../agentOrgRateLimit';
import { AGENT_STORAGE_RATE_WINDOW_SECONDS } from '../agentStorageSessionRateLimit';
import { DEFAULT_ENROLL_RATE_WINDOW_SECONDS } from '../../config/enrollmentRateLimit';

const AGENT_CEILING_SECONDS = 300;
const AGENT_JITTER = 1.3;

describe('agent-route Retry-After ceiling (#9457)', () => {
  it('the constant is the largest whole second that survives x1.3 jitter under the 300 s agent ceiling', () => {
    expect(AGENT_RETRY_AFTER_MAX_SECONDS).toBe(230);
    expect(AGENT_RETRY_AFTER_MAX_SECONDS * AGENT_JITTER).toBeLessThanOrEqual(AGENT_CEILING_SECONDS);
    expect((AGENT_RETRY_AFTER_MAX_SECONDS + 1) * AGENT_JITTER).toBeGreaterThan(AGENT_CEILING_SECONDS);
  });

  const sources: Array<[string, number]> = [
    ['admission shedding: bulk class', Math.max(...RETRY_AFTER_SECONDS.bulk)],
    ['admission shedding: standard class', Math.max(...RETRY_AFTER_SECONDS.standard)],
    ...Object.entries(RETRY_AFTER_OVERRIDES).map(([k, v]): [string, number] => [`admission override ${k}`, Math.max(...v)]),
    ['admission WS upgrade refusal', Math.max(...WS_RETRY_AFTER_BOUNDS)],
    ['db saturation response', Math.max(...DB_SATURATION_RETRY_AFTER_SECONDS)],
    ['agentAuth per-agent window', AGENT_RATE_WINDOW_SECONDS],
    ['agentAuth per-(agent, IP) window', AGENT_PER_IP_RATE_WINDOW_SECONDS],
    ['agent org rate-limit window', AGENT_ORG_RATE_WINDOW_SECONDS],
    ['agent storage-session window', AGENT_STORAGE_RATE_WINDOW_SECONDS],
    ['/enroll default window', DEFAULT_ENROLL_RATE_WINDOW_SECONDS],
  ];

  it.each(sources)('%s stays within the ceiling', (_name, max) => {
    expect(max).toBeLessThanOrEqual(AGENT_RETRY_AFTER_MAX_SECONDS);
  });
});
