"""
question_store.py
Data layer for questions and per-question progress, backed by separate JSON files.
"""

import json
import random
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

QUESTIONS_PATH = Path("sets/sks/questions.json")
PROGRESS_PATH = Path("sets/sks/progress.json")


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def load_questions() -> dict:
    """Load questions from the questions.json file."""
    with open(QUESTIONS_PATH, encoding="utf-8") as f:
        return json.load(f)


def load_progress() -> dict:
    """Load progress data keyed by question ID."""
    if not PROGRESS_PATH.exists():
        return {}
    with open(PROGRESS_PATH, encoding="utf-8") as f:
        return json.load(f)


def save_progress(progress: dict) -> None:
    """Save progress data to progress.json."""
    with open(PROGRESS_PATH, "w", encoding="utf-8") as f:
        json.dump(progress, f, ensure_ascii=False, indent=2)


def get_all_questions() -> list[dict]:
    """Return all questions with their progress data injected."""
    store = load_questions()
    progress = load_progress()
    questions = store["questions"]
    
    for q in questions:
        q_id = str(q["id"])
        q["progress"] = progress.get(q_id, _default_progress())
    
    return questions


def get_question_by_id(qid: str) -> Optional[dict]:
    return next((q for q in get_all_questions() if q["id"] == qid), None)


def get_next_question(topic: Optional[str] = None) -> Optional[dict]:
    """
    Return the question with the lowest success-rate among those with at
    least one attempt; fall back to any unattempted question, then random.
    Optionally filter by topic.
    """
    questions = get_all_questions()
    if topic:
        questions = [q for q in questions if q["topic"] == topic]
    if not questions:
        return None

    unattempted = [q for q in questions if q["progress"]["attempts"] == 0]
    if unattempted:
        return random.choice(unattempted)

    return min(
        questions,
        key=lambda q: _success_rate(q["progress"]),
    )


def record_attempt(qid: str, correct: bool, score: int) -> dict:
    """Persist one attempt and return the updated progress block."""
    progress = load_progress()
    q_id = str(qid)
    
    if q_id not in progress:
        progress[q_id] = _default_progress()
    
    p = progress[q_id]
    p["attempts"] += 1
    if correct:
        p["correct"] += 1
        p["streak"] = p.get("streak", 0) + 1
    else:
        p["streak"] = 0
    p["last_result"] = "correct" if correct else "incorrect"
    p["last_score"] = score
    p["last_attempt"] = datetime.now(timezone.utc).isoformat()
    
    save_progress(progress)
    return p


def get_topics() -> list[str]:
    return sorted({q["topic"] for q in get_all_questions()})


def get_stats() -> dict:
    questions = get_all_questions()
    total = len(questions)
    attempted = sum(1 for q in questions if q["progress"]["attempts"] > 0)
    total_attempts = sum(q["progress"]["attempts"] for q in questions)
    total_correct = sum(q["progress"]["correct"] for q in questions)
    return {
        "total": total,
        "attempted": attempted,
        "unattempted": total - attempted,
        "total_attempts": total_attempts,
        "total_correct": total_correct,
        "overall_rate": round(total_correct / total_attempts * 100, 1) if total_attempts else 0,
    }


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _success_rate(progress: dict) -> float:
    if progress["attempts"] == 0:
        return 1.0
    return progress["correct"] / progress["attempts"]


def _default_progress() -> dict:
    """Return a fresh progress object for a new question."""
    return {
        "attempts": 0,
        "correct": 0,
        "streak": 0,
        "last_result": None,
        "last_score": 0,
        "last_attempt": None,
    }