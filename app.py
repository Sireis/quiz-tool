"""
app.py
Flask entry point. Routes call into question_store and assessor.
"""

import os
from dataclasses import asdict

from flask import Flask, abort, g, jsonify, render_template, request, send_from_directory
from werkzeug.exceptions import HTTPException

import assessor
import learning_goals
import question_store
import profiles

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 64 * 1024


@app.before_request
def select_profile():
    profile_id = request.headers.get("X-Trainer-Profile", "default")
    if profile_id != "default":
        profiles.profile_path(profile_id)
    g.profile_token = question_store.active_profile.set(profile_id)


@app.teardown_request
def reset_profile(error):
    token = g.pop("profile_token", None)
    if token is not None:
        question_store.active_profile.reset(token)


@app.get("/api/profiles")
def api_profiles():
    return jsonify(profiles.list_profiles())


@app.post("/api/profiles")
def api_create_profile():
    return jsonify(profiles.create_profile(_request_body().get("name"))), 201


@app.errorhandler(ValueError)
def invalid_request(error):
    return jsonify({"error": str(error)}), 400


@app.errorhandler(assessor.AssessmentError)
def grading_failed(error):
    app.logger.warning("Assessment failed: %s", error)
    return jsonify({"error": str(error)}), 502


@app.errorhandler(HTTPException)
def http_error(error):
    return jsonify({"error": error.description}), error.code


# ---------------------------------------------------------------------------
# Page routes
# ---------------------------------------------------------------------------


@app.get("/")
def index():
    return render_template("index.html")


@app.get("/favicon.ico")
def favicon():
    return send_from_directory(
        os.path.join(app.root_path, "static"),
        "favicon.svg",
        mimetype="image/svg+xml",
    )

# ---------------------------------------------------------------------------
# API routes
# ---------------------------------------------------------------------------


@app.get("/api/fields/<field>/goal")
def api_goal(field: str):
    return jsonify(learning_goals.get_goal(field, request.args.get("timezone", "UTC")))


@app.get("/api/fields/<field>/goal/preview")
def api_goal_preview(field: str):
    return jsonify(learning_goals.preview_goal(
        field, request.args.get("target_date"), request.args.get("strategy", "steady"),
        request.args.get("timezone", "UTC")
    ))


@app.put("/api/fields/<field>/goal")
def api_save_goal(field: str):
    body = _request_body()
    return jsonify(learning_goals.save_goal(
        field, body.get("target_date"), body.get("strategy", "steady"), body.get("timezone", "UTC")
    ))


@app.delete("/api/fields/<field>/goal")
def api_delete_goal(field: str):
    learning_goals.delete_goal(field)
    return jsonify({"goal": None})


@app.get("/api/fields/<field>/question")
def api_next_question(field: str):
    topic = request.args.get("topic")
    group_name = request.args.get("filter")
    question = question_store.get_next_question(field, group_name, topic, request.args.get("subtopic"), request.args.get("filter_type"))
    progress = question_store.load_progress(field)
    if question is None:
        return jsonify({"error": "No questions available"}), 404
    return jsonify(_question_view(question, progress.get(str(question["id"]), {}), question_store.load_bookmarks(field)))


@app.post("/api/bookmark")
def api_bookmark():
    body = _request_body()
    bookmarked = body.get("bookmarked")
    if type(bookmarked) is not bool:
        raise ValueError("Bookmarked must be a boolean")
    question = _require_question(body.get("field"), body.get("id"))
    question_store.set_bookmark(body["field"], question["id"], bookmarked)
    return jsonify({"bookmarked": bookmarked})


@app.post("/api/assess")
def api_assess():
    body = _request_body()
    field = body.get("field")
    question_id = body.get("id")
    student_answer = body.get("answer")
    if not isinstance(student_answer, str):
        return jsonify({"error": "Answer must be text"}), 400
    student_answer = student_answer.strip()

    if not question_id or not student_answer:
        return jsonify({"error": "Missing 'id' or 'answer'"}), 400

    question = _require_question(field, question_id)

    system_prompt = question_store.load_system_prompt(field)

    result = assessor.assess(
        system_prompt=system_prompt,
        question=question["question"],
        answer=question["answer"],
        student_answer=student_answer,
    )

    progress = question_store.record_attempt(
        field, question_id, result.correct, result.score
    )

    return jsonify({
        **asdict(result),
        "answer": question["answer"],
        "progress": progress,
        "preparation": question_store.get_question_preparation(progress),
    })


@app.post("/api/reveal-answer")
def api_reveal_answer():
    body = _request_body()
    field = body.get("field")
    question_id = body.get("id")

    if not question_id:
        return jsonify({"error": "Missing 'id'"}), 400

    question = _require_question(field, question_id)

    return jsonify({
        "result": "revealed",
        "score": 0.0,
        "correct": False,
        "feedback": "Die Musterlösung wurde direkt angezeigt.",
        "answer": question["answer"],
    })


@app.get("/api/fields")
def api_fields():
    return jsonify(question_store.get_fields())


@app.get("/api/fields/<field>/topics")
def api_topics(field: str):
    return jsonify(question_store.get_topics(field))


@app.get("/api/fields/<field>/constellation")
def api_constellation(field: str):
    return jsonify(question_store.get_constellation(field))


@app.get("/api/fields/<field>/examens")
def api_examens(field: str):
    return jsonify(question_store.get_examens(field))


@app.get("/api/fields/<field>/sets")
def api_sets(field: str):
    return jsonify(question_store.get_sets(field))


@app.get("/api/fields/<field>/bookmarks")
def api_bookmarks(field: str):
    return jsonify(question_store.get_bookmarks(field))


@app.get("/api/fields/<field>/bookmarks/<path:topic>/stats")
def api_bookmark_stats(field: str, topic: str):
    return jsonify(question_store.get_bookmark_stats(field, topic))


@app.get("/api/fields/<field>/stats")
def api_field_stats(field: str):
    return jsonify(question_store.get_field_stats(field))


@app.get("/api/fields/<field>/topics/<path:topic>/stats")
def api_topic_stats(field: str, topic: str):
    return jsonify(question_store.get_topic_stats(field, topic, request.args.get("subtopic")))


@app.get("/api/fields/<field>/examens/<path:examen>/stats")
def api_exam_stats(field: str, examen: str):
    return jsonify(question_store.get_examen_stats(field, examen))


@app.get("/api/fields/<field>/sets/<path:set_name>/stats")
def api_set_stats(field: str, set_name: str):
    return jsonify(question_store.get_set_stats(field, set_name))


@app.get("/api/fields/<field>/questions")
def api_all_questions(field: str):
    """Return all questions with progress (for the progress overview)."""
    questions, progress = question_store.get_all_questions(field)
    bookmarks = question_store.load_bookmarks(field)
    return jsonify([
        _question_view(question, progress.get(str(question["id"]), {}), bookmarks)
        for question in questions
    ])

# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _request_body() -> dict:
    body = request.get_json()
    if not isinstance(body, dict):
        abort(400, description="Expected a JSON object")
    return body


def _require_question(field: str, question_id: str | int) -> dict:
    question = question_store.get_question_by_id(field, question_id)
    if question is None:
        abort(404, description=f"Unknown question id: {question_id!r}")
    return question


def _question_view(question: dict, progress: dict, bookmarks: dict) -> dict:
    """Strip answer from the public question representation."""
    return {
        "id": question["id"],
        "topic": question["topic"],
        "subtopic": question.get("subtopic", ""),
        "question": question["question"],
        "bookmarked": any(question["id"] in ids for ids in bookmarks.values()),
        "progress": progress,
        "preparation": question_store.get_question_preparation(progress),
    }


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000)
