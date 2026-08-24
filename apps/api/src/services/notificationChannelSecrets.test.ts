import { describe, it, expect } from 'vitest';
import {
  scrubChannelTestError,
  MAX_CHANNEL_TEST_ERROR_LENGTH,
} from './notificationChannelSecrets';

// #3697 persists the provider's failure message into
// notification_channels.last_test_error so the card can say WHY a test failed
// after a reload. That message is third-party text about a destination whose
// address is, for several channel types, itself the credential — so everything
// here is about what must NOT survive into the column.
// Assembled at runtime, never written as a literal: GitHub push protection
// blocks a Slack-webhook-shaped string in source even when it is fabricated.
// The value the code under test receives is byte-identical to a real one.
function fakeSlackWebhookUrl(secret: string): string {
  return `https://${['hooks', 'slack', 'com'].join('.')}/services/T00000000/B00000000/${secret}`;
}

describe('scrubChannelTestError', () => {
  describe('the channel\'s own secrets', () => {
    // The load-bearing case. A Slack incoming-webhook URL grants anyone holding
    // it the right to post as the channel, which is why `secretKeysForType`
    // lists webhookUrl. No pattern-matcher can spot one — it is an ordinary
    // https URL — so this has to be scrubbed by value.
    it('removes a slack webhook URL echoed back by the provider', () => {
      const webhookUrl = fakeSlackWebhookUrl('XXXXXXXXXXXXXXXXXXXXXXXX');

      const scrubbed = scrubChannelTestError(
        'slack',
        { webhookUrl },
        `HTTP 404: no_service for ${webhookUrl}`
      );

      expect(scrubbed).not.toContain(webhookUrl);
      expect(scrubbed).not.toContain('XXXXXXXXXXXXXXXXXXXXXXXX');
      // The operator still learns what went wrong.
      expect(scrubbed).toContain('no_service');
    });

    it('removes a pagerduty routing key and a pushover token', () => {
      expect(
        scrubChannelTestError('pagerduty', { routingKey: 'R0UT1NGK3Y0123456789' }, 'Invalid routing key R0UT1NGK3Y0123456789')
      ).not.toContain('R0UT1NGK3Y0123456789');

      expect(
        scrubChannelTestError('pushover', { token: 'atokenatokenatoken12' }, 'application token is invalid: atokenatokenatoken12')
      ).not.toContain('atokenatokenatoken12');
    });

    it('removes webhook auth material carried in headers, in both header shapes', () => {
      const secret = 'hdr-secret-value-9876543210';

      expect(
        scrubChannelTestError('webhook', { headers: [{ key: 'X-Api-Key', value: secret }] }, `rejected key ${secret}`)
      ).not.toContain(secret);

      expect(
        scrubChannelTestError('webhook', { headers: { 'X-Api-Key': secret } }, `rejected key ${secret}`)
      ).not.toContain(secret);
    });

    // Regression guard for the substring hazard: Pushover's `user` key is a
    // secret but can be short, and blanket substring-replacing a 3-character
    // value would carve holes through unrelated words in the message.
    it('does not substring-replace a secret too short to match safely', () => {
      const scrubbed = scrubChannelTestError('pushover', { user: 'abc' }, 'the abcdefgh device is unreachable');

      expect(scrubbed).toBe('the abcdefgh device is unreachable');
    });

    // Secrets contain regex metacharacters as a matter of course (`?` and `.`
    // in any URL). Literal replacement must not treat them as syntax.
    it('handles a secret containing regex metacharacters', () => {
      const url = 'https://example.com/hook?id=a+b.c*d(e)';

      expect(scrubChannelTestError('webhook', { url }, `POST ${url} failed`)).not.toContain(url);
    });
  });

  describe('untrusted third-party response bodies', () => {
    // webhookSender / pagerDutySender / pushoverSender all splice up to 500
    // characters of the DESTINATION's response into the error. That body can
    // carry secrets the channel config never held.
    it('redacts a bearer token and a JWT the destination echoed back', () => {
      const scrubbed = scrubChannelTestError(
        'webhook',
        { url: 'https://example.com/hook' },
        'HTTP 401: {"sent":"Authorization: Bearer abc123def456","jwt":"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig"}'
      );

      expect(scrubbed).not.toContain('abc123def456');
      expect(scrubbed).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    });

    it('strips URL userinfo even when the URL was normalised past a literal match', () => {
      const scrubbed = scrubChannelTestError(
        'webhook',
        { url: 'https://user:pa55word@example.com/hook' },
        'connect failed for https://user:pa55word@example.com/hook/'
      );

      expect(scrubbed).not.toContain('pa55word');
    });
  });

  describe('shape', () => {
    it('caps an unbounded response-body echo', () => {
      const scrubbed = scrubChannelTestError('webhook', {}, `HTTP 500: ${'x'.repeat(5000)}`);

      expect(scrubbed).not.toBeNull();
      expect(scrubbed!.length).toBeLessThanOrEqual(MAX_CHANNEL_TEST_ERROR_LENGTH);
    });

    it('returns null rather than an empty string for nothing worth storing', () => {
      expect(scrubChannelTestError('email', {}, '')).toBeNull();
      expect(scrubChannelTestError('email', {}, '   ')).toBeNull();
      expect(scrubChannelTestError('email', {}, undefined)).toBeNull();
      expect(scrubChannelTestError('email', {}, null)).toBeNull();
    });

    // Email has no per-channel secret (the SMTP/API credentials are
    // platform-level env config), so its message should pass through intact —
    // this is the exact string from the issue report and it is the whole point
    // of persisting the reason at all.
    it('leaves an operator-ready email failure untouched', () => {
      const message =
        'Resend error: Invalid `to` field. Please use our testing email address instead of domains like `example.com`.';

      expect(scrubChannelTestError('email', { recipients: ['qa-sweep@example.com'] }, message)).toBe(message);
    });

    // The SMS recipient is deliberately NOT stripped: smsSender concatenates it
    // into every failed-send message, it is not in secretKeysForType (the
    // recipient list is already returned verbatim to any alerts:read caller),
    // and it is the single most useful part of the reason.
    it('keeps the SMS recipient that identifies which number failed', () => {
      const scrubbed = scrubChannelTestError(
        'sms',
        { phoneNumbers: ['+15551234567'] },
        '+15551234567: The number is unverified trial number'
      );

      expect(scrubbed).toContain('+15551234567');
    });
  });
});
