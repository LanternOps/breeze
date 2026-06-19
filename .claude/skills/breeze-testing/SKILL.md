---
name: breeze-testing
description: Writing guidelines for Breeze RMM tests — API route (Vitest + Drizzle mocks), Go agent, shared validators, and the required coverage checklist for every new feature. Use when writing or modifying tests in this repo.
---

# Breeze Testing

Project-specific conventions for writing tests. Frameworks and file placement live in CLAUDE.md; this skill covers the writing craft: patterns that catch real bugs, gotchas that burn people, and the coverage contract every new feature must satisfy.

## Writing API Route Tests (Vitest)

- Mock Drizzle ORM query chains matching the exact chain pattern in the source (e.g., `select().from().where()`).
- Always test **multi-tenant isolation** — verify org-scoped data can't be accessed cross-org.
- Test all HTTP methods, auth/authz, Zod validation failures, not-found, and error cases.
- Use proper UUIDs in mock data — Zod validates UUID format and will reject `'other-org'`.
- Avoid trailing slashes in test URLs — Hono sub-routers return 404 for trailing slashes.
- `vi.mock` factories are hoisted — don't reference module-level `const` values inside them; use literal values instead.
- Read 2-3 existing test files in the same directory before writing new ones to match patterns.

## Writing Go Agent Tests

- Use **table-driven tests** for functions with multiple input/output combinations.
- Always run with `-race` flag to catch data races.
- Mock external dependencies (network, OS, filesystem) — never make real network calls.
- Use build tags for platform-specific tests: `//go:build !windows` or `//go:build darwin`.
- Test nil/empty inputs, error paths, and concurrency safety (spawn goroutines in tests).
- Place test helpers in the same package, not in a separate `_test` package.

## Writing Shared Validator Tests

- Test valid inputs, invalid inputs, boundary values, and Zod defaults/coercion.
- For discriminated unions, test each variant separately.
- Test `omitempty`/optional fields with both present and absent values.
- For schemas with `superRefine`, test all validation branches.

## Coverage Contract — Every New Feature Must Test

1. **Happy path** — basic success case.
2. **Auth/authz** — unauthenticated, wrong role, wrong org.
3. **Validation** — missing required fields, invalid types, boundary values.
4. **Multi-tenant isolation** — cross-org access denied.
5. **Error cases** — not found, conflict, server error.
6. **Edge cases** — empty arrays, nil inputs, concurrent access.

## Related

- Frameworks, file placement, and CI integration: see `CLAUDE.md` → Testing Standards.
- Post-implementation end-to-end verification: use the `feature-testing` skill.
