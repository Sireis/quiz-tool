import json
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

import assessor
import learning_goals
import question_store
from app import app


class LearningGoalTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        for field in ("first", "second"):
            path = self.root / field
            path.mkdir()
            (path / "questions.json").write_text(json.dumps({"questions": [
                {"id": qid, "topic": "Topic", "question": f"Q{qid}", "answer": "A"}
                for qid in range(1, 5)
            ]}))
            (path / "system-prompt.txt").write_text("Grade fairly")
        storage = patch.object(question_store, "FIELDS_PATH", self.root)
        storage.start()
        self.addCleanup(storage.stop)
        self.now = datetime(2026, 10, 12, 12, tzinfo=timezone.utc)
        clock = patch.object(learning_goals, "_now", return_value=self.now)
        clock.start()
        self.addCleanup(clock.stop)
        self.client = app.test_client()

    def save(self, **kwargs):
        return self.client.put("/api/fields/first/goal", json={
            "target_date": "2026-10-15", "strategy": "steady", **kwargs,
        })

    def progress(self, data):
        (self.root / "first" / "progress.json").write_text(json.dumps(data))

    def test_save_edit_delete_and_subject_isolation(self):
        self.assertIsNone(self.client.get("/api/fields/first/goal").json["goal"])
        self.assertEqual(self.save().status_code, 200)
        self.assertEqual(json.loads((self.root / "first" / "goal.json").read_text()), {
            "target_date": "2026-10-15", "strategy": "steady", "start_date": "2026-10-12",
        })
        self.assertIsNone(self.client.get("/api/fields/second/goal").json["goal"])
        self.assertEqual(self.save(strategy="frontloaded").json["goal"]["daily_target"], 4)
        self.client.delete("/api/fields/first/goal")
        self.assertIsNone(self.client.get("/api/fields/first/goal").json["goal"])
        self.assertFalse((self.root / "first" / "progress.json").exists())
        self.assertFalse((self.root / "first" / "bookmarks.json").exists())

    def test_validation_preserves_saved_goal(self):
        self.save()
        for invalid in (
            {"target_date": "2026-02-30"}, {"target_date": "2026-10-11"},
            {"target_date": "20261115"}, {"target_date": None},
            {"strategy": True}, {"strategy": None}, {"strategy": "unknown"}, {"strategy": []},
        ):
            with self.subTest(invalid=invalid):
                self.assertEqual(self.save(**invalid).status_code, 400)
        self.assertEqual(self.client.get("/api/fields/first/goal").json["goal"]["daily_target"], 2)
        self.assertEqual(self.client.put("/api/fields/first/goal", json=[]).status_code, 400)
        self.assertEqual(self.client.get("/api/fields/../goal").status_code, 400)

    def test_preparation_deadlines_and_repeated_answers_count(self):
        self.progress({
            "1": {"attempts": 4, "correct": 3, "last_result": "incorrect", "history": [
                {"at": "2026-10-12T09:00:00+00:00"}, {"at": "2026-10-12T10:00:00+00:00"}]},
            "2": {"attempts": 2, "correct": 2, "last_result": "correct", "history": [
                {"at": "2026-10-11T20:00:00+00:00"}]},
            "3": {"attempts": 10, "correct": 10, "last_result": "correct"},
        })
        goal = self.save(target_date="2026-10-12").json["goal"]
        self.assertEqual(goal["prepared"], 2)
        self.assertEqual(goal["preparation_percent"], 50)
        self.assertEqual(goal["today_count"], 2)
        self.assertTrue(goal["daily_complete"])
        self.assertEqual(goal["days_remaining"], 0)
        with patch.object(learning_goals, "_now", return_value=datetime(2026, 10, 14, tzinfo=timezone.utc)):
            goal = learning_goals.get_goal("first")["goal"]
            self.assertEqual(goal["days_remaining"], -2)
            self.assertEqual(goal["today_count"], 0)

    def test_local_day_boundary_and_timezone_validation(self):
        # 22:30 UTC on the 11th is 00:30 on the 12th in Berlin.
        self.progress({"1": {"history": [{"at": "2026-10-11T22:30:00+00:00"}]}})
        self.save()
        with patch.object(learning_goals, "_now", wraps=lambda name: self.now.astimezone(
                learning_goals.ZoneInfo(name))):
            self.assertEqual(learning_goals.get_goal("first", "Europe/Berlin")["goal"]["today_count"], 1)
            self.assertEqual(learning_goals.get_goal("first", "UTC")["goal"]["today_count"], 0)
        # Exercise the actual timezone validation rather than the fixed test clock.
        with patch.object(learning_goals, "_now", new=type(self)._real_now):
            self.assertEqual(self.client.get("/api/fields/first/goal?timezone=Unknown/Zone").status_code, 400)

    _real_now = staticmethod(learning_goals._now)

    def test_normal_practice_remains_available_after_goal_completion(self):
        self.save(target_date="2026-10-19")
        with patch.object(question_store, "datetime") as clock:
            clock.now.return_value = self.now
            question_store.record_attempt("first", 1, True, 1)
        self.assertTrue(learning_goals.get_goal("first")["goal"]["daily_complete"])
        for query in ({}, {"topic": "Topic"}):
            response = self.client.get("/api/fields/first/question", query_string=query)
            self.assertEqual(response.status_code, 200)
            self.assertNotIn("answer", response.json)
        self.assertEqual(self.client.get("/api/fields/first/goal/question").status_code, 404)

    def test_assessment_updates_goal_but_reveal_does_not(self):
        self.assertEqual(self.client.get("/api/fields/first/question").status_code, 200)
        self.save(target_date="2026-10-19")
        self.client.post("/api/reveal-answer", json={"field": "first", "id": 1})
        self.assertEqual(learning_goals.get_goal("first")["goal"]["today_count"], 0)
        assessment = assessor.Assessment(
            is_sks=False, correct=True, result="correct", sks_punkte=0, score=1, feedback="Try again",
        )
        with patch.object(assessor, "assess", return_value=assessment), \
                patch.object(question_store, "datetime") as clock:
            clock.now.return_value = self.now
            self.client.post("/api/assess", json={"field": "first", "id": 1, "answer": "A"})
        goal = learning_goals.get_goal("first")["goal"]
        self.assertTrue(goal["daily_complete"])
        self.assertEqual(goal["prepared"], 0)
        self.assertEqual(self.client.get("/api/fields/first/question").status_code, 200)

    def test_goal_survives_bank_shrinking(self):
        self.save()
        bank = question_store.load_questions("first")
        bank["questions"] = bank["questions"][:1]
        (self.root / "first" / "questions.json").write_text(json.dumps(bank))
        self.assertEqual(learning_goals.get_goal("first")["goal"]["daily_target"], 1)

    def test_strategy_schedules_reach_green_by_target_date(self):
        bank = question_store.load_questions("first")
        bank["questions"].append({"id": 5, "topic": "Topic", "question": "Q5", "answer": "A"})
        (self.root / "first" / "questions.json").write_text(json.dumps(bank))
        for strategy, expected in (
            ("steady", [3, 3, 2, 2]),
            ("increasing", [1, 2, 3, 4]),
            ("frontloaded", [4, 3, 2, 1]),
        ):
            with self.subTest(strategy=strategy):
                self.progress({})
                self.save(strategy=strategy)
                actual = []
                for day in range(12, 16):
                    now = datetime(2026, 10, day, 12, tzinfo=timezone.utc)
                    with patch.object(learning_goals, "_now", return_value=now), \
                            patch.object(question_store, "datetime") as clock:
                        clock.now.return_value = now
                        actual.append(learning_goals.get_goal("first")["goal"]["daily_target"])
                        for _ in range(actual[-1]):
                            question = question_store.get_next_question("first")
                            question_store.record_attempt("first", question["id"], True, 1)
                        self.assertTrue(learning_goals.get_goal("first")["goal"]["daily_complete"])
                self.assertEqual(actual, expected)
                self.assertTrue(learning_goals.get_goal("first")["goal"]["complete"])

    def test_wrong_answers_and_missed_days_recalculate_workload(self):
        self.assertEqual(self.save().json["goal"]["daily_target"], 2)
        with patch.object(question_store, "datetime") as clock:
            clock.now.return_value = self.now
            question_store.record_attempt("first", 1, False, 0)
        goal = learning_goals.get_goal("first")["goal"]
        self.assertEqual(goal["daily_target"], 2)
        self.assertEqual(goal["remaining_work"], 8)
        self.assertEqual(goal["daily_remaining"], 1)
        with patch.object(learning_goals, "_now", return_value=datetime(2026, 10, 14, tzinfo=timezone.utc)):
            self.assertEqual(learning_goals.get_goal("first")["goal"]["daily_target"], 4)

    def test_preview_is_read_only_and_original_goal_dates_are_preserved(self):
        question_store.save_goal("first", {"target_date": "2026-10-15", "daily_target": 100})
        self.assertEqual(learning_goals.get_goal("first")["goal"]["strategy"], "steady")
        self.assertEqual(learning_goals.get_goal("first")["goal"]["daily_target"], 2)
        response = self.client.get("/api/fields/first/goal/preview", query_string={
            "target_date": "2026-10-15", "strategy": "frontloaded",
        })
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json["daily_target"], 4)
        self.assertEqual(response.json["remaining_work"], 8)
        self.assertEqual(question_store.load_goal("first"), {"target_date": "2026-10-15", "daily_target": 100})
        self.assertFalse((self.root / "first" / "progress.json").exists())

    def test_already_prepared_questions_need_no_goal_practice(self):
        self.progress({str(qid): {"attempts": 2, "correct": 2, "last_result": "correct"}
                       for qid in range(1, 5)})
        goal = self.save().json["goal"]
        self.assertEqual(goal["remaining_work"], 0)
        self.assertEqual(goal["daily_target"], 0)
        self.assertTrue(goal["complete"])
        self.assertEqual(self.client.get("/api/fields/first/question").status_code, 200)

    def test_overachievement_keeps_daily_target_and_survives_completion(self):
        self.save()
        with patch.object(question_store, "datetime") as clock:
            clock.now.return_value = self.now
            for qid in (1, 1, 2, 2, 3, 3, 4, 4):
                question_store.record_attempt("first", qid, True, 1)
                self.assertEqual(learning_goals.get_goal("first")["goal"]["daily_target"], 2)
        goal = learning_goals.get_goal("first")["goal"]
        self.assertEqual(goal["daily_percent"], 400)
        self.assertEqual(goal["overachievement"], 6)
        self.assertEqual(goal["daily_remaining"], 0)
        self.assertTrue(goal["complete"])
        self.assertEqual(goal["preparation_counts"], {"red": 0, "yellow": 0, "green": 4})
        tomorrow = datetime(2026, 10, 13, 12, tzinfo=timezone.utc)
        with patch.object(learning_goals, "_now", return_value=tomorrow), \
                patch.object(question_store, "datetime") as clock:
            clock.now.return_value = tomorrow
            question_store.record_attempt("first", 1, True, 1)
            goal = learning_goals.get_goal("first")["goal"]
            self.assertEqual(goal["daily_target"], 0)
            self.assertEqual(goal["overachievement"], 1)
            self.assertIsNone(goal["daily_percent"])

    def test_legacy_last_failure_is_preserved_for_daily_baseline(self):
        self.progress({str(qid): {"attempts": 3, "correct": 2,
                                 "last_result": "incorrect" if qid == 1 else "correct"}
                       for qid in range(1, 5)})
        self.assertEqual(self.save().json["goal"]["daily_target"], 1)
        with patch.object(question_store, "datetime") as clock:
            clock.now.return_value = self.now
            question_store.record_attempt("first", 1, True, 1)
        goal = learning_goals.get_goal("first")["goal"]
        self.assertEqual(goal["daily_target"], 1)
        self.assertTrue(goal["complete"])


if __name__ == "__main__":
    unittest.main()
