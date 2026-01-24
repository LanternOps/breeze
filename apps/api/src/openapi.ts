/**
 * Breeze RMM API - OpenAPI 3.0 Specification
 *
 * This file defines the complete API documentation for the Breeze RMM platform.
 * Documentation is served via Swagger UI at /api/v1/docs
 */

export const openApiSpec = {
  openapi: '3.0.3',
  info: {
    title: 'Breeze RMM API',
    description: `
Breeze is a fast, modern Remote Monitoring and Management (RMM) platform for MSPs and internal IT teams.

## Authentication

The API supports two authentication methods:

- **Bearer Token (JWT)**: Include the token in the \`Authorization\` header as \`Bearer <token>\`
- **API Key**: Include the API key in the \`X-API-Key\` header

## Multi-Tenant Architecture

Breeze uses a hierarchical multi-tenant model:

\`\`\`
Partner (MSP) → Organization (Customer) → Site (Location) → Device Group → Device
\`\`\`

API access is scoped based on your authentication context:
- **System scope**: Full access to all resources
- **Partner scope**: Access to all organizations under the partner
- **Organization scope**: Access to resources within the organization

## Rate Limiting

API requests are rate-limited to ensure fair usage. Rate limit headers are included in responses:
- \`X-RateLimit-Limit\`: Maximum requests per window
- \`X-RateLimit-Remaining\`: Remaining requests in current window
- \`X-RateLimit-Reset\`: Unix timestamp when the window resets
    `,
    version: '1.0.0',
    contact: {
      name: 'Breeze RMM Support',
      email: 'support@breezermm.com'
    },
    license: {
      name: 'Proprietary',
      url: 'https://breezermm.com/license'
    }
  },
  servers: [
    {
      url: '/api/v1',
      description: 'Current API version'
    }
  ],
  tags: [
    { name: 'Auth', description: 'Authentication and authorization' },
    { name: 'Users', description: 'User management and invitations' },
    { name: 'Organizations', description: 'Partners, organizations, and sites management' },
    { name: 'Devices', description: 'Device management and monitoring' },
    { name: 'Scripts', description: 'Script library and execution' },
    { name: 'Alerts', description: 'Alert rules, alerts, and notifications' },
    { name: 'Automations', description: 'Automation workflows and policies' },
    { name: 'Reports', description: 'Reporting and data exports' },
    { name: 'Remote', description: 'Remote access sessions and file transfers' },
    { name: 'Agents', description: 'Agent enrollment and communication' },
    { name: 'Audit', description: 'Audit logging and activity tracking' }
  ],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'JWT access token obtained from /auth/login'
      },
      apiKeyAuth: {
        type: 'apiKey',
        in: 'header',
        name: 'X-API-Key',
        description: 'API key for service-to-service authentication'
      }
    },
    schemas: {
      // Common schemas
      Pagination: {
        type: 'object',
        properties: {
          page: { type: 'integer', example: 1 },
          limit: { type: 'integer', example: 50 },
          total: { type: 'integer', example: 100 }
        }
      },
      Error: {
        type: 'object',
        properties: {
          error: { type: 'string', description: 'Error message' },
          message: { type: 'string', description: 'Detailed error message' }
        },
        required: ['error']
      },
      Success: {
        type: 'object',
        properties: {
          success: { type: 'boolean', example: true }
        }
      },

      // Auth schemas
      LoginRequest: {
        type: 'object',
        properties: {
          email: { type: 'string', format: 'email', example: 'user@example.com' },
          password: { type: 'string', minLength: 1 }
        },
        required: ['email', 'password']
      },
      LoginResponse: {
        type: 'object',
        properties: {
          user: { $ref: '#/components/schemas/User' },
          tokens: { $ref: '#/components/schemas/Tokens' },
          mfaRequired: { type: 'boolean' },
          tempToken: { type: 'string', description: 'Temporary token for MFA verification' }
        }
      },
      RegisterRequest: {
        type: 'object',
        properties: {
          email: { type: 'string', format: 'email' },
          password: { type: 'string', minLength: 8 },
          name: { type: 'string', minLength: 1, maxLength: 255 }
        },
        required: ['email', 'password', 'name']
      },
      Tokens: {
        type: 'object',
        properties: {
          accessToken: { type: 'string' },
          refreshToken: { type: 'string' },
          expiresIn: { type: 'integer', example: 900 }
        }
      },
      MfaSetupResponse: {
        type: 'object',
        properties: {
          secret: { type: 'string' },
          otpAuthUrl: { type: 'string' },
          qrCodeDataUrl: { type: 'string' },
          recoveryCodes: { type: 'array', items: { type: 'string' } }
        }
      },

      // User schemas
      User: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          email: { type: 'string', format: 'email' },
          name: { type: 'string' },
          avatarUrl: { type: 'string', nullable: true },
          mfaEnabled: { type: 'boolean' },
          status: { type: 'string', enum: ['active', 'invited', 'disabled'] },
          lastLoginAt: { type: 'string', format: 'date-time', nullable: true },
          createdAt: { type: 'string', format: 'date-time' }
        }
      },
      InviteUserRequest: {
        type: 'object',
        properties: {
          email: { type: 'string', format: 'email' },
          name: { type: 'string', minLength: 1, maxLength: 255 },
          roleId: { type: 'string', format: 'uuid' },
          orgAccess: { type: 'string', enum: ['all', 'selected', 'none'] },
          orgIds: { type: 'array', items: { type: 'string', format: 'uuid' } },
          siteIds: { type: 'array', items: { type: 'string', format: 'uuid' } },
          deviceGroupIds: { type: 'array', items: { type: 'string', format: 'uuid' } }
        },
        required: ['email', 'name', 'roleId']
      },
      Role: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          name: { type: 'string' },
          description: { type: 'string', nullable: true },
          scope: { type: 'string', enum: ['partner', 'organization'] },
          isSystem: { type: 'boolean' }
        }
      },

      // Organization schemas
      Partner: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          name: { type: 'string' },
          slug: { type: 'string' },
          type: { type: 'string', enum: ['msp', 'enterprise', 'internal'] },
          plan: { type: 'string', enum: ['free', 'pro', 'enterprise', 'unlimited'] },
          maxOrganizations: { type: 'integer', nullable: true },
          maxDevices: { type: 'integer', nullable: true },
          billingEmail: { type: 'string', format: 'email', nullable: true },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' }
        }
      },
      Organization: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          partnerId: { type: 'string', format: 'uuid' },
          name: { type: 'string' },
          slug: { type: 'string' },
          type: { type: 'string', enum: ['customer', 'internal'] },
          status: { type: 'string', enum: ['active', 'suspended', 'trial', 'churned'] },
          maxDevices: { type: 'integer', nullable: true },
          contractStart: { type: 'string', format: 'date-time', nullable: true },
          contractEnd: { type: 'string', format: 'date-time', nullable: true },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' }
        }
      },
      Site: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          orgId: { type: 'string', format: 'uuid' },
          name: { type: 'string' },
          timezone: { type: 'string', example: 'America/New_York' },
          address: { type: 'object', nullable: true },
          contact: { type: 'object', nullable: true },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' }
        }
      },

      // Device schemas
      Device: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          orgId: { type: 'string', format: 'uuid' },
          siteId: { type: 'string', format: 'uuid' },
          agentId: { type: 'string' },
          hostname: { type: 'string' },
          displayName: { type: 'string', nullable: true },
          osType: { type: 'string', enum: ['windows', 'macos', 'linux'] },
          osVersion: { type: 'string' },
          architecture: { type: 'string' },
          agentVersion: { type: 'string' },
          status: { type: 'string', enum: ['online', 'offline', 'maintenance', 'decommissioned'] },
          lastSeenAt: { type: 'string', format: 'date-time', nullable: true },
          enrolledAt: { type: 'string', format: 'date-time' },
          tags: { type: 'array', items: { type: 'string' } },
          hardware: { $ref: '#/components/schemas/DeviceHardware' }
        }
      },
      DeviceHardware: {
        type: 'object',
        properties: {
          cpuModel: { type: 'string', nullable: true },
          cpuCores: { type: 'integer', nullable: true },
          ramTotalMb: { type: 'integer', nullable: true },
          diskTotalGb: { type: 'integer', nullable: true },
          serialNumber: { type: 'string', nullable: true },
          manufacturer: { type: 'string', nullable: true },
          model: { type: 'string', nullable: true }
        }
      },
      DeviceMetrics: {
        type: 'object',
        properties: {
          timestamp: { type: 'string', format: 'date-time' },
          cpu: { type: 'number', description: 'CPU usage percentage' },
          ram: { type: 'number', description: 'RAM usage percentage' },
          ramUsedMb: { type: 'integer' },
          disk: { type: 'number', description: 'Disk usage percentage' },
          diskUsedGb: { type: 'number' },
          networkIn: { type: 'integer' },
          networkOut: { type: 'integer' },
          processCount: { type: 'integer' }
        }
      },
      DeviceGroup: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          orgId: { type: 'string', format: 'uuid' },
          name: { type: 'string' },
          siteId: { type: 'string', format: 'uuid', nullable: true },
          type: { type: 'string', enum: ['static', 'dynamic'] },
          rules: { type: 'object', nullable: true },
          parentId: { type: 'string', format: 'uuid', nullable: true },
          createdAt: { type: 'string', format: 'date-time' }
        }
      },
      DeviceCommand: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          deviceId: { type: 'string', format: 'uuid' },
          type: { type: 'string', enum: ['script', 'reboot', 'shutdown', 'update'] },
          status: { type: 'string', enum: ['pending', 'sent', 'completed', 'failed', 'cancelled'] },
          payload: { type: 'object' },
          result: { type: 'object', nullable: true },
          createdAt: { type: 'string', format: 'date-time' },
          completedAt: { type: 'string', format: 'date-time', nullable: true }
        }
      },

      // Script schemas
      Script: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          orgId: { type: 'string', format: 'uuid', nullable: true },
          name: { type: 'string' },
          description: { type: 'string', nullable: true },
          category: { type: 'string', nullable: true },
          osTypes: { type: 'array', items: { type: 'string', enum: ['windows', 'macos', 'linux'] } },
          language: { type: 'string', enum: ['powershell', 'bash', 'python', 'cmd'] },
          content: { type: 'string' },
          parameters: { type: 'object', nullable: true },
          timeoutSeconds: { type: 'integer', default: 300 },
          runAs: { type: 'string', enum: ['system', 'user', 'elevated'] },
          isSystem: { type: 'boolean' },
          version: { type: 'integer' },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' }
        }
      },
      ScriptExecution: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          scriptId: { type: 'string', format: 'uuid' },
          deviceId: { type: 'string', format: 'uuid' },
          triggeredBy: { type: 'string', format: 'uuid' },
          triggerType: { type: 'string', enum: ['manual', 'scheduled', 'alert', 'policy'] },
          parameters: { type: 'object', nullable: true },
          status: { type: 'string', enum: ['pending', 'queued', 'running', 'completed', 'failed', 'timeout', 'cancelled'] },
          startedAt: { type: 'string', format: 'date-time', nullable: true },
          completedAt: { type: 'string', format: 'date-time', nullable: true },
          exitCode: { type: 'integer', nullable: true },
          stdout: { type: 'string', nullable: true },
          stderr: { type: 'string', nullable: true },
          errorMessage: { type: 'string', nullable: true }
        }
      },

      // Alert schemas
      AlertRule: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          orgId: { type: 'string', format: 'uuid' },
          name: { type: 'string' },
          description: { type: 'string', nullable: true },
          enabled: { type: 'boolean' },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'info'] },
          targets: { type: 'object', description: 'Target configuration (devices, sites, etc.)' },
          conditions: { type: 'object', description: 'Alert trigger conditions' },
          cooldownMinutes: { type: 'integer' },
          escalationPolicyId: { type: 'string', format: 'uuid', nullable: true },
          notificationChannels: { type: 'array', items: { type: 'string', format: 'uuid' } },
          autoResolve: { type: 'boolean' },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' }
        }
      },
      Alert: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          ruleId: { type: 'string', format: 'uuid' },
          deviceId: { type: 'string', format: 'uuid' },
          orgId: { type: 'string', format: 'uuid' },
          status: { type: 'string', enum: ['active', 'acknowledged', 'resolved', 'suppressed'] },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'info'] },
          title: { type: 'string' },
          message: { type: 'string', nullable: true },
          context: { type: 'object', nullable: true },
          triggeredAt: { type: 'string', format: 'date-time' },
          acknowledgedAt: { type: 'string', format: 'date-time', nullable: true },
          acknowledgedBy: { type: 'string', format: 'uuid', nullable: true },
          resolvedAt: { type: 'string', format: 'date-time', nullable: true },
          resolvedBy: { type: 'string', format: 'uuid', nullable: true },
          resolutionNote: { type: 'string', nullable: true },
          suppressedUntil: { type: 'string', format: 'date-time', nullable: true }
        }
      },
      NotificationChannel: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          orgId: { type: 'string', format: 'uuid' },
          name: { type: 'string' },
          type: { type: 'string', enum: ['email', 'slack', 'teams', 'webhook', 'pagerduty', 'sms'] },
          config: { type: 'object', description: 'Channel-specific configuration' },
          enabled: { type: 'boolean' },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' }
        }
      },
      EscalationPolicy: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          orgId: { type: 'string', format: 'uuid' },
          name: { type: 'string' },
          steps: { type: 'array', items: { type: 'object' } },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' }
        }
      },
      AlertSummary: {
        type: 'object',
        properties: {
          bySeverity: {
            type: 'object',
            properties: {
              critical: { type: 'integer' },
              high: { type: 'integer' },
              medium: { type: 'integer' },
              low: { type: 'integer' },
              info: { type: 'integer' }
            }
          },
          byStatus: {
            type: 'object',
            properties: {
              active: { type: 'integer' },
              acknowledged: { type: 'integer' },
              resolved: { type: 'integer' },
              suppressed: { type: 'integer' }
            }
          },
          total: { type: 'integer' }
        }
      },

      // Automation schemas
      Automation: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          orgId: { type: 'string', format: 'uuid' },
          name: { type: 'string' },
          description: { type: 'string', nullable: true },
          enabled: { type: 'boolean' },
          trigger: { type: 'object', description: 'Trigger configuration' },
          conditions: { type: 'object', nullable: true },
          actions: { type: 'object', description: 'Actions to execute' },
          onFailure: { type: 'string', enum: ['stop', 'continue', 'notify'] },
          notificationTargets: { type: 'object', nullable: true },
          runCount: { type: 'integer' },
          lastRunAt: { type: 'string', format: 'date-time', nullable: true },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' }
        }
      },
      AutomationRun: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          automationId: { type: 'string', format: 'uuid' },
          triggeredBy: { type: 'string' },
          status: { type: 'string', enum: ['running', 'completed', 'failed', 'partial'] },
          devicesTargeted: { type: 'integer' },
          devicesSucceeded: { type: 'integer' },
          devicesFailed: { type: 'integer' },
          logs: { type: 'array', items: { type: 'object' } },
          startedAt: { type: 'string', format: 'date-time' },
          completedAt: { type: 'string', format: 'date-time', nullable: true }
        }
      },
      Policy: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          orgId: { type: 'string', format: 'uuid' },
          name: { type: 'string' },
          description: { type: 'string', nullable: true },
          enabled: { type: 'boolean' },
          targets: { type: 'object', description: 'Target configuration' },
          rules: { type: 'object', description: 'Policy rules' },
          enforcement: { type: 'string', enum: ['monitor', 'warn', 'enforce'] },
          checkIntervalMinutes: { type: 'integer' },
          remediationScriptId: { type: 'string', format: 'uuid', nullable: true },
          lastEvaluatedAt: { type: 'string', format: 'date-time', nullable: true },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' }
        }
      },
      PolicyCompliance: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          policyId: { type: 'string', format: 'uuid' },
          deviceId: { type: 'string', format: 'uuid' },
          status: { type: 'string', enum: ['compliant', 'non_compliant', 'pending', 'error'] },
          details: { type: 'object', nullable: true },
          lastCheckedAt: { type: 'string', format: 'date-time' },
          remediationAttempts: { type: 'integer' }
        }
      },

      // Report schemas
      Report: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          orgId: { type: 'string', format: 'uuid' },
          name: { type: 'string' },
          type: { type: 'string', enum: ['device_inventory', 'software_inventory', 'alert_summary', 'compliance', 'performance', 'executive_summary'] },
          config: { type: 'object' },
          schedule: { type: 'string', enum: ['one_time', 'daily', 'weekly', 'monthly'] },
          format: { type: 'string', enum: ['csv', 'pdf', 'excel'] },
          lastGeneratedAt: { type: 'string', format: 'date-time', nullable: true },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' }
        }
      },
      ReportRun: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          reportId: { type: 'string', format: 'uuid' },
          status: { type: 'string', enum: ['pending', 'running', 'completed', 'failed'] },
          startedAt: { type: 'string', format: 'date-time' },
          completedAt: { type: 'string', format: 'date-time', nullable: true },
          outputUrl: { type: 'string', nullable: true },
          errorMessage: { type: 'string', nullable: true },
          rowCount: { type: 'integer', nullable: true }
        }
      },

      // Remote Access schemas
      RemoteSession: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          deviceId: { type: 'string', format: 'uuid' },
          userId: { type: 'string', format: 'uuid' },
          type: { type: 'string', enum: ['terminal', 'desktop', 'file_transfer'] },
          status: { type: 'string', enum: ['pending', 'connecting', 'active', 'disconnected', 'failed'] },
          startedAt: { type: 'string', format: 'date-time', nullable: true },
          endedAt: { type: 'string', format: 'date-time', nullable: true },
          durationSeconds: { type: 'integer', nullable: true },
          bytesTransferred: { type: 'integer', nullable: true },
          recordingUrl: { type: 'string', nullable: true },
          createdAt: { type: 'string', format: 'date-time' }
        }
      },
      FileTransfer: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          sessionId: { type: 'string', format: 'uuid', nullable: true },
          deviceId: { type: 'string', format: 'uuid' },
          userId: { type: 'string', format: 'uuid' },
          direction: { type: 'string', enum: ['upload', 'download'] },
          remotePath: { type: 'string' },
          localFilename: { type: 'string' },
          sizeBytes: { type: 'integer' },
          status: { type: 'string', enum: ['pending', 'transferring', 'completed', 'failed'] },
          progressPercent: { type: 'integer' },
          errorMessage: { type: 'string', nullable: true },
          createdAt: { type: 'string', format: 'date-time' },
          completedAt: { type: 'string', format: 'date-time', nullable: true }
        }
      },

      // Agent schemas
      EnrollmentRequest: {
        type: 'object',
        properties: {
          enrollmentKey: { type: 'string' },
          hostname: { type: 'string' },
          osType: { type: 'string', enum: ['windows', 'macos', 'linux'] },
          osVersion: { type: 'string' },
          architecture: { type: 'string' },
          agentVersion: { type: 'string' },
          hardwareInfo: { $ref: '#/components/schemas/DeviceHardware' },
          networkInfo: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                mac: { type: 'string' },
                ip: { type: 'string' },
                isPrimary: { type: 'boolean' }
              }
            }
          }
        },
        required: ['enrollmentKey', 'hostname', 'osType', 'osVersion', 'architecture', 'agentVersion']
      },
      EnrollmentResponse: {
        type: 'object',
        properties: {
          agentId: { type: 'string' },
          deviceId: { type: 'string', format: 'uuid' },
          authToken: { type: 'string' },
          orgId: { type: 'string', format: 'uuid' },
          siteId: { type: 'string', format: 'uuid' },
          config: {
            type: 'object',
            properties: {
              heartbeatIntervalSeconds: { type: 'integer' },
              metricsCollectionIntervalSeconds: { type: 'integer' }
            }
          }
        }
      },
      HeartbeatRequest: {
        type: 'object',
        properties: {
          metrics: {
            type: 'object',
            properties: {
              cpuPercent: { type: 'number' },
              ramPercent: { type: 'number' },
              ramUsedMb: { type: 'integer' },
              diskPercent: { type: 'number' },
              diskUsedGb: { type: 'number' },
              networkInBytes: { type: 'integer' },
              networkOutBytes: { type: 'integer' },
              processCount: { type: 'integer' }
            },
            required: ['cpuPercent', 'ramPercent', 'ramUsedMb', 'diskPercent', 'diskUsedGb']
          },
          status: { type: 'string', enum: ['ok', 'warning', 'error'] },
          agentVersion: { type: 'string' },
          pendingReboot: { type: 'boolean' },
          lastUser: { type: 'string' },
          uptime: { type: 'integer' }
        },
        required: ['metrics', 'status', 'agentVersion']
      },
      HeartbeatResponse: {
        type: 'object',
        properties: {
          commands: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', format: 'uuid' },
                type: { type: 'string' },
                payload: { type: 'object' }
              }
            }
          },
          configUpdate: { type: 'object', nullable: true },
          upgradeTo: { type: 'string', nullable: true }
        }
      },

      // Audit schemas
      AuditLog: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          timestamp: { type: 'string', format: 'date-time' },
          actorType: { type: 'string', enum: ['user', 'system', 'agent'] },
          actorId: { type: 'string', format: 'uuid' },
          actorEmail: { type: 'string' },
          action: { type: 'string' },
          resourceType: { type: 'string' },
          resourceId: { type: 'string', format: 'uuid' },
          resourceName: { type: 'string' },
          details: { type: 'object' },
          ipAddress: { type: 'string' },
          userAgent: { type: 'string' },
          result: { type: 'string', enum: ['success', 'failure'] }
        }
      }
    },
    parameters: {
      pageParam: {
        name: 'page',
        in: 'query',
        schema: { type: 'integer', default: 1 },
        description: 'Page number for pagination'
      },
      limitParam: {
        name: 'limit',
        in: 'query',
        schema: { type: 'integer', default: 50, maximum: 100 },
        description: 'Number of items per page'
      },
      orgIdParam: {
        name: 'orgId',
        in: 'query',
        schema: { type: 'string', format: 'uuid' },
        description: 'Filter by organization ID'
      },
      partnerIdParam: {
        name: 'partnerId',
        in: 'query',
        schema: { type: 'string', format: 'uuid' },
        description: 'Filter by partner ID (system scope only)'
      },
      idParam: {
        name: 'id',
        in: 'path',
        required: true,
        schema: { type: 'string', format: 'uuid' },
        description: 'Resource ID'
      }
    },
    responses: {
      NotFound: {
        description: 'Resource not found',
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/Error' }
          }
        }
      },
      Unauthorized: {
        description: 'Authentication required',
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/Error' }
          }
        }
      },
      Forbidden: {
        description: 'Access denied',
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/Error' }
          }
        }
      },
      BadRequest: {
        description: 'Invalid request',
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/Error' }
          }
        }
      },
      TooManyRequests: {
        description: 'Rate limit exceeded',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                error: { type: 'string' },
                retryAfter: { type: 'integer' }
              }
            }
          }
        }
      }
    }
  },
  security: [
    { bearerAuth: [] },
    { apiKeyAuth: [] }
  ],
  paths: {
    // ============================================
    // AUTH ENDPOINTS
    // ============================================
    '/auth/register': {
      post: {
        tags: ['Auth'],
        summary: 'Register a new user',
        description: 'Create a new user account. Rate limited to 5 requests per hour per IP.',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/RegisterRequest' }
            }
          }
        },
        responses: {
          '200': {
            description: 'Registration successful',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/LoginResponse' }
              }
            }
          },
          '400': { $ref: '#/components/responses/BadRequest' },
          '429': { $ref: '#/components/responses/TooManyRequests' }
        }
      }
    },
    '/auth/login': {
      post: {
        tags: ['Auth'],
        summary: 'Login',
        description: 'Authenticate with email and password. Returns JWT tokens or MFA challenge.',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/LoginRequest' }
            }
          }
        },
        responses: {
          '200': {
            description: 'Login successful',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/LoginResponse' }
              }
            }
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
          '429': { $ref: '#/components/responses/TooManyRequests' }
        }
      }
    },
    '/auth/logout': {
      post: {
        tags: ['Auth'],
        summary: 'Logout',
        description: 'Invalidate the current session',
        responses: {
          '200': {
            description: 'Logout successful',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Success' }
              }
            }
          }
        }
      }
    },
    '/auth/refresh': {
      post: {
        tags: ['Auth'],
        summary: 'Refresh tokens',
        description: 'Exchange a refresh token for new access and refresh tokens',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  refreshToken: { type: 'string' }
                },
                required: ['refreshToken']
              }
            }
          }
        },
        responses: {
          '200': {
            description: 'Tokens refreshed',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    tokens: { $ref: '#/components/schemas/Tokens' }
                  }
                }
              }
            }
          },
          '401': { $ref: '#/components/responses/Unauthorized' }
        }
      }
    },
    '/auth/mfa/setup': {
      post: {
        tags: ['Auth'],
        summary: 'Setup MFA',
        description: 'Initialize MFA setup and get QR code for authenticator app',
        responses: {
          '200': {
            description: 'MFA setup initiated',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/MfaSetupResponse' }
              }
            }
          },
          '400': { $ref: '#/components/responses/BadRequest' }
        }
      }
    },
    '/auth/mfa/verify': {
      post: {
        tags: ['Auth'],
        summary: 'Verify MFA code',
        description: 'Verify MFA code during login or to complete MFA setup',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  code: { type: 'string', minLength: 6, maxLength: 6 },
                  tempToken: { type: 'string', description: 'Required for login MFA verification' }
                },
                required: ['code']
              }
            }
          }
        },
        responses: {
          '200': {
            description: 'MFA verified',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/LoginResponse' }
              }
            }
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '429': { $ref: '#/components/responses/TooManyRequests' }
        }
      }
    },
    '/auth/mfa/disable': {
      post: {
        tags: ['Auth'],
        summary: 'Disable MFA',
        description: 'Disable MFA for the current user (requires current MFA code)',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  code: { type: 'string', minLength: 6, maxLength: 6 }
                },
                required: ['code']
              }
            }
          }
        },
        responses: {
          '200': {
            description: 'MFA disabled',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Success' }
              }
            }
          },
          '400': { $ref: '#/components/responses/BadRequest' },
          '401': { $ref: '#/components/responses/Unauthorized' }
        }
      }
    },
    '/auth/forgot-password': {
      post: {
        tags: ['Auth'],
        summary: 'Request password reset',
        description: 'Send password reset email. Always returns success to prevent email enumeration.',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  email: { type: 'string', format: 'email' }
                },
                required: ['email']
              }
            }
          }
        },
        responses: {
          '200': {
            description: 'Password reset request processed',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Success' }
              }
            }
          }
        }
      }
    },
    '/auth/reset-password': {
      post: {
        tags: ['Auth'],
        summary: 'Reset password',
        description: 'Reset password using the token from email',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  token: { type: 'string' },
                  password: { type: 'string', minLength: 8 }
                },
                required: ['token', 'password']
              }
            }
          }
        },
        responses: {
          '200': {
            description: 'Password reset successful',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Success' }
              }
            }
          },
          '400': { $ref: '#/components/responses/BadRequest' }
        }
      }
    },
    '/auth/me': {
      get: {
        tags: ['Auth'],
        summary: 'Get current user',
        description: 'Get the currently authenticated user profile',
        responses: {
          '200': {
            description: 'Current user profile',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    user: { $ref: '#/components/schemas/User' }
                  }
                }
              }
            }
          },
          '401': { $ref: '#/components/responses/Unauthorized' }
        }
      }
    },

    // ============================================
    // USER ENDPOINTS
    // ============================================
    '/users': {
      get: {
        tags: ['Users'],
        summary: 'List users',
        description: 'Get all users in the current scope (partner or organization)',
        responses: {
          '200': {
            description: 'List of users',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: { type: 'array', items: { $ref: '#/components/schemas/User' } }
                  }
                }
              }
            }
          },
          '403': { $ref: '#/components/responses/Forbidden' }
        }
      }
    },
    '/users/me': {
      get: {
        tags: ['Users'],
        summary: 'Get current user',
        description: 'Get the currently authenticated user profile',
        responses: {
          '200': {
            description: 'Current user profile',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/User' }
              }
            }
          },
          '401': { $ref: '#/components/responses/Unauthorized' }
        }
      },
      patch: {
        tags: ['Users'],
        summary: 'Update current user',
        description: 'Update the current user profile',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  name: { type: 'string', minLength: 1, maxLength: 255 },
                  avatarUrl: { type: 'string', nullable: true }
                }
              }
            }
          }
        },
        responses: {
          '200': {
            description: 'Updated user profile',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/User' }
              }
            }
          },
          '400': { $ref: '#/components/responses/BadRequest' },
          '401': { $ref: '#/components/responses/Unauthorized' }
        }
      }
    },
    '/users/{id}': {
      get: {
        tags: ['Users'],
        summary: 'Get user',
        description: 'Get a specific user by ID',
        parameters: [{ $ref: '#/components/parameters/idParam' }],
        responses: {
          '200': {
            description: 'User details',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/User' }
              }
            }
          },
          '404': { $ref: '#/components/responses/NotFound' }
        }
      },
      patch: {
        tags: ['Users'],
        summary: 'Update user',
        description: 'Update user name or status',
        parameters: [{ $ref: '#/components/parameters/idParam' }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  name: { type: 'string', minLength: 1, maxLength: 255 },
                  status: { type: 'string', enum: ['active', 'invited', 'disabled'] }
                }
              }
            }
          }
        },
        responses: {
          '200': {
            description: 'User updated',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/User' }
              }
            }
          },
          '400': { $ref: '#/components/responses/BadRequest' },
          '404': { $ref: '#/components/responses/NotFound' }
        }
      },
      delete: {
        tags: ['Users'],
        summary: 'Remove user',
        description: 'Remove user from the current scope',
        parameters: [{ $ref: '#/components/parameters/idParam' }],
        responses: {
          '200': {
            description: 'User removed',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Success' }
              }
            }
          },
          '404': { $ref: '#/components/responses/NotFound' }
        }
      }
    },
    '/users/invite': {
      post: {
        tags: ['Users'],
        summary: 'Invite user',
        description: 'Invite a new user to the partner or organization',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/InviteUserRequest' }
            }
          }
        },
        responses: {
          '201': {
            description: 'User invited',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/User' }
              }
            }
          },
          '400': { $ref: '#/components/responses/BadRequest' },
          '409': {
            description: 'User already exists',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Error' }
              }
            }
          }
        }
      }
    },
    '/users/resend-invite': {
      post: {
        tags: ['Users'],
        summary: 'Resend invitation',
        description: 'Resend the invitation email to a pending user',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  userId: { type: 'string', format: 'uuid' }
                },
                required: ['userId']
              }
            }
          }
        },
        responses: {
          '200': {
            description: 'Invitation resent',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Success' }
              }
            }
          },
          '400': { $ref: '#/components/responses/BadRequest' },
          '404': { $ref: '#/components/responses/NotFound' }
        }
      }
    },
    '/users/roles': {
      get: {
        tags: ['Users'],
        summary: 'List roles',
        description: 'Get available roles for the current scope',
        responses: {
          '200': {
            description: 'List of roles',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: { type: 'array', items: { $ref: '#/components/schemas/Role' } }
                  }
                }
              }
            }
          }
        }
      }
    },
    '/users/{id}/role': {
      post: {
        tags: ['Users'],
        summary: 'Assign role',
        description: 'Assign a role to a user',
        parameters: [{ $ref: '#/components/parameters/idParam' }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  roleId: { type: 'string', format: 'uuid' }
                },
                required: ['roleId']
              }
            }
          }
        },
        responses: {
          '200': {
            description: 'Role assigned',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Success' }
              }
            }
          },
          '400': { $ref: '#/components/responses/BadRequest' },
          '404': { $ref: '#/components/responses/NotFound' }
        }
      }
    },

    // ============================================
    // ORGANIZATION ENDPOINTS
    // ============================================
    '/orgs/partners': {
      get: {
        tags: ['Organizations'],
        summary: 'List partners',
        description: 'List all partners (system scope only)',
        parameters: [
          { $ref: '#/components/parameters/pageParam' },
          { $ref: '#/components/parameters/limitParam' }
        ],
        responses: {
          '200': {
            description: 'List of partners',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: { type: 'array', items: { $ref: '#/components/schemas/Partner' } },
                    pagination: { $ref: '#/components/schemas/Pagination' }
                  }
                }
              }
            }
          }
        }
      },
      post: {
        tags: ['Organizations'],
        summary: 'Create partner',
        description: 'Create a new partner (system scope only)',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  name: { type: 'string', minLength: 1 },
                  slug: { type: 'string', minLength: 1, maxLength: 100 },
                  type: { type: 'string', enum: ['msp', 'enterprise', 'internal'] },
                  plan: { type: 'string', enum: ['free', 'pro', 'enterprise', 'unlimited'] },
                  maxOrganizations: { type: 'integer', nullable: true },
                  maxDevices: { type: 'integer', nullable: true },
                  billingEmail: { type: 'string', format: 'email' }
                },
                required: ['name', 'slug']
              }
            }
          }
        },
        responses: {
          '201': {
            description: 'Partner created',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Partner' }
              }
            }
          },
          '400': { $ref: '#/components/responses/BadRequest' }
        }
      }
    },
    '/orgs/partners/{id}': {
      get: {
        tags: ['Organizations'],
        summary: 'Get partner',
        description: 'Get partner details (system scope only)',
        parameters: [{ $ref: '#/components/parameters/idParam' }],
        responses: {
          '200': {
            description: 'Partner details',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Partner' }
              }
            }
          },
          '404': { $ref: '#/components/responses/NotFound' }
        }
      },
      patch: {
        tags: ['Organizations'],
        summary: 'Update partner',
        description: 'Update partner details (system scope only)',
        parameters: [{ $ref: '#/components/parameters/idParam' }],
        responses: {
          '200': {
            description: 'Partner updated',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Partner' }
              }
            }
          },
          '404': { $ref: '#/components/responses/NotFound' }
        }
      },
      delete: {
        tags: ['Organizations'],
        summary: 'Delete partner',
        description: 'Soft delete a partner (system scope only)',
        parameters: [{ $ref: '#/components/parameters/idParam' }],
        responses: {
          '200': {
            description: 'Partner deleted',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Success' }
              }
            }
          },
          '404': { $ref: '#/components/responses/NotFound' }
        }
      }
    },
    '/orgs/organizations': {
      get: {
        tags: ['Organizations'],
        summary: 'List organizations',
        description: 'List organizations under the current partner (system scope can optionally filter by partnerId)',
        parameters: [
          { $ref: '#/components/parameters/partnerIdParam' },
          { $ref: '#/components/parameters/pageParam' },
          { $ref: '#/components/parameters/limitParam' }
        ],
        responses: {
          '200': {
            description: 'List of organizations',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: { type: 'array', items: { $ref: '#/components/schemas/Organization' } },
                    pagination: { $ref: '#/components/schemas/Pagination' }
                  }
                }
              }
            }
          }
        }
      },
      post: {
        tags: ['Organizations'],
        summary: 'Create organization',
        description: 'Create a new organization under the current partner (system scope requires partnerId)',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  partnerId: { type: 'string', format: 'uuid' },
                  name: { type: 'string', minLength: 1 },
                  slug: { type: 'string', minLength: 1, maxLength: 100 },
                  type: { type: 'string', enum: ['customer', 'internal'] },
                  status: { type: 'string', enum: ['active', 'suspended', 'trial', 'churned'] },
                  maxDevices: { type: 'integer', nullable: true },
                  contractStart: { type: 'string', format: 'date-time', nullable: true },
                  contractEnd: { type: 'string', format: 'date-time', nullable: true }
                },
                required: ['name', 'slug']
              }
            }
          }
        },
        responses: {
          '201': {
            description: 'Organization created',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Organization' }
              }
            }
          },
          '400': { $ref: '#/components/responses/BadRequest' }
        }
      }
    },
    '/orgs/organizations/{id}': {
      get: {
        tags: ['Organizations'],
        summary: 'Get organization',
        description: 'Get organization details',
        parameters: [{ $ref: '#/components/parameters/idParam' }],
        responses: {
          '200': {
            description: 'Organization details',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Organization' }
              }
            }
          },
          '404': { $ref: '#/components/responses/NotFound' }
        }
      },
      patch: {
        tags: ['Organizations'],
        summary: 'Update organization',
        description: 'Update organization details',
        parameters: [{ $ref: '#/components/parameters/idParam' }],
        responses: {
          '200': {
            description: 'Organization updated',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Organization' }
              }
            }
          },
          '404': { $ref: '#/components/responses/NotFound' }
        }
      },
      delete: {
        tags: ['Organizations'],
        summary: 'Delete organization',
        description: 'Soft delete an organization',
        parameters: [{ $ref: '#/components/parameters/idParam' }],
        responses: {
          '200': {
            description: 'Organization deleted',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Success' }
              }
            }
          },
          '404': { $ref: '#/components/responses/NotFound' }
        }
      }
    },
    '/orgs/sites': {
      get: {
        tags: ['Organizations'],
        summary: 'List sites',
        description: 'List sites for an organization',
        parameters: [
          { $ref: '#/components/parameters/pageParam' },
          { $ref: '#/components/parameters/limitParam' },
          { name: 'orgId', in: 'query', required: true, schema: { type: 'string', format: 'uuid' } }
        ],
        responses: {
          '200': {
            description: 'List of sites',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: { type: 'array', items: { $ref: '#/components/schemas/Site' } },
                    pagination: { $ref: '#/components/schemas/Pagination' }
                  }
                }
              }
            }
          }
        }
      },
      post: {
        tags: ['Organizations'],
        summary: 'Create site',
        description: 'Create a new site',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  orgId: { type: 'string', format: 'uuid' },
                  name: { type: 'string', minLength: 1 },
                  timezone: { type: 'string', default: 'UTC' },
                  address: { type: 'object' },
                  contact: { type: 'object' }
                },
                required: ['orgId', 'name']
              }
            }
          }
        },
        responses: {
          '201': {
            description: 'Site created',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Site' }
              }
            }
          }
        }
      }
    },
    '/orgs/sites/{id}': {
      get: {
        tags: ['Organizations'],
        summary: 'Get site',
        parameters: [{ $ref: '#/components/parameters/idParam' }],
        responses: {
          '200': {
            description: 'Site details',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Site' }
              }
            }
          },
          '404': { $ref: '#/components/responses/NotFound' }
        }
      },
      patch: {
        tags: ['Organizations'],
        summary: 'Update site',
        parameters: [{ $ref: '#/components/parameters/idParam' }],
        responses: {
          '200': {
            description: 'Site updated',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Site' }
              }
            }
          }
        }
      },
      delete: {
        tags: ['Organizations'],
        summary: 'Delete site',
        parameters: [{ $ref: '#/components/parameters/idParam' }],
        responses: {
          '200': {
            description: 'Site deleted',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Success' }
              }
            }
          }
        }
      }
    },

    // ============================================
    // DEVICE ENDPOINTS
    // ============================================
    '/devices': {
      get: {
        tags: ['Devices'],
        summary: 'List devices',
        description: 'Get paginated list of devices with optional filters',
        parameters: [
          { $ref: '#/components/parameters/pageParam' },
          { $ref: '#/components/parameters/limitParam' },
          { $ref: '#/components/parameters/orgIdParam' },
          { name: 'siteId', in: 'query', schema: { type: 'string', format: 'uuid' } },
          { name: 'status', in: 'query', schema: { type: 'string', enum: ['online', 'offline', 'maintenance', 'decommissioned'] } },
          { name: 'osType', in: 'query', schema: { type: 'string', enum: ['windows', 'macos', 'linux'] } },
          { name: 'search', in: 'query', schema: { type: 'string' }, description: 'Search by hostname' }
        ],
        responses: {
          '200': {
            description: 'List of devices',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: { type: 'array', items: { $ref: '#/components/schemas/Device' } },
                    pagination: { $ref: '#/components/schemas/Pagination' }
                  }
                }
              }
            }
          }
        }
      }
    },
    '/devices/{id}': {
      get: {
        tags: ['Devices'],
        summary: 'Get device details',
        description: 'Get comprehensive device information including hardware, network, and recent metrics',
        parameters: [{ $ref: '#/components/parameters/idParam' }],
        responses: {
          '200': {
            description: 'Device details',
            content: {
              'application/json': {
                schema: {
                  allOf: [
                    { $ref: '#/components/schemas/Device' },
                    {
                      type: 'object',
                      properties: {
                        networkInterfaces: { type: 'array', items: { type: 'object' } },
                        recentMetrics: { type: 'array', items: { $ref: '#/components/schemas/DeviceMetrics' } },
                        groups: { type: 'array', items: { $ref: '#/components/schemas/DeviceGroup' } }
                      }
                    }
                  ]
                }
              }
            }
          },
          '404': { $ref: '#/components/responses/NotFound' }
        }
      },
      patch: {
        tags: ['Devices'],
        summary: 'Update device',
        description: 'Update device display name, site, or tags',
        parameters: [{ $ref: '#/components/parameters/idParam' }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  displayName: { type: 'string', minLength: 1, maxLength: 255 },
                  siteId: { type: 'string', format: 'uuid' },
                  tags: { type: 'array', items: { type: 'string' } }
                }
              }
            }
          }
        },
        responses: {
          '200': {
            description: 'Device updated',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Device' }
              }
            }
          }
        }
      },
      delete: {
        tags: ['Devices'],
        summary: 'Decommission device',
        description: 'Mark device as decommissioned (soft delete)',
        parameters: [{ $ref: '#/components/parameters/idParam' }],
        responses: {
          '200': {
            description: 'Device decommissioned',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Success' }
              }
            }
          }
        }
      }
    },
    '/devices/{id}/metrics': {
      get: {
        tags: ['Devices'],
        summary: 'Get device metrics',
        description: 'Get historical metrics data for a device',
        parameters: [
          { $ref: '#/components/parameters/idParam' },
          { name: 'startDate', in: 'query', schema: { type: 'string', format: 'date-time' } },
          { name: 'endDate', in: 'query', schema: { type: 'string', format: 'date-time' } },
          { name: 'interval', in: 'query', schema: { type: 'string', enum: ['1m', '5m', '1h', '1d'] } }
        ],
        responses: {
          '200': {
            description: 'Metrics data',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: { type: 'array', items: { $ref: '#/components/schemas/DeviceMetrics' } },
                    interval: { type: 'string' },
                    startDate: { type: 'string', format: 'date-time' },
                    endDate: { type: 'string', format: 'date-time' }
                  }
                }
              }
            }
          }
        }
      }
    },
    '/devices/{id}/software': {
      get: {
        tags: ['Devices'],
        summary: 'Get installed software',
        description: 'Get list of software installed on the device',
        parameters: [
          { $ref: '#/components/parameters/idParam' },
          { $ref: '#/components/parameters/pageParam' },
          { $ref: '#/components/parameters/limitParam' },
          { name: 'search', in: 'query', schema: { type: 'string' } }
        ],
        responses: {
          '200': {
            description: 'Software list',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: { type: 'array', items: { type: 'object' } },
                    pagination: { $ref: '#/components/schemas/Pagination' }
                  }
                }
              }
            }
          }
        }
      }
    },
    '/devices/{id}/commands': {
      get: {
        tags: ['Devices'],
        summary: 'Get command history',
        description: 'Get history of commands sent to the device',
        parameters: [
          { $ref: '#/components/parameters/idParam' },
          { $ref: '#/components/parameters/pageParam' },
          { $ref: '#/components/parameters/limitParam' }
        ],
        responses: {
          '200': {
            description: 'Command history',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: { type: 'array', items: { $ref: '#/components/schemas/DeviceCommand' } },
                    pagination: { $ref: '#/components/schemas/Pagination' }
                  }
                }
              }
            }
          }
        }
      },
      post: {
        tags: ['Devices'],
        summary: 'Queue command',
        description: 'Queue a command for the device to execute',
        parameters: [{ $ref: '#/components/parameters/idParam' }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  type: { type: 'string', enum: ['script', 'reboot', 'shutdown', 'update'] },
                  payload: { type: 'object' }
                },
                required: ['type']
              }
            }
          }
        },
        responses: {
          '201': {
            description: 'Command queued',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/DeviceCommand' }
              }
            }
          }
        }
      }
    },
    '/devices/groups': {
      get: {
        tags: ['Devices'],
        summary: 'List device groups',
        parameters: [
          { $ref: '#/components/parameters/pageParam' },
          { $ref: '#/components/parameters/limitParam' },
          { name: 'orgId', in: 'query', required: true, schema: { type: 'string', format: 'uuid' } }
        ],
        responses: {
          '200': {
            description: 'List of device groups',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: { type: 'array', items: { $ref: '#/components/schemas/DeviceGroup' } },
                    pagination: { $ref: '#/components/schemas/Pagination' }
                  }
                }
              }
            }
          }
        }
      },
      post: {
        tags: ['Devices'],
        summary: 'Create device group',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  orgId: { type: 'string', format: 'uuid' },
                  name: { type: 'string', minLength: 1, maxLength: 255 },
                  siteId: { type: 'string', format: 'uuid' },
                  type: { type: 'string', enum: ['static', 'dynamic'] },
                  rules: { type: 'object' },
                  parentId: { type: 'string', format: 'uuid' }
                },
                required: ['orgId', 'name', 'type']
              }
            }
          }
        },
        responses: {
          '201': {
            description: 'Group created',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/DeviceGroup' }
              }
            }
          }
        }
      }
    },

    // ============================================
    // SCRIPT ENDPOINTS
    // ============================================
    '/scripts': {
      get: {
        tags: ['Scripts'],
        summary: 'List scripts',
        parameters: [
          { $ref: '#/components/parameters/pageParam' },
          { $ref: '#/components/parameters/limitParam' },
          { $ref: '#/components/parameters/orgIdParam' },
          { name: 'category', in: 'query', schema: { type: 'string' } },
          { name: 'osType', in: 'query', schema: { type: 'string', enum: ['windows', 'macos', 'linux'] } },
          { name: 'language', in: 'query', schema: { type: 'string', enum: ['powershell', 'bash', 'python', 'cmd'] } },
          { name: 'search', in: 'query', schema: { type: 'string' } },
          { name: 'includeSystem', in: 'query', schema: { type: 'string', enum: ['true', 'false'] } }
        ],
        responses: {
          '200': {
            description: 'List of scripts',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: { type: 'array', items: { $ref: '#/components/schemas/Script' } },
                    pagination: { $ref: '#/components/schemas/Pagination' }
                  }
                }
              }
            }
          }
        }
      },
      post: {
        tags: ['Scripts'],
        summary: 'Create script',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  orgId: { type: 'string', format: 'uuid' },
                  name: { type: 'string', minLength: 1, maxLength: 255 },
                  description: { type: 'string' },
                  category: { type: 'string', maxLength: 100 },
                  osTypes: { type: 'array', items: { type: 'string', enum: ['windows', 'macos', 'linux'] }, minItems: 1 },
                  language: { type: 'string', enum: ['powershell', 'bash', 'python', 'cmd'] },
                  content: { type: 'string', minLength: 1 },
                  parameters: { type: 'object' },
                  timeoutSeconds: { type: 'integer', minimum: 1, maximum: 86400, default: 300 },
                  runAs: { type: 'string', enum: ['system', 'user', 'elevated'], default: 'system' }
                },
                required: ['name', 'osTypes', 'language', 'content']
              }
            }
          }
        },
        responses: {
          '201': {
            description: 'Script created',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Script' }
              }
            }
          }
        }
      }
    },
    '/scripts/{id}': {
      get: {
        tags: ['Scripts'],
        summary: 'Get script',
        parameters: [{ $ref: '#/components/parameters/idParam' }],
        responses: {
          '200': {
            description: 'Script details',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Script' }
              }
            }
          },
          '404': { $ref: '#/components/responses/NotFound' }
        }
      },
      put: {
        tags: ['Scripts'],
        summary: 'Update script',
        description: 'Update script. Version is automatically incremented when content changes.',
        parameters: [{ $ref: '#/components/parameters/idParam' }],
        responses: {
          '200': {
            description: 'Script updated',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Script' }
              }
            }
          }
        }
      },
      delete: {
        tags: ['Scripts'],
        summary: 'Delete script',
        description: 'Delete script (fails if active executions exist)',
        parameters: [{ $ref: '#/components/parameters/idParam' }],
        responses: {
          '200': {
            description: 'Script deleted',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Success' }
              }
            }
          },
          '409': {
            description: 'Script has active executions',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Error' }
              }
            }
          }
        }
      }
    },
    '/scripts/{id}/execute': {
      post: {
        tags: ['Scripts'],
        summary: 'Execute script',
        description: 'Execute script on one or more devices',
        parameters: [{ $ref: '#/components/parameters/idParam' }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  deviceIds: { type: 'array', items: { type: 'string', format: 'uuid' }, minItems: 1 },
                  parameters: { type: 'object' },
                  triggerType: { type: 'string', enum: ['manual', 'scheduled', 'alert', 'policy'] }
                },
                required: ['deviceIds']
              }
            }
          }
        },
        responses: {
          '201': {
            description: 'Execution started',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    batchId: { type: 'string', format: 'uuid', nullable: true },
                    scriptId: { type: 'string', format: 'uuid' },
                    devicesTargeted: { type: 'integer' },
                    executions: { type: 'array', items: { type: 'object' } },
                    status: { type: 'string' }
                  }
                }
              }
            }
          }
        }
      }
    },
    '/scripts/{id}/executions': {
      get: {
        tags: ['Scripts'],
        summary: 'List executions',
        description: 'List executions for a specific script',
        parameters: [
          { $ref: '#/components/parameters/idParam' },
          { $ref: '#/components/parameters/pageParam' },
          { $ref: '#/components/parameters/limitParam' },
          { name: 'status', in: 'query', schema: { type: 'string', enum: ['pending', 'queued', 'running', 'completed', 'failed', 'timeout', 'cancelled'] } },
          { name: 'deviceId', in: 'query', schema: { type: 'string', format: 'uuid' } }
        ],
        responses: {
          '200': {
            description: 'List of executions',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: { type: 'array', items: { $ref: '#/components/schemas/ScriptExecution' } },
                    pagination: { $ref: '#/components/schemas/Pagination' }
                  }
                }
              }
            }
          }
        }
      }
    },
    '/scripts/executions/{id}': {
      get: {
        tags: ['Scripts'],
        summary: 'Get execution details',
        description: 'Get detailed execution information including stdout/stderr',
        parameters: [{ $ref: '#/components/parameters/idParam' }],
        responses: {
          '200': {
            description: 'Execution details',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ScriptExecution' }
              }
            }
          }
        }
      }
    },
    '/scripts/executions/{id}/cancel': {
      post: {
        tags: ['Scripts'],
        summary: 'Cancel execution',
        parameters: [{ $ref: '#/components/parameters/idParam' }],
        responses: {
          '200': {
            description: 'Execution cancelled',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Success' }
              }
            }
          },
          '400': { $ref: '#/components/responses/BadRequest' }
        }
      }
    },

    // ============================================
    // ALERT ENDPOINTS
    // ============================================
    '/alerts': {
      get: {
        tags: ['Alerts'],
        summary: 'List alerts',
        parameters: [
          { $ref: '#/components/parameters/pageParam' },
          { $ref: '#/components/parameters/limitParam' },
          { $ref: '#/components/parameters/orgIdParam' },
          { name: 'status', in: 'query', schema: { type: 'string', enum: ['active', 'acknowledged', 'resolved', 'suppressed'] } },
          { name: 'severity', in: 'query', schema: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'info'] } },
          { name: 'deviceId', in: 'query', schema: { type: 'string', format: 'uuid' } },
          { name: 'startDate', in: 'query', schema: { type: 'string', format: 'date-time' } },
          { name: 'endDate', in: 'query', schema: { type: 'string', format: 'date-time' } }
        ],
        responses: {
          '200': {
            description: 'List of alerts',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: { type: 'array', items: { $ref: '#/components/schemas/Alert' } },
                    pagination: { $ref: '#/components/schemas/Pagination' }
                  }
                }
              }
            }
          }
        }
      }
    },
    '/alerts/summary': {
      get: {
        tags: ['Alerts'],
        summary: 'Get alert summary',
        description: 'Get counts by severity and status',
        parameters: [{ $ref: '#/components/parameters/orgIdParam' }],
        responses: {
          '200': {
            description: 'Alert summary',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/AlertSummary' }
              }
            }
          }
        }
      }
    },
    '/alerts/{id}': {
      get: {
        tags: ['Alerts'],
        summary: 'Get alert details',
        parameters: [{ $ref: '#/components/parameters/idParam' }],
        responses: {
          '200': {
            description: 'Alert details',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Alert' }
              }
            }
          }
        }
      }
    },
    '/alerts/{id}/acknowledge': {
      post: {
        tags: ['Alerts'],
        summary: 'Acknowledge alert',
        parameters: [{ $ref: '#/components/parameters/idParam' }],
        responses: {
          '200': {
            description: 'Alert acknowledged',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Alert' }
              }
            }
          }
        }
      }
    },
    '/alerts/{id}/resolve': {
      post: {
        tags: ['Alerts'],
        summary: 'Resolve alert',
        parameters: [{ $ref: '#/components/parameters/idParam' }],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  note: { type: 'string' }
                }
              }
            }
          }
        },
        responses: {
          '200': {
            description: 'Alert resolved',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Alert' }
              }
            }
          }
        }
      }
    },
    '/alerts/{id}/suppress': {
      post: {
        tags: ['Alerts'],
        summary: 'Suppress alert',
        parameters: [{ $ref: '#/components/parameters/idParam' }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  until: { type: 'string', format: 'date-time' }
                },
                required: ['until']
              }
            }
          }
        },
        responses: {
          '200': {
            description: 'Alert suppressed',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Alert' }
              }
            }
          }
        }
      }
    },
    '/alerts/rules': {
      get: {
        tags: ['Alerts'],
        summary: 'List alert rules',
        parameters: [
          { $ref: '#/components/parameters/pageParam' },
          { $ref: '#/components/parameters/limitParam' },
          { $ref: '#/components/parameters/orgIdParam' },
          { name: 'enabled', in: 'query', schema: { type: 'string', enum: ['true', 'false'] } },
          { name: 'severity', in: 'query', schema: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'info'] } }
        ],
        responses: {
          '200': {
            description: 'List of alert rules',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: { type: 'array', items: { $ref: '#/components/schemas/AlertRule' } },
                    pagination: { $ref: '#/components/schemas/Pagination' }
                  }
                }
              }
            }
          }
        }
      },
      post: {
        tags: ['Alerts'],
        summary: 'Create alert rule',
        responses: {
          '201': {
            description: 'Rule created',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/AlertRule' }
              }
            }
          }
        }
      }
    },
    '/alerts/channels': {
      get: {
        tags: ['Alerts'],
        summary: 'List notification channels',
        parameters: [
          { $ref: '#/components/parameters/pageParam' },
          { $ref: '#/components/parameters/limitParam' },
          { $ref: '#/components/parameters/orgIdParam' },
          { name: 'type', in: 'query', schema: { type: 'string', enum: ['email', 'slack', 'teams', 'webhook', 'pagerduty', 'sms'] } }
        ],
        responses: {
          '200': {
            description: 'List of channels',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: { type: 'array', items: { $ref: '#/components/schemas/NotificationChannel' } },
                    pagination: { $ref: '#/components/schemas/Pagination' }
                  }
                }
              }
            }
          }
        }
      },
      post: {
        tags: ['Alerts'],
        summary: 'Create notification channel',
        responses: {
          '201': {
            description: 'Channel created',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/NotificationChannel' }
              }
            }
          }
        }
      }
    },
    '/alerts/channels/{id}/test': {
      post: {
        tags: ['Alerts'],
        summary: 'Test notification channel',
        parameters: [{ $ref: '#/components/parameters/idParam' }],
        responses: {
          '200': {
            description: 'Test result',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    channelId: { type: 'string', format: 'uuid' },
                    testResult: { type: 'object' },
                    testedAt: { type: 'string', format: 'date-time' }
                  }
                }
              }
            }
          }
        }
      }
    },
    '/alerts/policies': {
      get: {
        tags: ['Alerts'],
        summary: 'List escalation policies',
        responses: {
          '200': {
            description: 'List of policies',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: { type: 'array', items: { $ref: '#/components/schemas/EscalationPolicy' } },
                    pagination: { $ref: '#/components/schemas/Pagination' }
                  }
                }
              }
            }
          }
        }
      },
      post: {
        tags: ['Alerts'],
        summary: 'Create escalation policy',
        responses: {
          '201': {
            description: 'Policy created',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/EscalationPolicy' }
              }
            }
          }
        }
      }
    },

    // ============================================
    // AUTOMATION ENDPOINTS
    // ============================================
    '/automations': {
      get: {
        tags: ['Automations'],
        summary: 'List automations',
        parameters: [
          { $ref: '#/components/parameters/pageParam' },
          { $ref: '#/components/parameters/limitParam' },
          { $ref: '#/components/parameters/orgIdParam' },
          { name: 'enabled', in: 'query', schema: { type: 'string', enum: ['true', 'false'] } }
        ],
        responses: {
          '200': {
            description: 'List of automations',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: { type: 'array', items: { $ref: '#/components/schemas/Automation' } },
                    pagination: { $ref: '#/components/schemas/Pagination' }
                  }
                }
              }
            }
          }
        }
      },
      post: {
        tags: ['Automations'],
        summary: 'Create automation',
        responses: {
          '201': {
            description: 'Automation created',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Automation' }
              }
            }
          }
        }
      }
    },
    '/automations/{id}': {
      get: {
        tags: ['Automations'],
        summary: 'Get automation',
        parameters: [{ $ref: '#/components/parameters/idParam' }],
        responses: {
          '200': {
            description: 'Automation details with run history',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Automation' }
              }
            }
          }
        }
      },
      put: {
        tags: ['Automations'],
        summary: 'Update automation',
        parameters: [{ $ref: '#/components/parameters/idParam' }],
        responses: {
          '200': {
            description: 'Automation updated',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Automation' }
              }
            }
          }
        }
      },
      delete: {
        tags: ['Automations'],
        summary: 'Delete automation',
        parameters: [{ $ref: '#/components/parameters/idParam' }],
        responses: {
          '200': {
            description: 'Automation deleted',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Success' }
              }
            }
          }
        }
      }
    },
    '/automations/{id}/trigger': {
      post: {
        tags: ['Automations'],
        summary: 'Trigger automation',
        description: 'Manually trigger an automation run',
        parameters: [{ $ref: '#/components/parameters/idParam' }],
        responses: {
          '200': {
            description: 'Automation triggered',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    message: { type: 'string' },
                    run: { $ref: '#/components/schemas/AutomationRun' }
                  }
                }
              }
            }
          }
        }
      }
    },
    '/automations/{id}/runs': {
      get: {
        tags: ['Automations'],
        summary: 'List automation runs',
        parameters: [
          { $ref: '#/components/parameters/idParam' },
          { $ref: '#/components/parameters/pageParam' },
          { $ref: '#/components/parameters/limitParam' },
          { name: 'status', in: 'query', schema: { type: 'string', enum: ['running', 'completed', 'failed', 'partial'] } }
        ],
        responses: {
          '200': {
            description: 'List of runs',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: { type: 'array', items: { $ref: '#/components/schemas/AutomationRun' } },
                    pagination: { $ref: '#/components/schemas/Pagination' }
                  }
                }
              }
            }
          }
        }
      }
    },
    '/automations/policies': {
      get: {
        tags: ['Automations'],
        summary: 'List policies',
        parameters: [
          { $ref: '#/components/parameters/pageParam' },
          { $ref: '#/components/parameters/limitParam' },
          { $ref: '#/components/parameters/orgIdParam' },
          { name: 'enforcement', in: 'query', schema: { type: 'string', enum: ['monitor', 'warn', 'enforce'] } }
        ],
        responses: {
          '200': {
            description: 'List of policies',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: { type: 'array', items: { $ref: '#/components/schemas/Policy' } },
                    pagination: { $ref: '#/components/schemas/Pagination' }
                  }
                }
              }
            }
          }
        }
      },
      post: {
        tags: ['Automations'],
        summary: 'Create policy',
        responses: {
          '201': {
            description: 'Policy created',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Policy' }
              }
            }
          }
        }
      }
    },
    '/automations/policies/compliance/summary': {
      get: {
        tags: ['Automations'],
        summary: 'Get compliance summary',
        parameters: [{ $ref: '#/components/parameters/orgIdParam' }],
        responses: {
          '200': {
            description: 'Compliance summary',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    totalPolicies: { type: 'integer' },
                    enabledPolicies: { type: 'integer' },
                    byEnforcement: { type: 'object' },
                    complianceOverview: { type: 'object' },
                    complianceRate: { type: 'integer' }
                  }
                }
              }
            }
          }
        }
      }
    },
    '/automations/policies/{id}/evaluate': {
      post: {
        tags: ['Automations'],
        summary: 'Evaluate policy',
        description: 'Force immediate policy evaluation',
        parameters: [{ $ref: '#/components/parameters/idParam' }],
        responses: {
          '200': {
            description: 'Evaluation completed',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    message: { type: 'string' },
                    devicesEvaluated: { type: 'integer' },
                    results: { type: 'array', items: { type: 'object' } },
                    summary: { type: 'object' }
                  }
                }
              }
            }
          }
        }
      }
    },
    '/automations/policies/{id}/compliance': {
      get: {
        tags: ['Automations'],
        summary: 'Get policy compliance',
        parameters: [
          { $ref: '#/components/parameters/idParam' },
          { $ref: '#/components/parameters/pageParam' },
          { $ref: '#/components/parameters/limitParam' },
          { name: 'status', in: 'query', schema: { type: 'string', enum: ['compliant', 'non_compliant', 'pending', 'error'] } }
        ],
        responses: {
          '200': {
            description: 'Compliance status per device',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: { type: 'array', items: { $ref: '#/components/schemas/PolicyCompliance' } },
                    pagination: { $ref: '#/components/schemas/Pagination' }
                  }
                }
              }
            }
          }
        }
      }
    },

    // ============================================
    // REPORT ENDPOINTS
    // ============================================
    '/reports': {
      get: {
        tags: ['Reports'],
        summary: 'List reports',
        parameters: [
          { $ref: '#/components/parameters/pageParam' },
          { $ref: '#/components/parameters/limitParam' },
          { $ref: '#/components/parameters/orgIdParam' },
          { name: 'type', in: 'query', schema: { type: 'string', enum: ['device_inventory', 'software_inventory', 'alert_summary', 'compliance', 'performance', 'executive_summary'] } },
          { name: 'schedule', in: 'query', schema: { type: 'string', enum: ['one_time', 'daily', 'weekly', 'monthly'] } }
        ],
        responses: {
          '200': {
            description: 'List of reports',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: { type: 'array', items: { $ref: '#/components/schemas/Report' } },
                    pagination: { $ref: '#/components/schemas/Pagination' }
                  }
                }
              }
            }
          }
        }
      },
      post: {
        tags: ['Reports'],
        summary: 'Create report',
        responses: {
          '201': {
            description: 'Report created',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Report' }
              }
            }
          }
        }
      }
    },
    '/reports/generate': {
      post: {
        tags: ['Reports'],
        summary: 'Generate ad-hoc report',
        description: 'Generate a report immediately without saving the configuration',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  type: { type: 'string', enum: ['device_inventory', 'software_inventory', 'alert_summary', 'compliance', 'performance', 'executive_summary'] },
                  config: { type: 'object' },
                  format: { type: 'string', enum: ['csv', 'pdf', 'excel'], default: 'csv' },
                  orgId: { type: 'string', format: 'uuid' }
                },
                required: ['type']
              }
            }
          }
        },
        responses: {
          '200': {
            description: 'Report data',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    type: { type: 'string' },
                    format: { type: 'string' },
                    generatedAt: { type: 'string', format: 'date-time' },
                    data: { type: 'object' }
                  }
                }
              }
            }
          }
        }
      }
    },
    '/reports/{id}/generate': {
      post: {
        tags: ['Reports'],
        summary: 'Generate saved report',
        parameters: [{ $ref: '#/components/parameters/idParam' }],
        responses: {
          '200': {
            description: 'Report generation started',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    message: { type: 'string' },
                    runId: { type: 'string', format: 'uuid' },
                    status: { type: 'string' }
                  }
                }
              }
            }
          }
        }
      }
    },
    '/reports/runs': {
      get: {
        tags: ['Reports'],
        summary: 'List report runs',
        parameters: [
          { $ref: '#/components/parameters/pageParam' },
          { $ref: '#/components/parameters/limitParam' },
          { name: 'reportId', in: 'query', schema: { type: 'string', format: 'uuid' } },
          { name: 'status', in: 'query', schema: { type: 'string', enum: ['pending', 'running', 'completed', 'failed'] } }
        ],
        responses: {
          '200': {
            description: 'List of report runs',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: { type: 'array', items: { $ref: '#/components/schemas/ReportRun' } },
                    pagination: { $ref: '#/components/schemas/Pagination' }
                  }
                }
              }
            }
          }
        }
      }
    },
    '/reports/data/device-inventory': {
      get: {
        tags: ['Reports'],
        summary: 'Get device inventory data',
        parameters: [
          { $ref: '#/components/parameters/orgIdParam' },
          { name: 'siteId', in: 'query', schema: { type: 'string', format: 'uuid' } }
        ],
        responses: {
          '200': {
            description: 'Device inventory data',
            content: {
              'application/json': {
                schema: { type: 'object' }
              }
            }
          }
        }
      }
    },

    // ============================================
    // REMOTE ACCESS ENDPOINTS
    // ============================================
    '/remote/sessions': {
      get: {
        tags: ['Remote'],
        summary: 'List remote sessions',
        parameters: [
          { $ref: '#/components/parameters/pageParam' },
          { $ref: '#/components/parameters/limitParam' },
          { name: 'deviceId', in: 'query', schema: { type: 'string', format: 'uuid' } },
          { name: 'status', in: 'query', schema: { type: 'string', enum: ['pending', 'connecting', 'active', 'disconnected', 'failed'] } },
          { name: 'type', in: 'query', schema: { type: 'string', enum: ['terminal', 'desktop', 'file_transfer'] } },
          { name: 'includeEnded', in: 'query', schema: { type: 'string', enum: ['true', 'false'] } }
        ],
        responses: {
          '200': {
            description: 'List of sessions',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: { type: 'array', items: { $ref: '#/components/schemas/RemoteSession' } },
                    pagination: { $ref: '#/components/schemas/Pagination' }
                  }
                }
              }
            }
          }
        }
      },
      post: {
        tags: ['Remote'],
        summary: 'Initiate remote session',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  deviceId: { type: 'string', format: 'uuid' },
                  type: { type: 'string', enum: ['terminal', 'desktop', 'file_transfer'] }
                },
                required: ['deviceId', 'type']
              }
            }
          }
        },
        responses: {
          '201': {
            description: 'Session created',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/RemoteSession' }
              }
            }
          },
          '429': { $ref: '#/components/responses/TooManyRequests' }
        }
      }
    },
    '/remote/sessions/{id}': {
      get: {
        tags: ['Remote'],
        summary: 'Get session details',
        parameters: [{ $ref: '#/components/parameters/idParam' }],
        responses: {
          '200': {
            description: 'Session details',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/RemoteSession' }
              }
            }
          }
        }
      }
    },
    '/remote/sessions/{id}/offer': {
      post: {
        tags: ['Remote'],
        summary: 'Submit WebRTC offer',
        description: 'Submit WebRTC SDP offer from client',
        parameters: [{ $ref: '#/components/parameters/idParam' }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  offer: { type: 'string' }
                },
                required: ['offer']
              }
            }
          }
        },
        responses: {
          '200': {
            description: 'Offer submitted',
            content: {
              'application/json': {
                schema: { type: 'object' }
              }
            }
          }
        }
      }
    },
    '/remote/sessions/{id}/answer': {
      post: {
        tags: ['Remote'],
        summary: 'Submit WebRTC answer',
        description: 'Submit WebRTC SDP answer from agent',
        parameters: [{ $ref: '#/components/parameters/idParam' }],
        responses: {
          '200': {
            description: 'Answer submitted',
            content: {
              'application/json': {
                schema: { type: 'object' }
              }
            }
          }
        }
      }
    },
    '/remote/sessions/{id}/ice': {
      post: {
        tags: ['Remote'],
        summary: 'Add ICE candidate',
        parameters: [{ $ref: '#/components/parameters/idParam' }],
        responses: {
          '200': {
            description: 'ICE candidate added',
            content: {
              'application/json': {
                schema: { type: 'object' }
              }
            }
          }
        }
      }
    },
    '/remote/sessions/{id}/end': {
      post: {
        tags: ['Remote'],
        summary: 'End session',
        parameters: [{ $ref: '#/components/parameters/idParam' }],
        responses: {
          '200': {
            description: 'Session ended',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/RemoteSession' }
              }
            }
          }
        }
      }
    },
    '/remote/transfers': {
      get: {
        tags: ['Remote'],
        summary: 'List file transfers',
        parameters: [
          { $ref: '#/components/parameters/pageParam' },
          { $ref: '#/components/parameters/limitParam' },
          { name: 'deviceId', in: 'query', schema: { type: 'string', format: 'uuid' } },
          { name: 'status', in: 'query', schema: { type: 'string', enum: ['pending', 'transferring', 'completed', 'failed'] } },
          { name: 'direction', in: 'query', schema: { type: 'string', enum: ['upload', 'download'] } }
        ],
        responses: {
          '200': {
            description: 'List of transfers',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: { type: 'array', items: { $ref: '#/components/schemas/FileTransfer' } },
                    pagination: { $ref: '#/components/schemas/Pagination' }
                  }
                }
              }
            }
          }
        }
      },
      post: {
        tags: ['Remote'],
        summary: 'Initiate file transfer',
        responses: {
          '201': {
            description: 'Transfer initiated',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/FileTransfer' }
              }
            }
          }
        }
      }
    },
    '/remote/transfers/{id}/cancel': {
      post: {
        tags: ['Remote'],
        summary: 'Cancel file transfer',
        parameters: [{ $ref: '#/components/parameters/idParam' }],
        responses: {
          '200': {
            description: 'Transfer cancelled',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/FileTransfer' }
              }
            }
          }
        }
      }
    },

    // ============================================
    // AGENT ENDPOINTS
    // ============================================
    '/agents/enroll': {
      post: {
        tags: ['Agents'],
        summary: 'Enroll agent',
        description: 'Register a new agent with an enrollment key',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/EnrollmentRequest' }
            }
          }
        },
        responses: {
          '201': {
            description: 'Agent enrolled',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/EnrollmentResponse' }
              }
            }
          },
          '401': {
            description: 'Invalid enrollment key',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Error' }
              }
            }
          }
        }
      }
    },
    '/agents/{id}/heartbeat': {
      post: {
        tags: ['Agents'],
        summary: 'Agent heartbeat',
        description: 'Send heartbeat with metrics and receive pending commands',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'Agent ID' }
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/HeartbeatRequest' }
            }
          }
        },
        responses: {
          '200': {
            description: 'Heartbeat processed',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/HeartbeatResponse' }
              }
            }
          },
          '404': { $ref: '#/components/responses/NotFound' }
        }
      }
    },
    '/agents/{id}/commands/{commandId}/result': {
      post: {
        tags: ['Agents'],
        summary: 'Submit command result',
        description: 'Report the result of a command execution',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'commandId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  status: { type: 'string', enum: ['completed', 'failed', 'timeout'] },
                  exitCode: { type: 'integer' },
                  stdout: { type: 'string' },
                  stderr: { type: 'string' },
                  durationMs: { type: 'integer' },
                  error: { type: 'string' }
                },
                required: ['status', 'durationMs']
              }
            }
          }
        },
        responses: {
          '200': {
            description: 'Result recorded',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Success' }
              }
            }
          }
        }
      }
    },
    '/agents/{id}/config': {
      get: {
        tags: ['Agents'],
        summary: 'Get agent config',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } }
        ],
        responses: {
          '200': {
            description: 'Agent configuration',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    heartbeatIntervalSeconds: { type: 'integer' },
                    metricsCollectionIntervalSeconds: { type: 'integer' },
                    enabledCollectors: { type: 'array', items: { type: 'string' } }
                  }
                }
              }
            }
          }
        }
      }
    },
    '/agents/{id}/hardware': {
      put: {
        tags: ['Agents'],
        summary: 'Update hardware info',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } }
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/DeviceHardware' }
            }
          }
        },
        responses: {
          '200': {
            description: 'Hardware info updated',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Success' }
              }
            }
          }
        }
      }
    },

    // ============================================
    // AUDIT ENDPOINTS
    // ============================================
    '/audit/logs': {
      get: {
        tags: ['Audit'],
        summary: 'Query audit logs',
        parameters: [
          { $ref: '#/components/parameters/pageParam' },
          { $ref: '#/components/parameters/limitParam' },
          { name: 'actorId', in: 'query', schema: { type: 'string', format: 'uuid' } },
          { name: 'actorType', in: 'query', schema: { type: 'string', enum: ['user', 'system', 'agent'] } },
          { name: 'action', in: 'query', schema: { type: 'string' } },
          { name: 'resourceType', in: 'query', schema: { type: 'string' } },
          { name: 'resourceId', in: 'query', schema: { type: 'string', format: 'uuid' } },
          { name: 'from', in: 'query', schema: { type: 'string', format: 'date-time' } },
          { name: 'to', in: 'query', schema: { type: 'string', format: 'date-time' } },
          { name: 'result', in: 'query', schema: { type: 'string', enum: ['success', 'failure'] } }
        ],
        responses: {
          '200': {
            description: 'Audit logs',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: { type: 'array', items: { $ref: '#/components/schemas/AuditLog' } },
                    pagination: { $ref: '#/components/schemas/Pagination' }
                  }
                }
              }
            }
          }
        }
      }
    },
    '/audit/logs/export': {
      get: {
        tags: ['Audit'],
        summary: 'Export audit logs',
        parameters: [
          { name: 'format', in: 'query', schema: { type: 'string', enum: ['json', 'csv'], default: 'json' } },
          { name: 'from', in: 'query', schema: { type: 'string', format: 'date-time' } },
          { name: 'to', in: 'query', schema: { type: 'string', format: 'date-time' } }
        ],
        responses: {
          '200': {
            description: 'Exported audit logs',
            content: {
              'application/json': {
                schema: { type: 'object' }
              },
              'text/csv': {
                schema: { type: 'string' }
              }
            }
          }
        }
      }
    },
    '/audit/summary': {
      get: {
        tags: ['Audit'],
        summary: 'Get activity summary',
        parameters: [
          { name: 'from', in: 'query', schema: { type: 'string', format: 'date-time' } },
          { name: 'to', in: 'query', schema: { type: 'string', format: 'date-time' } }
        ],
        responses: {
          '200': {
            description: 'Activity summary',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    totalActions: { type: 'integer' },
                    byAction: { type: 'object' },
                    byActor: { type: 'array', items: { type: 'object' } },
                    byResource: { type: 'object' },
                    recentActivity: { type: 'array', items: { type: 'object' } }
                  }
                }
              }
            }
          }
        }
      }
    },
    '/audit/logs/{id}': {
      get: {
        tags: ['Audit'],
        summary: 'Get audit log entry',
        parameters: [{ $ref: '#/components/parameters/idParam' }],
        responses: {
          '200': {
            description: 'Audit log entry',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/AuditLog' }
              }
            }
          }
        }
      }
    }
  }
} as const;

export type OpenApiSpec = typeof openApiSpec;
