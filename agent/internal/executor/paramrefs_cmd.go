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
		prefix := r.src[lineStart(r.src, r.i):r.i]
		if cmdCallLine.MatchString(prefix) {
			return "", false, renderErr(key, "a cmd.exe `call` statement, which re-parses its command line",
				cmdHint(key))
		}
		if cmdForFClause.MatchString(strings.ReplaceAll(prefix, "\r", "")) {
			return "", false, renderErr(key, "a cmd.exe `for /f … in ( )` clause, whose contents are parsed as a command",
				cmdHint(key))
		}
		r.emit("!"+parameterEnvName(key)+"!", width)
	}
	return r.out.String(), r.used, nil
}
