import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import assessor
import learning_gaps
import profiles
import question_store as store
from app import app


class LearningGapTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        root = Path(temp.name)
        (root / "test").mkdir()
        self.questions = [{"id": i, "topic": "Lernen", "question": f"Frage {i}",
                           "answer": "Das Schema wird verändert."} for i in (1, 2)]
        (root / "test" / "questions.json").write_text(json.dumps({"questions": self.questions}))
        (root / "test" / "system-prompt.txt").write_text("Grade")
        for target, attribute, value in ((store, "FIELDS_PATH", root),
                                          (profiles, "PROFILES_PATH", root / "profiles")):
            p = patch.object(target, attribute, value)
            p.start()
            self.addCleanup(p.stop)
        self.client = app.test_client()
        self.url = "/api/fields/test/learning-gaps"
        self.grade = assessor.Assessment(False, False, "incorrect", 0, .2, "Begriffe verwechselt")

    def submit(self, question_id=1, answer="Assimilation verändert das Schema.", headers=None):
        with patch.object(assessor, "assess", return_value=self.grade):
            response = self.client.post("/api/assess", json={
                "field": "test", "id": question_id, "answer": answer,
            }, headers=headers)
        self.assertEqual(response.status_code, 200)
        return response.get_json()

    def preview(self, headers=None):
        return self.client.get(self.url, headers=headers).get_json()

    def output(self, snapshot, status="tentative", quote="Schema"):
        return {"summary": "Begrenzte Hinweise.", "findings": [{
            "title": "Assimilation", "description": "Begriffe verwechselt.",
            "status": status, "next_step": "Unterschied erklären.",
            "evidence": [{"attempt_id": a["attempt_id"], "quote": quote}
                         for a in snapshot["attempts"]],
        }]}

    def analyze(self, snapshot, output, headers=None):
        with patch.object(assessor, "generate_analysis", return_value=json.dumps(output)) as model:
            response = self.client.post(self.url, json={"fingerprint": snapshot["fingerprint"]}, headers=headers)
        return response, model

    def test_answers_store_only_attempt_text_and_resolve_current_question_bank(self):
        self.submit()
        snapshot = self.preview()
        self.assertEqual(len(snapshot["attempts"]), 1)
        attempt = snapshot["attempts"][0]
        self.assertEqual(attempt["student_answer"], "Assimilation verändert das Schema.")
        self.assertEqual(attempt["reference_answer"], self.questions[0]["answer"])
        self.assertEqual(attempt["evidence_type"], "individual")
        self.assertIn(attempt["student_answer"], snapshot["prompt"])
        self.assertIsNone(snapshot["report"])
        bank = store.field_path("test") / "questions.json"
        response = store.load_progress("test")["1"]["history"][0]["response"]
        self.assertEqual(set(response), {"student_answer", "feedback"})
        self.questions[0]["question"] = "Neue Frage"
        self.questions[0]["answer"] = "Neue Referenz"
        bank.write_text(json.dumps({"questions": self.questions}))
        changed = self.preview()
        self.assertEqual(changed["attempts"][0]["question"], "Neue Frage")
        self.assertEqual(changed["attempts"][0]["reference_answer"], "Neue Referenz")
        self.assertNotEqual(changed["fingerprint"], snapshot["fingerprint"])
        bank.write_text(json.dumps({"questions": []}))
        self.assertEqual(self.preview()["attempts"], [])
        self.assertEqual(self.preview()["missing_count"], 1)

    def test_legacy_reveal_and_failed_grading_create_no_evidence(self):
        store.record_attempt("test", 1, True, 1)
        self.client.post("/api/reveal-answer", json={"field": "test", "id": 1})
        with patch.object(assessor, "assess", side_effect=assessor.AssessmentError("Unavailable")):
            self.client.post("/api/assess", json={"field": "test", "id": 1, "answer": "A"})
        snapshot = self.preview()
        self.assertEqual(snapshot["legacy_count"], 1)
        self.assertEqual(snapshot["attempts"], [])
        response, model = self.analyze(snapshot, {})
        self.assertEqual(response.status_code, 400)
        model.assert_not_called()

    def test_valid_report_persists_without_altering_progress_and_uses_exported_prompt(self):
        self.submit()
        snapshot = self.preview()
        before = store.load_progress("test")
        response, model = self.analyze(snapshot, self.output(snapshot))
        self.assertEqual(response.status_code, 200)
        model.assert_called_once_with(learning_gaps.SYSTEM_PROMPT, snapshot["prompt"])
        self.assertEqual(self.preview()["report"], response.get_json())
        self.assertEqual(store.load_progress("test"), before)
        saved = store._load_json("test", "learning-gaps.json")
        self.assertNotIn("attempts", saved)
        self.assertEqual(saved["attempt_ids"], [snapshot["attempts"][0]["attempt_id"]])
        # Report evidence remains resolvable after it leaves the recent window.
        with patch.object(learning_gaps, "MAX_ATTEMPTS", 0):
            self.assertEqual(self.preview()["report"]["attempts"], snapshot["attempts"])

    def test_profile_isolation_includes_prompt_and_saved_report(self):
        profile = profiles.create_profile("Learner")
        headers = {"X-Trainer-Profile": profile["id"]}
        self.submit(headers=headers)
        snapshot = self.preview(headers)
        response, _ = self.analyze(snapshot, self.output(snapshot), headers)
        self.assertEqual(response.status_code, 200)
        self.assertIsNotNone(self.preview(headers)["report"])
        self.assertEqual(self.preview()["attempts"], [])
        self.assertIsNone(self.preview()["report"])

    def test_old_duplicated_formats_remain_readable_and_compact_on_next_write(self):
        self.submit()
        snapshot = self.preview()
        old_attempt = snapshot["attempts"][0]
        path = store.field_path("test") / "progress.json"
        progress = store.load_progress("test")
        progress["1"]["history"][0]["response"].update({
            "question_id": 1, "topic": "Old topic", "question": "Old question",
            "reference_answer": "Old reference",
        })
        path.write_text(json.dumps(progress))
        self.assertEqual(self.preview()["attempts"], snapshot["attempts"])
        old_report = {**self.output(snapshot), "created_at": old_attempt["at"],
                      "fingerprint": snapshot["fingerprint"], "attempts": [old_attempt]}
        store._save_json("test", "learning-gaps.json", old_report)
        self.assertEqual(self.preview()["report"]["attempt_ids"], [old_attempt["attempt_id"]])
        self.submit(question_id=2)
        response = store.load_progress("test")["1"]["history"][0]["response"]
        self.assertEqual(set(response), {"student_answer", "feedback"})
        # Removing a question cannot crash an older saved report.
        (store.field_path("test") / "questions.json").write_text(json.dumps({"questions": []}))
        report = self.preview()["report"]
        self.assertEqual(report["attempts"], [])
        self.assertEqual(report["attempt_ids"], [old_attempt["attempt_id"]])

    def test_stale_preview_and_invalid_evidence_do_not_replace_report(self):
        self.submit()
        snapshot = self.preview()
        report, _ = self.analyze(snapshot, self.output(snapshot))
        for change in ("quote", "id", "status", "json"):
            output = self.output(snapshot)
            if change == "quote": output["findings"][0]["evidence"][0]["quote"] = "invented"
            if change == "id": output["findings"][0]["evidence"][0]["attempt_id"] = "unknown"
            if change == "status": output["findings"][0]["status"] = "recurring"
            if change == "json": output = []
            response, _ = self.analyze(snapshot, output)
            self.assertEqual(response.status_code, 502)
            self.assertEqual(self.preview()["report"], report.get_json())
        self.submit(question_id=2)
        response, model = self.analyze(snapshot, self.output(snapshot))
        self.assertEqual(response.status_code, 400)
        model.assert_not_called()

    def test_recurring_needs_distinct_questions_and_individual_answers(self):
        self.submit()
        self.submit()
        snapshot = self.preview()
        response, _ = self.analyze(snapshot, self.output(snapshot, "recurring"))
        self.assertEqual(response.status_code, 502)
        self.submit(question_id=2)
        snapshot = self.preview()
        response, _ = self.analyze(snapshot, self.output(snapshot, "recurring"))
        self.assertEqual(response.status_code, 200)
        store.record_attempt("test", 2, False, .2, attempt_id="shared", source={"mode": "coop"},
                             response=learning_gaps.answer_record("Schema", vars(self.grade)))
        # A recovery retry must not duplicate either progress or original answers.
        store.record_attempt("test", 2, False, .2, attempt_id="shared", source={"mode": "coop"},
                             response=learning_gaps.answer_record("Schema", vars(self.grade)))
        snapshot = self.preview()
        self.assertEqual(len(snapshot["attempts"]), 4)
        self.assertEqual(sum(a["evidence_type"] == "shared" for a in snapshot["attempts"]), 1)
        response, _ = self.analyze(snapshot, self.output(snapshot, "recurring"))
        self.assertEqual(response.status_code, 502)

    def test_recent_window_is_bounded_without_truncating_answer_text(self):
        for i in range(23):
            self.submit(answer=f"Antwort {i}")
        snapshot = self.preview()
        self.assertEqual(snapshot["available"], 23)
        self.assertEqual(len(snapshot["attempts"]), 20)
        self.assertEqual(snapshot["attempts"][0]["student_answer"], "Antwort 3")
        self.submit(answer="x" * 3000)
        with patch.object(learning_gaps, "MAX_DATA_CHARS", 500):
            snapshot = self.preview()
        self.assertEqual(snapshot["attempts"], [])

    def test_empty_findings_and_backend_failure(self):
        self.submit()
        snapshot = self.preview()
        response, _ = self.analyze(snapshot, {"summary": "Keine ausreichenden Belege", "findings": []})
        self.assertEqual(response.status_code, 200)
        with patch.object(assessor, "generate_analysis", side_effect=RuntimeError("failed")):
            response = self.client.post(self.url, json={"fingerprint": snapshot["fingerprint"]})
        self.assertEqual(response.status_code, 502)
        self.assertEqual(self.preview()["report"]["findings"], [])


if __name__ == "__main__":
    unittest.main()
