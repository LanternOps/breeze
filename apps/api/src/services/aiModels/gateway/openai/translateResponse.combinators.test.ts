/**
 * Tool-call argument validation against combinator / $ref schemas, including
 * the schemas Breeze's real MCP tools advertise. Those are built exactly as the
 * Agent SDK's MCP server answers tools/list: Zod 4 `toJSONSchema` with
 * `target: 'draft-7'`, `io: 'input'` (toJsonSchemaCompat in
 * @modelcontextprotocol/sdk, called by the SDK with pipeStrategy 'input').
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildBreezeSdkTools } from '../../../aiAgentSdkTools';
import { matchesToolSchema, validateToolCalls } from './translateResponse';

const realTools = buildBreezeSdkTools((() => { throw new Error('handlers are never invoked here'); }) as never) as unknown as
  Array<{ name: string; inputSchema: z.ZodRawShape }>;

/** The JSON schema the SDK's MCP server advertises for a Breeze tool (round-tripped through JSON, as on the wire). */
function advertisedSchema(name: string): Record<string, unknown> {
  const t = realTools.find((x) => x.name === name);
  if (!t) throw new Error(`no Breeze tool named ${name}`);
  return JSON.parse(JSON.stringify(z.toJSONSchema(z.object(t.inputSchema), { target: 'draft-7', io: 'input' }))) as Record<string, unknown>;
}

const UUID = '3f2a7b8c-1d4e-4f5a-9b6c-7d8e9f0a1b2c';

describe('list_org_contacts: siteId is a union (anyOf) in the advertised schema', () => {
  const schema = advertisedSchema('list_org_contacts');

  it('the advertised siteId really is an anyOf (so this test exercises the combinator)', () => {
    expect((schema.properties as Record<string, Record<string, unknown>>).siteId!.anyOf).toBeInstanceOf(Array);
  });
  it('a number for siteId is rejected', () => {
    expect(matchesToolSchema({ orgId: UUID, siteId: 42 }, schema)).toBe(false);
  });
  it.each([['a uuid', UUID], ['the literal "none"', 'none']])('%s for siteId is accepted', (_l, siteId) => {
    expect(matchesToolSchema({ orgId: UUID, siteId }, schema)).toBe(true);
  });
  it('a batch with the bad call and a valid sibling is rejected whole', () => {
    const tools = {
      toOai: new Map([['list_org_contacts', 'list_org_contacts']]),
      fromOai: new Map([['list_org_contacts', 'list_org_contacts']]),
      schemas: new Map([['list_org_contacts', schema]]),
    };
    expect(validateToolCalls([
      { id: 'a', name: 'list_org_contacts', arguments: JSON.stringify({ orgId: UUID }) },
      { id: 'b', name: 'list_org_contacts', arguments: JSON.stringify({ orgId: UUID, siteId: 42 }) },
    ], tools)).toBeNull();
  });
});

describe('$ref and combinators', () => {
  const refRequired = {
    $ref: '#/$defs/args',
    $defs: { args: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  };
  it('a $ref to a schema with required properties enforces them', () => {
    expect(matchesToolSchema({}, refRequired)).toBe(false);
    expect(matchesToolSchema({ id: 5 }, refRequired)).toBe(false);
    expect(matchesToolSchema({ id: 'x' }, refRequired)).toBe(true);
  });
  it('draft-7 `definitions` and nested refs resolve; JSON-pointer escapes are honoured', () => {
    const schema = {
      type: 'object',
      properties: { a: { $ref: '#/definitions/a~1b' }, n: { $ref: '#/properties/a' } },
      definitions: { 'a/b': { type: 'integer' } },
    };
    expect(matchesToolSchema({ a: 1, n: 2 }, schema)).toBe(true);
    expect(matchesToolSchema({ a: 'x' }, schema)).toBe(false);
    expect(matchesToolSchema({ n: 'x' }, schema)).toBe(false);
  });
  it('a recursive schema validates nested values', () => {
    const tree = {
      $ref: '#/definitions/node',
      definitions: { node: { type: 'object', properties: { v: { type: 'integer' }, kids: { type: 'array', items: { $ref: '#/definitions/node' } } }, required: ['v'] } },
    };
    expect(matchesToolSchema({ v: 1, kids: [{ v: 2, kids: [{ v: 3 }] }] }, tree)).toBe(true);
    expect(matchesToolSchema({ v: 1, kids: [{ v: 2, kids: [{}] }] }, tree)).toBe(false);
  });
  it('a $ref cycle with no progress does not loop and does not reject', () => {
    const cyc = { $ref: '#/definitions/a', definitions: { a: { $ref: '#/definitions/b' }, b: { $ref: '#/definitions/a' } } };
    expect(matchesToolSchema({ x: 1 }, cyc)).toBe(true);
  });
  it('a non-local or unresolvable $ref is permissive (cannot be checked offline)', () => {
    expect(matchesToolSchema({ x: 1 }, { $ref: 'https://example.com/schema.json' })).toBe(true);
    expect(matchesToolSchema({ x: 1 }, { $ref: '#/definitions/missing' })).toBe(true);
  });
  it('anyOf: at least one branch must match', () => {
    const s = { type: 'object', properties: { v: { anyOf: [{ type: 'string' }, { type: 'null' }] } } };
    expect(matchesToolSchema({ v: 'a' }, s)).toBe(true);
    expect(matchesToolSchema({ v: null }, s)).toBe(true);
    expect(matchesToolSchema({ v: 1 }, s)).toBe(false);
  });
  it('oneOf is checked as "at least one" (multiple matches are not rejected)', () => {
    const s = { oneOf: [{ type: 'object', properties: { k: { const: 'a' } }, required: ['k'] }, { type: 'object' }] };
    expect(matchesToolSchema({ k: 'a' }, s)).toBe(true);
    expect(matchesToolSchema([], s)).toBe(false);
  });
  it('allOf: every branch must match', () => {
    const s = { allOf: [{ type: 'object', required: ['a'] }, { type: 'object', required: ['b'] }] };
    expect(matchesToolSchema({ a: 1, b: 2 }, s)).toBe(true);
    expect(matchesToolSchema({ a: 1 }, s)).toBe(false);
  });
  it('a combinator explosion is bounded (fails closed rather than spinning)', () => {
    let s: Record<string, unknown> = { type: 'string' };
    for (let i = 0; i < 40; i += 1) s = { anyOf: [{ type: 'integer' }, s, s] };
    const t0 = performance.now();
    matchesToolSchema(1.5, s);
    expect(performance.now() - t0).toBeLessThan(1000);
  });
});

describe('real Breeze tool schemas accept a valid minimal call', () => {
  const samples: Array<[string, Record<string, unknown>]> = [
    ['list_org_contacts', { orgId: UUID, siteId: 'none', limit: 10 }],
    ['propose_script', {
      language: 'powershell', content: 'Get-Service', goal: 'g', expectedEffect: 'e',
      verification: { kind: 'service_running', name: 'Spooler' }, deviceIds: [UUID],
    }],
    ['manage_monitor_definitions', { action: 'update', monitorId: UUID, overrides: null }],
    ['propose_action_plan', { title: 't', steps: [{ toolName: 'query_devices', input: { status: 'online' }, reasoning: 'r' }] }],
    ['manage_organizations', { action: 'add_contact', orgId: UUID, roles: ['billing', 'technical'], address: { city: 'Oslo' } }],
  ];
  it.each(samples)('%s', (name, input) => {
    const schema = advertisedSchema(name);
    // Sanity: the sample is valid for the tool's own Zod schema, so a false here is a gateway false rejection.
    const t = realTools.find((x) => x.name === name)!;
    expect(z.object(t.inputSchema).safeParse(input).success).toBe(true);
    expect(matchesToolSchema(input, schema)).toBe(true);
  });
  it('propose_script: a verification matching no oneOf branch is rejected', () => {
    expect(matchesToolSchema({
      language: 'powershell', content: 'x', goal: 'g', expectedEffect: 'e', deviceIds: [UUID], verification: { kind: 7 },
    }, advertisedSchema('propose_script'))).toBe(false);
  });
});
