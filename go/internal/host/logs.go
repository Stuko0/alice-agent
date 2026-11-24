package host

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// logNames maps the short name users type to the file under $ALICE_HOME/logs.
var logNames = map[string]string{
	"agent":   "agent.log",
	"errors":  "errors.log",
	"gateway": "gateway.log",
	"tui":     "tui_gateway_crash.log",
	"host":    "host.log",
}

// hostLogs tails an Alice log file. It exists so the host can inspect the
// backend it supervises without requiring a Python process.
func hostLogs(opts Options, args []string) int {
	name := "agent"
	lines := 50
	follow := false

	for i := 0; i < len(args); i++ {
		arg := args[i]
		switch {
		case arg == "-f" || arg == "--follow":
			follow = true

		case arg == "-n" || arg == "--lines":
			if i+1 >= len(args) {
				fmt.Fprintln(opts.Stderr, "alice host logs: -n requires a value")
				return 2
			}
			n, err := strconv.Atoi(args[i+1])
			if err != nil || n < 1 {
				fmt.Fprintf(opts.Stderr, "alice host logs: invalid line count %q\n", args[i+1])
				return 2
			}
			lines = n
			i++

		case strings.HasPrefix(arg, "-n="):
			n, err := strconv.Atoi(strings.TrimPrefix(arg, "-n="))
			if err != nil || n < 1 {
				fmt.Fprintf(opts.Stderr, "alice host logs: invalid line count %q\n", arg)
				return 2
			}
			lines = n

		case strings.HasPrefix(arg, "-"):
			fmt.Fprintf(opts.Stderr, "alice host logs: unknown flag %q\n", arg)
			return 2

		default:
			if name != "agent" {
				fmt.Fprintf(opts.Stderr, "alice host logs: unexpected argument %q\n", arg)
				return 2
			}
			name = arg
		}
	}

	file, ok := logNames[name]
	if !ok {
		names := make([]string, 0, len(logNames))
		for n := range logNames {
			names = append(names, n)
		}
		fmt.Fprintf(opts.Stderr, "alice host logs: unknown log %q (choose one of: %s)\n", name, strings.Join(names, ", "))
		return 2
	}

	home, _ := opts.Resolver.Home()
	path := filepath.Join(home, "logs", file)

	f, err := os.Open(path)
	if err != nil {
		fmt.Fprintf(opts.Stderr, "alice host logs: %v\n", err)
		return 1
	}
	defer f.Close()

	if err := tailFile(f, opts.Stdout, lines); err != nil {
		fmt.Fprintf(opts.Stderr, "alice host logs: %v\n", err)
		return 1
	}
	if follow {
		followFile(f, opts.Stdout)
	}
	return 0
}

// tailFile prints the last n lines without loading the whole file: it reads at
// most the final 256 KiB, which covers any realistic log line count.
func tailFile(f *os.File, w io.Writer, n int) error {
	info, err := f.Stat()
	if err != nil {
		return err
	}
	size := info.Size()
	const chunk = 256 << 10
	start := size - chunk
	if start < 0 {
		start = 0
	}

	buf := make([]byte, size-start)
	if len(buf) > 0 {
		if _, err := f.ReadAt(buf, start); err != nil && err != io.EOF {
			return err
		}
	}

	lines := strings.Split(strings.TrimRight(string(buf), "\n"), "\n")
	if start > 0 && len(lines) > 0 {
		// The first line is a fragment; drop it.
		lines = lines[1:]
	}
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	for _, line := range lines {
		fmt.Fprintln(w, line)
	}
	return nil
}

// followFile streams appended bytes until the process is interrupted.
func followFile(f *os.File, w io.Writer) {
	offset, err := f.Seek(0, io.SeekEnd)
	if err != nil {
		return
	}
	buf := make([]byte, 64<<10)

	for {
		time.Sleep(250 * time.Millisecond)

		info, err := f.Stat()
		if err != nil {
			return
		}
		if info.Size() < offset {
			offset = 0 // truncated (log rotation)
		}
		if info.Size() == offset {
			continue
		}
		if _, err := f.Seek(offset, io.SeekStart); err != nil {
			return
		}
		for {
			n, err := f.Read(buf)
			if n > 0 {
				_, _ = w.Write(buf[:n])
				offset += int64(n)
			}
			if err != nil {
				break
			}
		}
	}
}
