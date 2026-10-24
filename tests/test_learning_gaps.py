import json
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Barrier
from unittest.mock import patch

import assessor
import learning_gaps
import profiles
import question_store as store
from app import app


class LearningMemoryTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        subject = self.root / 'test'
        subject.mkdir()
        self.questions = [dict(id=i, topic=f'Topic {i}', question=f'Question {i}', answer=f'Reference {i}')
                          for i in (1, 2)]
        (subject / 'questions.json').write_text(json.dumps({'questions': self.questions}))
        (subject / 'system-prompt.txt').write_text('Grade fairly')
        for target, key, value in ((store, 'FIELDS_PATH', self.root),
                                    (profiles, 'PROFILES_PATH', self.root / 'profiles'),
                                    (assessor, 'BACKEND', 'openai')):
            patcher = patch.object(target, key, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.client = app.test_client()
        self.url = '/api/fields/test/learning-gaps'

    def update(self, title='Concept A', status='gap', memory_id=None, related=None):
        return dict(memory_id=memory_id, title=title, status=status,
                    description='Concept A is confused with B; compare their mechanisms.',
                    related_topics=related or ['Concept B'], next_step='Explain the distinction using an example.')

    def grade(self, updates=None, correct=False, summary='Compare A and B before advancing.'):
        return dict(score=1 if correct else .2, result='correct' if correct else 'incorrect',
                    feedback='Semantic grading feedback', memory_updates=updates or [], memory_summary=summary)

    def submit(self, qid=1, updates=None, correct=False, headers=None, answer='My explanation'):
        with patch.object(assessor, '_call_backend', return_value=json.dumps(self.grade(updates, correct))) as model:
            response = self.client.post('/api/assess', headers=headers,
                                        json=dict(field='test', id=qid, answer=answer))
        self.assertEqual(response.status_code, 200, response.get_json())
        return response.get_json(), model

    def state(self):
        return store._load_json('test', 'learning-gaps.json')

    def preview(self, headers=None):
        return self.client.get(self.url, headers=headers).get_json()

    def analysis(self, snapshot, findings=None, summary='Combined strategy'):
        return dict(summary=summary, findings=findings or [], input_fingerprint=snapshot['fingerprint'])

    def analyze(self, snapshot, output):
        with patch.object(assessor, 'generate_analysis', return_value=json.dumps(output)) as model:
            response = self.client.post(self.url, json={'fingerprint': snapshot['fingerprint']})
        return response, model

    def test_each_answer_updates_global_file_with_no_second_model_request(self):
        result, model = self.submit(updates=[self.update()])
        model.assert_called_once()
        state = self.state()
        self.assertEqual(state['schema_version'], 3)
        self.assertNotIn('questions', state)
        self.assertEqual(state['findings'][0]['title'], 'Concept A')
        self.assertEqual(state['summary'], result['memory_summary'])
        self.assertEqual(len(state['processed_attempt_ids']), 1)
        event = store.load_progress('test')['1']['history'][0]
        self.assertNotIn('memory_pending', event)
        self.assertEqual(set(event['response']), {'student_answer', 'feedback'})
        self.assertNotIn('question', state['findings'][0])
        self.assertNotIn('reference_answer', state['findings'][0])

    def test_next_grading_receives_memory_and_deterministic_context(self):
        self.submit(updates=[self.update(status='understood')], correct=True)
        _, model = self.submit(qid=2, updates=[self.update(title='Concept B', related=['Concept A', 'Concept C'])])
        system, prompt = model.call_args.args
        self.assertIn('frühere Leistungen dürfen die Note nicht beeinflussen', system)
        context = json.loads(prompt.split('Lerngedächtnis und berechneter Fortschritt (nur Kontext):\n')[1])
        self.assertEqual(context['memories'][0]['title'], 'Concept A')
        self.assertEqual(context['deterministic']['subject']['total_attempts'], 1)
        self.assertEqual(context['question_progress']['attempted'], 0)
        self.assertEqual({m['title'] for m in self.state()['findings']}, {'Concept A', 'Concept B'})

    def test_old_understanding_for_current_question_is_retrieved_before_unrelated_recent_memories(self):
        self.submit(updates=[self.update(status='understood')], correct=True)
        state = self.state()
        for i in range(25):
            state['findings'].append({**state['findings'][0], 'memory_id': f'unrelated-{i}',
                                      'title': f'Unrelated {i}', 'evidence': [],
                                      'related_topics': [], 'updated_at': '2099-01-01T00:00:00+00:00'})
        store._save_json('test', 'learning-gaps.json', state)
        context = json.loads(learning_gaps.grading_context('test', 1))
        self.assertEqual(context['memories'][0]['title'], 'Concept A')

    def test_cross_question_regression_and_connections_update_one_memory(self):
        self.submit(updates=[self.update(status='understood')], correct=True)
        memory_id = self.state()['findings'][0]['memory_id']
        self.submit(qid=2, updates=[self.update(status='regressed', memory_id=memory_id,
                                               related=['Concept B', 'Concept C'])])
        state = self.state()
        self.assertEqual(len(state['findings']), 1)
        memory = state['findings'][0]
        self.assertEqual(memory['status'], 'regressed')
        self.assertEqual(memory['memory_id'], memory_id)
        self.assertEqual(memory['related_topics'], ['Concept B', 'Concept C'])
        self.assertIsNotNone(memory['last_understood_at'])
        self.assertIsNotNone(memory['last_regression_at'])
        ids = {r['attempt_id'] for r in memory['evidence']}
        self.assertEqual(ids, set(state['processed_attempt_ids']))
        evidence = self.preview()['report']['attempts']
        self.assertEqual({a['question_id'] for a in evidence}, {1, 2})

    def test_partial_answer_can_show_understanding_of_one_concept_and_gap_in_another(self):
        self.submit(updates=[self.update(status='understood'), self.update(title='Concept B', status='gap')])
        self.assertEqual({m['status'] for m in self.state()['findings']}, {'understood', 'gap'})

    def test_profile_isolation_applies_to_file_and_grading_context(self):
        profile = profiles.create_profile('Other')
        headers = {'X-Trainer-Profile': profile['id']}
        self.submit(updates=[self.update(title='Private concept')], headers=headers)
        self.assertIsNone(self.preview()['report'])
        self.assertEqual(self.preview(headers)['report']['findings'][0]['title'], 'Private concept')
        _, model = self.submit(qid=2)
        self.assertNotIn('Private concept', model.call_args.args[1])

    def test_reveal_and_failed_or_malformed_grades_do_not_create_memories(self):
        self.client.post('/api/reveal-answer', json=dict(field='test', id=1))
        for raw in ('invalid', json.dumps({**self.grade(), 'memory_updates': [dict(title='Incomplete')]})):
            with patch.object(assessor, '_call_backend', return_value=raw):
                response = self.client.post('/api/assess', json=dict(field='test', id=1, answer='A'))
            self.assertEqual(response.status_code, 502)
        self.assertEqual(store.load_progress('test'), {})
        self.assertEqual(self.state(), {})

    def test_legacy_grade_without_memory_fields_still_records_bound_feedback(self):
        raw = dict(score=.5, result='partially_correct', feedback='Distinguish A and B.')
        with patch.object(assessor, '_call_backend', return_value=json.dumps(raw)):
            response = self.client.post('/api/assess', json=dict(field='test', id=1, answer='A'))
        self.assertEqual(response.status_code, 200)
        memory = self.state()['findings'][0]
        self.assertEqual(memory['description'], raw['feedback'])
        self.assertEqual(memory['status'], 'tentative')

    def test_pending_update_recovers_without_regrading_after_memory_write_failure(self):
        original = store._save_json
        def fail_memory(field, filename, data):
            if filename == 'learning-gaps.json':
                raise OSError('Simulated interrupted memory write')
            return original(field, filename, data)
        with patch.object(store, '_save_json', side_effect=fail_memory):
            result, model = self.submit(updates=[self.update()])
        self.assertEqual(result['progress']['attempts'], 1)
        model.assert_called_once()
        self.assertIn('memory_pending', store.load_progress('test')['1']['history'][0])
        self.assertEqual(self.state(), {})
        with patch.object(assessor, '_call_backend') as model:
            snapshot = self.preview()
            model.assert_not_called()
        self.assertEqual(len(snapshot['report']['findings']), 1)
        self.assertNotIn('memory_pending', store.load_progress('test')['1']['history'][0])

    def test_recovery_after_memory_commit_before_outbox_cleanup_is_idempotent(self):
        original = store.save_progress
        calls = 0
        def fail_cleanup(field, progress):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise OSError('Interrupted cleanup')
            return original(field, progress)
        with patch.object(store, 'save_progress', side_effect=fail_cleanup):
            self.submit(updates=[self.update()])
        self.assertIn('memory_pending', store.load_progress('test')['1']['history'][0])
        self.assertEqual(len(self.state()['findings'][0]['evidence']), 1)
        self.preview()
        self.assertEqual(len(self.state()['findings'][0]['evidence']), 1)
        self.assertEqual(len(self.state()['processed_attempt_ids']), 1)
        self.assertNotIn('memory_pending', store.load_progress('test')['1']['history'][0])

    def test_room_retry_does_not_duplicate_attempt_or_memory(self):
        for _ in range(2):
            store.record_attempt('test', 1, False, .2, attempt_id='room:one',
                                 response=dict(student_answer='A', feedback='Confusion'),
                                 memory_updates=[self.update()])
        self.assertEqual(store.load_progress('test')['1']['attempts'], 1)
        self.assertEqual(len(self.state()['findings'][0]['evidence']), 1)

    def test_shared_evidence_stays_tentative_and_separate_from_private_understanding(self):
        self.submit(updates=[self.update(status='understood')], correct=True)
        store.record_attempt('test', 2, False, .2, attempt_id='shared-answer', source={'mode': 'coop'},
                             response=dict(student_answer='A', feedback='Shared confusion'),
                             memory_updates=[self.update(status='regressed')])
        memories = self.state()['findings']
        self.assertEqual({(m['scope'], m['status']) for m in memories},
                         {('individual', 'understood'), ('shared', 'tentative')})
        context = json.loads(learning_gaps.grading_context('test', 2, shared=True))
        self.assertEqual(context['mode'], 'shared')
        self.assertNotIn('memories', context)
        self.assertNotIn('deterministic', context)

    def test_concurrent_answers_merge_memory_without_lost_evidence(self):
        barrier = Barrier(2)
        def generate(*args):
            barrier.wait(timeout=5)
            return json.dumps(self.grade([self.update()]))
        def submit(qid):
            with app.test_client() as client:
                return client.post('/api/assess', json=dict(field='test', id=qid, answer='A')).status_code
        with patch.object(assessor, '_call_backend', side_effect=generate) as model:
            with ThreadPoolExecutor(max_workers=2) as executor:
                self.assertEqual(list(executor.map(submit, (1, 2))), [200, 200])
            self.assertEqual(model.call_count, 2)
        self.assertEqual(len(self.state()['findings']), 1)
        self.assertEqual(len(self.state()['findings'][0]['evidence']), 2)
        self.assertEqual(len(self.state()['processed_attempt_ids']), 2)

    def test_on_demand_prompt_combines_global_memory_original_evidence_and_computed_facts(self):
        self.submit(updates=[self.update(status='understood')], correct=True)
        self.submit(qid=2, updates=[self.update(title='Concept B')])
        snapshot = self.preview()
        payload = json.loads(snapshot['prompt'].split('Belegdaten (chronologisch):\n')[1]
                             .split('\n\ninput_fingerprint:')[0])
        self.assertEqual(payload['deterministic']['subject']['total_attempts'], 2)
        self.assertEqual(len(payload['memories']), 2)
        self.assertTrue(all(a['already_reviewed'] for a in payload['attempts']))
        before = store.load_progress('test')
        response, model = self.analyze(snapshot, self.analysis(snapshot))
        self.assertEqual(response.status_code, 200)
        model.assert_called_once_with(learning_gaps.SYSTEM_PROMPT, snapshot['prompt'])
        self.assertEqual(store.load_progress('test'), before)
        self.assertEqual(len(response.get_json()['findings']), 2)
        self.assertNotIn('attempts', self.state())
        self.assertNotIn('deterministic', self.state())

    def test_analysis_can_refine_relationships_without_recounting_evidence(self):
        self.submit(updates=[self.update(status='understood')], correct=True)
        snapshot = self.preview()
        memory = snapshot['report']['findings'][0]
        finding = {**memory, 'related_topics': ['Concept B', 'Concept C'],
                   'description': 'A is understood; distinguish its relationship to C.',
                   'status': 'resolved'}
        response, _ = self.analyze(snapshot, self.analysis(snapshot, [finding]))
        self.assertEqual(response.status_code, 200, response.get_json())
        updated = response.get_json()['findings'][0]
        self.assertEqual(updated['status'], 'understood')
        self.assertEqual(updated['related_topics'], ['Concept B', 'Concept C'])
        self.assertEqual(len(updated['evidence']), 1)

    def test_external_import_uses_same_validated_memory_flow_without_backend_call(self):
        self.submit(updates=[self.update()])
        snapshot = self.preview()
        output = self.analysis(snapshot)
        with patch.object(assessor, 'generate_analysis') as model:
            response = self.client.post(self.url, json=dict(fingerprint=snapshot['fingerprint'], result=json.dumps(output)))
            self.assertEqual(response.status_code, 200)
            model.assert_not_called()
        self.assertEqual(self.state()['backend'], 'external')
        self.assertEqual(len(self.state()['findings']), 1)
        self.submit(qid=2)
        stale = self.client.post(self.url, json=dict(fingerprint=snapshot['fingerprint'], result=json.dumps(output)))
        self.assertEqual(stale.status_code, 400)

    def test_invented_citations_and_failed_analysis_preserve_automatic_memory(self):
        self.submit(updates=[self.update()])
        snapshot = self.preview()
        original = self.state()
        finding = {**snapshot['report']['findings'][0], 'evidence': [{'attempt_id': 'invented', 'quote': ''}]}
        response, _ = self.analyze(snapshot, self.analysis(snapshot, [finding]))
        self.assertEqual(response.status_code, 502)
        self.assertEqual(self.state(), original)
        with patch.object(assessor, 'generate_analysis', side_effect=RuntimeError('Unavailable')):
            response = self.client.post(self.url, json={'fingerprint': snapshot['fingerprint']})
        self.assertEqual(response.status_code, 502)
        self.assertEqual(self.state(), original)

    def test_old_question_owned_format_is_read_and_migrated_to_cross_question_memory(self):
        self.submit(updates=[self.update()])
        self.submit(qid=2, updates=[self.update()])
        state = self.state()
        refs = state['findings'][0]['evidence']
        legacy = {'schema_version': 2, 'questions': {
            str(qid): {'findings': [{**state['findings'][0], 'memory_id': f'old-{qid}', 'evidence': [ref]}],
                       'reviewed_attempt_ids': [ref['attempt_id']]}
            for qid, ref in zip((1, 2), refs)
        }}
        store._save_json('test', 'learning-gaps.json', legacy)
        snapshot = self.preview()
        self.assertEqual(len(snapshot['report']['findings']), 1)
        self.assertEqual(len(snapshot['report']['findings'][0]['evidence']), 2)
        self.assertIn('questions', self.state())
        self.submit(updates=[self.update()])
        self.assertNotIn('questions', self.state())
        self.assertEqual(self.state()['schema_version'], 3)
        self.assertEqual(len(self.state()['findings'][0]['evidence']), 3)

    def test_bank_edits_use_current_reference_without_storing_duplicate_question_text(self):
        self.submit()
        self.questions[0]['answer'] = 'Edited reference'
        (self.root / 'test' / 'questions.json').write_text(json.dumps({'questions': self.questions}))
        self.assertEqual(self.preview()['attempts'][0]['reference_answer'], 'Edited reference')
        response = store.load_progress('test')['1']['history'][0]['response']
        self.assertEqual(set(response), {'student_answer', 'feedback'})

    def test_invalid_fingerprints_and_empty_history_never_call_analysis_model(self):
        with patch.object(assessor, 'generate_analysis') as model:
            for value in (None, [], {}, True, 'invalid'):
                response = self.client.post(self.url, json={'fingerprint': value})
                self.assertEqual(response.status_code, 400)
            snapshot = self.preview()
            response = self.client.post(self.url, json={'fingerprint': snapshot['fingerprint']})
            self.assertEqual(response.status_code, 400)
            model.assert_not_called()

    def test_stale_model_result_does_not_overwrite_newer_automatic_memory(self):
        self.submit(updates=[self.update()])
        snapshot = self.preview()
        def generate(*args):
            self.submit(qid=2, updates=[self.update(title='Concept B')])
            return json.dumps(self.analysis(snapshot, summary='Stale strategy'))
        with patch.object(assessor, 'generate_analysis', side_effect=generate):
            response = self.client.post(self.url, json={'fingerprint': snapshot['fingerprint']})
        self.assertEqual(response.status_code, 400)
        self.assertEqual({m['title'] for m in self.state()['findings']}, {'Concept A', 'Concept B'})
        self.assertNotEqual(self.state()['summary'], 'Stale strategy')

    def test_recent_window_is_bounded_and_original_evidence_remains_resolvable(self):
        self.submit(updates=[self.update()])
        original_id = self.state()['processed_attempt_ids'][0]
        for i in range(21):
            self.submit(qid=2, answer=f'Answer {i}')
        snapshot = self.preview()
        self.assertEqual(len(snapshot['attempts']), 20)
        self.assertEqual(snapshot['available'], 22)
        self.assertIn(original_id, {a['attempt_id'] for a in snapshot['evidence_attempts']})
        self.assertIn(original_id, {a['attempt_id'] for a in snapshot['report']['attempts']})


if __name__ == '__main__':
    unittest.main()
