---
name: codex-delegation
description: Orchestrate tasks between Claude and OpenAI Codex CLI to optimize work across both AI agents. Use Codex for isolated, mechanical tasks while Claude handles architecture, security, and coordination.
---

# Codex Delegation Guide

This skill enables efficient task orchestration between Claude and OpenAI Codex CLI.

## Quick Reference

```bash
# Standard task
codex exec "<task>" --full-auto -C "/path/to/project"

# With reasoning level
codex exec "<task>" --full-auto -c 'model_reasoning_effort="xhigh"'

# With web search
codex exec "<task>" --full-auto --search

# Resume previous session
codex exec resume --last "<follow-up task>"
```

## When to Delegate to Codex

### Good for Codex
| Task Type | Example | Reasoning Level |
|-----------|---------|-----------------|
| File operations | "List all TypeScript files in src/" | low |
| Simple utilities | "Create a formatBytes function" | medium |
| CRUD endpoints | "Add GET /api/users/:id endpoint following existing patterns" | medium |
| Test generation | "Write tests for the auth service" | medium |
| Code reading | "Summarize what this file does" | medium |
| Refactoring | "Rename all occurrences of X to Y" | low |
| Build/lint fixes | "Fix the TypeScript errors" | medium |
| Security analysis | "Review this code for vulnerabilities" | high |
| Architecture design | "Design a rate limiting strategy" | xhigh |

### Keep with Claude
| Task Type | Reason |
|-----------|--------|
| Multi-tenant security | Requires deep context about isolation patterns |
| Business logic | Domain-specific knowledge needed |
| Cross-module refactoring | Needs holistic codebase understanding |
| Coordination | Orchestrating multiple tasks |
| Code review integration | Needs to verify and integrate results |
| Security-critical auth | JWT, sessions, RBAC implementation |

## Reasoning Effort Levels

Configure with `-c 'model_reasoning_effort="<level>"'`

| Level | Tokens | Style | Best For |
|-------|--------|-------|----------|
| `low` | Higher | Verbose, detailed | Simple/mechanical tasks, file ops |
| `medium` | Balanced | Standard | Code generation, comprehension |
| `high` | Moderate | Thoughtful | Code review, debugging, analysis |
| `xhigh` | Lower | Strategic, concise | Architecture, complex trade-offs |

**Key finding**: `xhigh` produces more strategic, concise output with fewer tokens. `low` is verbose but thorough for mechanical tasks.

## Common Patterns

### Parallel Execution
Run independent Codex tasks simultaneously:
```bash
# In separate terminals or background
codex exec "task 1" --full-auto &
codex exec "task 2" --full-auto &
wait
```

### Session Resumption
Continue previous work without re-explaining context:
```bash
codex exec resume --last "Now fix the issues you found"
```

### Output Capture
Save results for parsing:
```bash
codex exec "<task>" --full-auto --json -o results.txt
```

### Additional Directories
Grant access beyond workspace:
```bash
codex exec "<task>" --full-auto --add-dir /other/path
```

## Tested Capabilities (gpt-5.2-codex)

| Capability | Quality | Token Cost |
|------------|---------|------------|
| File search/listing | Excellent | ~1.3k |
| Code comprehension | Excellent | ~2.9k |
| Utility generation | Excellent | ~3.5k |
| Security analysis | Excellent | ~2.4-4.7k |
| Architecture design | Excellent | ~1.6-4.7k |

Codex proactively:
- Creates necessary directories
- Updates barrel exports
- Follows project conventions
- Uses efficient tools (`rg` over `grep`)

## Error Handling

1. **Check exit codes**: Non-zero means failure
2. **Parse output**: Look for error messages in response
3. **Fallback**: If Codex fails, Claude handles the task
4. **Verify**: Always review Codex output before integrating

## Model Configuration

- **Default model**: `gpt-5.2-codex` (ChatGPT account)
- **Config file**: `~/.codex/config.toml`
- **Override model**: `-m "model-name"`

## Integration Workflow

1. **Claude analyzes task** - Breaks down into subtasks
2. **Identify delegation candidates** - Match to Codex strengths
3. **Set appropriate reasoning level** - Based on task complexity
4. **Execute via Codex** - Using `codex exec --full-auto`
5. **Claude reviews output** - Verify quality and correctness
6. **Integrate results** - Claude coordinates final assembly
