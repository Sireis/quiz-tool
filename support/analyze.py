#!/usr/bin/env python3
"""
Analyze Prüfungsbogen sets against a question bank.

Usage:
    python3 analyze.py <bank.json> <pruefungsbogen.json>

Outputs:
    - Summary metrics
    - Topic frequency (sorted)
    - Questions appearing in multiple sets
    - Unmatched IDs
"""

import json
import sys
from collections import Counter


# --- Loading ---

def load_bank(path: str) -> dict[int, dict]:
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    questions = data["questions"] if isinstance(data, dict) else data
    return {q["id"]: q for q in questions}


def load_sets(path: str) -> dict[str, list[int]]:
    with open(path, encoding="utf-8") as f:
        return json.load(f)


# --- Analysis ---

def all_ids(sets: dict[str, list[int]]) -> list[int]:
    return [id_ for ids in sets.values() for id_ in ids]


def id_frequency(sets: dict[str, list[int]]) -> Counter:
    return Counter(all_ids(sets))


def topic_frequency(freq: Counter, bank: dict[int, dict]) -> Counter:
    topic_freq: Counter = Counter()
    for id_, count in freq.items():
        q = bank.get(id_)
        topic = q["topic"] if q else "(not in bank)"
        topic_freq[topic] += count
    return topic_freq


# --- Reporting ---

def print_section(title: str) -> None:
    print(f"\n{'='*60}")
    print(f"  {title}")
    print('='*60)


def report(sets: dict[str, list[int]], bank: dict[int, dict]) -> None:
    freq      = id_frequency(sets)
    unique    = len(freq)
    matched   = sum(1 for id_ in freq if id_ in bank)
    missing   = sorted(id_ for id_ in freq if id_ not in bank)
    dupes     = sorted(((id_, c) for id_, c in freq.items() if c > 1), key=lambda x: -x[1])
    topic_freq = topic_frequency(freq, bank)

    print_section("Summary")
    print(f"  Prüfungsbogen : {len(sets)}")
    print(f"  Unique IDs    : {unique}")
    print(f"  Matched       : {matched}")
    print(f"  Unmatched     : {len(missing)}")

    print_section("Topic frequency (sorted)")
    for topic, count in topic_freq.most_common():
        print(f"  {count:4d}  {topic}")

    print_section("Questions in multiple sets (learn these first)")
    for id_, count in dupes:
        q = bank.get(id_)
        label = q["question"][:80] + ("…" if q and len(q["question"]) > 80 else "") if q else "(not in bank)"
        topic = f"[{q['topic']}] " if q and q.get("topic") else ""
        print(f"  {count}×  ID {id_:4d}  {topic}{label}")

    print_section("Unmatched IDs (not in bank)")
    if missing:
        print("  " + ", ".join(str(i) for i in missing))
    else:
        print("  None — all IDs covered.")


# --- CLI ---

if __name__ == "__main__":
    if len(sys.argv) != 3:
        print(f"Usage: {sys.argv[0]} <bank.json> <pruefungsbogen.json>", file=sys.stderr)
        sys.exit(1)

    bank = load_bank(sys.argv[1])
    sets = load_sets(sys.argv[2])
    report(sets, bank)