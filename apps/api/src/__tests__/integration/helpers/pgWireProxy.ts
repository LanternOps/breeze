/**
 * In-process Postgres wire proxy for the #8143 pool-recovery suite.
 *
 * It understands just enough of the frontend protocol to:
 *   - count simple-query BEGINs (postgres.js sends `begin` via `sql.unsafe`,
 *     i.e. a simple 'Q' message), so a test can prove an acquire-timed-out
 *     request never reached the driver;
 *   - recognise the RLS prologue (`select set_config('breeze.…`) by tracking
 *     Parse→Bind per statement name, then at its Execute either
 *       * withhold every later client→server byte on that connection: the
 *         backend has the Bind and sits `active` / `ClientRead` on the
 *         prologue forever, which is the #6048 wedge, or
 *       * withhold server→client bytes until resume(): a slow database whose
 *         reply arrives after the deadline.
 * Only connections whose startup `application_name` matches
 * `holdApplicationName` (default 'breeze-api') are ever held, so the
 * reclaimer's side clients pass straight through.
 *
 * Plaintext only: TLS is unsupported. An SSLRequest is forwarded untouched, so
 * if the upstream answers 'S' the stream becomes encrypted and the parser can
 * no longer see Parse/Bind/Execute. Point it at a non-TLS test Postgres
 * (`sslmode` off/prefer-without-server-TLS), as the integration stack is.
 */
import net from 'node:net';

const SSL_REQUEST_CODE = 80877103;
const GSSENC_REQUEST_CODE = 80877104;
const PROTOCOL_3 = 196608;
const PROLOGUE_PREFIX = "select set_config('breeze.";

export interface PgWireProxyStats {
  connections: number;
  begins: number;
  prologueExecutes: number;
}

export interface PgWireProxy {
  readonly port: number;
  readonly stats: PgWireProxyStats;
  urlFor(url: string): string;
  armWedgeOnNextPrologue(): void;
  armHoldResponsesAfterNextPrologue(): void;
  /**
   * One-shot: right after the next held-app prologue (and the rest of its
   * chunk, incl. Sync) is forwarded upstream, call `stall` synchronously. A
   * busy-wait there stalls the event loop while the prologue is IN FLIGHT, so
   * its reply lands buffered behind the stall — the case that abandons a permit.
   */
  armStallAfterNextPrologue(stall: () => void): void;
  resume(): void;
  close(): Promise<void>;
}

interface FrontendMessage {
  /** null for untyped startup-phase messages. */
  type: string | null;
  raw: Buffer;
  body: Buffer;
}

function readCString(buf: Buffer, offset: number): [string, number] {
  const end = buf.indexOf(0, offset);
  if (end === -1) return [buf.toString('utf8', offset), buf.length];
  return [buf.toString('utf8', offset, end), end + 1];
}

function parseStartupApplicationName(body: Buffer): string | null {
  let offset = 0;
  while (offset < body.length && body[offset] !== 0) {
    const [key, afterKey] = readCString(body, offset);
    const [value, afterValue] = readCString(body, afterKey);
    if (key === 'application_name') return value;
    offset = afterValue;
  }
  return null;
}

class FrontendParser {
  private buffer = Buffer.alloc(0);
  private startupPhase = true;

  constructor(private readonly onMessage: (message: FrontendMessage) => void) {}

  push(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      if (this.startupPhase) {
        if (this.buffer.length < 8) return;
        const length = this.buffer.readInt32BE(0);
        if (this.buffer.length < length) return;
        const raw = this.buffer.subarray(0, length);
        this.buffer = this.buffer.subarray(length);
        const code = raw.readInt32BE(4);
        if (code !== SSL_REQUEST_CODE && code !== GSSENC_REQUEST_CODE) this.startupPhase = false;
        this.onMessage({ type: null, raw, body: raw.subarray(8) });
        continue;
      }
      if (this.buffer.length < 5) return;
      const length = this.buffer.readInt32BE(1);
      if (this.buffer.length < 1 + length) return;
      const raw = this.buffer.subarray(0, 1 + length);
      this.buffer = this.buffer.subarray(1 + length);
      this.onMessage({ type: String.fromCharCode(raw[0]!), raw, body: raw.subarray(5) });
    }
  }
}

interface ProxiedConnection {
  client: net.Socket;
  upstream: net.Socket;
  applicationName: string | null;
  statements: Map<string, string>;
  lastBindIsPrologue: boolean;
  clientHeld: boolean;
  serverHeld: boolean;
  heldServerChunks: Buffer[];
}

export async function startPgWireProxy(
  target: { host: string; port: number },
  options: { holdApplicationName?: string } = {},
): Promise<PgWireProxy> {
  const holdApplicationName = options.holdApplicationName ?? 'breeze-api';
  const stats: PgWireProxyStats = { connections: 0, begins: 0, prologueExecutes: 0 };
  const connections = new Set<ProxiedConnection>();
  let wedgeArmed = false;
  let holdResponsesArmed = false;
  let stallArmed: (() => void) | null = null;
  let pendingStall: (() => void) | null = null;

  const isBegin = (query: string): boolean => /^\s*begin\b/i.test(query);

  function onFrontendMessage(conn: ProxiedConnection, message: FrontendMessage): void {
    if (conn.clientHeld) return; // wedged: the backend never sees another byte
    if (message.type === null) {
      if (message.raw.readInt32BE(4) === PROTOCOL_3) {
        conn.applicationName = parseStartupApplicationName(message.body);
      }
    } else if (message.type === 'Q') {
      const [query] = readCString(message.body, 0);
      if (isBegin(query)) stats.begins += 1;
    } else if (message.type === 'P') {
      const [name, next] = readCString(message.body, 0);
      const [query] = readCString(message.body, next);
      conn.statements.set(name, query);
    } else if (message.type === 'B') {
      const [, next] = readCString(message.body, 0);
      const [statement] = readCString(message.body, next);
      conn.lastBindIsPrologue = (conn.statements.get(statement) ?? '').startsWith(PROLOGUE_PREFIX);
    } else if (message.type === 'E' && conn.lastBindIsPrologue) {
      stats.prologueExecutes += 1;
      if (conn.applicationName === holdApplicationName) {
        if (wedgeArmed) {
          wedgeArmed = false;
          conn.clientHeld = true;
          return;
        }
        if (holdResponsesArmed) {
          holdResponsesArmed = false;
          conn.serverHeld = true;
        }
        if (stallArmed) {
          pendingStall = stallArmed;
          stallArmed = null;
        }
      }
    }
    conn.upstream.write(message.raw);
  }

  /** Runs a stall armed by armStallAfterNextPrologue once the whole chunk (incl. Sync) is forwarded. */
  function runPendingStall(): void {
    const stall = pendingStall;
    pendingStall = null;
    stall?.();
  }

  const server = net.createServer((client) => {
    const upstream = net.connect(target.port, target.host);
    const conn: ProxiedConnection = {
      client,
      upstream,
      applicationName: null,
      statements: new Map(),
      lastBindIsPrologue: false,
      clientHeld: false,
      serverHeld: false,
      heldServerChunks: [],
    };
    connections.add(conn);
    stats.connections += 1;
    const parser = new FrontendParser((message) => onFrontendMessage(conn, message));
    client.on('data', (chunk: Buffer) => {
      parser.push(chunk);
      runPendingStall();
    });
    upstream.on('data', (chunk: Buffer) => {
      if (conn.serverHeld) conn.heldServerChunks.push(chunk);
      else client.write(chunk);
    });
    const teardown = (): void => {
      client.destroy();
      upstream.destroy();
      connections.delete(conn);
    };
    client.on('close', teardown);
    upstream.on('close', teardown);
    client.on('error', () => {});
    upstream.on('error', () => {});
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;

  return {
    port,
    stats,
    urlFor(url: string): string {
      const parsed = new URL(url);
      parsed.hostname = '127.0.0.1';
      parsed.port = String(port);
      return parsed.toString();
    },
    armWedgeOnNextPrologue() {
      wedgeArmed = true;
    },
    armStallAfterNextPrologue(stall: () => void) {
      stallArmed = stall;
    },
    armHoldResponsesAfterNextPrologue() {
      holdResponsesArmed = true;
    },
    resume() {
      for (const conn of connections) {
        if (!conn.serverHeld) continue;
        conn.serverHeld = false;
        for (const chunk of conn.heldServerChunks.splice(0)) conn.client.write(chunk);
      }
    },
    async close() {
      for (const conn of connections) {
        conn.client.destroy();
        conn.upstream.destroy();
      }
      connections.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
