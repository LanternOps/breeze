import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const pageSource = readFileSync(new URL('./index.astro', import.meta.url), 'utf8');
const listSource = readFileSync(
  new URL('../../components/portal/TicketList.tsx', import.meta.url),
  'utf8',
);

describe('support page states', () => {
  it('opens the disabled branch with PageHeader like every other page', () => {
    expect(pageSource).toMatch(
      /import \{[^}]*PageHeader[^}]*\} from '\.\.\/\.\.\/components\/portal\/ui'/,
    );
    expect(pageSource).toMatch(/<PageHeader\s+title="Support"/);
    // The hand-rolled title used its own scale and broke the serif ramp.
    expect(pageSource).not.toMatch(/<h1[^>]*class=/);
    expect(pageSource).not.toContain('text-2xl');
    expect(pageSource).toContain('data-testid="portal-tickets-disabled-notice"');
  });

  it('leaves the page with exactly one heading level below the h1', () => {
    // h1 comes from PageHeader; the page itself must not author a stray h2/h3
    // that jumps the outline before the shared components get their turn.
    expect(pageSource).not.toMatch(/<h[23]\b/);
  });

  it('never prints a raw transport error at the customer', () => {
    // The page hands the transport error to TicketList, which answers it with
    // concierge copy; the raw string must never reach a rendered slot.
    expect(pageSource).toMatch(/<TicketList[\s\S]*error=\{response\.error\}/);
    expect(listSource).not.toContain('<ErrorNotice>{error}</ErrorNotice>');
    expect(listSource).toContain(
      "We couldn&apos;t load your requests just now. Your IT team can help.",
    );
  });
});
