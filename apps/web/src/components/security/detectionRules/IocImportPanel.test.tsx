import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { generateIocRules, type YaraIoc } from '@breeze/shared';

const { fetchWithAuth, showToast } = vi.hoisted(() => ({ fetchWithAuth: vi.fn(), showToast: vi.fn() }));

vi.mock('@/stores/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/stores/auth')>()),
  fetchWithAuth,
}));
vi.mock('../../shared/Toast', () => ({ showToast }));

import IocImportPanel from './IocImportPanel';

const json = (status: number, payload: unknown) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  }) as unknown as Response;

const SET = { id: 'set-1', enabled: true };
const MD5 = '44d88612fea8a8f36de82e1278abb02f';
const THREE = `${MD5}\nevil[.]com\nC:\\Users\\Public\\dropper.exe`;

async function settle() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

function paste(text: string) {
  fireEvent.change(screen.getByTestId('ioc-text'), { target: { value: text } });
}

const kindOf = (n: number) => (screen.getByTestId(`ioc-kind-${n}`) as HTMLSelectElement).value;

describe('IocImportPanel (W04-1)', () => {
  const onImported = vi.fn();
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('pasting three lines previews each IOC with its detected kind and an editable kind selector', () => {
    render(<IocImportPanel set={SET} onImported={onImported} />);
    paste(THREE);

    expect(screen.getByTestId('ioc-preview-row-0')).toBeInTheDocument();
    expect(screen.getByTestId('ioc-preview-row-1')).toBeInTheDocument();
    expect(screen.getByTestId('ioc-preview-row-2')).toBeInTheDocument();
    expect(screen.queryByTestId('ioc-preview-row-3')).toBeNull();
    const kinds = [kindOf(0), kindOf(1), kindOf(2)].sort();
    expect(kinds).toEqual(['domain', 'filepath', 'md5']);
    // Refanged before preview.
    expect(screen.getByTestId('ioc-preview-list').textContent).toContain('evil.com');
    expect(screen.getByTestId('ioc-valid-count').textContent).toContain('3');
  });

  it('changing a row kind re-runs validation and drops the row from the count when invalid', () => {
    render(<IocImportPanel set={SET} onImported={onImported} />);
    paste(THREE);
    const domainRow = [0, 1, 2].find((n) => kindOf(n) === 'domain')!;

    fireEvent.change(screen.getByTestId(`ioc-kind-${domainRow}`), { target: { value: 'ip' } });

    expect(screen.getByTestId(`ioc-error-${domainRow}`).textContent).toMatch(/IP address/i);
    expect(screen.getByTestId('ioc-valid-count').textContent).toContain('2');
  });

  it('invalid lines show their error copy and are not counted', () => {
    render(<IocImportPanel set={SET} onImported={onImported} />);
    paste(`${MD5}\nab`);

    expect(screen.getByTestId('ioc-parse-error-0').textContent).toMatch(/at least 4 bytes/i);
    expect(screen.getByTestId('ioc-parse-error-0').textContent).toContain('2');
    expect(screen.getByTestId('ioc-valid-count').textContent).toContain('1');
  });

  it('the generated-rule preview is byte-identical to the shared generator output', () => {
    render(<IocImportPanel set={SET} onImported={onImported} />);
    fireEvent.change(screen.getByTestId('ioc-label'), { target: { value: 'Advisory 42' } });
    paste(THREE);

    const iocs: YaraIoc[] = [
      { kind: 'md5', value: MD5 },
      { kind: 'domain', value: 'evil.com' },
      { kind: 'filepath', value: 'C:\\Users\\Public\\dropper.exe' },
    ];
    const expected = generateIocRules({ label: 'Advisory 42', iocs, severity: 'high' });
    expect(expected.length).toBeGreaterThan(0);
    expected.forEach((rule, n) => {
      expect(screen.getByTestId(`ioc-generated-rule-${n}`).textContent).toBe(rule.source);
    });
    expect(screen.queryByTestId(`ioc-generated-rule-${expected.length}`)).toBeNull();
    // The batch has a hash, so the full-hash cost note is shown.
    expect(screen.getByTestId('ioc-hash-note')).toBeInTheDocument();
  });

  it('Import posts structured IOCs (no rule text) and follows the publish outcome', async () => {
    fetchWithAuth.mockResolvedValue(
      json(201, {
        data: { rules: [{ id: 'r9', name: 'ioc_x', kind: 'md5', iocCount: 1 }] },
        publish: { published: true, version: 4, currentVersion: 4, stale: false, errors: [] },
      }),
    );
    render(<IocImportPanel set={SET} onImported={onImported} />);
    fireEvent.change(screen.getByTestId('ioc-label'), { target: { value: 'Advisory 42' } });
    paste(`${MD5}\nevil[.]com`);
    fireEvent.click(screen.getByTestId('ioc-import-submit'));
    await settle();

    const [url, init] = fetchWithAuth.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/security/yara/rule-sets/set-1/ioc-import');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    expect(Object.keys(body).sort()).toEqual(['iocs', 'label', 'severity']);
    expect(body.label).toBe('Advisory 42');
    expect(body.iocs).toEqual(
      expect.arrayContaining([
        { kind: 'md5', value: MD5 },
        { kind: 'domain', value: 'evil.com' },
      ]),
    );
    for (const ioc of body.iocs) expect(Object.keys(ioc).sort()).toEqual(['kind', 'value']);
    expect(JSON.stringify(body)).not.toContain('rule ');

    expect(showToast.mock.calls.filter(([t]) => t.type === 'success')[0][0].message).toMatch(/version 4/);
    expect(onImported).toHaveBeenCalledTimes(1);
  });

  it('an import whose publish failed toasts no success and hands the warning body to the editor', async () => {
    const body = {
      data: { rules: [{ id: 'r9', name: 'ioc_x', kind: 'string', iocCount: 1 }] },
      publish: {
        published: false, version: 3, currentVersion: 4, stale: true,
        errors: [{ ruleId: 'r9', name: 'ioc_x', code: 'compile', message: 'slow pattern', line: 9 }],
      },
    };
    fetchWithAuth.mockResolvedValue(json(201, body));
    render(<IocImportPanel set={SET} onImported={onImported} />);
    fireEvent.change(screen.getByTestId('ioc-label'), { target: { value: 'Advisory 42' } });
    paste('string:abcdefgh');
    fireEvent.click(screen.getByTestId('ioc-import-submit'));
    await settle();

    expect(showToast.mock.calls.filter(([t]) => t.type === 'success')).toHaveLength(0);
    // The editor applies the outcome (warning toast + banner + per-rule errors).
    expect(onImported).toHaveBeenCalledWith(body);
  });

  it('a 409 IOC_BATCH_ALREADY_IMPORTED shows the friendly "already imported" copy', async () => {
    fetchWithAuth.mockResolvedValue(
      json(409, { error: 'raw', code: 'IOC_BATCH_ALREADY_IMPORTED', names: ['ioc_x'] }),
    );
    render(<IocImportPanel set={SET} onImported={onImported} />);
    fireEvent.change(screen.getByTestId('ioc-label'), { target: { value: 'Advisory 42' } });
    paste(MD5);
    fireEvent.click(screen.getByTestId('ioc-import-submit'));
    await settle();

    expect(screen.getByTestId('ioc-import-error').textContent).toMatch(/already imported/i);
    expect(onImported).not.toHaveBeenCalled();
  });

  it('more than 1000 IOCs disables Import with the cap copy', () => {
    render(<IocImportPanel set={SET} onImported={onImported} />);
    fireEvent.change(screen.getByTestId('ioc-label'), { target: { value: 'Big' } });
    const lines = Array.from({ length: 1001 }, (_, i) => `sha256:${i.toString(16).padStart(64, '0')}`);
    paste(lines.join('\n'));

    expect(screen.getByTestId('ioc-cap-error')).toBeInTheDocument();
    expect((screen.getByTestId('ioc-import-submit') as HTMLButtonElement).disabled).toBe(true);
  });
});
