"""
app.py
Flask entry point. Routes call into question_store and assessor.
"""

from flask import Flask, jsonify, render_template, request

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

@app.get("/api/question")
def api_next_question():
    topic = request.args.get("topic")
    question = question_store.get_next_question(topic)
    if question is None:
        return jsonify({"error": "No questions available"}), 404
    return jsonify(_question_view(question))


@app.post("/api/assess")
def api_assess():
    body = request.get_json(force=True)
    qid = body.get("id")
    student_answer = (body.get("answer") or "").strip()

    if not qid or not student_answer:
        return jsonify({"error": "Missing 'id' or 'answer'"}), 400

    question = question_store.get_question_by_id(qid)
    if question is None:
        return jsonify({"error": f"Unknown question id: {qid!r}"}), 404

    result = assessor.assess(
        question=question["question"],
        answer=question["answer"],
        student_answer=student_answer,
    )

    progress = question_store.record_attempt(qid, result.correct, result.score)

    return jsonify({
        "correct": result.correct,
        "score": result.score,
        "feedback": result.feedback,
        "answer": question["answer"],
        "progress": progress,
    })


@app.get("/api/topics")
def api_topics():
    return jsonify(question_store.get_topics())


@app.get("/api/stats")
def api_stats():
    return jsonify(question_store.get_stats())


@app.get("/api/questions")
def api_all_questions():
    """Return all questions with progress (for the progress overview)."""
    questions = question_store.get_all_questions()
    return jsonify([_question_view(q) for q in questions])


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _question_view(q: dict) -> dict:
    """Strip answer from the public question representation."""
    return {
        "id": q["id"],
        "topic": q["topic"],
        "subtopic": q.get("subtopic", ""),
        "question": q["question"],
        "progress": q["progress"],
    }


if __name__ == "__main__":
    app.run(debug=True)