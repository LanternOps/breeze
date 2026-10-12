/**
 * Container image currency monitor handler (workload inventory W06, #8195,
 * spec §10.2).
 *
 * Server-evaluated from what the image-currency pass stored on the device's
 * own `device_workloads` rows — no agent round trip. One subject per image
 * `repository:tag` on the device; replicas (and the same image under several
 * runtimes) collapse into one subject, worst status first:
 *
 *   - any replica `behind`  → `breaching` once the OLDEST `behind_since` is at
 *     least `minDaysBehind` days old, otherwise `unknown` (behind, but not for
 *     long enough — it must not read as recovered either);
 *   - else any replica unknown-class or `not_found` → `unknown`;
 *   - else every replica `current` → `recovered`.
 *
 * `pinned` and `local` images have no registry tag to compare with, so they
 * produce no subject at all (not a coverage gap, nothing to monitor).
 */
import { and, eq, isNotNull } from 'drizzle-orm';
import { monitorConditionSchemas, workloadUpstreamStatusClass, type WorkloadUpstreamStatus } from '@breeze/shared';
import { db } from '../../../db';
import { deviceWorkloads } from '../../../db/schema';
import type { ConditionHandler } from '../registry';
import type { SubjectEvidence, SubjectStatus } from '../types';

const DAY_MS = 86_400_000;

/** The subject key of an image; also what ingest retirement resolves by. */
export function containerImageSubjectKey(repository: string, tag: string): string {
  return `${repository}:${tag}`;
}

interface ImageAggregate {
  repository: string;
  tag: string;
  statuses: Set<WorkloadUpstreamStatus>;
  oldestBehindSince: Date | null;
  behindUnstamped: boolean;
}

export const containerImageCurrencyHandler: ConditionHandler = {
  type: 'container_image_currency',
  async evaluate(condition, deviceId) {
    const { type: _type, ...rest } = condition as Record<string, unknown>;
    const cond = monitorConditionSchemas.container_image_currency.parse(rest);
    const rows = await db
      .select({
        imageRepository: deviceWorkloads.imageRepository,
        imageTag: deviceWorkloads.imageTag,
        upstreamStatus: deviceWorkloads.upstreamStatus,
        behindSince: deviceWorkloads.behindSince,
      })
      .from(deviceWorkloads)
      .where(and(
        eq(deviceWorkloads.deviceId, deviceId),
        eq(deviceWorkloads.kind, 'container'),
        isNotNull(deviceWorkloads.imageRepository),
        isNotNull(deviceWorkloads.imageTag),
      ));

    const images = new Map<string, ImageAggregate>();
    for (const row of rows) {
      if (!row.imageRepository || !row.imageTag) continue;
      if (workloadUpstreamStatusClass(row.upstreamStatus) === 'not_applicable' && row.upstreamStatus !== 'not_found') continue;
      const key = containerImageSubjectKey(row.imageRepository, row.imageTag);
      const agg = images.get(key) ?? {
        repository: row.imageRepository, tag: row.imageTag, statuses: new Set(), oldestBehindSince: null, behindUnstamped: false,
      };
      agg.statuses.add(row.upstreamStatus);
      if (row.upstreamStatus === 'behind') {
        if (!row.behindSince) agg.behindUnstamped = true;
        else if (!agg.oldestBehindSince || row.behindSince < agg.oldestBehindSince) agg.oldestBehindSince = row.behindSince;
      }
      images.set(key, agg);
    }

    const now = Date.now();
    const subjects: SubjectEvidence[] = [...images.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, agg]) => {
        let status: SubjectStatus = 'unknown';
        let upstreamStatus: WorkloadUpstreamStatus;
        let daysBehind: number | null = null;
        if (agg.statuses.has('behind')) {
          upstreamStatus = 'behind';
          if (agg.oldestBehindSince) {
            const ageMs = now - agg.oldestBehindSince.getTime();
            daysBehind = Math.floor(ageMs / DAY_MS);
            if (ageMs >= cond.minDaysBehind * DAY_MS) status = 'breaching';
          }
        } else if ([...agg.statuses].every((s) => s === 'current')) {
          upstreamStatus = 'current';
          status = 'recovered';
        } else {
          upstreamStatus = [...agg.statuses].find((s) => s !== 'current')!;
        }
        const description = status === 'breaching'
          ? `${key} has been behind its registry tag for ${daysBehind} days`
          : `${key} is ${upstreamStatus.replaceAll('_', ' ')}`;
        return {
          subjectKey: key,
          status,
          description,
          actualValue: daysBehind ?? undefined,
          context: {
            source: 'container_image_currency',
            subjectKey: key,
            imageRef: key,
            imageRepository: agg.repository,
            imageTag: agg.tag,
            upstreamStatus,
            daysBehind,
            behindSince: agg.oldestBehindSince?.toISOString() ?? null,
          },
        };
      });

    const count = (status: SubjectStatus) => subjects.filter((s) => s.status === status).length;
    return {
      passed: count('breaching') > 0,
      dataAvailable: subjects.length > 0,
      subjects,
      description: `${count('breaching')} breaching, ${count('recovered')} recovered, ${count('unknown')} unknown container images`,
    };
  },
  validate(condition, path) {
    const { type: _type, ...rest } = (condition ?? {}) as Record<string, unknown>;
    const result = monitorConditionSchemas.container_image_currency.safeParse(rest);
    return result.success ? [] : result.error.issues.map((i) => `${path}.${i.path.join('.')}: ${i.message}`);
  },
};
