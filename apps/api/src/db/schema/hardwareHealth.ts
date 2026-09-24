import { sql } from 'drizzle-orm';
import { pgEnum,pgTable,uuid,text,bigint,smallint,integer,boolean,jsonb,timestamp,foreignKey,index,uniqueIndex } from 'drizzle-orm/pg-core';
import { devices } from './devices';
import { organizations } from './orgs';
import type { HardwareSourceReport } from '@breeze/shared';
export const hardwareComponentTypeEnum = pgEnum('hardware_component_type',['controller','virtual_disk','physical_disk','cache_battery','enclosure','bmc','collector']);
export const hardwareSourceEnum = pgEnum('hardware_source',['storcli','perccli','megacli','ssacli','arcconf','omreport','mdadm','zfs','storage_spaces','windows_physical_disk','smartctl','ipmi','racadm','hponcfg','redfish','snmp']);
export const hardwareHealthEnum = pgEnum('hardware_health',['ok','warning','critical','unknown']);
export const hardwareEventTypeEnum = pgEnum('hardware_event_type',['first_seen','health_changed','state_changed','disk_replaced','predictive_failure_set','predictive_failure_cleared','stale','removed']);
export const deviceHardwareComponents = pgTable('device_hardware_components',{
  id:uuid('id').primaryKey().defaultRandom(),deviceId:uuid('device_id').notNull(),orgId:uuid('org_id').notNull().references(()=>organizations.id,{onDelete:'cascade'}),
  componentKey:text('component_key').notNull(),componentType:hardwareComponentTypeEnum('component_type').notNull(),parentKey:text('parent_key'),source:hardwareSourceEnum('source').notNull(),name:text('name').notNull(),
  model:text('model'),serial:text('serial'),firmware:text('firmware'),sizeBytes:bigint('size_bytes',{mode:'number'}),health:hardwareHealthEnum('health').notNull().default('unknown'),state:text('state').notNull(),stateDetail:text('state_detail'),
  progressPercent:smallint('progress_percent'),temperatureC:smallint('temperature_c'),predictiveFailure:boolean('predictive_failure').notNull().default(false),alertExempt:boolean('alert_exempt').notNull().default(false),attributes:jsonb('attributes').$type<Record<string,unknown>>().notNull().default({}),
  unhealthyStreak:integer('unhealthy_streak').notNull().default(0),criticalStreak:integer('critical_streak').notNull().default(0),healthyStreak:integer('healthy_streak').notNull().default(0),belowCriticalStreak:integer('below_critical_streak').notNull().default(0),predictiveStreak:integer('predictive_streak').notNull().default(0),
  stale:boolean('stale').notNull().default(false),staleSince:timestamp('stale_since',{withTimezone:true}),firstSeenAt:timestamp('first_seen_at',{withTimezone:true}).notNull(),lastSeenAt:timestamp('last_seen_at',{withTimezone:true}).notNull(),createdAt:timestamp('created_at',{withTimezone:true}).notNull().defaultNow(),updatedAt:timestamp('updated_at',{withTimezone:true}).notNull().defaultNow(),
},t=>[
  foreignKey({columns:[t.deviceId,t.orgId],foreignColumns:[devices.id,devices.orgId],name:'device_hardware_components_device_org_fkey'}).onUpdate('cascade').onDelete('cascade'),
  uniqueIndex('device_hardware_components_device_key_uidx').on(t.deviceId,t.componentKey),
  index('device_hardware_components_device_type_idx').on(t.deviceId,t.componentType).where(sql`NOT ${t.stale}`),
  index('device_hardware_components_org_health_idx').on(t.orgId,t.health).where(sql`NOT ${t.stale} AND ${t.health} IN ('warning','critical')`),
  index('device_hardware_components_stale_idx').on(t.staleSince).where(sql`${t.stale}`),
]);
export const deviceHardwareEvents = pgTable('device_hardware_events',{
  id:uuid('id').primaryKey().defaultRandom(),deviceId:uuid('device_id').notNull(),orgId:uuid('org_id').notNull().references(()=>organizations.id,{onDelete:'cascade'}),
  componentKey:text('component_key').notNull(),componentType:hardwareComponentTypeEnum('component_type').notNull(),eventType:hardwareEventTypeEnum('event_type').notNull(),fromHealth:hardwareHealthEnum('from_health'),toHealth:hardwareHealthEnum('to_health'),fromState:text('from_state'),toState:text('to_state'),detail:jsonb('detail').$type<Record<string,unknown>>().notNull().default({}),snapshotId:uuid('snapshot_id'),occurredAt:timestamp('occurred_at',{withTimezone:true}).notNull(),createdAt:timestamp('created_at',{withTimezone:true}).notNull().defaultNow(),
},t=>[
  foreignKey({columns:[t.deviceId,t.orgId],foreignColumns:[devices.id,devices.orgId],name:'device_hardware_events_device_org_fkey'}).onUpdate('cascade').onDelete('cascade'),
  index('device_hardware_events_device_occurred_idx').on(t.deviceId,t.occurredAt.desc()),index('device_hardware_events_occurred_idx').on(t.occurredAt),
]);
export const deviceHardwareHealth = pgTable('device_hardware_health',{
  deviceId:uuid('device_id').primaryKey(),orgId:uuid('org_id').notNull().references(()=>organizations.id,{onDelete:'cascade'}),health:hardwareHealthEnum('health').notNull().default('unknown'),collectorHealth:hardwareHealthEnum('collector_health').notNull().default('ok'),summary:jsonb('summary').$type<{counts?:Record<string,number>;controllerNames?:string[]}>().notNull().default({}),sources:jsonb('sources').$type<HardwareSourceReport[]>().notNull().default([]),
  lastAgentSequence:bigint('last_agent_sequence',{mode:'number'}).notNull().default(0),lastSnapshotId:uuid('last_snapshot_id'),lastCollectedAt:timestamp('last_collected_at',{withTimezone:true}),lastReceivedAt:timestamp('last_received_at',{withTimezone:true}),lastRaidReceivedAt:timestamp('last_raid_received_at',{withTimezone:true}),lastDiskReceivedAt:timestamp('last_disk_received_at',{withTimezone:true}),pollIntervalMinutes:integer('poll_interval_minutes'),diskHealthIntervalMinutes:integer('disk_health_interval_minutes'),tiersRun:text('tiers_run').array().notNull().default([]),agentVersion:text('agent_version'),createdAt:timestamp('created_at',{withTimezone:true}).notNull().defaultNow(),updatedAt:timestamp('updated_at',{withTimezone:true}).notNull().defaultNow(),
},t=>[
  foreignKey({columns:[t.deviceId,t.orgId],foreignColumns:[devices.id,devices.orgId],name:'device_hardware_health_device_org_fkey'}).onUpdate('cascade').onDelete('cascade'),
  index('device_hardware_health_org_health_idx').on(t.orgId,t.health),
]);
