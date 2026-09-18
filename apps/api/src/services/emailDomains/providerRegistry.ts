import { getEmailDomainsConfig } from './config';
import type { EmailDomainProvider } from './provider';
import { createResendDomainProvider } from './adapters/resend';
import { createStaticDomainProvider } from './adapters/static';
import { createFakeDomainProvider } from './adapters/fake';

/**
 * The single switch that keeps this wave dark: with EMAIL_DOMAINS_PROVIDER
 * unset this returns null, the settings tab is hidden, the routes 404 and the
 * worker is never registered.
 *
 * `undefined` = not yet resolved; `null` = resolved to "no provider". The
 * distinction matters because null is a legitimate cached answer.
 */
let cached: EmailDomainProvider | null | undefined;

export function getEmailDomainProvider(): EmailDomainProvider | null {
  if (cached !== undefined) return cached;
  const config = getEmailDomainsConfig();
  switch (config.provider) {
    case 'resend':
      // No key => degrade to "unsupported" rather than constructing a Resend
      // client, whose constructor throws on a missing key. config/validate.ts
      // already refuses this combination in production.
      cached = config.resendApiKey ? createResendDomainProvider() : null;
      break;
    case 'static':
      cached = createStaticDomainProvider();
      break;
    case 'fake':
      cached = createFakeDomainProvider();
      break;
    default:
      cached = null;
  }
  return cached;
}

export function resetEmailDomainProviderForTests(): void {
  cached = undefined;
}
