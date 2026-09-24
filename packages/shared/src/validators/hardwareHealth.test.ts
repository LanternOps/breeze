import { expect, it } from 'vitest';
import { hardwareComponentReportSchema as component, hardwareSourceReportSchema as source,
  hardwareHealthSnapshotSchema as snapshot, hardwareMonitoringInlineSettingsSchema as settings,
  HARDWARE_MONITORING_DEFAULTS } from './hardwareHealth';
const disk = {componentKey:'smart:serial',componentType:'physical_disk',source:'smartctl',name:'Disk',state:'online'};
const wire = {snapshotId:'11111111-1111-4111-8111-111111111111',sequence:0,collectedAt:'2026-09-23T00:00:00Z',agentVersion:'1',pollIntervalMinutes:10,diskHealthIntervalMinutes:60,tiersRun:['disk'],sources:[],components:[]};
it('defaults and nullable fields round trip', () => {
  expect(settings.parse({})).toEqual(HARDWARE_MONITORING_DEFAULTS);
  expect(component.parse({...disk,serial:null,smartPassed:null})).toMatchObject({predictiveFailure:false,alertExempt:false,attributes:{},serial:null,smartPassed:null});
  expect(snapshot.parse(wire).sequence).toBe(0);
});
it.each(['ok','unavailable','superseded','failed','backing_off','disabled'])('requires complete only for %s', status => {
  expect(source.safeParse({source:'smartctl',status}).success).toBe(status !== 'ok');
  for (const complete of [false,true]) expect(source.safeParse({source:'smartctl',status,complete}).success).toBe(true);
});
it.each([{componentType:'collector'},{componentKey:''},{componentKey:'x'.repeat(201)},{sizeBytes:-1},{progressPercent:101},{temperatureC:201},{predictiveFailure:1}])('rejects malformed component %j', extra => expect(component.safeParse({...disk,...extra}).success).toBe(false));
it.each([{pollIntervalMinutes:4},{pollIntervalMinutes:61},{diskHealthIntervalMinutes:14},{diskHealthIntervalMinutes:1441},{enabled:'true'}])('rejects settings %j', input => expect(settings.safeParse(input).success).toBe(false));
it('caps arrays and accepts interval endpoints', () => {
  expect(snapshot.safeParse({...wire,components:Array(2001).fill(disk)}).success).toBe(false);
  expect(snapshot.safeParse({...wire,tiersRun:[]}).success).toBe(false);
  expect(snapshot.safeParse({...wire,sources:Array(33).fill({source:'smartctl',status:'failed'})}).success).toBe(false);
  for (const [pollIntervalMinutes,diskHealthIntervalMinutes] of [[5,15],[60,1440]]) expect(settings.safeParse({pollIntervalMinutes,diskHealthIntervalMinutes}).success).toBe(true);
});
