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
	// bfHeredoc is a heredoc body. It is a frame (rather than an inner loop)
	// so that the constructs an UNQUOTED heredoc still expands — `$(( ))`,
	// `$[ ]`, `${name[…]}`, `$( )` — go through the same rules as anywhere
	// else in the script.
	bfHeredoc
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
	// arrayInit marks a bfCode frame opened by an array-assignment
	// initializer (`name=(` / `name+=(`), where a `[` at the start of a word
	// is a subscript — an arithmetic context — and not a glob.
	arrayInit bool

	// heredoc describes a bfHeredoc frame's body.
	heredoc bashHeredoc

	// wordSink is the bfCode frame whose current word a quoting frame feeds.
	// `de"c"lare` and `\declare` are the `declare` builtin, so the literal
	// bytes of a quoted or escaped span belong to the command word.
	wordSink *bashFrame

	// Simple-command state (bfCode only).
	cmdWord string
	args    []string
	curWord strings.Builder
	sawIn   bool
	// wrapped records that `command` or `builtin` opened the command, so the
	// next non-flag word is the command that actually runs.
	wrapped bool
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
		case bfHeredoc:
			err = r.stepHeredoc(f)
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
		// A backslash quotes the next byte, which is still part of the word:
		// `\declare` and `ev\al` are the `declare` and `eval` builtins.
		if r.i+1 < len(r.src) && r.src[r.i+1] != '\n' {
			f.curWord.WriteByte(r.src[r.i+1])
		}
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
		r.push(&bashFrame{kind: bfSingle, wordSink: f})
		return nil
	case r.hasPrefix("$'"):
		r.copyN(2)
		r.push(&bashFrame{kind: bfAnsi, wordSink: f})
		return nil
	case r.hasPrefix("$\""):
		r.copyN(2)
		r.push(&bashFrame{kind: bfDouble, wordSink: f})
		return nil
	case c == '"':
		r.copyByte()
		r.push(&bashFrame{kind: bfDouble, wordSink: f})
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
	case c == '[' && r.subscriptStartsHere(f):
		// `name[subscript]=` / `name=( [subscript]=v )` — an arithmetic
		// context. A `[` anywhere else in a word is a glob bracket.
		r.copyByte()
		r.push(&bashFrame{kind: bfArith, closer: "]"})
		return nil
	case c == '(' && isArrayInitPrefix(f.curWord.String()):
		f.endWord()
		f.reset()
		r.copyByte()
		r.push(&bashFrame{kind: bfCode, arrayInit: true})
		return nil
	case c == ')':
		f.endWord()
		f.reset()
		r.copyByte()
		if f.subst || f.arrayInit {
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
	f.sink(r.cur())
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
		if r.i+1 < len(r.src) {
			f.sink(r.src[r.i+1])
		}
		r.copyN(2)
	case '\'':
		r.copyByte()
		r.pop()
	default:
		f.sink(r.cur())
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
		if r.i+1 < len(r.src) {
			f.sink(r.src[r.i+1])
		}
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
		f.sink(r.cur())
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
	case r.cur() == '`':
		// `[[ ]]` performs command substitution on its operands, so a backtick
		// opens a code frame here too — with its own command word, so `eval` and
		// an array subscript inside it are caught.
		r.copyByte()
		r.push(&bashFrame{kind: bfCode, backtick: true})
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
