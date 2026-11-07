import { describe, expect, it } from 'vitest';
import { toolInputSchemas } from '../aiToolSchemas';
import { classifyWispUnattendedRead, WISP_UNATTENDED_READ_DECIDING_KEYS } from './unattendedReads';

const DEVICE = '00000000-0000-4000-8000-000000000001';

const reg = (o: Record<string, unknown>) => ({ deviceId: DEVICE, keyPath: 'HKLM\\SOFTWARE\\Vendor', ...o });
const sec = (payload: Record<string, unknown>, top: Record<string, unknown> = {}) => ({
  deviceId: DEVICE,
  commandType: 'event_logs_query',
  payload: { logName: 'Security', ...payload },
  ...top,
});
const note = (o: Record<string, unknown> = {}) => ({ deviceId: DEVICE, contextType: 'issue', summary: 'Disk is failing', ...o });

describe('classifyWispUnattendedRead — accepts exactly the four reads', () => {
  it.each([
    ['read_key', 'registry_operations', reg({ action: 'read_key' }), 'registry_read'],
    ['read_key with a value name', 'registry_operations', reg({ action: 'read_key', valueName: 'Path' }), 'registry_read'],
    ['get_value', 'registry_operations', reg({ action: 'get_value', valueName: 'Path' }), 'registry_read'],
    ['Security, no filter', 'execute_command', sec({}), 'security_event_query'],
    ['Security, lower case', 'execute_command', sec({ logName: 'security' }), 'security_event_query'],
    ['Security, eventId only', 'execute_command', sec({ eventId: 4625 }), 'security_event_query'],
    ['Security, level + source', 'execute_command', sec({ level: 'error', source: 'Microsoft-Windows-Security-Auditing' }), 'security_event_query'],
    ['Security, paging at the caps', 'execute_command', sec({ page: 20, limit: 500 }), 'security_event_query'],
    ['set_device_context', 'set_device_context', note(), 'device_context'],
    ['set_device_context with details + expiry', 'set_device_context', note({ details: { a: { b: 1 } }, expiresInDays: 30 }), 'device_context'],
  ])('%s', (_label, tool, input, kind) => {
    expect(classifyWispUnattendedRead(tool, input)?.kind).toBe(kind);
    expect(classifyWispUnattendedRead(tool, input)?.tool).toBe(tool);
  });

  it.each([
    '*[System[EventID=4625]]',
    '*[System[Level=2]]',
    "*[System[Provider[@Name='Microsoft-Windows-Security-Auditing']]]",
    '*[System[TimeCreated[timediff(@SystemTime) <= 86400000]]]',
    '*[System[(EventID=4625 or EventID=4624) and TimeCreated[timediff(@SystemTime) <= 86400000]]]',
    "*[System[(Level=1 or Level=2) and (EventID=1 or (EventID=2 and Provider[@Name='A b.c_d-e']))]]",
  ])('accepts grammar-valid XPath %s', (query) => {
    expect(classifyWispUnattendedRead('execute_command', sec({ query }))?.kind).toBe('security_event_query');
  });
});

describe('classifyWispUnattendedRead — everything else stays where it was', () => {
  it.each([
    ['set_value', 'registry_operations', reg({ action: 'set_value', valueName: 'a', valueData: 'b' })],
    ['create_key', 'registry_operations', reg({ action: 'create_key' })],
    ['delete_key', 'registry_operations', reg({ action: 'delete_key' })],
    ['write key on a read', 'registry_operations', reg({ action: 'read_key', valueData: 'x' })],
    ['write type on a read', 'registry_operations', reg({ action: 'get_value', valueName: 'a', valueType: 'REG_SZ' })],
    ['get_value without a name', 'registry_operations', reg({ action: 'get_value' })],
    ['registry unknown key', 'registry_operations', reg({ action: 'read_key', extra: 1 })],
    ['registry bad device', 'registry_operations', reg({ action: 'read_key', deviceId: 'nope' })],
    ['registry control character in path', 'registry_operations', reg({ action: 'read_key', keyPath: 'HKLM\\a\nb' })],
    ['another commandType', 'execute_command', { deviceId: DEVICE, commandType: 'file_read', payload: { logName: 'Security' } }],
    ['System channel', 'execute_command', sec({ logName: 'System' })],
    ['padded Security', 'execute_command', sec({ logName: 'Security ' })],
    ['leading pad', 'execute_command', sec({ logName: ' Security' })],
    ['other channel', 'execute_command', sec({ logName: 'Microsoft-Windows-Sysmon/Operational' })],
    ['missing logName', 'execute_command', { deviceId: DEVICE, commandType: 'event_logs_query', payload: {} }],
    ['limit too high', 'execute_command', sec({ limit: 501 })],
    ['page too high', 'execute_command', sec({ page: 21 })],
    ['payload unknown key', 'execute_command', sec({ path: 'x' })],
    ['top-level unknown key', 'execute_command', sec({}, { extra: true })],
    ['query + eventId', 'execute_command', sec({ query: '*[System[EventID=1]]', eventId: 1 })],
    ['query + level', 'execute_command', sec({ query: '*[System[EventID=1]]', level: 2 })],
    ['query + source', 'execute_command', sec({ query: '*[System[EventID=1]]', source: 'a' })],
    ['source with a quote', 'execute_command', sec({ source: "a'b" })],
    ['note unknown key', 'set_device_context', note({ extra: 1 })],
    ['note bad type', 'set_device_context', note({ contextType: 'other' })],
    ['note too long', 'set_device_context', note({ summary: 'x'.repeat(256) })],
    ['note expiry too long', 'set_device_context', note({ expiresInDays: 366 })],
    ['a different tool', 'manage_services', { deviceId: DEVICE, action: 'list' }],
    ['not an object', 'registry_operations', 'read_key'],
    ['null', 'set_device_context', null],
    ['array', 'execute_command', []],
  ])('%s → null', (_label, tool, input) => {
    expect(classifyWispUnattendedRead(tool, input)).toBeNull();
  });

  it.each([
    ['QueryList selector', '<QueryList><Query Path="Microsoft-Windows-Sysmon/Operational"><Select>*</Select></Query></QueryList>'],
    ['EventData', "*[EventData[Data[@Name='TargetUserName']='x']]"],
    ['UserData', "*[UserData[x='y']]"],
    ['bare star', '*'],
    ['System without the wrapper', '*[System]'],
    ['empty body', '*[System[]]'],
    ['trailing junk', '*[System[EventID=1]] or *'],
    ['second predicate', '*[System[EventID=1]][EventData]'],
    ['leading junk', 'x*[System[EventID=1]]'],
    ['Level out of range', '*[System[Level=6]]'],
    ['Level zero', '*[System[Level=0]]'],
    ['non-digit EventID', '*[System[EventID=4625x]]'],
    ['EventID function', '*[System[EventID=count(//*)]]'],
    ['other comparison', '*[System[EventID>1]]'],
    ['less-than without equals', '*[System[TimeCreated[timediff(@SystemTime) < 5]]]'],
    ['other attribute', "*[System[Provider[@Guid='x']]]"],
    ['other time attribute', '*[System[TimeCreated[timediff(@Foo) <= 5]]]'],
    ['provider quote break', "*[System[Provider[@Name='a'] or Provider[@Name='b''c']]]"],
    ['provider illegal char', "*[System[Provider[@Name='a/b']]]"],
    ['provider empty', "*[System[Provider[@Name='']]]"],
    ['provider too long', `*[System[Provider[@Name='${'a'.repeat(129)}']]]`],
    ['unbalanced open', '*[System[(EventID=1]]'],
    ['unbalanced close', '*[System[EventID=1)]]'],
    ['dangling and', '*[System[EventID=1 and]]'],
    ['leading or', '*[System[or EventID=1]]'],
    ['upper-case AND', '*[System[EventID=1 AND EventID=2]]'],
    ['smuggled Path word', '*[System[Path]]'],
    ['smuggled Select word', '*[System[Select=1]]'],
    ['smuggled Suppress word', '*[System[Suppress]]'],
    ['newline', '*[System[EventID=1\n]]'],
    ['tab', '*[System[EventID=1\tor EventID=2]]'],
    ['too long', `*[System[${Array.from({ length: 80 }, () => 'EventID=1').join(' or ')}]]`],
    ['too deep', `*[System[${'('.repeat(40)}EventID=1${')'.repeat(40)}]]`],
    ['not a string', 42],
  ])('rejects XPath: %s', (_label, query) => {
    expect(classifyWispUnattendedRead('execute_command', sec({ query }))).toBeNull();
  });
});

describe('classifyWispUnattendedRead — pinned payload (classify == dispatch)', () => {
  it('is frozen all the way down', () => {
    const r = classifyWispUnattendedRead('set_device_context', note({ details: { a: { b: 1 } } }))!;
    expect(Object.isFrozen(r)).toBe(true);
    expect(Object.isFrozen(r.pinned)).toBe(true);
    expect(Object.isFrozen(r.pinned.details as Record<string, unknown>)).toBe(true);
    expect(Object.isFrozen((r.pinned.details as { a: object }).a)).toBe(true);
    const s = classifyWispUnattendedRead('execute_command', sec({ eventId: 1 }))!;
    expect(Object.isFrozen(s.pinned.payload)).toBe(true);
  });

  it('is detached: mutating the input afterwards changes nothing', () => {
    const details = { a: { b: 1 } };
    const input = note({ details });
    const r = classifyWispUnattendedRead('set_device_context', input)!;
    details.a.b = 2;
    (input as { summary: string }).summary = 'changed';
    expect(r.pinned.summary).toBe('Disk is failing');
    expect(r.pinned.details).toEqual({ a: { b: 1 } });

    const secInput = sec({ eventId: 1 });
    const s = classifyWispUnattendedRead('execute_command', secInput)!;
    (secInput.payload as Record<string, unknown>).logName = 'Microsoft-Windows-Sysmon/Operational';
    expect((s.pinned.payload as Record<string, unknown>).logName).toBe('Security');
  });

  it('canonicalizes the channel, so what runs is exactly Security', () => {
    const s = classifyWispUnattendedRead('execute_command', sec({ logName: 'SECURITY' }))!;
    expect(s.pinned).toEqual({ deviceId: DEVICE, commandType: 'event_logs_query', payload: { logName: 'Security' } });
  });

  it("every accepted call also passes the tool's own full input schema", () => {
    const accepted: Array<[keyof typeof toolInputSchemas, unknown]> = [
      ['registry_operations', reg({ action: 'read_key' })],
      ['registry_operations', reg({ action: 'get_value', valueName: 'Path' })],
      ['execute_command', sec({ query: '*[System[EventID=1]]' })],
      ['set_device_context', note({ details: { a: 1 }, expiresInDays: 30 })],
    ];
    for (const [tool, input] of accepted) {
      const pinned = classifyWispUnattendedRead(tool as string, input)!.pinned;
      expect(toolInputSchemas[tool]!.safeParse(pinned).success, String(tool)).toBe(true);
    }
  });

  it('declares its deciding keys', () => {
    expect([...WISP_UNATTENDED_READ_DECIDING_KEYS.registry_operations!].sort()).toEqual(['action', 'deviceId', 'keyPath', 'valueName']);
    expect([...WISP_UNATTENDED_READ_DECIDING_KEYS.execute_command!].sort()).toEqual(['commandType', 'deviceId', 'payload']);
    expect([...WISP_UNATTENDED_READ_DECIDING_KEYS.set_device_context!].sort()).toEqual(['contextType', 'details', 'deviceId', 'expiresInDays', 'summary']);
  });
});
