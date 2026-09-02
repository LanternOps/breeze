import { Hono, type Context } from 'hono';
import {
  AuthBindingRotationRequiredError,
  AuthBindingUnavailableError,
  NATIVE_AUTH_BINDING_HEADER,
  resolveAuthBinding,
  rotateExpiredBinding,
  type AuthBindingSource,
} from '../../services/authBrowserTransition';
import { readMobileDeviceId } from '../../services/mobileDeviceBinding';
import {
  AUTH_BINDING_COOKIE_NAME,
  buildAuthBindingCookie,
  buildClearAuthBindingCookie,
  getCookieValue,
  isAllowedOrigin,
  isRequestConnectionSecure,
} from './helpers';

export {
  AUTH_BINDING_COOKIE_NAME,
  buildAuthBindingCookie,
  buildClearAuthBindingCookie,
  NATIVE_AUTH_BINDING_HEADER,
};

export function requestAuthBinding(c: Context): AuthBindingSource {
  const nativeValue = c.req.header(NATIVE_AUTH_BINDING_HEADER);
  if (nativeValue !== undefined) {
    return { kind: 'native', value: nativeValue.trim() };
  }
  if (readMobileDeviceId(c)) {
    return { kind: 'native', value: '' };
  }

  return {
    kind: 'browser',
    value: getCookieValue(c.req.header('cookie'), AUTH_BINDING_COOKIE_NAME) ?? '',
  };
}

export function installAuthBindingReplacement(c: Context, source: AuthBindingSource): void {
  if (source.kind === 'native') {
    c.header(NATIVE_AUTH_BINDING_HEADER, source.value);
    return;
  }

  c.header(
    'Set-Cookie',
    buildAuthBindingCookie(source.value, isRequestConnectionSecure(c)),
    { append: true },
  );
}

export const authBindingRoutes = new Hono();

authBindingRoutes.post('/browser-binding/bootstrap', async (c) => {
  const origin = c.req.header('origin');
  if (origin && !isAllowedOrigin(origin)) {
    return c.json({ error: 'Invalid request origin' }, 403);
  }

  if (c.req.header('sec-fetch-site')?.trim().toLowerCase() === 'cross-site') {
    return c.json({ error: 'Cross-site request blocked' }, 403);
  }

  const source: AuthBindingSource = {
    kind: 'browser',
    value: getCookieValue(c.req.header('cookie'), AUTH_BINDING_COOKIE_NAME) ?? '',
  };

  let installedSource: AuthBindingSource = source;
  try {
    resolveAuthBinding(source);
    try {
      installedSource = await rotateExpiredBinding(source);
    } catch (error) {
      if (error instanceof AuthBindingUnavailableError) {
        if (error.reason === 'logout_pending') {
          return c.json({
            error: 'Authentication logout is still pending',
            reason: 'auth_logout_pending',
          }, 409);
        }
        // A valid binding with no row has not granted authority yet; an active
        // row needs no rotation. Both are safe to reissue unchanged.
        installedSource = source;
      } else {
        throw error;
      }
    }
  } catch (error) {
    if (!(error instanceof AuthBindingRotationRequiredError)) {
      throw error;
    }
    installedSource = error.replacement;
  }

  installAuthBindingReplacement(c, installedSource);
  return c.body(null, 204);
});
