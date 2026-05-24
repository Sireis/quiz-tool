# SKS Trainer

Flask-based exam prep app. Questions and progress are stored in `questions.json`.

## Setup

```bash
pip install -r requirements.txt
python app.py
```

Open http://localhost:5000

## Switching to OpenAI backend

```bash
export ASSESSOR_BACKEND=openai
export OPENAI_API_KEY=sk-...
export OPENAI_MODEL=gpt-4o-mini   # optional, default
python app.py
```

or

create .env file with

```bash
ASSESSOR_BACKEND=openai
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o-mini   # optional, default
```

## Adding questions

Add entries to `questions.json` following the existing schema:

```json
{
  "id": "q013",
  "topic": "Navigation",
  "subtopic": "GPS",
  "question": "...",
  "answer": "..."
}
```

## Env variables

| Variable           | Default                                   | Purpose                      |
|--------------------|-------------------------------------------|------------------------------|
| ASSESSOR_BACKEND   | `gpt4all`                                 | `gpt4all` or `openai`        |
| GPT4ALL_MODEL      | `mistral-7b-instruct-v0.1.Q4_0.gguf`      | Model filename (auto-downloaded) |
| OPENAI_MODEL       | `gpt-4o-mini`                             | OpenAI model string          |
