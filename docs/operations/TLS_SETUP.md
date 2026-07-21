# TLS / HTTPS Setup Guide

This guide covers how to terminate TLS in front of the Breeze API and configure the related environment variables.

## Architecture

```
Client (HTTPS) --> Reverse Proxy (TLS termination) --> Breeze API (HTTP, localhost:3001)
```

The Breeze API runs as a plain HTTP server. TLS is terminated by a reverse proxy (Caddy or nginx) which forwards requests over localhost. The proxy must set the `X-Forwarded-Proto` header so the API knows the original protocol.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `FORCE_HTTPS` | *(unset)* | Set to `true` to redirect HTTP requests to HTTPS. The API checks the `X-Forwarded-Proto` header to determine the original protocol. Health check paths (`/health`, `/ready`) are excluded from redirects. |
| `CSP_REPORT_URI` | *(unset)* | URL where browsers send Content Security Policy violation reports. When set, the API adds `report-uri` and `report-to` directives to the CSP header. Example: `https://csp.example.com/report` |
| `NODE_ENV` | `development` | When set to `production`, the API adds the `Strict-Transport-Security` header (HSTS) with a 1-year max-age. |

## Option A: Caddy (Recommended)

Caddy automatically provisions and renews Let's Encrypt certificates with zero configuration.

### Install Caddy

```bash
# macOS
brew install caddy

# Ubuntu/Debian
sudo apt install -y caddy

# Or download from https://caddyserver.com/download
```

### Caddyfile

Create `/etc/caddy/Caddyfile`:

```caddyfile
breeze.example.com {
    # Caddy automatically:
    # - Obtains Let's Encrypt certificates
    # - Redirects HTTP -> HTTPS
    # - Sets X-Forwarded-Proto header
    # - Renews certificates before expiry

    # WebSocket support is handled natively by Caddy
    # No extra config needed for /api/v1/agent-ws/*/ws

    reverse_proxy localhost:3001 {
        # Disable read timeout for long-running WebSocket connections
        transport http {
            read_timeout 0
        }
    }
}
```

### Start Caddy

```bash
# Foreground (for testing)
caddy run --config /etc/caddy/Caddyfile

# As a system service
sudo systemctl enable --now caddy
```

### Breeze API Environment

```env
FORCE_HTTPS=true
NODE_ENV=production
# Optional:
# CSP_REPORT_URI=https://csp.example.com/report
```

## Option B: nginx + certbot

### Install nginx and certbot

```bash
# Ubuntu/Debian
sudo apt install -y nginx certbot python3-certbot-nginx

# RHEL/Rocky
sudo dnf install -y nginx certbot python3-certbot-nginx
```

### Obtain Certificate

```bash
sudo certbot --nginx -d breeze.example.com
```

Certbot will automatically modify your nginx config. Renewal is handled by a systemd timer (`certbot.timer`) or cron job.

### nginx Configuration

Create `/etc/nginx/sites-available/breeze`:

```nginx
# Redirect HTTP -> HTTPS
server {
    listen 80;
    server_name breeze.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name breeze.example.com;

    # Certificates managed by certbot
    ssl_certificate     /etc/letsencrypt/live/breeze.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/breeze.example.com/privkey.pem;

    # Modern TLS settings
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384;
    ssl_prefer_server_ciphers off;

    # OCSP stapling
    ssl_stapling on;
    ssl_stapling_verify on;

    # Proxy to Breeze API
    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # WebSocket support for agent connections
    location ~ ^/api/v1/(agent-ws|remote/sessions|desktop-ws)/ {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Disable buffering for real-time data
        proxy_buffering off;

        # Keep WebSocket connections alive
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }
}
```

### Enable and Start

```bash
sudo ln -s /etc/nginx/sites-available/breeze /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

### Breeze API Environment

```env
FORCE_HTTPS=true
NODE_ENV=production
# Optional:
# CSP_REPORT_URI=https://csp.example.com/report
```

## Trusted Proxy Headers

The `FORCE_HTTPS` redirect relies on the `X-Forwarded-Proto` header set by the reverse proxy. This is safe when:

1. The Breeze API is **not** directly exposed to the internet (it listens on `localhost:3001`).
2. Only the reverse proxy (Caddy/nginx) can reach the API.
3. The reverse proxy sets `X-Forwarded-Proto` to the actual client protocol.

If the API were exposed directly, a malicious client could forge the `X-Forwarded-Proto` header to bypass the HTTPS redirect. Always run the API behind a trusted reverse proxy in production.

## Security Headers Reference

The following security headers are set by the Breeze API (via `secureHeaders` from Hono and the custom `securityMiddleware`):

| Header | Value | Source |
|--------|-------|--------|
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` | secureHeaders (production) |
| `X-Content-Type-Options` | `nosniff` | secureHeaders |
| `X-Frame-Options` | `DENY` | secureHeaders |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | secureHeaders |
| `Content-Security-Policy` | See below | securityMiddleware |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=()` | securityMiddleware |
| `Cross-Origin-Resource-Policy` | `same-origin` | secureHeaders |
| `Cross-Origin-Opener-Policy` | `same-origin` | secureHeaders |
| `X-DNS-Prefetch-Control` | `off` | secureHeaders |
| `X-Download-Options` | `noopen` | secureHeaders |
| `X-Permitted-Cross-Domain-Policies` | `none` | secureHeaders |

### Content Security Policy

```
default-src 'self';
script-src 'self' 'unsafe-inline';
style-src 'self' 'unsafe-inline';
img-src 'self' data: blob:;
font-src 'self';
connect-src 'self' ws: wss:;
frame-ancestors 'none';
base-uri 'self';
form-action 'self'
```

The `script-src` allows `unsafe-inline` for inline scripts used by API documentation pages (Swagger UI). The `connect-src` includes `ws:` and `wss:` for WebSocket connections used by the agent communication layer and remote terminal/desktop features.

## Verifying the Setup

After deploying, verify headers with curl:

```bash
curl -I https://breeze.example.com/health
```

Expected headers (subset):

```
Strict-Transport-Security: max-age=31536000; includeSubDomains
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline'; ...
Referrer-Policy: strict-origin-when-cross-origin
Permissions-Policy: camera=(), microphone=(), geolocation=()
```

You can also use [Mozilla Observatory](https://observatory.mozilla.org/) or [securityheaders.com](https://securityheaders.com/) to audit the deployed headers.
