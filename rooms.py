"""Two-profile practice rooms backed by locked, atomically replaced JSON files."""
import fcntl
import json
import logging
import os
import random
import re
import secrets
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from dataclasses import asdict
from pathlib import Path
from uuid import uuid4

import assessor
import profiles
import question_store as store

ROOMS_PATH = Path(__file__).resolve().parent / 'data' / 'rooms'
_executor = ThreadPoolExecutor(max_workers=2)
LEASE_SECONDS = 300


def _save(path, room):
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=path.parent, delete=False) as target:
            temporary = target.name
            json.dump(room, target, ensure_ascii=False)
            target.flush()
            os.fsync(target.fileno())
        os.replace(temporary, path)
    finally:
        if temporary and os.path.exists(temporary):
            os.unlink(temporary)


@contextmanager
def transaction(code):
    if not isinstance(code, str) or not re.fullmatch(r'[A-F0-9]{8}', code):
        raise ValueError('Invalid room code')
    ROOMS_PATH.mkdir(parents=True, exist_ok=True)
    with (ROOMS_PATH / f'{code}.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            path = ROOMS_PATH / f'{code}.json'
            if not path.exists():
                raise ValueError('Room not found')
            room = json.loads(path.read_text(encoding='utf-8'))
            yield room
            _save(path, room)
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)


def _participant(profile):
    for item in profiles.list_profiles():
        if item['id'] == profile:
            return {**item, 'seen': time.time(), 'points': 0, 'correct': 0}
    raise ValueError('Unknown profile')


def _member(room, profile):
    if profile not in room['participants']:
        raise ValueError('Join this room first')
    return room['participants'][profile]


def _new_round(room):
    questions = store.get_filtered_questions(room['field'], topic=room['topic'])
    progress = []
    for profile in room['participants']:
        token = store.active_profile.set(profile)
        try:
            progress.append(store.load_progress(room['field']))
        finally:
            store.active_profile.reset(token)
    def rank(question):
        return min(min(p.get(str(question['id']), {}).get('streak', 0), 2) for p in progress)
    weakest = min(map(rank, questions))
    candidates = [q for q in questions if rank(q) == weakest]
    previous = room.get('round', {}).get('question', {}).get('id')
    alternatives = [q for q in candidates if q['id'] != previous]
    room['round'] = {'id': str(uuid4()), 'question': random.choice(alternatives or candidates),
                     'submissions': {}, 'ready': []}
    room['number'] += 1


def create(profile, field, mode='coop', topic=None):
    if mode not in ('coop', 'compete'):
        raise ValueError('Choose coop or compete')
    if topic is not None and not isinstance(topic, str):
        raise ValueError('Invalid topic')
    if not store.get_filtered_questions(field, topic=topic):
        raise ValueError('No questions available')
    person = _participant(profile)
    ROOMS_PATH.mkdir(parents=True, exist_ok=True)
    code = secrets.token_hex(4).upper()
    room = {'code': code, 'field': field, 'topic': topic, 'mode': mode, 'closed': False,
            'participants': {profile: person}, 'number': 0, 'completed': 0}
    _new_round(room)
    # Publish a complete JSON document, including when another process creates rooms.
    while True:
        with (ROOMS_PATH / f'{code}.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            path = ROOMS_PATH / f'{code}.json'
            if not path.exists():
                room['code'] = code
                _save(path, room)
                return code
        code = secrets.token_hex(4).upper()


def join(code, profile):
    with transaction(code) as room:
        if room['closed']:
            raise ValueError('This room has ended')
        if profile not in room['participants']:
            if len(room['participants']) == 2:
                raise ValueError('This room already has two profiles')
            room['participants'][profile] = _participant(profile)
            room['number'] = 0
            _new_round(room)


def _revealed(room):
    submissions = room['round']['submissions']
    return len(room['participants']) == 2 and all(
        submissions.get(p, {}).get('recorded') for p in room['participants'])


def _record_results(room):
    current = room['round']
    for profile, submission in current['submissions'].items():
        if 'result' not in submission or submission.get('recorded'):
            continue
        token = store.active_profile.set(profile)
        try:
            result = submission['result']
            store.record_attempt(room['field'], current['question']['id'], result['correct'],
                                 result['score'], attempt_id=f"room:{room['code']}:{current['id']}:{profile}")
        finally:
            store.active_profile.reset(token)
        submission['recorded'] = True
        room['participants'][profile]['points'] += round(result['score'] * 100)
        room['participants'][profile]['correct'] += int(result['correct'])
    if _revealed(room) and not current.get('counted'):
        current['counted'] = True
        room['completed'] += 1


def _schedule(room):
    if room['closed']:
        return
    now = time.time()
    for profile, submission in room['round']['submissions'].items():
        if 'result' in submission or submission.get('error'):
            continue
        if submission.get('lease_until', 0) > now:
            continue
        job = str(uuid4())
        submission.update(job=job, lease_until=now + LEASE_SECONDS)
        _executor.submit(_grade, room['code'], room['round']['id'], profile, job,
                         room['field'], dict(room['round']['question']), submission['answer'])


def _grade(code, round_id, profile, job, field, question, answer):
    try:
        result = asdict(assessor.assess(store.load_system_prompt(field), question['question'],
                                       question['answer'], answer))
        error = None
    except Exception:
        logging.getLogger(__name__).exception('Room grading failed')
        result, error = None, 'Bewertung fehlgeschlagen. Bitte erneut versuchen.'
    try:
        with transaction(code) as room:
            if room['round']['id'] != round_id:
                return
            submission = room['round']['submissions'].get(profile)
            if not submission or submission.get('job') != job or 'result' in submission:
                return
            if result is not None:
                submission['result'] = result
            else:
                submission['error'] = error
        # Persist the grade before recording progress; retries deduplicate the attempt.
        with transaction(code) as room:
            if room['round']['id'] == round_id:
                _record_results(room)
    except Exception:
        logging.getLogger(__name__).exception('Could not finalize room grading')


def action(code, profile, operation, round_id=None, answer=None):
    with transaction(code) as room:
        _member(room, profile)
        if room['closed']:
            raise ValueError('This room has ended')
        if operation == 'leave':
            room['closed'] = True
            return
        if round_id != room['round']['id']:
            raise ValueError('This round has changed. Refresh and try again.')
        if len(room['participants']) != 2:
            raise ValueError('Wait for a second profile')
        current = room['round']
        if operation == 'submit':
            if not isinstance(answer, str) or not answer.strip() or len(answer) > 16000:
                raise ValueError('Answer must contain 1–16000 characters')
            existing = current['submissions'].get(profile)
            if existing:
                if existing['answer'] != answer.strip():
                    raise ValueError('Your answer is already submitted')
                if existing.get('error'):
                    existing.pop('error')
                    existing['lease_until'] = 0
            else:
                current['submissions'][profile] = {'answer': answer.strip()}
            _schedule(room)
        elif operation == 'ready':
            _record_results(room)
            if not _revealed(room):
                raise ValueError('Wait for both results')
            if profile not in current['ready']:
                current['ready'].append(profile)
            if len(current['ready']) == 2:
                _new_round(room)
        else:
            raise ValueError('Unknown room action')


def view(code, profile):
    with transaction(code) as room:
        _member(room, profile)['seen'] = time.time()
        _record_results(room)
        _schedule(room)
        reveal = _revealed(room)
        current = room['round']
        participants = []
        for pid, person in room['participants'].items():
            submission = current['submissions'].get(pid, {})
            item = {'id': pid, 'name': person['name'], 'online': time.time() - person['seen'] < 15,
                    'status': ('error' if submission.get('error') else 'graded' if submission.get('recorded')
                               else 'grading' if submission else 'answering'),
                    'ready': pid in current['ready']}
            if reveal:
                item.update(answer=submission['answer'], result=submission['result'],
                            points=person['points'], correct=person['correct'])
            participants.append(item)
        question = {k: v for k, v in current['question'].items() if k != 'answer'}
        token = store.active_profile.set(profile)
        try:
            question['progress'] = store.load_progress(room['field']).get(str(question['id']), {})
            question['preparation'] = store.get_question_preparation(question['progress'])
            question['bookmarked'] = any(question['id'] in ids for ids in store.load_bookmarks(room['field']).values())
        finally:
            store.active_profile.reset(token)
        own = current['submissions'].get(profile, {})
        response = {'code': code, 'field': room['field'], 'topic': room['topic'], 'mode': room['mode'],
                    'closed': room['closed'], 'round_id': current['id'], 'number': room['number'],
                    'completed': room['completed'], 'question': question, 'participants': participants,
                    'revealed': reveal, 'own_answer': own.get('answer'), 'error': own.get('error')}
        if reveal:
            response['reference_answer'] = current['question']['answer']
        return response
