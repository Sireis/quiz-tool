#!/usr/bin/env python3
"""
Parse HTML containing Q&A pairs into JSON.
Only assumption: questions are in <strong> tags; answers follow until the next <strong>.
"""

import json
import re
import sys
from bs4 import BeautifulSoup, NavigableString, Tag


# --- Top-level entry points ---

def parse_qa_from_file(path: str) -> list[dict]:
    with open(path, "r", encoding="utf-8") as f:
        return parse_qa(f.read())


def parse_qa(html: str) -> list[dict]:
    soup        = BeautifulSoup(html, "html.parser")
    strong_tags = soup.find_all("strong")
    return [_build_pair(soup, s, strong_tags[i + 1] if i + 1 < len(strong_tags) else None)
            for i, s in enumerate(strong_tags)]


# --- Pair construction ---

def _build_pair(soup: BeautifulSoup, question_tag: Tag, next_question_tag: Tag | None) -> dict:
    return {
        "question": question_tag.get_text(strip=True),
        "answer":   _collect_answer(soup, question_tag, next_question_tag),
    }


# --- Answer collection ---

def _collect_answer(soup: BeautifulSoup, from_tag: Tag, until_tag: Tag | None) -> str:
    """Collect all text nodes that appear after from_tag and before until_tag."""
    parts    = []
    in_range = False

    for node in soup.descendants:
        if node is from_tag:
            in_range = True
            continue

        if until_tag and node is until_tag:
            break

        if not in_range:
            continue

        if isinstance(node, NavigableString):
            text = node.strip()
            if text and not _is_noise(text) and not _is_descendant_of(node, from_tag):
                parts.append(text)

    return "\n".join(parts)


def _is_noise(text: str) -> bool:
    return bool(re.match(r'^Nummer\s+\d+\s*:?$', text.strip()))


def _is_descendant_of(node, ancestor: Tag) -> bool:
    for parent in node.parents:
        if parent is ancestor:
            return True
    return False


# --- CLI ---

if __name__ == "__main__":
    if len(sys.argv) == 2:
        pairs = parse_qa_from_file(sys.argv[1])
    else:
        pairs = parse_qa(sys.stdin.read())

    print(json.dumps(pairs, ensure_ascii=False, indent=2))