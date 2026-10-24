# Repository guidance

## Purpose

Quiz Trainer is a German-language learning app for free-text practice, AI
assessment, personal progress tracking, and live two-person sessions. See
[README.md](README.md) for setup, configuration, content formats, and hosting.

## Architecture

- `app.py`: Flask routes, request validation, and active-profile selection.
- `question_store.py`: question banks, adaptive selection, progress, bookmarks,
  preparation ratings, and statistics.
- `assessor.py`: GPT4All/OpenAI grading and assessment validation.
- `learning_goals.py`: deadlines and daily workload calculations.
- `profiles.py`: profile creation, listing, and storage paths.
- `rooms.py`: cooperative/competitive room lifecycle and background grading.
- `collaboration.py` and `realtime.py`: shared document updates, presence, and
  WebSocket transport.
- `templates/` and `static/`: interface and browser behavior.
- `frontend/shared-editor.js`: source for the bundled CodeMirror editor.
- `sets/`: shared question banks, grading prompts, practice/exam groups, and
  default-profile learning data.
- `data/profiles/` and `data/rooms/`: additional profiles and persisted rooms.
- `tests/`: Python unit tests and JavaScript checks.
- `support/`: question import and maintenance utilities.

## Development commands

Run commands from the repository root. Use the existing virtual environment
when available; see the README to create one.

- Start: `.venv/bin/python app.py`
- Python tests:
  `.venv/bin/python -m unittest discover -s tests -p 'test_*.py'`
- JavaScript tests: `npm test`
- Rebuild the shared editor: `npm run build`
- Install JavaScript dependencies when needed: `npm ci`

Normal Python startup does not require Node. The built editor asset is included
in `static/`.

## Implementation conventions

- Follow the existing Python and plain JavaScript patterns. Keep Flask routes
  thin and put domain logic in the relevant Python module.
- Keep user-facing text in German. Preserve keyboard interaction, focus
  handling, accessible labels, and status announcements when changing the UI.
- Edit `frontend/shared-editor.js` and rebuild `static/shared-editor.js`; do not
  hand-edit the generated bundle. Include the rebuilt asset with source changes.
- Prefer the existing stack over adding dependencies for routine changes.
- Update the README when changing setup, configuration, content formats, or
  user-visible workflows.

## Behaviors to preserve

- Question IDs remain stable: saved progress and question groups reference them.
- Question banks and practice/exam groups are shared; progress, bookmarks, and
  learning goals remain isolated by profile. The default profile retains its
  existing storage under `sets/<subject>/`.
- Revealing an answer does not record an assessed attempt. Failed or malformed
  assessments must not update progress.
- Preparation ratings and adaptive selection are separate calculations.
  Preparation uses lifetime correct answers and the latest result; selection
  mixes four new questions with a due spaced review and excludes recent displays.
  Do not change one implicitly while modifying the other.
- Learning-goal study days begin at 06:00 in the requested timezone. Preserve
  timezone and daylight-saving handling and the stable daily workload baseline.
- Competitive answers remain private from the other participant until both
  results are ready.
- Cooperative grading freezes a confirmed editor revision and records the shared
  result once per participant. Preserve idempotency across retries and recovery.
- Preserve locking and atomic writes for learning and room data. Keep
  read-modify-write operations inside the appropriate transaction.
- Maintain compatibility with legacy progress formats when changing storage;
  do not invent historical timestamps or scores during migration.

## Data and configuration

- Tests must use temporary storage and mocked grading backends. Avoid paid API
  calls or model downloads in automated tests.
- Do not modify real progress, bookmarks, goals, profiles, or room files while
  testing. Learning data can exist under both `sets/` and `data/`.
- Do not expose or commit `.env` values or credentials. Document configuration
  with placeholder values in `.env.example` or the README.
- Preserve unrelated working-tree changes.

## Validation

- Run the relevant tests for changed behavior. Add regression coverage for
  meaningful bug fixes, especially changes involving persistence, profiles,
  grading, learning goals, or collaborative state.
- Rebuild the editor and run JavaScript tests after shared-editor source changes.
- For interface changes, check desktop and mobile behavior when possible.
- Report checks performed and any verification limits. Distinguish mocked tests
  from live model or browser verification.

## Operational constraints

- Live collaboration currently requires one server process: its WebSocket hub
  and cursor presence are process-local. Do not introduce multiple workers
  without addressing broadcast and presence coordination.
- File locking uses `fcntl`; account for this Unix dependency when changing
  platform support or deployment instructions.
