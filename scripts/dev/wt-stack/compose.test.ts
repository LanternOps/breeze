import { describe, it, expect } from 'vitest';
import { parsePublishedPort, parsePortOwners } from './compose';

// #9864 — output of `docker ps --format '{{.Label "com.docker.compose.project"}}|{{.Ports}}'`.
describe('parsePortOwners', () => {
  const out = [
    'breeze-wt-main|0.0.0.0:8443->80/tcp, [::]:8443->80/tcp, 0.0.0.0:61001->443/tcp',
    'breeze-wt-other|0.0.0.0:61002->80/tcp',
    'breeze-wt-x|5432/tcp',
    '|0.0.0.0:18443->80/tcp',
    '',
  ].join('\n');

  it('matches the host side of a binding, once per container', () => {
    expect(parsePortOwners(out, 8443)).toEqual(['breeze-wt-main']);
  });
  it('does not match a container-side port', () => {
    expect(parsePortOwners(out, 80)).toEqual([]);
    expect(parsePortOwners(out, 5432)).toEqual([]);
  });
  it('does not match a port that is only a prefix of the published one', () => {
    expect(parsePortOwners(out, 844)).toEqual([]);
    expect(parsePortOwners(out, 1001)).toEqual([]);
  });
  it('reports an unlabelled container as an empty owner', () => {
    expect(parsePortOwners(out, 18443)).toEqual(['']);
  });
  it('returns nothing for empty output', () => {
    expect(parsePortOwners('', 8443)).toEqual([]);
  });
});

describe('parsePublishedPort', () => {
  it('parses an IPv4 mapping', () => {
    expect(parsePublishedPort('0.0.0.0:53421\n')).toBe(53421);
  });
  it('parses a loopback-bound mapping', () => {
    expect(parsePublishedPort('127.0.0.1:53421\n')).toBe(53421);
  });
  it('parses the first line when both IPv6 and IPv4 are present', () => {
    expect(parsePublishedPort('[::]:53421\n0.0.0.0:53421\n')).toBe(53421);
  });
  it('throws on empty output', () => {
    expect(() => parsePublishedPort('   \n')).toThrow(/no published port/i);
  });
});
