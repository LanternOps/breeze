import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

export interface CapturedRequest {
  label: string;
  at: string;
  path: string;
  model: string | null;
  betaHeader: string | null;
  /** JSON.stringify(body.system).length, as used by the capture report. */
  systemBytes: number;
  tools: Array<{ name: string; deferLoading: boolean }>;
  toolReferenceCount: number;
  status: number;
  ttfbMs: number;
  usage: {
    inputTokens: number;
    cacheCreationInputTokens: number;
    cacheReadInputTokens: number;
    outputTokens: number;
  } | null;
}

export interface CaptureProxy {
  url: string;
  setLabel(label: string): void;
  records(): CapturedRequest[];
  close(): Promise<void>;
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function parseObject(text: string): Record<string, unknown> {
  try { return object(JSON.parse(text)); } catch { return {}; }
}

function countToolReferences(value: unknown): number {
  if (Array.isArray(value)) return value.reduce((count, item) => count + countToolReferences(item), 0);
  const record = object(value);
  return (record.type === 'tool_reference' ? 1 : 0)
    + Object.values(record).reduce<number>((count, item) => count + countToolReferences(item), 0);
}

function captureUsage(text: string, isSse: boolean): CapturedRequest['usage'] {
  let raw: Record<string, unknown> | null = null;
  if (isSse) {
    for (const event of text.split(/\r?\n\r?\n/)) {
      const data = event.split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).replace(/^ /, '')).join('\n');
      const message = parseObject(data);
      if (message.type === 'message_start' && object(message.message).usage != null) {
        raw = object(object(message.message).usage);
      } else if (message.type === 'message_delta' && object(message.usage).output_tokens != null) {
        raw = { ...raw, output_tokens: object(message.usage).output_tokens };
      }
    }
  } else {
    const response = parseObject(text);
    if (response.usage != null) raw = object(response.usage);
  }
  if (raw === null) return null;
  const usage = raw;
  const number = (key: string): number => typeof usage[key] === 'number' ? usage[key] : 0;
  return {
    inputTokens: number('input_tokens'),
    cacheCreationInputTokens: number('cache_creation_input_tokens'),
    cacheReadInputTokens: number('cache_read_input_tokens'),
    outputTokens: number('output_tokens'),
  };
}

/** Local measurement only: request bodies and auth headers are never retained in records. */
export async function startCaptureProxy(upstream: string): Promise<CaptureProxy> {
  const target = new URL(upstream);
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw new Error('Capture proxy upstream must use HTTP or HTTPS');
  }
  const request = target.protocol === 'https:' ? httpsRequest : httpRequest;
  const records: CapturedRequest[] = [];
  let label = '';
  const server = createServer((req, res) => {
    const startedAt = Date.now();
    const requestLabel = label;
    const chunks: Buffer[] = [];
    req.on('error', () => res.destroy());
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const bodyBuffer = Buffer.concat(chunks);
      const body = parseObject(bodyBuffer.toString('utf8'));
      const record: CapturedRequest = {
        label: requestLabel,
        at: new Date(startedAt).toISOString(),
        path: req.url ?? '/',
        model: typeof body.model === 'string' ? body.model : null,
        betaHeader: req.headers['anthropic-beta']?.toString() ?? null,
        systemBytes: JSON.stringify(body.system)?.length ?? 0,
        tools: Array.isArray(body.tools) ? body.tools.flatMap((value) => {
          const tool = object(value);
          return typeof tool.name === 'string'
            ? [{ name: tool.name, deferLoading: tool.defer_loading === true }] : [];
        }) : [],
        toolReferenceCount: countToolReferences(body.messages),
        status: 0,
        ttfbMs: 0,
        usage: null,
      };
      const forward = request(target, {
        method: req.method,
        path: req.url,
        headers: { ...req.headers, host: target.host },
      }, (up) => {
        record.status = up.statusCode ?? 502;
        // Headers are the first upstream response bytes, even for empty bodies.
        record.ttfbMs = Date.now() - startedAt;
        res.writeHead(record.status, up.headers);
        const responseChunks: Buffer[] = [];
        up.on('data', (chunk: Buffer) => {
          responseChunks.push(chunk);
          if (!res.write(chunk)) up.pause();
        });
        res.on('drain', () => up.resume());
        up.on('error', () => res.destroy());
        up.on('end', () => {
          record.usage = captureUsage(Buffer.concat(responseChunks).toString('utf8'),
            up.headers['content-type']?.includes('text/event-stream') ?? false);
          records.push(record);
          res.end();
        });
        res.on('close', () => up.destroy());
      });
      forward.on('error', () => {
        if (res.headersSent) res.destroy();
        else { res.writeHead(502); res.end('Upstream request failed'); }
      });
      res.on('close', () => forward.destroy());
      forward.end(bodyBuffer);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${address.port}`,
    setLabel(value) { label = value; },
    records() { return structuredClone(records); },
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}
