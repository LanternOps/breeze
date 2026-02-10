import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import SNMPTemplateEditor from './SNMPTemplateEditor';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn()
}));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload)
  }) as unknown as Response;

describe('SNMPTemplateEditor OID browser and validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('loads OID browser results and adds selected OID into template rows', async () => {
    fetchWithAuthMock.mockImplementation(async (input) => {
      const url = String(input);

      if (url === '/snmp/templates') {
        return makeJsonResponse({
          data: [
            {
              id: 'tpl-1',
              name: 'Default Router',
              vendor: 'Cisco',
              deviceClass: 'Router',
              description: 'Core router profile',
              oids: []
            }
          ]
        });
      }

      if (url.startsWith('/snmp/oids/browse')) {
        return makeJsonResponse({
          data: {
            results: [
              {
                oid: '1.3.6.1.2.1.1.3.0',
                name: 'sysUpTime',
                type: 'TimeTicks',
                description: 'System uptime',
                source: 'catalog'
              }
            ]
          }
        });
      }

      return makeJsonResponse({}, false, 404);
    });

    render(<SNMPTemplateEditor />);

    await screen.findByText('sysUpTime');
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() => {
      expect(screen.getByDisplayValue('1.3.6.1.2.1.1.3.0')).not.toBeNull();
    });

    expect(screen.queryByText('OID browser and validator placeholder')).toBeNull();
  });

  it('validates OIDs before save and prevents submit on invalid validation result', async () => {
    fetchWithAuthMock.mockImplementation(async (input, init) => {
      const url = String(input);

      if (url === '/snmp/templates') {
        return makeJsonResponse({
          data: [
            {
              id: 'tpl-1',
              name: 'Default Router',
              vendor: 'Cisco',
              deviceClass: 'Router',
              description: 'Core router profile',
              oids: [
                {
                  id: 'oid-1',
                  oid: '1.3.6.1.2.1.1.3.0',
                  name: 'sysUpTime',
                  type: 'TimeTicks',
                  description: 'System uptime'
                }
              ]
            }
          ]
        });
      }

      if (url.startsWith('/snmp/oids/browse')) {
        return makeJsonResponse({ data: { results: [] } });
      }

      if (url === '/snmp/oids/validate' && init?.method === 'POST') {
        return makeJsonResponse({
          data: {
            valid: false,
            results: [
              {
                id: 'oid-1',
                oid: '1.3.6.1.2.1.1.3.0',
                valid: false,
                errors: ['OID must use dotted numeric format (e.g. 1.3.6.1.2.1.1.3.0).']
              }
            ]
          }
        });
      }

      return makeJsonResponse({}, false, 404);
    });

    render(<SNMPTemplateEditor />);

    await screen.findByDisplayValue('1.3.6.1.2.1.1.3.0');
    fireEvent.click(screen.getByRole('button', { name: 'Save template' }));

    const validationErrors = await screen.findAllByText('OID must use dotted numeric format (e.g. 1.3.6.1.2.1.1.3.0).');
    expect(validationErrors.length).toBeGreaterThan(0);

    const saveCalls = fetchWithAuthMock.mock.calls.filter(([url, init]) =>
      String(url) === '/snmp/templates/tpl-1' && init?.method === 'PATCH'
    );
    expect(saveCalls).toHaveLength(0);
  });
});
