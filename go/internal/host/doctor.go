package host

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"time"

	"github.com/Stuko0/alice-agent/go/internal/rpcclient"
)

type doctorStatus string

const (
	statusOK   doctorStatus = "ok"
	statusWarn doctorStatus = "warn"
	statusFail doctorStatus = "fail"
)

type doctorCheck struct {
	Name   string       `json:"name"`
	Status doctorStatus `json:"status"`
	Detail string       `json:"detail"`
}

type doctorEnv struct {
	resolver  Resolver
	runImport func(ctx context.Context, python string) ([]byte, error)
	deep      bool
}

// hostDoctor checks the plumbing the Go host owns: home, interpreter, config,
// state and (with --deep) a real gateway handshake. It is deliberately
// shallow — `alice doctor` remains the exhaustive Python diagnostic.
func hostDoctor(opts Options, args []string) int {
	asJSON := false
	deep := false
	for _, a := range args {
		switch a {
		case "--json":
			asJSON = true
		case "--deep":
			deep = true
		default:
			fmt.Fprintf(opts.Stderr, "alice host doctor: unknown flag %q\n", a)
			return 2
		}
	}

	env := doctorEnv{resolver: opts.Resolver, deep: deep, runImport: runPythonImport}
	return env.report(opts.Stdout, opts.Stderr, asJSON)
}

func (e doctorEnv) report(stdout, stderr io.Writer, asJSON bool) int {
	checks := e.checks(context.Background())

	if asJSON {
		report := struct {
			OK     int           `json:"ok"`
			Warn   int           `json:"warn"`
			Fail   int           `json:"fail"`
			Checks []doctorCheck `json:"checks"`
		}{Checks: checks}
		for _, c := range checks {
			switch c.Status {
			case statusOK:
				report.OK++
			case statusWarn:
				report.Warn++
			case statusFail:
				report.Fail++
			}
		}
		enc := json.NewEncoder(stdout)
		enc.SetIndent("", "  ")
		if err := enc.Encode(report); err != nil {
			fmt.Fprintf(stderr, "alice host doctor: %v\n", err)
			return 1
		}
		if report.Fail > 0 {
			return 1
		}
		return 0
	}

	ok, warn, fail := 0, 0, 0
	fmt.Fprintln(stdout, "alice host doctor")
	fmt.Fprintln(stdout)
	for _, c := range checks {
		switch c.Status {
		case statusOK:
			ok++
		case statusWarn:
			warn++
		case statusFail:
			fail++
		}
		fmt.Fprintf(stdout, "  [%-4s] %-14s %s\n", c.Status, c.Name, c.Detail)
	}
	fmt.Fprintln(stdout)
	fmt.Fprintf(stdout, "%d ok · %d warn · %d fail\n", ok, warn, fail)

	if fail > 0 {
		return 1
	}
	return 0
}

func (e doctorEnv) checks(ctx context.Context) []doctorCheck {
	home, source := e.resolver.Home()

	checks := []doctorCheck{
		e.checkHome(home, source),
		e.checkPython(ctx),
	}
	checks = append(checks, e.checkFile("config", filepath.Join(home, "config.yaml"), "missing (run alice setup)"))
	checks = append(checks, e.checkFile("state.db", filepath.Join(home, "state.db"), "no sessions yet"))
	if e.deep {
		checks = append(checks, e.checkGateway(ctx))
	}
	return checks
}

func (e doctorEnv) checkHome(home, source string) doctorCheck {
	check := doctorCheck{Name: "alice_home"}
	info, err := os.Stat(home)
	if err != nil || !info.IsDir() {
		check.Status = statusFail
		check.Detail = fmt.Sprintf("%s (%s): not a directory", home, source)
		return check
	}

	f, err := os.CreateTemp(home, ".doctor-*")
	if err != nil {
		check.Status = statusFail
		check.Detail = fmt.Sprintf("%s (%s): not writable: %v", home, source, err)
		return check
	}
	name := f.Name()
	_ = f.Close()
	_ = os.Remove(name)

	check.Status = statusOK
	check.Detail = fmt.Sprintf("%s (%s)", home, source)
	return check
}

func (e doctorEnv) checkPython(ctx context.Context) doctorCheck {
	check := doctorCheck{Name: "python"}

	rt, err := e.resolver.Python()
	if err != nil {
		check.Status = statusFail
		check.Detail = err.Error()
		return check
	}

	if rt.Source == "checkout" {
		root := e.resolver.CheckoutRoot(rt)
		if _, err := os.Stat(filepath.Join(root, "alice_cli", "main.py")); err != nil {
			check.Status = statusFail
			check.Detail = fmt.Sprintf("%s (%s): checkout root %s has no alice_cli/main.py", rt.Python, rt.Source, root)
			return check
		}
	}

	importCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	out, err := e.runImport(importCtx, rt.Python)
	if err != nil {
		check.Status = statusFail
		check.Detail = fmt.Sprintf("%s (%s): cannot import alice_cli.main: %v %s", rt.Python, rt.Source, err, tailString(string(out), 300))
		return check
	}

	check.Status = statusOK
	check.Detail = fmt.Sprintf("%s (%s)", rt.Python, rt.Source)
	return check
}

func (e doctorEnv) checkFile(name, path, missingDetail string) doctorCheck {
	check := doctorCheck{Name: name}
	info, err := os.Stat(path)
	if err != nil || info.IsDir() {
		check.Status = statusWarn
		check.Detail = fmt.Sprintf("%s: %s", path, missingDetail)
		return check
	}
	check.Status = statusOK
	check.Detail = fmt.Sprintf("%s (%s)", path, humanBytes(info.Size()))
	return check
}

func (e doctorEnv) checkGateway(ctx context.Context) doctorCheck {
	check := doctorCheck{Name: "gateway"}

	rt, err := e.resolver.Python()
	if err != nil {
		check.Status = statusFail
		check.Detail = err.Error()
		return check
	}

	startCtx, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()

	var stderr bytes.Buffer
	client, err := rpcclient.Start(startCtx, rpcclient.Options{
		Python: rt.Python,
		Dir:    e.resolver.CheckoutRoot(rt),
		Stderr: &stderr,
	})
	if err != nil {
		check.Status = statusFail
		check.Detail = fmt.Sprintf("handshake failed: %v %s", err, tailString(stderr.String(), 300))
		return check
	}
	defer client.Close()

	check.Status = statusOK
	check.Detail = "gateway.ready"
	return check
}

func runPythonImport(ctx context.Context, python string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, python, "-c", "import alice_cli.main")
	return cmd.CombinedOutput()
}

func humanBytes(n int64) string {
	const unit = 1024
	if n < unit {
		return fmt.Sprintf("%d B", n)
	}
	div, exp := int64(unit), 0
	for m := n / unit; m >= unit; m /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %cB", float64(n)/float64(div), "KMGTPE"[exp])
}

func tailString(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return "..." + s[len(s)-max:]
}
