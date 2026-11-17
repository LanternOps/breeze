import { afterEach, describe, expect, it } from 'vitest';
import { clearZammadDirectoryCache } from './directory';
import { FakeZammad, zammadTestHandle } from './fakeZammad.fixtures';
import { zammadTicketImportModule } from './index';
import { resolveZammadPeople } from './people';

/** Names for the report's owner keys, read live (#8313 W6; spec 2026-10-19 §5.10). */

afterEach(() => clearZammadDirectoryCache());

describe('resolveZammadPeople', () => {
  it('names users by first and last name with their email, from one read of the users index', async () => {
    const fake = new FakeZammad();
    const people = await resolveZammadPeople(zammadTestHandle(fake), ['4', '3', '4']);
    expect(people.size).toBe(2);
    expect(Object.fromEntries(people)).toEqual({
      4: { name: 'Bob Former', email: 'Bob.Former@MSP.example.test' },
      3: { name: 'Alice Agent', email: 'alice.agent@msp.example.test' },
    });
    // The index is paged once (the fake answers an empty second page); no per-user request.
    expect(fake.requestedPaths().filter((p) => p.startsWith('/api/v1/users')).every((p) => p.startsWith('/api/v1/users?page='))).toBe(true);
    // A second lookup is served from the directory.
    const before = fake.requestedPaths().length;
    await resolveZammadPeople(zammadTestHandle(fake, { sourceId: 'same' }), ['3']);
    await resolveZammadPeople(zammadTestHandle(fake, { sourceId: 'same' }), ['3']);
    expect(fake.requestedPaths().length - before).toBeLessThanOrEqual(2);
  });

  it('answers null for an unknown user and a key outside the id grammar, with no request for the bad key', async () => {
    const fake = new FakeZammad();
    const people = await resolveZammadPeople(zammadTestHandle(fake), ['999999', 'abc', '0', '-1', '11']);
    expect(people.get('999999')).toBeNull();
    expect(people.get('abc')).toBeNull();
    expect(people.get('0')).toBeNull();
    expect(people.get('-1')).toBeNull();
    // An empty email reads as none.
    expect(people.get('11')).toEqual({ name: 'Eve Nomail', email: null });
    expect(fake.requestedPaths().some((p) => p.includes('abc'))).toBe(false);
  });

  it('reads nothing when no key is a user id', async () => {
    const fake = new FakeZammad();
    expect(Object.fromEntries(await resolveZammadPeople(zammadTestHandle(fake), ['x']))).toEqual({ x: null });
    expect(fake.requestedPaths()).toEqual([]);
  });

  it('is the module\'s resolvePeople', () => {
    expect(zammadTicketImportModule.resolvePeople).toBe(resolveZammadPeople);
  });
});
