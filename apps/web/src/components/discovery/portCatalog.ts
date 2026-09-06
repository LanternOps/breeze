// Service catalog for discovered open ports. Turns a bare port number into
// something a technician can act on: a human label, a "kind" that drives the
// row's action/badge on NetworkDeviceDetailPage, and whether the service is
// inherently insecure (sends credentials/data in clear text).
//
// `isWebPort`/`defaultSchemeForPort` are kept here (not duplicated on the
// page) so the "does this port get an Open button" question and the "what
// scheme do we default to" question can never drift out of sync with the
// catalog itself.

export type PortKind = 'web' | 'remote' | 'print' | 'file' | 'mgmt' | 'insecure' | 'other';

export type PortDescription = {
  label: string;
  kind: PortKind;
  risky: boolean;
};

type CatalogEntry = {
  label: string;
  kind: PortKind;
  // Only ports whose plaintext protocol carries credentials/data are marked
  // risky — this drives the "Unencrypted" warning badge, not just the
  // 'insecure' kind (kept separate in case a future entry needs one without
  // the other).
  risky?: boolean;
  // Ports that should default the proxy popover's scheme to HTTPS. Only web
  // ports need this; everything else defaults to plain HTTP.
  scheme?: 'https';
};

// Ports/services a network discovery scan commonly turns up. Extend this as
// new well-known services come up rather than special-casing them on the page.
const PORT_CATALOG: Record<number, CatalogEntry> = {
  21: { label: 'FTP', kind: 'insecure', risky: true },
  22: { label: 'SSH', kind: 'remote' },
  23: { label: 'Telnet', kind: 'insecure', risky: true },
  25: { label: 'SMTP', kind: 'other' },
  53: { label: 'DNS', kind: 'other' },
  80: { label: 'HTTP', kind: 'web' },
  88: { label: 'Kerberos', kind: 'other' },
  110: { label: 'POP3', kind: 'insecure', risky: true },
  135: { label: 'RPC', kind: 'mgmt' },
  137: { label: 'NetBIOS', kind: 'file' },
  138: { label: 'NetBIOS', kind: 'file' },
  139: { label: 'NetBIOS', kind: 'file' },
  143: { label: 'IMAP', kind: 'other' },
  161: { label: 'SNMP', kind: 'mgmt' },
  389: { label: 'LDAP', kind: 'mgmt' },
  443: { label: 'HTTPS', kind: 'web', scheme: 'https' },
  445: { label: 'SMB', kind: 'file' },
  515: { label: 'LPD', kind: 'print' },
  548: { label: 'AFP', kind: 'file' },
  631: { label: 'IPP', kind: 'print' },
  636: { label: 'LDAPS', kind: 'mgmt' },
  902: { label: 'ESXi', kind: 'mgmt' },
  1433: { label: 'MSSQL', kind: 'other' },
  1521: { label: 'Oracle', kind: 'other' },
  2049: { label: 'NFS', kind: 'file' },
  3306: { label: 'MySQL', kind: 'other' },
  3389: { label: 'RDP', kind: 'remote' },
  5900: { label: 'VNC', kind: 'remote' },
  5985: { label: 'WinRM', kind: 'mgmt' },
  5986: { label: 'WinRM (HTTPS)', kind: 'mgmt' },
  8006: { label: 'Proxmox', kind: 'web' },
  8080: { label: 'HTTP-alt', kind: 'web' },
  8443: { label: 'HTTPS-alt', kind: 'web', scheme: 'https' },
  9100: { label: 'Raw print (JetDirect)', kind: 'print' },
  9443: { label: 'HTTPS-alt', kind: 'web', scheme: 'https' },
  10000: { label: 'Webmin', kind: 'web' },
};

// When the port itself isn't in the catalog, fall back to the discovered
// service string (if the scan recorded one) to guess a kind.
function inferKindFromService(service: string): PortKind {
  if (/https?/i.test(service)) return 'web';
  if (/ssh|rdp|vnc/i.test(service)) return 'remote';
  if (/ipp|lpd|jetdirect/i.test(service)) return 'print';
  if (/smb|nfs|afp/i.test(service)) return 'file';
  if (/snmp|ldap|winrm/i.test(service)) return 'mgmt';
  return 'other';
}

export function describePort(port: number, service?: string): PortDescription {
  const known = PORT_CATALOG[port];
  if (known) {
    return { label: known.label, kind: known.kind, risky: !!known.risky };
  }
  if (service) {
    return { label: service, kind: inferKindFromService(service), risky: false };
  }
  return { label: String(port), kind: 'other', risky: false };
}

export function isWebPort(port: number, service?: string): boolean {
  return describePort(port, service).kind === 'web';
}

export function defaultSchemeForPort(port: number, service?: string): 'http' | 'https' {
  if (PORT_CATALOG[port]?.scheme === 'https') return 'https';
  if (service && /https/i.test(service)) return 'https';
  return 'http';
}

// Ascending by port number. `Array.prototype.sort` is stable in every engine
// this app ships to, so equal-port entries (e.g. two scans of the same port
// with different service labels) keep their relative order.
export function sortPorts<T extends { port: number }>(ports: T[]): T[] {
  return [...ports].sort((a, b) => a.port - b.port);
}
