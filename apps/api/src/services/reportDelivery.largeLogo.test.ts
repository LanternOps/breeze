import { crc32 } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';

/**
 * A report whose logo is a large PNG is built while holding the process-wide
 * large-decode slot (pngDecodeLimits.ts), so it waits for another large decode
 * in progress instead of adding to its memory. The renderer is mocked: only the
 * ordering is under test.
 */
const state = vi.hoisted(() => ({ events: [] as string[] }));
vi.mock('./email', () => ({ getEmailService: () => ({ sendEmail: vi.fn(async () => undefined) }) }));
vi.mock('./sentry', () => ({ captureException: vi.fn() }));
vi.mock('@breeze/shared/reportPdf', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@breeze/shared/reportPdf')>()),
  buildReportPdf: () => {
    state.events.push('report built');
    return { output: () => new ArrayBuffer(8) };
  },
}));

import { emailReportRun } from './reportDelivery';
import { withPngDecodeSlot } from './pngDecodeLimits';

function pngDataUrl(width: number, height: number): string {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${png.toString('base64')}`;
}

const run = (logoDataUrl: string) => ({
  reportName: 'Nightly inventory',
  reportType: 'device_inventory',
  format: 'pdf' as const,
  recipients: ['ops@example.com'],
  rows: [],
  timezone: 'UTC',
  branding: { name: 'Acme', logoDataUrl, logoAspect: 1 },
  partnerId: null,
});

/** Holds the large-decode slot until `release` is called. */
function holdLargeDecode(): { held: Promise<void>; release: () => void } {
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const held = withPngDecodeSlot(Buffer.from(pngDataUrl(4000, 4000).split(',')[1]!, 'base64'), async () => {
    state.events.push('other decode running');
    await gate;
    state.events.push('other decode done');
  });
  return { held, release };
}

describe('report PDF with a large logo', () => {
  it('waits for a large decode already in progress', async () => {
    state.events.length = 0;
    const other = holdLargeDecode();
    await vi.waitFor(() => expect(state.events).toContain('other decode running'));
    const report = emailReportRun(run(pngDataUrl(4000, 4000)) as never);
    await new Promise((resolve) => setTimeout(resolve, 20));
    other.release();
    await Promise.all([other.held, report]);
    expect(state.events).toEqual(['other decode running', 'other decode done', 'report built']);
  });

  it('waits the same way when the large PNG logo is labelled image/jpeg', async () => {
    state.events.length = 0;
    const other = holdLargeDecode();
    await vi.waitFor(() => expect(state.events).toContain('other decode running'));
    const report = emailReportRun(run(pngDataUrl(4000, 4000).replace('data:image/png;', 'data:image/jpeg;')) as never);
    await new Promise((resolve) => setTimeout(resolve, 20));
    other.release();
    await Promise.all([other.held, report]);
    expect(state.events).toEqual(['other decode running', 'other decode done', 'report built']);
  });

  it('does not wait when the logo is small', async () => {
    state.events.length = 0;
    const other = holdLargeDecode();
    await vi.waitFor(() => expect(state.events).toContain('other decode running'));
    const report = emailReportRun(run(pngDataUrl(200, 200)) as never);
    await report;
    other.release();
    await other.held;
    expect(state.events).toEqual(['other decode running', 'report built', 'other decode done']);
  });
});
