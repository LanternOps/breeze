import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { I18nextProvider } from 'react-i18next';
import { i18n } from '../../lib/i18n';

import McpUrlCard from './McpUrlCard';

function renderCard() {
  return render(
    <I18nextProvider i18n={i18n}>
      <McpUrlCard />
    </I18nextProvider>,
  );
}

describe('McpUrlCard', () => {
  // G4-6: the card only described the OAuth flow, but the API also accepts an
  // `X-API-Key` header (with ai:read/ai:write scope) — mcpServer.ts:241-269.
  // That path was undocumented on the page.
  it('mentions the X-API-Key header as an alternative to OAuth', async () => {
    renderCard();
    const description = await screen.findByText(/X-API-Key/i);
    expect(description).toBeInTheDocument();
  });
});
