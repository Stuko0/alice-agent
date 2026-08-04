"""Quick-setup provider ordering: OmniRoute (free, no CLI) is the default
recommendation, Copilot remains available but no longer preselected."""
import inspect

from alice_cli import setup as alice_setup


def test_quick_setup_source_omniroute_first_default():
    src = inspect.getsource(alice_setup._run_first_time_quick_setup)

    # OmniRoute must appear in the provider list before Copilot.
    omni_idx = src.index('"omniroute"') if '"omniroute"' in src else src.index("'omniroute'")
    copilot_idx = src.index('"copilot-acp"')
    assert omni_idx < copilot_idx, "omniroute must precede copilot-acp in the providers list"

    # And it must be the default selection (index 0).
    assert "0,  # default: OmniRoute" in src or '0, # default: OmniRoute' in src, (
        "default index must be 0 (OmniRoute) with a comment naming it"
    )
