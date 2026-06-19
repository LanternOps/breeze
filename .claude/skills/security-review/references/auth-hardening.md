# Authentication and Authorization Hardening Reference

## Key Files

| File | Purpose |
|------|---------|
| `apps/api/src/middleware/auth.ts` | JWT validation, scope resolution, `orgCondition()` |
| `apps/api/src/middleware/apiKeyAuth.ts` | API key auth (SHA-256 hash, `brz_` prefix, expiry) |
| `apps/api/src/middleware/agentAuth.ts` | Agent bearer token auth (SHA-256 hash, rate limit) |
| `apps/api/src/routes/auth/login.ts` | Login with rate limiting (5/5min per IP+email) |
| `apps/api/src/routes/auth/register.ts` | Registration with rate limiting (5/hr) |
| `apps/api/src/routes/auth/mfa.ts` | MFA setup and verification |
| `apps/api/src/services/permissions.ts` | RBAC permission system |
| `apps/api/src/services/enrollmentKeySecurity.ts` | Enrollment key hashing with pepper |
| `apps/api/src/routes/agents/enrollment.ts` | Agent enrollment (timing-safe secret check) |

## Auth Flow Summary

```
Login → JWT (access + refresh) → authMiddleware validates on every request
  ├── Checks signature + expiry
  ├── Checks revocation (Redis)
  ├── Resolves scope (system/partner/org)
  ├── Computes accessibleOrgIds
  └── Sets DB context (RLS)
```

## Token Types

| Type | Format | Storage | Validation |
|------|--------|---------|------------|
| JWT access | Bearer header | Client memory | Signature + expiry + revocation |
| JWT refresh | httpOnly cookie | Browser cookie | Signature + expiry + CSRF header |
| API key | `brz_*` in `X-API-Key` header | SHA-256 hash in DB | Hash match + expiry + status |
| Agent token | `brz_*` in Bearer header | SHA-256 hash in `devices.agentTokenHash` | Hash match + device status |
| Enrollment key | Request body | Peppered SHA-256 hash in DB | Timing-safe compare + usage/expiry |
| WS ticket | Query param | Redis (single-use) | Consume-on-use + session match |

## Common Auth Vulnerabilities to Check

1. **Token confusion**: Refresh token accepted where access token expected (check `type` claim)
2. **Scope escalation**: Org user accessing partner/system routes (check `requireScope()`)
3. **Missing auth middleware**: Route handler without `authMiddleware` or `agentAuthMiddleware`
4. **IDOR via missing ownership check**: Authenticated user accessing another user's resources
5. **Race condition on token revocation**: Token revoked but still valid in cache
6. **API key reuse**: Same key hash allows access after key is rotated/deleted
7. **Agent impersonation**: Compromised agent token used to access other devices
8. **Enrollment replay**: Same enrollment key reused after consumption
9. **CSRF on state-changing GET**: Mutations on GET without CSRF protection
10. **Password reset token not invalidated**: Old reset tokens still work after password change

## Audit Procedure

1. **List all routes**: Grep for `.get(`, `.post(`, `.put(`, `.patch(`, `.delete(` in route files
2. **Check middleware chain**: Each route should have auth middleware BEFORE the handler
3. **Identify public routes**: Any route without `authMiddleware` — verify intentional
4. **Check scope requirements**: Admin operations should have `requireScope('system')` or `requireScope('partner')`
5. **Check permission requirements**: Sensitive operations should have `requirePermission('resource:action')`
6. **Verify token handling**: No tokens logged, no tokens in URL params (except WS tickets)
7. **Check cookie security**: `httpOnly`, `secure`, `sameSite` flags on refresh token cookie
