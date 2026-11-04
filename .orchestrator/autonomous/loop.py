#!/usr/bin/env python3
"""Camera D-AI autonomous loop — v2 state machine (deterministic, no LLM).

Design rules (from hostile review round 4):
  R1  NO SELF-APPROVAL. `done` only succeeds when the gate script exits 0.
      The agent cannot mark a milestone done; the gate decides.
  R2  DONE IS NOT FOREVER. Every done milestone records a sha256 over its
      watch_files. If those files change, the milestone becomes `stale` and
      its dependents lose READY status.
  R3  BOUNDED RETRIES. attempts/milestone; at max_attempts -> `blocked`.
  R4  FENCING. An open run younger than stale_after_min blocks a second
      runner ("RUN IN PROGRESS"). An older one is marked INTERRUPTED and the
      next runner must RECONCILE before continuing.
  R5  UNVERIFIABLE != PASS. Gate exit 3 means "cannot verify" -> treated as
      failure, never as success.

Exit codes: 0 = milestone ready (instruction printed)
            2 = nothing ready / stopped / budget reached / run in progress
            4 = watchdog found a problem
"""
from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import time
from datetime import date
from pathlib import Path

ROOT = Path(os.environ.get("LOOP_ROOT") or Path(__file__).resolve().parent)
STATE = ROOT / "state.json"
STOP = ROOT / "STOP"
GATES = "gates.py"


# --------------------------------------------------------------------------
# state helpers
# --------------------------------------------------------------------------
def load() -> dict:
    return json.loads(STATE.read_text(encoding="utf-8"))


def save(state: dict) -> None:
    STATE.write_text(json.dumps(state, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def roll_day(state: dict) -> None:
    today = date.today().isoformat()
    if state.get("steps_today_date") != today:
        state["steps_today_date"] = today
        state["steps_today"] = 0


def by_id(state: dict) -> dict:
    return {m["id"]: m for m in state["milestones"]}


def file_sha(milestone: dict) -> str | None:
    """sha256 over the milestone's watch_files, or None when it has none."""
    names = milestone.get("watch_files") or []
    if not names:
        return None
    h = hashlib.sha256()
    for name in names:
        p = Path(name) if Path(name).is_absolute() else (ROOT / name)
        try:
            h.update(p.read_bytes())
        except OSError:
            h.update(b"<MISSING>")
    return h.hexdigest()


def invalidate(state: dict) -> list[str]:
    """R2 - demote done milestones whose watched files drifted."""
    demoted = []
    for m in state["milestones"]:
        if m.get("status") != "done":
            continue
        old = m.get("evidence_sha")
        if not old:
            continue
        if file_sha(m) != old:
            m["status"] = "stale"
            m["stale_reason"] = "watch_files changed since verification"
            m["stale_at"] = time.strftime("%Y-%m-%dT%H:%M:%S")
            demoted.append(m["id"])
    return demoted


def run_age_min(state: dict) -> float | None:
    started = (state.get("run") or {}).get("started_at")
    if not started:
        return None
    try:
        t0 = time.mktime(time.strptime(started, "%Y-%m-%dT%H:%M:%S"))
    except ValueError:
        return 10_000.0
    return (time.time() - t0) / 60.0


def close_run(state: dict, status: str) -> None:
    state["run"] = {"id": None, "started_at": None, "status": status,
                    "needs_reconcile": False}


def summary(state: dict) -> str:
    counts: dict[str, int] = {}
    for m in state["milestones"]:
        counts[m["status"]] = counts.get(m["status"], 0) + 1
    parts = ", ".join(f"{k}={v}" for k, v in sorted(counts.items()))
    return (f"cycle={state['cycle']} steps_today={state['steps_today']}"
            f"/{state['max_steps_per_day']} [{parts}]")


# --------------------------------------------------------------------------
# selection
# --------------------------------------------------------------------------
def pick(state: dict) -> dict | None:
    """Return the next milestone to work on, or None."""
    ms = state["milestones"]
    table = by_id(state)

    # 1. stale first — a verification that no longer holds must be redone
    stale = [m for m in ms if m.get("status") == "stale"]
    if stale:
        stale.sort(key=lambda m: m.get("priority", 99))
        return stale[0]

    # 2. resume an interrupted milestone (agent died mid-run)
    cur = state.get("current")
    if cur and table.get(cur, {}).get("status") == "doing":
        return table[cur]

    # 3. a fresh READY milestone: all prereqs done, lowest priority first
    ready = [m for m in ms
             if m.get("status") == "todo"
             and all(table.get(p, {}).get("status") == "done" for p in m.get("prereq", []))]
    if not ready:
        return None
    ready.sort(key=lambda m: m.get("priority", 99))
    return ready[0]


# --------------------------------------------------------------------------
# commands
# --------------------------------------------------------------------------
def cmd_next() -> int:
    state = load()
    roll_day(state)

    if STOP.exists():
        print("STOPPED: owner stop flag present at " + str(STOP))
        save(state)
        return 2

    if state["steps_today"] >= state["max_steps_per_day"]:
        print(f"BUDGET REACHED: {state['steps_today']}/{state['max_steps_per_day']} steps today")
        save(state)
        return 2

    # R4 — fencing
    age = run_age_min(state)
    reconcile = False
    if (state.get("run") or {}).get("status") == "doing" and age is not None:
        if age < state.get("stale_after_min", 20):
            print("RUN IN PROGRESS — another runner started "
                  f"{age:.1f} min ago. Refusing to start a second one.")
            save(state)
            return 2
        prev = state["run"]
        state["run"] = {"id": prev.get("id"), "started_at": prev.get("started_at"),
                        "status": "interrupted", "needs_reconcile": True}
        reconcile = True
        save(state)

    demoted = invalidate(state)
    if demoted:
        print("INVALIDATED: " + ", ".join(demoted)
              + " — watched files changed, verification no longer holds.")

    m = pick(state)
    if m is None:
        remaining = [x["id"] for x in state["milestones"]
                     if x["status"] in ("todo", "doing", "blocked", "stale")]
        if not remaining:
            print("PROJECT COMPLETE: all milestones done. " + summary(state))
        else:
            print("NOTHING READY — unmet prerequisites or blocked: " + ", ".join(remaining))
        save(state)
        return 2

    mid = m["id"]
    if m.get("status") == "stale":
        tag = "RE-VERIFY (STALE)"
        m["attempts"] = m.get("attempts", 0) + 1
        state["steps_today"] += 1
        state["cycle"] += 1
    elif m.get("status") == "doing" and mid == state.get("current"):
        tag = "RESUME"
    else:
        tag = "NEXT MILESTONE"
        m["attempts"] = m.get("attempts", 0) + 1
        state["steps_today"] += 1
        state["cycle"] += 1

    if m.get("attempts", 0) > state.get("max_attempts", 3):
        m["status"] = "blocked"
        m["blocked_reason"] = f"exceeded max_attempts={state.get('max_attempts', 3)}"
        state["current"] = None
        save(state)
        print(f"BLOCKED {mid}: exceeded max_attempts — needs human decision. {summary(state)}")
        return 2

    state["current"] = mid
    m["status"] = "doing"
    state["run"] = {"id": f"{mid}-{int(time.time())}",
                    "started_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
                    "status": "doing",
                    "needs_reconcile": bool(reconcile or m.get("needs_reconcile"))}
    save(state)

    print("=" * 70)
    print(f"{tag}: {mid}  ({summary(state)})")
    print("=" * 70)
    print(f"TITLE:    {m.get('title', '')}")
    print(f"PREREQ:   {', '.join(m.get('prereq', [])) or 'none'}")
    print(f"GATE:     {m.get('gate', '')}")
    print(f"ATTEMPT:  {m.get('attempts', 0)}/{state.get('max_attempts', 3)}")
    if m.get("stale_reason"):
        print(f"STALE:    {m['stale_reason']}")
    if state["run"].get("needs_reconcile"):
        print()
        print("RECONCILE REQUIRED: the previous run died mid-milestone.")
        print("  Inspect git status/diff and any partial side effects, finish or undo them,")
        print("  and only then run the gate. Report what you reconciled.")
    print()
    print("DO EXACTLY ONE MILESTONE THIS TURN. The gate decides success:")
    print(f"  python {Path(__file__).name} done {mid} --note '<what you changed>'")
    print(f"  python {Path(__file__).name} block {mid} '<reason>'   # genuine blocker only")
    print("  (done runs the gate script; it refuses if the gate fails)")
    return 0


def cmd_done(mid: str, note: str) -> int:
    """R1 — run the gate. Only exit 0 from the gate marks the milestone done."""
    state = load()
    table = by_id(state)
    if mid not in table:
        print(f"ERROR: unknown milestone {mid}")
        return 1
    m = table[mid]

    proc = subprocess.run([sys.executable, GATES, mid], cwd=str(ROOT),
                          capture_output=True, text=True)
    out = (proc.stdout or "").strip()
    err = (proc.stderr or "").strip()
    print(f"--- gate {mid} exit={proc.returncode} ---")
    if out:
        print(out)
    if err:
        print(err, file=sys.stderr)

    if proc.returncode == 3:
        m["attempts"] = m.get("attempts", 0) + 1
        m["status"] = "todo"
        state["current"] = None
        close_run(state, "unverifiable")
        save(state)
        print(f"REFUSED {mid}: gate UNVERIFIABLE (needs credentials or human approval).")
        return 3

    if proc.returncode != 0:
        m["attempts"] = m.get("attempts", 0) + 1
        m["status"] = "todo"
        m["last_gate_failure"] = (out or err)[-400:]
        state["current"] = None
        close_run(state, "gate_failed")
        save(state)
        print(f"REFUSED {mid}: gate FAILED. Status stays todo "
              f"(attempt {m['attempts']}/{state.get('max_attempts', 3)}).")
        return 1

    m["status"] = "done"
    m["evidence"] = note
    m["done_at"] = time.strftime("%Y-%m-%dT%H:%M:%S")
    m["verified_at"] = m["done_at"]
    m["evidence_sha"] = file_sha(m)
    m["gate_output"] = out[-400:]
    m.pop("stale_reason", None)
    state["current"] = None
    close_run(state, "done")
    save(state)
    print(f"OK {mid} -> done (gate passed). {summary(state)}")
    return 0


def cmd_block(mid: str, reason: str, hard: bool = False) -> int:
    """Retry until max_attempts, then park as blocked.

    --hard parks immediately: a missing credential/permission is a dead end,
    so spending the retry budget on it only wastes cycles.
    """
    state = load()
    table = by_id(state)
    if mid not in table:
        print(f"ERROR: unknown milestone {mid}")
        return 1
    m = table[mid]
    m["attempts"] = m.get("attempts", 0) + 1
    cap = state.get("max_attempts", 3)
    if hard or m["attempts"] >= cap:
        if hard:
            m["blocked_reason"] = reason
            m["status"] = "blocked"
            print(f"OK {mid} -> blocked immediately (--hard: {reason}). {summary(state)}")
            state["current"] = None
            close_run(state, "blocked")
            save(state)
            return 0
        m["status"] = "blocked"
        m["blocked_reason"] = reason
        print(f"OK {mid} -> blocked ({reason}) after {m['attempts']} attempts. {summary(state)}")
    else:
        m["status"] = "todo"
        m["retry_reason"] = reason
        print(f"RETRY {mid} ({reason}) attempt {m['attempts']}/{cap}. {summary(state)}")
    state["current"] = None
    close_run(state, "blocked" if m["status"] == "blocked" else "retry")
    save(state)
    return 0


def cmd_unblock(mid: str) -> int:
    """Put a parked milestone back into the queue once the blocker is gone."""
    state = load()
    table = by_id(state)
    if mid not in table:
        print(f"ERROR: unknown milestone {mid}")
        return 1
    m = table[mid]
    if m.get("status") != "blocked":
        print(f"NOT BLOCKED: {mid} is '{m.get('status')}' — nothing to do")
        return 2
    m["status"] = "todo"
    m["attempts"] = 0
    m.pop("blocked_reason", None)
    m["unblocked_at"] = time.strftime("%Y-%m-%dT%H:%M:%S")
    save(state)
    print(f"OK {mid} -> todo (attempts reset). {summary(state)}")
    return 0


def cmd_touch() -> int:
    """Refresh the open run's heartbeat (long-running milestone)."""
    state = load()
    run = state.get("run") or {}
    if run.get("status") != "doing":
        print("NO OPEN RUN")
        return 2
    run["started_at"] = time.strftime("%Y-%m-%dT%H:%M:%S")
    state["run"] = run
    save(state)
    print("HEARTBEAT REFRESHED")
    return 0


def cmd_watchdog() -> int:
    """Detect silent-death modes."""
    state = load()
    problems: list[str] = []

    age = run_age_min(state)
    if (state.get("run") or {}).get("status") == "doing" and age is not None \
            and age >= state.get("stale_after_min", 20):
        problems.append(f"ALERT run stalled: milestone {state.get('current')} open {age:.0f} min")

    for mid in invalidate(state):
        problems.append(f"ALERT verified state drifted: {mid} watch_files changed")

    remaining = [m["id"] for m in state["milestones"]
                 if m["status"] in ("todo", "doing", "stale")]
    if not remaining and any(m["status"] == "blocked" for m in state["milestones"]):
        problems.append("ALERT no progress possible: every remaining milestone is blocked")

    if state["steps_today"] >= state["max_steps_per_day"] and remaining:
        problems.append(f"ALERT budget exhausted with {len(remaining)} milestones left")

    if not problems:
        print(f"WATCHDOG OK {summary(state)}")
        save(state)
        return 0

    for p in problems:
        print(p)
    save(state)
    return 4


def cmd_status() -> int:
    state = load()
    roll_day(state)
    save(state)
    print(summary(state))
    order = {"stale": "!!  ", "blocked": "!!  ", "doing": ">>  ", "done": "OK  ", "todo": "    "}
    for m in sorted(state["milestones"], key=lambda x: x.get("priority", 99)):
        mark = order.get(m["status"], "?   ")
        extra = ""
        if m.get("attempts"):
            extra = f"  [attempts {m['attempts']}]"
        if m.get("blocked_reason"):
            extra += f"  ({m['blocked_reason'][:60]})"
        if m.get("stale_reason"):
            extra += f"  ({m['stale_reason'][:60]})"
        print(f"{mark}{m['id']:<4} {m.get('title', '')[:78]}{extra}")
    if STOP.exists():
        print("STOP FLAG PRESENT — loop is halted")
    return 0


def main(argv: list[str]) -> int:
    if not argv or argv[0] == "next":
        return cmd_next()
    if argv[0] == "status":
        return cmd_status()
    if argv[0] == "watchdog":
        return cmd_watchdog()
    if argv[0] == "touch":
        return cmd_touch()
    if argv[0] == "done" and len(argv) >= 2:
        note = ""
        if "--note" in argv:
            i = argv.index("--note")
            note = argv[i + 1] if len(argv) > i + 1 else ""
        return cmd_done(argv[1], note)
    if argv[0] == "block" and len(argv) >= 3:
        return cmd_block(argv[1], argv[2], hard="--hard" in argv)
    if argv[0] == "unblock" and len(argv) >= 2:
        return cmd_unblock(argv[1])
    print(__doc__)
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
