import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { qualifiedToolName, QUALIFIED_TOOL_NAME_MAX, SOURCE_TOOL_NAME_RE } from '@breeze/shared';
import { dereferenceLocal, OpenApiSpecError, parseOpenApiDocument } from './openapiSpec';
import {
  asOperationBinding,
  MAX_OPERATIONS,
  MAX_PARAMETERS,
  MAX_SCHEMA_BYTES,
  operationToolName,
  projectOpenApiDocument,
  type ProjectedOperation,
} from './openapiProjection';
import { proposeTier } from './discovery';

const load = (f: string) => dereferenceLocal(parseOpenApiDocument(readFileSync(join(__dirname, '__fixtures__', f), 'utf8')));
const CTX = { sourceSlug: 'petsvc', credentialOrigin: 'https://api.example.com', specUrl: 'https://api.example.com/v1/openapi.json' };
const byName = (ops: ProjectedOperation[], n: string) => {
  const op = ops.find((o) => o.name === n);
  if (!op) throw new Error(`no operation ${n}; have ${ops.map((o) => o.name).join(', ')}`);
  return op;
};
const doc = (paths: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  dereferenceLocal({ openapi: '3.1.0', info: { title: 't', version: '1' }, paths, ...extra });
const ok = { responses: { '200': { description: 'ok' } } };

describe('projectOpenApiDocument — petstore', () => {
  const result = projectOpenApiDocument(load('petstore.json'), CTX);

  it('projects one tool per supported operation, named from operationId', () => {
    expect(result.operations.map((o) => o.name).sort()).toEqual(['createPets', 'deletePet', 'listPets', 'showPetById']);
    expect(result.operationCount).toBe(4);
  });

  it('records OPTIONS as skipped, never projected', () => {
    expect(result.skipped).toEqual([{ name: 'OPTIONS /pets/{petId}', method: 'OPTIONS', path: '/pets/{petId}', reason: 'unsupported_method' }]);
  });

  it('maps HTTP verbs to tiers fail-closed through the unchanged proposeTier', () => {
    const tierOf = (n: string) => proposeTier(byName(result.operations, n).annotations);
    expect(tierOf('listPets')).toBe(1);
    expect(tierOf('showPetById')).toBe(1);
    expect(tierOf('createPets')).toBe(3);
    expect(tierOf('deletePet')).toBe(3);
    expect(byName(result.operations, 'deletePet').annotations.destructiveHint).toBe(true);
    expect(byName(result.operations, 'createPets').annotations.readOnlyHint).toBeUndefined();
  });

  it('records the routing binding, merging path-item parameters', () => {
    const binding = asOperationBinding(byName(result.operations, 'showPetById').annotations)!;
    expect(binding.method).toBe('get');
    expect(binding.path).toBe('/pets/{petId}');
    expect(binding.operationId).toBe('showPetById');
    expect(binding.params).toEqual([{ name: 'petId', in: 'path', property: 'petId', required: true }]);
    expect(binding.body).toBeNull();
    expect(binding.declaredServer).toBe('https://api.example.com/v1');
  });

  it('turns parameters into a strict object schema with descriptions', () => {
    const list = byName(result.operations, 'listPets');
    expect(list.inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
    expect((list.inputSchema as any).properties.limit).toEqual({
      type: 'integer', maximum: 100, description: 'How many items to return at one time (max 100)',
    });
    expect((list.inputSchema as any).required).toBeUndefined();
    expect((byName(result.operations, 'showPetById').inputSchema as any).required).toEqual(['petId']);
  });

  it('gives a JSON request body a `body` property and marks it required', () => {
    const create = byName(result.operations, 'createPets');
    expect((create.inputSchema as any).properties.body.required).toEqual(['name']);
    expect((create.inputSchema as any).required).toContain('body');
    expect(asOperationBinding(create.annotations)!.body).toEqual({ property: 'body', required: true });
  });

  it('carries the first 2xx JSON response schema as the output schema', () => {
    expect(byName(result.operations, 'listPets').outputSchema).toMatchObject({ type: 'array' });
    expect(byName(result.operations, 'deletePet').outputSchema).toBeUndefined();
  });

  it('uses the summary as the description', () => {
    expect(byName(result.operations, 'listPets').description).toBe('List all pets');
  });

  it('emits no server warning when servers[] matches the pinned origin', () => {
    expect(result.serverOriginWarnings).toEqual([]);
  });

  it('emits schemas that compile under the resolver\'s Ajv configuration', () => {
    const ajv = new Ajv({ allErrors: true, strict: false });
    addFormats(ajv);
    for (const op of result.operations) expect(() => ajv.compile(op.inputSchema)).not.toThrow();
  });

  it('emits plain JSON trees (no shared references, serialisable)', () => {
    for (const op of result.operations) {
      expect(JSON.parse(JSON.stringify(op.inputSchema))).toEqual(op.inputSchema);
      expect(JSON.parse(JSON.stringify(op.annotations))).toEqual(op.annotations);
    }
  });
});

describe('projectOpenApiDocument — psa-like (every skip reason)', () => {
  const result = projectOpenApiDocument(load('psa-like.yaml'), CTX);

  it('skips each unsupported shape with its own reason and keeps the rest', () => {
    const reasons = Object.fromEntries(result.skipped.map((s) => [s.name, s.reason]));
    expect(reasons).toEqual({
      searchTickets: 'unsupported_param_style',
      uploadAttachment: 'unsupported_request_body',
      getSession: 'unsupported_param_style',
      legacyReport: 'unsupported_security_location',
    });
    expect(result.operations.map((o) => o.name).sort()).toEqual(['createTicket', 'get_tickets', 'get_tickets_by_ticketid']);
  });

  it('records method and path on every skipped entry', () => {
    expect(result.skipped.find((s) => s.name === 'uploadAttachment')).toMatchObject({ method: 'POST', path: '/tickets/{ticketId}/attachments' });
  });

  it('warns about an off-origin servers[] entry without routing to it', () => {
    expect(result.serverOriginWarnings).toEqual(['https://eu.vendor-cdn.example']);
    const binding = asOperationBinding(byName(result.operations, 'get_tickets').annotations)!;
    expect(binding.path).toBe('/tickets');
  });

  it('accepts form-explode array query parameters', () => {
    const binding = asOperationBinding(byName(result.operations, 'get_tickets').annotations)!;
    expect(binding.params.map((p) => p.name)).toEqual(['status', 'tags']);
  });
});

describe('projectOpenApiDocument — rules', () => {
  it('skips an operation whose only security alternative is an apiKey in a cookie, or openIdConnect', () => {
    const r = projectOpenApiDocument(
      doc(
        {
          '/a': { get: { operationId: 'a', security: [{ cookieKey: [] }], ...ok } },
          '/b': { get: { operationId: 'b', security: [{ oidc: [] }], ...ok } },
          '/c': { get: { operationId: 'c', security: [{ oidc: [] }, { bearer: [] }], ...ok } },
          '/d': { get: { operationId: 'd', security: [], ...ok } },
        },
        {
          components: {
            securitySchemes: {
              cookieKey: { type: 'apiKey', in: 'cookie', name: 'k' },
              oidc: { type: 'openIdConnect', openIdConnectUrl: 'https://id.example/.well-known' },
              bearer: { type: 'http', scheme: 'bearer' },
            },
          },
          security: [{ cookieKey: [] }],
        },
      ),
      CTX,
    );
    expect(r.skipped.map((s) => [s.name, s.reason])).toEqual([
      ['a', 'unsupported_security_location'],
      ['b', 'unsupported_security_location'],
    ]);
    expect(r.operations.map((o) => o.name)).toEqual(['c', 'd']);
  });

  it('inherits document-level security when the operation declares none', () => {
    const r = projectOpenApiDocument(
      doc({ '/a': { get: { operationId: 'a', ...ok } } }, {
        components: { securitySchemes: { q: { type: 'apiKey', in: 'query', name: 'k' } } },
        security: [{ q: [] }],
      }),
      CTX,
    );
    expect(r.skipped).toEqual([{ name: 'a', method: 'GET', path: '/a', reason: 'unsupported_security_location' }]);
  });

  it.each([
    ['path matrix', { name: 'id', in: 'path', required: true, style: 'matrix', schema: { type: 'string' } }, '/x/{id}'],
    ['path explode', { name: 'id', in: 'path', required: true, explode: true, schema: { type: 'string' } }, '/x/{id}'],
    ['query pipeDelimited', { name: 'q', in: 'query', style: 'pipeDelimited', schema: { type: 'array' } }, '/x'],
    ['query explode false', { name: 'q', in: 'query', explode: false, schema: { type: 'array' } }, '/x'],
    ['query via content', { name: 'q', in: 'query', content: { 'application/json': { schema: { type: 'object' } } } }, '/x'],
    ['cookie', { name: 'c', in: 'cookie', schema: { type: 'string' } }, '/x'],
    ['header Host', { name: 'Host', in: 'header', schema: { type: 'string' } }, '/x'],
    ['header Cookie', { name: 'cookie', in: 'header', schema: { type: 'string' } }, '/x'],
    ['header Transfer-Encoding', { name: 'Transfer-Encoding', in: 'header', schema: { type: 'string' } }, '/x'],
    ['header bad token', { name: 'Bad Header', in: 'header', schema: { type: 'string' } }, '/x'],
    ['unknown location', { name: 'q', in: 'body', schema: { type: 'string' } }, '/x'],
  ])('skips a %s parameter as unsupported_param_style', (_label, param, path) => {
    const r = projectOpenApiDocument(doc({ [path]: { get: { operationId: 'op', parameters: [param], ...ok } } }), CTX);
    expect(r.skipped).toEqual([expect.objectContaining({ name: 'op', reason: 'unsupported_param_style' })]);
    expect(r.operations).toEqual([]);
  });

  it.each(['/a/../admin', '//evil.example/x', '/a?b=1', 'relative', '/a/%2e%2e/b'])(
    'skips a path template that could leave endpoint_url (%s) as unsupported_path',
    (path) => {
      const r = projectOpenApiDocument(doc({ [path]: { get: { operationId: 'op', ...ok } } }), CTX);
      expect(r.operations).toEqual([]);
      expect(r.skipped).toEqual([expect.objectContaining({ reason: 'unsupported_path' })]);
    },
  );

  it('ignores Accept, Content-Type and Authorization header parameters (OAS 3 §4.8.12.1)', () => {
    const r = projectOpenApiDocument(
      doc({
        '/x': {
          get: {
            operationId: 'op',
            parameters: ['Accept', 'Content-Type', 'Authorization'].map((name) => ({ name, in: 'header', schema: { type: 'string' } }))
              .concat([{ name: 'X-Trace', in: 'header', schema: { type: 'string' } }]),
            ...ok,
          },
        },
      }),
      CTX,
    );
    const binding = asOperationBinding(r.operations[0].annotations)!;
    expect(binding.params).toEqual([{ name: 'X-Trace', in: 'header', property: 'X_Trace', required: false }]);
  });

  it('lets an operation parameter override a path-item parameter with the same name and location', () => {
    const r = projectOpenApiDocument(
      doc({
        '/x/{id}': {
          parameters: [{ name: 'id', in: 'path', required: true, description: 'outer', schema: { type: 'string' } }],
          get: { operationId: 'op', parameters: [{ name: 'id', in: 'path', required: true, description: 'inner', schema: { type: 'integer' } }], ...ok },
        },
      }),
      CTX,
    );
    expect((r.operations[0].inputSchema as any).properties.id).toEqual({ type: 'integer', description: 'inner' });
  });

  it('adds an undeclared path template variable as a required string, and always requires path params', () => {
    const r = projectOpenApiDocument(
      doc({ '/x/{id}/{other}': { get: { operationId: 'op', parameters: [{ name: 'id', in: 'path', schema: { type: 'string' } }], ...ok } } }),
      CTX,
    );
    const binding = asOperationBinding(r.operations[0].annotations)!;
    expect(binding.params).toEqual([
      { name: 'id', in: 'path', property: 'id', required: true },
      { name: 'other', in: 'path', property: 'other', required: true },
    ]);
    expect((r.operations[0].inputSchema as any).required).toEqual(['id', 'other']);
  });

  it('sanitises and de-duplicates property names, keeping `body` for the request body', () => {
    const r = projectOpenApiDocument(
      doc({
        '/x': {
          post: {
            operationId: 'op',
            parameters: [
              { name: 'x-id', in: 'query', schema: { type: 'string' } },
              { name: 'x.id', in: 'header', schema: { type: 'string' } },
              { name: '1st', in: 'query', schema: { type: 'string' } },
              { name: 'body', in: 'query', schema: { type: 'string' } },
            ],
            requestBody: { content: { 'application/vnd.api+json': { schema: { type: 'object' } } } },
            ...ok,
          },
        },
      }),
      CTX,
    );
    const binding = asOperationBinding(r.operations[0].annotations)!;
    expect(binding.params.map((p) => p.property)).toEqual(['x_id', 'x_id_2', 'p_1st', 'body']);
    expect(binding.body).toEqual({ property: 'body_2', required: false });
  });

  it('skips a non-JSON request body as unsupported_request_body', () => {
    const r = projectOpenApiDocument(
      doc({ '/x': { put: { operationId: 'op', requestBody: { content: { 'application/x-www-form-urlencoded': { schema: { type: 'object' } } } }, ...ok } } }),
      CTX,
    );
    expect(r.skipped).toEqual([expect.objectContaining({ reason: 'unsupported_request_body' })]);
  });

  it('skips an operation with more than MAX_PARAMETERS parameters', () => {
    const parameters = Array.from({ length: MAX_PARAMETERS + 1 }, (_, i) => ({ name: `q${i}`, in: 'query', schema: { type: 'string' } }));
    const r = projectOpenApiDocument(doc({ '/x': { get: { operationId: 'op', parameters, ...ok } } }), CTX);
    expect(r.skipped).toEqual([expect.objectContaining({ reason: 'too_many_parameters' })]);
  });

  it('skips an operation whose generated input schema exceeds MAX_SCHEMA_BYTES', () => {
    const big = { type: 'string', description: 'x'.repeat(MAX_SCHEMA_BYTES) };
    const r = projectOpenApiDocument(doc({ '/x': { get: { operationId: 'op', parameters: [{ name: 'q', in: 'query', schema: big }], ...ok } } }), CTX);
    expect(r.skipped).toEqual([expect.objectContaining({ reason: 'schema_too_large' })]);
  });

  it('bounds an exponentially shared schema instead of expanding it', () => {
    // 2^40 leaves if serialised naively; the projector must give up at the byte cap.
    let node: Record<string, unknown> = { type: 'string' };
    for (let i = 0; i < 40; i++) node = { type: 'object', properties: { a: node, b: node } };
    const r = projectOpenApiDocument(doc({ '/x': { post: { operationId: 'op', requestBody: { content: { 'application/json': { schema: node } } }, ...ok } } }), CTX);
    expect(r.skipped).toEqual([expect.objectContaining({ reason: 'schema_too_large' })]);
  });

  it('drops an oversize output schema but keeps the operation', () => {
    const big = { type: 'string', description: 'x'.repeat(MAX_SCHEMA_BYTES) };
    const r = projectOpenApiDocument(
      doc({ '/x': { get: { operationId: 'op', responses: { '200': { description: 'ok', content: { 'application/json': { schema: big } } } } } } }),
      CTX,
    );
    expect(r.operations).toHaveLength(1);
    expect(r.operations[0].outputSchema).toBeUndefined();
  });

  it('translates OpenAPI 3.0 `nullable` into a JSON-Schema type union', () => {
    const r = projectOpenApiDocument(
      doc({ '/x': { get: { operationId: 'op', parameters: [{ name: 'q', in: 'query', schema: { type: 'string', nullable: true } }], ...ok } } }),
      CTX,
    );
    expect((r.operations[0].inputSchema as any).properties.q).toEqual({ type: ['string', 'null'] });
  });

  it('refuses a document over MAX_OPERATIONS rather than truncating it', () => {
    const paths: Record<string, unknown> = {};
    for (let i = 0; i <= MAX_OPERATIONS; i++) paths[`/p${i}`] = { get: ok };
    expect(() => projectOpenApiDocument(doc(paths), CTX)).toThrow(OpenApiSpecError);
    try {
      projectOpenApiDocument(doc(paths), CTX);
    } catch (err) {
      expect((err as OpenApiSpecError).code).toBe('too_many_operations');
      expect((err as OpenApiSpecError).message).toBe(`too_many_operations: ${MAX_OPERATIONS + 1} (limit ${MAX_OPERATIONS})`);
    }
  });

  it('de-duplicates colliding names with deterministic suffixes in document order', () => {
    const r = projectOpenApiDocument(
      doc({ '/a': { get: { operationId: 'dup', ...ok } }, '/b': { get: { operationId: 'dup', ...ok } }, '/c': { get: { operationId: 'dup_2', ...ok } } }),
      CTX,
    );
    expect(r.operations.map((o) => o.name)).toEqual(['dup', 'dup_2', 'dup_2_2']);
  });

  it('resolves relative and templated servers[] entries before comparing origins', () => {
    const r = projectOpenApiDocument(
      doc({ '/x': { get: { operationId: 'op', servers: [{ url: '/v2' }], ...ok } } }, {
        servers: [{ url: 'https://{region}.other.example/v1', variables: { region: { default: 'eu' } } }],
      }),
      CTX,
    );
    expect(r.serverOriginWarnings).toEqual(['https://eu.other.example']);
    expect(asOperationBinding(r.operations[0].annotations)!.declaredServer).toBe('/v2');
  });

  it('caps description length and falls back to METHOD path', () => {
    const r = projectOpenApiDocument(
      doc({ '/a': { get: { operationId: 'a', description: 'd'.repeat(5000), ...ok } }, '/b': { get: { operationId: 'b', ...ok } } }),
      CTX,
    );
    expect(byName(r.operations, 'a').description).toHaveLength(2000);
    expect(byName(r.operations, 'b').description).toBe('GET /b');
  });

  it('produces only addressable names', () => {
    const r = projectOpenApiDocument(load('psa-like.yaml'), CTX);
    for (const op of r.operations) {
      expect(SOURCE_TOOL_NAME_RE.test(op.name)).toBe(true);
      expect(qualifiedToolName(CTX.sourceSlug, op.name).length).toBeLessThanOrEqual(QUALIFIED_TOOL_NAME_MAX);
    }
  });
});

describe('operationToolName', () => {
  it('prefers a sanitised operationId', () => {
    expect(operationToolName('get', '/pets', 'pets.list', 'petsvc')).toBe('pets_list');
    expect(operationToolName('get', '/pets', 'pets/list', 'petsvc')).toBe('pets_list');
  });
  it('synthesises from method and path when operationId is absent or unusable', () => {
    expect(operationToolName('get', '/pets/{petId}/toys', undefined, 'petsvc')).toBe('get_pets_by_petid_toys');
    expect(operationToolName('post', '/pets', 'has spaces!', 'petsvc')).toBe('post_pets');
    expect(operationToolName('get', '/', undefined, 'petsvc')).toBe('get');
  });
  it('truncates a long synthesised name to fit the qualified-name cap', () => {
    const name = operationToolName('get', `/${'x'.repeat(200)}`, undefined, 'petsvc')!;
    expect(qualifiedToolName('petsvc', name).length).toBe(QUALIFIED_TOOL_NAME_MAX);
  });
  it('returns null when nothing addressable remains', () => {
    expect(operationToolName('get', '/', undefined, 'a'.repeat(62))).toBeNull();
  });
});

describe('asOperationBinding', () => {
  const good = { operation: { method: 'get', path: '/a', operationId: null, params: [], body: null, declaredServer: null } };
  it('accepts a well-formed binding', () => {
    expect(asOperationBinding(good)).toEqual(good.operation);
  });
  it.each([
    ['no operation', {}],
    ['bad method', { operation: { ...good.operation, method: 'options' } }],
    ['relative path', { operation: { ...good.operation, path: 'a' } }],
    ['absolute URL path', { operation: { ...good.operation, path: '//evil.example/a' } }],
    ['bad param location', { operation: { ...good.operation, params: [{ name: 'a', in: 'cookie', property: 'a', required: false }] } }],
    ['bad body', { operation: { ...good.operation, body: { property: 1 } } }],
    ['not an object', 'x'],
  ])('rejects %s', (_l, value) => {
    expect(asOperationBinding(value)).toBeNull();
  });
});
