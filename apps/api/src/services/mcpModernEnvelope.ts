/**
 * B-W03 (#6157): pure pre-dispatch checks for the MCP Streamable HTTP endpoint.
 *
 * - `validateJsonRpcEnvelope` — the JSON-RPC shape every request (both eras)
 *   must have before any field is dereferenced (D-B15).
 * - `classifyMcpRequest` — the one era decision per request. The numbered
 *   "Row N" comments in the function are the decision table: rows are
 *   evaluated in order and the first match wins. (Design history: plan
 *   docs/superpowers/plans/ai-mcp/2026-10-18-mcp-modernization-b03-stateless-cimd.md,
 *   decision D-B13.)
 * - `decodeMcpHeaderValue` — SEP-2243 header value decoding (`=?base64?…?=`).
 *
 * No I/O, no env reads: the caller snapshots `MCP_STATELESS_ENABLED` once per
 * request and passes it in, so classification and the advertised version list
 * can never disagree.
 */
import { Buffer } from 'node:buffer';
import {
  isLegacyMcpProtocolVersion,
  isModernMcpProtocolVersion,
  supportedMcpProtocolVersions,
  type ModernMcpProtocolVersion,
} from './mcpProtocol';

/** SEP-2243: an `Mcp-*` / `MCP-Protocol-Version` header disagrees with the body. */
export const MCP_HEADER_MISMATCH = -32020;
/** The modern `_meta` names a protocol version this server does not speak. */
export const MCP_UNSUPPORTED_PROTOCOL_VERSION = -32022;

const META_PROTOCOL_VERSION = 'io.modelcontextprotocol/protocolVersion';
const META_CLIENT_CAPABILITIES = 'io.modelcontextprotocol/clientCapabilities';
const META_CLIENT_INFO = 'io.modelcontextprotocol/clientInfo';

export type JsonRpcEnvelope = {
  jsonrpc: '2.0';
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
};

export type ModernRequestMeta = {
  protocolVersion: ModernMcpProtocolVersion;
  clientCapabilities: Record<string, unknown>;
  clientInfo: unknown;
};

export type McpRejectReason =
  | 'contradictory_initialize'
  | 'modern_on_legacy_endpoint'
  | 'modern_disabled'
  | 'legacy_version_in_modern_envelope'
  | 'unsupported_version'
  | 'missing_client_capabilities'
  | 'header_mismatch'
  | 'header_modern_without_meta';

export type McpRejection = {
  status: 400 | 403 | 404;
  error: { code: number; message: string; data?: unknown };
  reason: McpRejectReason;
};

export type McpEraDecision =
  | { era: 'legacy' }
  | { era: 'modern'; meta: ModernRequestMeta }
  | { era: 'reject'; rejection: McpRejection };

/** Raw header values; `undefined` = header absent. */
export type McpRequestHeaders = { protocolVersion?: string; method?: string; name?: string };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isValidId(v: unknown): v is string | number {
  return typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v));
}

export function validateJsonRpcEnvelope(
  body: unknown,
): { ok: true; body: JsonRpcEnvelope } | { ok: false; id: string | number | null } {
  if (!isPlainObject(body)) return { ok: false, id: null };
  const id = isValidId(body.id) ? body.id : null;
  if (body.jsonrpc !== '2.0') return { ok: false, id };
  if (typeof body.method !== 'string' || body.method.length === 0) return { ok: false, id };
  if ('id' in body && body.id !== undefined && !isValidId(body.id)) return { ok: false, id: null };
  if ('params' in body && body.params !== undefined && !isPlainObject(body.params)) return { ok: false, id };
  return { ok: true, body: body as JsonRpcEnvelope };
}

/** Visible ASCII (0x20–0x7E) or horizontal tab only. */
function isValidHeaderChars(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c === 0x09) continue;
    if (c < 0x20 || c > 0x7e) return false;
  }
  return true;
}

const BASE64_SENTINEL = /^=\?base64\?(.*)\?=$/;
const STRICT_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export function decodeMcpHeaderValue(raw: string): { ok: true; value: string } | { ok: false } {
  if (!isValidHeaderChars(raw)) return { ok: false };
  const match = BASE64_SENTINEL.exec(raw);
  if (!match) return { ok: true, value: raw };
  const encoded = match[1] ?? '';
  if (!STRICT_BASE64.test(encoded)) return { ok: false };
  try {
    // ignoreBOM: a BOM-prefixed name is a different name; stripping it would
    // let the header and body disagree byte-wise yet compare equal.
    const value = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.from(encoded, 'base64'));
    return { ok: true, value };
  } catch {
    return { ok: false };
  }
}

function reject(
  status: McpRejection['status'],
  code: number,
  message: string,
  reason: McpRejectReason,
  data?: unknown,
): McpEraDecision {
  return { era: 'reject', rejection: { status, error: data === undefined ? { code, message } : { code, message, data }, reason } };
}

/** Methods whose `Mcp-Name` header mirrors a body field (SEP-2243). */
function nameTargetFor(body: JsonRpcEnvelope): { required: boolean; value: unknown } {
  switch (body.method) {
    case 'tools/call':
    case 'prompts/get':
      return { required: true, value: body.params?.name };
    case 'resources/read':
      return { required: true, value: body.params?.uri };
    default:
      return { required: false, value: undefined };
  }
}

function headersMatchBody(body: JsonRpcEnvelope, headers: McpRequestHeaders): boolean {
  for (const raw of [headers.protocolVersion, headers.method, headers.name]) {
    if (raw !== undefined && !isValidHeaderChars(raw)) return false;
  }
  if (headers.method === undefined || headers.method !== body.method) return false;
  const target = nameTargetFor(body);
  if (target.required) {
    if (headers.name === undefined || typeof target.value !== 'string') return false;
    const decoded = decodeMcpHeaderValue(headers.name);
    if (!decoded.ok || decoded.value !== target.value) return false;
  }
  return true;
}

export function classifyMcpRequest(input: {
  body: JsonRpcEnvelope;
  headers: McpRequestHeaders;
  statelessEnabled: boolean;
  endpoint: 'streamable' | 'legacy_message';
}): McpEraDecision {
  const { body, headers, statelessEnabled, endpoint } = input;
  const meta = isPlainObject(body.params?._meta) ? body.params._meta : undefined;
  const metaV = meta?.[META_PROTOCOL_VERSION];
  const hdrV = headers.protocolVersion;

  // Row 1–2: initialize is always legacy; modern _meta on it is contradictory.
  if (body.method === 'initialize') {
    if (metaV !== undefined) {
      return reject(400, -32600, 'initialize cannot carry a stateless protocol envelope', 'contradictory_initialize', {
        supported: supportedMcpProtocolVersions(statelessEnabled),
      });
    }
    return { era: 'legacy' };
  }
  // Row 3: legacy HTTP+SSE never serves modern envelopes.
  if (endpoint === 'legacy_message' && (metaV !== undefined || isModernMcpProtocolVersion(hdrV))) {
    return reject(400, -32600, 'Stateless protocol requests are not accepted on the legacy HTTP+SSE endpoint', 'modern_on_legacy_endpoint');
  }
  if (metaV === undefined) {
    // Row 4: a modern header without the body envelope (flag on only; with the
    // flag off legacy answers its own "Unsupported MCP-Protocol-Version").
    if (isModernMcpProtocolVersion(hdrV) && statelessEnabled) {
      return reject(400, MCP_HEADER_MISMATCH, 'MCP-Protocol-Version header requires a matching _meta protocol version', 'header_modern_without_meta');
    }
    // Row 5.
    return { era: 'legacy' };
  }
  // Row 6: not a recognised modern error, so a dual-era client falls back to initialize.
  if (!statelessEnabled) {
    return reject(400, -32600, 'Stateless protocol is not enabled on this server; use initialize', 'modern_disabled');
  }
  // Row 7.
  if (typeof metaV !== 'string' || hdrV !== metaV) {
    return reject(400, MCP_HEADER_MISMATCH, 'MCP-Protocol-Version header does not match _meta protocol version', 'header_mismatch');
  }
  // Row 8: answering -32022 here would loop (supported lists this version).
  if (isLegacyMcpProtocolVersion(metaV)) {
    return reject(400, -32600, `Protocol ${metaV} requires initialize to use protocol ${metaV}`, 'legacy_version_in_modern_envelope');
  }
  // Row 9.
  if (!isModernMcpProtocolVersion(metaV)) {
    return reject(400, MCP_UNSUPPORTED_PROTOCOL_VERSION, 'Unsupported protocol version', 'unsupported_version', {
      supported: supportedMcpProtocolVersions(true),
      requested: metaV,
    });
  }
  // Row 10.
  const clientCapabilities = meta?.[META_CLIENT_CAPABILITIES];
  if (!isPlainObject(clientCapabilities)) {
    return reject(400, -32602, 'Missing or invalid _meta client capabilities', 'missing_client_capabilities');
  }
  // Row 11.
  if (!headersMatchBody(body, headers)) {
    return reject(400, MCP_HEADER_MISMATCH, 'Mcp-Method or Mcp-Name header does not match the request body', 'header_mismatch');
  }
  // Row 12.
  return {
    era: 'modern',
    meta: { protocolVersion: metaV, clientCapabilities, clientInfo: meta?.[META_CLIENT_INFO] },
  };
}
