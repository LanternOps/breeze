import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import SNMPTemplateList from './SNMPTemplateList';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  registerOrgIdProvider: vi.fn()
}));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload)
  }) as unknown as Response;

describe('SNMPTemplateList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(window, 'confirm').mockImplementation(() => true);
  });

  it('loads templates from API and wires select/create actions', async () => {
    const onSelectTemplate = vi.fn();
    const onCreateTemplate = vi.fn();

    fetchWithAuthMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';

      if (url === '/snmp/templates' && method === 'GET') {
        return makeJsonResponse({
          data: [
            { id: 'tpl-1', name: 'Cisco Core', vendor: 'Cisco', deviceClass: 'Core Switch', oidCount: 24, source: 'builtin' },
            { id: 'tpl-2', name: 'Edge Custom', vendor: 'Juniper', deviceClass: 'Edge Router', oidCount: 12, source: 'custom' }
          ]
        });
      }

      if (url === '/snmp/dashboard' && method === 'GET') {
        return makeJsonResponse({
          data: {
            templateUsage: [
              { templateId: 'tpl-1', deviceCount: 9 },
              { templateId: 'tpl-2', deviceCount: 4 }
            ]
          }
        });
      }

      return makeJsonResponse({}, false, 404);
    });

    render(
      <SNMPTemplateList
        selectedTemplateId="tpl-1"
        onSelectTemplate={onSelectTemplate}
        onCreateTemplate={onCreateTemplate}
      />
    );

    // ResponsiveTable renders both the desktop table and the mobile card list
    // (CSS hides one, but jsdom ignores media queries), so text/buttons appear twice.
    await screen.findAllByText('Cisco Core');
    expect(screen.getAllByText('Edge Custom').length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: 'Add template' }));
    expect(onCreateTemplate).toHaveBeenCalledTimes(1);

    // Two surfaces × two templates = four Edit buttons; tpl-2 (Edge Custom) is the
    // second template, i.e. indices 1 (desktop) and 3 (mobile).
    const editButtons = screen.getAllByRole('button', { name: 'Edit' });
    fireEvent.click(editButtons[1]!);
    expect(onSelectTemplate).toHaveBeenCalledWith('tpl-2');
  });

  it('deletes custom templates through API and refreshes list', async () => {
    let templates = [
      { id: 'tpl-1', name: 'Cisco Core', vendor: 'Cisco', deviceClass: 'Core Switch', oidCount: 24, source: 'builtin' },
      { id: 'tpl-2', name: 'Edge Custom', vendor: 'Juniper', deviceClass: 'Edge Router', oidCount: 12, source: 'custom' }
    ];

    fetchWithAuthMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';

      if (url === '/snmp/templates' && method === 'GET') {
        return makeJsonResponse({ data: templates });
      }

      if (url === '/snmp/dashboard' && method === 'GET') {
        return makeJsonResponse({ data: { templateUsage: [] } });
      }

      if (url === '/snmp/templates/tpl-2' && method === 'DELETE') {
        templates = templates.filter((template) => template.id !== 'tpl-2');
        return makeJsonResponse({ data: { id: 'tpl-2' } });
      }

      return makeJsonResponse({}, false, 404);
    });

    render(<SNMPTemplateList />);
    await screen.findAllByText('Edge Custom');

    // Open the confirm dialog via the row's Delete button (rendered in both the
    // desktop table and the mobile card list; either opens the same dialog).
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete' })[0]!);

    // …then confirm it from the ConfirmDialog.
    fireEvent.click(await screen.findByRole('button', { name: 'Delete Template' }));

    await waitFor(() => {
      const deleteCalls = fetchWithAuthMock.mock.calls.filter(([url, options]) =>
        String(url) === '/snmp/templates/tpl-2' && options?.method === 'DELETE'
      );
      expect(deleteCalls).toHaveLength(1);
    });

    await waitFor(() => {
      expect(screen.queryAllByText('Edge Custom')).toHaveLength(0);
    });
  });
});
