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
from openai import OpenAI  # lazy import
from dataclasses import dataclass
from dotenv import load_dotenv
load_dotenv()

BACKEND = os.environ.get("ASSESSOR_BACKEND", "gpt4all").lower()
GPT4ALL_MODEL = os.environ.get("GPT4ALL_MODEL", "mistral-7b-instruct-v0.1.Q4_0.gguf")
OPENAI_MODEL = os.environ.get("OPENAI_MODEL", "gpt-4o-mini")

SKS_SYSTEM_PROMPT = """You are an official SKS (Sportküstenschifferschein) examiner.

You evaluate answers in German according to practical German SKS exam standards.

You will receive:
- Frage
- Musterlösung
- Schülerantwort

Task:
Assess the student answer like a real SKS Prüfer:
technically precise, safety-oriented, but fair and practice-oriented.

Important evaluation principles:
- The Musterlösung is only a reference example, not the only valid answer.
- Accept alternative correct nautical reasoning.
- Evaluate semantic correctness, not wording similarity.
- Concise answers are acceptable if the key seamanship concept is correct.
- Do NOT deduct points merely because details are omitted that were not explicitly required.
- Real SKS exams accept technically sufficient answers even if not textbook-complete.

Evaluate only based on SKS-relevant seamanship knowledge:
COLREG, navigation, weather, safety, boat handling, maritime practice.

Scoring:
- 2 Punkte:
  Technically correct and sufficiently complete for a safe SKS exam answer.
- 1 Punkt:
  Core concept understood, but incomplete, imprecise, or containing minor technical mistakes.
- 0 Punkte:
  Technically wrong, unsafe, or missing the essential seamanship concept.

Additional rules:
- Prioritize practical seamanship correctness over wording.
- Minor missing details should usually still receive 1-2 points.
- Only give 0 points if the essential nautical understanding is missing or dangerous.

Output:
{
  "correct": <true if answer is substantially correct>,
  "sks_punkte": <0-2>,
  "score": <0-100>,
  "feedback": "<short technical examiner feedback in German>"
}

Output valid JSON only.
"""


@dataclass
class Assessment:
    correct: bool
    sks_punkte: int
    score: int
    feedback: str

client = OpenAI()

# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def assess(question: str, answer: str, student_answer: str) -> Assessment:
    prompt = _build_prompt(question, answer, student_answer)
    raw = _call_backend(prompt)
    print(f"returned Response:\n{raw}")
    return _parse_response(raw)

# ---------------------------------------------------------------------------
# Backend dispatch
# ---------------------------------------------------------------------------

def _call_backend(prompt: str) -> dict:
    print(f"calling backend {BACKEND}")
    if BACKEND == "openai":
        return _call_openai(prompt)
    return _call_gpt4all(prompt)


def _call_gpt4all(prompt: str) -> str:
    from gpt4all import GPT4All  # lazy import – not installed in all envs
    model = _get_gpt4all_model()
    with model.chat_session():
        return model.generate(prompt, max_tokens=256)


def _call_openai(prompt: str) -> dict:

    response = client.responses.create(
        model=OPENAI_MODEL,
        temperature=0,
        input=[
            {"role": "system", "content": SKS_SYSTEM_PROMPT},
            {"role": "user",
             "content": f"{prompt}"}
        ],
        max_output_tokens=256,
    )
    print(f"API respone:\n{response.output_text}")
    return response.output_text


# ---------------------------------------------------------------------------
# Prompt construction & response parsing
# ---------------------------------------------------------------------------

def _build_prompt(question: str, answer: str, student_answer: str) -> str:
    return (
        f"Frage: {question}\n"
        f"Musterlösung: {answer}\n"
        f"Schülerantwort: {student_answer}\n\n"
    )


def _parse_response(raw: str) -> Assessment:
    """Extract JSON from LLM output, tolerating surrounding text."""
    match = re.search(r"\{.*?\}", raw, re.DOTALL)
    if match:
        try:
            data = json.loads(match.group())
            correct = data.get("correct", False)
            if isinstance(correct, str):
                correct = correct.lower() in ("true", "1", "yes", "correct", "richtig")
            return Assessment(
                correct=bool(correct),
                sks_punkte=int(data.get("sks_punkte", 0)),
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