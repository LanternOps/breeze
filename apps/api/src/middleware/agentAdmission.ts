/**
 * W08 (spec W1c, #8147) — agent admission control at the front door.
 *
 * Mounted in index.ts directly after requestPathLogger: a refusal is still
 * counted and logged, and costs nothing else — no secure headers, no body-limit
 * gate, no Redis round trip (globalRateLimit), no partner guard, no agent auth
 * DB transaction, no body read. It reads the method, the path and in-process
 * counters only, and never runs inside a DB context.
 *
 * Refusals are TRUTHFUL: 503 + Retry-After. A refused agent WS upgrade is an
 * HTTP 503 BEFORE the upgrade — never an accepted socket closed with 1013:
 * shipped agents (agent/internal/websocket `client.go` `reconnectLoop`) back off after a
 * failed connect but reconnect immediately after an accepted socket closes.
 */
import type { MiddlewareHandler } from 'hono';
import { getAdmissionRuntime, type AdmissionGate } from '../services/admission/admissionRuntime';
import { classifyAgentRequest } from '../services/admission/agentRouteClasses';
import type { WsSetupSlot } from '../services/admission/wsUpgradeGate';

declare module 'hono' {
  interface ContextVariableMap {
    /** W08: setup slot of an admitted agent WS upgrade; routes/agentWs.ts releases it when onOpen finishes. */
    admissionWsSetupSlot: WsSetupSlot;
  }
}

export function agentAdmission(getGate: () => AdmissionGate | null = getAdmissionRuntime): MiddlewareHandler {
  return async (c, next) => {
    const gate = getGate();
    if (!gate || gate.mode === 'off') return next();
    const req = classifyAgentRequest(c.req.method, c.req.path);
    if (!req || req.cls === 'protected') return next();
    // Junk GETs on the WS path (no Upgrade header) 401/404 without ever opening a
    // socket: they must not spend upgrade tokens or setup slots.
    if (req.cls === 'ws_upgrade' && c.req.header('upgrade')?.toLowerCase() !== 'websocket') return next();

    const decision = gate.decide(req);
    if (decision.action === 'shed') {
      c.set('admissionRouteLabel', req.label);
      c.set('rejectReason', req.cls === 'ws_upgrade' ? 'admission_ws_upgrade' : `admission_shed_${req.cls}`);
      c.header('Retry-After', String(decision.retryAfterSec));
      c.header('Cache-Control', 'no-store');
      return req.cls === 'ws_upgrade'
        ? c.json({ error: 'Too many agent connections right now; retry later', code: 'WS_UPGRADE_REFUSED', retryAfterSeconds: decision.retryAfterSec }, 503)
        : c.json({ error: 'Server busy; retry later', code: 'ADMISSION_SHED', retryAfterSeconds: decision.retryAfterSec }, 503);
    }

    if (decision.wsSlot) c.set('admissionWsSetupSlot', decision.wsSlot);
    try {
      await next();
    } finally {
      decision.release?.();
      // @hono/node-ws answers an accepted upgrade with a plain 200 Response;
      // anything else (401, 429, 404) never reaches onOpen, so return the slot now.
      // The token is refunded too: only completed upgrades consume rate budget.
      if (decision.wsSlot && c.res.status !== 200) {
        decision.wsSlot.release();
        decision.refund?.();
      }
    }
  };
}
