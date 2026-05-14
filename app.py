"""
app.py
Flask entry point. Routes call into question_store and assessor.
"""

from flask import Flask, jsonify, render_template, request, abort

import assessor
import question_store

app = Flask(__name__)


# ---------------------------------------------------------------------------
# Page routes
# ---------------------------------------------------------------------------

@app.get("/")
def index():
    return render_template("index.html")


# ---------------------------------------------------------------------------
# API routes
# ---------------------------------------------------------------------------

@app.get("/api/fields/<field>/question")
def api_next_question(field: str):
    if field == "undefined":
        print("not serving request with undefined field")
        abort(400, description="missing field parameter")
        
    topic = request.args.get("topic")
    filter = request.args.get("filter")
    question = question_store.get_next_question(field, filter, topic)
    progress = question_store.load_progress(field)
    if question is None:
        return jsonify({"error": "No questions available"}), 404
    return jsonify(_question_view(question, progress.get(str(question["id"]), {})))


@app.post("/api/assess")
def api_assess():
    body = request.get_json(force=True)
    field = body.get("field")
    qid = body.get("id")
    student_answer = (body.get("answer") or "").strip()

    if not qid or not student_answer:
        return jsonify({"error": "Missing 'id' or 'answer'"}), 400

    question = question_store.get_question_by_id(field, qid)
    if question is None:
        return jsonify({"error": f"Unknown question id: {qid!r}"}), 404

    result = assessor.assess(
        question=question["question"],
        answer=question["answer"],
        student_answer=student_answer,
    )

    progress = question_store.record_attempt(field, qid, result.correct, result.score)

    return jsonify({
        "correct": result.correct,
        "score": result.score,
        "feedback": result.feedback,
        "answer": question["answer"],
        "progress": progress,
    })

@app.get("/api/fields")
def api_fields():
    return jsonify(question_store.get_fields())

@app.get("/api/fields/<field>/topics")
def api_topics(field: str):
    if field == "undefined":
        print("not serving request with undefined field")
        abort(400, description="missing field parameter")
        
    return jsonify(question_store.get_topics(field))

@app.get("/api/fields/<field>/examens")
def api_pruefungen(field: str):
    if field == "undefined":
        print("not serving request with undefined field")
        abort(400, description="missing field parameter")
        
    return jsonify(question_store.get_examens(field))

@app.get("/api/fields/<field>/sets")
def api_sets(field: str):
    if field == "undefined":
        print("not serving request with undefined field")
        abort(400, description="missing field parameter")
        
    return jsonify(question_store.get_sets(field))

@app.get("/api/fields/<field>/stats")
def api_stats(field: str):
    if field == "undefined":
        print("not serving request with undefined field")
        abort(400, description="missing field parameter")
        
    return jsonify(question_store.get_stats(field, ids=None))

@app.get("/api/fields/<field>/stats")
def api_field_stats(field: str):
    if field == "undefined":
        print("not serving request with undefined field")
        abort(400, description="missing field parameter")
        
    return jsonify(question_store.get_field_stats(field))

@app.get("/api/fields/<field>/topics/<topic>/stats")
def api_topic_stats(field: str, topic: str):
    if field == "undefined":
        print("not serving request with undefined field")
        abort(400, description="missing field parameter")
        
    return jsonify(question_store.get_topic_stats(field, topic))

@app.get("/api/fields/<field>/examens/<examen>/stats")
def api_pruefung_stats(field: str, examen: str):
    if field == "undefined":
        print("not serving request with undefined field")
        abort(400, description="missing field parameter")

    return jsonify(question_store.get_examen_stats(field, examen))

@app.get("/api/fields/<field>/sets/<set_name>/stats")
def api_set_stats(field: str, set_name: str):
    if field == "undefined":
        print("not serving request with undefined field")
        abort(400, description="missing field parameter")

    return jsonify(question_store.get_set_stats(field, set_name))


@app.get("/api/fields/<field>/questions")
def api_all_questions(field: str):
    """Return all questions with progress (for the progress overview)."""
    if field == "undefined":
        print("not serving request with undefined field")
        abort(400, description="missing field parameter")

    questions, progress = question_store.get_all_questions(field)
    return jsonify([
        _question_view(q, progress.get(str(q["id"]), {}))
        for q in questions
    ])


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _question_view(q: dict, p: dict) -> dict:
    """Strip answer from the public question representation."""
    return {
        "id": q["id"],
        "topic": q["topic"],
        "subtopic": q.get("subtopic", ""),
        "question": q["question"],
        "progress": p,
    }


if __name__ == "__main__":
    app.run(debug=True)