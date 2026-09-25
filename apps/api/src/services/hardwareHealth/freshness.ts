import { DISK_TIER_SOURCES,type HardwareSource } from '@breeze/shared';
export function isComponentFresh(c:{source:HardwareSource;lastSeenAt:Date},health:{pollIntervalMinutes:number|null;diskHealthIntervalMinutes:number|null},now:Date):boolean{
 const disk=(DISK_TIER_SOURCES as readonly string[]).includes(c.source);
 const interval=disk?(health.diskHealthIntervalMinutes??60):(health.pollIntervalMinutes??10);
 return now.getTime()-c.lastSeenAt.getTime()<=3*interval*60_000;
}
