/**
 * SCIM 2.0 wire handling for Entra provisioning (portal registration W9
 * #11386, plan Task 5; D5, D8). Pure: no DB.
 */
import { describe, expect, it } from 'vitest';
import {
  SCIM_USER_SCHEMA,
  ScimError,
  parseCreateBody,
  parseListParams,
  parsePatchBody,
  parsePutBody,
  parseScimFilter,
  scimErrorBody,
  scimListResponse,
  toScimUser,
} from './protocol';

const OID = '66666666-7777-4888-9999-000000000000';
const PATCH = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';
const ENTERPRISE = 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User';

function scimErr(fn: () => unknown): ScimError {
  try { fn(); } catch (err) { if (err instanceof ScimError) return err; throw err; }
  throw new Error('expected a ScimError');
}

describe('parseScimFilter (D8)', () => {
  it.each([
    ['userName eq "jane@acme.example"', { attribute: 'userName', value: 'jane@acme.example' }],
    ['USERNAME EQ "Jane@Acme.example"', { attribute: 'userName', value: 'Jane@Acme.example' }],
    [`externalId eq "${OID}"`, { attribute: 'externalId', value: OID }],
    [`urn:ietf:params:scim:schemas:core:2.0:User:externalId eq "${OID}"`, { attribute: 'externalId', value: OID }],
    ['userName eq "a\\"b"', { attribute: 'userName', value: 'a"b' }],
    // Test Connection: a random GUID through the configured matching attribute.
    [`userName eq "${OID}"`, { attribute: 'userName', value: OID }],
  ])('%s', (filter, expected) => {
    expect(parseScimFilter(filter)).toEqual(expected);
  });

  it.each([
    'displayName eq "x"',
    'userName co "x"',
    'userName eq "x" and active eq true',
    'userName eq x',
    'userName pr',
    '',
  ])('refuses %s with 400 invalidFilter', (filter) => {
    expect(scimErr(() => parseScimFilter(filter))).toMatchObject({ status: 400, scimType: 'invalidFilter' });
  });
});

describe('parseListParams', () => {
  it('defaults to startIndex 1, count 100, and clamps', () => {
    expect(parseListParams({})).toEqual({ startIndex: 1, count: 100 });
    expect(parseListParams({ startIndex: '0', count: '500' })).toEqual({ startIndex: 1, count: 100 });
    expect(parseListParams({ startIndex: '11', count: '5' })).toEqual({ startIndex: 11, count: 5 });
    expect(parseListParams({ startIndex: 'x', count: '-1' })).toEqual({ startIndex: 1, count: 0 });
  });
});

describe('parseCreateBody (D4, D5)', () => {
  const body = {
    schemas: [SCIM_USER_SCHEMA, ENTERPRISE],
    externalId: OID.toUpperCase(),
    userName: 'Jane@Acme.example',
    active: true,
    displayName: 'Jane Doe',
    name: { givenName: 'Jane', familyName: 'Doe', formatted: 'Jane Doe' },
    emails: [{ primary: true, type: 'work', value: 'someone-else@other.example' }],
    title: 'Engineer',
    [ENTERPRISE]: { department: 'IT' },
  };

  it('keeps the attributes SCIM manages, lowercases externalId, ignores the rest', () => {
    expect(parseCreateBody(body)).toEqual({
      externalId: OID, userName: 'Jane@Acme.example', active: true,
      displayName: 'Jane Doe', givenName: 'Jane', familyName: 'Doe',
    });
  });

  it('active defaults to true and accepts Entra\'s string booleans', () => {
    expect(parseCreateBody({ ...body, active: undefined }).active).toBe(true);
    expect(parseCreateBody({ ...body, active: 'False' }).active).toBe(false);
  });

  it('refuses an externalId that is not an Entra object id, naming the mapping to fix', () => {
    const err = scimErr(() => parseCreateBody({ ...body, externalId: 'jdoe' }));
    expect(err).toMatchObject({ status: 400, scimType: 'invalidValue' });
    expect(err.message).toMatch(/objectId/);
  });

  it.each([
    ['no externalId', { ...body, externalId: undefined }],
    ['no userName', { ...body, userName: undefined }],
    ['a userName that is not an address', { ...body, userName: 'jdoe' }],
    ['a non-boolean active', { ...body, active: 'maybe' }],
    ['an over-long displayName', { ...body, displayName: 'x'.repeat(257) }],
    ['not an object', 'nope'],
  ])('refuses %s with 400', (_label, b) => {
    expect(scimErr(() => parseCreateBody(b)).status).toBe(400);
  });
});

describe('parsePutBody (D8)', () => {
  it('replaces userName and the name parts; omitted parts clear; an omitted active is unchanged', () => {
    expect(parsePutBody({ schemas: [SCIM_USER_SCHEMA], externalId: OID, userName: 'jane@acme.example' })).toEqual({
      externalId: OID, userName: 'jane@acme.example', displayName: null, givenName: null, familyName: null,
    });
    expect(parsePutBody({ externalId: OID, userName: 'jane@acme.example', active: false })).toMatchObject({ active: false });
  });
});

describe('parsePatchBody (D5, D8)', () => {
  const patch = (...ops: unknown[]) => ({ schemas: [PATCH], Operations: ops });

  it('replace active with Entra\'s capitalised op and string boolean', () => {
    expect(parsePatchBody(patch({ op: 'Replace', path: 'active', value: 'False' }))).toEqual({ active: false });
    expect(parsePatchBody(patch({ op: 'replace', path: 'active', value: true }))).toEqual({ active: true });
  });

  it('path-less object, including literal dotted keys and a whole name object', () => {
    expect(parsePatchBody(patch({ op: 'replace', value: { active: false, 'name.givenName': 'J', displayName: 'J D' } })))
      .toEqual({ active: false, givenName: 'J', displayName: 'J D' });
    expect(parsePatchBody(patch({ op: 'add', value: { name: { givenName: 'A', familyName: 'B' } } })))
      .toEqual({ givenName: 'A', familyName: 'B' });
  });

  it('paths: userName, displayName, name.familyName, name; case-insensitive and URN-prefixed', () => {
    expect(parsePatchBody(patch(
      { op: 'Add', path: 'userName', value: 'New@Acme.example' },
      { op: 'replace', path: 'DISPLAYNAME', value: 'New' },
      { op: 'replace', path: `${SCIM_USER_SCHEMA}:name.familyName`, value: 'Fam' },
    ))).toEqual({ userName: 'New@Acme.example', displayName: 'New', familyName: 'Fam' });
    expect(parsePatchBody(patch({ op: 'replace', path: 'name', value: { givenName: 'G' } }))).toEqual({ givenName: 'G' });
  });

  it('remove clears optional attributes', () => {
    expect(parsePatchBody(patch({ op: 'Remove', path: 'displayName' }, { op: 'remove', path: 'name' })))
      .toEqual({ displayName: null, givenName: null, familyName: null });
  });

  it('ignores attributes SCIM does not manage, in every form', () => {
    expect(parsePatchBody(patch(
      { op: 'replace', path: 'emails[type eq "work"].value', value: 'x@y.example' },
      { op: 'add', path: `${ENTERPRISE}:department`, value: 'IT' },
      { op: 'replace', path: 'title', value: 'Eng' },
      { op: 'replace', path: 'name.formatted', value: 'x' },
      { op: 'replace', value: { 'emails[type eq "work"].value': 'x@y.example', [ENTERPRISE]: { manager: 'm' }, phoneNumbers: [] } },
      { op: 'remove', path: 'title' },
    ))).toEqual({});
  });

  it('externalId is carried for the caller\'s equality check (mutability)', () => {
    expect(parsePatchBody(patch({ op: 'replace', path: 'externalId', value: OID.toUpperCase() }))).toEqual({ externalId: OID });
  });

  it.each([
    ['an unknown op', { op: 'move', path: 'active', value: true }],
    ['remove userName', { op: 'remove', path: 'userName' }],
    ['remove externalId', { op: 'remove', path: 'externalId' }],
    ['remove active', { op: 'remove', path: 'active' }],
    ['remove with no path', { op: 'remove' }],
    ['a path-less non-object value', { op: 'replace', value: 'x' }],
    ['a bad active', { op: 'replace', path: 'active', value: 'yes' }],
    ['a bad userName', { op: 'replace', path: 'userName', value: 'no-at-sign' }],
  ])('refuses %s with 400 and nothing applied', (_label, op) => {
    // The good op before it is never returned: the whole list is validated first (RFC 7644 §3.5.2).
    expect(scimErr(() => parsePatchBody(patch({ op: 'replace', path: 'displayName', value: 'ok' }, op))).status).toBe(400);
  });

  it('refuses a body without Operations', () => {
    expect(scimErr(() => parsePatchBody({ schemas: [PATCH] })).status).toBe(400);
  });
});

describe('serializers', () => {
  it('toScimUser renders the resource Entra wrote, with meta', () => {
    const created = new Date('2027-02-01T12:00:00.000Z');
    expect(toScimUser({
      id: 'ident-1', externalId: OID, userName: 'Jane@Acme.example', active: false,
      displayName: 'Jane Doe', givenName: 'Jane', familyName: null, created,
    })).toEqual({
      schemas: [SCIM_USER_SCHEMA],
      id: 'ident-1',
      externalId: OID,
      userName: 'Jane@Acme.example',
      active: false,
      displayName: 'Jane Doe',
      name: { givenName: 'Jane' },
      meta: { resourceType: 'User', created: created.toISOString() },
    });
  });

  it('a list response and an error body follow RFC 7644', () => {
    expect(scimListResponse([], 0, 1)).toEqual({
      schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'], totalResults: 0, startIndex: 1, itemsPerPage: 0, Resources: [],
    });
    expect(scimErrorBody(409, 'taken', 'uniqueness')).toEqual({
      schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'], status: '409', scimType: 'uniqueness', detail: 'taken',
    });
    expect(scimErrorBody(401, 'no')).toEqual({ schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'], status: '401', detail: 'no' });
  });
});
