"""Profile-specific learning goals for subjects and question selections."""

import json
import math
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import question_store


def _now(timezone_name: str) -> datetime:
    if not isinstance(timezone_name, str):
        raise ValueError("Invalid timezone")
    try:
        return datetime.now(ZoneInfo(timezone_name))
    except (ZoneInfoNotFoundError, ValueError):
        raise ValueError("Unknown timezone") from None


STRATEGIES = {"steady", "increasing", "frontloaded"}


def _validate_plan(target_date: str, strategy: str, today: date) -> None:
    try:
        target = date.fromisoformat(target_date)
    except (TypeError, ValueError):
        raise ValueError("Choose a valid target date") from None
    if target.isoformat() != target_date or target < today:
        raise ValueError("Target date must be today or later")
    if not isinstance(strategy, str) or strategy not in STRATEGIES:
        raise ValueError("Choose a valid workload strategy")


def _selection(
    field: str, scope: str, name: str, subtopic: str,
) -> tuple[str | None, list[dict], dict]:
    if scope not in {"field", "topic", "set", "examen"}:
        raise ValueError("Unknown goal scope")
    questions, progress = question_store.get_all_questions(field)
    if scope == "field":
        if name or subtopic:
            raise ValueError("Invalid field goal scope")
        return None, questions, progress
    if not isinstance(name, str) or not name or not isinstance(subtopic, str):
        raise ValueError("Choose a goal selection")
    if scope == "topic":
        if not any(q["topic"] == name for q in questions):
            raise ValueError("Unknown topic")
        questions = [q for q in questions if q["topic"] == name
                     and (not subtopic or q.get("subtopic") == subtopic)]
    else:
        if subtopic:
            raise ValueError("Invalid group goal scope")
        groups = question_store.load_sets(field) if scope == "set" else question_store.load_examens(field)
        if name not in groups:
            raise ValueError("Unknown question set")
        ids = set(groups[name])
        if ids - {q["id"] for q in questions}:
            raise ValueError("Question set contains unknown IDs")
        questions = [q for q in questions if q["id"] in ids]
    return json.dumps([scope, name, subtopic], ensure_ascii=False), questions, progress


def save_goal(
    field: str, target_date: str, strategy: str, timezone_name: str,
    scope: str = "field", name: str = "", subtopic: str = "",
) -> dict:
    today = _now(timezone_name).date()
    _validate_plan(target_date, strategy, today)
    key, questions, _ = _selection(field, scope, name, subtopic)
    if not questions:
        raise ValueError("No questions available")
    goal = {"target_date": target_date, "strategy": strategy, "start_date": today.isoformat()}
    question_store.save_goal(field, goal, key)
    return get_goal(field, timezone_name, scope, name, subtopic)


def preview_goal(
    field: str, target_date: str, strategy: str, timezone_name: str,
    scope: str = "field", name: str = "", subtopic: str = "",
) -> dict:
    now = _now(timezone_name)
    _validate_plan(target_date, strategy, now.date())
    goal = {"target_date": target_date, "strategy": strategy, "start_date": now.date().isoformat()}
    _, questions, progress = _selection(field, scope, name, subtopic)
    return _goal_view(goal, questions, progress, now)


def delete_goal(field: str, scope: str = "field", name: str = "", subtopic: str = "") -> None:
    key, _, _ = _selection(field, scope, name, subtopic)
    question_store.save_goal(field, {}, key)


def _dated_events(entry: dict, now: datetime) -> list[tuple[datetime, dict]]:
    events = []
    for event in entry.get("history", []):
        try:
            at = datetime.fromisoformat(event["at"])
            if at.tzinfo is not None:
                events.append((at.astimezone(now.tzinfo), event))
        except (KeyError, TypeError, ValueError):
            continue
    # Legacy progress retains only its most recent answer. After migration,
    # that timestamp is preserved separately from the new detailed history.
    legacy_at = (entry.get("historical_last_attempt") if "history" in entry
                 else entry.get("last_attempt") or entry.get("last_seen"))
    legacy_result = (entry.get("historical_last_result") if "history" in entry
                     else entry.get("last_result"))
    if legacy_at:
        try:
            at = datetime.fromisoformat(legacy_at)
            if at.tzinfo is not None:
                at = at.astimezone(now.tzinfo)
                if not any(existing_at == at for existing_at, _ in events):
                    events.append((at, {"correct": legacy_result == "correct"}))
        except (TypeError, ValueError):
            pass
    return events


def _study_day(at: datetime) -> date:
    """Group local timestamps into study days without changing stored dates."""
    return at.date() - timedelta(days=at.hour < 6)


def _entry_at_day_start(entry: dict, now: datetime) -> dict:
    events = _dated_events(entry, now)
    today = [event for at, event in events if _study_day(at) == _study_day(now)]
    if not today:
        return entry
    attempts = max(0, entry.get("attempts", 0) - len(today))
    correct = max(0, entry.get("correct", 0) - sum(event.get("correct") is True for event in today))
    before = [(at, event) for at, event in events if _study_day(at) < _study_day(now)]
    if before:
        last_result = "correct" if max(before, key=lambda item: item[0])[1].get("correct") else "incorrect"
    else:
        # Older progress did not retain its last result when history began.
        last_result = entry.get("historical_last_result", "correct" if correct else "incorrect")
    return {**entry, "attempts": attempts, "correct": correct, "last_result": last_result}


def _remaining_work(entry: dict) -> int:
    if question_store.get_question_preparation(entry) == "green":
        return 0
    # Two correct answers turn red into green; yellow needs one more correct answer.
    return max(1, 2 - entry.get("correct", 0))


def _goal_view(goal: dict, questions: list[dict], progress: dict, now: datetime) -> dict:
    today = _study_day(now)
    entries = [progress.get(str(question["id"]), {}) for question in questions]
    remaining_work = sum(_remaining_work(entry) for entry in entries)
    prepared = sum(question_store.get_question_preparation(entry) == "green" for entry in entries)
    today_count = sum(_study_day(at) == _study_day(now) for entry in entries for at, _ in _dated_events(entry, now))
    day_start_work = sum(_remaining_work(_entry_at_day_start(entry, now)) for entry in entries)
    days_remaining = (date.fromisoformat(goal["target_date"]) - today).days
    days = max(1, days_remaining + 1)  # Today and the target date are study days.
    strategy = goal.get("strategy", "steady")  # Original manually configured goals still work.
    age = max(1, (today - date.fromisoformat(goal.get("start_date", today.isoformat()))).days + 1)
    if strategy == "increasing":
        weight, total_weight = age, days * (2 * age + days - 1) // 2
    elif strategy == "frontloaded":
        weight, total_weight = days, days * (days + 1) // 2
    else:
        weight, total_weight = 1, days
    # Keep the day's target stable so additional practice remains visible as bonus
    # effort. Tomorrow's recommendation uses the updated preparation instead.
    daily_target = math.ceil(day_start_work * weight / total_weight)
    counts = {color: sum(question_store.get_question_preparation(entry) == color for entry in entries)
              for color in ("red", "yellow", "green")}
    return {
        "target_date": goal["target_date"], "strategy": strategy,
        "remaining_work": remaining_work,
        "daily_target": daily_target,
        "daily_remaining": max(0, daily_target - today_count),
        "prepared": prepared,
        "preparation_percent": round(prepared / len(questions) * 100) if questions else 0,
        "today_count": today_count,
        "daily_percent": round(today_count / daily_target * 100) if daily_target else None,
        "overachievement": max(0, today_count - daily_target),
        "preparation_counts": counts,
        "daily_complete": today_count >= daily_target,
        "days_remaining": days_remaining,
        "complete": bool(questions) and prepared == len(questions),
    }


def get_goal(
    field: str, timezone_name: str = "UTC", scope: str = "field",
    name: str = "", subtopic: str = "",
) -> dict:
    now = _now(timezone_name)
    key, questions, progress = _selection(field, scope, name, subtopic)
    goal = question_store.load_goal(field, key)
    response = {"goal": None, "total": len(questions), "today": now.date().isoformat()}
    if not goal:
        return response
    response["goal"] = _goal_view(goal, questions, progress, now)
    return response


def get_goal_previews(field: str, timezone_name: str = "UTC") -> list[dict]:
    """Return saved selection goals together for sidebar previews."""
    now = _now(timezone_name)
    previews = []
    for key, goal in question_store.load_scoped_goals(field).items():
        scope, name, subtopic = json.loads(key)
        try:
            _, questions, progress = _selection(field, scope, name, subtopic)
        except ValueError:
            # A deleted question group can retain its goal until restored.
            continue
        previews.append({"scope": scope, "name": name, "subtopic": subtopic,
                         "goal": _goal_view(goal, questions, progress, now)})
    return previews

