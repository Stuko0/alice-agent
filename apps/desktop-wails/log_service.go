package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
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

func (ls *LogService) GetRecentLogs(maxLines int) ([]string, error) {
	logsDir := ls.GetLogsDir()
	logFile := filepath.Join(logsDir, "agent.log")

	data, err := os.ReadFile(logFile)
	if err != nil {
		return nil, err
	}

	lines := strings.Split(string(data), "\n")
	if len(lines) > maxLines {
		lines = lines[len(lines)-maxLines:]
	}

	var result []string
	for _, line := range lines {
		if strings.TrimSpace(line) != "" {
			result = append(result, line+"\n")
		}
	}
	return result, nil
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
