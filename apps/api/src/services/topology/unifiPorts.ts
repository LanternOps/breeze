import { createHash } from 'node:crypto';

/**
 * Canonical UniFi controller port identity (M3 Task 4 prerequisite).
 *
 * A controller device's switch port is a canonical `topology_interfaces` row
 * owned by the device's endpoint node, `interface_key = unifi-port:<index>` and
 * `controller_port_key` below. The port index is the identity (a label change
 * is not a new generation). The key is namespaced by the controller host +
 * controller site — the same axis as the endpoint key — so the telemetry
 * authority for one controller site can bound its interface allowlist by
 * prefix without trusting the upload. Bounded length; opaque by design.
 */
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const PREFIX = 'uport-v1';
const namespaceOf = (scopePart: string) => `${PREFIX}:${sha(scopePart).slice(0, 16)}:`;

/** Namespace for every port under one (host, controller site). */
export function unifiControllerPortNamespace(hostKey: string, controllerSiteId: string): string {
  return namespaceOf(`unifi:${encodeURIComponent(hostKey)}:${encodeURIComponent(controllerSiteId)}`);
}
/** Controller port key of `portIndex` on the device with this endpoint key. */
export function unifiControllerPortKey(endpointKey: string, portIndex: number): string {
  const [scheme, host, site] = endpointKey.split(':');
  if (scheme !== 'unifi' || !host || !site) throw new Error('invalid_unifi_endpoint_key');
  return `${namespaceOf(`unifi:${host}:${site}`)}${sha(`${endpointKey}#${portIndex}`).slice(0, 40)}`;
}
export const unifiPortInterfaceKey = (portIndex: number) => `unifi-port:${portIndex}`;
