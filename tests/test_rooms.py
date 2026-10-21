import json
import tempfile
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Event
from unittest.mock import patch

import assessor
from app import app
import profiles
import question_store as store
import rooms


class QueuedGrading:
    def __init__(self):
        self.jobs = []

    def submit(self, function, *args):
        self.jobs.append((function, args))

    def run_one(self):
        function, args = self.jobs.pop(0)
        function(*args)


class RoomTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        subject = self.root / 'sets' / 'test'
        subject.mkdir(parents=True)
        (subject / 'questions.json').write_text(json.dumps({'questions': [
            {'id': qid, 'topic': 'Topic', 'question': f'Q{qid}', 'answer': f'Reference {qid}'}
            for qid in (1, 2)
        ]}))
        (subject / 'system-prompt.txt').write_text('Grade fairly')
        self.queue = QueuedGrading()
        for target, attribute, value in (
            (store, 'FIELDS_PATH', self.root / 'sets'),
            (profiles, 'PROFILES_PATH', self.root / 'profiles'),
            (rooms, 'ROOMS_PATH', self.root / 'rooms'),
            (rooms, '_executor', self.queue),
        ):
            patcher = patch.object(target, attribute, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.a = profiles.create_profile('Alice')['id']
        self.b = profiles.create_profile('Bob')['id']
        self.c = profiles.create_profile('Charlie')['id']
        self.grade = patch.object(assessor, 'assess', return_value=assessor.Assessment(
            False, True, 'correct', 0, 1.0, 'Good answer'))
        self.assess = self.grade.start()
        self.addCleanup(self.grade.stop)
        self.client = app.test_client()

    def post(self, path, profile, body=None):
        return self.client.post(path, headers={'X-Trainer-Profile': profile}, json=body or {})

    def get(self, code, profile):
        return self.client.get(f'/api/rooms/{code}', headers={'X-Trainer-Profile': profile})

    def start(self, mode='coop'):
        response = self.post('/api/rooms', self.a, {'field': 'test', 'mode': mode})
        self.assertEqual(response.status_code, 201)
        code = response.get_json()['code']
        response = self.post(f'/api/rooms/{code}/join', self.b)
        self.assertEqual(response.status_code, 200)
        state = response.get_json()
        self.assertEqual(state['number'], 1)
        return code, state['round_id']

    def submit(self, code, round_id, profile, answer='Private answer'):
        return self.post(f'/api/rooms/{code}/submit', profile, {'round_id': round_id, 'answer': answer})

    def progress(self, profile):
        token = store.active_profile.set(profile)
        try:
            return store.load_progress('test')
        finally:
            store.active_profile.reset(token)

    def test_private_answers_shared_reveal_and_separate_progress(self):
        code, rid = self.start('compete')
        question = self.get(code, self.a).get_json()['question']
        self.assertNotIn('answer', question)
        self.assertEqual(self.submit(code, rid, self.a, 'Secret Alice').status_code, 200)
        self.queue.run_one()
        state = self.get(code, self.b).get_json()
        self.assertNotIn('Secret Alice', json.dumps(state))
        self.assertNotIn('Good answer', json.dumps(state))
        self.assertNotIn('reference_answer', state)
        self.assertFalse(state['revealed'])
        self.submit(code, rid, self.b, 'Secret Bob')
        self.queue.run_one()
        state = self.get(code, self.a).get_json()
        self.assertTrue(state['revealed'])
        self.assertEqual(state['reference_answer'], f"Reference {question['id']}")
        self.assertEqual([p['answer'] for p in state['participants']], ['Secret Alice', 'Secret Bob'])
        self.assertEqual([p['points'] for p in state['participants']], [100, 100])
        for profile in (self.a, self.b):
            self.assertEqual(self.progress(profile)[str(question['id'])]['attempts'], 1)
        self.assertEqual(self.progress('default'), {})
        self.assertEqual(self.progress(self.c), {})
        self.assertEqual(self.assess.call_count, 2)

    def test_duplicate_submission_retry_and_ready_are_idempotent(self):
        code, rid = self.start()
        for _ in range(4):
            self.submit(code, rid, self.a)
        self.assertEqual(len(self.queue.jobs), 1)
        self.assertEqual(self.submit(code, rid, self.a, 'Changed').status_code, 400)
        self.queue.run_one()
        self.submit(code, rid, self.b)
        self.queue.run_one()
        for _ in range(3):
            self.get(code, self.a)
            self.submit(code, rid, self.a)
            self.post(f'/api/rooms/{code}/ready', self.a, {'round_id': rid})
        self.assertEqual(sum(p['attempts'] for p in self.progress(self.a).values()), 1)
        state = self.post(f'/api/rooms/{code}/ready', self.b, {'round_id': rid}).get_json()
        self.assertNotEqual(state['round_id'], rid)
        self.assertEqual(state['number'], 2)
        self.assertEqual(state['completed'], 1)
        self.assertFalse(state['revealed'])
        self.assertEqual(self.submit(code, rid, self.a).status_code, 400)

    def test_failed_grading_retries_same_answer(self):
        code, rid = self.start()
        self.submit(code, rid, self.a)
        self.assess.side_effect = assessor.AssessmentError('Unavailable')
        with self.assertLogs('rooms', level='ERROR'):
            self.queue.run_one()
        state = self.get(code, self.a).get_json()
        self.assertTrue(state['error'])
        self.assertEqual(self.progress(self.a), {})
        self.assess.side_effect = None
        self.submit(code, rid, self.a)
        self.queue.run_one()
        self.assertEqual(sum(p['attempts'] for p in self.progress(self.a).values()), 1)

    def test_reconnect_membership_capacity_and_end(self):
        code, rid = self.start()
        self.assertEqual(self.get(code, self.c).status_code, 400)
        self.assertEqual(self.post(f'/api/rooms/{code}/join', self.c).status_code, 400)
        state = self.post(f'/api/rooms/{code}/join', self.a).get_json()
        self.assertEqual(state['round_id'], rid)
        self.assertEqual(len(state['participants']), 2)
        self.assertEqual(self.post(f'/api/rooms/{code}/ready', self.a, {'round_id': rid}).status_code, 400)
        self.post(f'/api/rooms/{code}/leave', self.b)
        self.assertTrue(self.get(code, self.a).get_json()['closed'])
        self.assertEqual(self.submit(code, rid, self.a).status_code, 400)
        self.assertEqual(self.post(f'/api/rooms/{code}/join', self.a).status_code, 400)

    def test_recovery_after_grade_persisted_before_progress_saved(self):
        code, rid = self.start()
        self.submit(code, rid, self.a)
        # Simulate a persisted result and a crash just after writing profile progress.
        with rooms.transaction(code) as room:
            submission = room['round']['submissions'][self.a]
            submission['result'] = {'correct': True, 'score': 1, 'feedback': 'Recovered'}
            qid = room['round']['question']['id']
            token = store.active_profile.set(self.a)
            try:
                store.record_attempt('test', qid, True, 1, attempt_id=f'room:{code}:{rid}:{self.a}')
            finally:
                store.active_profile.reset(token)
        self.get(code, self.a)
        self.assertEqual(self.progress(self.a)[str(qid)]['attempts'], 1)
        # Expired in-flight jobs are automatically rescheduled by polling.
        self.submit(code, rid, self.b)
        with rooms.transaction(code) as room:
            room['round']['submissions'][self.b]['lease_until'] = 0
        count = len(self.queue.jobs)
        self.get(code, self.b)
        self.assertEqual(len(self.queue.jobs), count + 1)

    def test_concurrent_submissions(self):
        code, rid = self.start()
        with ThreadPoolExecutor(max_workers=2) as pool:
            list(pool.map(lambda pid: rooms.action(code, pid, 'submit', rid, 'Answer'), (self.a, self.b)))
        self.assertEqual(len(self.queue.jobs), 2)
        while self.queue.jobs:
            self.queue.run_one()
        self.assertTrue(rooms.view(code, self.a)['revealed'])

    def test_background_grading_does_not_block_requests(self):
        code, rid = self.start()
        release = Event()
        def slow_assessment(*args):
            release.wait(3)
            return assessor.Assessment(False, True, 'correct', 0, 1, 'Done')
        self.assess.side_effect = slow_assessment
        with ThreadPoolExecutor(max_workers=2) as executor, patch.object(rooms, '_executor', executor):
            try:
                self.assertEqual(self.submit(code, rid, self.a).status_code, 200)
                self.assertEqual(self.submit(code, rid, self.b).status_code, 200)
                self.assertFalse(self.get(code, self.a).get_json()['revealed'])
            finally:
                release.set()
            deadline = time.monotonic() + 3
            while time.monotonic() < deadline:
                if self.get(code, self.a).get_json()['revealed']:
                    break
                time.sleep(.01)
            self.assertTrue(self.get(code, self.a).get_json()['revealed'])

    def test_question_selection_considers_both_profiles(self):
        for profile, mastered in ((self.a, 1), (self.b, 2)):
            token = store.active_profile.set(profile)
            try:
                for _ in range(2):
                    store.record_attempt('test', mastered, True, 1)
            finally:
                store.active_profile.reset(token)
        code, _ = self.start()
        # Alice has mastered Q1; Bob has not. Both questions are still eligible.
        with patch.object(rooms.random, 'choice', side_effect=lambda choices: choices[0]) as choice:
            with rooms.transaction(code) as room:
                room['round']['question']['id'] = None
                rooms._new_round(room)
        self.assertEqual({q['id'] for q in choice.call_args.args[0]}, {1, 2})

    def test_validation_and_pages(self):
        for body in ({'field': '../test'}, {'field': 'test', 'mode': 'invalid'},
                     {'field': 'test', 'topic': 'Missing'}):
            self.assertEqual(self.post('/api/rooms', self.a, body).status_code, 400)
        self.assertEqual(self.get('invalid', self.a).status_code, 400)
        self.assertEqual(self.get('AAAAAAAA', self.a).status_code, 400)
        code = self.post('/api/rooms', self.a, {'field': 'test'}).get_json()['code']
        rid = self.get(code, self.a).get_json()['round_id']
        self.assertEqual(self.submit(code, rid, self.a).status_code, 400)
        self.assertEqual(self.client.get('/together').status_code, 200)


if __name__ == '__main__':
    unittest.main()
