package cli

// Style wraps text in ANSI SGR codes when color is enabled.
type Style struct{ Color bool }

func (s Style) wrap(code, v string) string {
	if !s.Color || v == "" {
		return v
	}
	return "\x1b[" + code + "m" + v + "\x1b[0m"
}

func (s Style) Dim(v string) string     { return s.wrap("2", v) }
func (s Style) Bold(v string) string    { return s.wrap("1", v) }
func (s Style) Red(v string) string     { return s.wrap("31", v) }
func (s Style) Green(v string) string   { return s.wrap("32", v) }
func (s Style) Yellow(v string) string  { return s.wrap("33", v) }
func (s Style) Magenta(v string) string { return s.wrap("35", v) }
func (s Style) Cyan(v string) string    { return s.wrap("36", v) }
