import { describe, it, expect, vi, beforeEach } from 'vitest';
import { connectVnc, type VncDeps } from './vnc';

// Mock the noVNC wrapper. RFB is a constructor that records listeners.
vi.mock('../novnc', () => {
  return {
    RFB: vi.fn(function (this: any, container: HTMLElement, wsUrl: string, opts: unknown) {
      this._listeners = {} as Record<string, Array<(e: any) => void>>;
      this._container = container;
      this._wsUrl = wsUrl;
      this._opts = opts;
      this.scaleViewport = true;
      this.resizeSession = false;
      this.showDotCursor = true;
      this.addEventListener = (ev: string, cb: (e: any) => void) => {
        (this._listeners[ev] ||= []).push(cb);
      };
      this.removeEventListener = vi.fn();
      this.sendCredentials = vi.fn();
      this.disconnect = vi.fn();
      this.clipboardPasteFrom = vi.fn();
    }),
  };
});

function makeDeps(overrides: Partial<VncDeps> = {}): VncDeps {
  return {
    container: document.createElement('div'),
    onStatus: vi.fn(),
    onError: vi.fn(),
    onCredentialsRequired: vi.fn(),
    ...overrides,
  };
}

async function fireEvent(rfb: any, ev: string, detail?: unknown) {
  const cbs = rfb._listeners[ev] || [];
  for (const cb of cbs) cb({ detail });
}

describe('connectVnc', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns a TransportSession with kind=vnc and clipboardChannel capability', async () => {
    const deps = makeDeps();
    const session = await connectVnc({ tunnelId: 't1', wsUrl: 'wss://api/x' }, deps);
    expect(session.kind).toBe('vnc');
    expect(session.capabilities.clipboardChannel).toBe(true);
    expect(session.capabilities.monitors).toBe(false);
    expect(session.capabilities.bitrateControl).toBe(false);
    expect(session.vncContainer).toBe(deps.container);
  });

  it('fires onStatus("connecting") synchronously and onStatus("connected") when RFB connects', async () => {
    const deps = makeDeps();
    await connectVnc({ tunnelId: 't1', wsUrl: 'wss://api/x' }, deps);
    expect(deps.onStatus).toHaveBeenCalledWith('connecting');

    const { RFB } = await import('../novnc');
    const rfb = (RFB as unknown as { mock: { results: Array<{ value: any }> } }).mock.results[0].value;
    await fireEvent(rfb, 'connect');
    expect(deps.onStatus).toHaveBeenCalledWith('connected');
  });

  it('fires onStatus("disconnected") on clean disconnect and onStatus("error") + onError on unclean', async () => {
    const deps = makeDeps();
    await connectVnc({ tunnelId: 't1', wsUrl: 'wss://api/x' }, deps);
    const { RFB } = await import('../novnc');
    const rfb = (RFB as unknown as { mock: { results: Array<{ value: any }> } }).mock.results[0].value;

    await fireEvent(rfb, 'disconnect', { clean: true });
    expect(deps.onStatus).toHaveBeenCalledWith('disconnected');

    // Reset for unclean case with a new instance
    vi.clearAllMocks();
    const deps2 = makeDeps();
    await connectVnc({ tunnelId: 't2', wsUrl: 'wss://api/x' }, deps2);
    const rfb2 = (RFB as unknown as { mock: { results: Array<{ value: any }> } }).mock.results[0].value;
    await fireEvent(rfb2, 'disconnect', { clean: false });
    expect(deps2.onStatus).toHaveBeenCalledWith('error');
    expect(deps2.onError).toHaveBeenCalledWith(expect.stringMatching(/lost/i));
  });

  it('invokes onCredentialsRequired with requiresUsername=true for ARD (type 30) auth', async () => {
    const deps = makeDeps();
    await connectVnc({ tunnelId: 't1', wsUrl: 'wss://api/x' }, deps);
    const { RFB } = await import('../novnc');
    const rfb = (RFB as unknown as { mock: { results: Array<{ value: any }> } }).mock.results[0].value;

    await fireEvent(rfb, 'credentialsrequired', { types: ['username', 'password'] });
    expect(deps.onCredentialsRequired).toHaveBeenCalledWith(true, expect.any(Function));
  });

  it('invokes onCredentialsRequired with requiresUsername=false for plain VNC auth', async () => {
    const deps = makeDeps();
    await connectVnc({ tunnelId: 't1', wsUrl: 'wss://api/x' }, deps);
    const { RFB } = await import('../novnc');
    const rfb = (RFB as unknown as { mock: { results: Array<{ value: any }> } }).mock.results[0].value;

    await fireEvent(rfb, 'credentialsrequired', { types: ['password'] });
    expect(deps.onCredentialsRequired).toHaveBeenCalledWith(false, expect.any(Function));
  });

  it('credentials submit callback routes to rfb.sendCredentials', async () => {
    const deps = makeDeps();
    await connectVnc({ tunnelId: 't1', wsUrl: 'wss://api/x' }, deps);
    const { RFB } = await import('../novnc');
    const rfb = (RFB as unknown as { mock: { results: Array<{ value: any }> } }).mock.results[0].value;

    await fireEvent(rfb, 'credentialsrequired', { types: ['username', 'password'] });
    const [, submit] = (deps.onCredentialsRequired as unknown as { mock: { calls: any[][] } }).mock.calls[0];
    submit({ username: 'olive', password: 'secret' });
    expect(rfb.sendCredentials).toHaveBeenCalledWith({ username: 'olive', password: 'secret' });
  });

  it('fires onError with sanitised fallback when server reason is unknown', async () => {
    const deps = makeDeps();
    await connectVnc({ tunnelId: 't1', wsUrl: 'wss://api/x' }, deps);
    const { RFB } = await import('../novnc');
    const rfb = (RFB as unknown as { mock: { results: Array<{ value: any }> } }).mock.results[0].value;

    await fireEvent(rfb, 'securityfailure', { status: 1, reason: 'wrong password' });
    expect(deps.onError).toHaveBeenCalledWith(expect.stringMatching(/connection refused by remote/));
    expect(deps.onError).toHaveBeenCalledWith(expect.not.stringMatching(/wrong password/));
    expect(deps.onStatus).toHaveBeenCalledWith('error');
  });

  it('session.close() calls rfb.disconnect idempotently', async () => {
    const session = await connectVnc({ tunnelId: 't1', wsUrl: 'wss://api/x' }, makeDeps());
    const { RFB } = await import('../novnc');
    const rfb = (RFB as unknown as { mock: { results: Array<{ value: any }> } }).mock.results[0].value;

    session.close();
    session.close(); // must not throw
    expect(rfb.disconnect).toHaveBeenCalled();
  });

  it('does not include raw server reason text in the error', async () => {
    const seen: string[] = [];
    const deps = makeDeps({
      onError: (msg: string) => seen.push(msg),
    });
    await connectVnc({ tunnelId: 't1', wsUrl: 'wss://api/x' }, deps);
    const { RFB } = await import('../novnc');
    const rfb = (RFB as unknown as { mock: { results: Array<{ value: any }> } }).mock.results[0].value;

    await fireEvent(rfb, 'securityfailure', {
      status: 1,
      reason: '<script>alert(1)</script>',
    });
    expect(seen.some((m) => m.includes('<script>'))).toBe(false);
  });

  it.each([
    ['authentication failed', 'authentication failed'],
    ['Authentication failed.', 'authentication failed.'],
    ['too many attempts', 'too many attempts'],
    ['unsupported security type', 'unsupported security type'],
    ['unsupported protocol version', 'unsupported protocol version'],
    ['<script>alert(1)</script>', 'connection refused by remote'],
    ['unknown reason', 'connection refused by remote'],
    ['', 'connection refused by remote'],
  ])('sanitises VNC reason "%s" → "%s"', async (input, expected) => {
    const seen: string[] = [];
    const deps = makeDeps({
      onError: (msg: string) => seen.push(msg),
    });
    await connectVnc({ tunnelId: 't1', wsUrl: 'wss://api/x' }, deps);
    const { RFB } = await import('../novnc');
    const rfb = (RFB as unknown as { mock: { results: Array<{ value: any }> } }).mock.results[0].value;

    await fireEvent(rfb, 'securityfailure', { status: 1, reason: input });
    expect(seen.join('\n')).toContain(expected);
    // Verify XSS attempt does not leak through
    if (input.includes('<script>')) {
      expect(seen.join('\n')).not.toContain('<script>');
    }
  });
});
