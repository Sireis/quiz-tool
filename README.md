# Quiz Trainer

**Practice in your own words. Get feedback. Build confidence.**

A browser-based exam trainer for SKS, SRC, psychology, and custom subjects. Choose a topic or question set, write your answer, and compare it with AI feedback and a reference solution.

## What you can do

- Practice by subject, topic, or exam set.
- Get feedback on the meaning of your answer.
- Track your progress and revisit questions that need more practice.
- Open **Deine Lernreise** in the statistics panel for a timeline galaxy, coverage milestones, daily activity, and daily average grading scores.
- Explore an answer further with a prepared ChatGPT follow-up prompt.

## Quick start

From the repository directory, create a Python environment and install the dependencies:

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
python app.py
```

On Windows, activate the environment with `.venv\Scripts\activate` instead.

Open **[localhost:5000](http://localhost:5000)** in your browser.

### Choose your AI backend

By default, grading runs locally with **GPT4All**. No API key is needed. The model loads when you first submit an answer and may need to download, so the first assessment can take longer.

To use **OpenAI** instead, create a `.env` file in the repository root:

```dotenv
ASSESSOR_BACKEND=openai
OPENAI_API_KEY=your-key
OPENAI_MODEL=gpt-6-luna
OPENAI_REASONING_EFFORT=medium
OPENAI_MAX_OUTPUT_TOKENS=4096
```

Restart the app after changing the configuration. To choose a different local model, set `GPT4ALL_MODEL` in the same file.

## Add your own questions

### Create a subject

Create a folder under `sets/`, for example `sets/my-subject/`, and add these two files:

**`questions.json`** — your questions and reference answers:

```json
{
  "questions": [
    {
      "id": 1,
      "topic": "Navigation",
      "subtopic": "GPS",
      "question": "What does GPS stand for?",
      "answer": "Global Positioning System."
    }
  ]
}
```

Each question needs a unique positive integer `id`, a `topic`, a `question`, and an `answer`. The `subtopic` is optional. To add questions to an existing subject, append entries to its `questions` array. Keep existing IDs unchanged so saved progress and question sets still refer to the right questions.

**`system-prompt.txt`** — instructions for grading answers. Start with:

```text
Evaluate the student answer semantically against the reference answer.
Accept equivalent correct explanations.
Return valid JSON only with:
- score: a number from 0 to 1
- result: correct, mostly_correct, partially_correct, minimally_correct, or incorrect
- feedback: a short explanation
```

Adjust the instructions to suit your subject. Save both files as UTF-8, then reload the browser to see the subject and its topics.

### Organize questions into sets

Optionally add `sets.json` for custom practice groups or `examens.json` for exam groups. Both use group names and lists of question IDs:

```json
{
  "Practice set 1": [1, 2, 3],
  "Practice set 2": [2, 4]
}
```

Use only IDs that exist in that subject’s question bank. Groups can overlap. Saved progress is created automatically as you answer questions and is shared by everyone using the same server.

---

The quick-start command runs Flask’s development server. Use a production WSGI server when hosting the app.
