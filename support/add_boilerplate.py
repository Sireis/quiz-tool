#!/usr/bin/env python3
"""
Add id, topic, and subtopic fields to a Q&A JSON array.

Usage:
    python3 add_boilerplate.py <input.json> <start_id> <topic> <subtopic>

Example:
    python3 add_boilerplate.py qa.json 11 "Segeln" "Takelage"
"""

import json
import sys


def add_boilerplate(pairs: list[dict], start_id: int, topic: str, subtopic: str) -> list[dict]:
    return [
        {"id": start_id + i, "topic": topic, "subtopic": subtopic, **pair}
        for i, pair in enumerate(pairs)
    ]


if __name__ == "__main__":
    if len(sys.argv) != 5:
        print(f"Usage: {sys.argv[0]} <input.json> <start_id> <topic> <subtopic>", file=sys.stderr)
        sys.exit(1)

    _, input_path, start_id_str, topic, subtopic = sys.argv

    with open(input_path, "r", encoding="utf-8") as f:
        pairs = json.load(f)

    result = add_boilerplate(pairs, int(start_id_str), topic, subtopic)
    print(json.dumps(result, ensure_ascii=False, indent=2))