package cli

import "github.com/charmbracelet/lipgloss"

// palette is the TUI's skin-derived style set.
type palette struct {
	user      lipgloss.Style
	assistant lipgloss.Style
	dim       lipgloss.Style
	err       lipgloss.Style
	prompt    lipgloss.Style
	render    renderStyles
}

// paletteFor maps a backend skin name to a terminal palette. The Go TUI does
// not replicate the Python skin engine's full key set; it keeps the four
// built-in moods and falls back to `default`.
func paletteFor(skin string) palette {
	switch skin {
	case "ares":
		return makePalette("209", "196", "8", "196", "208", "208", "130", "196")
	case "mono":
		return makePalette("7", "15", "8", "9", "7", "15", "8", "8")
	case "slate":
		return makePalette("6", "4", "8", "1", "12", "12", "8", "6")
	default:
		return makePalette("6", "2", "8", "1", "3", "214", "223", "4")
	}
}

func makePalette(user, assistant, dim, errColor, prompt, heading, code, link string) palette {
	return palette{
		user:      lipgloss.NewStyle().Foreground(lipgloss.Color(user)).Bold(true),
		assistant: lipgloss.NewStyle().Foreground(lipgloss.Color(assistant)).Bold(true),
		dim:       lipgloss.NewStyle().Foreground(lipgloss.Color(dim)),
		err:       lipgloss.NewStyle().Foreground(lipgloss.Color(errColor)),
		prompt:    lipgloss.NewStyle().Foreground(lipgloss.Color(prompt)).Bold(true),
		render: renderStyles{
			Bold:    lipgloss.NewStyle().Bold(true),
			Code:    lipgloss.NewStyle().Foreground(lipgloss.Color(code)),
			Heading: lipgloss.NewStyle().Foreground(lipgloss.Color(heading)).Bold(true),
			Dim:     lipgloss.NewStyle().Foreground(lipgloss.Color(dim)),
			Link:    lipgloss.NewStyle().Foreground(lipgloss.Color(link)).Underline(true),
		},
	}
}
