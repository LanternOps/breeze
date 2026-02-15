/**
 * API Documentation Routes
 *
 * Serves OpenAPI specification and Swagger UI for interactive API documentation.
 */

import { Hono } from 'hono';
import { openApiSpec } from '../openapi';
import { envFlag } from '../utils/envFlag';

export const docsRoutes = new Hono();

const ENABLE_DOCS_UI = envFlag(
  'ENABLE_API_DOCS_UI',
  (process.env.NODE_ENV ?? 'development') !== 'production'
);

/**
 * Swagger UI HTML template
 */
const swaggerUIHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Breeze RMM API Documentation</title>
  <link rel="stylesheet" type="text/css" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css">
  <style>
    html {
      box-sizing: border-box;
      overflow: -moz-scrollbars-vertical;
      overflow-y: scroll;
    }
    *,
    *:before,
    *:after {
      box-sizing: inherit;
    }
    body {
      margin: 0;
      background: #fafafa;
    }
    .swagger-ui .topbar {
      display: none;
    }
    .swagger-ui .info {
      margin: 30px 0;
    }
    .swagger-ui .info .title {
      color: #3b82f6;
    }
    .swagger-ui .opblock-tag {
      border-bottom: 1px solid rgba(59, 130, 246, 0.3);
    }
    .swagger-ui .opblock.opblock-get .opblock-summary-method {
      background: #3b82f6;
    }
    .swagger-ui .opblock.opblock-post .opblock-summary-method {
      background: #10b981;
    }
    .swagger-ui .opblock.opblock-put .opblock-summary-method {
      background: #f59e0b;
    }
    .swagger-ui .opblock.opblock-delete .opblock-summary-method {
      background: #ef4444;
    }
    .swagger-ui .opblock.opblock-patch .opblock-summary-method {
      background: #8b5cf6;
    }
    .swagger-ui .btn.execute {
      background-color: #3b82f6;
      border-color: #3b82f6;
    }
    .swagger-ui .btn.execute:hover {
      background-color: #2563eb;
      border-color: #2563eb;
    }
    /* Custom header */
    .custom-header {
      background: linear-gradient(135deg, #3b82f6 0%, #1d4ed8 100%);
      padding: 20px 40px;
      color: white;
    }
    .custom-header h1 {
      margin: 0;
      font-size: 24px;
      font-weight: 600;
    }
    .custom-header p {
      margin: 8px 0 0;
      opacity: 0.9;
      font-size: 14px;
    }
  </style>
</head>
<body>
  <div class="custom-header">
    <h1>Breeze RMM API</h1>
    <p>Modern Remote Monitoring and Management Platform</p>
  </div>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-standalone-preset.js"></script>
  <script>
    window.onload = function() {
      const ui = SwaggerUIBundle({
        url: "/api/v1/docs/openapi.json",
        dom_id: '#swagger-ui',
        deepLinking: true,
        presets: [
          SwaggerUIBundle.presets.apis,
          SwaggerUIStandalonePreset
        ],
        plugins: [
          SwaggerUIBundle.plugins.DownloadUrl
        ],
        layout: "StandaloneLayout",
        persistAuthorization: true,
        filter: true,
        tagsSorter: "alpha",
        operationsSorter: "alpha",
        docExpansion: "list",
        defaultModelsExpandDepth: 2,
        defaultModelExpandDepth: 2,
        syntaxHighlight: {
          activate: true,
          theme: "monokai"
        }
      });
      window.ui = ui;
    };
  </script>
</body>
</html>`;

/**
 * GET /docs
 * Serves Swagger UI HTML for interactive API documentation
 */
docsRoutes.get('/', (c) => {
  if (!ENABLE_DOCS_UI) {
    return c.json({
      error: 'Interactive API docs are disabled',
      openApiJson: '/api/v1/docs/openapi.json',
      openApiYaml: '/api/v1/docs/openapi.yaml'
    }, 404);
  }

  return c.html(swaggerUIHtml);
});

/**
 * GET /docs/openapi.json
 * Returns the OpenAPI specification as JSON
 */
docsRoutes.get('/openapi.json', (c) => {
  return c.json(openApiSpec);
});

/**
 * GET /docs/openapi.yaml
 * Returns the OpenAPI specification as YAML (basic conversion)
 */
docsRoutes.get('/openapi.yaml', (c) => {
  // Simple JSON to YAML conversion for basic compatibility
  const yaml = jsonToYaml(openApiSpec);
  return c.text(yaml, 200, {
    'Content-Type': 'application/x-yaml'
  });
});

/**
 * Basic JSON to YAML converter for OpenAPI spec
 */
function jsonToYaml(obj: unknown, indent = 0): string {
  const spaces = '  '.repeat(indent);

  if (obj === null || obj === undefined) {
    return 'null';
  }

  if (typeof obj === 'string') {
    // Check if string needs quoting
    if (
      obj.includes('\n') ||
      obj.includes(':') ||
      obj.includes('#') ||
      obj.includes("'") ||
      obj.includes('"') ||
      obj.startsWith(' ') ||
      obj.endsWith(' ')
    ) {
      // Use literal block style for multiline strings
      if (obj.includes('\n')) {
        const lines = obj.split('\n');
        return `|\n${lines.map((line) => spaces + '  ' + line).join('\n')}`;
      }
      // Quote single-line strings that need it
      // YAML double-quoted scalars treat backslash as an escape character, so we must escape it too.
      return `"${obj.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    }
    return obj;
  }

  if (typeof obj === 'number' || typeof obj === 'boolean') {
    return String(obj);
  }

  if (Array.isArray(obj)) {
    if (obj.length === 0) return '[]';
    return obj
      .map((item) => {
        const value = jsonToYaml(item, indent + 1);
        if (typeof item === 'object' && item !== null) {
          return `\n${spaces}- ${value.trim().replace(/^\n/, '').replace(/^  /gm, '')}`;
        }
        return `\n${spaces}- ${value}`;
      })
      .join('');
  }

  if (typeof obj === 'object') {
    const entries = Object.entries(obj);
    if (entries.length === 0) return '{}';
    return entries
      .map(([key, value]) => {
        const yamlValue = jsonToYaml(value, indent + 1);
        if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
          return `\n${spaces}${key}:${yamlValue}`;
        }
        if (Array.isArray(value)) {
          return `\n${spaces}${key}:${yamlValue}`;
        }
        return `\n${spaces}${key}: ${yamlValue}`;
      })
      .join('');
  }

  return String(obj);
}
