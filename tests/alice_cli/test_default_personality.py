"""Shipped-default persona contract (Alice Liddell).

A brand-new install gets its persona from exactly two places, and both have
to stay wired:

- **Identity (SOUL.md)** — `ensure_alice_home()` seeds ``DEFAULT_SOUL_MD``
  into a fresh ``ALICE_HOME``. Identity is the mechanism that reaches every
  surface (CLI, TUI/desktop, gateway, cron), because SOUL.md is always
  loaded as the agent's identity slot.
- **Preset** — `alice-liddell` ships in the built-in ``agent.personalities``
  map, so ``/personality alice-liddell`` exists, pickers can name it, and
  the overlay text matches the identity the user already has.

The overlay keys stay EMPTY by default (``agent.system_prompt``,
``display.personality``): the shipped persona is identity, not an overlay.
That keeps `/personality none` meaning "no overlay" instead of "no persona",
and avoids injecting the same text twice into the prompt.

Also guards the presets removed on request (kawaii, catgirl, pirate,
shakespeare, surfer, noir, hype): they must not ship anymore.
"""

import pathlib

from alice_cli.config import ensure_alice_home, load_config
from alice_cli.default_soul import (
    ALICE_LIDDELL_PERSONA,
    DEFAULT_SOUL_MD,
)

REMOVED_PRESETS = {
    "kawaii",
    "catgirl",
    "pirate",
    "shakespeare",
    "surfer",
    "noir",
    "hype",
}
DEFAULT_PERSONALITY = "alice-liddell"


def _shipped_personalities(monkeypatch) -> dict:
    """Built-in presets as a fresh install sees them (user config skipped)."""
    monkeypatch.setenv("ALICE_IGNORE_USER_CONFIG", "1")
    from cli import load_cli_config

    return dict(load_cli_config().get("agent", {}).get("personalities", {}) or {})


def _render(value) -> str:
    if isinstance(value, dict):
        parts = [value.get("system_prompt", "")]
        if value.get("tone"):
            parts.append(f'Tone: {value["tone"]}')
        if value.get("style"):
            parts.append(f'Style: {value["style"]}')
        return "\n".join(p for p in parts if p)
    return str(value)


class TestShippedPersonaPreset:
    def test_default_persona_is_a_registered_preset(self, monkeypatch):
        personalities = _shipped_personalities(monkeypatch)
        assert DEFAULT_PERSONALITY in personalities, (
            "the shipped default persona must also be selectable with "
            f"/personality {DEFAULT_PERSONALITY}"
        )

    def test_default_persona_preset_is_described_and_renderable(
        self, monkeypatch
    ):
        from cli import AliceCLI

        entry = _shipped_personalities(monkeypatch)[DEFAULT_PERSONALITY]
        assert isinstance(entry, dict), (
            "the default preset uses the dict schema so pickers can show a "
            "one-line description"
        )
        assert entry.get("description", "").strip()
        rendered = AliceCLI._resolve_personality_prompt(entry)
        assert rendered.strip() == _render(entry).strip()
        assert rendered.strip(), "an empty preset would render no overlay"

    def test_removed_presets_do_not_ship(self, monkeypatch):
        shipped = set(_shipped_personalities(monkeypatch))
        leftovers = REMOVED_PRESETS & shipped
        assert not leftovers, (
            f"removed presets still ship in cli.py defaults: {sorted(leftovers)}"
        )

    def test_persona_preset_stays_in_sync_with_seeded_identity(self):
        """Preset and identity carry the same persona text — one edit source,
        no drift between what /personality applies and what SOUL.md ships."""
        assert ALICE_LIDDELL_PERSONA.strip() in DEFAULT_SOUL_MD


class TestSeededIdentity:
    def test_fresh_home_seeds_identity_with_the_persona(self, tmp_path, monkeypatch):
        monkeypatch.setenv("ALICE_HOME", str(tmp_path))
        ensure_alice_home()
        soul = (tmp_path / "SOUL.md").read_text(encoding="utf-8")
        assert soul == DEFAULT_SOUL_MD
        assert ALICE_LIDDELL_PERSONA.strip() in soul
        assert "Alice Liddell" in soul

    def test_existing_user_identity_is_never_replaced(self, tmp_path, monkeypatch):
        """Installs that already carry an identity keep it — the new persona
        only lands where no persona was chosen yet."""
        monkeypatch.setenv("ALICE_HOME", str(tmp_path))
        previous = "You are Alice Agent, an intelligent AI assistant created by Stuko."
        (tmp_path / "SOUL.md").write_text(previous, encoding="utf-8")
        ensure_alice_home()
        assert (tmp_path / "SOUL.md").read_text(encoding="utf-8") == previous


class TestNoOverlayByDefault:
    def test_persona_ships_as_identity_not_as_overlay(self, tmp_path, monkeypatch):
        """agent.system_prompt / display.personality stay empty on a fresh
        install: identity already carries the persona, and a default overlay
        would double-inject it and break `/personality none` semantics."""
        monkeypatch.setenv("ALICE_HOME", str(tmp_path))
        cfg = load_config()
        assert (cfg.get("agent", {}).get("system_prompt") or "") == ""
        assert (cfg.get("display", {}).get("personality") or "") in ("", "none")

    def test_shipped_presets_reach_load_config(self, tmp_path, monkeypatch):
        """load_config() (the merged loader behind `alice config show`, the
        TUI fallback and the gateway /personality fallback) must expose the
        shipped presets, not just the CLI's own defaults."""
        monkeypatch.setenv("ALICE_HOME", str(tmp_path))
        cfg = load_config()
        presets = cfg.get("agent", {}).get("personalities") or {}
        assert DEFAULT_PERSONALITY in presets
        assert presets == _shipped_personalities(monkeypatch)


class TestSeedersCarryTheSameIdentity:
    """install.sh, install.ps1 and docker/SOUL.md write SOUL.md themselves and
    their comments say they MUST match DEFAULT_SOUL_MD. If they drift, a fresh
    install gets a persona-less identity that no runtime upgrade can fix (the
    legacy-template upgrade only fires for the old comment scaffolds)."""

    REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]

    def _extract(self, text: str, start_marker: str, end_marker: str) -> str:
        start = text.index(start_marker) + len(start_marker)
        end = text.index(end_marker, start)
        return text[start:end]

    def test_docker_soul_matches_default(self):
        soul = (self.REPO_ROOT / "docker" / "SOUL.md").read_text(encoding="utf-8")
        assert soul.strip() == DEFAULT_SOUL_MD.strip()

    def test_install_sh_heredoc_matches_default(self):
        text = (self.REPO_ROOT / "scripts" / "install.sh").read_text(encoding="utf-8")
        seeded = self._extract(text, "<< 'SOUL_EOF'\n", "\nSOUL_EOF")
        assert seeded.strip() == DEFAULT_SOUL_MD.strip()

    def test_install_ps1_here_string_matches_default(self):
        text = (self.REPO_ROOT / "scripts" / "install.ps1").read_text(encoding="utf-8")
        seeded = self._extract(text, '$soulContent = @"\n', '\n"@')
        assert seeded.strip() == DEFAULT_SOUL_MD.strip()
