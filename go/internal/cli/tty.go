package cli

import (
	"io"
	"os"

	"github.com/mattn/go-isatty"
)

func isTTY(w io.Writer) bool {
	f, ok := w.(*os.File)
	if !ok {
		return false
	}
	return isatty.IsTerminal(f.Fd()) || isatty.IsCygwinTerminal(f.Fd())
}

func colorEnabled(w io.Writer) bool {
	if os.Getenv("NO_COLOR") != "" {
		return false
	}
	if os.Getenv("TERM") == "dumb" {
		return false
	}
	return isTTY(w)
}

func wantsTUI(w io.Writer, plain bool) bool {
	return !plain && isTTY(w)
}
