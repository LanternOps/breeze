import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  dereferenceLocal,
  fetchOpenApiDocument,
  MAX_DEREF_DEPTH,
  MAX_DEREF_RESOLUTIONS,
  MAX_SPEC_BYTES,
  OpenApiSpecError,
  parseOpenApiDocument,
  SPEC_FETCH_TIMEOUT_MS,
} from './openapiSpec';
import { ResponseTooLargeError, safeFetch } from '../urlSafety';

vi.mock('../urlSafety', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../urlSafety')>();
  return { ...actual, safeFetch: vi.fn() };
});

const fixture = (name: string) => readFileSync(join(__dirname, '__fixtures__', name), 'utf8');
const ok = (body: string) => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
const ORIGIN = 'https://api.example.com';

function specErr(fn: () => unknown): OpenApiSpecError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(OpenApiSpecError);
    return err as OpenApiSpecError;
  }
  throw new Error('expected an OpenApiSpecError');
}

describe('parseOpenApiDocument', () => {
  it('parses JSON and YAML documents alike, sniffing content rather than trusting a type', () => {
    expect(parseOpenApiDocument(fixture('petstore.json')).openapi).toBe('3.0.3');
    const yamlDoc = parseOpenApiDocument(fixture('psa-like.yaml'));
    expect(yamlDoc.openapi).toBe('3.1.0');
  });

  it('keeps YAML booleans and numbers typed (JSON schema, not failsafe)', () => {
    const doc = parseOpenApiDocument('openapi: 3.0.3\npaths:\n  /x:\n    get:\n      parameters:\n        - { name: a, in: path, required: true, schema: { type: integer, maximum: 5 } }\n');
    const param = (((doc.paths as any)['/x'].get.parameters) as any[])[0];
    expect(param.required).toBe(true);
    expect(param.schema.maximum).toBe(5);
  });

  it('accepts an unquoted YAML openapi: 3.1 that parses as a number', () => {
    expect(parseOpenApiDocument('openapi: 3.1\npaths: {}\n').openapi).toBe('3.1');
  });

  it('rejects swagger 2.0, a missing version, and a 3.2/4.x version', () => {
    expect(specErr(() => parseOpenApiDocument('{"swagger":"2.0","paths":{}}')).code).toBe('unsupported_version');
    expect(specErr(() => parseOpenApiDocument('{"swagger":"2.0","paths":{}}')).message).toMatch(/^unsupported_openapi_version: swagger 2\.0/);
    expect(specErr(() => parseOpenApiDocument('{"paths":{}}')).code).toBe('unsupported_version');
    expect(specErr(() => parseOpenApiDocument('{"openapi":"3.2.0","paths":{}}')).code).toBe('unsupported_version');
    expect(specErr(() => parseOpenApiDocument('{"openapi":"4.0.0","paths":{}}')).code).toBe('unsupported_version');
  });

  it('rejects a body that is neither a JSON nor a YAML object', () => {
    expect(specErr(() => parseOpenApiDocument('<html>nope</html>')).code).toBe('parse');
    expect(specErr(() => parseOpenApiDocument('[1,2,3]')).code).toBe('parse');
    expect(specErr(() => parseOpenApiDocument('')).code).toBe('parse');
  });

  it('refuses a YAML alias bomb instead of expanding it', () => {
    const lines = ['openapi: 3.0.3', 'a0: &a0 [x, x, x, x, x, x, x, x, x, x]'];
    for (let i = 1; i < 200; i++) lines.push(`a${i}: &a${i} [*a${i - 1}, *a${i - 1}, *a${i - 1}, *a${i - 1}, *a${i - 1}, *a${i - 1}]`);
    expect(specErr(() => parseOpenApiDocument(lines.join('\n'))).code).toBe('parse');
  });
});

describe('dereferenceLocal', () => {
  it('inlines a local $ref and keeps sibling keys', () => {
    const doc = dereferenceLocal({
      openapi: '3.1.0',
      components: { schemas: { Pet: { type: 'object', properties: { id: { type: 'string' } } } } },
      x: { $ref: '#/components/schemas/Pet', description: 'a pet' },
    });
    expect((doc.x as Record<string, unknown>).type).toBe('object');
    expect((doc.x as Record<string, unknown>).description).toBe('a pet');
    expect((doc.x as Record<string, unknown>).$ref).toBeUndefined();
  });

  it('decodes JSON-pointer escapes (~1, ~0, percent-encoding)', () => {
    const doc = dereferenceLocal({
      openapi: '3.1.0',
      components: { schemas: { 'a/b': { type: 'string' }, 'c~d': { type: 'number' }, 'e f': { type: 'boolean' } } },
      x: { $ref: '#/components/schemas/a~1b' },
      y: { $ref: '#/components/schemas/c~0d' },
      z: { $ref: '#/components/schemas/e%20f' },
    });
    expect(doc.x).toEqual({ type: 'string' });
    expect(doc.y).toEqual({ type: 'number' });
    expect(doc.z).toEqual({ type: 'boolean' });
  });

  it('rejects a remote $ref anywhere, naming it', () => {
    const err = specErr(() => dereferenceLocal(JSON.parse(fixture('remote-ref.json'))));
    expect(err.code).toBe('remote_ref');
    expect(err.message).toBe('remote_ref_rejected: https://evil.example/schemas/Pet.json');
    expect(specErr(() => dereferenceLocal({ openapi: '3.0.3', x: { $ref: 'other.yaml#/Pet' } })).code).toBe('remote_ref');
    expect(specErr(() => dereferenceLocal({ openapi: '3.0.3', x: { $ref: '//evil.example/x' } })).code).toBe('remote_ref');
  });

  it('rejects a $ref to a missing local target', () => {
    expect(specErr(() => dereferenceLocal({ openapi: '3.0.3', x: { $ref: '#/components/schemas/Nope' } })).code).toBe('parse');
  });

  it('never resolves a pointer through the prototype chain', () => {
    expect(specErr(() => dereferenceLocal({ openapi: '3.0.3', x: { $ref: '#/constructor/prototype' } })).code).toBe('parse');
    expect(specErr(() => dereferenceLocal({ openapi: '3.0.3', x: { $ref: '#/__proto__' } })).code).toBe('parse');
  });

  it('keeps a literal __proto__ key as data instead of rewriting the prototype', () => {
    const doc = dereferenceLocal(JSON.parse('{"openapi":"3.0.3","x":{"__proto__":{"polluted":true}}}'));
    expect(Object.getPrototypeOf(doc.x)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(doc.x, '__proto__')).toBe(true);
  });

  it('resolves a cycle to an empty schema instead of hanging', () => {
    const doc = dereferenceLocal({
      openapi: '3.0.3',
      components: { schemas: { Node: { type: 'object', properties: { next: { $ref: '#/components/schemas/Node' } } } } },
      x: { $ref: '#/components/schemas/Node' },
    });
    expect(((doc.x as any).properties as any).next).toEqual({});
  });

  it('caps $ref chain depth', () => {
    const schemas: Record<string, unknown> = {};
    for (let i = 0; i <= MAX_DEREF_DEPTH + 2; i++) schemas[`S${i}`] = { $ref: `#/components/schemas/S${i + 1}` };
    schemas[`S${MAX_DEREF_DEPTH + 3}`] = { type: 'string' };
    expect(specErr(() => dereferenceLocal({ openapi: '3.0.3', components: { schemas }, x: { $ref: '#/components/schemas/S0' } })).code)
      .toBe('deref_limit');
  });

  it('caps the number of distinct $ref targets', () => {
    const schemas: Record<string, unknown> = {};
    const uses: unknown[] = [];
    for (let i = 0; i <= MAX_DEREF_RESOLUTIONS; i++) {
      schemas[`S${i}`] = { type: 'string' };
      uses.push({ $ref: `#/components/schemas/S${i}` });
    }
    expect(specErr(() => dereferenceLocal({ openapi: '3.0.3', components: { schemas }, x: uses })).code).toBe('deref_limit');
  });

  it('caps structural nesting depth', () => {
    let deep: unknown = { type: 'string' };
    for (let i = 0; i < 400; i++) deep = { items: deep };
    expect(specErr(() => dereferenceLocal({ openapi: '3.0.3', x: deep })).code).toBe('deref_limit');
  });

  it('does not descend into literal example/default/enum values or x- extensions', () => {
    const doc = dereferenceLocal({
      openapi: '3.0.3',
      x: {
        type: 'object',
        example: { $ref: 'https://not-a-ref.example/literal' },
        default: { $ref: 'https://not-a-ref.example/literal' },
        'x-vendor': { $ref: 'https://not-a-ref.example/literal' },
      },
    });
    expect((doc.x as any).example).toEqual({ $ref: 'https://not-a-ref.example/literal' });
  });

  it('dereferences schema PROPERTIES named like literal keywords (default, enum, x-…) and checks their refs', () => {
    const doc = dereferenceLocal({
      openapi: '3.1.0',
      components: { schemas: { Foo: { type: 'string' }, default: { type: 'integer' } } },
      x: {
        type: 'object',
        properties: {
          default: { $ref: '#/components/schemas/Foo' },
          enum: { $ref: '#/components/schemas/Foo' },
          'x-vendor-id': { $ref: '#/components/schemas/default' },
        },
      },
    });
    expect((doc.x as any).properties).toEqual({ default: { type: 'string' }, enum: { type: 'string' }, 'x-vendor-id': { type: 'integer' } });
    expect(specErr(() => dereferenceLocal({
      openapi: '3.1.0', x: { type: 'object', properties: { default: { $ref: 'https://evil.example/x.json' } } },
    })).code).toBe('remote_ref');
  });

  it('dereferences the petstore fixture fully', () => {
    const doc = dereferenceLocal(parseOpenApiDocument(fixture('petstore.json')));
    expect(JSON.stringify(doc.paths)).not.toContain('$ref');
    const params = ((doc.paths as any)['/pets/{petId}'].parameters as any[]);
    expect(params[0].name).toBe('petId');
  });
});

describe('fetchOpenApiDocument', () => {
  it('sends the credential, the byte cap and a wall-clock deadline when the spec is on the pinned origin', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok(fixture('petstore.json')));
    const doc = await fetchOpenApiDocument({
      specUrl: 'https://api.example.com/openapi.json', credentialOrigin: ORIGIN,
      auth: { authKind: 'bearer', token: 'tok' }, fetchImpl, allowPrivateNetwork: true,
    });
    expect(doc.openapi).toBe('3.0.3');
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://api.example.com/openapi.json');
    expect(init.method).toBe('GET');
    expect(init.headers.Authorization).toBe('Bearer tok');
    expect(init.maxBytes).toBe(MAX_SPEC_BYTES);
    expect(init.timeoutMs).toBe(SPEC_FETCH_TIMEOUT_MS);
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.allowPrivateNetwork).toBe(true);
    expect(init.redirect).toBeUndefined();
  });

  it('uses safeFetch by default and passes the private-egress flag through', async () => {
    vi.mocked(safeFetch).mockResolvedValue(ok(fixture('petstore.json')));
    await fetchOpenApiDocument({
      specUrl: 'https://api.example.com/openapi.json', credentialOrigin: ORIGIN, auth: { authKind: 'none' }, allowPrivateNetwork: true,
    });
    expect(safeFetch).toHaveBeenCalledTimes(1);
    expect(vi.mocked(safeFetch).mock.calls[0]![0]).toBe('https://api.example.com/openapi.json');
    expect(vi.mocked(safeFetch).mock.calls[0]![1]).toMatchObject({ allowPrivateNetwork: true, maxBytes: MAX_SPEC_BYTES });
  });

  it('omits the credential when the spec is served off-origin', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok(fixture('petstore.json')));
    await fetchOpenApiDocument({
      specUrl: 'https://docs.example.net/openapi.json', credentialOrigin: ORIGIN,
      auth: { authKind: 'bearer', token: 'tok' }, fetchImpl,
    });
    expect(fetchImpl.mock.calls[0]![1].headers.Authorization).toBeUndefined();
  });

  it('maps an oversize body to too_large', async () => {
    const tooBig = vi.fn().mockRejectedValue(new ResponseTooLargeError(MAX_SPEC_BYTES));
    await expect(
      fetchOpenApiDocument({ specUrl: 'https://api.example.com/o.json', credentialOrigin: ORIGIN, auth: { authKind: 'none' }, fetchImpl: tooBig }),
    ).rejects.toMatchObject({ code: 'too_large' });
  });

  it('enforces the byte cap itself even when a transport ignores maxBytes', async () => {
    const huge = vi.fn().mockResolvedValue(ok(`{"openapi":"3.0.3","x":"${'a'.repeat(MAX_SPEC_BYTES)}"}`));
    await expect(
      fetchOpenApiDocument({ specUrl: 'https://api.example.com/o.json', credentialOrigin: ORIGIN, auth: { authKind: 'none' }, fetchImpl: huge }),
    ).rejects.toMatchObject({ code: 'too_large' });
  });

  it('maps a non-2xx and a redirect to transport errors without following', async () => {
    const notFound = vi.fn().mockResolvedValue(new Response('nope', { status: 404 }));
    await expect(
      fetchOpenApiDocument({ specUrl: 'https://api.example.com/o.json', credentialOrigin: ORIGIN, auth: { authKind: 'none' }, fetchImpl: notFound }),
    ).rejects.toMatchObject({ code: 'transport', message: expect.stringContaining('404') });
    const redirect = vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: { location: 'https://evil.example/o.json' } }));
    const err = await fetchOpenApiDocument({
      specUrl: 'https://api.example.com/o.json', credentialOrigin: ORIGIN, auth: { authKind: 'bearer', token: 'tok' }, fetchImpl: redirect,
    }).catch((e) => e);
    expect(err).toMatchObject({ code: 'transport' });
    expect(err.message).toContain('302');
    expect(err.message).not.toContain('evil.example');
    expect(redirect).toHaveBeenCalledTimes(1);
  });

  it('maps a transport throw to a transport error', async () => {
    const boom = vi.fn().mockRejectedValue(new Error('getaddrinfo ENOTFOUND'));
    await expect(
      fetchOpenApiDocument({ specUrl: 'https://api.example.com/o.json', credentialOrigin: ORIGIN, auth: { authKind: 'none' }, fetchImpl: boom }),
    ).rejects.toMatchObject({ code: 'transport' });
  });

  it('rejects a fetched document carrying a remote $ref', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok(fixture('remote-ref.json')));
    await expect(
      fetchOpenApiDocument({ specUrl: 'https://api.example.com/o.json', credentialOrigin: ORIGIN, auth: { authKind: 'none' }, fetchImpl }),
    ).rejects.toMatchObject({ code: 'remote_ref' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
