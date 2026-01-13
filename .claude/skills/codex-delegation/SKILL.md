---
name: codex-delegation
description: This skill should be used when delegating specific subtasks to OpenAI Codex CLI to optimize subscription usage across both AI agents. Use this for simple, isolated tasks that don't require deep codebase understanding or multi-tenant security context.
---

# Codex Delegation Skill

This skill provides guidance for effectively delegating tasks to OpenAI Codex CLI to optimize token usage and subscription costs across both Claude and Codex.

## When to Delegate to Codex

Delegate tasks to Codex when they are:

1. **Simple and isolated** - Tasks that don't require understanding the broader codebase context
2. **Mechanical operations** - File operations, formatting, running commands
3. **Testing and validation** - Running test suites, checking code style, validation
4. **Package management** - Installing dependencies, updating packages
5. **Git operations** - Simple commits, status checks, branch operations
6. **Quick fixes** - Isolated bug fixes in single files
7. **Script execution** - Running scripts, data processing tasks
8. **File searching** - When quick grep/search results are needed

## When NOT to Delegate to Codex

Keep tasks with Claude when they require:

1. **High-level planning** - Architecture decisions, complex refactoring
2. **Security-sensitive operations** - Multi-tenant isolation, authentication, authorization
3. **Django/ORM expertise** - Migrations, models, views, complex queries
4. **Deep codebase understanding** - Multi-file refactoring, cross-module changes
5. **Business logic** - Domain-specific requirements, MSP features
6. **Code review** - Quality analysis, security audits
7. **Coordination** - Managing multiple subtasks, orchestration
8. **OliveConnect-specific patterns** - tenant isolation, RAG system, integrations

## Delegation Methods

### Method 1: Exec Mode (Non-Interactive, Recommended)

Use `codex exec` for quick, non-interactive tasks:

```bash
codex exec "<task description>" --full-auto
```

**Options:**
- `--full-auto` - Automatic execution with workspace-write sandbox (recommended)
- `--dangerously-bypass-approvals-and-sandbox` - Skip all confirmations (use with caution)
- `-m <model>` - Specify model (default: gpt-5.2-codex medium)
- `-C <dir>` - Set working directory
- `--search` - Enable web search capability

**Example:**
```bash
codex exec "Run the test suite for the integrations app and show me the results" --full-auto
```

### Method 2: Apply Mode (For Diffs)

When Codex generates code changes, apply them with:

```bash
codex apply
```

This applies the latest diff from Codex agent as a git patch.

### Method 3: Interactive Mode

For complex tasks requiring back-and-forth:

```bash
codex "initial prompt" --full-auto
```

This starts an interactive session. Use sparingly as it consumes more tokens.

## Task Delegation Workflow

When receiving a complex task from the user:

1. **Analyze the task** - Break down into subtasks
2. **Identify delegation candidates** - Which subtasks fit the "delegate to Codex" criteria?
3. **Delegate simple tasks** - Use `codex exec` for mechanical operations
4. **Monitor results** - Parse Codex output and handle errors
5. **Continue with complex tasks** - Handle the remaining work that requires Claude's expertise
6. **Coordinate** - Integrate Codex results with Claude's work

## Error Handling

When delegating to Codex:

1. **Check exit status** - Codex exec returns non-zero on failures
2. **Parse output** - Codex includes thinking and execution details
3. **Retry strategy** - If Codex fails, attempt the task with Claude
4. **Context preservation** - Keep track of what Codex did for continuity

## Output Parsing

Codex output includes:
- **Configuration header** - workdir, model, approval, sandbox settings
- **Session ID** - For tracking
- **Thinking blocks** - Codex's reasoning
- **Exec blocks** - Commands executed and results
- **Token usage** - Track consumption

Extract relevant information and present it clearly to the user.

## Examples

### Good Delegation: Running Tests
```bash
codex exec "Run the Django test suite for the integrations app and summarize any failures" --full-auto
```

### Good Delegation: Package Installation
```bash
codex exec "Install the latest version of requests package using pip" --full-auto
```

### Good Delegation: File Search
```bash
codex exec "Find all files that import PowerDMARC models" --full-auto
```

### Bad Delegation: Security-Sensitive
❌ Don't delegate: "Update the tenant_objects manager to fix isolation"
✓ Handle with Claude: Requires deep understanding of multi-tenant security

### Bad Delegation: Complex Refactoring
❌ Don't delegate: "Refactor the RAG ingestion pipeline"
✓ Handle with Claude: Requires understanding of architecture

## Best Practices

1. **Be specific** - Give Codex clear, actionable tasks
2. **Set timeouts** - Use `timeout` parameter for long-running commands
3. **Sandbox mode** - Always use `--full-auto` for safety
4. **Monitor costs** - Track token usage from both agents
5. **Maintain context** - Keep user informed about what was delegated
6. **Verify results** - Don't blindly trust Codex output
7. **Fail gracefully** - Have fallback plans when delegation fails

## Script: delegate_to_codex.sh

A helper script is provided in `scripts/delegate_to_codex.sh` for common delegation patterns.

Usage:
```bash
scripts/delegate_to_codex.sh "<task>" [--model <model>] [--dir <directory>] [--search] [--timeout <seconds>]
```

**Options:**
- `--model <model>` - Specify model (default: gpt-5.2-codex medium, or set via `CODEX_MODEL` env var)
- `--dir <directory>` - Set working directory (default: current directory)
- `--search` - Enable web search capability
- `--timeout <seconds>` - Command timeout in seconds (default: 120)

**Examples:**
```bash
# Run tests
scripts/delegate_to_codex.sh "Run the test suite"

# Install package in specific directory
scripts/delegate_to_codex.sh "Install requests package" --dir /path/to/project

# Search with extended timeout
scripts/delegate_to_codex.sh "Find all TODO comments" --search --timeout 300
```
