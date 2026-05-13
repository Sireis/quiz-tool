#!/usr/bin/env python3
"""
Reindex the 'questions' array in a JSON file so IDs start at 1 and increment by 1.

Usage:
    python3 reindex.py <file.json>
"""

import json
import sys


def reindex(data: dict) -> dict:
    for i, question in enumerate(data["questions"]):
        question["id"] = i + 1
    return data


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(f"Usage: {sys.argv[0]} <file.json>", file=sys.stderr)
        sys.exit(1)

    with open(sys.argv[1], "r", encoding="utf-8") as f:
        data = json.load(f)

    print(json.dumps(reindex(data), ensure_ascii=False, indent=2))