import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from app import app
import profiles
import question_store


class ProfileTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        subject = root / "sets" / "test"
        subject.mkdir(parents=True)
        (subject / "questions.json").write_text(json.dumps({"questions": [
            {"id": 1, "topic": "Topic", "question": "Q", "answer": "A"}
        ]}))
        (subject / "progress.json").write_text(json.dumps({"1": {"attempts": 3}}))
        for target, attribute, value in (
            (question_store, "FIELDS_PATH", root / "sets"),
            (profiles, "PROFILES_PATH", root / "profiles"),
        ):
            patcher = patch.object(target, attribute, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.client = app.test_client()

    def create(self, name):
        response = self.client.post('/api/profiles', json={"name": name})
        self.assertEqual(response.status_code, 201)
        return {"X-Trainer-Profile": response.get_json()["id"]}

    def test_profiles_isolate_learning_data_and_preserve_legacy(self):
        first = self.create("First")
        second = self.create("Second")
        url = '/api/fields/test/questions'
        self.assertEqual(self.client.get(url).get_json()[0]["progress"]["attempts"], 3)
        for headers in (first, second):
            self.assertEqual(self.client.get(url, headers=headers).get_json()[0]["progress"], {})
        self.client.post('/api/bookmark', headers=first, json={
            "field": "test", "id": 1, "bookmarked": True,
        })
        self.assertTrue(self.client.get(url, headers=first).get_json()[0]["bookmarked"])
        self.assertFalse(self.client.get(url, headers=second).get_json()[0]["bookmarked"])
        self.assertFalse(self.client.get(url).get_json()[0]["bookmarked"])

        # Storage operations used by grading and goals inherit only this request's profile.
        with app.test_request_context(headers=first):
            app.preprocess_request()
            question_store.record_attempt("test", 1, True, 1)
            question_store.save_goal("test", {"target_date": "2030-01-01"})
            self.assertTrue(question_store.load_goal("test"))
        with app.test_request_context(headers=second):
            app.preprocess_request()
            self.assertEqual(question_store.load_progress("test"), {})
            self.assertEqual(question_store.load_goal("test"), {})
        self.assertEqual(question_store.load_progress("test")["1"]["attempts"], 3)
        self.assertEqual(question_store.load_goal("test"), {})
        self.assertEqual(self.client.get(url, headers=first).get_json()[0]["progress"]["attempts"], 1)

    def test_validation_and_listing(self):
        for name in (None, "  ", "x" * 51, 42):
            self.assertEqual(self.client.post('/api/profiles', json={"name": name}).status_code, 400)
        self.create("  Learner  ")
        self.assertEqual([p["name"] for p in self.client.get('/api/profiles').get_json()],
                         ["Standard", "Learner"])
        for profile_id in ("../sets", "missing", "00000000-0000-0000-0000-000000000000"):
            self.assertEqual(self.client.get('/api/fields', headers={
                "X-Trainer-Profile": profile_id,
            }).status_code, 400)
        self.assertEqual(self.client.get('/api/fields').status_code, 200)
