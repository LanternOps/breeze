package executor

import (
	"strings"
)

// Bash simple-command state.
//
// A handful of builtins re-interpret their arguments (`eval` as code, `let` and
// `declare -i` as arithmetic, `read` as a variable name), so the renderer has
// to know which command the placeholder is an argument of. The tracker below
// accumulates the UNQUOTED EQUIVALENT of each word — quoting and backslashes
// are stripped — because `de"c"lare -i`, `\declare -i`, `"let"` and `ev\al`
// are those same builtins, and it unwraps the `command` / `builtin` prefixes,
// which run the builtin anyway.

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
		// `command eval …` / `builtin eval …` run eval all the same.
		if word == "command" || word == "builtin" {
			f.wrapped = true
			return
		}
		if f.wrapped && strings.HasPrefix(word, "-") {
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
	f.wrapped = false
	f.curWord.Reset()
}

// sink records one literal byte of a quoted span in the command word of the
// frame that opened it, so the word tracker sees `de"c"lare` as `declare`.
func (f *bashFrame) sink(c byte) {
	if f.wordSink != nil {
		f.wordSink.curWord.WriteByte(c)
	}
}

// isArrayInitPrefix reports whether the word before a `(` opens an array
// assignment initializer: `name=(` or `name+=(`.
func isArrayInitPrefix(word string) bool {
	if !strings.HasSuffix(word, "=") {
		return false
	}
	name := strings.TrimSuffix(strings.TrimSuffix(word, "="), "+")
	return isBashName(name)
}

// subscriptStartsHere reports whether the `[` at the cursor opens an array
// SUBSCRIPT — an arithmetic context — rather than a glob bracket. Only an
// assignment target (`name[…]=` or `name[…]+=`) and an element of an array
// initializer qualify; `${name[…]}` is handled by scanParamExpansion.
func (r *bashRenderer) subscriptStartsHere(f *bashFrame) bool {
	if f.arrayInit && f.curWord.Len() == 0 {
		return true
	}
	if !isBashName(f.curWord.String()) {
		return false
	}
	return bashSubscriptIsAssignment(r.src, r.i)
}

// bashSubscriptIsAssignment reports whether the bracket group starting at the
// `[` in src[pos] is immediately followed by `=` or `+=`.
func bashSubscriptIsAssignment(src string, pos int) bool {
	depth := 0
	for i := pos; i < len(src); i++ {
		switch src[i] {
		case '\\':
			i++
		case '[':
			depth++
		case ']':
			depth--
			if depth > 0 {
				continue
			}
			j := i + 1
			if j < len(src) && src[j] == '+' {
				j++
			}
			return j < len(src) && src[j] == '='
		case '\n':
			return false
		}
	}
	return false
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
