"""Review schedules and selection policy, independent of progress storage."""

import random
from datetime import datetime, timedelta, timezone

INTERVALS = (1, 3, 7, 14, 30)
RETRY_SECONDS = 10 * 60


def parse_time(value):
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    return parsed.astimezone(timezone.utc) if parsed.tzinfo is not None else None


def _advance(previous, correct, now):
    due = parse_time(previous.get("due_at"))
    if correct and due and now < due and previous.get("step", -1) >= 0:
        # Extra practice must not accelerate or postpone an existing review.
        return previous.copy()
    step = min(previous.get("step", -1) + 1, len(INTERVALS) - 1) if correct else -1
    seconds = INTERVALS[step] * 86400 if correct else RETRY_SECONDS
    return {"step": step, "interval_seconds": seconds,
            "due_at": (now + timedelta(seconds=seconds)).isoformat()}


def schedule(entry):
    if "review" in entry:
        return entry["review"].copy()
    # Legacy entries are interpreted without changing their stored history.
    result = {}
    historical = entry.get("historical_attempts", 0)
    if historical or not entry.get("history"):
        at = parse_time(entry.get("historical_last_attempt") if historical else
                        entry.get("last_attempt") or entry.get("last_seen"))
        last_result = entry.get("historical_last_result") if historical else entry.get("last_result")
        if at and last_result in {"correct", "incorrect"}:
            step = min(max(entry.get("streak", 1) - 1, 0), len(INTERVALS) - 1)
            # A historical aggregate has no reliable consecutive review dates.
            if historical:
                step = 0
            result = _advance({"step": step - 1}, last_result == "correct", at)
    for event in entry.get("history", []):
        at = parse_time(event.get("at"))
        if at and type(event.get("correct")) is bool:
            result = _advance(result, event["correct"], at)
    return result


def next_schedule(entry, correct, now):
    return _advance(schedule(entry), correct, now)


def remember_display(state, question_id, now):
    state.setdefault("shown", {})[str(question_id)] = now.isoformat()
    state["recent"] = (state.get("recent", []) + [question_id])[-3:]


def choose(questions, progress_list, state, now, *, extra_practice=False):
    """Select within a filtered pool and update display state, never assessments."""
    by_id = {q["id"]: q for q in questions}
    questions = list(by_id.values())
    recent = [qid for qid in state.get("recent", []) if qid in by_id]
    excluded = set(recent[-min(3, len(questions) - 1):]) if len(questions) > 1 else set()
    available = [q for q in questions if q["id"] not in excluded]
    available_ids = {q["id"] for q in available}
    new, due, future_dates = [], [], []
    urgency = {}
    recent_only = False
    for q in questions:
        entries = [p.get(str(q["id"]), {}) for p in progress_list]
        if any(entry.get("attempts", 0) == 0 for entry in entries):
            if q["id"] in available_ids:
                new.append(q)
            else:
                recent_only = True
            continue
        priorities = []
        for entry in entries:
            review = schedule(entry)
            due_at = parse_time(review.get("due_at"))
            if due_at is None:
                priorities.append(1.0)  # Unknown historical date: review, don't invent a date.
            elif due_at <= now:
                priorities.append((now - due_at).total_seconds() /
                                  review["interval_seconds"])
            else:
                future_dates.append(due_at)
        if priorities and q["id"] in available_ids:
            urgency[q["id"]] = max(priorities)
            due.append(q)
        elif priorities:
            recent_only = True
    count = state.get("new_since_review", 0)
    if due and (not new or count >= 4):
        highest = max(urgency[q["id"]] for q in due)
        candidates = [q for q in due if urgency[q["id"]] == highest]
        kind = "review"
    elif new:
        candidates, kind = new, "new"
    elif extra_practice:
        candidates, kind = available, "extra"
    else:
        return {"practice_complete": True,
                "recent_only": recent_only,
                "next_due": min(future_dates).isoformat() if future_dates and not recent_only else None}
    shown = state.setdefault("shown", {})
    oldest = min(shown.get(str(q["id"]), "") for q in candidates)
    selected = random.choice([q for q in candidates if shown.get(str(q["id"]), "") == oldest])
    state["recent"] = recent
    remember_display(state, selected["id"], now)
    state["new_since_review"] = min(count + 1, 4) if kind == "new" else 0
    return {**selected, "selection_kind": kind}
