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


@dataclass
class Assessment:
    is_sks: bool
    correct: bool
    result: str
    sks_punkte: int
    score: float
    feedback: str

client = OpenAI()

# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def assess(system_prompt: str, question: str, answer: str, student_answer: str) -> Assessment:
    prompt = _build_prompt(question, answer, student_answer)
    raw = _call_backend(system_prompt, prompt)
    print(f"returned Response:\n{raw}")
    return _parse_response(raw)

# ---------------------------------------------------------------------------
# Backend dispatch
# ---------------------------------------------------------------------------

def _call_backend(system_prompt: str, prompt: str) -> dict:
    print(f"calling backend {BACKEND}")
    if BACKEND == "openai":
        return _call_openai(system_prompt, prompt)
    return _call_gpt4all(prompt)


def _call_gpt4all(prompt: str) -> str:
    from gpt4all import GPT4All  # lazy import – not installed in all envs
    model = _get_gpt4all_model()
    with model.chat_session():
        return model.generate(prompt, max_tokens=256)


def _call_openai(system_prompt: str, prompt: str) -> dict:

    response = client.responses.create(
        model=OPENAI_MODEL,
        temperature=0,
        input=[
            {"role": "system", "content": system_prompt},
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
    if "sks" in raw:
        return _parse_response_sks(raw)
    
    match = re.search(r"\{.*?\}", raw, re.DOTALL)
    if match:
        try:
            data = json.loads(match.group())
            result = data.get("result", "incorrect")
            return Assessment(
                is_sks=False,
                sks_punkte=0,
                correct=bool(True if result == "correct" or result == "mostly_correct" else False),
                result=str(data.get("result", "incorrect")),
                score=float(data.get("score", 0.0)),
                feedback=str(data.get("feedback", "")),
            )
        except (json.JSONDecodeError, ValueError):
            pass
    # Fallback: heuristic
    lower = raw.lower()
    correct = "correct" in lower and "incorrect" not in lower
    return Assessment(correct=correct, score=70 if correct else 30, feedback=raw[:200])

def _parse_response_sks(raw: str) -> Assessment:
    """Extract JSON from LLM output, tolerating surrounding text."""
    match = re.search(r"\{.*?\}", raw, re.DOTALL)
    if match:
        try:
            data = json.loads(match.group())
            correct = data.get("correct", False)
            if isinstance(correct, str):
                correct = correct.lower() in ("true", "1", "yes", "correct", "richtig")
            return Assessment(
                is_sks=True,
                correct=bool(correct),
                result="",
                sks_punkte=int(data.get("sks_punkte", 0)),
                score=float(data.get("score", 0.0)),
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