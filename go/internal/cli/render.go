package cli

import (
	"fmt"
	"strings"
)

// RenderHistory renders a stored transcript for a line interface. Only the
// last limit messages are shown; limit <= 0 means "all".
func RenderHistory(messages []Message, limit int) string {
	if limit > 0 && len(messages) > limit {
		messages = messages[len(messages)-limit:]
	}
	var b strings.Builder
	for _, msg := range messages {
		content := strings.TrimSpace(msg.Content)
		if content == "" {
			continue
		}
		switch msg.Role {
		case "assistant":
			b.WriteString("alice> " + content + "\n")
		case "user":
			b.WriteString("you> " + content + "\n")
		default:
			continue
		}
	}
	return b.String()
}

// clip shortens a single-line preview.
func clip(s string, max int) string {
	s = strings.TrimSpace(strings.ReplaceAll(s, "\n", " "))
	if len(s) <= max {
		return s
	}
	return s[:max-3] + "..."
}

func formatDuration(seconds float64) string {
	if seconds <= 0 {
		return ""
	}
	if seconds < 1 {
		return fmt.Sprintf("%.0fms", seconds*1000)
	}
	return fmt.Sprintf("%.1fs", seconds)
}
