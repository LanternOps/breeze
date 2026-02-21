import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db';
import {
  playbookDefinitions,
  type PlaybookStep,
  type PlaybookTriggerConditions,
} from '../db/schema';

type BuiltInPlaybook = {
  name: string;
  description: string;
  category: 'disk' | 'service' | 'memory';
  steps: PlaybookStep[];
  triggerConditions?: PlaybookTriggerConditions;
  requiredPermissions: string[];
};

const BUILT_IN_PLAYBOOKS: BuiltInPlaybook[] = [
  {
    name: 'Disk Cleanup',
    description: 'Free up disk space with a preview + execute + verify workflow.',
    category: 'disk',
    requiredPermissions: ['devices:read', 'devices:execute'],
    steps: [
      {
        type: 'diagnose',
        name: 'Capture baseline disk usage',
        description: 'Collect latest disk usage and cleanup candidate metrics.',
        tool: 'analyze_disk_usage',
        toolInput: {
          deviceId: '{{deviceId}}',
          refresh: true,
        },
      },
      {
        type: 'act',
        name: 'Preview safe cleanup candidates',
        description: 'Preview candidate files by safe categories before deletion.',
        tool: 'disk_cleanup',
        toolInput: {
          deviceId: '{{deviceId}}',
          action: 'preview',
          categories: ['temp_files', 'browser_cache', 'package_cache', 'trash'],
        },
      },
      {
        type: 'act',
        name: 'Execute cleanup',
        description: 'Delete selected cleanup candidates from the latest preview.',
        tool: 'disk_cleanup',
        toolInput: {
          deviceId: '{{deviceId}}',
          action: 'execute',
          paths: '{{cleanupPaths}}',
        },
      },
      {
        type: 'wait',
        name: 'Wait for filesystem metrics to settle',
        description: 'Allow time for disk metrics to refresh after cleanup.',
        waitSeconds: 30,
      },
      {
        type: 'verify',
        name: 'Verify post-cleanup disk usage',
        description: 'Confirm disk usage improved compared to baseline.',
        tool: 'analyze_disk_usage',
        toolInput: {
          deviceId: '{{deviceId}}',
          refresh: true,
        },
        verifyCondition: {
          metric: 'disk_usage_percent',
          operator: 'lt',
          value: 90,
        },
        onFailure: 'stop',
      },
    ],
  },
  {
    name: 'Service Restart with Health Check',
    description: 'Restart a service, wait for stabilization, and verify it is running.',
    category: 'service',
    requiredPermissions: ['devices:read', 'devices:execute'],
    triggerConditions: {
      alertTypes: ['service_down'],
      autoExecute: false,
    },
    steps: [
      {
        type: 'diagnose',
        name: 'Check current service status',
        description: 'Read service status before remediation.',
        tool: 'manage_services',
        toolInput: {
          deviceId: '{{deviceId}}',
          action: 'list',
          serviceName: '{{serviceName}}',
        },
      },
      {
        type: 'act',
        name: 'Restart target service',
        description: 'Restart the target service to recover from failure.',
        tool: 'manage_services',
        toolInput: {
          deviceId: '{{deviceId}}',
          action: 'restart',
          serviceName: '{{serviceName}}',
        },
      },
      {
        type: 'wait',
        name: 'Wait for service startup',
        description: 'Give the service enough time to initialize.',
        waitSeconds: 10,
      },
      {
        type: 'verify',
        name: 'Verify service health',
        description: 'Ensure the service reports running after restart.',
        tool: 'manage_services',
        toolInput: {
          deviceId: '{{deviceId}}',
          action: 'list',
          serviceName: '{{serviceName}}',
        },
        verifyCondition: {
          metric: 'service_status',
          operator: 'eq',
          value: 'running',
        },
        onFailure: 'stop',
      },
    ],
  },
  {
    name: 'Memory Pressure Relief',
    description: 'Collect baseline RAM metrics, restart target service, then verify memory improvement.',
    category: 'memory',
    requiredPermissions: ['devices:read', 'devices:execute'],
    steps: [
      {
        type: 'diagnose',
        name: 'Capture baseline memory metrics',
        description: 'Check memory trend and current utilization before remediation.',
        tool: 'analyze_metrics',
        toolInput: {
          deviceId: '{{deviceId}}',
          metric: 'ram',
          hoursBack: 1,
        },
      },
      {
        type: 'act',
        name: 'Restart memory-heavy service',
        description: 'Restart the service believed to be causing memory pressure.',
        tool: 'manage_services',
        toolInput: {
          deviceId: '{{deviceId}}',
          action: 'restart',
          serviceName: '{{serviceName}}',
        },
      },
      {
        type: 'wait',
        name: 'Wait for memory stabilization',
        description: 'Allow enough time for memory to stabilize after restart.',
        waitSeconds: 300,
      },
      {
        type: 'verify',
        name: 'Verify memory improved',
        description: 'Confirm memory usage moved below target threshold.',
        tool: 'analyze_metrics',
        toolInput: {
          deviceId: '{{deviceId}}',
          metric: 'ram',
          hoursBack: 1,
        },
        verifyCondition: {
          metric: 'ram_usage_percent',
          operator: 'lt',
          value: 85,
        },
        onFailure: 'stop',
      },
    ],
  },
];

async function fallbackEnsureBuiltIn(playbook: BuiltInPlaybook): Promise<void> {
  console.warn(`[startup] Using fallback seeder for "${playbook.name}" (unique constraint missing)`);
  const [existing] = await db
    .select({ id: playbookDefinitions.id })
    .from(playbookDefinitions)
    .where(and(
      eq(playbookDefinitions.isBuiltIn, true),
      eq(playbookDefinitions.name, playbook.name),
    ))
    .limit(1);

  if (existing) {
    await db
      .update(playbookDefinitions)
      .set({
        description: playbook.description,
        category: playbook.category,
        steps: playbook.steps,
        triggerConditions: playbook.triggerConditions ?? null,
        requiredPermissions: playbook.requiredPermissions,
        isActive: true,
        updatedAt: new Date(),
      })
      .where(eq(playbookDefinitions.id, existing.id));
    return;
  }

  await db.insert(playbookDefinitions).values({
    orgId: null,
    name: playbook.name,
    description: playbook.description,
    category: playbook.category,
    steps: playbook.steps,
    triggerConditions: playbook.triggerConditions ?? null,
    requiredPermissions: playbook.requiredPermissions,
    isBuiltIn: true,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

export async function seedBuiltInPlaybooks(): Promise<void> {
  const builtinScopeKey = '00000000-0000-0000-0000-000000000000';
  let primaryCount = 0;
  let fallbackCount = 0;

  for (const playbook of BUILT_IN_PLAYBOOKS) {
    try {
      await db.execute(sql`
        INSERT INTO playbook_definitions (
          org_id,
          name,
          description,
          steps,
          trigger_conditions,
          is_built_in,
          is_active,
          category,
          required_permissions,
          created_at,
          updated_at
        )
        VALUES (
          NULL,
          ${playbook.name},
          ${playbook.description},
          ${JSON.stringify(playbook.steps)}::jsonb,
          ${playbook.triggerConditions ? JSON.stringify(playbook.triggerConditions) : null}::jsonb,
          true,
          true,
          ${playbook.category},
          ${JSON.stringify(playbook.requiredPermissions)}::jsonb,
          NOW(),
          NOW()
        )
        ON CONFLICT ((COALESCE(org_id, ${builtinScopeKey}::uuid)), lower(name))
        DO UPDATE SET
          description = EXCLUDED.description,
          steps = EXCLUDED.steps,
          trigger_conditions = EXCLUDED.trigger_conditions,
          is_built_in = true,
          is_active = true,
          category = EXCLUDED.category,
          required_permissions = EXCLUDED.required_permissions,
          updated_at = NOW()
      `);
      primaryCount += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('no unique or exclusion constraint matching the ON CONFLICT specification')) {
        await fallbackEnsureBuiltIn(playbook);
        fallbackCount += 1;
      } else {
        throw error;
      }
    }
  }

  console.log(`[startup] Built-in playbooks ensured: ${primaryCount} via upsert, ${fallbackCount} via fallback`);
}
