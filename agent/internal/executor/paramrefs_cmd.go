package executor

import (
	"regexp"
	"strings"
)

// cmd.exe placeholder rendering.
//
// `%VAR%` expansion happens BEFORE the line is parsed, so a value containing
// `&` or `|` would execute — it is not usable as a carrier. Delayed expansion
// (`!VAR!`) substitutes AFTER parsing and inserts the value verbatim without
// re-parsing it, so that is what we emit; Execute adds `/V:ON` to the cmd.exe
// invocation when at least one placeholder was rendered.
//
// The cost of `/V:ON` is that a literal `!` in the author's own script text is
// consumed by delayed expansion. It only applies to scripts that actually use
// parameters.
//
// `call` re-parses its command line a second time (that is why `%%` behaves
// differently there), and a `for /f … in ( )` clause parses its contents as a
// command, so a delayed-expansion value is not data in either: both are
// rejected.
//
// The `call` test applies to the STATEMENT the placeholder is in, not to the
// whole line: cmd splits a line on unquoted `&`, `&&`, `||`, `|` and on
// parenthesised blocks, so `call foo & echo {{p}}` re-parses only `call foo`.
// Matching the whole line rejected the `echo` statement too. The statement is
// still matched loosely (anywhere inside it) rather than by first word, so a
// `call` behind an `if`/`for`/`else` prefix — `if exist x call y {{p}}` — is
// still rejected.

var (
	cmdCallLine   = regexp.MustCompile(`(?i)(^|[\s&(|@])call\s`)
	cmdForFClause = regexp.MustCompile(`(?i)\bfor\b[^)]*\bin\s*\([^)]*$`)
)

func cmdHint(key string) string {
	return "read it as %" + parameterEnvName(key) +
		"% (the agent exports every parameter into the environment) instead of using a placeholder here"
}

func renderCMDParameters(content string, params map[string]string) (string, bool, error) {
	r := newScanner(content, params)
	for !r.done() {
		key, width, ok := r.placeholder()
		if !ok {
			r.copyByte()
			continue
		}
		value, known := r.value(key)
		if !known {
			r.skipLiteral(width)
			continue
		}
		if containsNewline(value) {
			return "", false, renderErr(key, "a cmd.exe script, which has no line continuation for data",
				"the value contains a line break, which cannot be represented on a cmd line; "+cmdHint(key))
		}
		prefix := cmdLogicalPrefix(r.src, r.i)
		if cmdCallLine.MatchString(cmdStatementPrefix(prefix)) {
			return "", false, renderErr(key, "a cmd.exe `call` statement, which re-parses its command line",
				cmdHint(key))
		}
		if cmdForFClause.MatchString(prefix) {
			return "", false, renderErr(key, "a cmd.exe `for /f … in ( )` clause, whose contents are parsed as a command",
				cmdHint(key))
		}
		r.emit("!"+parameterEnvName(key)+"!", width)
	}
	return r.out.String(), r.used, nil
}

// cmdLogicalPrefix returns the text of the LOGICAL cmd line up to pos: the
// physical line holding pos, with every preceding physical line that ended in a
// caret continuation joined onto the front exactly as cmd joins them (the `^`
// and the newline are both dropped).
//
// Both guards below used to read the physical line only, so a trailing `^`
// carried `call` or a `for /f … in (` clause onto the next line and out of
// their view. A caret pair (`^^`) is an escaped caret, not a continuation, so
// only an ODD run of trailing carets continues the line. Quote state is not
// tracked across the join: over-joining can only widen the guards.
func cmdLogicalPrefix(src string, pos int) string {
	start := lineStart(src, pos)
	parts := []string{strings.ReplaceAll(src[start:pos], "\r", "")}
	for start > 0 {
		newline := start - 1 // the '\n' that ended the previous physical line
		prevStart := lineStart(src, newline)
		prev := strings.ReplaceAll(src[prevStart:newline], "\r", "")
		if !cmdLineContinues(prev) {
			break
		}
		parts = append(parts, prev[:len(prev)-1])
		start = prevStart
	}
	for i, j := 0, len(parts)-1; i < j; i, j = i+1, j-1 {
		parts[i], parts[j] = parts[j], parts[i]
	}
	return strings.Join(parts, "")
}

// cmdLineContinues reports whether a physical line ends in an unescaped caret,
// which escapes the newline and continues the line.
func cmdLineContinues(line string) bool {
	carets := 0
	for i := len(line) - 1; i >= 0 && line[i] == '^'; i-- {
		carets++
	}
	return carets%2 == 1
}

// cmdStatementPrefix trims a line prefix back to the start of the cmd statement
// the cursor is in, by dropping everything up to the last unquoted command
// separator (`&`, `&&`, `||`, `|`) or block bracket.
//
// A caret escapes the next character, so `^&` is a literal ampersand handed to
// the command and NOT a separator: splitting on it hid the `call` that still
// re-parses the whole line. Inside double quotes cmd does not treat a caret as
// an escape, so the skip is only applied outside them.
func cmdStatementPrefix(prefix string) string {
	inQuote := false
	start := 0
	for i := 0; i < len(prefix); i++ {
		switch prefix[i] {
		case '^':
			if !inQuote {
				i++ // the escaped character is never a separator or a quote
			}
		case '"':
			inQuote = !inQuote
		case '&', '|', '(', ')':
			if !inQuote {
				start = i + 1
			}
		}
	}
	return prefix[start:]
}
