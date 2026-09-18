package executor

import (
	"strings"
)

// Bash heredoc bodies.
//
// A heredoc body is a scanner FRAME rather than an inner loop, because an
// UNQUOTED heredoc still performs the expansions that make a parameter value
// dangerous: `$(( ))` and `$[ ]` evaluate variable CONTENTS as an arithmetic
// expression, `${name[…]}` and `${name:off}` do the same for a subscript or
// offset, and `$( )` is a command-substitution code context. Emitting the
// plain `${NAME}` interpolation for every placeholder in the body — which is
// what an unconditional scan did — handed those constructs the value.
//
// A QUOTED heredoc (`<<'EOF'`) expands nothing at all, so a reference cannot
// carry the value and every placeholder in it is rejected.

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

// drainHeredocs pushes the heredocs whose headers appeared on the line just
// ended. They are pushed in reverse order so the FIRST header's body is the
// frame on top: `cat <<A <<B` reads A's body first.
func (r *bashRenderer) drainHeredocs() error {
	for i := len(r.pending) - 1; i >= 0; i-- {
		r.push(&bashFrame{kind: bfHeredoc, heredoc: r.pending[i]})
	}
	r.pending = nil
	return nil
}

// stepHeredoc advances one step inside a heredoc body.
func (r *bashRenderer) stepHeredoc(f *bashFrame) error {
	h := f.heredoc
	if r.i == 0 || r.src[r.i-1] == '\n' {
		line := currentLine(r.src, r.i)
		candidate := line
		if h.strip {
			candidate = strings.TrimLeft(candidate, "\t")
		}
		if strings.TrimRight(candidate, "\r") == h.delim {
			r.copyN(len(line))
			if !r.done() {
				r.copyByte() // newline
			}
			r.pop()
			return nil
		}
	}

	if key, width, ok := r.placeholder(); ok {
		if _, known := r.value(key); !known {
			r.skipLiteral(width)
			return nil
		}
		if h.quoted {
			return renderErr(key, "a quoted heredoc (<<'"+h.delim+"'), where nothing is expanded",
				"drop the quotes on the heredoc delimiter and write $"+parameterEnvName(key)+
					" in the body, or use an unquoted heredoc")
		}
		r.emit(bashRef(key, formInterp), width)
		return nil
	}

	if h.quoted {
		// Nothing in a quoted body expands, so nothing needs scanning.
		r.copyByte()
		return nil
	}

	switch {
	case r.cur() == '\\':
		r.copyN(2)
	case r.hasPrefix("$(("):
		r.copyN(3)
		r.push(&bashFrame{kind: bfArith, closer: "))"})
	case r.hasPrefix("$("):
		r.copyN(2)
		r.push(&bashFrame{kind: bfCode, subst: true})
	case r.hasPrefix("${"):
		return r.scanParamExpansion()
	case r.hasPrefix("$["):
		r.copyN(2)
		r.push(&bashFrame{kind: bfArith, closer: "]"})
	default:
		r.copyByte()
	}
	return nil
}

// currentLine returns the text from pos to the next newline (exclusive).
func currentLine(src string, pos int) string {
	line := src[pos:]
	if idx := strings.IndexByte(line, '\n'); idx >= 0 {
		line = line[:idx]
	}
	return line
}
