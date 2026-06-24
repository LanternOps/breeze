import { runOutsideDbContext } from '../../db';
import type { AccountingConnection } from './accountingConnectionService';
import { markStatus, updateTokens } from './accountingConnectionService';
import { getAccountingProvider } from './providerRegistry';

const ACCESS_TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

export class ReauthRequiredError extends Error {
  constructor(message = 'Accounting connection requires reauthorization') {
    super(message);
    this.name = 'ReauthRequiredError';
  }
}

function isInvalidGrant(err: unknown): boolean {
  const withQbo = err as { status?: number; qboError?: string; message?: string };
  return withQbo.qboError === 'invalid_grant'
    || (withQbo.status === 400 && /invalid_grant/i.test(withQbo.message ?? ''))
    || /invalid_grant/i.test(withQbo.message ?? '');
}

export async function getValidAccessToken(db: unknown, connection: AccountingConnection): Promise<string> {
  const now = Date.now();
  const refreshExpiresAt = connection.refreshTokenExpiresAt?.getTime() ?? 0;
  if (!connection.refreshToken || refreshExpiresAt <= now) {
    await markStatus(db as any, connection.id, connection.partnerId, 'reauth_required', 'QuickBooks refresh token expired');
    throw new ReauthRequiredError();
  }

  const accessExpiresAt = connection.accessTokenExpiresAt?.getTime() ?? 0;
  if (connection.accessToken && accessExpiresAt > now + ACCESS_TOKEN_REFRESH_BUFFER_MS) {
    return connection.accessToken;
  }

  try {
    const provider = getAccountingProvider(connection.provider);
    const tokens = await runOutsideDbContext(() => provider.refresh(connection.refreshToken!));
    await updateTokens(db as any, connection.id, connection.partnerId, {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      accessTokenExpiresAt: tokens.accessTokenExpiresAt,
      refreshTokenExpiresAt: tokens.refreshTokenExpiresAt,
    });
    return tokens.accessToken;
  } catch (err) {
    if (isInvalidGrant(err)) {
      await markStatus(db as any, connection.id, connection.partnerId, 'reauth_required', 'QuickBooks refresh token is invalid or expired');
      throw new ReauthRequiredError();
    }
    throw err;
  }
}
