package cli

import (
	"regexp"
	"strings"

	"github.com/charmbracelet/lipgloss"
)

// renderStyles is the subset of styles the markdown renderer needs.
type renderStyles struct {
	Bold    lipgloss.Style
	Code    lipgloss.Style
	Heading lipgloss.Style
	Dim     lipgloss.Style
	Link    lipgloss.Style
}

var (
	reHeading = regexp.MustCompile(`^(#{1,6})\s+(.*)$`)
	reBullet  = regexp.MustCompile(`^(\s*)[-*]\s+(.*)$`)
	reQuote   = regexp.MustCompile(`^>\s?(.*)$`)
	reRule    = regexp.MustCompile(`^\s*(-{3,}|\*{3,}|_{3,})\s*$`)
	reBold    = regexp.MustCompile(`\*\*([^*]+)\*\*`)
	reItalic  = regexp.MustCompile(`(^|[\s(])\*([^*\s][^*]*)\*`)
	reCode    = regexp.MustCompile("`([^`]+)`")
	reLink    = regexp.MustCompile(`\[([^\]]+)\]\(([^)\s]+)\)`)
)

// renderMarkdown turns the assistant's markdown into styled terminal text.
//
// It is deliberately small: headings, lists, blockquotes, rules, fenced code,
// bold/italic/inline code and links. Tables and nested constructs are passed
// through unchanged — a wrong render is worse than a plain one.
func renderMarkdown(text string, st renderStyles) string {
	lines := strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n")
	out := make([]string, 0, len(lines))

	inFence := false
	for _, line := range lines {
		if strings.HasPrefix(strings.TrimSpace(line), "```") {
			inFence = !inFence
			lang := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(line), "```"))
			if inFence {
				if lang == "" {
					lang = "code"
				}
				out = append(out, st.Dim.Render("╭─ "+lang))
			} else {
				out = append(out, st.Dim.Render("╰─"))
			}
			continue
		}

		if inFence {
			out = append(out, "  "+st.Code.Render(line))
			continue
		}

		switch {
		case reRule.MatchString(line):
			out = append(out, st.Dim.Render(strings.Repeat("─", 24)))

		case reHeading.MatchString(line):
			match := reHeading.FindStringSubmatch(line)
			out = append(out, st.Heading.Render(renderInline(match[2], st)))

		case reBullet.MatchString(line):
			match := reBullet.FindStringSubmatch(line)
			out = append(out, match[1]+"• "+renderInline(match[2], st))

		case reQuote.MatchString(line):
			match := reQuote.FindStringSubmatch(line)
			out = append(out, st.Dim.Render("│ ")+st.Dim.Render(renderInline(match[1], st)))

		default:
			out = append(out, renderInline(line, st))
		}
	}
	return strings.Join(out, "\n")
}

// renderInline styles code, links, bold and italic inside one line.
func renderInline(line string, st renderStyles) string {
	if strings.TrimSpace(line) == "" {
		return line
	}

	line = reCode.ReplaceAllStringFunc(line, func(m string) string {
		return st.Code.Render(strings.Trim(m, "`"))
	})

	line = reLink.ReplaceAllStringFunc(line, func(m string) string {
		match := reLink.FindStringSubmatch(m)
		if len(match) != 3 {
			return m
		}
		return match[1] + " " + st.Link.Render("("+match[2]+")")
	})

	line = reBold.ReplaceAllStringFunc(line, func(m string) string {
		return st.Bold.Render(strings.Trim(m, "*"))
	})

	line = reItalic.ReplaceAllStringFunc(line, func(m string) string {
		match := reItalic.FindStringSubmatch(m)
		if len(match) != 3 {
			return m
		}
		return match[1] + st.Bold.Render(match[2])
	})

	return line
}
