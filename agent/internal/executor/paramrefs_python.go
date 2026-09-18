package executor

import (
	"strings"
)

// Python placeholder rendering.
//
// Outside a string literal a placeholder becomes
// `__import__("os").environ["BREEZE_PARAM_KEY"]` (a reference, no import line
// required), or the bare number when the value is numeric so arithmetic keeps
// working.
//
// INSIDE a string literal the value is escaped for that exact literal kind
// instead. We know the prefix (r/b/u/f combinations) and the quote style, so
// the escaping is exact rather than a guess, and rewriting the literal into a
// concatenation was what broke implicit concatenation, raw trailing
// backslashes and triple-quote edge cases. A raw literal has no escape for a
// backslash or its own quote, and a bytes literal cannot hold non-ASCII, so
// those combinations are rejected instead of mangled.
//
// An f-string is two languages in one literal: the text between `{` and `}` is
// an EXPRESSION, not string data, so escaping a value for the literal would
// still hand it to the evaluator (`f"{ {{i}} }"` with the value
// `__import__("os").system("id")` executes it). Replacement-field regions are
// tracked and a placeholder inside one is rejected.

type pyLiteral struct {
	raw    bool
	bytes  bool
	fmt    bool
	triple bool
	quote  byte
}

func pythonRef(key string) string {
	return `__import__("os").environ["` + parameterEnvName(key) + `"]`
}

func pythonHint(key string) string {
	return `read it with os.environ["` + parameterEnvName(key) +
		`"] (the agent exports every parameter into the environment) instead of using a placeholder here`
}

func renderPythonParameters(content string, params map[string]string) (string, bool, error) {
	r := newScanner(content, params)
	for !r.done() {
		if key, width, ok := r.placeholder(); ok {
			value, known := r.value(key)
			if !known {
				r.skipLiteral(width)
				continue
			}
			if decimalValuePattern.MatchString(value) {
				r.emit(value, width)
				continue
			}
			r.emit(pythonRef(key), width)
			continue
		}
		switch r.cur() {
		case '#':
			scanPythonComment(r)
		case '\'', '"':
			if err := scanPythonString(r); err != nil {
				return "", false, err
			}
		case '\\':
			r.copyN(2)
		default:
			r.copyByte()
		}
	}
	return r.out.String(), r.used, nil
}

func scanPythonComment(r *scanner) {
	for !r.done() && r.cur() != '\n' {
		if key, width, ok := r.placeholder(); ok {
			if _, known := r.value(key); known {
				r.emit(`os.environ["`+parameterEnvName(key)+`"]`, width)
				continue
			}
			r.skipLiteral(width)
			continue
		}
		r.copyByte()
	}
}

// pythonLiteralPrefix reads the string prefix (r, b, u, f and combinations)
// immediately before the cursor, which the code path has already copied out.
func pythonLiteralPrefix(src string, quotePos int) pyLiteral {
	j := quotePos
	for j > 0 && isPythonPrefixByte(src[j-1]) {
		j--
	}
	// The prefix may not be the tail of a longer identifier.
	if j > 0 && isIdentByte(src[j-1]) {
		return pyLiteral{}
	}
	prefix := strings.ToLower(src[j:quotePos])
	if len(prefix) > 2 {
		return pyLiteral{}
	}
	lit := pyLiteral{}
	for i := 0; i < len(prefix); i++ {
		switch prefix[i] {
		case 'r':
			lit.raw = true
		case 'b':
			lit.bytes = true
		case 'f':
			lit.fmt = true
		case 'u':
			// no effect
		}
	}
	return lit
}

func isPythonPrefixByte(c byte) bool {
	switch c {
	case 'r', 'R', 'b', 'B', 'u', 'U', 'f', 'F':
		return true
	}
	return false
}

// scanPythonString copies a string literal through, escaping any parameter
// value spliced into it for that literal's exact kind.
func scanPythonString(r *scanner) error {
	lit := pythonLiteralPrefix(r.src, r.i)
	lit.quote = r.cur()
	quoteRun := string(lit.quote)
	if strings.HasPrefix(r.src[r.i:], strings.Repeat(quoteRun, 3)) {
		lit.triple = true
		quoteRun = strings.Repeat(quoteRun, 3)
	}
	r.copyN(len(quoteRun))

	// field is the f-string replacement-field nesting depth. At depth 0 the
	// cursor is in string data; above 0 it is inside an expression or a nested
	// format spec, where a value cannot be carried as escaped text.
	field := 0
	for !r.done() {
		if key, width, ok := r.placeholder(); ok {
			value, known := r.value(key)
			if !known {
				r.skipLiteral(width)
				continue
			}
			if field > 0 {
				return renderErr(key, "an f-string replacement field, which Python evaluates as an expression",
					pythonHint(key))
			}
			escaped, err := pythonEscapeValue(key, value, lit)
			if err != nil {
				return err
			}
			r.emit(escaped, width)
			continue
		}
		if lit.fmt {
			switch {
			case field == 0 && (r.hasPrefix("{{") || r.hasPrefix("}}")):
				// `{{` / `}}` are escaped braces, not a field.
				r.copyN(2)
				continue
			case field > 0 && (r.cur() == '\'' || r.cur() == '"'):
				// A STRING nested in a replacement field is expression data:
				// its braces are not field delimiters. Counting them let a
				// `'}'` close the field early, so a placeholder after it was
				// treated as string data and its value was escaped into an
				// expression slot instead of being rejected.
				if err := scanPythonNestedString(r); err != nil {
					return err
				}
				continue
			case field > 0 && lit.triple && r.cur() == '#':
				// PEP 701 (Python 3.12+): a `#` comment is legal inside a
				// MULTI-LINE f-string replacement field and runs to the end of
				// the line, so a `}` in it is comment text and not the end of
				// the field. Counting that brace desynced `field` and demoted
				// the placeholder after it to string data — the value was then
				// escaped into an expression slot instead of being rejected.
				if err := scanPythonFieldComment(r); err != nil {
					return err
				}
				continue
			case r.cur() == '{':
				field++
				r.copyByte()
				continue
			case r.cur() == '}' && field > 0:
				field--
				r.copyByte()
				continue
			}
		}
		if r.cur() == '\\' {
			// A backslash escapes the next character even in a raw literal, as
			// far as finding the end of the literal goes.
			r.copyN(2)
			continue
		}
		if r.hasPrefix(quoteRun) {
			r.copyN(len(quoteRun))
			return nil
		}
		if !lit.triple && r.cur() == '\n' {
			// Unterminated single-line literal; let Python report it.
			return nil
		}
		r.copyByte()
	}
	return nil
}

// scanPythonFieldComment copies a `#` comment inside a multi-line f-string
// replacement field through to the end of its line. A placeholder inside the
// comment is still inside the field, so it is rejected for the same reason one
// in the expression itself is — the cursor is in a region Python parses as code.
func scanPythonFieldComment(r *scanner) error {
	for !r.done() && r.cur() != '\n' {
		if key, width, ok := r.placeholder(); ok {
			if _, known := r.value(key); known {
				return renderErr(key, "an f-string replacement field, which Python evaluates as an expression",
					pythonHint(key))
			}
			r.skipLiteral(width)
			continue
		}
		r.copyByte()
	}
	return nil
}

// scanPythonNestedString copies a string literal nested inside an f-string
// replacement field, so that nothing in it — a brace, or the outer literal's
// own quote character, which Python 3.12+ allows here — is read as f-string
// syntax. A placeholder inside it is still inside the replacement field, so it
// is rejected for the same reason one directly in the expression is.
func scanPythonNestedString(r *scanner) error {
	quote := r.cur()
	run := string(quote)
	if strings.HasPrefix(r.src[r.i:], strings.Repeat(run, 3)) {
		run = strings.Repeat(run, 3)
	}
	r.copyN(len(run))
	for !r.done() {
		if key, width, ok := r.placeholder(); ok {
			if _, known := r.value(key); known {
				return renderErr(key, "an f-string replacement field, which Python evaluates as an expression",
					pythonHint(key))
			}
			r.skipLiteral(width)
			continue
		}
		switch {
		case r.cur() == '\\':
			r.copyN(2)
		case r.hasPrefix(run):
			r.copyN(len(run))
			return nil
		case len(run) == 1 && r.cur() == '\n':
			// Unterminated single-line literal; let Python report it.
			return nil
		default:
			r.copyByte()
		}
	}
	return nil
}

// pythonEscapeValue escapes a parameter value so it is one datum inside the
// given literal.
func pythonEscapeValue(key, value string, lit pyLiteral) (string, error) {
	if lit.bytes && !isASCII(value) {
		return "", renderErr(key, "a Python bytes literal (b\"…\")",
			"the value is not ASCII and cannot be placed in a bytes literal; "+pythonHint(key))
	}
	if lit.raw {
		if strings.Contains(value, `\`) {
			return "", renderErr(key, "a Python raw string literal (r\"…\")",
				"the value contains a backslash, which a raw literal cannot escape; "+pythonHint(key))
		}
		if strings.IndexByte(value, lit.quote) >= 0 {
			return "", renderErr(key, "a Python raw string literal (r\"…\")",
				"the value contains the literal's quote character, which a raw literal cannot escape; "+pythonHint(key))
		}
		if !lit.triple && containsNewline(value) {
			return "", renderErr(key, "a Python raw string literal (r\"…\")",
				"the value contains a newline, which a single-line raw literal cannot hold; "+pythonHint(key))
		}
		if lit.fmt {
			value = strings.ReplaceAll(value, "{", "{{")
			value = strings.ReplaceAll(value, "}", "}}")
		}
		return value, nil
	}

	var b strings.Builder
	b.Grow(len(value) + 8)
	for i := 0; i < len(value); i++ {
		switch c := value[i]; c {
		case '\\':
			b.WriteString(`\\`)
		case '\'':
			b.WriteString(`\'`)
		case '"':
			b.WriteString(`\"`)
		case '\r':
			b.WriteString(`\r`)
		case '\n':
			b.WriteString(`\n`)
		case 0:
			b.WriteString(`\x00`)
		case '{':
			if lit.fmt {
				b.WriteString("{{")
			} else {
				b.WriteByte(c)
			}
		case '}':
			if lit.fmt {
				b.WriteString("}}")
			} else {
				b.WriteByte(c)
			}
		default:
			b.WriteByte(c)
		}
	}
	return b.String(), nil
}
