package executor

import (
	"regexp"
	"strings"
)

// PowerShell placeholder rendering.
//
// Placeholders become `${env:BREEZE_PARAM_KEY}`, which PowerShell reads from
// the process environment at run time, so the value is never parsed as code.
// A single-quoted literal cannot expand anything, so the whole literal is
// rewritten into a double-quoted one with the author's own fragments escaped —
// closing the literal and concatenating does not work in argument mode
// (`Write-Host 'a'+$x` prints `a+…`). A literal here-string has no escape at
// all and is rejected.

type psFrameKind int

const (
	psCode psFrameKind = iota
	psDouble
	psHereExpanding
)

type psFrame struct {
	kind psFrameKind
	// subexpr marks a `$( )` frame opened inside a string, which ends at its
	// matching `)`.
	subexpr bool
	depth   int
}

type psRenderer struct {
	*scanner
	frames []*psFrame
}

// psInvokeExpressionLine matches a statement that hands its argument to the
// PowerShell parser. A value cannot be data there, so those lines are rejected.
var psInvokeExpressionLine = regexp.MustCompile(`(?i)(^|[\s;|&({])(invoke-expression|iex)(\s|\(|$)`)

func renderPowerShellParameters(content string, params map[string]string) (string, bool, error) {
	r := &psRenderer{scanner: newScanner(content, params)}
	r.frames = []*psFrame{{kind: psCode}}
	for !r.done() {
		var err error
		switch f := r.top(); f.kind {
		case psCode:
			err = r.stepCode(f)
		case psDouble:
			err = r.stepDouble(f)
		case psHereExpanding:
			err = r.stepHereExpanding(f)
		}
		if err != nil {
			return "", false, err
		}
	}
	return r.out.String(), r.used, nil
}

func (r *psRenderer) top() *psFrame { return r.frames[len(r.frames)-1] }

func (r *psRenderer) push(f *psFrame) { r.frames = append(r.frames, f) }

func (r *psRenderer) pop() {
	if len(r.frames) > 1 {
		r.frames = r.frames[:len(r.frames)-1]
	}
}

func psRef(key string) string { return "${env:" + parameterEnvName(key) + "}" }

func psHint(key string) string {
	return "reference it as $env:" + parameterEnvName(key) +
		" (the agent exports every parameter into the environment) instead of using a placeholder here"
}

// emitPS renders one placeholder in an expanding context.
func (r *psRenderer) emitPS(key, value string, width int, allowNumeric bool) error {
	if psInvokeExpressionLine.MatchString(r.src[lineStart(r.src, r.i):r.i]) {
		return renderErr(key, "an Invoke-Expression (iex) statement, which parses its argument as code",
			psHint(key))
	}
	if allowNumeric && decimalValuePattern.MatchString(value) {
		// Keep `$x = {{n}}` typed as a number rather than a string.
		r.emit(value, width)
		return nil
	}
	r.emit(psRef(key), width)
	return nil
}

func (r *psRenderer) stepCode(f *psFrame) error {
	if key, width, ok := r.placeholder(); ok {
		value, known := r.value(key)
		if !known {
			r.skipLiteral(width)
			return nil
		}
		return r.emitPS(key, value, width, true)
	}
	switch {
	case r.cur() == '`':
		r.copyN(2)
	case r.hasPrefix("<#"):
		return r.scanBlockComment()
	case r.cur() == '#':
		return r.scanLineComment()
	case r.isHereStringStart('"'):
		r.copyN(2)
		r.push(&psFrame{kind: psHereExpanding})
	case r.isHereStringStart('\''):
		return r.scanLiteralHereString()
	case r.cur() == '\'':
		return r.scanSingleQuoted()
	case r.cur() == '"':
		r.copyByte()
		r.push(&psFrame{kind: psDouble})
	case r.hasPrefix("$("):
		r.copyN(2)
		r.push(&psFrame{kind: psCode, subexpr: true})
	case r.cur() == '(':
		if f.subexpr {
			f.depth++
		}
		r.copyByte()
	case r.cur() == ')':
		r.copyByte()
		if f.subexpr {
			if f.depth > 0 {
				f.depth--
			} else {
				r.pop()
			}
		}
	default:
		r.copyByte()
	}
	return nil
}

func (r *psRenderer) stepDouble(f *psFrame) error {
	if key, width, ok := r.placeholder(); ok {
		value, known := r.value(key)
		if !known {
			r.skipLiteral(width)
			return nil
		}
		return r.emitPS(key, value, width, false)
	}
	switch {
	case r.cur() == '`':
		r.copyN(2)
	case r.hasPrefix(`""`):
		r.copyN(2)
	case r.cur() == '"':
		r.copyByte()
		r.pop()
	case r.hasPrefix("$("):
		r.copyN(2)
		r.push(&psFrame{kind: psCode, subexpr: true})
	default:
		r.copyByte()
	}
	return nil
}

func (r *psRenderer) stepHereExpanding(f *psFrame) error {
	if key, width, ok := r.placeholder(); ok {
		value, known := r.value(key)
		if !known {
			r.skipLiteral(width)
			return nil
		}
		return r.emitPS(key, value, width, false)
	}
	// The terminator is `"@` at the start of a line.
	if r.cur() == '"' && r.hasPrefix(`"@`) && lineStart(r.src, r.i) == r.i {
		r.copyN(2)
		r.pop()
		return nil
	}
	r.copyByte()
	return nil
}

// isHereStringStart reports whether the cursor is at `@"` / `@'` opening a
// here-string (the quote must be the last thing on the line).
func (r *psRenderer) isHereStringStart(quote byte) bool {
	if !r.hasPrefix("@" + string(quote)) {
		return false
	}
	rest := r.src[r.i+2:]
	if idx := strings.IndexByte(rest, '\n'); idx >= 0 {
		rest = rest[:idx]
	}
	return strings.TrimSpace(rest) == ""
}

func (r *psRenderer) scanLineComment() error {
	for !r.done() && r.cur() != '\n' {
		if key, width, ok := r.placeholder(); ok {
			if _, known := r.value(key); known {
				r.emit(psRef(key), width)
				continue
			}
			r.skipLiteral(width)
			continue
		}
		r.copyByte()
	}
	return nil
}

func (r *psRenderer) scanBlockComment() error {
	r.copyN(2)
	for !r.done() {
		if r.hasPrefix("#>") {
			r.copyN(2)
			return nil
		}
		if key, width, ok := r.placeholder(); ok {
			if _, known := r.value(key); known {
				r.emit(psRef(key), width)
				continue
			}
			r.skipLiteral(width)
			continue
		}
		r.copyByte()
	}
	return nil
}

// scanLiteralHereString copies a `@' … '@` literal here-string through. Nothing
// expands inside one and there is no escape character, so a placeholder there
// cannot be rendered as a reference.
func (r *psRenderer) scanLiteralHereString() error {
	start := r.i
	end := len(r.src)
	for i := r.i + 2; i < len(r.src); i++ {
		if r.src[i] == '\'' && i+1 < len(r.src) && r.src[i+1] == '@' && lineStart(r.src, i) == i {
			end = i + 2
			break
		}
	}
	body := r.src[start:end]
	for off := 0; off < len(body); off++ {
		probe := &scanner{src: body, i: off, params: r.params}
		key, _, ok := probe.placeholder()
		if !ok {
			continue
		}
		if _, known := r.value(key); known {
			return renderErr(key, "a PowerShell literal here-string (@' … '@), where nothing is expanded",
				"use an expanding here-string (@\" … \"@) and write $env:"+parameterEnvName(key)+" in it")
		}
	}
	r.copyN(end - start)
	return nil
}

// scanSingleQuoted rewrites a single-quoted literal that contains at least one
// parameter placeholder into a double-quoted literal: the author's fragments
// are escaped for the new quoting and the placeholders become env references.
func (r *psRenderer) scanSingleQuoted() error {
	// Locate the end of the literal. `''` is an escaped quote.
	end := -1
	for i := r.i + 1; i < len(r.src); i++ {
		if r.src[i] != '\'' {
			continue
		}
		if i+1 < len(r.src) && r.src[i+1] == '\'' {
			i++
			continue
		}
		end = i
		break
	}
	if end < 0 {
		// Unterminated literal: copy the rest verbatim, let PowerShell report it.
		r.copyN(len(r.src) - r.i)
		return nil
	}
	inner := r.src[r.i+1 : end]

	var rebuilt strings.Builder
	rebuilt.WriteString(`"`)
	var fragment strings.Builder
	found := false
	for off := 0; off < len(inner); {
		probe := &scanner{src: inner, i: off, params: r.params}
		if key, width, ok := probe.placeholder(); ok {
			if _, known := r.value(key); known {
				found = true
				rebuilt.WriteString(escapePSDoubleFragment(strings.ReplaceAll(fragment.String(), "''", "'")))
				fragment.Reset()
				rebuilt.WriteString(psRef(key))
				off += width
				continue
			}
		}
		fragment.WriteByte(inner[off])
		off++
	}
	if !found {
		r.copyN(end + 1 - r.i)
		return nil
	}
	if psInvokeExpressionLine.MatchString(r.src[lineStart(r.src, r.i):r.i]) {
		probe := &scanner{src: inner, params: r.params}
		for off := 0; off < len(inner); off++ {
			probe.i = off
			if key, _, ok := probe.placeholder(); ok {
				if _, known := r.value(key); known {
					return renderErr(key, "an Invoke-Expression (iex) statement, which parses its argument as code",
						psHint(key))
				}
			}
		}
	}
	rebuilt.WriteString(escapePSDoubleFragment(strings.ReplaceAll(fragment.String(), "''", "'")))
	rebuilt.WriteString(`"`)
	r.out.WriteString(rebuilt.String())
	r.i = end + 1
	r.used = true
	return nil
}

// escapePSDoubleFragment escapes a fragment of a former single-quoted literal
// for its new double-quoted home: backtick, `"` and `$` all become backtick
// escapes. One pass, so an escape we add is never escaped again.
func escapePSDoubleFragment(s string) string {
	var b strings.Builder
	b.Grow(len(s) + 8)
	for i := 0; i < len(s); i++ {
		switch s[i] {
		case '`':
			b.WriteString("``")
		case '"':
			b.WriteString("`\"")
		case '$':
			b.WriteString("`$")
		default:
			b.WriteByte(s[i])
		}
	}
	return b.String()
}
