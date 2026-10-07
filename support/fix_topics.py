import json
import sys

TOPIC_BY_SUBTOPIC = {
    "Psychologie als empirische Wissenschaft":
        "Wissenschaftstheoretische und methodische Grundlagen",
    "Theoretische Konstrukte":
        "Wissenschaftstheoretische und methodische Grundlagen",
    "Operationalisierung":
        "Wissenschaftstheoretische und methodische Grundlagen",
    "Fragebogenmethoden":
        "Wissenschaftstheoretische und methodische Grundlagen",
    "Generalisierung":
        "Wissenschaftstheoretische und methodische Grundlagen",
    "Ökologische Validität":
        "Wissenschaftstheoretische und methodische Grundlagen",
    "Nomothetischer und idiographischer Ansatz":
        "Wissenschaftstheoretische und methodische Grundlagen",

    "Soziogenetische Ansätze":
        "Soziokulturelle Entwicklungstheorien",
    "Meads Theorie des Selbst":
        "Soziokulturelle Entwicklungstheorien",
    "Kultivationsprinzip":
        "Soziokulturelle Entwicklungstheorien",
    "Vygotskys soziokultureller Ansatz":
        "Soziokulturelle Entwicklungstheorien",
    "Zone der nächsten Entwicklung":
        "Soziokulturelle Entwicklungstheorien",

    "Piagets Entwicklungstheorie":
        "Kognitive Entwicklung",

    "Ontogenese":
        "Grundlagen und Modelle der Entwicklung über die Lebensspanne",
    "Entwicklungsbegriff":
        "Grundlagen und Modelle der Entwicklung über die Lebensspanne",
    "Entwicklungspsychologie der Lebensspanne":
        "Grundlagen und Modelle der Entwicklung über die Lebensspanne",
    "SOK-Modell":
        "Grundlagen und Modelle der Entwicklung über die Lebensspanne",
    "Entwicklungsaufgaben":
        "Grundlagen und Modelle der Entwicklung über die Lebensspanne",

    "Alter in der Entwicklungsforschung":
        "Methoden der Entwicklungsforschung",
    "Querschnittmethode":
        "Methoden der Entwicklungsforschung",
    "Längsschnittmethode":
        "Methoden der Entwicklungsforschung",

    "Eriksons psychosoziale Entwicklung":
        "Psychosoziale Entwicklung und Identität",
    "Eriksons Identitätsbegriff":
        "Psychosoziale Entwicklung und Identität",
    "Marcias Identitätsstatus-Ansatz":
        "Psychosoziale Entwicklung und Identität",
    "Erhebungsmethoden der Identität":
        "Psychosoziale Entwicklung und Identität",

    "Display Rules":
        "Emotionale Ausdrucksregulation",

    "Kulturvergleich":
        "Kultur und Entwicklung",
    "Kulturpsychologie":
        "Kultur und Entwicklung",
    "Kultur und Entwicklung":
        "Kultur und Entwicklung",
}


def main():
    if len(sys.argv) != 3:
        print(
            f"Usage: {sys.argv[0]} input.json output.json",
            file=sys.stderr,
        )
        sys.exit(1)

    input_path = sys.argv[1]
    output_path = sys.argv[2]

    with open(input_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    if not isinstance(data, dict):
        raise ValueError("Expected top-level JSON object")

    questions = data.get("questions")

    if not isinstance(questions, list):
        raise ValueError("Expected top-level 'questions' array")

    unknown_subtopics = set()

    for question in questions:
        if not isinstance(question, dict):
            raise ValueError(
                f"Expected question object, got: {type(question).__name__}"
            )

        subtopic = question.get("subtopic")

        if subtopic not in TOPIC_BY_SUBTOPIC:
            unknown_subtopics.add(subtopic)
            continue

        question["topic"] = TOPIC_BY_SUBTOPIC[subtopic]

    if unknown_subtopics:
        print("Unknown subtopics:", file=sys.stderr)

        for subtopic in sorted(unknown_subtopics, key=lambda x: str(x)):
            print(f"  - {subtopic!r}", file=sys.stderr)

        print("No output written.", file=sys.stderr)
        sys.exit(2)

    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(
            data,
            f,
            ensure_ascii=False,
            indent=2,
        )
        f.write("\n")

    print(f"Wrote {len(questions)} questions to {output_path}")


if __name__ == "__main__":
    main()