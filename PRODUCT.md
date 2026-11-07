# Quiz Trainer

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Primärer Nutzer ist der Entwickler selbst, der für seinen Psychologie-Bachelor
als drittes Studium lernt. Die App soll auch für andere Lernende und deren
Fachgebiete nutzbar sein. Besondere Vorkenntnisse über das Projekt sollen keine
Voraussetzung für die Bedienung sein.

## Product Purpose

Quiz Trainer unterstützt selbstständige Prüfungsvorbereitung: Fragen in eigenen
Worten beantworten, Rückmeldung erhalten, Verständnislücken erkennen und gezielt
weiterüben. Fortschritt soll bei der Entscheidung helfen, was als Nächstes zu
lernen ist. Ein Prüfungserfolg oder eine bestimmte Lernwirkung wird nicht
garantiert.

## Positioning

Der bestehende Lernablauf verbindet Freitextantworten und semantische
KI-Bewertung mit Referenzlösungen, adaptiver Wiederholung, persönlichem
Lernfortschritt und Live-Sitzungen für zwei Personen. Eigene Fragebanken und
fachspezifische Bewertungsanweisungen machen ihn auf weitere Fächer übertragbar.

## Operating Context

- Lernen im Browser, allein oder zu zweit am selben laufenden Server.
- Fach, Thema oder Übungs-/Prüfungssatz wählen, Antwort schreiben, prüfen lassen
  und Feedback sowie Referenzlösung durchgehen.
- Persönliche Lernprofile trennen Fortschritt, Lesezeichen, Lernziele und
  Statistiken; Fragebanken und Fragengruppen bleiben gemeinsam.
- Lernziele mit Termin und Tagespensum sowie Statistiken, Lernreise und
  Lernlückenanalyse unterstützen die Planung und Reflexion.
- Kooperatives Lernen nutzt eine gemeinsame Antwort; im Wettbewerb antworten
  beide Personen zunächst privat.
- Bewertung läuft je nach Konfiguration lokal über GPT4All oder über OpenAI.
  ChatGPT-Verknüpfungen und exportierbare Analyse-Prompts ergänzen den Ablauf.

## Capabilities and Constraints

- Bestehender Stack: Flask, Python, serverseitige Templates, CSS und JavaScript;
  CodeMirror für den gemeinsamen Editor. Normaler Python-Start benötigt kein Node.
- Frage-IDs und bestehende Lernhistorien bleiben stabil. Reale Lerndaten dürfen
  bei Entwicklung und Tests nicht verändert werden.
- Aufdecken einer Lösung ist kein bewerteter Versuch. Fehlgeschlagene oder
  ungültige Bewertungen dürfen keinen Lernfortschritt erzeugen.
- Vorbereitungsbewertung, adaptive Fragenauswahl und semantische Lernhinweise
  sind getrennte Berechnungen. KI-Hinweise sind revidierbare Vorschläge.
- Adaptive Auswahl mischt vier neue Fragen mit einer fälligen Wiederholung,
  sofern vorhanden, und vermeidet kürzlich angezeigte Fragen.
- Lernziel-Tage beginnen um 06:00 in der gewählten Zeitzone; Zeitumstellung und
  stabile tägliche Planungsgrundlagen müssen erhalten bleiben.
- Im Wettbewerb bleiben Antworten privat, bis beide Ergebnisse bereit sind.
  Kooperative Bewertung bezieht sich auf eine bestätigte Editorrevision und
  zählt je Teilnehmer genau einmal, auch nach Wiederholung oder Wiederherstellung.
- Lernprofile haben derzeit keine Passwörter oder Zugriffsbeschränkungen.
  Profiltrennung ist keine Zugangskontrolle.
- Live-Zusammenarbeit benötigt derzeit einen Serverprozess; Präsenz und
  WebSocket-Verteilung sind prozesslokal. Dateisperren verwenden Unix-`fcntl`.
- Weitere verbindliche Produktanforderungen wurden beim Init nicht festgelegt.
  Die bestehenden Vorgaben in AGENTS.md bleiben maßgeblich.

## Brand Commitments

Produktname: Quiz Trainer. Die Oberfläche bleibt deutschsprachig und spricht
Lernende direkt an. Bestehende fachliche Inhalte und Begriffe erhalten; keine
unbelegten Aussagen über Lernerfolg oder Prüfungsreife ergänzen.

## Evidence on Hand

- README.md beschreibt Einrichtung, Inhalte, Lernabläufe und Hosting.
- AGENTS.md enthält Architektur, Entwicklungsregeln und zu bewahrende Abläufe.
- `sets/` enthält vorhandene Fragebanken, Referenzantworten, Bewertungsanweisungen
  und Fragengruppen; dokumentierte Fächer umfassen Psychologie, SKS und SRC.
- `templates/index.html`, `templates/_together.html` und `static/trainer.css`
  bilden die bestehende Oberfläche ab.
- Lernhistorien und semantische Beobachtungen sind persönliche Nutzungsdaten,
  keine öffentlichen Wirksamkeitsnachweise oder Marketingmaterialien.

## Product Principles

- Eigene Erklärungen und nachvollziehbare Rückmeldung stehen im Zentrum.
- Der nächste Lernschritt soll aus tatsächlichem Fortschritt verständlich werden.
- Persönliche Lernstände und die Vertraulichkeit gemeinsamer Sitzungen bewahren.
- Fachübergreifende Nutzung ermöglichen, ohne den persönlichen Lernablauf unnötig
  zu verkomplizieren.
- Erfasste Leistung, Planung und KI-Interpretationen klar auseinanderhalten.

## Accessibility & Inclusion

Bestehende Tastaturbedienung, Fokusführung, zugängliche Beschriftungen und
Statusmeldungen bewahren. Die Weboberfläche soll auf Desktop und Mobilgeräten
bedienbar bleiben. Ein zusätzlicher formaler Barrierefreiheitsstandard oder
besondere individuelle Anforderungen wurden beim Init nicht festgelegt.
