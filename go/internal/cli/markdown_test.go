package cli

import (
	"strings"
	"testing"

	"github.com/charmbracelet/lipgloss"
)

func plainStyles() renderStyles {
	plain := lipgloss.NewStyle()
	return renderStyles{Bold: plain, Code: plain, Heading: plain, Dim: plain, Link: plain}
}

func TestRenderMarkdownHeadingsAndLists(t *testing.T) {
	got := renderMarkdown("# Title\n\n- one\n- two\n\n1. first", plainStyles())

	for _, want := range []string{"Title", "• one", "• two", "1. first"} {
		if !strings.Contains(got, want) {
			t.Fatalf("missing %q in:\n%s", want, got)
		}
	}
}

func TestRenderMarkdownCodeFence(t *testing.T) {
	got := renderMarkdown("antes\n```go\nfmt.Println(\"hi\")\n```\ndespués", plainStyles())

	if !strings.Contains(got, "╭─ go") || !strings.Contains(got, "╰─") {
		t.Fatalf("fence markers missing:\n%s", got)
	}
	if !strings.Contains(got, `  fmt.Println("hi")`) {
		t.Fatalf("code line missing:\n%s", got)
	}
	// Content inside a fence must not be inline-processed.
	if strings.Contains(got, "**") {
		t.Fatalf("unexpected inline pass:\n%s", got)
	}
}

func TestRenderMarkdownInline(t *testing.T) {
	got := renderMarkdown("usa `ls -la` y **cuidado** con [docs](https://x.y)", plainStyles())

	for _, want := range []string{"ls -la", "cuidado", "docs", "(https://x.y)"} {
		if !strings.Contains(got, want) {
			t.Fatalf("missing %q in:\n%s", want, got)
		}
	}
	if strings.Contains(got, "**") || strings.Contains(got, "`") {
		t.Fatalf("markers not consumed:\n%s", got)
	}
}

func TestRenderMarkdownQuoteAndRule(t *testing.T) {
	got := renderMarkdown("> nota\n---", plainStyles())
	if !strings.Contains(got, "│ nota") {
		t.Fatalf("quote missing:\n%s", got)
	}
	if !strings.Contains(got, "────") {
		t.Fatalf("rule missing:\n%s", got)
	}
}

func TestRenderMarkdownPlainPassthrough(t *testing.T) {
	got := renderMarkdown("hola mundo", plainStyles())
	if got != "hola mundo" {
		t.Fatalf("got %q", got)
	}
}
