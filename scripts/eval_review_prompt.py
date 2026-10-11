#!/usr/bin/env python3
"""Score the background-review prompt against frozen sessions.

Fase 4 of `.hermes/plans/2026-09-22_174556-autoaprendizaje-verificado-core.md`.

WHY THIS EXISTS
---------------
`agent/background_review.py` holds the self-improvement prompt. Until now the
only regression signal on it was a pile of tests asserting that certain
SENTENCES are present — which cannot tell you whether the prompt got better or
worse. This harness gives it a number instead: each fixture is a frozen
transcript plus the review decisions it SHOULD produce (which skills get
touched, which effectiveness outcomes get recorded, when nothing should happen
at all).

TWO MODES
---------
``--offline`` (default) — validates the fixtures themselves (schema, seeded
  skills exist, expectations reference seeded skills) and prints the inventory.
  No model, no network, no credentials. This is the guard that keeps the
  harness well-formed; it is NOT a measure of prompt quality, and it must never
  be reported as one.

``--live`` — for each fixture: seeds its skills into a temp ``ALICE_HOME``,
  sends the real review prompt + transcript to the auxiliary model with the
  real ``skill_manage`` tool schema, APPLIES the returned tool calls through
  the real tool, then scores the resulting library state against the fixture's
  expectations. Prints per-check results and an aggregate score.

LIMITATIONS (read before quoting a number)
-----------------------------------------
- The live run executes up to ``--rounds`` model turns. The real fork loops
  until it stops calling tools; a large round count costs more.
- The fork's read tools (``skills_list``, ``skill_view``) AND ``skill_manage``
  are offered, so a prompt that says "list the skills first" can be followed.
  The ``memory`` tool is not offered, so a fixture cannot score memory writes.
- Applying calls runs in the FOREGROUND, so the review fork's own write guards
  (pin / bundled / read-before-write) are not exercised. This measures the
  model's decisions, not the guards — those have their own tests.
- Live scoring is one sample per fixture. Run it a few times before treating a
  delta as real.

USAGE
-----
    python scripts/eval_review_prompt.py                    # offline validation
    python scripts/eval_review_prompt.py --live              # score against the model
    python scripts/eval_review_prompt.py --live --only skill-step-failed
    python scripts/eval_review_prompt.py --live --rounds 3 --timeout 180
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import tempfile
from pathlib import Path
from typing import Any, Dict, List, Optional

REPO_ROOT = Path(__file__).resolve().parent.parent
FIXTURE_DIR = REPO_ROOT / "tests" / "fixtures" / "self_improvement"

_PROMPTS = {
    "skill_review": "agent.background_review._SKILL_REVIEW_PROMPT",
    "combined": "agent.background_review._COMBINED_REVIEW_PROMPT",
}

_SKILL_MANAGE_KWARGS = {
    "action", "name", "content", "category", "file_path", "file_content",
    "old_string", "new_string", "replace_all", "absorbed_into",
    "outcome", "outcome_note",
}


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

def load_fixtures(only: Optional[str] = None) -> List[Dict[str, Any]]:
    fixtures = []
    for path in sorted(FIXTURE_DIR.glob("*.json")):
        data = json.loads(path.read_text(encoding="utf-8"))
        data["_path"] = str(path)
        if only and data.get("name") != only:
            continue
        fixtures.append(data)
    return fixtures


def validate_fixture(fx: Dict[str, Any]) -> List[str]:
    """Return a list of structural problems; empty means well-formed."""
    errors: List[str] = []
    if not fx.get("name"):
        errors.append("missing 'name'")
    variant = fx.get("prompt", "skill_review")
    if variant not in _PROMPTS:
        errors.append(f"unknown prompt variant {variant!r} (expected one of {sorted(_PROMPTS)})")

    transcript = fx.get("transcript") or []
    if not transcript:
        errors.append("transcript is empty")
    for i, msg in enumerate(transcript):
        if not isinstance(msg, dict) or msg.get("role") not in {"user", "assistant"}:
            errors.append(f"transcript[{i}] must be a user/assistant message")
        elif not (msg.get("content") or "").strip():
            errors.append(f"transcript[{i}] has empty content")

    skills = fx.get("skills") or {}
    if not isinstance(skills, dict):
        errors.append("'skills' must be an object of name -> SKILL.md body")
    for name, body in skills.items():
        if f"name: {name}" not in str(body):
            errors.append(f"seeded skill {name!r} must contain 'name: {name}' frontmatter")

    expect = fx.get("expect") or {}
    if not expect:
        errors.append("'expect' is empty — a fixture with no expectation scores nothing")
    for key in ("must_write", "must_not_write"):
        for name in expect.get(key) or []:
            if name not in skills:
                errors.append(f"expect.{key} references {name!r}, which is not seeded under 'skills'")
    for name, outcome in (expect.get("outcomes") or {}).items():
        if name not in skills:
            errors.append(f"expect.outcomes references {name!r}, which is not seeded under 'skills'")
        if outcome not in {"helped", "hurt", "neutral"}:
            errors.append(f"expect.outcomes[{name}] must be helped/hurt/neutral, got {outcome!r}")
    return errors


# ---------------------------------------------------------------------------
# Seeding / applying
# ---------------------------------------------------------------------------

# Only config + credentials are mirrored from the real profile. Skills,
# sessions, memory and telemetry are deliberately NOT copied: the fixture's
# skills must be the whole library the model sees.
_CONFIG_FILES = ("config.yaml", ".env", "auth.json")


def prepare_home() -> Path:
    """Build the one temp ALICE_HOME used by the whole live run.

    A SINGLE home is reused for every fixture on purpose. Skill tooling
    captures skill paths at IMPORT time, so a per-fixture home silently leaked
    the real profile's library into every fixture after the first — measured
    directly: the model was offered the user's real skills and recorded
    outcomes against them instead of against the fixture's. Redirecting
    ALICE_HOME per fixture cannot fix that, because the paths are already
    bound by then; the redirect has to be in place before the tool modules are
    imported, and it has to stay stable for the whole process.

    Copying ``config.yaml`` / ``.env`` / ``auth.json`` keeps provider and
    credential resolution working under the temp home, so the model call runs
    with the same runtime the real review fork would use.
    """
    real_home = Path(os.environ.get("ALICE_HOME") or (Path.home() / ".alice"))
    home = Path(tempfile.mkdtemp(prefix="eval-review-"))
    for name in _CONFIG_FILES:
        src = real_home / name
        if src.exists():
            shutil.copy2(src, home / name)
    (home / "skills").mkdir(parents=True, exist_ok=True)
    return home


def seed_fixture_skills(home: Path, fx: Dict[str, Any]) -> None:
    """Replace the library under *home* with exactly this fixture's skills."""
    skills_dir = home / "skills"
    skills_dir.mkdir(parents=True, exist_ok=True)
    for child in skills_dir.iterdir():
        if child.name.startswith("."):
            continue
        shutil.rmtree(child, ignore_errors=True)
    for name, body in (fx.get("skills") or {}).items():
        d = skills_dir / name
        d.mkdir(parents=True, exist_ok=True)
        (d / "SKILL.md").write_text(str(body).rstrip("\n") + "\n", encoding="utf-8")


def _prompt_text(variant: str) -> str:
    import importlib

    module_name, attr = _PROMPTS[variant].rsplit(".", 1)
    return getattr(importlib.import_module(module_name), attr)


def _tools() -> List[Dict[str, Any]]:
    """The fork's real toolset for this eval: two read tools + skill_manage.

    Offering only ``skill_manage`` used to make the run score the prompt on
    instructions the model could not follow ("list the skills first" with no
    listing tool), which penalised a correct prompt for a harness limitation.
    """
    from tools.skill_manager_tool import SKILL_MANAGE_SCHEMA
    from tools.skills_tool import SKILLS_LIST_SCHEMA, SKILL_VIEW_SCHEMA

    # call_llm forwards `tools` straight to the OpenAI SDK, so each entry must
    # be the WIRE format: {"type": "function", "function": <schema>}. Passing a
    # bare schema list fails upstream with an opaque 400/422 ("missing field
    # `type`") depending on the provider — which costs an hour if you assume the
    # model refuses tools.
    return [
        {"type": "function", "function": schema}
        for schema in (SKILLS_LIST_SCHEMA, SKILL_VIEW_SCHEMA, SKILL_MANAGE_SCHEMA)
    ]


def _messages(fx: Dict[str, Any]) -> List[Dict[str, Any]]:
    msgs = [{"role": m["role"], "content": m["content"]} for m in fx["transcript"]]
    msgs.append({"role": "user", "content": _prompt_text(fx.get("prompt", "skill_review"))})
    return msgs


def _extract_tool_calls(response: Any) -> List[Dict[str, Any]]:
    message = response.choices[0].message
    calls = getattr(message, "tool_calls", None) or []
    out = []
    for call in calls:
        fn = getattr(call, "function", None)
        if fn is None:
            continue
        try:
            args = json.loads(fn.arguments or "{}")
        except (json.JSONDecodeError, TypeError):
            args = {}
        out.append({"id": getattr(call, "id", ""), "name": fn.name, "args": args})
    return out


def _run_calls(calls: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Execute each returned call through the REAL tool and keep its result.

    Read calls (skills_list / skill_view) are executed too — the model needs
    their output to name a skill correctly, and returning a fabricated empty
    result would make the harness score a world the model never saw.
    """
    from tools.skill_manager_tool import skill_manage
    from tools.skills_tool import skill_view, skills_list

    executed = []
    for call in calls:
        tool = call["name"]
        args = call["args"]
        try:
            if tool == "skill_manage":
                kwargs = {k: v for k, v in args.items() if k in _SKILL_MANAGE_KWARGS}
                raw = skill_manage(**kwargs)
                payload = json.loads(raw)
            elif tool == "skills_list":
                raw = skills_list(category=args.get("category"))
                payload = json.loads(raw)
            elif tool == "skill_view":
                raw = skill_view(str(args.get("name") or ""), file_path=args.get("file_path"))
                payload = json.loads(raw)
            else:
                payload = {"success": False, "error": f"tool {tool!r} not offered by this harness"}
        except Exception as exc:  # a malformed call is a failed action, not a crash
            payload = {"success": False, "error": f"{type(exc).__name__}: {exc}"}
        executed.append({"tool": tool, "args": args, "result": payload})
    return executed


def run_fixture_live(fx: Dict[str, Any], *, rounds: int, timeout: float,
                     provider: Optional[str], model: Optional[str]) -> Dict[str, Any]:
    from agent.auxiliary_client import call_llm

    home = Path(os.environ["ALICE_HOME"])
    seed_fixture_skills(home, fx)
    messages = _messages(fx)
    tools = _tools()
    applied: List[Dict[str, Any]] = []
    error = None
    for _ in range(max(1, rounds)):
        try:
            overrides = {}
            if provider:
                overrides["provider"] = provider
            if model:
                overrides["model"] = model
            response = call_llm(
                task="background_review",
                messages=messages,
                tools=tools,
                timeout=timeout,
                max_tokens=2000,
                **overrides,
            )
        except Exception as exc:
            error = f"{type(exc).__name__}: {exc}"
            break
        calls = _extract_tool_calls(response)
        if not calls:
            break
        results = _run_calls(calls)
        applied.extend(results)
        messages.append({
            "role": "assistant",
            "content": json.dumps(
                [{"name": c["name"], **c["args"]} for c in calls], ensure_ascii=False
            ),
        })
        messages.append({
            "role": "user",
            "content": "Results: " + json.dumps(
                [r["result"] for r in applied[-len(results):]], ensure_ascii=False
            ) + "\nContinue, or stop if you are done.",
        })

    checks = score(fx, applied, home)
    return {"fixture": fx["name"], "applied": applied, "checks": checks, "error": error}


# ---------------------------------------------------------------------------
# Scoring
# ---------------------------------------------------------------------------

def score(fx: Dict[str, Any], applied: List[Dict[str, Any]], home: Path) -> List[Dict[str, Any]]:
    """Turn the applied actions + resulting sidecar into pass/fail checks."""
    expect = fx.get("expect") or {}
    # Only skill_manage calls can change the library; read calls are ignored.
    writes = [a for a in applied if a["tool"] == "skill_manage"]
    touched = {
        a["args"].get("name")
        for a in writes
        if a["result"].get("success") and a["args"].get("action") != "record_outcome"
    }
    recorded = {
        a["args"].get("name"): str(a["args"].get("outcome") or "").lower()
        for a in writes
        if a["args"].get("action") == "record_outcome" and a["result"].get("success")
    }
    created = {
        a["args"].get("name")
        for a in writes
        if a["args"].get("action") == "create" and a["result"].get("success")
    }

    # Verify the outcome actually landed in the sidecar, not just that the
    # model asked for it — a call can succeed and still write nothing.
    from tools import skill_usage as su

    sidecar = {name: su.effectiveness(su.get_record(name)) for name in (fx.get("skills") or {})}

    checks: List[Dict[str, Any]] = []

    for name in expect.get("must_write") or []:
        checks.append({
            "check": f"touched {name}",
            "ok": name in touched,
            "detail": f"touched={sorted(t for t in touched if t)}",
        })
    for name in expect.get("must_not_write") or []:
        checks.append({
            "check": f"left {name} untouched",
            "ok": name not in touched,
            "detail": f"touched={sorted(t for t in touched if t)}",
        })
    for name, outcome in (expect.get("outcomes") or {}).items():
        effect = sidecar[name]
        if outcome == "helped":
            want = effect["helped"] >= 1
        elif outcome == "hurt":
            want = effect["hurt"] >= 1
        else:
            want = recorded.get(name) == "neutral"
        checks.append({
            "check": f"recorded {outcome} for {name}",
            "ok": bool(want),
            "detail": f"asked={recorded.get(name) or 'nothing'} sidecar={effect['helped']}/{effect['hurt']}",
        })
    if expect.get("must_not_create"):
        checks.append({
            "check": "created no new skill",
            "ok": not created,
            "detail": f"created={sorted(created)}" if created else "created=none",
        })
    return checks


# ---------------------------------------------------------------------------
# Reporting
# ---------------------------------------------------------------------------

def _print_offline(fixtures: List[Dict[str, Any]]) -> int:
    print(f"fixtures: {len(fixtures)} under {FIXTURE_DIR.relative_to(REPO_ROOT)}\n")
    bad = 0
    for fx in fixtures:
        errors = validate_fixture(fx)
        expect = fx.get("expect") or {}
        status = "OK " if not errors else "BAD"
        print(f"[{status}] {fx.get('name')}  (prompt={fx.get('prompt', 'skill_review')}, "
              f"turns={len(fx.get('transcript') or [])}, skills={len(fx.get('skills') or {})})")
        print(f"        expects: write={expect.get('must_write') or []} "
              f"outcomes={expect.get('outcomes') or {}} "
              f"no_create={bool(expect.get('must_not_create'))}")
        for err in errors:
            bad += 1
            print(f"        ERROR: {err}")
    print("\nThis run validated the harness only — it says NOTHING about prompt quality.")
    print("Score the prompt with: python scripts/eval_review_prompt.py --live")
    return 1 if bad else 0


def _print_live(results: List[Dict[str, Any]]) -> int:
    total = passed = 0
    for res in results:
        print(f"\n=== {res['fixture']}")
        if res.get("error"):
            print(f"  ✗ model call failed: {res['error']}")
            total += 1
            continue
        for check in res["checks"]:
            total += 1
            passed += 1 if check["ok"] else 0
            mark = "✓" if check["ok"] else "✗"
            print(f"  {mark} {check['check']}  [{check['detail']}]")
        actions = [
            f"{a['args'].get('action')}:{a['args'].get('name')}"
            for a in res["applied"] if a["tool"] == "skill_manage" and a["result"].get("success")
        ]
        print(f"  actions taken: {actions or 'none'}")
        failed_calls = [
            a for a in res["applied"]
            if a["tool"] == "skill_manage" and not a["result"].get("success")
        ]
        if failed_calls:
            print(f"  rejected calls: {[str(a['result'].get('error'))[:120] for a in failed_calls]}")
    pct = (100.0 * passed / total) if total else 0.0
    print(f"\n=== score: {passed}/{total} checks passed ({pct:.0f}%)")
    print("Single sample per fixture — repeat runs before trusting a small delta.")
    return 0 if passed == total and total else 1


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--live", action="store_true", help="call the model and score real decisions")
    parser.add_argument("--only", default=None, help="run a single fixture by name")
    parser.add_argument("--rounds", type=int, default=2, help="max model turns per fixture (default 2)")
    parser.add_argument("--timeout", type=float, default=120.0, help="per-call timeout in seconds")
    parser.add_argument("--provider", default=None, help="override the auxiliary provider")
    parser.add_argument("--model", default=None, help="override the auxiliary model")
    args = parser.parse_args()

    fixtures = load_fixtures(args.only)
    if not fixtures:
        print(f"no fixtures found in {FIXTURE_DIR}")
        return 1

    if not args.live:
        return _print_offline(fixtures)

    errors = {fx["name"]: validate_fixture(fx) for fx in fixtures}
    broken = {k: v for k, v in errors.items() if v}
    if broken:
        print("refusing to run live with malformed fixtures:")
        for name, errs in broken.items():
            print(f"  {name}: {errs}")
        return 1

    # Redirect ALICE_HOME BEFORE any tool module is imported. Skill tooling
    # binds skill directories at import time, so a redirect applied after the
    # first import silently points every tool at the real profile (this is how
    # a live run once scored the model against the user's real skills).
    home = prepare_home()
    os.environ["ALICE_HOME"] = str(home)
    try:
        results = [
            run_fixture_live(fx, rounds=args.rounds, timeout=args.timeout,
                             provider=args.provider, model=args.model)
            for fx in fixtures
        ]
        return _print_live(results)
    finally:
        print(f"\ntemp ALICE_HOME used for the run: {home} (removed)")
        shutil.rmtree(home, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
