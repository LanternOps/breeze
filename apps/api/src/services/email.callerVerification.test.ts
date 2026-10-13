import { expect, it } from 'vitest';
import { buildCallerVerificationTemplate } from './email';

const url = `https://app.example.com/verify/${'A'.repeat(43)}`;

it('uses the shared shell, names the request and escapes partner-controlled text', () => {
  const result = buildCallerVerificationTemplate({
    partnerName: 'Example <b>MSP</b>',
    technicianLabel: '<script>bad</script>',
    requestLabel: 'reset the password for alex@example.com',
    url,
  });
  expect(result.html).toContain('Example &lt;b&gt;MSP&lt;/b&gt;');
  expect(result.html).toContain('&lt;script&gt;');
  expect(result.html).not.toContain('<script>bad');
  expect(result.html).not.toContain('<b>MSP');
  expect(result.html).toContain('reset the password for alex@example.com');
  expect(result.html).toContain('role="presentation"');
  expect(result.html).toContain(url);
  expect(result.text).toContain(url);
  expect(result.text).toContain('number you already have');
  expect(result.text).toContain('This is not me');
  expect(result.text).not.toMatch(/proves|read.*code.*back/i);
});

it('never carries a challenge number or reverse code', () => {
  const result = buildCallerVerificationTemplate({ partnerName: 'Example MSP', technicianLabel: 'Taylor', requestLabel: 'disable the account for Alex', url: 'https://app.example.com/verify/' + 'B'.repeat(43) });
  const body = `${result.subject}\n${result.html.replace(/<head[\s\S]*?<\/head>/i, ' ').replace(/<[^>]+>/g, ' ').replace(/&#?\w+;/g, ' ')}\n${result.text}`
    .replaceAll('https://app.example.com/verify/' + 'B'.repeat(43), '');
  // Only "10 minutes" may appear as a number.
  expect(body.match(/\d+/g)?.filter((n) => n !== '10') ?? []).toEqual([]);
});
