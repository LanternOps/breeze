// @vitest-environment jsdom
/**
 * B-W05 (#6159, D-B39): the fleet-health MCP App view, run in a real jsdom
 * window with its inline script executing. Every tenant-controlled string is
 * hostile input; the view must render it as text and never touch the network.
 *
 * jsdom proves DOM behaviour only — not CSP or host sandboxing. The real-host
 * leg is the Task 7 lab.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { FLEET_HEALTH_VIEW_HTML } from './fleetHealthView';

type Win = Window & typeof globalThis & { __pwned?: unknown };
type Posted = { jsonrpc?: string; id?: unknown; method?: string; params?: any; result?: unknown };

// jsdom ships no type declarations; a non-literal specifier keeps tsc from
// resolving the module while vitest loads it normally.
const JSDOM_MODULE: string = 'jsdom';
let JSDOMCtor: new (html: string, opts: Record<string, unknown>) => { window: Win };

beforeAll(async () => {
  JSDOMCtor = ((await import(JSDOM_MODULE)) as { JSDOM: typeof JSDOMCtor }).JSDOM;
});

function load() {
  const posted: Posted[] = [];
  const network = { fetch: vi.fn(), xhr: vi.fn(), ws: vi.fn(), open: vi.fn() };
  const dom = new JSDOMCtor(FLEET_HEALTH_VIEW_HTML, {
    runScripts: 'dangerously',
    beforeParse(win: Win) {
      // A top-level jsdom window is its own parent, so this is the host channel.
      (win as any).postMessage = (msg: Posted) => { posted.push(msg); };
      (win as any).fetch = network.fetch;
      (win as any).XMLHttpRequest = network.xhr;
      (win as any).WebSocket = network.ws;
      (win as any).open = network.open;
    },
  });
  const win = dom.window;
  const doc = win.document;
  const send = (data: unknown, source: unknown = win) => {
    win.dispatchEvent(new win.MessageEvent('message', { data, source: source as any }));
  };
  const initId = () => posted.find((m) => m.method === 'ui/initialize')?.id;
  const handshake = () => send({ jsonrpc: '2.0', id: initId(), result: { protocolVersion: '2026-01-26', hostCapabilities: {}, hostInfo: { name: 'host', version: '1' }, hostContext: {} } });
  const toolResult = (params: Record<string, unknown>) => send({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params });
  const q = (sel: string) => doc.querySelector(sel);
  const qa = (sel: string) => Array.from(doc.querySelectorAll(sel));
  return { win, doc, posted, network, send, handshake, toolResult, q, qa };
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    topIssueCount: 2,
    deviceId: 'd-1',
    orgId: 'o-1',
    siteId: 's-1',
    hostname: 'ws-01.example.test',
    osType: 'windows',
    status: 'online',
    reliabilityScore: 41,
    trendDirection: 'degrading',
    trendConfidence: 0.8,
    uptime30d: 97.25,
    crashCount30d: 3,
    hangCount30d: 1,
    serviceFailureCount30d: 0,
    hardwareErrorCount30d: 0,
    mtbfHours: 120,
    computedAt: '2026-10-20T00:00:00.000Z',
    provisional: false,
    ...overrides,
  };
}

function fixture(overrides: Record<string, unknown> = {}) {
  const devices = [
    row(),
    row({ deviceId: 'd-2', hostname: 'ws-02.example.test', reliabilityScore: 63, trendDirection: 'stable', provisional: true }),
    row({ deviceId: 'd-3', hostname: 'ws-03.example.test', reliabilityScore: 90, trendDirection: 'improving' }),
  ];
  return {
    devices,
    showing: 3, limit: 25, offset: 0, total: 3, totalMode: 'exact', hasMore: false, nextCursor: null,
    summary: { averageScore: 65, criticalDevices: 1, poorDevices: 1, fairDevices: 0, goodDevices: 1, degradingDevices: 1 },
    ...overrides,
  };
}

function result(structured: Record<string, unknown> | undefined, text = JSON.stringify(structured ?? {})) {
  return { content: [{ type: 'text', text }], ...(structured ? { structuredContent: structured } : {}) };
}

const HOSTILE = [
  '<img src=x onerror="window.__pwned=1">',
  '</script><script>window.__pwned=1</script>',
  '<svg onload="window.__pwned=1"></svg>',
];

describe('fleet-health view (D-B39)', () => {
  it('opens with ui/initialize (2026-01-26) and nothing else until the host answers', () => {
    const v = load();
    expect(v.posted).toHaveLength(1);
    expect(v.posted[0]).toMatchObject({ jsonrpc: '2.0', method: 'ui/initialize', params: { protocolVersion: '2026-01-26' } });
    expect(v.posted[0]!.id).toBeDefined();
    v.handshake();
    expect(v.posted.map((m) => m.method)).toEqual(['ui/initialize', 'ui/notifications/initialized']);
  });

  it('initializes, then renders summary bands and the worst-first table from structuredContent', () => {
    const v = load();
    v.handshake();
    v.toolResult(result(fixture()));
    expect(v.q('[data-testid="fh-band-critical"]')!.textContent).toContain('1');
    expect(v.q('[data-testid="fh-band-poor"]')!.textContent).toContain('1');
    expect(v.q('[data-testid="fh-band-fair"]')!.textContent).toContain('0');
    expect(v.q('[data-testid="fh-band-good"]')!.textContent).toContain('1');
    expect(v.q('[data-testid="fh-degrading"]')!.textContent).toContain('1');
    expect(v.q('[data-testid="fh-average"]')!.textContent).toContain('65');
    expect(v.qa('[data-testid="fh-row"]').map((r) => r.querySelector('[data-testid="fh-host"]')!.textContent))
      .toEqual(['ws-01.example.test', 'ws-02.example.test', 'ws-03.example.test']);
    const first = v.q('[data-testid="fh-row"]')!;
    expect(first.querySelector('[data-testid="fh-score"]')!.textContent).toBe('41');
    expect(first.textContent).toContain('97.3%');
    expect(first.textContent).toContain('degrading');
    expect(v.qa('[data-testid="fh-provisional"]')).toHaveLength(1);
  });

  it('labels the summary "matching devices" and says "worst first" only at offset 0', () => {
    const v = load();
    v.handshake();
    v.toolResult(result(fixture({ total: 40, hasMore: true })));
    expect(v.q('[data-testid="fh-total"]')!.textContent).toContain('40 matching devices');
    expect(v.q('[data-testid="fh-caption"]')!.textContent!.toLowerCase()).toContain('worst first');

    const w = load();
    w.handshake();
    w.toolResult(result(fixture({ total: 40, offset: 25, hasMore: true })));
    expect(w.q('[data-testid="fh-total"]')!.textContent).toContain('40 matching devices');
    expect(w.q('[data-testid="fh-total"]')!.textContent).toContain('showing 3 (offset 25)');
    expect(w.q('[data-testid="fh-caption"]')!.textContent!.toLowerCase()).not.toContain('worst first');
    expect(w.q('[data-testid="fh-caption"]')!.textContent).toContain('This page');
  });

  // Every string field the view renders gets every hostile payload.
  it.each(HOSTILE)('renders hostile strings as text in every rendered field: %s', (evil) => {
    const v = load();
    v.handshake();
    v.toolResult(result(fixture({
      devices: [row({ hostname: evil, trendDirection: evil, osType: evil, status: evil, computedAt: evil })],
      totalMode: evil,
    })));
    expect(v.doc.querySelectorAll('img, svg, script:not([data-view])').length).toBe(0);
    expect(v.win.__pwned).toBeUndefined();
    const r = v.q('[data-testid="fh-row"]')!;
    expect(r.querySelector('[data-testid="fh-host"]')!.textContent).toBe(evil);
    expect(r.querySelector('[data-testid="fh-trend"]')!.textContent).toBe(evil);
    expect(r.querySelector('[data-testid="fh-meta"]')!.textContent).toContain(evil);
    expect(r.querySelector('[data-testid="fh-meta"]')!.textContent!.split(evil).length - 1).toBe(3);
  });

  it('renders a hostile fallback text verbatim, never as markup', () => {
    const v = load();
    v.handshake();
    v.toolResult({ content: [{ type: 'text', text: HOSTILE.join('\n') }] });
    expect(v.q('[data-testid="fh-fallback"]')!.textContent).toBe(HOSTILE.join('\n'));
    expect(v.doc.querySelectorAll('img, svg, script:not([data-view])').length).toBe(0);
    expect(v.win.__pwned).toBeUndefined();
  });

  it('falls back to the text content when structuredContent is absent', () => {
    const v = load();
    v.handshake();
    const digest = '{"summarized":true,"summary":"Fleet: 3 devices…"}';
    v.toolResult({ content: [{ type: 'text', text: digest }] });
    expect(v.q('[data-testid="fh-fallback"]')!.textContent).toBe(digest);
    expect(v.q('[data-testid="fh-fallback"]')!.tagName).toBe('PRE');
    expect(v.qa('[data-testid="fh-row"]')).toHaveLength(0);
  });

  it.each([
    ['no devices array', { summary: {} }],
    ['devices not an array', { devices: {}, summary: {} }],
    ['no summary object', { devices: [] }],
    ['summary is an array', { devices: [], summary: [] }],
  ])('falls back to the text when structuredContent has the wrong shape: %s', (_label, sc) => {
    const v = load();
    v.handshake();
    v.toolResult(result(sc as Record<string, unknown>, 'plain text body'));
    expect(v.q('[data-testid="fh-fallback"]')!.textContent).toBe('plain text body');
  });

  it('falls back to the text for an isError result even when structuredContent is present', () => {
    const v = load();
    v.handshake();
    v.toolResult({ ...result(fixture(), '{"error":"Access denied to this organization"}'), isError: true });
    expect(v.q('[data-testid="fh-fallback"]')!.textContent).toBe('{"error":"Access denied to this organization"}');
    expect(v.qa('[data-testid="fh-row"]')).toHaveLength(0);
  });

  it('never fails blank even when reading the result itself throws', () => {
    const v = load();
    v.handshake();
    const exploding = {};
    Object.defineProperty(exploding, 'structuredContent', { enumerable: true, get() { throw new Error('boom'); } });
    Object.defineProperty(exploding, 'content', { enumerable: true, get() { throw new Error('boom'); } });
    v.toolResult(exploding);
    expect(v.q('[data-testid="fh-fallback"]')!.textContent).toBe('Unable to display this result.');
    expect(v.posted.at(-1)!.method).toBe('ui/notifications/size-changed');
  });

  it('never fails blank: no text and no structured content still renders a message', () => {
    const v = load();
    v.handshake();
    v.toolResult({ content: [] });
    expect(v.q('[data-testid="fh-fallback"]')!.textContent!.length).toBeGreaterThan(0);
  });

  it('shows "N more" when hasMore, never fetches', () => {
    const v = load();
    v.handshake();
    v.toolResult(result(fixture({ total: 40, hasMore: true, nextCursor: 'abc' })));
    expect(v.q('[data-testid="fh-more"]')!.textContent).toContain('37 more');
    expect(v.q('[data-testid="fh-more"]')!.textContent).toContain('ask for the next page');
    expect(v.network.fetch).not.toHaveBeenCalled();
    expect(v.network.xhr).not.toHaveBeenCalled();
    expect(v.network.ws).not.toHaveBeenCalled();
    expect(v.network.open).not.toHaveBeenCalled();

    const w = load();
    w.handshake();
    w.toolResult(result(fixture()));
    expect(w.q('[data-testid="fh-more"]')).toBeNull();
  });

  it('shows a partial-result banner for truncation marker strings and _chat, never a marker row', () => {
    const marker = '...[truncated 12 items]';
    const v = load();
    v.handshake();
    v.toolResult(result(fixture({ devices: [row(), row({ hostname: 'ws-02.example.test' }), marker] })));
    expect(v.q('[data-testid="fh-partial"]')).not.toBeNull();
    expect(v.qa('[data-testid="fh-row"]')).toHaveLength(2);
    expect(v.q('#root')!.textContent).not.toContain(marker);

    const w = load();
    w.handshake();
    w.toolResult(result(fixture({ _chat: { arrayItemsDropped: 4 } })));
    expect(w.q('[data-testid="fh-partial"]')).not.toBeNull();
    expect(w.qa('[data-testid="fh-row"]')).toHaveLength(3);

    const x = load();
    x.handshake();
    x.toolResult(result(fixture()));
    expect(x.q('[data-testid="fh-partial"]')).toBeNull();
  });

  it.each([null, 'NaN', Number.NaN, Number.POSITIVE_INFINITY, '42', undefined, {}])('renders non-finite numbers as —: %s', (bad) => {
    const v = load();
    v.handshake();
    v.toolResult(result(fixture({
      devices: [row({ reliabilityScore: bad, uptime30d: bad, crashCount30d: bad })],
      total: bad,
      summary: { averageScore: bad, criticalDevices: bad, poorDevices: 0, fairDevices: 0, goodDevices: 0, degradingDevices: bad },
    })));
    const r = v.q('[data-testid="fh-row"]')!;
    expect(r.querySelector('[data-testid="fh-score"]')!.textContent).toBe('—');
    expect(v.q('[data-testid="fh-band-critical"]')!.textContent).toContain('—');
    expect(v.q('[data-testid="fh-total"]')!.textContent).toContain('—');
    // #root only: body.textContent would include the inline script's source.
    expect(v.q('#root')!.textContent).not.toMatch(/NaN|Infinity|undefined|\[object/);
  });

  it.each([
    'not an object',
    null,
    ['jsonrpc', '2.0'],
    { jsonrpc: '1.0', method: 'ui/notifications/tool-result', params: {} },
    { jsonrpc: '2.0', method: 'ui/unknown', params: {} },
    { jsonrpc: '2.0', id: 999, result: {} },
    { method: 'ui/notifications/tool-result', params: {} },
  ])('ignores malformed message %j', (bad) => {
    const v = load();
    v.send(bad);
    v.handshake();
    v.send(bad);
    expect(v.posted.map((m) => m.method)).toEqual(['ui/initialize', 'ui/notifications/initialized']);
    expect(v.qa('[data-testid="fh-row"]')).toHaveLength(0);
    expect(v.q('[data-testid="fh-fallback"]')).toBeNull();
  });

  it('a response with the wrong id does not complete the handshake', () => {
    const v = load();
    v.send({ jsonrpc: '2.0', id: 'not-the-init-id', result: {} });
    v.toolResult(result(fixture()));
    expect(v.qa('[data-testid="fh-row"]')).toHaveLength(0);
    expect(v.posted.map((m) => m.method)).toEqual(['ui/initialize']);
  });

  it('ignores messages not from window.parent', () => {
    const v = load();
    const stranger = new JSDOMCtor('<!doctype html><p>x</p>', {}).window;
    v.send({ jsonrpc: '2.0', id: v.posted[0]!.id, result: {} }, stranger);
    v.send({ jsonrpc: '2.0', id: v.posted[0]!.id, result: {} }, null);
    expect(v.posted.map((m) => m.method)).toEqual(['ui/initialize']);
    v.handshake();
    v.send({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: result(fixture()) }, stranger);
    expect(v.qa('[data-testid="fh-row"]')).toHaveLength(0);
  });

  it('buffers a tool-result that arrives before the initialize response and renders it after (latest wins)', () => {
    const v = load();
    v.toolResult(result(fixture({ devices: [row({ hostname: 'old.example.test' })] })));
    v.toolResult(result(fixture()));
    expect(v.qa('[data-testid="fh-row"]')).toHaveLength(0);
    v.handshake();
    expect(v.qa('[data-testid="fh-row"]')).toHaveLength(3);
    expect(v.q('#root')!.textContent).not.toContain('old.example.test');
  });

  it('shows a cancelled line on tool-cancelled and ignores tool-input', () => {
    const v = load();
    v.handshake();
    v.send({ jsonrpc: '2.0', method: 'ui/notifications/tool-input', params: { arguments: { limit: 5 } } });
    v.send({ jsonrpc: '2.0', method: 'ui/notifications/tool-input-partial', params: { arguments: {} } });
    expect(v.q('[data-testid="fh-cancelled"]')).toBeNull();
    v.send({ jsonrpc: '2.0', method: 'ui/notifications/tool-cancelled', params: { reason: '<b>user</b>' } });
    expect(v.q('[data-testid="fh-cancelled"]')!.textContent).toContain('cancelled');
    expect(v.doc.querySelectorAll('b').length).toBe(0);
  });

  it('posts size-changed after render', () => {
    const v = load();
    v.handshake();
    v.toolResult(result(fixture()));
    const last = v.posted.at(-1)!;
    expect(last.method).toBe('ui/notifications/size-changed');
    expect(typeof last.params.width).toBe('number');
    expect(typeof last.params.height).toBe('number');
    expect(last).not.toHaveProperty('id');
  });

  it('answers ping and ui/resource-teardown with an empty result (responses, not calls)', () => {
    const v = load();
    v.handshake();
    v.send({ jsonrpc: '2.0', id: 7, method: 'ping' });
    v.send({ jsonrpc: '2.0', id: 8, method: 'ui/resource-teardown', params: {} });
    const responses = v.posted.filter((m) => m.method === undefined);
    expect(responses).toEqual([{ jsonrpc: '2.0', id: 7, result: {} }, { jsonrpc: '2.0', id: 8, result: {} }]);
  });

  it('sends no tools/call, resources/read, ui/message or ui/open-link', () => {
    const v = load();
    v.send({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: result(fixture()) });
    v.handshake();
    v.toolResult(result(fixture({ total: 40, hasMore: true })));
    v.toolResult({ content: [{ type: 'text', text: 'x' }] });
    v.send({ jsonrpc: '2.0', method: 'ui/notifications/tool-cancelled', params: {} });
    for (const button of v.qa('button, a')) (button as HTMLElement).click();
    const methods = new Set(v.posted.map((m) => m.method).filter((m) => m !== undefined));
    for (const method of methods) {
      expect(['ui/initialize', 'ui/notifications/initialized', 'ui/notifications/size-changed']).toContain(method);
    }
  });
});
