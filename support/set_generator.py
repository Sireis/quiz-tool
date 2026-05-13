#!/usr/bin/env python3
"""
Match questions from a text file (one question per line) to IDs in a JSON question bank.

Usage:
    python3 match_questions.py <questions.json> <input.txt> [--threshold 60]

Output: one line per input line, containing the matched question ID or -1.
"""

import argparse
import json
import sys

from rapidfuzz import fuzz, process


EXPECTED_COUNT = 30


# --- Top-level ---

def match_questions(bank: list[dict], raw_text: str, threshold: int) -> list[int]:
    candidates = [line.strip() for line in raw_text.splitlines() if line.strip()]
    return [best_match(c, bank, threshold) for c in candidates]


# --- Fuzzy matching ---

def best_match(candidate: str, bank: list[dict], threshold: int) -> int:
    bank_questions = [q["question"] for q in bank]
    result = process.extractOne(candidate, bank_questions, scorer=fuzz.token_set_ratio)

    if result is None or result[1] < threshold:
        return -1

    matched_question = result[0]
    for q in bank:
        if q["question"] == matched_question:
            return q["id"]
    return -1


# --- CLI ---

def load_bank(path: str) -> list[dict]:
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    return data["questions"] if isinstance(data, dict) else data


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("json",  help="Question bank JSON file")
    parser.add_argument("text",  help="Input text file with question set")
    parser.add_argument("--threshold", type=int, default=60,
                        help="Minimum match score 0-100 (default: 60)")
    args = parser.parse_args()

    bank = load_bank(args.json)

    with open(args.text, "r", encoding="utf-8") as f:
        raw = f.read()

    results = match_questions(bank, raw, args.threshold)

    if len(results) != EXPECTED_COUNT:
        print(f"Warning: got {len(results)} lines, expected {EXPECTED_COUNT}", file=sys.stderr)

    for id_ in results:
        print(id_)