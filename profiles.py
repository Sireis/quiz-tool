"""Selectable local profiles, without accounts or authentication."""

import json
from pathlib import Path
from uuid import UUID, uuid4

PROFILES_PATH = Path(__file__).resolve().parent / "data" / "profiles"
DEFAULT_PROFILE = {"id": "default", "name": "Standard"}


def profile_path(profile_id: str) -> Path:
    try:
        if str(UUID(profile_id)) != profile_id:
            raise ValueError("Unknown profile")
    except (ValueError, TypeError, AttributeError):
        raise ValueError("Unknown profile") from None
    path = PROFILES_PATH / profile_id
    if not (path / "profile.json").is_file():
        raise ValueError("Unknown profile")
    return path


def list_profiles() -> list[dict]:
    profiles = []
    if PROFILES_PATH.exists():
        for path in PROFILES_PATH.glob("*/profile.json"):
            profiles.append(json.loads(path.read_text(encoding="utf-8")))
    return [DEFAULT_PROFILE, *sorted(profiles, key=lambda item: item["name"].casefold())]


def create_profile(name: str) -> dict:
    if not isinstance(name, str) or not 1 <= len(name.strip()) <= 50:
        raise ValueError("Profile name must contain 1–50 characters")
    profile = {"id": str(uuid4()), "name": name.strip()}
    path = PROFILES_PATH / profile["id"]
    path.mkdir(parents=True)
    (path / "profile.json").write_text(json.dumps(profile, ensure_ascii=False), encoding="utf-8")
    return profile
