package executor

import (
	"strings"
)

// Nested-construct dispatch, and the `${…}` expansion frame.
//
// Bash expands the SAME set of constructs in every "word-ish" region: script
// text, a double-quoted string, an unquoted heredoc body, a `[[ … ]]` operand,
// and the word body of a `${name<op>word}` expansion. Each of those had grown
// its own partial copy of the list, and three consecutive review rounds each
// found one region missing an entry — every miss being an Execute-level RCE,
// because the construct re-interprets the value as code (`eval`, command
// substitution) or as an arithmetic expression (which dereferences variable
// CONTENTS). stepNested is the single list they all route through.
//
// FRAME MATRIX — who calls stepNested, and why:
//
//	bfCode       YES  script text, a `$( )` body, a backtick body. It handles
//	                  `\`, quotes, a closing backtick, `[[`, `((` and heredoc
//	                  headers itself first, then delegates the `$…` forms.
//	bfDouble     YES  "…" and $"…": everything but word splitting still happens.
//	bfHeredoc    YES  UNQUOTED delimiter only — an unquoted body expands.
//	bfBracket    YES  `[[ … ]]` performs command substitution on its operands.
//	bfParamWord  YES  the word body / offset / subscript of a `${…}` expansion.
//	bfSingle     no   '…' expands nothing.
//	bfAnsi       no   $'…' expands nothing (ANSI-C escapes only).
//	bfHeredoc    no   QUOTED delimiter (`<<'EOF'`) expands nothing; placeholders
//	                  in it are rejected outright.
//	bfArith      no   already the strictest context, and it owns its own nesting.
//
// Adding a construct bash expands means adding it HERE, once.
func (r *bashRenderer) stepNested(f *bashFrame) (bool, error) {
	switch {
	case r.cur() == '\\':
		// A backslash quotes the next byte. The literal byte still belongs to
		// the enclosing command word where one is being tracked.
		if r.i+1 < len(r.src) {
			f.sink(r.src[r.i+1])
		}
		r.copyN(2)
	case r.hasPrefix("$(("):
		r.copyN(3)
		r.push(&bashFrame{kind: bfArith, closer: "))"})
	case r.hasPrefix("$("):
		r.copyN(2)
		r.push(&bashFrame{kind: bfCode, subst: true})
	case r.hasPrefix("${"):
		r.scanParamExpansion()
	case r.hasPrefix("$["):
		r.copyN(2)
		r.push(&bashFrame{kind: bfArith, closer: "]"})
	case r.cur() == '`':
		r.copyByte()
		r.push(&bashFrame{kind: bfCode, backtick: true})
	default:
		return false, nil
	}
	return true, nil
}

// scanParamExpansion opens a `${…}` expansion: it copies `${`, any `#`/`!`
// prefix operator and the parameter name, then pushes a bfParamWord frame for
// the rest. It is a FRAME rather than an inner loop because bash expands the
// nested constructs above inside the expansion's word — `${u:-$(eval "$v")}`
// runs eval — and because the word honours its own quoting.
func (r *bashRenderer) scanParamExpansion() {
	r.copyN(2) // "${"
	for !r.done() && (r.cur() == '#' || r.cur() == '!') {
		r.copyByte()
	}
	for !r.done() && isIdentByte(r.cur()) {
		r.copyByte()
	}
	r.push(&bashFrame{kind: bfParamWord, depth: 1, interp: r.inInterpolatingContext()})
}

// stepParamWord advances one step inside a `${…}` expansion.
//
// Until an operator is seen the cursor is in the NAME region, where `[` opens
// an array subscript and a `:` that is not part of `:-`, `:=`, `:?` or `:+`
// opens a substring offset/length — both arithmetic contexts, in which bash
// evaluates variable contents as an expression. Everything after an operator is
// the expansion's WORD, which bash expands (and quote-removes) like any other
// word.
func (r *bashRenderer) stepParamWord(f *bashFrame) error {
	if key, width, ok := r.placeholder(); ok {
		value, known := r.value(key)
		if !known {
			r.skipLiteral(width)
			return nil
		}
		if f.arith {
			return r.emitInteger(key, value, width, bashArithContext)
		}
		return r.emitPlaceholder(key, value, width, formInterp)
	}
	if handled, err := r.stepNested(f); handled {
		return err
	}

	switch c := r.cur(); {
	case c == '}':
		f.depth--
		r.copyByte()
		if f.depth == 0 {
			r.pop()
		}
	case c == '{':
		f.depth++
		r.copyByte()
	case !f.wordBody && c == '[':
		// `${name[sub]}` / `${#name[sub]}` — the subscript is arithmetic. The
		// frame stays in the name region so a `:offset` after the `]` is still
		// recognised as one.
		r.copyByte()
		r.push(&bashFrame{kind: bfArith, closer: "]"})
	case !f.wordBody && c == ':':
		if r.i+1 < len(r.src) && strings.ContainsRune("-=?+", rune(r.src[r.i+1])) {
			r.copyN(2) // `:-`, `:=`, `:?`, `:+` — a default-value operator
		} else {
			// `${name:off}` / `${name:off:len}`: arithmetic to the closing `}`.
			f.arith = true
			r.copyByte()
		}
		f.wordBody = true
	case !f.arith && (c == '\'' || c == '"'):
		// Quotes nest fresh in the word: `${u:-"a b"}` and `${u:-'}'}` are
		// both legal, and a `}` inside either does NOT close the expansion.
		f.wordBody = true
		r.copyByte()
		if c == '\'' {
			r.push(&bashFrame{kind: bfSingle, interp: f.interp})
		} else {
			r.push(&bashFrame{kind: bfDouble})
		}
	default:
		// Any other byte here is the `#`, `##`, `%`, `%%`, `/`, `^`, `,` or `@`
		// operator (or word text once one has been seen).
		f.wordBody = true
		r.copyByte()
	}
	return nil
}

// inInterpolatingContext reports whether the cursor sits in a region that
// expands but does NOT perform quote removal — inside double quotes or an
// unquoted heredoc body. It picks the form a single-quoted span inside a
// `${…}` word body gets: in an unquoted expansion bash removes those quotes and
// suppresses expansion between them, so the value has to be spliced in as its
// own double-quoted word; inside double quotes the very same quotes are
// literal data and expansion still happens, so a bare `${NAME}` is correct and
// a splice would emit stray quote characters.
func (r *bashRenderer) inInterpolatingContext() bool {
	for i := len(r.frames) - 1; i >= 0; i-- {
		switch f := r.frames[i]; f.kind {
		case bfDouble:
			return true
		case bfHeredoc:
			return !f.heredoc.quoted
		case bfParamWord:
			// Keep walking: the enclosing expansion decides.
		default:
			return false
		}
	}
	return false
}
