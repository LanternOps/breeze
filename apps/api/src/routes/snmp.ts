import { randomUUID } from 'crypto';
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { authMiddleware, requireScope } from '../middleware/auth';

type SnmpOid = {
  id: string;
  oid: string;
  name: string;
  label: string;
  unit?: string;
  type: string;
  description?: string;
};

type SnmpTemplate = {
  id: string;
  name: string;
  description: string;
  source: 'builtin' | 'custom';
  vendor?: string;
  deviceClass?: string;
  tags: string[];
  oids: SnmpOid[];
  createdAt: string;
  updatedAt: string;
};

type SnmpDevice = {
  id: string;
  name: string;
  ipAddress: string;
  status: 'online' | 'offline' | 'warning' | 'maintenance';
  templateId: string;
  snmpVersion: 'v1' | 'v2c' | 'v3';
  community?: string;
  location?: string;
  tags: string[];
  lastPolledAt: string;
  createdAt: string;
  updatedAt: string;
};

type MetricSample = {
  oid: string;
  name: string;
  value: number | string;
  unit?: string;
  recordedAt: string;
};

type DeviceMetrics = {
  deviceId: string;
  capturedAt: string;
  metrics: MetricSample[];
};

type Threshold = {
  id: string;
  deviceId: string;
  oid: string;
  name: string;
  condition: 'gt' | 'gte' | 'lt' | 'lte' | 'eq';
  value: number;
  severity: 'info' | 'warning' | 'critical';
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

const nowIso = () => new Date().toISOString();
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60 * 1000).toISOString();
const hoursAgo = (hours: number) => new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

const builtInOids: SnmpOid[] = [
  {
    id: 'oid-sysuptime',
    oid: '1.3.6.1.2.1.1.3.0',
    name: 'sysUpTime',
    label: 'System Uptime',
    unit: 'centiseconds',
    type: 'TimeTicks',
    description: 'Time since last restart.'
  },
  {
    id: 'oid-sysname',
    oid: '1.3.6.1.2.1.1.5.0',
    name: 'sysName',
    label: 'System Name',
    type: 'OctetString',
    description: 'User-friendly device name.'
  },
  {
    id: 'oid-sysdescr',
    oid: '1.3.6.1.2.1.1.1.0',
    name: 'sysDescr',
    label: 'System Description',
    type: 'OctetString',
    description: 'System description string.'
  },
  {
    id: 'oid-ifinoctets',
    oid: '1.3.6.1.2.1.2.2.1.10',
    name: 'ifInOctets',
    label: 'Interface In Octets',
    unit: 'octets',
    type: 'Counter32',
    description: 'Total bytes received on an interface.'
  },
  {
    id: 'oid-ifoutoctets',
    oid: '1.3.6.1.2.1.2.2.1.16',
    name: 'ifOutOctets',
    label: 'Interface Out Octets',
    unit: 'octets',
    type: 'Counter32',
    description: 'Total bytes sent on an interface.'
  },
  {
    id: 'oid-ifoperstatus',
    oid: '1.3.6.1.2.1.2.2.1.8',
    name: 'ifOperStatus',
    label: 'Interface Operational Status',
    type: 'Integer',
    description: 'Operational state of an interface.'
  },
  {
    id: 'oid-hrprocessorload',
    oid: '1.3.6.1.2.1.25.3.3.1.2',
    name: 'hrProcessorLoad',
    label: 'CPU Load',
    unit: 'percent',
    type: 'Integer',
    description: 'CPU load percentage.'
  }
];

const ciscoCpuOid: SnmpOid = {
  id: 'oid-cisco-cpu-5m',
  oid: '1.3.6.1.4.1.9.2.1.57.0',
  name: 'cpmCPUTotal5min',
  label: 'CPU 5 Minute Average',
  unit: 'percent',
  type: 'Gauge32',
  description: 'Cisco CPU utilization (5 min).'
};

const hpSwitchCpuOid: SnmpOid = {
  id: 'oid-hp-switch-cpu',
  oid: '1.3.6.1.4.1.11.2.14.11.1.2.6.1.0',
  name: 'hpSwitchCpu',
  label: 'Switch CPU Utilization',
  unit: 'percent',
  type: 'Gauge32',
  description: 'HP switch CPU utilization.'
};

const printerSuppliesLevelOid: SnmpOid = {
  id: 'oid-prt-supply-level',
  oid: '1.3.6.1.2.1.43.11.1.1.9.1',
  name: 'prtMarkerSuppliesLevel',
  label: 'Toner Level',
  unit: 'percent',
  type: 'Integer',
  description: 'Remaining printer supply level.'
};

const printerStatusOid: SnmpOid = {
  id: 'oid-prt-status',
  oid: '1.3.6.1.2.1.43.5.1.1.1.1',
  name: 'prtGeneralPrinterStatus',
  label: 'Printer Status',
  type: 'Integer',
  description: 'Overall printer status.'
};

const allOids = [
  ...builtInOids,
  ciscoCpuOid,
  hpSwitchCpuOid,
  printerSuppliesLevelOid,
  printerStatusOid
];

const oidByName = new Map(allOids.map((oid) => [oid.name, oid]));
const oidByOid = new Map(allOids.map((oid) => [oid.oid, oid]));

const templates: SnmpTemplate[] = [
  {
    id: 'tmpl-cisco-router',
    name: 'Cisco Router',
    description: 'Core router template with interface and CPU metrics.',
    source: 'builtin',
    vendor: 'Cisco',
    deviceClass: 'router',
    tags: ['router', 'cisco', 'wan'],
    oids: [
      oidByName.get('sysUpTime')!,
      oidByName.get('ifInOctets')!,
      oidByName.get('ifOutOctets')!,
      oidByName.get('ifOperStatus')!,
      ciscoCpuOid
    ],
    createdAt: daysAgo(90),
    updatedAt: daysAgo(10)
  },
  {
    id: 'tmpl-hp-switch',
    name: 'HP Switch',
    description: 'Switch monitoring for ports, CPU, and uptime.',
    source: 'builtin',
    vendor: 'HP',
    deviceClass: 'switch',
    tags: ['switch', 'hp', 'lan'],
    oids: [
      oidByName.get('sysUpTime')!,
      oidByName.get('ifInOctets')!,
      oidByName.get('ifOutOctets')!,
      oidByName.get('ifOperStatus')!,
      hpSwitchCpuOid
    ],
    createdAt: daysAgo(120),
    updatedAt: daysAgo(14)
  },
  {
    id: 'tmpl-network-printer',
    name: 'Network Printer',
    description: 'Printer health and supply level monitoring.',
    source: 'builtin',
    vendor: 'Generic',
    deviceClass: 'printer',
    tags: ['printer', 'office'],
    oids: [
      oidByName.get('sysUpTime')!,
      oidByName.get('sysName')!,
      printerSuppliesLevelOid,
      printerStatusOid
    ],
    createdAt: daysAgo(150),
    updatedAt: daysAgo(20)
  },
  {
    id: 'tmpl-custom-ups',
    name: 'Custom UPS',
    description: 'Custom UPS monitoring pack.',
    source: 'custom',
    vendor: 'APC',
    deviceClass: 'ups',
    tags: ['ups', 'power'],
    oids: [
      oidByName.get('sysUpTime')!,
      oidByName.get('hrProcessorLoad')!,
      oidByName.get('ifInOctets')!
    ],
    createdAt: daysAgo(12),
    updatedAt: daysAgo(3)
  }
];

const devices: SnmpDevice[] = [
  {
    id: 'snmp-dev-001',
    name: 'Edge Router 01',
    ipAddress: '10.40.12.1',
    status: 'online',
    templateId: 'tmpl-cisco-router',
    snmpVersion: 'v2c',
    community: 'public',
    location: 'DC-1 Row A',
    tags: ['core', 'wan'],
    lastPolledAt: minutesAgo(6),
    createdAt: daysAgo(40),
    updatedAt: hoursAgo(6)
  },
  {
    id: 'snmp-dev-002',
    name: 'HQ Switch 24',
    ipAddress: '10.50.4.10',
    status: 'warning',
    templateId: 'tmpl-hp-switch',
    snmpVersion: 'v2c',
    community: 'public',
    location: 'HQ MDF',
    tags: ['access', 'lan'],
    lastPolledAt: minutesAgo(8),
    createdAt: daysAgo(60),
    updatedAt: hoursAgo(8)
  },
  {
    id: 'snmp-dev-003',
    name: 'Finance Printer',
    ipAddress: '10.20.8.55',
    status: 'online',
    templateId: 'tmpl-network-printer',
    snmpVersion: 'v1',
    community: 'public',
    location: 'Floor 3 West',
    tags: ['printer', 'finance'],
    lastPolledAt: minutesAgo(12),
    createdAt: daysAgo(25),
    updatedAt: hoursAgo(2)
  }
];

const metricsByDevice: Record<string, DeviceMetrics> = {
  'snmp-dev-001': {
    deviceId: 'snmp-dev-001',
    capturedAt: minutesAgo(6),
    metrics: [
      {
        oid: oidByName.get('sysUpTime')!.oid,
        name: 'sysUpTime',
        value: 98324567,
        unit: 'centiseconds',
        recordedAt: minutesAgo(6)
      },
      {
        oid: oidByName.get('ifInOctets')!.oid,
        name: 'ifInOctets',
        value: 829452934,
        unit: 'octets',
        recordedAt: minutesAgo(6)
      },
      {
        oid: oidByName.get('ifOutOctets')!.oid,
        name: 'ifOutOctets',
        value: 776302112,
        unit: 'octets',
        recordedAt: minutesAgo(6)
      },
      {
        oid: ciscoCpuOid.oid,
        name: 'cpmCPUTotal5min',
        value: 41,
        unit: 'percent',
        recordedAt: minutesAgo(6)
      }
    ]
  },
  'snmp-dev-002': {
    deviceId: 'snmp-dev-002',
    capturedAt: minutesAgo(8),
    metrics: [
      {
        oid: oidByName.get('sysUpTime')!.oid,
        name: 'sysUpTime',
        value: 55234112,
        unit: 'centiseconds',
        recordedAt: minutesAgo(8)
      },
      {
        oid: oidByName.get('ifInOctets')!.oid,
        name: 'ifInOctets',
        value: 433221900,
        unit: 'octets',
        recordedAt: minutesAgo(8)
      },
      {
        oid: oidByName.get('ifOutOctets')!.oid,
        name: 'ifOutOctets',
        value: 291229100,
        unit: 'octets',
        recordedAt: minutesAgo(8)
      },
      {
        oid: hpSwitchCpuOid.oid,
        name: 'hpSwitchCpu',
        value: 78,
        unit: 'percent',
        recordedAt: minutesAgo(8)
      }
    ]
  },
  'snmp-dev-003': {
    deviceId: 'snmp-dev-003',
    capturedAt: minutesAgo(12),
    metrics: [
      {
        oid: oidByName.get('sysUpTime')!.oid,
        name: 'sysUpTime',
        value: 12302211,
        unit: 'centiseconds',
        recordedAt: minutesAgo(12)
      },
      {
        oid: printerSuppliesLevelOid.oid,
        name: 'prtMarkerSuppliesLevel',
        value: 32,
        unit: 'percent',
        recordedAt: minutesAgo(12)
      },
      {
        oid: printerStatusOid.oid,
        name: 'prtGeneralPrinterStatus',
        value: 4,
        recordedAt: minutesAgo(12)
      }
    ]
  }
};

const thresholds: Threshold[] = [
  {
    id: 'snmp-thresh-001',
    deviceId: 'snmp-dev-001',
    oid: ciscoCpuOid.oid,
    name: 'Router CPU High',
    condition: 'gt',
    value: 80,
    severity: 'critical',
    enabled: true,
    createdAt: daysAgo(30),
    updatedAt: daysAgo(2)
  },
  {
    id: 'snmp-thresh-002',
    deviceId: 'snmp-dev-002',
    oid: hpSwitchCpuOid.oid,
    name: 'Switch CPU Warning',
    condition: 'gt',
    value: 70,
    severity: 'warning',
    enabled: true,
    createdAt: daysAgo(25),
    updatedAt: daysAgo(1)
  },
  {
    id: 'snmp-thresh-003',
    deviceId: 'snmp-dev-003',
    oid: printerSuppliesLevelOid.oid,
    name: 'Toner Low',
    condition: 'lt',
    value: 20,
    severity: 'warning',
    enabled: true,
    createdAt: daysAgo(18),
    updatedAt: daysAgo(3)
  }
];

const listDevicesSchema = z.object({
  status: z.enum(['online', 'offline', 'warning', 'maintenance']).optional(),
  templateId: z.string().optional(),
  location: z.string().optional(),
  tag: z.string().optional(),
  search: z.string().optional()
});

const createDeviceSchema = z.object({
  name: z.string().min(1),
  ipAddress: z.string().min(1),
  snmpVersion: z.enum(['v1', 'v2c', 'v3']),
  community: z.string().optional(),
  templateId: z.string().min(1),
  location: z.string().optional(),
  tags: z.array(z.string()).optional()
});

const updateDeviceSchema = createDeviceSchema.partial();

const listTemplatesSchema = z.object({
  source: z.enum(['builtin', 'custom']).optional(),
  search: z.string().optional()
});

const oidSchema = z.object({
  id: z.string().optional(),
  oid: z.string().min(1),
  name: z.string().min(1),
  label: z.string().optional(),
  unit: z.string().optional(),
  type: z.string().optional(),
  description: z.string().optional()
});

const createTemplateSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  vendor: z.string().optional(),
  deviceClass: z.string().optional(),
  tags: z.array(z.string()).optional(),
  oids: z.array(oidSchema)
});

const updateTemplateSchema = createTemplateSchema.partial();

const metricsHistorySchema = z.object({
  start: z.string().optional(),
  end: z.string().optional(),
  interval: z.enum(['5m', '15m', '1h', '6h', '1d']).optional()
});

const createThresholdSchema = z.object({
  deviceId: z.string().min(1),
  oid: z.string().min(1),
  name: z.string().min(1),
  condition: z.enum(['gt', 'gte', 'lt', 'lte', 'eq']),
  value: z.number(),
  severity: z.enum(['info', 'warning', 'critical']),
  enabled: z.boolean().optional()
});

const updateThresholdSchema = createThresholdSchema.partial();

const intervalMsMap: Record<string, number> = {
  '5m': 5 * 60 * 1000,
  '15m': 15 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
  '1d': 24 * 60 * 60 * 1000
};

const snmpRoutes = new Hono();

snmpRoutes.use('*', authMiddleware);

function getDeviceById(deviceId: string) {
  return devices.find((device) => device.id === deviceId) ?? null;
}

function getTemplateById(templateId: string) {
  return templates.find((template) => template.id === templateId) ?? null;
}

function normalizeDate(value: string | undefined, fallback: Date) {
  if (!value) {
    return fallback;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return fallback;
  }
  return parsed;
}

function resolveOid(oid: string) {
  return oidByOid.get(oid) ?? oidByName.get(oid) ?? null;
}

function buildSeries(metrics: MetricSample[], start: Date, end: Date, intervalMs: number) {
  return metrics.map((metric) => {
    const points: Array<{ timestamp: string; value: number | string }> = [];
    for (let ts = start.getTime(); ts <= end.getTime(); ts += intervalMs) {
      if (typeof metric.value === 'number') {
        const variance = Math.max(1, Math.round(metric.value * 0.06));
        const wave = Math.sin(ts / (intervalMs * 2));
        const value = Math.max(0, Math.round(metric.value + wave * variance));
        points.push({ timestamp: new Date(ts).toISOString(), value });
      } else {
        points.push({ timestamp: new Date(ts).toISOString(), value: metric.value });
      }
    }
    return {
      oid: metric.oid,
      name: metric.name,
      unit: metric.unit,
      points
    };
  });
}

function refreshDeviceMetrics(deviceId: string) {
  const current = metricsByDevice[deviceId];
  if (!current) {
    return null;
  }
  const capturedAt = nowIso();
  const metrics = current.metrics.map((metric) => {
    if (typeof metric.value === 'number') {
      const variance = Math.max(1, Math.round(metric.value * 0.04));
      const value = Math.max(0, Math.round(metric.value + (Math.random() - 0.5) * variance));
      return { ...metric, value, recordedAt: capturedAt };
    }
    return { ...metric, recordedAt: capturedAt };
  });
  const updated = { ...current, capturedAt, metrics };
  metricsByDevice[deviceId] = updated;
  return updated;
}

// Device routes
snmpRoutes.get(
  '/devices',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', listDevicesSchema),
  (c) => {
    const query = c.req.valid('query');
    let results = devices.slice();

    if (query.status) {
      results = results.filter((device) => device.status === query.status);
    }
    if (query.templateId) {
      results = results.filter((device) => device.templateId === query.templateId);
    }
    if (query.location) {
      results = results.filter((device) =>
        device.location?.toLowerCase().includes(query.location!.toLowerCase())
      );
    }
    if (query.tag) {
      results = results.filter((device) => device.tags.includes(query.tag!));
    }
    if (query.search) {
      const term = query.search.toLowerCase();
      results = results.filter((device) =>
        [device.name, device.ipAddress, device.location ?? ''].some((value) =>
          value.toLowerCase().includes(term)
        )
      );
    }

    return c.json({
      data: results,
      filters: query,
      total: results.length
    });
  }
);

snmpRoutes.post(
  '/devices',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', createDeviceSchema),
  async (c) => {
    const payload = c.req.valid('json');
    const template = getTemplateById(payload.templateId);
    if (!template) {
      return c.json({ error: 'Template not found.' }, 400);
    }

    const device: SnmpDevice = {
      id: `snmp-dev-${randomUUID()}`,
      name: payload.name,
      ipAddress: payload.ipAddress,
      status: 'online',
      templateId: payload.templateId,
      snmpVersion: payload.snmpVersion,
      community: payload.community ?? 'public',
      location: payload.location ?? 'Unassigned',
      tags: payload.tags ?? [],
      lastPolledAt: nowIso(),
      createdAt: nowIso(),
      updatedAt: nowIso()
    };
    devices.push(device);

    const templateMetrics = template.oids.map((oid) => ({
      oid: oid.oid,
      name: oid.name,
      unit: oid.unit,
      value: oid.unit === 'percent' ? 10 : 1,
      recordedAt: nowIso()
    }));
    metricsByDevice[device.id] = {
      deviceId: device.id,
      capturedAt: nowIso(),
      metrics: templateMetrics
    };

    return c.json({ data: device }, 201);
  }
);

snmpRoutes.get(
  '/devices/:id',
  requireScope('organization', 'partner', 'system'),
  (c) => {
    const device = getDeviceById(c.req.param('id'));
    if (!device) {
      return c.json({ error: 'Device not found.' }, 404);
    }

    const template = getTemplateById(device.templateId);
    const metrics = metricsByDevice[device.id] ?? null;

    return c.json({
      data: {
        ...device,
        template,
        recentMetrics: metrics
      }
    });
  }
);

snmpRoutes.patch(
  '/devices/:id',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', updateDeviceSchema),
  (c) => {
    const device = getDeviceById(c.req.param('id'));
    if (!device) {
      return c.json({ error: 'Device not found.' }, 404);
    }

    const payload = c.req.valid('json');
    if (payload.templateId && !getTemplateById(payload.templateId)) {
      return c.json({ error: 'Template not found.' }, 400);
    }

    Object.assign(device, {
      ...payload,
      updatedAt: nowIso()
    });

    return c.json({ data: device });
  }
);

snmpRoutes.delete(
  '/devices/:id',
  requireScope('organization', 'partner', 'system'),
  (c) => {
    const deviceId = c.req.param('id');
    const index = devices.findIndex((device) => device.id === deviceId);
    if (index === -1) {
      return c.json({ error: 'Device not found.' }, 404);
    }

    const [removed] = devices.splice(index, 1);
    delete metricsByDevice[deviceId];

    return c.json({ data: removed });
  }
);

snmpRoutes.post(
  '/devices/:id/poll',
  requireScope('organization', 'partner', 'system'),
  (c) => {
    const device = getDeviceById(c.req.param('id'));
    if (!device) {
      return c.json({ error: 'Device not found.' }, 404);
    }

    const metrics = refreshDeviceMetrics(device.id);
    device.lastPolledAt = nowIso();
    device.updatedAt = nowIso();

    return c.json({
      data: {
        deviceId: device.id,
        polledAt: device.lastPolledAt,
        metrics
      }
    });
  }
);

snmpRoutes.post(
  '/devices/:id/test',
  requireScope('organization', 'partner', 'system'),
  (c) => {
    const device = getDeviceById(c.req.param('id'));
    if (!device) {
      return c.json({ error: 'Device not found.' }, 404);
    }

    const ok = device.status !== 'offline';
    const latencyMs = ok ? 12 + Math.floor(Math.random() * 60) : null;
    return c.json({
      data: {
        deviceId: device.id,
        ok,
        latencyMs,
        snmpVersion: device.snmpVersion,
        testedAt: nowIso()
      }
    });
  }
);

// Template routes
snmpRoutes.get(
  '/templates',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', listTemplatesSchema),
  (c) => {
    const query = c.req.valid('query');
    let results = templates.slice();

    if (query.source) {
      results = results.filter((template) => template.source === query.source);
    }
    if (query.search) {
      const term = query.search.toLowerCase();
      results = results.filter((template) =>
        [template.name, template.vendor ?? '', template.deviceClass ?? '']
          .join(' ')
          .toLowerCase()
          .includes(term)
      );
    }

    return c.json({
      data: results.map((template) => ({
        ...template,
        oidCount: template.oids.length
      }))
    });
  }
);

snmpRoutes.post(
  '/templates',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', createTemplateSchema),
  (c) => {
    const payload = c.req.valid('json');
    const createdAt = nowIso();
    const oids: SnmpOid[] = payload.oids.map((oid) => ({
      id: oid.id ?? `oid-custom-${randomUUID()}`,
      oid: oid.oid,
      name: oid.name,
      label: oid.label ?? oid.name,
      unit: oid.unit,
      type: oid.type ?? 'Gauge32',
      description: oid.description
    }));

    const template: SnmpTemplate = {
      id: `tmpl-custom-${randomUUID()}`,
      name: payload.name,
      description: payload.description ?? 'Custom SNMP template.',
      source: 'custom',
      vendor: payload.vendor,
      deviceClass: payload.deviceClass,
      tags: payload.tags ?? [],
      oids,
      createdAt,
      updatedAt: createdAt
    };

    templates.push(template);
    return c.json({ data: template }, 201);
  }
);

snmpRoutes.get(
  '/templates/:id',
  requireScope('organization', 'partner', 'system'),
  (c) => {
    const template = getTemplateById(c.req.param('id'));
    if (!template) {
      return c.json({ error: 'Template not found.' }, 404);
    }

    return c.json({ data: template });
  }
);

snmpRoutes.patch(
  '/templates/:id',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', updateTemplateSchema),
  (c) => {
    const template = getTemplateById(c.req.param('id'));
    if (!template) {
      return c.json({ error: 'Template not found.' }, 404);
    }
    if (template.source === 'builtin') {
      return c.json({ error: 'Built-in templates cannot be modified.' }, 400);
    }

    const payload = c.req.valid('json');
    const { oids: payloadOids, ...templateUpdates } = payload;
    const nextTemplate: Partial<SnmpTemplate> = { ...templateUpdates };
    if (payloadOids) {
      template.oids = payloadOids.map((oid) => ({
        id: oid.id ?? `oid-custom-${randomUUID()}`,
        oid: oid.oid,
        name: oid.name,
        label: oid.label ?? oid.name,
        unit: oid.unit,
        type: oid.type ?? 'Gauge32',
        description: oid.description
      }));
    }

    Object.assign(template, nextTemplate, {
      updatedAt: nowIso()
    });

    return c.json({ data: template });
  }
);

snmpRoutes.delete(
  '/templates/:id',
  requireScope('organization', 'partner', 'system'),
  (c) => {
    const templateId = c.req.param('id');
    const template = getTemplateById(templateId);
    if (!template) {
      return c.json({ error: 'Template not found.' }, 404);
    }
    if (template.source === 'builtin') {
      return c.json({ error: 'Built-in templates cannot be deleted.' }, 400);
    }

    const index = templates.findIndex((item) => item.id === templateId);
    templates.splice(index, 1);

    return c.json({ data: template });
  }
);

// Metric routes
snmpRoutes.get(
  '/metrics/:deviceId',
  requireScope('organization', 'partner', 'system'),
  (c) => {
    const deviceId = c.req.param('deviceId');
    const device = getDeviceById(deviceId);
    if (!device) {
      return c.json({ error: 'Device not found.' }, 404);
    }

    const metrics = metricsByDevice[deviceId];
    return c.json({
      data: metrics ?? {
        deviceId,
        capturedAt: nowIso(),
        metrics: []
      }
    });
  }
);

snmpRoutes.get(
  '/metrics/:deviceId/history',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', metricsHistorySchema),
  (c) => {
    const deviceId = c.req.param('deviceId');
    const device = getDeviceById(deviceId);
    if (!device) {
      return c.json({ error: 'Device not found.' }, 404);
    }

    const query = c.req.valid('query');
    const end = normalizeDate(query.end, new Date());
    const start = normalizeDate(query.start, new Date(end.getTime() - 24 * 60 * 60 * 1000));
    const interval = query.interval ?? '1h';
    const intervalMs = intervalMsMap[interval] ?? 0;
    const metrics = metricsByDevice[deviceId]?.metrics ?? [];

    return c.json({
      data: {
        deviceId,
        start: start.toISOString(),
        end: end.toISOString(),
        interval,
        series: buildSeries(metrics, start, end, intervalMs)
      }
    });
  }
);

snmpRoutes.get(
  '/metrics/:deviceId/:oid',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', metricsHistorySchema),
  (c) => {
    const deviceId = c.req.param('deviceId');
    const oid = c.req.param('oid');
    const device = getDeviceById(deviceId);
    if (!device) {
      return c.json({ error: 'Device not found.' }, 404);
    }

    const query = c.req.valid('query');
    const end = normalizeDate(query.end, new Date());
    const start = normalizeDate(query.start, new Date(end.getTime() - 24 * 60 * 60 * 1000));
    const interval = query.interval ?? '1h';
    const intervalMs = intervalMsMap[interval] ?? 0;
    const metrics = metricsByDevice[deviceId]?.metrics ?? [];
    const metric = metrics.find((entry) => entry.oid === oid || entry.name === oid);

    if (!metric) {
      const resolved = resolveOid(oid);
      return c.json(
        {
          data: {
            deviceId,
            oid,
            name: resolved?.name ?? oid,
            series: []
          }
        },
        200
      );
    }

    const series = buildSeries([metric], start, end, intervalMs);
    return c.json({
      data: {
        deviceId,
        oid: metric.oid,
        name: metric.name,
        unit: metric.unit,
        interval,
        start: start.toISOString(),
        end: end.toISOString(),
        series: series[0]?.points ?? []
      }
    });
  }
);

// Threshold routes
snmpRoutes.get(
  '/thresholds/:deviceId',
  requireScope('organization', 'partner', 'system'),
  (c) => {
    const deviceId = c.req.param('deviceId');
    const device = getDeviceById(deviceId);
    if (!device) {
      return c.json({ error: 'Device not found.' }, 404);
    }

    return c.json({
      data: thresholds.filter((threshold) => threshold.deviceId === deviceId)
    });
  }
);

snmpRoutes.post(
  '/thresholds',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', createThresholdSchema),
  (c) => {
    const payload = c.req.valid('json');
    const device = getDeviceById(payload.deviceId);
    if (!device) {
      return c.json({ error: 'Device not found.' }, 404);
    }

    const createdAt = nowIso();
    const threshold: Threshold = {
      id: `snmp-thresh-${randomUUID()}`,
      deviceId: payload.deviceId,
      oid: payload.oid,
      name: payload.name,
      condition: payload.condition,
      value: payload.value,
      severity: payload.severity,
      enabled: payload.enabled ?? true,
      createdAt,
      updatedAt: createdAt
    };

    thresholds.push(threshold);
    return c.json({ data: threshold }, 201);
  }
);

snmpRoutes.patch(
  '/thresholds/:id',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', updateThresholdSchema),
  (c) => {
    const threshold = thresholds.find((item) => item.id === c.req.param('id'));
    if (!threshold) {
      return c.json({ error: 'Threshold not found.' }, 404);
    }

    const payload = c.req.valid('json');
    Object.assign(threshold, {
      ...payload,
      updatedAt: nowIso()
    });

    return c.json({ data: threshold });
  }
);

snmpRoutes.delete(
  '/thresholds/:id',
  requireScope('organization', 'partner', 'system'),
  (c) => {
    const thresholdId = c.req.param('id');
    const index = thresholds.findIndex((item) => item.id === thresholdId);
    if (index === -1) {
      return c.json({ error: 'Threshold not found.' }, 404);
    }

    const [removed] = thresholds.splice(index, 1);
    return c.json({ data: removed });
  }
);

// Dashboard route
snmpRoutes.get(
  '/dashboard',
  requireScope('organization', 'partner', 'system'),
  (c) => {
    const statusCounts = devices.reduce<Record<string, number>>((acc, device) => {
      acc[device.status] = (acc[device.status] ?? 0) + 1;
      return acc;
    }, {});

    const templateUsage = templates.map((template) => ({
      templateId: template.id,
      name: template.name,
      deviceCount: devices.filter((device) => device.templateId === template.id).length
    }));

    const topInterfaces = devices.map((device) => {
      const metrics = metricsByDevice[device.id]?.metrics ?? [];
      const inOctets = metrics.find((metric) => metric.name === 'ifInOctets')?.value ?? 0;
      const outOctets = metrics.find((metric) => metric.name === 'ifOutOctets')?.value ?? 0;
      return {
        deviceId: device.id,
        name: device.name,
        inOctets,
        outOctets,
        totalOctets: Number(inOctets) + Number(outOctets)
      };
    });

    topInterfaces.sort((a, b) => b.totalOctets - a.totalOctets);

    return c.json({
      data: {
        totals: {
          devices: devices.length,
          templates: templates.length,
          thresholds: thresholds.length
        },
        status: statusCounts,
        templateUsage,
        topInterfaces: topInterfaces.slice(0, 5),
        recentPolls: devices
          .map((device) => ({
            deviceId: device.id,
            name: device.name,
            lastPolledAt: device.lastPolledAt,
            status: device.status
          }))
          .sort((a, b) => b.lastPolledAt.localeCompare(a.lastPolledAt))
          .slice(0, 5)
      }
    });
  }
);

export { snmpRoutes };
