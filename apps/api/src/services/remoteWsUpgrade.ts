import type { MiddlewareHandler } from 'hono';
import { getRemoteWsRuntimeConfig } from '../config/env';
import { getTrustedClientIp } from './clientIp';
import { assertRemoteWsPreUpgradeDrainComplete } from './remoteWsDrainGate';
import {
  authorizeConsumedRemoteWsTicket,
  consumeRemoteWsUpgradeTicket,
  type ConsumedRemoteWsTicketContext,
  type RemoteWsAuthMode,
  type ValidatedRemoteWsContext,
} from './remoteWsAuthorization';
import type {
  InstallLocalConnectionResult,
  RemoteConnectionIdentity,
  RemoteWsKind,
} from './remoteWsOwnership';
import type {
  RemoteWsSharedLeaseClaim,
  RemoteWsSharedLeaseManager,
} from './remoteWsSharedLease';

export type RemoteWsUpgradeContext =
  | {
      authorizationPhase: 'ticket_only';
      ticket: ConsumedRemoteWsTicketContext;
      connection: RemoteConnectionIdentity;
      sharedClaim: RemoteWsSharedLeaseClaim;
    }
  | {
      authorizationPhase: 'complete';
      authorization: ValidatedRemoteWsContext;
      sharedClaim: RemoteWsSharedLeaseClaim;
    };

declare module 'hono' {
  interface ContextVariableMap {
    remoteWs: RemoteWsUpgradeContext;
  }
}

export function getRemoteWsUpgradeConnection(
  context: RemoteWsUpgradeContext,
): RemoteConnectionIdentity {
  return context.authorizationPhase === 'complete'
    ? context.authorization.connection
    : context.connection;
}

function connectionIdentity(claim: RemoteWsSharedLeaseClaim): RemoteConnectionIdentity {
  return {
    connectionId: claim.connectionId,
    generation: claim.generation,
    instanceId: claim.instanceId,
    leaseToken: claim.leaseToken,
  };
}

function failure(status: number, reason: string): Response {
  return Response.json({ error: reason }, { status });
}

function sessionParam(kind: RemoteWsKind): string {
  return kind === 'tunnel' ? 'tunnelId' : 'id';
}

async function getMode(): Promise<RemoteWsAuthMode> {
  const config = getRemoteWsRuntimeConfig();
  assertRemoteWsPreUpgradeDrainComplete({
    mode: config.authMode,
    legacyTicketWriterDrainedAt: config.legacyTicketWriterDrainedAt,
    legacyViewerIssuerDrainedAt: config.legacyViewerIssuerDrainedAt,
  });
  return config.authMode;
}

export function assertRemoteWsUpgradeRuntimeReady(): RemoteWsAuthMode {
  const config = getRemoteWsRuntimeConfig();
  const productionLike = (
    process.env.NODE_ENV === 'production'
    || process.env.DEPLOYMENT_ENV === 'staging'
  );
  if (productionLike) {
    assertRemoteWsPreUpgradeDrainComplete({
      mode: config.authMode,
      legacyTicketWriterDrainedAt: config.legacyTicketWriterDrainedAt,
      legacyViewerIssuerDrainedAt: config.legacyViewerIssuerDrainedAt,
    });
  }
  return config.authMode;
}

export function requireRemoteWsUpgrade(options: {
  expectedType: RemoteWsKind;
  sharedLeases: RemoteWsSharedLeaseManager;
  installLocal: (
    sessionId: string,
    claim: RemoteWsSharedLeaseClaim,
  ) => InstallLocalConnectionResult;
  removeLocal: (
    sessionId: string,
    claim: RemoteWsSharedLeaseClaim,
  ) => boolean;
}): MiddlewareHandler {
  return async (c, next) => {
    let mode: RemoteWsAuthMode;
    try {
      mode = await getMode();
    } catch {
      return failure(503, 'remote websocket configuration unavailable');
    }

    const id = c.req.param(sessionParam(options.expectedType));
    if (!id) return failure(400, 'session_missing');
    const intake = await consumeRemoteWsUpgradeTicket({
      sessionId: id,
      expectedType: options.expectedType,
      ticket: c.req.query('ticket'),
      mode,
      caller: {
        ip: getTrustedClientIp(c),
        userAgent: c.req.header('user-agent') ?? '',
      },
    });
    if (!intake.ok) return failure(intake.status, intake.reason);

    let authorized: Omit<ValidatedRemoteWsContext, 'connection'> | null = null;
    if (mode === 'pre_upgrade') {
      const result = await authorizeConsumedRemoteWsTicket(intake.ticket);
      if (!result.ok) return failure(result.status, result.reason);
      authorized = result.context;
    }

    if (options.expectedType === 'desktop') {
      try {
        const { recoverDesktopFinalizationOrphan } = await import(
          './desktopSessionFinalization'
        );
        const recovery = await recoverDesktopFinalizationOrphan({
          sessionId: id,
          trigger: 'admission',
        });
        if (recovery === 'retained') {
          return failure(409, 'orphan_recovery');
        }
      } catch {
        return failure(503, 'desktop_recovery_unavailable');
      }
    }

    const acquired = await options.sharedLeases.acquire(options.expectedType, id);
    if (!acquired.ok) {
      const status = (
        acquired.reason === 'already_owned'
        || acquired.reason === 'desktop_finalizing'
        || acquired.reason === 'desktop_orphan_recovery'
      ) ? 409 : 503;
      return failure(status, acquired.reason);
    }

    const installed = options.installLocal(id, acquired.claim);
    if (!installed.ok) {
      acquired.claim.safeForwardingUntilMonotonicMs = 0;
      await options.sharedLeases.release(acquired.claim);
      return failure(409, installed.reason);
    }

    const identity = connectionIdentity(acquired.claim);
    const remoteWs: RemoteWsUpgradeContext = authorized
      ? {
          authorizationPhase: 'complete',
          authorization: {
            ...authorized,
            connection: identity,
          },
          sharedClaim: acquired.claim,
        }
      : {
          authorizationPhase: 'ticket_only',
          ticket: intake.ticket,
          connection: identity,
          sharedClaim: acquired.claim,
        };
    c.set('remoteWs' as never, remoteWs as never);

    let openingCleaned = false;
    const cleanupOpening = async () => {
      if (openingCleaned) return;
      openingCleaned = true;
      acquired.claim.safeForwardingUntilMonotonicMs = 0;
      options.removeLocal(id, acquired.claim);
      await options.sharedLeases.release(acquired.claim);
    };

    try {
      await next();
      if (c.error) await cleanupOpening();
    } catch (error) {
      await cleanupOpening();
      throw error;
    }
  };
}
