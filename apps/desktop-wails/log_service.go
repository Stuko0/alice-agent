package main

import (
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

type LogService struct{}

func NewLogService() *LogService {
	return &LogService{}
}

func (ls *LogService) GetLogsDir() string {
	homeDir, _ := os.UserHomeDir()
	aliceHome := os.Getenv("ALICE_HOME")
	if aliceHome == "" {
		aliceHome = filepath.Join(homeDir, ".alice")
	}
	return filepath.Join(aliceHome, "logs")
}

// bootLogName is the shell's own log. The Python backend owns agent.log, so a
// boot that fails before Python ever starts leaves nothing behind for the
// failure overlay to show — exactly the "No usable Python runtime" case, where
// the only useful evidence (which paths were probed) never reached disk.
const bootLogName = "desktop-boot.log"

const maxBootLogBytes = 256 * 1024

// bootLogPath resolves the shell log for the active profile.
func bootLogPath() string {
	return filepath.Join((&LogService{}).GetLogsDir(), bootLogName)
}

// logBoot appends one timestamped line to the shell's boot log. Best-effort:
// logging must never be the reason a boot fails.
func logBoot(format string, args ...any) {
	line := fmt.Sprintf(format, args...)
	log.Printf("[boot] %s", line)

	dir := (&LogService{}).GetLogsDir()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return
	}

	path := filepath.Join(dir, bootLogName)

	// Keep the file from growing without bound across months of launches.
	if info, err := os.Stat(path); err == nil && info.Size() > maxBootLogBytes {
		_ = os.Remove(path)
	}

	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return
	}
	defer f.Close()

	if _, err := fmt.Fprintf(f, "%s %s\n", time.Now().Format(time.RFC3339), line); err != nil {
		return
	}
}

// readLogTail returns the last maxLines non-empty lines of a file. A missing
// file is not an error worth surfacing: callers merge several logs.
func readLogTail(path string, maxLines int) ([]string, error) {
	if maxLines <= 0 {
		maxLines = 1
	}

	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}

	lines := strings.Split(string(data), "\n")

	nonEmpty := make([]string, 0, len(lines))
	for _, line := range lines {
		if strings.TrimSpace(line) != "" {
			nonEmpty = append(nonEmpty, line)
		}
	}

	if len(nonEmpty) > maxLines {
		nonEmpty = nonEmpty[len(nonEmpty)-maxLines:]
	}

	out := make([]string, 0, len(nonEmpty))
	for _, line := range nonEmpty {
		out = append(out, line+"\n")
	}

	return out, nil
}

// GetRecentLogs returns the tail of agent.log followed by the shell's own boot
// log. The boot lines come last because the failure overlay renders the tail of
// this list, and the shell's record of what it probed is the newest evidence —
// when the backend never started, agent.log does not even exist.
func (ls *LogService) GetRecentLogs(maxLines int) ([]string, error) {
	if maxLines <= 0 {
		maxLines = 200
	}

	agentPath := filepath.Join(ls.GetLogsDir(), "agent.log")

	boot, bootErr := readLogTail(bootLogPath(), maxLines)
	if bootErr != nil {
		// No shell log (older install, or the boot never got this far):
		// preserve the historical behavior exactly, error included.
		return readLogTail(agentPath, maxLines)
	}

	bootBudget := maxLines / 2
	if bootBudget < 1 {
		bootBudget = 1
	}

	if len(boot) > bootBudget {
		boot = boot[len(boot)-bootBudget:]
	}

	agentBudget := maxLines - len(boot)
	if agentBudget < 1 {
		agentBudget = 1
	}

	agent, _ := readLogTail(agentPath, agentBudget)

	lines := make([]string, 0, len(agent)+len(boot))
	lines = append(lines, agent...)
	lines = append(lines, boot...)

	return lines, nil
}

func (ls *LogService) RevealLogs() error {
	logsDir := ls.GetLogsDir()

	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", logsDir)
	case "windows":
		cmd = exec.Command("explorer", logsDir)
	default:
		cmd = exec.Command("xdg-open", logsDir)
	}

	return cmd.Start()
}
