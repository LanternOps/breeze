import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EXTERNAL_USES_RULE = 'external-uses-must-be-sha';
const PR_SECRET_RULE = 'pr-workflow-must-be-secret-free';
const PR_TARGET_HEAD_RULE = 'pr-target-must-not-execute-head';
const SIGNING_BUILD_RULE = 'signing-job-must-not-build-source';
const SIGNING_VERIFY_RULE = 'signing-job-must-verify-artifact-before-secrets';
const UNSUPPORTED_SYNTAX_RULE = 'unsupported-workflow-syntax';
const WINDOWS_SIGNING_PROVIDER_FAIL_CLOSED_RULE = 'windows-signing-provider-must-fail-closed';
const WINDOWS_SIGNING_PROVIDER_LEAST_PRIVILEGE_RULE = 'windows-signing-provider-least-privilege';
const SSLCOM_SIGNING_CERTIFICATE_PIN_RULE = 'sslcom-signing-must-pin-certificate';
const WINDOWS_SIGNING_TIMESTAMP_RULE = 'windows-signing-must-require-timestamp';
const SSLCOM_SIGNING_AGENT_ISOLATION_RULE = 'sslcom-signing-must-not-touch-agent';
const WINDOWS_SIGNING_PROVIDER_CONVERGENCE_RULE = 'windows-signing-provider-must-converge';
const WINDOWS_SIGNING_PUBLISHER_RULE = 'windows-signing-must-assert-publisher';
const WINDOWS_SIGNING_RELEASE_GATE_RULE = 'windows-signing-gate-must-block-release';
const WINDOWS_SIGNING_ARTIFACT_PARITY_RULE = 'windows-signing-providers-must-cover-same-artifacts';
const SSLCOM_SIGNING_TOOLCHAIN_RULE = 'sslcom-signing-must-pin-toolchain';
const TAURI_SIGNED_ARTIFACT_MARKER = 'breeze-viewer-windows.msi';
const TAURI_SIGNED_ARTIFACT_RE = /breeze-[a-z0-9-]+-windows\.msi/gu;
const PROVIDER_RESOLVER_SCRIPT = '.github/scripts/resolve-windows-signing-provider.mjs';
const CONVERGENCE_SCRIPT = '.github/scripts/assert-windows-signing-convergence.mjs';
const SHARED_SIGNATURE_VERIFIER = '.github/scripts/Verify-WindowsSignature.ps1';
const AZURE_SIGNING_ACTION_PREFIX = 'azure/artifact-signing-action@';
const SSLCOM_ACTION_PREFIX = 'SSLcom/esigner-codesign@';
const PINNED_EXTERNAL_USES = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*@[0-9a-f]{40}$/u;
const PUBLIC_AGENT_WINDOWS_ASSETS = [
  'breeze-agent-windows-amd64.exe',
  'breeze-backup-windows-amd64.exe',
  'breeze-watchdog-windows-amd64.exe',
  'breeze-user-helper-windows-amd64.exe',
  'breeze-agent.msi',
];
const SSLCOM_ACTION = 'SSLcom/esigner-codesign@cf5f6c1d38ad10f47e3ed9aca873f429b1a8d85b';
const SSLCOM_SECRETS = [
  'SSLCOM_USERNAME',
  'SSLCOM_PASSWORD',
  'SSLCOM_CREDENTIAL_ID',
  'SSLCOM_TOTP_SECRET',
  'SSLCOM_CERT_SHA256',
  'SSLCOM_ENVIRONMENT_LABEL',
];

function stripInlineComment(line) {
  let quote = null;
  let escaped = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];

    if (quote === '"') {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }

    if (quote === "'") {
      if (character === quote && line[index + 1] === quote) {
        index += 1;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }

    if (character === '"' || character === "'") {
      quote = character;
    } else if (
      character === '#'
      && (index === 0 || /\s/u.test(line[index - 1]))
    ) {
      return line.slice(0, index).trimEnd();
    }
  }

  return line.trimEnd();
}

function unquote(value) {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2
    && (
      (trimmed.startsWith('"') && trimmed.endsWith('"'))
      || (trimmed.startsWith("'") && trimmed.endsWith("'"))
    )
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function codePointCompare(left, right) {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function findTopLevelCharacter(text, target) {
  let quote = null;
  let escaped = false;
  let squareDepth = 0;
  let curlyDepth = 0;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];

    if (quote === '"') {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }

    if (quote === "'") {
      if (character === quote && text[index + 1] === quote) {
        index += 1;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }

    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '[') {
      squareDepth += 1;
      continue;
    }
    if (character === ']') {
      squareDepth -= 1;
      continue;
    }
    if (character === '{') {
      curlyDepth += 1;
      continue;
    }
    if (character === '}') {
      curlyDepth -= 1;
      continue;
    }
    if (character === target && squareDepth === 0 && curlyDepth === 0) {
      return index;
    }
  }

  return -1;
}

function splitTopLevel(text, separator) {
  const parts = [];
  let remainder = text;

  while (remainder !== '') {
    const index = findTopLevelCharacter(remainder, separator);
    if (index === -1) {
      parts.push(remainder);
      break;
    }
    parts.push(remainder.slice(0, index));
    remainder = remainder.slice(index + 1);
  }

  return parts;
}

function mappingEntry(text) {
  const colonIndex = findTopLevelCharacter(text.trim(), ':');
  if (colonIndex === -1) {
    return null;
  }

  const trimmed = text.trim();
  const key = unquote(trimmed.slice(0, colonIndex));
  if (key === '') {
    return null;
  }

  return {
    key,
    value: trimmed.slice(colonIndex + 1).trim(),
  };
}

function flowMappingEntries(text) {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    return [];
  }

  return splitTopLevel(trimmed.slice(1, -1), ',')
    .map((entry) => mappingEntry(entry))
    .filter(Boolean);
}

export function activeLines(text) {
  const lines = [];
  let blockScalarIndent = null;

  for (const [index, source] of text.split(/\r?\n/u).entries()) {
    const sourceIndent = source.match(/^\s*/u)[0].length;
    const isBlockScalarContent = (
      blockScalarIndent !== null && sourceIndent > blockScalarIndent
    );
    if (
      blockScalarIndent !== null
      && source.trim() !== ''
      && !isBlockScalarContent
    ) {
      blockScalarIndent = null;
    }

    const content = isBlockScalarContent
      ? source.trimEnd()
      : stripInlineComment(source);
    const indent = content.match(/^\s*/u)[0].length;
    const trimmed = content.trim();

    if (trimmed === '') {
      continue;
    }

    lines.push({
      content,
      indent,
      isBlockScalarContent,
      line: index + 1,
      trimmed,
    });

    if (!isBlockScalarContent && /:\s*[>|][0-9+-]*\s*$/u.test(trimmed)) {
      blockScalarIndent = indent;
    }
  }

  return lines;
}

function parentLineIndex(lines, childIndex) {
  for (let index = childIndex - 1; index >= 0; index -= 1) {
    if (lines[index].indent < lines[childIndex].indent) {
      return index;
    }
  }
  return -1;
}

function mappingKey(line) {
  return mappingEntry(line.trimmed)?.key ?? null;
}

function isSequenceItem(line) {
  return /^-(?:\s|$)/u.test(line.trimmed);
}

function isDirectChildOfMapping(lines, lineIndex, parentKey) {
  const parentIndex = parentLineIndex(lines, lineIndex);
  return (
    parentIndex !== -1
    && mappingKey(lines[parentIndex]) === parentKey
  );
}

function usesEntries(lines) {
  const entries = [];

  for (const [lineIndex, line] of lines.entries()) {
    if (line.isBlockScalarContent) {
      continue;
    }

    if (
      isSequenceItem(line)
      && isDirectChildOfMapping(lines, lineIndex, 'steps')
    ) {
      const sequenceBody = line.trimmed.slice(1).trim();
      const stepEntries = sequenceBody.startsWith('{')
        ? flowMappingEntries(sequenceBody)
        : [mappingEntry(sequenceBody)].filter(Boolean);
      const uses = stepEntries.find(({ key }) => key === 'uses');
      if (uses) {
        entries.push({
          ...line,
          isStep: true,
          stepIndex: lineIndex,
          value: unquote(uses.value),
        });
      }
      continue;
    }

    const entry = mappingEntry(line.trimmed);
    if (!entry) {
      continue;
    }

    if (entry.key === 'uses') {
      const parentIndex = parentLineIndex(lines, lineIndex);
      if (
        parentIndex !== -1
        && isSequenceItem(lines[parentIndex])
        && isDirectChildOfMapping(lines, parentIndex, 'steps')
      ) {
        entries.push({
          ...line,
          isStep: true,
          stepIndex: parentIndex,
          value: unquote(entry.value),
        });
        continue;
      }

      if (
        parentIndex !== -1
        && isDirectChildOfMapping(lines, parentIndex, 'jobs')
      ) {
        entries.push({
          ...line,
          isStep: false,
          stepIndex: null,
          value: unquote(entry.value),
        });
      }
      continue;
    }

    if (
      isDirectChildOfMapping(lines, lineIndex, 'jobs')
      && entry.value.startsWith('{')
    ) {
      const uses = flowMappingEntries(entry.value)
        .find(({ key }) => key === 'uses');
      if (uses) {
        entries.push({
          ...line,
          isStep: false,
          stepIndex: null,
          value: unquote(uses.value),
        });
      }
    }
  }

  return entries;
}

function workflowTriggers(lines) {
  const triggers = new Set();

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.isBlockScalarContent) {
      continue;
    }
    const entry = mappingEntry(line.trimmed);
    if (line.indent !== 0 || entry?.key !== 'on') {
      continue;
    }

    const onIndent = line.indent;
    const scalar = unquote(entry.value);
    if (scalar) {
      const values = scalar.startsWith('[') && scalar.endsWith(']')
        ? splitTopLevel(scalar.slice(1, -1), ',')
        : scalar.startsWith('{') && scalar.endsWith('}')
          ? flowMappingEntries(scalar).map(({ key }) => key)
          : [scalar];
      for (const value of values) {
        const trigger = unquote(value);
        if (trigger === 'pull_request' || trigger === 'pull_request_target') {
          triggers.add(trigger);
        }
      }
      continue;
    }

    for (let nestedIndex = index + 1; nestedIndex < lines.length; nestedIndex += 1) {
      const nested = lines[nestedIndex];
      if (nested.indent <= onIndent) {
        break;
      }
      if (nested.isBlockScalarContent) {
        continue;
      }
      if (parentLineIndex(lines, nestedIndex) !== index) {
        continue;
      }
      const trigger = mappingEntry(nested.trimmed)?.key;
      if (trigger === 'pull_request' || trigger === 'pull_request_target') {
        triggers.add(trigger);
      }
    }
  }

  return triggers;
}

function normalizePropertyAccess(value) {
  return value
    .replace(/\[\s*(['"])([A-Za-z0-9_]+)\1\s*\]/gu, '.$2')
    .replace(/\s+/gu, '');
}

function isPullRequestHeadOrMergeRef(value) {
  const normalized = normalizePropertyAccess(value);
  return (
    normalized.includes('github.event.pull_request.head')
    || normalized.includes('github.head_ref')
    || /refs\/pull\/.+\/merge/u.test(normalized)
  );
}

function isDynamicExpression(value) {
  return /\$\{\{[\s\S]*\}\}/u.test(value);
}

function blockScalarValue(lines, lineIndex) {
  const content = [];

  for (let index = lineIndex + 1; index < lines.length; index += 1) {
    if (!lines[index].isBlockScalarContent) {
      break;
    }
    content.push(lines[index].trimmed);
  }

  return content.join(' ');
}

function containsSecretReference(value) {
  const normalized = normalizePropertyAccess(value);
  return (
    /\bsecrets\./u.test(normalized)
    || /\btojson\(\s*secrets\s*\)/iu.test(normalized)
  );
}

function secretReferenceLines(lines) {
  const lineNumbers = new Set();

  for (const [index, line] of lines.entries()) {
    if (containsSecretReference(line.content)) {
      lineNumbers.add(line.line);
    }

    if (line.isBlockScalarContent) {
      continue;
    }

    const entry = mappingEntry(line.trimmed);
    if (
      entry
      && /^[>|][0-9+-]*$/u.test(entry.value)
      && containsSecretReference(blockScalarValue(lines, index))
    ) {
      let scalarHasDirectMatch = false;
      for (let nestedIndex = index + 1; nestedIndex < lines.length; nestedIndex += 1) {
        if (!lines[nestedIndex].isBlockScalarContent) {
          break;
        }
        if (containsSecretReference(lines[nestedIndex].content)) {
          scalarHasDirectMatch = true;
          break;
        }
      }
      if (!scalarHasDirectMatch) {
        lineNumbers.add(line.line);
      }
    }
  }

  return lines.filter((line) => lineNumbers.has(line.line));
}

function unsupportedSyntaxLines(text, lines) {
  const unsupported = new Map();
  const add = (line, message) => {
    if (!unsupported.has(line.line)) {
      unsupported.set(line.line, { line, message });
    }
  };

  const firstLine = lines[0];
  if (
    firstLine
    && firstLine.indent === 0
    && (firstLine.trimmed.startsWith('{') || firstLine.trimmed.startsWith('['))
  ) {
    add(firstLine, 'root flow collections are unsupported by the workflow security scanner');
  }

  for (const [index, line] of lines.entries()) {
    if (line.isBlockScalarContent) {
      continue;
    }

    if (/\\(?:u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|x[0-9a-fA-F]{2})/u.test(line.content)) {
      add(line, 'escape-bearing YAML is unsupported by the workflow security scanner');
    }

    if (
      isSequenceItem(line)
      && isDirectChildOfMapping(lines, index, 'steps')
    ) {
      const body = line.trimmed.slice(1).trim();
      if (body.startsWith('{') && !body.endsWith('}')) {
        add(line, 'multiline flow-style steps are unsupported by the workflow security scanner');
      }
    }

    const entry = mappingEntry(line.trimmed);
    if (
      entry
      && isDirectChildOfMapping(lines, index, 'jobs')
      && entry.value.startsWith('{')
      && !entry.value.endsWith('}')
    ) {
      add(line, 'multiline flow-style jobs are unsupported by the workflow security scanner');
    }
  }

  // Inspect the original text so escape sequences inside otherwise skipped
  // scalar shapes cannot disappear before the fail-closed check.
  if (
    /\\(?:u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|x[0-9a-fA-F]{2})/u.test(text)
    && ![...unsupported.values()].some(({ message }) => message.startsWith('escape-bearing'))
  ) {
    add(firstLine ?? {
      line: 1,
    }, 'escape-bearing YAML is unsupported by the workflow security scanner');
  }

  return [...unsupported.values()];
}

function flowRefValues(text) {
  const values = [];
  const entries = flowMappingEntries(text);

  for (const entry of entries) {
    if (entry.key === 'ref') {
      values.push(unquote(entry.value));
    }
    if (entry.value.startsWith('{')) {
      values.push(...flowRefValues(entry.value));
    }
  }

  return values;
}

function checkoutHeadRefs(lines, checkoutEntries) {
  const violations = [];
  const violatingLineNumbers = new Set();

  for (const checkout of checkoutEntries) {
    if (!checkout.isStep || checkout.stepIndex === null) {
      continue;
    }

    const stepIndex = checkout.stepIndex;
    const stepIndent = lines[stepIndex].indent;
    for (let index = stepIndex + 1; index < lines.length; index += 1) {
      const line = lines[index];
      if (line.indent <= stepIndent) {
        break;
      }
      if (line.isBlockScalarContent) {
        continue;
      }

      const entry = mappingEntry(line.trimmed);
      if (entry?.key === 'ref') {
        const value = /^[>|][0-9+-]*$/u.test(entry.value)
          ? blockScalarValue(lines, index)
          : unquote(entry.value);
        if (isDynamicExpression(value) || isPullRequestHeadOrMergeRef(value)) {
          violatingLineNumbers.add(line.line);
        }
      }

      for (const ref of flowRefValues(line.trimmed)) {
        if (isDynamicExpression(ref) || isPullRequestHeadOrMergeRef(ref)) {
          violatingLineNumbers.add(line.line);
        }
      }
    }

    for (const ref of flowRefValues(lines[stepIndex].trimmed.slice(1).trim())) {
      if (isDynamicExpression(ref) || isPullRequestHeadOrMergeRef(ref)) {
        violatingLineNumbers.add(lines[stepIndex].line);
      }
    }
  }

  for (const line of lines) {
    if (violatingLineNumbers.has(line.line)) {
      violations.push(line);
    }
  }

  return violations;
}

function workflowSteps(lines) {
  const steps = [];

  for (const [index, line] of lines.entries()) {
    if (
      line.isBlockScalarContent
      || !isSequenceItem(line)
      || !isDirectChildOfMapping(lines, index, 'steps')
    ) {
      continue;
    }

    let endIndex = lines.length;
    for (let nestedIndex = index + 1; nestedIndex < lines.length; nestedIndex += 1) {
      if (lines[nestedIndex].indent <= line.indent) {
        endIndex = nestedIndex;
        break;
      }
    }

    steps.push(lines.slice(index, endIndex));
  }

  return steps;
}

function runStepHeadRefs(lines) {
  const violatingLineNumbers = new Set();
  const checkoutCommand = (
    /\bgit\s+(?:(?:checkout|switch)\b|reset\s+--hard\b|worktree\s+add\b)/u
  );

  for (const job of workflowJobs(lines)) {
    const jobContent = job.lines.map(({ content }) => content).join('\n');
    if (!isPullRequestHeadOrMergeRef(jobContent)) {
      continue;
    }

    for (const step of workflowSteps(job.lines)) {
      for (const [index, line] of step.entries()) {
        if (line.isBlockScalarContent) {
          continue;
        }

        const entry = mappingEntry(line.trimmed.replace(/^-\s*/u, ''));
        if (entry?.key !== 'run') {
          continue;
        }

        const command = /^[>|][0-9+-]*$/u.test(entry.value)
          ? blockScalarValue(step, index)
          : unquote(entry.value);
        if (checkoutCommand.test(command)) {
          violatingLineNumbers.add(line.line);
        }
      }
    }
  }

  return lines.filter(({ line }) => violatingLineNumbers.has(line));
}

export function workflowJobs(lines) {
  const jobs = [];

  for (const [index, line] of lines.entries()) {
    if (
      line.isBlockScalarContent
      || !isDirectChildOfMapping(lines, index, 'jobs')
    ) {
      continue;
    }

    const entry = mappingEntry(line.trimmed);
    if (!entry || entry.value !== '') {
      continue;
    }

    let endIndex = lines.length;
    for (let nestedIndex = index + 1; nestedIndex < lines.length; nestedIndex += 1) {
      if (lines[nestedIndex].indent <= line.indent) {
        endIndex = nestedIndex;
        break;
      }
    }

    jobs.push({
      lines: lines.slice(index, endIndex),
      name: entry.key,
    });
  }

  return jobs;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function requirePattern(section, pattern, rule, violations, file) {
  const content = section?.lines.map((line) => line.content).join('\n') ?? '';
  if (section && pattern.test(content)) {
    return;
  }
  violations.push({
    file,
    line: section?.lines[0].line ?? 1,
    rule,
    message: `release signing job "${section?.name ?? 'missing'}" must satisfy ${rule}`,
  });
}

function forbidPattern(section, pattern, rule, violations, file) {
  if (!section) {
    return;
  }
  const content = section.lines.map((line) => line.content).join('\n');
  if (!pattern.test(content)) {
    return;
  }
  violations.push({
    file,
    line: section.lines[0].line,
    rule,
    message: `release signing job "${section.name}" must not violate ${rule}`,
  });
}

function scalarListValues(value) {
  const scalar = unquote(value);
  if (!scalar.startsWith('[') || !scalar.endsWith(']')) {
    return scalar === '' ? [] : [scalar];
  }
  return splitTopLevel(scalar.slice(1, -1), ',').map((item) => unquote(item));
}

function hasVersionTagPushTrigger(lines) {
  for (const [onIndex, onLine] of lines.entries()) {
    const onEntry = onLine.isBlockScalarContent
      ? null
      : mappingEntry(onLine.trimmed);
    if (onLine.indent !== 0 || onEntry?.key !== 'on' || onEntry.value !== '') {
      continue;
    }

    for (let pushIndex = onIndex + 1; pushIndex < lines.length; pushIndex += 1) {
      const pushLine = lines[pushIndex];
      if (pushLine.indent <= onLine.indent) {
        break;
      }
      const pushEntry = pushLine.isBlockScalarContent
        ? null
        : mappingEntry(pushLine.trimmed);
      if (
        parentLineIndex(lines, pushIndex) !== onIndex
        || pushEntry?.key !== 'push'
        || pushEntry.value !== ''
      ) {
        continue;
      }

      for (let tagsIndex = pushIndex + 1; tagsIndex < lines.length; tagsIndex += 1) {
        const tagsLine = lines[tagsIndex];
        if (tagsLine.indent <= pushLine.indent) {
          break;
        }
        const tagsEntry = tagsLine.isBlockScalarContent
          ? null
          : mappingEntry(tagsLine.trimmed);
        if (
          parentLineIndex(lines, tagsIndex) !== pushIndex
          || tagsEntry?.key !== 'tags'
        ) {
          continue;
        }

        const patterns = scalarListValues(tagsEntry.value);
        for (let patternIndex = tagsIndex + 1; patternIndex < lines.length; patternIndex += 1) {
          const patternLine = lines[patternIndex];
          if (patternLine.indent <= tagsLine.indent) {
            break;
          }
          if (
            parentLineIndex(lines, patternIndex) === tagsIndex
            && isSequenceItem(patternLine)
          ) {
            patterns.push(unquote(patternLine.trimmed.slice(1).trim()));
          }
        }
        if (patterns.includes('v*')) {
          return true;
        }
      }
    }
  }

  return false;
}

export function topLevelLogicalParts(value, operator) {
  const parts = [];
  let start = 0;
  let quote = null;
  let escaped = false;
  let parenthesisDepth = 0;
  let squareDepth = 0;
  let curlyDepth = 0;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];

    if (quote === '"') {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }

    if (quote === "'") {
      if (character === quote && value[index + 1] === quote) {
        index += 1;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }

    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '(') {
      parenthesisDepth += 1;
      continue;
    }
    if (character === ')') {
      parenthesisDepth -= 1;
      continue;
    }
    if (character === '[') {
      squareDepth += 1;
      continue;
    }
    if (character === ']') {
      squareDepth -= 1;
      continue;
    }
    if (character === '{') {
      curlyDepth += 1;
      continue;
    }
    if (character === '}') {
      curlyDepth -= 1;
      continue;
    }
    if (
      character === operator[0]
      && value[index + 1] === operator[1]
      && parenthesisDepth === 0
      && squareDepth === 0
      && curlyDepth === 0
    ) {
      parts.push(value.slice(start, index));
      index += 1;
      start = index + 1;
    }
  }

  parts.push(value.slice(start));
  return parts;
}

function hasTrustedVersionTagJobGate(lines) {
  for (const [index, line] of lines.entries()) {
    if (
      line.isBlockScalarContent
      || parentLineIndex(lines, index) !== 0
    ) {
      continue;
    }

    const entry = mappingEntry(line.trimmed);
    if (entry?.key !== 'if') {
      continue;
    }

    let condition = normalizePropertyAccess(
      /^[>|][0-9+-]*$/u.test(entry.value)
        ? blockScalarValue(lines, index)
        : unquote(entry.value),
    );
    if (condition.startsWith('${{') && condition.endsWith('}}')) {
      condition = condition.slice(3, -2);
    }
    if (topLevelLogicalParts(condition, '||').length !== 1) {
      return false;
    }
    const conjuncts = new Set(topLevelLogicalParts(condition, '&&'));
    return (
      conjuncts.has("github.ref_type=='tag'")
      && conjuncts.has("startsWith(github.ref,'refs/tags/v')")
    );
  }

  return false;
}

function appleSecretReferenceLines(lines) {
  return lines.filter((line, index) => {
    const scalar = line.isBlockScalarContent
      ? line.content
      : `${line.content} ${blockScalarValue(lines, index)}`;
    return /\bsecrets\.APPLE_[A-Za-z0-9_]+\b/u.test(
      normalizePropertyAccess(scalar),
    );
  });
}

function normalizedActionName(value) {
  const atIndex = value.lastIndexOf('@');
  return (atIndex === -1 ? value : value.slice(0, atIndex)).toLowerCase();
}

function collapseShellContinuations(lines) {
  const collapsed = [];

  for (let index = 0; index < lines.length; index += 1) {
    const firstLine = lines[index];
    let content = firstLine.content;

    while (
      firstLine.isBlockScalarContent
      && content.trimEnd().endsWith('\\')
      && lines[index + 1]?.isBlockScalarContent
      && lines[index + 1].line === lines[index].line + 1
    ) {
      content = (
        `${content.trimEnd().slice(0, -1)} ${lines[index + 1].trimmed}`
      );
      index += 1;
    }

    collapsed.push({
      ...firstLine,
      content,
      trimmed: content.trim(),
    });
  }

  return collapsed;
}

function forbiddenSigningSourceLines(lines) {
  const forbidden = new Map();

  for (const checkout of usesEntries(lines).filter(({ value }) => (
    normalizedActionName(value) === 'actions/checkout'
  ))) {
    forbidden.set(checkout.line, checkout);
  }

  const buildCommand = /\b(?:go\s+build|cargo\s+build|npm\s+run\s+build|pnpm\s+build)\b/u;
  for (const line of collapseShellContinuations(lines)) {
    if (
      !line.trimmed.startsWith('#')
      && buildCommand.test(line.content)
    ) {
      forbidden.set(line.line, line);
    }
  }

  return [...forbidden.values()].sort((left, right) => left.line - right.line);
}

function developerSigningViolations(file, lines) {
  const violations = [];
  const hasReleaseTrigger = hasVersionTagPushTrigger(lines);
  for (const job of workflowJobs(lines)) {
    const appleSecrets = appleSecretReferenceLines(job.lines);
    if (appleSecrets.length === 0) {
      continue;
    }
    if (hasReleaseTrigger && hasTrustedVersionTagJobGate(job.lines)) {
      continue;
    }

    for (const line of forbiddenSigningSourceLines(job.lines)) {
      violations.push({
        file,
        line: line.line,
        rule: SIGNING_BUILD_RULE,
        message: `developer signing job "${job.name}" must not check out or build source`,
      });
    }

    const firstSecretLine = Math.min(...appleSecrets.map(({ line }) => line));
    const verificationName = job.lines.find((line) => {
      const entry = line.isBlockScalarContent
        ? null
        : mappingEntry(line.trimmed.replace(/^-\s*/u, ''));
      return (
        entry?.key === 'name'
        && unquote(entry.value) === 'Verify unsigned artifact before secrets'
      );
    });
    const checksumVerification = job.lines.find((line) => (
      !line.trimmed.startsWith('#')
      && line.trimmed === 'shasum -a 256 -c SHA256SUMS'
    ));

    if (
      !verificationName
      || !checksumVerification
      || verificationName.line >= firstSecretLine
      || checksumVerification.line >= firstSecretLine
    ) {
      violations.push({
        file,
        line: firstSecretLine,
        rule: SIGNING_VERIFY_RULE,
        message: `developer signing job "${job.name}" must verify artifact checksums before referencing Apple secrets`,
      });
    }
  }

  return violations;
}

function jobText(job) {
  return job.lines.map((line) => line.content).join('\n');
}

function findJobByShape(jobs, marker) {
  return jobs.find((job) => jobText(job).includes(marker));
}

function artifactsMatching(job, lineFilter) {
  const found = new Set();
  for (const line of job.lines) {
    if (!lineFilter(line.trimmed)) {
      continue;
    }
    for (const match of line.content.matchAll(TAURI_SIGNED_ARTIFACT_RE)) {
      found.add(match[0]);
    }
  }
  return [...found].sort(codePointCompare);
}

// Artifacts handed to a signing action, via azure `files:` or eSigner
// `file_path:`. Deliberately NOT every MSI named in the job — download and
// upload steps name them too, so a deleted sign step would go unnoticed while
// the unsigned file was re-uploaded over the signed artifact name.
function signedWindowsArtifacts(job) {
  return artifactsMatching(job, (trimmed) => /^(?:files|file_path):/u.test(trimmed));
}

// Artifacts passed to the shared verifier.
function verifiedWindowsArtifacts(job) {
  return artifactsMatching(job, (trimmed) => trimmed.startsWith('-Path'));
}

function publicReleaseSigningViolations(file, lines) {
  const text = lines.map((line) => line.content).join('\n');

  // Trigger on the ARTIFACT, not on job names. Keying this on job names meant a
  // consistent rename of the four signing jobs silently disabled every rule
  // below — including the certificate pin — with CI fully green.
  if (!text.includes(TAURI_SIGNED_ARTIFACT_MARKER)) {
    return [];
  }

  const jobs = workflowJobs(lines);
  // Each provider is located by the action or script that defines it, so the
  // rules survive any renaming of the jobs themselves.
  const resolver = findJobByShape(jobs, PROVIDER_RESOLVER_SCRIPT);
  const azure = findJobByShape(jobs, AZURE_SIGNING_ACTION_PREFIX);
  const sslcom = findJobByShape(jobs, SSLCOM_ACTION_PREFIX);
  const gate = findJobByShape(jobs, CONVERGENCE_SCRIPT);
  const integrityGate = findJobByShape(jobs, 'require_success');

  const violations = [];
  const structural = [
    [resolver, 'a provider resolution job', WINDOWS_SIGNING_PROVIDER_FAIL_CLOSED_RULE],
    [azure, 'an Azure signing job', WINDOWS_SIGNING_PUBLISHER_RULE],
    [sslcom, 'an SSL.com signing job', SSLCOM_SIGNING_CERTIFICATE_PIN_RULE],
    [gate, 'a provider convergence gate', WINDOWS_SIGNING_PROVIDER_CONVERGENCE_RULE],
    [integrityGate, 'a release integrity gate', WINDOWS_SIGNING_RELEASE_GATE_RULE],
  ];
  for (const [job, description, rule] of structural) {
    if (!job) {
      violations.push({
        file,
        line: 1,
        rule,
        message: `a workflow that signs ${TAURI_SIGNED_ARTIFACT_MARKER} must declare ${description}`,
      });
    }
  }

  // Fail-closed provider resolution.
  requirePattern(
    resolver,
    /node\s+\.github\/scripts\/resolve-windows-signing-provider\.mjs\s+"\$RAW_PROVIDER"\s*>>\s*"\$GITHUB_OUTPUT"/u,
    WINDOWS_SIGNING_PROVIDER_FAIL_CLOSED_RULE,
    violations,
    file,
  );

  // Only the Azure signer may hold OIDC.
  requirePattern(
    azure,
    /id-token:\s*write/u,
    WINDOWS_SIGNING_PROVIDER_LEAST_PRIVILEGE_RULE,
    violations,
    file,
  );
  for (const section of [resolver, sslcom, gate]) {
    forbidPattern(
      section,
      /id-token:/u,
      WINDOWS_SIGNING_PROVIDER_LEAST_PRIVILEGE_RULE,
      violations,
      file,
    );
  }

  // Both providers must assert the publisher through the shared verifier. The
  // Azure path previously verified only that *some* signature existed, so a
  // mis-set endpoint or certificate profile shipped under any identity.
  for (const section of [azure, sslcom]) {
    requirePattern(
      section,
      new RegExp(escapeRegExp(SHARED_SIGNATURE_VERIFIER), 'u'),
      WINDOWS_SIGNING_TIMESTAMP_RULE,
      violations,
      file,
    );
    requirePattern(
      section,
      /-ExpectedSubject\s+\$env:EXPECTED_SUBJECT/u,
      WINDOWS_SIGNING_PUBLISHER_RULE,
      violations,
      file,
    );
  }

  // SSL.com credential + certificate pinning.
  requirePattern(
    sslcom,
    new RegExp(escapeRegExp(SSLCOM_ACTION), 'u'),
    SSLCOM_SIGNING_CERTIFICATE_PIN_RULE,
    violations,
    file,
  );
  for (const secret of SSLCOM_SECRETS) {
    requirePattern(
      sslcom,
      new RegExp(`secrets\\.${secret}\\b`, 'u'),
      SSLCOM_SIGNING_CERTIFICATE_PIN_RULE,
      violations,
      file,
    );
  }
  requirePattern(
    sslcom,
    /-ExpectedThumbprintSha256\s+\$env:SSLCOM_CERT_SHA256/u,
    SSLCOM_SIGNING_CERTIFICATE_PIN_RULE,
    violations,
    file,
  );
  // -AllowUnpinnedLeaf turns the certificate pin off. It is correct on the
  // Azure path, whose leaves rotate, and never on the pinned one.
  forbidPattern(
    sslcom,
    /-AllowUnpinnedLeaf/u,
    SSLCOM_SIGNING_CERTIFICATE_PIN_RULE,
    violations,
    file,
  );
  // Verifying without a pin has to be an explicit, reviewable choice rather
  // than the silent consequence of an empty secret.
  requirePattern(
    azure,
    /-AllowUnpinnedLeaf/u,
    WINDOWS_SIGNING_PUBLISHER_RULE,
    violations,
    file,
  );
  // The stable/prerelease certificate split exists only in GitHub Environment
  // scoping, which is invisible in YAML. This label makes a repository-level
  // secret fail one of the two environments instead of silently signing a
  // prerelease with the production certificate.
  requirePattern(
    sslcom,
    /SSLCOM_ENVIRONMENT_LABEL\s+-ne\s+\$env:EXPECTED_ENVIRONMENT[\s\S]{0,200}throw/u,
    SSLCOM_SIGNING_CERTIFICATE_PIN_RULE,
    violations,
    file,
  );

  // The pinned action SHA does not cover CodeSignTool, which the action fetches
  // at runtime from a mutable release asset and executes next to the eSigner
  // credentials. It must be pre-staged against a verified digest.
  requirePattern(
    sslcom,
    /Get-FileHash[\s\S]{0,400}\$actual\s+-ne\s+\$env:CODESIGNTOOL_SHA256\s*\)\s*\{[\s\S]{0,200}throw/u,
    SSLCOM_SIGNING_TOOLCHAIN_RULE,
    violations,
    file,
  );
  for (const marker of ['CODESIGNTOOL_PATH=', 'JAVA_VERSION=']) {
    requirePattern(
      sslcom,
      new RegExp(escapeRegExp(marker), 'u'),
      SSLCOM_SIGNING_TOOLCHAIN_RULE,
      violations,
      file,
    );
  }

  // Agent-family artifacts stay unsigned in the public pipeline — on BOTH
  // providers, not just SSL.com.
  for (const section of [azure, sslcom]) {
    for (const asset of PUBLIC_AGENT_WINDOWS_ASSETS) {
      forbidPattern(
        section,
        new RegExp(escapeRegExp(asset), 'u'),
        SSLCOM_SIGNING_AGENT_ISOLATION_RULE,
        violations,
        file,
      );
    }
    // A directory-wide batch sign would pick up whatever is staged without
    // naming any forbidden file.
    forbidPattern(
      section,
      /(?:command:\s*batch_sign|dir_path:)/u,
      SSLCOM_SIGNING_AGENT_ISOLATION_RULE,
      violations,
      file,
    );
  }

  // Both providers must cover exactly the same artifact set, or one of them can
  // quietly leave a file unsigned while overwriting the signed artifact name.
  // Every artifact a provider verifies must also have been signed by it, and
  // both providers must cover the same set.
  for (const section of [azure, sslcom]) {
    if (!section) {
      continue;
    }
    const signed = signedWindowsArtifacts(section);
    const verified = verifiedWindowsArtifacts(section);
    if (signed.join(',') !== verified.join(',')) {
      violations.push({
        file,
        line: section.lines[0].line,
        rule: WINDOWS_SIGNING_ARTIFACT_PARITY_RULE,
        message: `signing job "${section.name}" signs [${signed.join(' ')}] but verifies [${verified.join(' ')}]`,
      });
    }
  }
  if (azure && sslcom) {
    const azureArtifacts = signedWindowsArtifacts(azure);
    const sslcomArtifacts = signedWindowsArtifacts(sslcom);
    if (azureArtifacts.join(',') !== sslcomArtifacts.join(',')) {
      violations.push({
        file,
        line: sslcom.lines[0].line,
        rule: WINDOWS_SIGNING_ARTIFACT_PARITY_RULE,
        message: `Windows signing providers must cover the same artifacts; azure=[${azureArtifacts.join(' ')}] sslcom=[${sslcomArtifacts.join(' ')}]`,
      });
    }
  }

  // Convergence gate: exactly one provider ran, and it succeeded.
  requirePattern(gate, /!cancelled\(\)/u, WINDOWS_SIGNING_PROVIDER_CONVERGENCE_RULE, violations, file);
  if (azure) {
    requirePattern(
      gate,
      new RegExp(`needs\\.${escapeRegExp(azure.name)}\\.result`, 'u'),
      WINDOWS_SIGNING_PROVIDER_CONVERGENCE_RULE,
      violations,
      file,
    );
  }
  if (sslcom) {
    requirePattern(
      gate,
      new RegExp(`needs\\.${escapeRegExp(sslcom.name)}\\.result`, 'u'),
      WINDOWS_SIGNING_PROVIDER_CONVERGENCE_RULE,
      violations,
      file,
    );
  }
  requirePattern(
    gate,
    /node\s+\.github\/scripts\/assert-windows-signing-convergence\.mjs\s+"\$PROVIDER"\s+"\$AZURE_RESULT"\s+"\$SSLCOM_RESULT"/u,
    WINDOWS_SIGNING_PROVIDER_CONVERGENCE_RULE,
    violations,
    file,
  );

  // The convergence gate only protects the release while the integrity gate
  // hard-requires it. Everything downstream tolerates a 'skipped' signing job,
  // so dropping this one entry would silently make the pipeline fail open.
  if (gate) {
    requirePattern(
      integrityGate,
      new RegExp(`require_success\\s+"${escapeRegExp(gate.name)}"`, 'u'),
      WINDOWS_SIGNING_RELEASE_GATE_RULE,
      violations,
      file,
    );
  }

  return violations;
}

function compareViolations(left, right) {
  return codePointCompare(left.file, right.file)
    || left.line - right.line
    || codePointCompare(left.rule, right.rule);
}

export function inspectWorkflowText(file, text) {
  const lines = activeLines(text);
  const uses = usesEntries(lines);
  const triggers = workflowTriggers(lines);
  const checkoutEntries = uses.filter(({ value }) => (
    value.startsWith('actions/checkout@')
  ));
  const violations = [];

  for (const { line, message } of unsupportedSyntaxLines(text, lines)) {
    violations.push({
      file,
      line: line.line,
      rule: UNSUPPORTED_SYNTAX_RULE,
      message,
    });
  }

  for (const entry of uses) {
    if (!entry.value.startsWith('./') && !PINNED_EXTERNAL_USES.test(entry.value)) {
      violations.push({
        file,
        line: entry.line,
        rule: EXTERNAL_USES_RULE,
        message: `external action must use a lowercase 40-character commit SHA: ${entry.value}`,
      });
    }
  }

  if (triggers.has('pull_request') && checkoutEntries.length > 0) {
    for (const line of secretReferenceLines(lines)) {
      violations.push({
        file,
        line: line.line,
        rule: PR_SECRET_RULE,
        message: 'pull_request workflow checks out repository code and references a secret',
      });
    }
  }

  if (triggers.has('pull_request_target')) {
    const headRefLines = new Map([
      ...checkoutHeadRefs(lines, checkoutEntries),
      ...runStepHeadRefs(lines),
    ].map((line) => [line.line, line]));
    for (const line of headRefLines.values()) {
      violations.push({
        file,
        line: line.line,
        rule: PR_TARGET_HEAD_RULE,
        message: 'pull_request_target workflow must not check out a pull request head or merge ref',
      });
    }
  }

  violations.push(...developerSigningViolations(file, lines));
  violations.push(...publicReleaseSigningViolations(file, lines));

  return violations.sort(compareViolations);
}

export function inspectWorkflowDirectory(rootDirectory) {
  return readdirSync(rootDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.ya?ml$/u.test(entry.name))
    .flatMap((entry) => inspectWorkflowText(
      entry.name,
      readFileSync(path.join(rootDirectory, entry.name), 'utf8'),
    ))
    .sort(compareViolations);
}

function main() {
  const workflowDirectory = path.resolve('.github', 'workflows');
  const violations = inspectWorkflowDirectory(workflowDirectory);

  for (const violation of violations) {
    console.error(
      `${violation.file}:${violation.line} [${violation.rule}] ${violation.message}`,
    );
  }

  if (violations.length > 0) {
    process.exitCode = 1;
  }
}

const invokedFile = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedFile === fileURLToPath(import.meta.url)) {
  main();
}
