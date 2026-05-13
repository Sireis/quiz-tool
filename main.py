"""
Quiz Tool — GPT4All-powered semantic answer rating
Progress is tracked per question ID in progress.json (same directory as questions file).
"""

import json
import tkinter as tk
from tkinter import filedialog, messagebox, scrolledtext
from datetime import datetime, timezone
from pathlib import Path
from gpt4all import GPT4All


# ─── Configuration ────────────────────────────────────────────────────────────

MODEL_NAME    = "Meta-Llama-3-8B-Instruct.Q4_0.gguf"  # change to your downloaded model
PROGRESS_FILE = "progress.json"                         # relative to questions file location


# ─── Top-level app ────────────────────────────────────────────────────────────

def main():
    app = QuizApp()
    app.run()


class QuizApp:
    def __init__(self):
        self.model       = None
        self.questions   = []
        self.progress    = {}
        self.queue       = []
        self.current     = None
        self.questions_path = None
        self.progress_path  = None

        self.root = tk.Tk()
        self.root.title("Quiz Tool")
        self.root.geometry("700x500")
        self.root.resizable(True, True)

        self._build_ui()

    def run(self):
        self.root.mainloop()

    # ─── UI actions (high-level) ───────────────────────────────────────────────

    def on_load_file(self):
        path = filedialog.askopenfilename(filetypes=[("JSON files", "*.json")])
        if not path:
            return
        self.questions_path = Path(path)
        self.progress_path  = self.questions_path.parent / PROGRESS_FILE
        self.context        = load_context(self.questions_path) 
        self.questions      = load_questions(self.questions_path)
        self.progress       = load_progress(self.progress_path)
        self.queue          = build_queue(self.questions)
        self._set_status(f"Loaded {len(self.questions)} questions.")
        self._init_model()
        self._next_question()

    def on_submit(self):
        if not self.current:
            return
        user_answer = self.answer_box.get("1.0", tk.END).strip()
        if not user_answer:
            return
        self._set_status("Rating your answer…")
        self.root.update()

        correct, explanation = rate_answer(
            self.model,
            self.context,
            self.current["question"],
            self.current["answer"],
            user_answer,
        )
        update_progress(self.progress, self.current["id"], correct)
        save_progress(self.progress_path, self.progress)

        self._show_result(correct, explanation)

    def on_next(self):
        self._next_question()

    # ─── UI state transitions ──────────────────────────────────────────────────

    def _next_question(self):
        if not self.queue:
            messagebox.showinfo("Done", "You've gone through all questions!")
            return
        self.current = self.queue.pop(0)
        stats = self.progress.get(self.current["id"], {})
        attempts = stats.get("attempts", 0)
        correct  = stats.get("correct", 0)

        self.question_label.config(
            text=f"Q: {self.current['question']}"
        )
        self.stats_label.config(
            text=f"Attempts: {attempts}   Correct: {correct}"
        )
        self.answer_box.delete("1.0", tk.END)
        self.result_box.config(state=tk.NORMAL)
        self.result_box.delete("1.0", tk.END)
        self.result_box.config(state=tk.DISABLED)
        self.submit_btn.config(state=tk.NORMAL)
        self.next_btn.config(state=tk.DISABLED)
        self._set_status("Type your answer and press Submit.")

    def _show_result(self, correct: bool, explanation: str):
        tag    = "correct" if correct else "incorrect"
        header = "✓ Correct!" if correct else "✗ Incorrect"
        self.result_box.config(state=tk.NORMAL)
        self.result_box.delete("1.0", tk.END)
        self.result_box.insert(tk.END, f"{header}\n\n", tag)
        self.result_box.insert(tk.END, explanation)
        self.result_box.config(state=tk.DISABLED)
        self.submit_btn.config(state=tk.DISABLED)
        self.next_btn.config(state=tk.NORMAL)
        self._set_status("")

    def _set_status(self, text: str):
        self.status_label.config(text=text)

    def _init_model(self):
        if self.model is not None:
            return
        self._set_status(f"Loading model: {MODEL_NAME} …")
        self.root.update()
        self.model = GPT4All(MODEL_NAME)
        self._set_status("Model ready.")

    # ─── UI construction ──────────────────────────────────────────────────────

    def _build_ui(self):
        pad = {"padx": 10, "pady": 5}

        top_bar = tk.Frame(self.root)
        top_bar.pack(fill=tk.X, **pad)

        tk.Button(top_bar, text="Load Questions…", command=self.on_load_file).pack(side=tk.LEFT)
        self.status_label = tk.Label(top_bar, text="No file loaded.", fg="gray")
        self.status_label.pack(side=tk.LEFT, padx=10)

        self.question_label = tk.Label(
            self.root, text="Load a questions file to begin.",
            wraplength=660, justify=tk.LEFT, font=("TkDefaultFont", 12, "bold")
        )
        self.question_label.pack(fill=tk.X, **pad)

        self.stats_label = tk.Label(self.root, text="", fg="gray")
        self.stats_label.pack(anchor=tk.W, padx=10)

        tk.Label(self.root, text="Your answer:").pack(anchor=tk.W, padx=10)
        self.answer_box = scrolledtext.ScrolledText(self.root, height=4, wrap=tk.WORD)
        self.answer_box.pack(fill=tk.X, **pad)
        self.answer_box.bind("<Control-Return>", lambda _: self.on_submit())

        btn_row = tk.Frame(self.root)
        btn_row.pack(**pad)
        self.submit_btn = tk.Button(btn_row, text="Submit (Ctrl+Enter)", command=self.on_submit, state=tk.DISABLED)
        self.submit_btn.pack(side=tk.LEFT, padx=5)
        self.next_btn = tk.Button(btn_row, text="Next →", command=self.on_next, state=tk.DISABLED)
        self.next_btn.pack(side=tk.LEFT, padx=5)

        tk.Label(self.root, text="Result:").pack(anchor=tk.W, padx=10)
        self.result_box = scrolledtext.ScrolledText(self.root, height=6, wrap=tk.WORD, state=tk.DISABLED)
        self.result_box.pack(fill=tk.BOTH, expand=True, **pad)
        self.result_box.tag_config("correct",   foreground="green")
        self.result_box.tag_config("incorrect", foreground="red")


# ─── GPT4All interaction ───────────────────────────────────────────────────────

def rate_answer(model: GPT4All, context: str, question: str, expected: str, user_answer: str) -> tuple[bool, str]:
    prompt = (
        f"Du bewertest eine Quiz-Antwort. Bewertung basierend auf dem Sinn, nicht auf exaktem Wortlaut. Beachte auch den Kontext.\n\n"
        f"Kontext: {context}\n\n"
        f"Frage: {question}\n"
        f"Erwartete Antwort: {expected}\n"
        f"Student Antwort: {user_answer}\n\n"
        f"Erste Zeile muss genau Richtig oder FALSCH sein. Basierend darauf, ob die Antwort im Wesentlichen korrekt und vollständig ist. "
        f"Dann gib eine kurze Erklärung (1-3 Sätze)."
    )
    with model.chat_session():
        raw = model.generate(prompt, max_tokens=150).strip()

    lines    = raw.splitlines()
    verdict  = lines[0].strip().upper() if lines else ""
    correct  = verdict.startswith("RICHTIG")
    explanation = "\n".join(lines[1:]).strip() if len(lines) > 1 else raw
    return correct, explanation


# ─── Progress logic ───────────────────────────────────────────────────────────

def build_queue(questions: list[dict]) -> list[dict]:
    """Return questions in original order. Extend here for spaced repetition later."""
    return list(questions)


def update_progress(progress: dict, qid: str, correct: bool):
    entry = progress.setdefault(qid, {"attempts": 0, "correct": 0, "last_seen": None})
    entry["attempts"] += 1
    if correct:
        entry["correct"] += 1
    entry["last_seen"] = datetime.now(timezone.utc).isoformat()


# ─── File I/O ─────────────────────────────────────────────────────────────────

def load_context(path: Path) -> str:
    with open(path, encoding="utf-8") as f:
        return json.load(f).get("context", "")

def load_questions(path: Path) -> list[dict]:
    with open(path, encoding="utf-8") as f:
        return json.load(f).get("questions", [])


def load_progress(path: Path) -> dict:
    if path.exists():
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    return {}


def save_progress(path: Path, progress: dict):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(progress, f, indent=2)


# ─── Entry point ──────────────────────────────────────────────────────────────

if __name__ == "__main__":
    main()