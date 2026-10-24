import json
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

import profiles
import question_store as store
import spaced_repetition as reviews
from app import app


class ReviewTests(unittest.TestCase):
    def setUp(self):
        self.now = datetime(2026, 10, 24, 12, tzinfo=timezone.utc)
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        subject = self.root / 'sets' / 'test'
        subject.mkdir(parents=True)
        self.questions = [
            {'id': i, 'topic': 'Topic', 'question': f'Q{i}', 'answer': 'A'}
            for i in range(1, 41)
        ]
        (subject / 'questions.json').write_text(json.dumps({'questions': self.questions}))
        (subject / 'sets.json').write_text(json.dumps({'Small': [1, 2], 'Single': [1]}))
        for target, attribute, value in (
            (store, 'FIELDS_PATH', self.root / 'sets'),
            (profiles, 'PROFILES_PATH', self.root / 'profiles'),
        ):
            patcher = patch.object(target, attribute, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.client = app.test_client()

    def entry(self, days_overdue=0, interval=86400, streak=3):
        return {'attempts': 3, 'correct': 3, 'streak': streak, 'last_result': 'correct',
                'review': {'step': 0, 'interval_seconds': interval,
                           'due_at': (self.now - timedelta(days=days_overdue)).isoformat()}}

    def choose(self, questions=None, progress=None, state=None, **kwargs):
        return reviews.choose(questions or self.questions, [progress or {}],
                              state if state is not None else {}, self.now, **kwargs)

    def test_four_new_then_due_review_even_if_review_is_well_prepared(self):
        progress = {'40': self.entry(days_overdue=1, streak=20)}
        state = {}
        selected = [self.choose(progress=progress, state=state) for _ in range(10)]
        self.assertEqual([q['selection_kind'] for q in selected],
                         ['new'] * 4 + ['review'] + ['new'] * 4 + ['review'])
        self.assertEqual([q['id'] for q in selected if q['selection_kind'] == 'review'], [40, 40])
        self.assertEqual(store.get_question_preparation(progress['40']), 'green')

    def test_skipping_covers_all_forty_before_repeating_without_assessments(self):
        selected = [self.client.get('/api/fields/test/question').json['id'] for _ in range(40)]
        self.assertEqual(len(set(selected)), 40)
        self.assertEqual(store.load_progress('test'), {})
        state_file = self.root / 'sets' / 'test' / 'selection.json'
        self.assertTrue(state_file.is_file())

    def test_last_three_excluded_even_if_only_due_review_is_recent(self):
        progress = {str(q['id']): self.entry(days_overdue=-1) for q in self.questions}
        progress['1'] = self.entry(days_overdue=10)
        state = {'recent': [1, 2, 3]}
        result = self.choose(progress=progress, state=state)
        self.assertTrue(result['practice_complete'])
        extra = self.choose(progress=progress, state=state, extra_practice=True)
        self.assertNotIn(extra['id'], [1, 2, 3])

    def test_small_pools_shorten_exclusion_and_single_question_stays_usable(self):
        state = {}
        ids = [self.choose(questions=self.questions[:2], state=state)['id'] for _ in range(12)]
        self.assertTrue(all(a != b for a, b in zip(ids, ids[1:])))
        state = {}
        ids = [self.choose(questions=self.questions[:3], state=state)['id'] for _ in range(12)]
        self.assertTrue(all(len(set(ids[i:i + 3])) == 3 for i in range(10)))
        for _ in range(3):
            self.assertEqual(self.choose(questions=self.questions[:1], state=state)['id'], 1)

    def test_reviews_rank_relative_overdue_time_not_streak_or_absolute_age(self):
        progress = {'1': self.entry(days_overdue=2, interval=30 * 86400, streak=0),
                    '2': self.entry(days_overdue=1, interval=86400, streak=12)}
        self.assertEqual(self.choose(questions=self.questions[:2], progress=progress)['id'], 2)

    def test_future_reviews_offer_extra_practice_without_changing_schedule(self):
        progress = {str(q['id']): self.entry(days_overdue=-1) for q in self.questions}
        store.save_progress('test', progress)
        response = self.client.get('/api/fields/test/question')
        self.assertTrue(response.json['practice_complete'])
        self.assertEqual(response.headers['Cache-Control'], 'no-store')
        self.assertIn('next_due', response.json)
        result = self.client.get('/api/fields/test/question?extra=1').json
        self.assertEqual(result['selection_kind'], 'extra')
        self.assertNotIn('answer', result)
        self.assertEqual(store.load_progress('test'), progress)

    def test_intervals_advance_only_after_due_success_and_cap_at_thirty_days(self):
        entry = {}
        now = self.now
        for days in (1, 3, 7, 14, 30, 30):
            review = reviews.next_schedule(entry, True, now)
            self.assertEqual(review['interval_seconds'], days * 86400)
            due = reviews.parse_time(review['due_at'])
            self.assertEqual(due, now + timedelta(days=days))
            entry['review'] = review
            self.assertEqual(reviews.next_schedule(entry, True, now + timedelta(minutes=1)), review)
            now = due

    def test_failure_resets_and_correct_relearning_returns_to_one_day(self):
        entry = self.entry(days_overdue=1)
        retry = reviews.next_schedule(entry, False, self.now)
        self.assertEqual(retry['step'], -1)
        self.assertEqual(reviews.parse_time(retry['due_at']), self.now + timedelta(minutes=10))
        entry['review'] = retry
        result = reviews.next_schedule(entry, True, self.now + timedelta(minutes=10))
        self.assertEqual(result['interval_seconds'], 86400)

    def test_legacy_history_uses_actual_review_times_and_preserves_missing_dates(self):
        history = [
            {'at': self.now.isoformat(), 'correct': True, 'score': 1},
            {'at': (self.now + timedelta(hours=1)).isoformat(), 'correct': True, 'score': 1},
            {'at': (self.now + timedelta(days=1)).isoformat(), 'correct': True, 'score': 1},
        ]
        entry = {'attempts': 3, 'correct': 3, 'streak': 3, 'history': history}
        before = json.dumps(entry)
        review = reviews.schedule(entry)
        self.assertEqual(review['interval_seconds'], 3 * 86400)
        self.assertEqual(reviews.parse_time(review['due_at']), self.now + timedelta(days=4))
        self.assertEqual(json.dumps(entry), before)
        self.assertEqual(reviews.schedule({'attempts': 4, 'streak': 2}), {})
        legacy = {'attempts': 2, 'streak': 2, 'last_result': 'correct',
                  'last_attempt': self.now.isoformat()}
        self.assertEqual(reviews.schedule(legacy)['interval_seconds'], 3 * 86400)

    def test_timezone_offsets_and_malformed_dates(self):
        self.assertEqual(reviews.parse_time('2026-10-25T03:30:00+01:00'),
                         datetime(2026, 10, 25, 2, 30, tzinfo=timezone.utc))
        for value in (None, 'not a date', '2026-10-25T03:30:00'):
            self.assertIsNone(reviews.parse_time(value))

    def test_assessment_retry_is_idempotent_including_review_schedule(self):
        with patch.object(store, 'datetime') as clock:
            clock.now.return_value = self.now
            first = store.record_attempt('test', 1, True, 1, attempt_id='same')
            clock.now.return_value = self.now + timedelta(days=10)
            second = store.record_attempt('test', 1, True, 1, attempt_id='same')
        self.assertEqual(second, first)
        self.assertEqual(second['attempts'], 1)

    def test_selection_is_profile_and_scope_local_and_survives_new_client(self):
        with patch.object(reviews.random, 'choice', side_effect=lambda pool: pool[0]):
            self.assertEqual(self.client.get('/api/fields/test/question').json['id'], 1)
            self.assertEqual(app.test_client().get('/api/fields/test/question').json['id'], 2)
            self.assertEqual(self.client.get('/api/fields/test/question?filter=Small').json['id'], 1)
            profile = profiles.create_profile('Other')['id']
            self.assertEqual(self.client.get('/api/fields/test/question', headers={
                'X-Trainer-Profile': profile}).json['id'], 1)
        self.assertTrue((self.root / 'profiles' / profile / 'test' / 'selection.json').is_file())

    def test_manual_question_jump_records_display_and_validates_scope(self):
        response = self.client.get('/api/fields/test/question?id=1')
        self.assertEqual(response.json['selection_kind'], 'manual')
        self.assertNotIn('answer', response.json)
        with patch.object(reviews.random, 'choice', side_effect=lambda pool: pool[0]):
            self.assertEqual(self.client.get('/api/fields/test/question').json['id'], 2)
        self.assertEqual(self.client.get('/api/fields/test/question?filter=Small&id=3').status_code, 400)
        self.assertEqual(self.client.get('/api/fields/test/question?id=bad').status_code, 400)
        self.assertEqual(store.load_progress('test'), {})

    def test_concurrent_selections_preserve_display_history(self):
        with ThreadPoolExecutor(max_workers=8) as executor:
            ids = list(executor.map(lambda _: store.get_next_question('test')['id'], range(40)))
        self.assertEqual(len(set(ids)), 40)

    def test_cooperative_selection_uses_either_participants_due_reviews(self):
        first = {str(q['id']): self.entry(days_overdue=-1) for q in self.questions}
        second = {str(q['id']): self.entry(days_overdue=-1) for q in self.questions}
        second['20'] = self.entry(days_overdue=1)
        selected = reviews.choose(self.questions, [first, second], {}, self.now)
        self.assertEqual(selected['id'], 20)
        del second['30']
        selected = reviews.choose(self.questions, [first, second], {}, self.now)
        self.assertEqual(selected['id'], 30)
