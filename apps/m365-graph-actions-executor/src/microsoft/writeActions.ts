import { randomInt } from 'node:crypto';
import type { M365WriteAction, WriteActionResult, WriteActionFailureCode } from '@breeze/shared/m365';
import { GraphClientError, type MicrosoftGraphClient } from './graphClient';
import type { OpaqueAccessToken } from './tokenClient';

export interface GraphWriteActionContext {
  accessToken: OpaqueAccessToken;
  graphClient: MicrosoftGraphClient;
}

const LOWER = 'abcdefghijkmnpqrstuvwxyz';
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const DIGITS = '23456789';
const SYMBOLS = '!@#$%^&*-_';
const ALL = LOWER + UPPER + DIGITS + SYMBOLS;

function pick(alphabet: string): string {
  // randomInt(alphabet.length) is always in [0, alphabet.length), so the
  // index is never out of range — the assertion just satisfies
  // noUncheckedIndexedAccess.
  return alphabet[randomInt(alphabet.length)]!;
}

/** 20 chars, at least one of each class, shuffled — satisfies default Entra
 *  password complexity without echoing any input. */
export function generateTemporaryPassword(): string {
  const required = [pick(LOWER), pick(UPPER), pick(DIGITS), pick(SYMBOLS)];
  const rest = Array.from({ length: 16 }, () => pick(ALL));
  const chars = [...required, ...rest];
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    // i and j are always valid indices into chars (Fisher-Yates); the
    // assertions just satisfy noUncheckedIndexedAccess.
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }
  return chars.join('');
}

function mapGraphFailure(error: unknown): WriteActionResult {
  if (error instanceof GraphClientError) {
    const code: WriteActionFailureCode =
      error.code === 'graph_not_found' ? 'user_not_found'
      : error.code === 'graph_throttled' ? 'graph_throttled'
      : error.code === 'graph_permission_missing' ? 'graph_permission_missing'
      : error.code === 'application_token_invalid' ? 'application_token_invalid'
      : error.code === 'graph_request_timeout' ? 'graph_request_timeout'
      : error.code === 'graph_transport_failed' ? 'graph_transport_failed'
      : 'graph_error';
    return error.retryAfterSeconds === undefined
      ? { success: false, errorCode: code }
      : { success: false, errorCode: code, retryAfterSeconds: error.retryAfterSeconds };
  }
  throw error;
}

async function resolveUserId(action: M365WriteAction, ctx: GraphWriteActionContext): Promise<string> {
  const resource = await ctx.graphClient.readResource({
    accessToken: ctx.accessToken,
    path: `/users/${encodeURIComponent(action.userIdentifier)}`,
    select: ['id'],
  });
  const id = resource.id;
  if (typeof id !== 'string' || !id) throw new GraphClientError('graph_not_found');
  return id;
}

export async function executeGraphWriteAction(
  action: M365WriteAction,
  ctx: GraphWriteActionContext,
): Promise<WriteActionResult> {
  try {
    switch (action.type) {
      case 'm365.user.disable': {
        const userId = await resolveUserId(action, ctx);
        await ctx.graphClient.patch({
          accessToken: ctx.accessToken,
          path: `/users/${encodeURIComponent(userId)}`,
          body: { accountEnabled: false },
        });
        return { success: true, action: 'm365.user.disable', userId };
      }
      case 'm365.user.reset_password': {
        const userId = await resolveUserId(action, ctx);
        const temporaryPassword = generateTemporaryPassword();
        await ctx.graphClient.patch({
          accessToken: ctx.accessToken,
          path: `/users/${encodeURIComponent(userId)}`,
          body: { passwordProfile: { forceChangePasswordNextSignIn: true, password: temporaryPassword } },
        });
        return { success: true, action: 'm365.user.reset_password', userId, temporaryPassword, forceChangeNextSignIn: true };
      }
      default: {
        const exhaustive: never = action;
        throw new Error(`Unhandled M365 write action: ${JSON.stringify(exhaustive)}`);
      }
    }
  } catch (error) {
    return mapGraphFailure(error);
  }
}
