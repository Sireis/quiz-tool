"""
assessor.py
LLM-based answer assessment.

Backend is selected via the ASSESSOR_BACKEND env variable:
  gpt4all  (default) – local inference via gpt4all
  openai            – OpenAI ChatGPT API (set OPENAI_API_KEY)
"""

import json
import os
import re
from dataclasses import dataclass

BACKEND = os.environ.get("ASSESSOR_BACKEND", "gpt4all").lower()
GPT4ALL_MODEL = os.environ.get("GPT4ALL_MODEL", "mistral-7b-instruct-v0.1.Q4_0.gguf")
OPENAI_MODEL = os.environ.get("OPENAI_MODEL", "gpt-4o-mini")


@dataclass
class Assessment:
    correct: bool
    score: int          # 0–100
    feedback: str


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def assess(question: str, answer: str, student_answer: str) -> Assessment:
    prompt = _build_prompt(question, answer, student_answer)
    raw = _call_backend(prompt)
    return _parse_response(raw)


# ---------------------------------------------------------------------------
# Backend dispatch
# ---------------------------------------------------------------------------

def _call_backend(prompt: str) -> str:
    if BACKEND == "openai":
        return _call_openai(prompt)
    return _call_gpt4all(prompt)


def _call_gpt4all(prompt: str) -> str:
    from gpt4all import GPT4All  # lazy import – not installed in all envs
    model = _get_gpt4all_model()
    with model.chat_session():
        return model.generate(prompt, max_tokens=256)


def _call_openai(prompt: str) -> str:
    from openai import OpenAI  # lazy import
    client = OpenAI()
    response = client.chat.completions.create(
        model=OPENAI_MODEL,
        messages=[{"role": "user", "content": prompt}],
        max_tokens=256,
        temperature=0.2,
    )
    return response.choices[0].message.content


# ---------------------------------------------------------------------------
# Prompt construction & response parsing
# ---------------------------------------------------------------------------

def _build_prompt(question: str, answer: str, student_answer: str) -> str:
    return (
        "You are a strict but fair maritime exam examiner.\n"
        "Assess whether the student's answer is correct.\n"
        "Be lenient with phrasing but strict about factual correctness.\n\n"
        f"Question: {question}\n"
        f"Reference answer: {answer}\n"
        f"Student's answer: {student_answer}\n\n"
        "Respond ONLY with a JSON object, no extra text:\n"
        '{"correct": true/false, "score": <0-100>, "feedback": "<one concise sentence>"}'
    )


def _parse_response(raw: str) -> Assessment:
    """Extract JSON from LLM output, tolerating surrounding text."""
    match = re.search(r"\{.*?\}", raw, re.DOTALL)
    if match:
        try:
            data = json.loads(match.group())
            return Assessment(
                correct=bool(data.get("correct", False)),
                score=int(data.get("score", 0)),
                feedback=str(data.get("feedback", "")),
            )
        except (json.JSONDecodeError, ValueError):
            pass
    # Fallback: heuristic
    lower = raw.lower()
    correct = "correct" in lower and "incorrect" not in lower
    return Assessment(correct=correct, score=70 if correct else 30, feedback=raw[:200])


# ---------------------------------------------------------------------------
# Singleton model cache (gpt4all is expensive to load)
# ---------------------------------------------------------------------------

_gpt4all_instance = None


def _get_gpt4all_model():
    global _gpt4all_instance
    if _gpt4all_instance is None:
        from gpt4all import GPT4All
        _gpt4all_instance = GPT4All(GPT4ALL_MODEL)
    return _gpt4all_instance