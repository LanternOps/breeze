import { expect,it } from 'vitest';
import { HARDWARE_SOURCES,DISK_TIER_SOURCES } from '@breeze/shared';
import { isComponentFresh } from './freshness';
it.each(HARDWARE_SOURCES)('%s expires strictly after three tier intervals',source=>{
 const disk=(DISK_TIER_SOURCES as readonly string[]).includes(source);
 const lastSeenAt=new Date('2026-09-23T00:00:00Z');
 for(const settings of [{pollIntervalMinutes:null,diskHealthIntervalMinutes:null},{pollIntervalMinutes:5,diskHealthIntervalMinutes:15}]){
  const window=(disk?(settings.diskHealthIntervalMinutes??60):(settings.pollIntervalMinutes??10))*3*60_000;
  expect(isComponentFresh({source,lastSeenAt},settings,new Date(+lastSeenAt+window))).toBe(true);
  expect(isComponentFresh({source,lastSeenAt},settings,new Date(+lastSeenAt+window+1))).toBe(false);
 }
});
