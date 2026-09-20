import { readFileSync } from 'node:fs';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AlertTemplateEditor from './AlertTemplateEditor';
import { fetchWithAuth } from '../../stores/auth';
import '../../lib/i18n';
vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('@/stores/orgStore', () => ({
  useOrgStore: () => ({ partners: [], organizations: [] }),
}));
vi.mock('@/lib/authScope', async () => {
  const actual = await vi.importActual<typeof import('@/lib/authScope')>('@/lib/authScope');
  return { ...actual, getJwtClaims: () => ({ scope: 'partner', partnerId: 'p-1', orgId: null }) };
});
const fetchMock = vi.mocked(fetchWithAuth);

beforeEach(() => vi.clearAllMocks());
describe('template creation freeze', () => {
  it('freezes a direct new-editor mount before fetching or rendering a form', () => {
    render(<AlertTemplateEditor templateId="new" />);
    expect(screen.getByTestId('alert-template-editor-frozen')).toHaveTextContent('New alert templates are created as monitors');
    expect(screen.getByTestId('alert-template-editor-frozen-link')).toHaveAttribute('href', '/alerts/monitors');
    expect(screen.queryByRole('button', { name: /create template/i })).toBeNull();
    expect(screen.queryByTestId('template-availability')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each(['new', '10000000-0000-4000-8000-000000000009'])('guards the actual dynamic page for %s', (id) => {
    const source = readFileSync('src/pages/settings/alert-templates/[id].astro', 'utf8');
    const frontmatter = source.split('---')[1]!.replace(/^import .*;\r?$/gm, '');
    const redirect = vi.fn(() => 'redirect-response');
    const result = new Function('Astro', frontmatter)({ params: { id }, redirect });
    if (id === 'new') {
      expect(redirect).toHaveBeenCalledWith('/alerts/monitors', 302);
      expect(result).toBe('redirect-response');
    } else {
      expect(redirect).not.toHaveBeenCalled();
      expect(source).toContain('<AlertTemplateEditor templateId={id} client:load />');
    }
  });
});
