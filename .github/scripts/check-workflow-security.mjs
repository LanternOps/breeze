import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EXTERNAL_USES_RULE = 'external-uses-must-be-sha';
const PR_SECRET_RULE = 'pr-workflow-must-be-secret-free';
const PR_TARGET_HEAD_RULE = 'pr-target-must-not-execute-head';
const UNSUPPORTED_SYNTAX_RULE = 'unsupported-workflow-syntax';
const PINNED_EXTERNAL_USES = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*@[0-9a-f]{40}$/u;

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

function activeLines(text) {
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

function secretReferenceLines(lines) {
  const lineNumbers = new Set();

  for (const [index, line] of lines.entries()) {
    if (/\bsecrets\s*(?:\.|\[)/u.test(line.content)) {
      lineNumbers.add(line.line);
    }

    if (line.isBlockScalarContent) {
      continue;
    }

    const entry = mappingEntry(line.trimmed);
    if (
      entry
      && /^[>|][0-9+-]*$/u.test(entry.value)
      && /\bsecrets\s*(?:\.|\[)/u.test(blockScalarValue(lines, index))
    ) {
      let scalarHasDirectMatch = false;
      for (let nestedIndex = index + 1; nestedIndex < lines.length; nestedIndex += 1) {
        if (!lines[nestedIndex].isBlockScalarContent) {
          break;
        }
        if (/\bsecrets\s*(?:\.|\[)/u.test(lines[nestedIndex].content)) {
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
    for (const line of checkoutHeadRefs(lines, checkoutEntries)) {
      violations.push({
        file,
        line: line.line,
        rule: PR_TARGET_HEAD_RULE,
        message: 'pull_request_target workflow must not check out a pull request head or merge ref',
      });
    }
  }

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
