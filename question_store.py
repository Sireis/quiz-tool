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

FIELDS_PATH = Path("sets")

# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def load_questions(field) -> dict:
    """Load questions from the questions.json file."""
    path = FIELDS_PATH / field / "questions.json"
    if not path.exists():
        return {}
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def load_progress(field: str) -> dict:
    """Load progress data keyed by question ID."""
    path = FIELDS_PATH / field / "progress.json"
    if not path.exists():
        return {}
    with open(path, encoding="utf-8") as f:
        return json.load(f)
    
def load_sets(field: str) -> dict:
    path = FIELDS_PATH / field / "sets.json"
    if not path.exists():
        return {}
    with open(path, encoding="utf-8") as f:
        return json.load(f)
    
def load_examens(field: str) -> dict:
    path = FIELDS_PATH / field / "examens.json"
    if not path.exists():
        return {}
    with open(path, encoding="utf-8") as f:
        return json.load(f)
        
def load_system_prompt(field: str) -> dict:
    """Load system prompt."""
    path = FIELDS_PATH / field / "system-prompt.txt"
    if not path.exists():
        return {}
    with open(path, encoding="utf-8") as f:
        return f.read()

def save_progress(field: str, progress: dict) -> None:
    """Save progress data to progress.json."""
    path = FIELDS_PATH / field / "progress.json"
    with open(path, "w", encoding="utf-8") as f:
        json.dump(progress, f, ensure_ascii=False, indent=2)


def get_all_questions(field: str) -> list[dict]:
    """Return all questions with their progress data injected."""
    store = load_questions(field)
    progress = load_progress(field)
    questions = store["questions"]
        
    return questions, progress

def get_filtered_questions(field: str, filter: str, topic: str) -> list[dict]:    
    questions, _ = get_all_questions(field)
    if filter:
        sets = load_sets(field)
        examens = load_examens(field)
        if filter in sets:
            ids = sets[filter]
        if filter in examens:
            ids = examens[filter]
        
        filtered_questions = []
        for id in ids:
            filtered_questions.append(next((q for q in questions if q["id"] == id), None))
        questions = filtered_questions

    if topic:
        questions = [q for q in questions if q["topic"] == topic]
        
    return questions


def get_question_by_id(field: str, qid: str) -> Optional[dict]:
    questions, _ = get_all_questions(field)
    return next((q for q in questions if q["id"] == int(qid)), None)


def get_next_question(field: str, filter: Optional[str] = None, topic: Optional[str] = None) -> Optional[dict]:
    """
    Return the question with the lowest success-rate among those with at
    least one attempt; fall back to any unattempted question, then random.
    Optionally filter by topic.
    """
    questions = get_filtered_questions(field, filter, topic)
    progress = load_progress(field)

    if topic:
        questions = [q for q in questions if q["topic"] == topic]
    if not questions:
        return None

    unattempted = [
        q for q in questions
        if progress.get(str(q["id"]), {}).get("attempts", 0) == 0
    ]
    if unattempted:
        return random.choice(unattempted)

    return min(
        questions,
        key=lambda q: _success_rate(progress[str(q["id"])]),
    )


def record_attempt(field: str, qid: str, correct: bool, score: int) -> dict:
    """Persist one attempt and return the updated progress block."""
    progress = load_progress(field)
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
    
    save_progress(field, progress)
    return p


def get_fields() -> list[str]:
    all_fields = [p.name for p in FIELDS_PATH.iterdir() if p.is_dir()]
    return sorted(all_fields)


def get_sets(field: str) -> list[dict]:
    sets = load_sets(field)

    return [
        {
            "name": name,
            "questions_count": len(questions),
        }
        for name, questions in sets.items()
    ]

def get_examens(field: str) -> list[dict]:
    sets = load_examens(field)

    return [
        {
            "name": name,
            "questions_count": len(questions),
        }
        for name, questions in sets.items()
    ]


def get_topics(field: str) -> list[str]:
    questions, _ = get_all_questions(field)
    return sorted({q["topic"] for q in questions})


def get_set_stats(field: str, set: str) -> dict:
    questions = get_filtered_questions(field, set, "")
    ids = [q["id"] for q in questions]
    return get_stats(field, ids)


def get_examen_stats(field: str, examen: str) -> dict:
    questions = get_filtered_questions(field, examen, "")
    ids = [q["id"] for q in questions]
    return get_stats(field, ids)


def get_topic_stats(field: str, topic: str) -> dict:
    questions = get_filtered_questions(field, "", topic)
    ids = [q["id"] for q in questions]
    return get_stats(field, ids)


def get_stats(field: str, ids: list[int]) -> dict:
    questions, progress = get_all_questions(field)
    if (ids == None):
        ids = [q["id"] for q in questions]

    total_questions = len(ids)

    attempted_questions = 0
    correct_questions = 0
    total_attempts = 0
    total_correct = 0
    total_score = 0
    total_streak = 0

    for question_id in ids:
        p = progress.get(str(question_id))

        if p is None:
            continue

        attempted_questions += 1

        attempts = p.get("attempts", 0)
        correct = p.get("correct", 0)

        total_attempts += attempts
        total_correct += correct

        total_score += p.get("last_score", 0)
        total_streak += p.get("streak", 0)

        if p.get("last_result") == "correct":
            correct_questions += 1

    incorrect_questions = attempted_questions - correct_questions

    return {
        "total": total_questions,
        "attempted": attempted_questions,
        "unattempted_questions": (
            total_questions - attempted_questions
        ),
        "total_correct": correct_questions,
        "incorrect_questions": incorrect_questions,
        "completion_percent": (
            attempted_questions / total_questions * 100
            if total_questions else 0
        ),
        "success_rate": (
            total_correct / total_attempts * 100
            if total_attempts else 0
        ),
        "average_score": (
            total_score / attempted_questions
            if attempted_questions else 0
        ),
        "average_streak": (
            total_streak / attempted_questions
            if attempted_questions else 0
        ),
        "total_attempts": total_attempts,
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