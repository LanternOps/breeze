/**
 * Web/API mirror of the agent's STRICT-level script security patterns
 * (`agent/internal/executor/security.go`, `strictPatterns`).
 *
 * WHY THIS EXISTS (#5129)
 *
 * The agent refuses to execute a script whose content matches one of its
 * danger patterns. Basic-level patterns (`rm -rf /`, `Format-Volume`, fork
 * bombs, block-device writes) are unconditional and stay that way — there is
 * no legitimate RMM use for them and nothing here can override them.
 *
 * Strict-level patterns are different: `reg add HKLM` is one of the most common
 * things an MSP tech does on Windows, and before #5129 it was blocked at the
 * agent with no override anywhere in the product. Those patterns are now
 * *acknowledgeable per script*: an admin who can already manage scripts is
 * shown which patterns the script content matches, acknowledges the ones they
 * intend, and the acknowledged descriptions ride the dispatch payload. The
 * agent allows exactly the Strict patterns whose description was acknowledged
 * and still blocks every other match.
 *
 * The acknowledgement is stored as the SET OF MATCHED DESCRIPTIONS, never a
 * bare boolean. A boolean would mean acknowledging an HKLM write permanently
 * disarms Strict checking for that script, so a later edit that introduces a
 * credential-dumping pattern would inherit the approval silently. With the
 * description set, the existing approval stands and the newly-introduced
 * pattern is unacknowledged and still blocks.
 *
 * CONTRACT WITH THE GO VALIDATOR
 *
 * The `description` strings below are protocol values, not display copy: they
 * are stored, sent on the wire, and compared byte-for-byte against the agent's
 * own descriptions. They are deliberately NOT translated — a translated
 * acknowledgement would never match. `scriptSecurityPatterns.test.ts` parses
 * `agent/internal/executor/security.go` and fails if the two lists drift in
 * either pattern source or description.
 *
 * Any residual regex-engine divergence between RE2 and JS is fail-SAFE in both
 * directions: a pattern this file misses cannot be acknowledged, so the agent
 * still blocks it; a pattern only this file matches lets an admin acknowledge
 * something harmless. Neither direction can loosen the agent.
 */

/**
 * XOR key for obfuscated pattern literals — must equal `obfuscate.Key`
 * (`agent/internal/obfuscate/obfuscate.go`).
 *
 * Three of the Strict patterns are well-known credential-theft tool names.
 * Stored as plain literals they get compiled verbatim into shipped artifacts
 * and antivirus engines flag those artifacts as malware (issue #2797, and
 * `scripts/security/check-agent-binary-signatures.sh` guards the agent side).
 * The same reasoning applies to a bundle served to browsers, so this file
 * carries the identical XOR-encoded bytes the Go source does and decodes them
 * at module load. This is NOT secrecy — it only keeps byte-for-byte token
 * matches out of build artifacts.
 */
const OBFUSCATION_KEY = 0x5a;

function decodeObfuscated(bytes: readonly number[]): string {
  return bytes.map((byte) => String.fromCharCode(byte ^ OBFUSCATION_KEY)).join('');
}

/**
 * Web/API mirror of the agent's BASIC-level patterns
 * (`agent/internal/executor/security.go`, `basicPatterns`).
 *
 * BASIC patterns are UNCONDITIONAL on the device: unlike STRICT they can never
 * be acknowledged, so this mirror carries no `explanation` — there is no
 * acknowledgement UI for it. Its only consumer is the proposal scanner, which
 * rejects a proposal outright on a hit (spec §4.4) rather than sending it to a
 * reviewer or a human.
 *
 * The same fail-safe argument as the STRICT mirror holds in both directions: a
 * BASIC pattern this file misses is still blocked by the agent at execution
 * (the proposal simply fails on the device instead of at authoring time), and a
 * pattern only this file matches rejects a harmless proposal early. Neither
 * direction can loosen the agent.
 */
export type BasicScriptPattern = {
  /** The regex source, mirroring the Go pattern verbatim, matched with `(?i)`. */
  readonly source: string;
  /** The agent's description string, byte-for-byte. */
  readonly description: string;
};

export const BASIC_SCRIPT_PATTERNS: readonly BasicScriptPattern[] = [
  // Unix dangerous patterns
  { source: String.raw`rm\s+-[rR]f?\s+/\s*$`, description: 'recursive delete on root directory' },
  { source: String.raw`rm\s+-[rR]f?\s+/\*`, description: 'recursive delete on root wildcard' },
  { source: String.raw`rm\s+-[rR]f?\s+/[a-z]+\s*$`, description: 'recursive delete on system directory' },
  { source: String.raw`mkfs\s+`, description: 'filesystem format command' },
  { source: String.raw`dd\s+.*of=/dev/[hs]d`, description: 'direct disk write to block device' },
  { source: String.raw`>\s*/dev/[hs]d`, description: 'redirect to block device' },
  { source: String.raw`chmod\s+-[rR]\s+[0-7]*777\s+/`, description: 'dangerous recursive chmod on root' },
  { source: String.raw`chown\s+-[rR]\s+.*\s+/\s*$`, description: 'dangerous recursive chown on root' },
  { source: String.raw`:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:`, description: 'fork bomb pattern' },
  { source: String.raw`/dev/null\s*>\s*/etc/passwd`, description: 'attempt to destroy passwd file' },
  { source: String.raw`echo\s+.*>\s*/etc/shadow`, description: 'attempt to modify shadow file' },

  // Windows dangerous patterns
  { source: String.raw`format\s+[a-zA-Z]:`, description: 'disk format command' },
  { source: String.raw`del\s+/[fFsS]\s+[a-zA-Z]:\\Windows`, description: 'Windows system file deletion' },
  { source: String.raw`rd\s+/[sS]\s+/[qQ]\s+[a-zA-Z]:\\Windows`, description: 'Windows directory deletion' },
  { source: String.raw`rd\s+/[sS]\s+/[qQ]\s+[a-zA-Z]:\\Program`, description: 'Program Files deletion' },
  { source: String.raw`attrib\s+.*[a-zA-Z]:\\Windows`, description: 'modify Windows file attributes' },

  // PowerShell dangerous patterns
  { source: String.raw`Remove-Item\s+-Recurse\s+-Force\s+[A-Z]:\\Windows`, description: 'PowerShell Windows deletion' },
  { source: String.raw`Remove-Item\s+-Recurse\s+-Force\s+/`, description: 'PowerShell root deletion' },
  { source: String.raw`Format-Volume`, description: 'PowerShell volume format' },
  { source: String.raw`Clear-Disk`, description: 'PowerShell disk clear' },
  { source: String.raw`Initialize-Disk`, description: 'PowerShell disk initialize' },
] as const;

export const BASIC_SCRIPT_PATTERN_DESCRIPTIONS: readonly string[] = [
  ...new Set(BASIC_SCRIPT_PATTERNS.map((pattern) => pattern.description)),
];

const COMPILED_BASIC_PATTERNS: readonly { regex: RegExp; description: string }[] =
  BASIC_SCRIPT_PATTERNS.map((pattern) => ({
    // `i` mirrors the agent's `(?i)` prefix. No `s` flag, same reason as STRICT.
    regex: new RegExp(pattern.source, 'i'),
    description: pattern.description,
  }));

/** The BASIC-level descriptions this content matches, deduped, in the agent's order. */
export function detectBasicScriptPatterns(content: string): string[] {
  if (!content) return [];
  const matched: string[] = [];
  const seen = new Set<string>();
  for (const { regex, description } of COMPILED_BASIC_PATTERNS) {
    if (seen.has(description)) continue;
    if (regex.test(content)) {
      seen.add(description);
      matched.push(description);
    }
  }
  return matched;
}

export type StrictScriptPattern = {
  /**
   * The regex source, mirroring the Go pattern verbatim. Matched
   * case-insensitively, exactly as the agent compiles it with `(?i)`.
   */
  readonly source: string;
  /**
   * The agent's description for this pattern. This is the value stored in
   * `scripts.acknowledged_security_patterns` and compared on the device — it
   * must match the Go string byte-for-byte and must never be translated.
   */
  readonly description: string;
  /** Plain-language explanation of the risk, for the acknowledgement UI. */
  readonly explanation: string;
};

/**
 * Mirror of `strictPatterns` in `agent/internal/executor/security.go`, in the
 * same order. Two descriptions intentionally appear twice (the `curl`/`wget`
 * pipe-to-shell pairs); acknowledging one acknowledges both, which is correct
 * — they describe the same risk.
 */
export const STRICT_SCRIPT_PATTERNS: readonly StrictScriptPattern[] = [
  // Network exfiltration patterns
  {
    source: String.raw`curl\s+.*\|\s*bash`,
    description: 'remote code execution via curl',
    explanation:
      'Downloads a remote script with curl and pipes it straight into a shell. Whatever the remote server serves at run time is executed with this script’s privileges.',
  },
  {
    source: String.raw`wget\s+.*\|\s*bash`,
    description: 'remote code execution via wget',
    explanation:
      'Downloads a remote script with wget and pipes it straight into a shell. Whatever the remote server serves at run time is executed with this script’s privileges.',
  },
  {
    source: String.raw`curl\s+.*\|\s*sh`,
    description: 'remote code execution via curl',
    explanation:
      'Downloads a remote script with curl and pipes it straight into a shell. Whatever the remote server serves at run time is executed with this script’s privileges.',
  },
  {
    source: String.raw`wget\s+.*\|\s*sh`,
    description: 'remote code execution via wget',
    explanation:
      'Downloads a remote script with wget and pipes it straight into a shell. Whatever the remote server serves at run time is executed with this script’s privileges.',
  },
  {
    source: String.raw`Invoke-WebRequest.*\|\s*Invoke-Expression`,
    description: 'PowerShell remote execution',
    explanation:
      'Fetches remote content and evaluates it as PowerShell. The code that runs is whatever the remote host returns at run time, not what is reviewed here.',
  },
  {
    source: String.raw`IEX\s*\(\s*\(New-Object`,
    description: 'PowerShell download cradle',
    explanation:
      'The classic PowerShell download-and-execute cradle. Legitimate in installers, but it executes code that is not visible in this script.',
  },
  {
    source: String.raw`DownloadString\s*\(`,
    description: 'PowerShell download string',
    explanation:
      'Pulls a string from a remote URL, usually as the first half of a download-and-execute chain.',
  },

  // Credential access patterns. The three tool-name tokens are XOR-obfuscated
  // for the same reason the Go source obfuscates them — see OBFUSCATION_KEY.
  {
    source: decodeObfuscated([0x37, 0x33, 0x37, 0x33, 0x31, 0x3b, 0x2e, 0x20]),
    description: 'credential dumping tool',
    explanation:
      'References a well-known credential-dumping tool. Acknowledge only for a deliberate, authorised security exercise — this extracts passwords and hashes from memory.',
  },
  {
    source: decodeObfuscated([0x29, 0x3f, 0x31, 0x2f, 0x28, 0x36, 0x29, 0x3b]),
    description: 'credential extraction',
    explanation:
      'References a known credential-extraction technique. Acknowledge only for a deliberate, authorised security exercise.',
  },
  {
    source: decodeObfuscated([0x36, 0x29, 0x3b, 0x3e, 0x2f, 0x37, 0x2a]),
    description: 'LSA dump',
    explanation:
      'Dumps the Windows LSA secrets store, which holds cached credentials and service account passwords.',
  },
  {
    source: String.raw`Get-Credential`,
    description: 'PowerShell credential prompt',
    explanation:
      'Prompts for credentials. On an unattended agent run there is no one to answer the prompt, so this usually hangs until the timeout.',
  },
  {
    source: String.raw`ConvertTo-SecureString`,
    description: 'PowerShell secure string (may be legitimate)',
    explanation:
      'Builds a SecureString, commonly from a plaintext password embedded in the script. Prefer a secret parameter over a literal credential in the script body.',
  },

  // Persistence patterns
  {
    source: String.raw`schtasks\s+/create`,
    description: 'scheduled task creation',
    explanation:
      'Creates a Windows scheduled task, which keeps running after this script finishes and survives reboots.',
  },
  {
    source: String.raw`at\s+\d+:\d+`,
    description: 'at job creation',
    explanation:
      'Schedules a job to run later. Also matches ordinary prose containing a clock time, so it fires on some harmless scripts.',
  },
  {
    source: String.raw`crontab\s+-[el]`,
    description: 'crontab modification',
    explanation:
      'Reads or edits a crontab. Editing installs work that keeps running after this script finishes.',
  },
  {
    source: String.raw`Register-ScheduledTask`,
    description: 'PowerShell scheduled task',
    explanation:
      'Registers a Windows scheduled task, which keeps running after this script finishes and survives reboots.',
  },
  {
    source: String.raw`New-Service`,
    description: 'PowerShell service creation',
    explanation:
      'Creates a Windows service, which runs as SYSTEM and starts automatically at boot.',
  },

  // Privilege escalation patterns
  {
    source: String.raw`setuid`,
    description: 'setuid manipulation',
    explanation:
      'Touches the setuid bit, which lets a binary run as its owner rather than as the caller.',
  },
  {
    source: String.raw`setgid`,
    description: 'setgid manipulation',
    explanation:
      'Touches the setgid bit, which lets a binary run with its group rather than the caller’s.',
  },
  {
    source: String.raw`chmod\s+[0-7]*[4-7][0-7]{2}`,
    description: 'setuid/setgid chmod',
    explanation:
      'A chmod mode with the setuid/setgid bit set. Also matches some ordinary four-digit modes, so it fires on harmless scripts too.',
  },

  // Registry modification (Windows)
  {
    source: String.raw`reg\s+add\s+HKLM`,
    description: 'HKLM registry modification',
    explanation:
      'Writes a machine-wide registry value. Routine configuration management — acknowledge it if the script is meant to change HKLM.',
  },
  {
    source: String.raw`Set-ItemProperty\s+.*HKLM`,
    description: 'PowerShell HKLM modification',
    explanation:
      'Sets a machine-wide registry value. Routine configuration management — acknowledge it if the script is meant to change HKLM.',
  },
  {
    source: String.raw`New-ItemProperty\s+.*HKLM`,
    description: 'PowerShell HKLM property creation',
    explanation:
      'Creates a machine-wide registry value. Routine configuration management — acknowledge it if the script is meant to change HKLM.',
  },

  // System modification
  {
    source: String.raw`visudo`,
    description: 'sudoers modification',
    explanation: 'Edits the sudoers file, which decides who can act as root on the device.',
  },
  {
    source: String.raw`/etc/sudoers`,
    description: 'sudoers file access',
    explanation: 'Reads or writes the sudoers file, which decides who can act as root on the device.',
  },
  {
    source: String.raw`passwd\s+-d`,
    description: 'password removal',
    explanation: 'Removes a local account’s password, leaving the account able to log in with none.',
  },
  {
    source: String.raw`usermod\s+-[aG].*sudo`,
    description: 'sudo group modification',
    explanation: 'Adds an account to the sudo group, granting it root on the device.',
  },
  {
    source: String.raw`net\s+localgroup\s+administrators`,
    description: 'Windows admin group modification',
    explanation:
      'Reads or changes the local Administrators group. Changing it grants or removes local admin on the device.',
  },
] as const;

/**
 * Every distinct Strict description, in first-appearance order. This is the
 * closed vocabulary an acknowledgement may draw from.
 */
export const STRICT_SCRIPT_PATTERN_DESCRIPTIONS: readonly string[] = [
  ...new Set(STRICT_SCRIPT_PATTERNS.map((pattern) => pattern.description)),
];

const DESCRIPTION_SET = new Set(STRICT_SCRIPT_PATTERN_DESCRIPTIONS);

/** Is this string one of the agent's Strict-level pattern descriptions? */
export function isStrictScriptPatternDescription(description: string): boolean {
  return DESCRIPTION_SET.has(description);
}

/** The explanation shown next to a matched description in the acknowledgement UI. */
export function strictScriptPatternExplanation(description: string): string | undefined {
  return STRICT_SCRIPT_PATTERNS.find((pattern) => pattern.description === description)?.explanation;
}

/**
 * Compiled once at module load. Compiling per call would re-parse 28 regexes
 * on every keystroke in the script editor.
 *
 * `i` mirrors the agent's `(?i)` prefix. No `s` flag: the agent does not use
 * `(?s)` either, so `.` must not cross a newline on this side either — a
 * mirror that matched MORE than the agent would let an admin acknowledge a
 * pattern the device never reports.
 */
const COMPILED_PATTERNS: readonly { regex: RegExp; description: string }[] = STRICT_SCRIPT_PATTERNS.map(
  (pattern) => ({ regex: new RegExp(pattern.source, 'i'), description: pattern.description }),
);

/**
 * The Strict-level pattern descriptions this script content matches, deduped
 * and in the agent's own pattern order.
 *
 * This is what the editor shows for acknowledgement and what the API
 * intersects a submitted acknowledgement against — an admin can only
 * acknowledge a pattern the content actually contains, so no one can
 * pre-acknowledge the whole vocabulary and permanently disarm the check.
 */
export function detectStrictScriptPatterns(content: string): string[] {
  if (!content) return [];
  const matched: string[] = [];
  const seen = new Set<string>();
  for (const { regex, description } of COMPILED_PATTERNS) {
    if (seen.has(description)) continue;
    if (regex.test(content)) {
      seen.add(description);
      matched.push(description);
    }
  }
  return matched;
}
