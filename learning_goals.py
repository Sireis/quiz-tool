"""One subject-wide learning goal, independent of grading and bookmarks."""

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


def save_goal(field: str, target_date: str, strategy: str, timezone_name: str) -> dict:
    today = _now(timezone_name).date()
    _validate_plan(target_date, strategy, today)
    if not question_store.load_questions(field)["questions"]:
        raise ValueError("No questions available")
    goal = {"target_date": target_date, "strategy": strategy, "start_date": today.isoformat()}
    question_store.save_goal(field, goal)
    return get_goal(field, timezone_name)


def preview_goal(field: str, target_date: str, strategy: str, timezone_name: str) -> dict:
    now = _now(timezone_name)
    _validate_plan(target_date, strategy, now.date())
    goal = {"target_date": target_date, "strategy": strategy, "start_date": now.date().isoformat()}
    questions, progress = question_store.get_all_questions(field)
    return _goal_view(goal, questions, progress, now)


def delete_goal(field: str) -> None:
    question_store.save_goal(field, {})


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


def get_goal(field: str, timezone_name: str = "UTC") -> dict:
    now = _now(timezone_name)
    questions, progress = question_store.get_all_questions(field)
    goal = question_store.load_goal(field)
    response = {"goal": None, "total": len(questions), "today": now.date().isoformat()}
    if not goal:
        return response
    response["goal"] = _goal_view(goal, questions, progress, now)
    return response

