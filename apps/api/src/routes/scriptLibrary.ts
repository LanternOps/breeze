import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { authMiddleware, requireScope } from '../middleware/auth';

export const scriptLibraryRoutes = new Hono();

type OsType = 'windows' | 'macos' | 'linux';
type ScriptLanguage = 'powershell' | 'bash' | 'python' | 'cmd';

type ScriptCategory = {
  id: string;
  name: string;
  description?: string;
  color?: string;
  createdAt: Date;
  updatedAt: Date;
};

type ScriptTag = {
  id: string;
  name: string;
  createdAt: Date;
  updatedAt: Date;
};

type ScriptTemplate = {
  id: string;
  name: string;
  description?: string;
  categoryId: string | null;
  tags: string[];
  language: ScriptLanguage;
  osTypes: OsType[];
  content: string;
  createdAt: Date;
  updatedAt: Date;
};

type ScriptRecord = {
  id: string;
  name: string;
  description?: string;
  categoryId: string | null;
  tags: string[];
  language: ScriptLanguage;
  osTypes: OsType[];
  content: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

type ScriptVersion = {
  id: string;
  scriptId: string;
  version: number;
  content: string;
  createdAt: Date;
  createdBy: string;
  note?: string;
};

type ScriptUsageStats = {
  scriptId: string;
  totalRuns: number;
  successCount: number;
  failureCount: number;
  averageDurationSeconds: number;
  lastRunAt: Date | null;
  lastRunStatus: 'success' | 'failed' | 'running' | 'queued' | 'cancelled' | null;
  recentRuns: Array<{
    id: string;
    executedAt: Date;
    status: 'success' | 'failed' | 'running' | 'queued' | 'cancelled';
    durationSeconds: number;
  }>;
};

// ============================================
// MOCK DATA
// ============================================

const now = new Date();
const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
const lastWeek = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

const maintenanceCategoryId = randomUUID();
const securityCategoryId = randomUUID();
const onboardingCategoryId = randomUUID();

const cleanupTagId = randomUUID();
const complianceTagId = randomUUID();
const onboardingTagId = randomUUID();

const categories = new Map<string, ScriptCategory>([
  [maintenanceCategoryId, {
    id: maintenanceCategoryId,
    name: 'Maintenance',
    description: 'Routine cleanup and upkeep scripts',
    color: '#E9C46A',
    createdAt: lastWeek,
    updatedAt: lastWeek
  }],
  [securityCategoryId, {
    id: securityCategoryId,
    name: 'Security',
    description: 'Security hardening and compliance checks',
    color: '#264653',
    createdAt: lastWeek,
    updatedAt: lastWeek
  }],
  [onboardingCategoryId, {
    id: onboardingCategoryId,
    name: 'Onboarding',
    description: 'First-run setup and configuration',
    color: '#2A9D8F',
    createdAt: lastWeek,
    updatedAt: lastWeek
  }]
]);

const tags = new Map<string, ScriptTag>([
  [cleanupTagId, {
    id: cleanupTagId,
    name: 'cleanup',
    createdAt: lastWeek,
    updatedAt: lastWeek
  }],
  [complianceTagId, {
    id: complianceTagId,
    name: 'compliance',
    createdAt: lastWeek,
    updatedAt: lastWeek
  }],
  [onboardingTagId, {
    id: onboardingTagId,
    name: 'onboarding',
    createdAt: lastWeek,
    updatedAt: lastWeek
  }]
]);

const tempCleanupTemplateId = randomUUID();
const baselineTemplateId = randomUUID();
const onboardingTemplateId = randomUUID();

const templates = new Map<string, ScriptTemplate>([
  [tempCleanupTemplateId, {
    id: tempCleanupTemplateId,
    name: 'Clean Temp Files',
    description: 'Remove OS temp directories and stale cache entries',
    categoryId: maintenanceCategoryId,
    tags: [cleanupTagId],
    language: 'powershell',
    osTypes: ['windows'],
    content: [
      'Write-Host "Cleaning temp files..."',
      '$paths = @($env:TEMP, "C:\\Windows\\Temp")',
      'foreach ($path in $paths) {',
      '  if (Test-Path $path) {',
      '    Get-ChildItem -Path $path -Recurse -Force | Remove-Item -Force -Recurse -ErrorAction SilentlyContinue',
      '  }',
      '}',
      'Write-Host "Cleanup complete."'
    ].join('\n'),
    createdAt: lastWeek,
    updatedAt: lastWeek
  }],
  [baselineTemplateId, {
    id: baselineTemplateId,
    name: 'Security Baseline Check',
    description: 'Validate baseline settings and export a summary report',
    categoryId: securityCategoryId,
    tags: [complianceTagId],
    language: 'bash',
    osTypes: ['linux', 'macos'],
    content: [
      'echo "Running baseline checks..."',
      'uname -a',
      'id',
      'echo "Baseline checks complete."'
    ].join('\n'),
    createdAt: lastWeek,
    updatedAt: lastWeek
  }],
  [onboardingTemplateId, {
    id: onboardingTemplateId,
    name: 'Developer Onboarding',
    description: 'Provision tooling and local preferences',
    categoryId: onboardingCategoryId,
    tags: [onboardingTagId],
    language: 'python',
    osTypes: ['windows', 'macos', 'linux'],
    content: [
      'import os',
      'print("Setting up developer tools...")',
      'print("Onboarding complete.")'
    ].join('\n'),
    createdAt: lastWeek,
    updatedAt: lastWeek
  }]
]);

const weeklyCleanupScriptId = randomUUID();
const baselineScriptId = randomUUID();

const scripts = new Map<string, ScriptRecord>([
  [weeklyCleanupScriptId, {
    id: weeklyCleanupScriptId,
    name: 'Weekly Cleanup',
    description: 'Removes temp files weekly for Windows endpoints',
    categoryId: maintenanceCategoryId,
    tags: [cleanupTagId],
    language: 'powershell',
    osTypes: ['windows'],
    content: [
      'Write-Host "Starting weekly cleanup..."',
      'Get-ChildItem -Path $env:TEMP -Recurse -Force | Remove-Item -Force -Recurse -ErrorAction SilentlyContinue',
      'Write-Host "Weekly cleanup complete."'
    ].join('\n'),
    version: 3,
    createdAt: lastWeek,
    updatedAt: yesterday
  }],
  [baselineScriptId, {
    id: baselineScriptId,
    name: 'Baseline Report',
    description: 'Collects baseline metadata for audit review',
    categoryId: securityCategoryId,
    tags: [complianceTagId],
    language: 'bash',
    osTypes: ['linux', 'macos'],
    content: [
      'echo "Collecting baseline data..."',
      'uptime',
      'df -h',
      'echo "Baseline report ready."'
    ].join('\n'),
    version: 1,
    createdAt: lastWeek,
    updatedAt: lastWeek
  }]
]);

const versionsByScriptId = new Map<string, ScriptVersion[]>([
  [weeklyCleanupScriptId, [
    {
      id: randomUUID(),
      scriptId: weeklyCleanupScriptId,
      version: 1,
      content: 'Write-Host "Cleanup v1"\nGet-ChildItem -Path $env:TEMP | Remove-Item -Force',
      createdAt: lastWeek,
      createdBy: 'system',
      note: 'Initial draft'
    },
    {
      id: randomUUID(),
      scriptId: weeklyCleanupScriptId,
      version: 2,
      content: [
        'Write-Host "Cleanup v2"',
        'Get-ChildItem -Path $env:TEMP -Recurse -Force | Remove-Item -Force -Recurse -ErrorAction SilentlyContinue'
      ].join('\n'),
      createdAt: yesterday,
      createdBy: 'system',
      note: 'Added recursive cleanup'
    }
  ]]
]);

const usageStats = new Map<string, ScriptUsageStats>([
  [weeklyCleanupScriptId, {
    scriptId: weeklyCleanupScriptId,
    totalRuns: 128,
    successCount: 121,
    failureCount: 7,
    averageDurationSeconds: 43,
    lastRunAt: new Date(now.getTime() - 2 * 60 * 60 * 1000),
    lastRunStatus: 'success',
    recentRuns: [
      {
        id: randomUUID(),
        executedAt: new Date(now.getTime() - 2 * 60 * 60 * 1000),
        status: 'success',
        durationSeconds: 41
      },
      {
        id: randomUUID(),
        executedAt: new Date(now.getTime() - 26 * 60 * 60 * 1000),
        status: 'failed',
        durationSeconds: 18
      }
    ]
  }]
]);

// ============================================
// VALIDATION SCHEMAS
// ============================================

const createCategorySchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  color: z.string().max(20).optional()
});

const updateCategorySchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional(),
  color: z.string().max(20).optional()
});

const createTagSchema = z.object({
  name: z.string().min(1).max(50)
});

const createVersionSchema = z.object({
  content: z.string().min(1),
  note: z.string().max(200).optional()
});

const listTemplatesSchema = z.object({
  categoryId: z.string().optional(),
  category: z.string().optional()
});

const createFromTemplateSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  categoryId: z.string().optional(),
  tags: z.array(z.string().min(1)).optional()
});

// ============================================
// HELPERS
// ============================================

function getCategoryList() {
  return [...categories.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function getTagList() {
  return [...tags.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function getTemplateList() {
  return [...templates.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function getVersionHistory(scriptId: string) {
  const versions = versionsByScriptId.get(scriptId) ?? [];
  return [...versions].sort((a, b) => b.version - a.version);
}

function getUsageStats(scriptId: string): ScriptUsageStats {
  return usageStats.get(scriptId) ?? {
    scriptId,
    totalRuns: 0,
    successCount: 0,
    failureCount: 0,
    averageDurationSeconds: 0,
    lastRunAt: null,
    lastRunStatus: null,
    recentRuns: []
  };
}

function findCategoryIdByName(name: string) {
  const normalized = name.trim().toLowerCase();
  for (const category of categories.values()) {
    if (category.name.toLowerCase() === normalized) {
      return category.id;
    }
  }
  return null;
}

scriptLibraryRoutes.use('*', authMiddleware);

// ============================================
// CATEGORIES
// ============================================

scriptLibraryRoutes.get(
  '/categories',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    try {
      return c.json({ data: getCategoryList() });
    } catch {
      return c.json({ error: 'Failed to list categories' }, 500);
    }
  }
);

scriptLibraryRoutes.post(
  '/categories',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', createCategorySchema),
  async (c) => {
    try {
      const data = c.req.valid('json');
      const name = data.name.trim();

      const duplicate = [...categories.values()].some(
        (category) => category.name.toLowerCase() === name.toLowerCase()
      );
      if (duplicate) {
        return c.json({ error: 'Category name already exists' }, 409);
      }

      const category: ScriptCategory = {
        id: randomUUID(),
        name,
        description: data.description,
        color: data.color,
        createdAt: new Date(),
        updatedAt: new Date()
      };

      categories.set(category.id, category);
      return c.json(category, 201);
    } catch {
      return c.json({ error: 'Failed to create category' }, 500);
    }
  }
);

scriptLibraryRoutes.get(
  '/categories/:id',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    try {
      const id = c.req.param('id');
      const category = categories.get(id);

      if (!category) {
        return c.json({ error: 'Category not found' }, 404);
      }

      return c.json(category);
    } catch {
      return c.json({ error: 'Failed to fetch category' }, 500);
    }
  }
);

scriptLibraryRoutes.patch(
  '/categories/:id',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', updateCategorySchema),
  async (c) => {
    try {
      const id = c.req.param('id');
      const data = c.req.valid('json');

      if (Object.keys(data).length === 0) {
        return c.json({ error: 'No updates provided' }, 400);
      }

      const category = categories.get(id);
      if (!category) {
        return c.json({ error: 'Category not found' }, 404);
      }

      if (data.name) {
        const name = data.name.trim();
        const duplicate = [...categories.values()].some(
          (entry) => entry.id !== id && entry.name.toLowerCase() === name.toLowerCase()
        );
        if (duplicate) {
          return c.json({ error: 'Category name already exists' }, 409);
        }
        category.name = name;
      }

      if (data.description !== undefined) {
        category.description = data.description;
      }

      if (data.color !== undefined) {
        category.color = data.color;
      }

      category.updatedAt = new Date();
      categories.set(id, category);

      return c.json(category);
    } catch {
      return c.json({ error: 'Failed to update category' }, 500);
    }
  }
);

scriptLibraryRoutes.delete(
  '/categories/:id',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    try {
      const id = c.req.param('id');
      const category = categories.get(id);

      if (!category) {
        return c.json({ error: 'Category not found' }, 404);
      }

      categories.delete(id);

      for (const template of templates.values()) {
        if (template.categoryId === id) {
          template.categoryId = null;
          template.updatedAt = new Date();
        }
      }

      for (const script of scripts.values()) {
        if (script.categoryId === id) {
          script.categoryId = null;
          script.updatedAt = new Date();
        }
      }

      return c.json({ success: true });
    } catch {
      return c.json({ error: 'Failed to delete category' }, 500);
    }
  }
);

// ============================================
// TAGS
// ============================================

scriptLibraryRoutes.get(
  '/tags',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    try {
      return c.json({ data: getTagList() });
    } catch {
      return c.json({ error: 'Failed to list tags' }, 500);
    }
  }
);

scriptLibraryRoutes.post(
  '/tags',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', createTagSchema),
  async (c) => {
    try {
      const data = c.req.valid('json');
      const name = data.name.trim();

      const duplicate = [...tags.values()].some(
        (tag) => tag.name.toLowerCase() === name.toLowerCase()
      );
      if (duplicate) {
        return c.json({ error: 'Tag name already exists' }, 409);
      }

      const tag: ScriptTag = {
        id: randomUUID(),
        name,
        createdAt: new Date(),
        updatedAt: new Date()
      };

      tags.set(tag.id, tag);
      return c.json(tag, 201);
    } catch {
      return c.json({ error: 'Failed to create tag' }, 500);
    }
  }
);

scriptLibraryRoutes.delete(
  '/tags/:id',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    try {
      const id = c.req.param('id');
      const tag = tags.get(id);

      if (!tag) {
        return c.json({ error: 'Tag not found' }, 404);
      }

      tags.delete(id);

      for (const template of templates.values()) {
        if (template.tags.includes(id)) {
          template.tags = template.tags.filter((tagId) => tagId !== id);
          template.updatedAt = new Date();
        }
      }

      for (const script of scripts.values()) {
        if (script.tags.includes(id)) {
          script.tags = script.tags.filter((tagId) => tagId !== id);
          script.updatedAt = new Date();
        }
      }

      return c.json({ success: true });
    } catch {
      return c.json({ error: 'Failed to delete tag' }, 500);
    }
  }
);

// ============================================
// SCRIPT VERSIONS
// ============================================

scriptLibraryRoutes.get(
  '/scripts/:id/versions',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    try {
      const scriptId = c.req.param('id');
      const script = scripts.get(scriptId);

      if (!script) {
        return c.json({ error: 'Script not found' }, 404);
      }

      return c.json({ data: getVersionHistory(scriptId) });
    } catch {
      return c.json({ error: 'Failed to fetch version history' }, 500);
    }
  }
);

scriptLibraryRoutes.post(
  '/scripts/:id/versions',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', createVersionSchema),
  async (c) => {
    try {
      const scriptId = c.req.param('id');
      const data = c.req.valid('json');
      const script = scripts.get(scriptId);

      if (!script) {
        return c.json({ error: 'Script not found' }, 404);
      }

      const auth = c.get('auth');
      const createdBy = auth?.user?.id ?? 'system';
      const versionEntry: ScriptVersion = {
        id: randomUUID(),
        scriptId,
        version: script.version,
        content: script.content,
        createdAt: new Date(),
        createdBy,
        note: data.note
      };

      const versions = versionsByScriptId.get(scriptId) ?? [];
      versions.push(versionEntry);
      versionsByScriptId.set(scriptId, versions);

      script.content = data.content;
      script.version += 1;
      script.updatedAt = new Date();
      scripts.set(scriptId, script);

      return c.json({ script, version: versionEntry }, 201);
    } catch {
      return c.json({ error: 'Failed to create version' }, 500);
    }
  }
);

scriptLibraryRoutes.post(
  '/scripts/:id/rollback/:versionId',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    try {
      const scriptId = c.req.param('id');
      const versionId = c.req.param('versionId');
      const script = scripts.get(scriptId);

      if (!script) {
        return c.json({ error: 'Script not found' }, 404);
      }

      const versions = versionsByScriptId.get(scriptId) ?? [];
      const targetVersion = versions.find((entry) => entry.id === versionId);

      if (!targetVersion) {
        return c.json({ error: 'Version not found' }, 404);
      }

      const auth = c.get('auth');
      const createdBy = auth?.user?.id ?? 'system';
      const snapshot: ScriptVersion = {
        id: randomUUID(),
        scriptId,
        version: script.version,
        content: script.content,
        createdAt: new Date(),
        createdBy,
        note: `Rollback snapshot from version ${targetVersion.version}`
      };

      versions.push(snapshot);
      versionsByScriptId.set(scriptId, versions);

      script.content = targetVersion.content;
      script.version += 1;
      script.updatedAt = new Date();
      scripts.set(scriptId, script);

      return c.json({ script, rolledBackFrom: targetVersion, snapshot });
    } catch {
      return c.json({ error: 'Failed to rollback version' }, 500);
    }
  }
);

// ============================================
// TEMPLATES
// ============================================

scriptLibraryRoutes.get(
  '/templates',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', listTemplatesSchema),
  async (c) => {
    try {
      const query = c.req.valid('query');
      let data = getTemplateList();

      const categoryId = query.categoryId ?? (query.category ? findCategoryIdByName(query.category) : null);
      if (categoryId) {
        data = data.filter((template) => template.categoryId === categoryId);
      }

      return c.json({ data });
    } catch {
      return c.json({ error: 'Failed to list templates' }, 500);
    }
  }
);

scriptLibraryRoutes.post(
  '/from-template/:templateId',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', createFromTemplateSchema),
  async (c) => {
    try {
      const templateId = c.req.param('templateId');
      const template = templates.get(templateId);

      if (!template) {
        return c.json({ error: 'Template not found' }, 404);
      }

      const data = c.req.valid('json');
      const script: ScriptRecord = {
        id: randomUUID(),
        name: data.name.trim(),
        description: data.description ?? template.description,
        categoryId: data.categoryId ?? template.categoryId,
        tags: data.tags ?? [...template.tags],
        language: template.language,
        osTypes: [...template.osTypes],
        content: template.content,
        version: 1,
        createdAt: new Date(),
        updatedAt: new Date()
      };

      scripts.set(script.id, script);
      versionsByScriptId.set(script.id, []);

      return c.json({ ...script, sourceTemplateId: templateId }, 201);
    } catch {
      return c.json({ error: 'Failed to create script from template' }, 500);
    }
  }
);

// ============================================
// USAGE STATS
// ============================================

scriptLibraryRoutes.get(
  '/scripts/:id/usage-stats',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    try {
      const scriptId = c.req.param('id');
      const script = scripts.get(scriptId);

      if (!script) {
        return c.json({ error: 'Script not found' }, 404);
      }

      return c.json({ data: getUsageStats(scriptId) });
    } catch {
      return c.json({ error: 'Failed to fetch usage stats' }, 500);
    }
  }
);
