package executor

import (
	"strings"
)

// Bash placeholder rendering.
//
// The scanner below tracks just enough of bash's grammar to classify the
// syntactic context of each placeholder: quoting (unquoted, single, double,
// `$'…'`), command substitution (`$( )` and backticks, which reset quoting),
// arithmetic (`$(( ))`, `(( ))`, `$[ ]`, `${name:off}`, `name[sub]`),
// conditional expressions (`[[ ]]`), comments, and heredocs (quoted and
// unquoted delimiters, `<<-`). It also tracks the command word of the current
// simple command, because a handful of builtins re-interpret their arguments.

// bashFrameKind is the kind of region the scanner is currently inside.
type bashFrameKind int

const (
	// bfCode is script text with quoting off: the top level, a `$( )` body or
	// a backtick body. Each carries its own simple-command state.
	bfCode bashFrameKind = iota
	bfSingle
	bfAnsi
	bfDouble
	bfArith
	bfBracket
)

type bashFrame struct {
	kind bashFrameKind

	// closer/depth track the end of an arithmetic region: "))" for `$(( ))`,
	// `(( ))` and `$[`-style `]` for subscripts.
	closer string
	depth  int

	// backtick marks a bfCode frame opened by a backtick rather than `$(`.
	backtick bool
	// subst marks a bfCode frame opened by `$(`.
	subst bool

	// Simple-command state (bfCode only).
	cmdWord string
	args    []string
	curWord strings.Builder
	sawIn   bool
}

type bashHeredoc struct {
	delim  string
	quoted bool
	strip  bool
}

type bashRenderer struct {
	*scanner
	frames  []*bashFrame
	pending []bashHeredoc
}

// renderBashParameters rewrites placeholders in a bash script into references
// to the matching BREEZE_PARAM_* environment variable.
func renderBashParameters(content string, params map[string]string) (string, bool, error) {
	r := &bashRenderer{scanner: newScanner(content, params)}
	r.push(&bashFrame{kind: bfCode})
	for !r.done() {
		var err error
		switch f := r.top(); f.kind {
		case bfCode:
			err = r.stepCode(f)
		case bfSingle:
			err = r.stepSingle(f)
		case bfAnsi:
			err = r.stepAnsi(f)
		case bfDouble:
			err = r.stepDouble(f)
		case bfArith:
			err = r.stepArith(f)
		case bfBracket:
			err = r.stepBracket(f)
		}
		if err != nil {
			return "", false, err
		}
	}
	return r.out.String(), r.used, nil
}

func (r *bashRenderer) push(f *bashFrame) { r.frames = append(r.frames, f) }

func (r *bashRenderer) pop() {
	if len(r.frames) > 1 {
		r.frames = r.frames[:len(r.frames)-1]
	}
}

func (r *bashRenderer) top() *bashFrame { return r.frames[len(r.frames)-1] }

// codeFrame is the innermost bfCode frame, which owns the simple-command state
// that applies to the cursor (quoting frames do not reset the command word).
func (r *bashRenderer) codeFrame() *bashFrame {
	for i := len(r.frames) - 1; i >= 0; i-- {
		if r.frames[i].kind == bfCode {
			return r.frames[i]
		}
	}
	return nil
}

// ---------------------------------------------------------------- emission

type bashForm int

const (
	// formWord emits a double-quoted reference: safe as a standalone word in
	// an unquoted context (no word splitting, no globbing).
	formWord bashForm = iota
	// formInterp emits a bare `${NAME}` for contexts that already expand and
	// do not word-split (inside double quotes, an unquoted heredoc, comments).
	formInterp
	// formSingle closes the single-quoted string, splices a double-quoted
	// reference, and reopens it — still one shell word.
	formSingle
	// formAnsi is formSingle for `$'…'`, reopening with `$'` so the remaining
	// author fragment keeps ANSI-C escape processing.
	formAnsi
)

func bashRef(key string, form bashForm) string {
	name := parameterEnvName(key)
	switch form {
	case formInterp:
		return "${" + name + "}"
	case formSingle:
		return "'\"${" + name + "}\"'"
	case formAnsi:
		return "'\"${" + name + "}\"$'"
	default:
		return "\"${" + name + "}\""
	}
}

func bashHint(key string) string {
	return "reference it as $" + parameterEnvName(key) +
		" (the agent exports every parameter into the environment) instead of using a placeholder here"
}

// commandRule describes how the current simple command re-interprets its
// arguments.
type commandRule int

const (
	ruleNormal commandRule = iota
	// ruleForbidden: the command evaluates its arguments as shell code.
	ruleForbidden
	// ruleArith: the argument is evaluated as an arithmetic expression, which
	// dereferences variables recursively — only an integer literal is safe.
	ruleArith
	// ruleName: the argument names a variable to write into.
	ruleName
)

func (r *bashRenderer) commandRule(f *bashFrame) (commandRule, string) {
	if f == nil || f.cmdWord == "" {
		return ruleNormal, ""
	}
	word := f.cmdWord
	switch word {
	case "eval", "trap", "alias":
		return ruleForbidden, word
	case "let":
		return ruleArith, word
	case "read", "unset", "mapfile", "readarray", "getopts":
		return ruleName, word
	case "declare", "typeset", "local", "readonly", "export":
		if f.hasFlag("-i") {
			return ruleArith, word
		}
		if f.hasFlag("-n") {
			return ruleName, word
		}
	case "printf":
		if f.hasFlag("-v") {
			return ruleName, word
		}
	case "for", "select":
		if !f.sawIn {
			return ruleName, word
		}
	}
	return ruleNormal, ""
}

func (f *bashFrame) hasFlag(flag string) bool {
	for _, a := range f.args {
		if a == flag {
			return true
		}
		// Bundled short flags: `declare -ig` still declares an integer.
		if len(a) > 1 && a[0] == '-' && a[1] != '-' && strings.ContainsRune(a[1:], rune(flag[1])) {
			return true
		}
	}
	return false
}

// emitPlaceholder renders one placeholder whose key IS a parameter, applying
// the command-level rules first and the quoting form second.
func (r *bashRenderer) emitPlaceholder(key, value string, width int, form bashForm) error {
	rule, word := r.commandRule(r.codeFrame())
	switch rule {
	case ruleForbidden:
		return renderErr(key, "a bash `"+word+"` command, which evaluates its arguments as shell code",
			bashHint(key))
	case ruleArith:
		return r.emitInteger(key, value, width, "a bash `"+word+"` arithmetic command")
	case ruleName:
		if !identifierValuePattern.MatchString(value) {
			return renderErr(key, "a variable-name position in a bash `"+word+"` command",
				"the value must be a plain identifier ([A-Za-z_][A-Za-z0-9_]*); "+bashHint(key))
		}
	}
	r.emit(bashRef(key, form), width)
	return nil
}

// emitInteger is the arithmetic-context rule: bash evaluates the CONTENTS of a
// variable as an expression there (`x='a[$(id)]'` runs `id`), so an environment
// reference is not a safe carrier. Only a digits-only value may be inlined.
func (r *bashRenderer) emitInteger(key, value string, width int, context string) error {
	if !integerValuePattern.MatchString(value) {
		return renderErr(key, context,
			"bash evaluates variable contents as an expression there, so only an integer value can be used; "+
				"make the parameter an integer, or assign $"+parameterEnvName(key)+
				" to a variable outside the expression first")
	}
	r.emit(value, width)
	return nil
}

// ---------------------------------------------------------------- contexts

func (r *bashRenderer) stepCode(f *bashFrame) error {
	if key, width, ok := r.placeholder(); ok {
		value, known := r.value(key)
		if !known {
			r.skipLiteral(width)
			return nil
		}
		f.curWord.WriteString("$")
		return r.emitPlaceholder(key, value, width, formWord)
	}

	switch c := r.cur(); {
	case c == '\\':
		r.copyN(2)
		return nil
	case c == '\n':
		f.endWord()
		f.reset()
		r.copyByte()
		return r.drainHeredocs()
	case c == '#' && f.curWord.Len() == 0:
		return r.scanComment()
	case c == '\'':
		r.copyByte()
		r.push(&bashFrame{kind: bfSingle})
		return nil
	case r.hasPrefix("$'"):
		r.copyN(2)
		r.push(&bashFrame{kind: bfAnsi})
		return nil
	case r.hasPrefix("$\""):
		r.copyN(2)
		r.push(&bashFrame{kind: bfDouble})
		return nil
	case c == '"':
		r.copyByte()
		r.push(&bashFrame{kind: bfDouble})
		return nil
	case r.hasPrefix("$(("):
		r.copyN(3)
		r.push(&bashFrame{kind: bfArith, closer: "))"})
		return nil
	case r.hasPrefix("$("):
		r.copyN(2)
		r.push(&bashFrame{kind: bfCode, subst: true})
		return nil
	case r.hasPrefix("${"):
		return r.scanParamExpansion()
	case r.hasPrefix("$["):
		r.copyN(2)
		r.push(&bashFrame{kind: bfArith, closer: "]"})
		return nil
	case c == '`':
		r.copyByte()
		if f.backtick {
			r.pop()
		} else {
			r.push(&bashFrame{kind: bfCode, backtick: true})
		}
		return nil
	case r.hasPrefix("[[") && f.curWord.Len() == 0:
		r.copyN(2)
		r.push(&bashFrame{kind: bfBracket})
		return nil
	case r.hasPrefix("((") && f.curWord.Len() == 0:
		r.copyN(2)
		r.push(&bashFrame{kind: bfArith, closer: "))"})
		return nil
	case r.hasPrefix("<<"):
		return r.scanHeredocHeader()
	case c == '[' && isBashName(f.curWord.String()):
		// `name[subscript]=` — the subscript is an arithmetic context.
		r.copyByte()
		r.push(&bashFrame{kind: bfArith, closer: "]"})
		return nil
	case c == ')':
		f.endWord()
		f.reset()
		r.copyByte()
		if f.subst {
			r.pop()
		}
		return nil
	case c == ';' || c == '&' || c == '|' || c == '(' || c == '{' || c == '}':
		f.endWord()
		f.reset()
		r.copyByte()
		return nil
	case isSpaceByte(c):
		f.endWord()
		r.copyByte()
		return nil
	default:
		f.curWord.WriteByte(c)
		r.copyByte()
		return nil
	}
}

func (r *bashRenderer) stepSingle(f *bashFrame) error {
	if key, width, ok := r.placeholder(); ok {
		if value, known := r.value(key); known {
			return r.emitPlaceholder(key, value, width, formSingle)
		}
		r.skipLiteral(width)
		return nil
	}
	if r.cur() == '\'' {
		r.copyByte()
		r.pop()
		return nil
	}
	r.copyByte()
	return nil
}

func (r *bashRenderer) stepAnsi(f *bashFrame) error {
	if key, width, ok := r.placeholder(); ok {
		if value, known := r.value(key); known {
			return r.emitPlaceholder(key, value, width, formAnsi)
		}
		r.skipLiteral(width)
		return nil
	}
	switch r.cur() {
	case '\\':
		r.copyN(2)
	case '\'':
		r.copyByte()
		r.pop()
	default:
		r.copyByte()
	}
	return nil
}

func (r *bashRenderer) stepDouble(f *bashFrame) error {
	if key, width, ok := r.placeholder(); ok {
		if value, known := r.value(key); known {
			return r.emitPlaceholder(key, value, width, formInterp)
		}
		r.skipLiteral(width)
		return nil
	}
	switch {
	case r.cur() == '\\':
		r.copyN(2)
	case r.cur() == '"':
		r.copyByte()
		r.pop()
	case r.hasPrefix("$(("):
		r.copyN(3)
		r.push(&bashFrame{kind: bfArith, closer: "))"})
	case r.hasPrefix("$("):
		r.copyN(2)
		r.push(&bashFrame{kind: bfCode, subst: true})
	case r.hasPrefix("${"):
		return r.scanParamExpansion()
	case r.cur() == '`':
		r.copyByte()
		r.push(&bashFrame{kind: bfCode, backtick: true})
	default:
		r.copyByte()
	}
	return nil
}

func (r *bashRenderer) stepArith(f *bashFrame) error {
	if key, width, ok := r.placeholder(); ok {
		value, known := r.value(key)
		if !known {
			r.skipLiteral(width)
			return nil
		}
		return r.emitInteger(key, value, width, "a bash arithmetic expression")
	}
	if f.closer == "))" {
		switch {
		case r.hasPrefix("))") && f.depth == 0:
			r.copyN(2)
			r.pop()
		case r.cur() == '(':
			f.depth++
			r.copyByte()
		case r.cur() == ')' && f.depth > 0:
			f.depth--
			r.copyByte()
		default:
			r.copyByte()
		}
		return nil
	}
	// closer == "]"
	switch {
	case r.cur() == '[':
		f.depth++
		r.copyByte()
	case r.cur() == ']' && f.depth > 0:
		f.depth--
		r.copyByte()
	case r.cur() == ']':
		r.copyByte()
		r.pop()
	default:
		r.copyByte()
	}
	return nil
}

var bashNumericComparisons = map[string]bool{
	"-eq": true, "-ne": true, "-lt": true, "-le": true, "-gt": true, "-ge": true,
}

func (r *bashRenderer) stepBracket(f *bashFrame) error {
	if key, width, ok := r.placeholder(); ok {
		value, known := r.value(key)
		if !known {
			r.skipLiteral(width)
			return nil
		}
		// An operand of a numeric comparison is an arithmetic context: bash
		// evaluates the operand's contents as an expression.
		if bashNumericComparisons[prevToken(r.src, r.i)] || bashNumericComparisons[nextToken(r.src, r.i+width)] {
			return r.emitInteger(key, value, width, "a numeric comparison inside bash `[[ ]]`")
		}
		return r.emitPlaceholder(key, value, width, formWord)
	}
	switch {
	case r.cur() == '\\':
		r.copyN(2)
	case r.hasPrefix("]]"):
		r.copyN(2)
		r.pop()
	case r.cur() == '\'':
		r.copyByte()
		r.push(&bashFrame{kind: bfSingle})
	case r.cur() == '"':
		r.copyByte()
		r.push(&bashFrame{kind: bfDouble})
	case r.hasPrefix("$(("):
		r.copyN(3)
		r.push(&bashFrame{kind: bfArith, closer: "))"})
	case r.hasPrefix("$("):
		r.copyN(2)
		r.push(&bashFrame{kind: bfCode, subst: true})
	case r.hasPrefix("${"):
		return r.scanParamExpansion()
	default:
		r.copyByte()
	}
	return nil
}

// scanComment copies a `#` comment through, rewriting placeholders into inert
// references so the comment still documents what the line uses.
func (r *bashRenderer) scanComment() error {
	for !r.done() && r.cur() != '\n' {
		if key, width, ok := r.placeholder(); ok {
			if _, known := r.value(key); known {
				r.emit(bashRef(key, formInterp), width)
				continue
			}
			r.skipLiteral(width)
			continue
		}
		r.copyByte()
	}
	return nil
}

// scanParamExpansion copies a `${…}` expansion through. The name is copied
// verbatim; a `:offset` or `[subscript]` makes the remainder an arithmetic
// context, anything else (defaults, pattern replacement) behaves like the
// inside of double quotes.
func (r *bashRenderer) scanParamExpansion() error {
	r.copyN(2) // "${"
	for !r.done() && (r.cur() == '#' || r.cur() == '!') {
		r.copyByte()
	}
	for !r.done() && isIdentByte(r.cur()) {
		r.copyByte()
	}
	arith := false
	if !r.done() {
		switch r.cur() {
		case '[':
			arith = true
		case ':':
			// `:-`, `:=`, `:?`, `:+` are default-value forms, not offsets.
			if r.i+1 >= len(r.src) || !strings.ContainsRune("-=?+", rune(r.src[r.i+1])) {
				arith = true
			}
		}
	}
	depth := 1
	for !r.done() {
		if key, width, ok := r.placeholder(); ok {
			value, known := r.value(key)
			if !known {
				r.skipLiteral(width)
				continue
			}
			if arith {
				if err := r.emitInteger(key, value, width, "a bash `${…}` subscript or offset"); err != nil {
					return err
				}
				continue
			}
			r.emit(bashRef(key, formInterp), width)
			continue
		}
		switch c := r.cur(); c {
		case '\\':
			r.copyN(2)
		case '{':
			depth++
			r.copyByte()
		case '}':
			depth--
			r.copyByte()
			if depth == 0 {
				return nil
			}
		default:
			r.copyByte()
		}
	}
	return nil
}

// ---------------------------------------------------------------- heredocs

func (r *bashRenderer) scanHeredocHeader() error {
	if r.hasPrefix("<<<") {
		r.copyN(3)
		return nil
	}
	r.copyN(2)
	h := bashHeredoc{}
	if !r.done() && r.cur() == '-' {
		h.strip = true
		r.copyByte()
	}
	for !r.done() && (r.cur() == ' ' || r.cur() == '\t') {
		r.copyByte()
	}
	var delim strings.Builder
	if !r.done() && (r.cur() == '\'' || r.cur() == '"') {
		quote := r.cur()
		h.quoted = true
		r.copyByte()
		for !r.done() && r.cur() != quote {
			delim.WriteByte(r.cur())
			r.copyByte()
		}
		if !r.done() {
			r.copyByte()
		}
	} else {
		for !r.done() {
			c := r.cur()
			if isSpaceByte(c) || c == ';' || c == '&' || c == '|' || c == ')' || c == '<' || c == '>' {
				break
			}
			if c == '\\' {
				h.quoted = true
				r.copyByte()
				if !r.done() {
					delim.WriteByte(r.cur())
					r.copyByte()
				}
				continue
			}
			delim.WriteByte(c)
			r.copyByte()
		}
	}
	h.delim = delim.String()
	if h.delim != "" {
		r.pending = append(r.pending, h)
	}
	return nil
}

func (r *bashRenderer) drainHeredocs() error {
	for len(r.pending) > 0 {
		h := r.pending[0]
		r.pending = r.pending[1:]
		if err := r.consumeHeredocBody(h); err != nil {
			return err
		}
	}
	return nil
}

func (r *bashRenderer) consumeHeredocBody(h bashHeredoc) error {
	for !r.done() {
		line := r.src[r.i:]
		if idx := strings.IndexByte(line, '\n'); idx >= 0 {
			line = line[:idx]
		}
		candidate := line
		if h.strip {
			candidate = strings.TrimLeft(candidate, "\t")
		}
		if strings.TrimRight(candidate, "\r") == h.delim {
			r.copyN(len(line))
			if !r.done() {
				r.copyByte() // newline
			}
			return nil
		}
		end := r.i + len(line)
		for r.i < end {
			key, width, ok := r.placeholder()
			if !ok {
				r.copyByte()
				continue
			}
			if _, known := r.value(key); !known {
				r.skipLiteral(width)
				continue
			}
			if h.quoted {
				return renderErr(key, "a quoted heredoc (<<'"+h.delim+"'), where nothing is expanded",
					"drop the quotes on the heredoc delimiter and write $"+parameterEnvName(key)+
						" in the body, or use an unquoted heredoc")
			}
			r.emit(bashRef(key, formInterp), width)
		}
		if !r.done() {
			r.copyByte() // newline
		}
	}
	return nil
}

// ---------------------------------------------------- simple-command state

// bashKeywords are words that precede the actual command word.
var bashKeywords = map[string]bool{
	"if": true, "then": true, "else": true, "elif": true, "fi": true,
	"while": true, "until": true, "do": true, "done": true, "case": true,
	"esac": true, "function": true, "time": true, "!": true, "{": true,
	"[[": true, "coproc": true,
}

func (f *bashFrame) endWord() {
	word := f.curWord.String()
	f.curWord.Reset()
	if word == "" {
		return
	}
	if f.cmdWord == "" {
		if bashKeywords[word] {
			return
		}
		// A leading assignment (`FOO=bar cmd`) is not the command word.
		if eq := strings.IndexByte(word, '='); eq > 0 && isBashName(word[:eq]) {
			return
		}
		f.cmdWord = word
		return
	}
	if (f.cmdWord == "for" || f.cmdWord == "select") && word == "in" {
		f.sawIn = true
	}
	f.args = append(f.args, word)
}

func (f *bashFrame) reset() {
	f.cmdWord = ""
	f.args = nil
	f.sawIn = false
	f.curWord.Reset()
}

func isBashName(s string) bool {
	if s == "" {
		return false
	}
	if s[0] >= '0' && s[0] <= '9' {
		return false
	}
	for i := 0; i < len(s); i++ {
		if !isIdentByte(s[i]) {
			return false
		}
	}
	return true
}
