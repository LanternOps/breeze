import type { AuthContext } from '../../middleware/auth';
import { createAuditLogAsync } from '../../services/auditService';
import { resolveRemoteSessionPromptConfig, type SessionPromptMode } from './helpers';
import {
  CONSENT_REQUIRED_SCREEN_ACCESS_UNAVAILABLE_CODE,
  CONSENT_REQUIRED_SCREEN_ACCESS_UNAVAILABLE_MESSAGE,
  REMOTE_PROMPT_POLICY_UNAVAILABLE_CODE,
  REMOTE_PROMPT_POLICY_UNAVAILABLE_MESSAGE,
  RemoteSessionPromptPolicyError,
} from './consentGate';

/**
 * Every server path that captures a device's screen or injects input outside a
 * remote desktop session. Recorded on the audit row so a refusal can be traced
 * to the tool or route that asked.
 */
export type ScreenAccessSurface = 'take_screenshot' | 'analyze_screen' | 'computer_control' | 'device_diagnose';

export const SCREEN_ACCESS_CONSENT_BLOCKED_AUDIT_ACTION = 'screen_access_consent_blocked';

export const SCREEN_ACCESS_UNAVAILABLE_IN_QUICK_SUPPORT_CODE = 'SCREEN_ACCESS_UNAVAILABLE_IN_QUICK_SUPPORT';
export const SCREEN_ACCESS_UNAVAILABLE_IN_QUICK_SUPPORT_MESSAGE =
  'Screenshots and computer control are not available on a Quick Support device. Use the remote desktop session the user accepted.';

export type ScreenAccessConsentGateResult =
  | { ok: true }
  | { ok: false; status: 409 | 503; body: { error: string; code: string } };

const NIL_ACTOR_ID = '00000000-0000-0000-0000-000000000000';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ScreenAccessActor = Pick<AuthContext, 'user' | 'principal'>;

function auditActor(actor: ScreenAccessActor): { actorType: 'user' | 'agent' | 'system' | 'ai_agent'; actorId: string } {
  const kind = actor.principal?.kind;
  const actorType = kind === 'ai_agent'
    ? 'ai_agent'
    : kind === 'helper'
      ? 'agent'
      : kind === 'system'
        ? 'system'
        : 'user';
  const id = actor.user?.id;
  return { actorType, actorId: typeof id === 'string' && UUID_RE.test(id) ? id : NIL_ACTOR_ID };
}

/**
 * Screen capture (`take_screenshot`, `analyze_screen`, the device diagnose
 * route) and input control (`computer_control`) honour the device's remote
 * access consent policy, resolved exactly as a remote desktop start resolves
 * it (`resolveRemoteSessionPromptConfig`).
 *
 * The agent's one-shot capture and input commands carry no consent prompt: only
 * a desktop stream start asks the signed-in user. So on a device whose policy
 * requires consent these paths refuse before anything is dispatched, and the
 * technician uses the remote desktop viewer, which asks. An unreadable prompt
 * policy refuses too, exactly as the desktop start paths do. `off` and
 * `notify` devices are unchanged.
 *
 * A Quick Support (ephemeral) device refuses every one of these surfaces,
 * whatever its prompt mode: the person at that machine is shown who is viewing
 * their screen only while a remote desktop session runs, and the support
 * client refuses these one-shot commands too.
 *
 * Every refusal is written to the audit log (fire-and-forget with retry, so an
 * audit write failure never turns a refusal into an allow).
 */
export async function checkScreenAccessConsentGate(input: {
  deviceId: string;
  orgId: string;
  hostname?: string | null;
  surface: ScreenAccessSurface;
  actor: ScreenAccessActor;
  /** devices.isEphemeral: a Quick Support device. Required so no caller can omit it. */
  isEphemeral: boolean;
}): Promise<ScreenAccessConsentGateResult> {
  if (input.isEphemeral) {
    await auditRefusal(input, 'quick_support_session', null);
    return {
      ok: false,
      status: 409,
      body: {
        error: SCREEN_ACCESS_UNAVAILABLE_IN_QUICK_SUPPORT_MESSAGE,
        code: SCREEN_ACCESS_UNAVAILABLE_IN_QUICK_SUPPORT_CODE,
      },
    };
  }

  let mode: SessionPromptMode;
  try {
    ({ mode } = await resolveRemoteSessionPromptConfig(input.deviceId));
  } catch (error) {
    if (error instanceof RemoteSessionPromptPolicyError) {
      await auditRefusal(input, 'policy_unavailable', null);
      return {
        ok: false,
        status: 503,
        body: { error: REMOTE_PROMPT_POLICY_UNAVAILABLE_MESSAGE, code: REMOTE_PROMPT_POLICY_UNAVAILABLE_CODE },
      };
    }
    throw error;
  }

  if (mode === 'consent') {
    await auditRefusal(input, 'prompt_unsupported', mode);
    return {
      ok: false,
      status: 409,
      body: {
        error: CONSENT_REQUIRED_SCREEN_ACCESS_UNAVAILABLE_MESSAGE,
        code: CONSENT_REQUIRED_SCREEN_ACCESS_UNAVAILABLE_CODE,
      },
    };
  }
  return { ok: true };
}

async function auditRefusal(
  input: Parameters<typeof checkScreenAccessConsentGate>[0],
  reason: 'prompt_unsupported' | 'policy_unavailable' | 'quick_support_session',
  promptMode: SessionPromptMode | null,
): Promise<void> {
  await createAuditLogAsync({
    orgId: input.orgId,
    ...auditActor(input.actor),
    action: SCREEN_ACCESS_CONSENT_BLOCKED_AUDIT_ACTION,
    resourceType: 'device',
    resourceId: input.deviceId,
    ...(input.hostname ? { resourceName: input.hostname } : {}),
    result: 'denied',
    initiatedBy: input.surface === 'device_diagnose' ? 'manual' : 'ai',
    details: {
      deviceId: input.deviceId,
      surface: input.surface,
      reason,
      promptMode,
    },
  });
}
