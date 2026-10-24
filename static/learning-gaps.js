/* Reports always render as text; model output and saved answers are untrusted. */
(() => {
  const el = id => document.getElementById(`gaps-${id}`);
  const dialog = el('dialog');
  let snapshot = null;
  let field = null;
  let generation = 0;
  let busy = false;

  async function json(url, options) {
    const response = await fetch(url, options);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Die Anfrage ist fehlgeschlagen.');
    return data;
  }

  function text(parent, tag, value) {
    const node = document.createElement(tag);
    node.textContent = value;
    parent.append(node);
    return node;
  }

  function renderReport(report) {
    const root = el('report');
    root.replaceChildren();
    if (!report) return;
    const stale = report.fingerprint !== snapshot.fingerprint && report.input_fingerprint !== snapshot.fingerprint;
    text(root, 'h3', 'Lerngedächtnis · letzte Analyse');
    text(root, 'p', `${new Date(report.created_at).toLocaleString('de-DE')} · ${(report.attempt_ids || report.attempts).length} Antworten${stale ? ' · Andere Datengrundlage als die aktuelle Vorschau' : ''}`);
    text(root, 'p', report.summary);
    if (!report.findings.length) text(root, 'p', 'Keine ausreichend belegten Lernlücken gefunden. Das ist kein Nachweis vollständiger Beherrschung.');
    const labels = {tentative: 'Vorläufiger Hinweis', recurring: 'Wiederkehrender Hinweis', improving: 'Anzeichen für Verbesserung', resolved: 'Vorläufig aufgelöst'};
    const attempts = new Map(report.attempts.map(item => [item.attempt_id, item]));
    for (const finding of report.findings) {
      const card = document.createElement('article');
      root.append(card);
      text(card, 'h4', finding.title);
      text(card, 'p', labels[finding.status]);
      if (finding.updated_at) text(card, 'p', `Zuletzt überprüft: ${new Date(finding.updated_at).toLocaleString('de-DE')} · ${new Set(finding.evidence.map(e => e.attempt_id)).size} unterschiedliche Belege`);
      text(card, 'p', finding.description);
      text(card, 'p', `Gezielt üben: ${finding.next_step}`);
      for (const evidence of finding.evidence) {
        const attempt = attempts.get(evidence.attempt_id);
        if (!attempt) {
          text(card, 'p', 'Dieser Beleg ist nicht mehr verfügbar (Antwort oder Frage entfernt).');
          continue;
        }
        const details = document.createElement('details');
        card.append(details);
        text(details, 'summary', `Frage ${attempt.question_id} · ${new Date(attempt.at).toLocaleString('de-DE')}${attempt.evidence_type === 'shared' ? ' · Gemeinsame Antwort' : ''}`);
        if (evidence.quote) text(details, 'blockquote', evidence.quote);
        text(details, 'p', `Frage: ${attempt.question}`);
        text(details, 'p', `Deine Antwort${attempt.evidence_type === 'shared' ? ' (gemeinsam)' : ''}: ${attempt.student_answer}`);
        text(details, 'p', `Musterlösung: ${attempt.reference_answer}`);
        text(details, 'p', `Bewertung: ${Math.round(attempt.score * 100)}% · ${attempt.feedback}`);
      }
    }
  }

  function controls() {
    const available = Boolean(snapshot?.can_analyze ?? snapshot?.attempts.length);
    el('analyze').disabled = busy || !available;
    el('import').disabled = busy || !available;
    el('copy').disabled = !available;
    el('download').disabled = !available;
  }

  function renderFacts(data) {
    const root = el('facts');
    root.replaceChildren();
    const facts = data.deterministic;
    if (!facts) return;
    const s = facts.subject;
    text(root, 'h3', 'Berechneter Fortschritt');
    text(root, 'p', `${s.attempted} von ${s.total} Fragen bearbeitet (${Math.round(s.completion_percent)}%) · ${s.total_attempts} Versuche · ${Math.round(s.success_rate)}% richtige Versuche`);
    const c = s.preparation.counts;
    text(root, 'p', `Vorbereitung: ${c.red} rot · ${c.yellow} gelb · ${c.green} grün. Farben und Trefferraten sind Fortschrittswerte; semantische Hinweise ergänzen sie.`);
    const details = document.createElement('details');
    root.append(details);
    text(details, 'summary', 'Fortschritt nach Thema');
    for (const topic of facts.topics) text(details, 'p', `${topic.name}: ${topic.attempted}/${topic.total} Fragen · ${Math.round(topic.success_rate)}% richtige Versuche`);
    if (facts.omitted_topics) text(details, 'p', `${facts.omitted_topics} weitere Themen sind in diesem Ausschnitt nicht enthalten.`);
  }

  el('close').onclick = () => dialog.close();
  dialog.addEventListener('close', () => { generation++; busy = false; });
  el('open').onclick = async () => {
    if (!sel.field) return;
    field = sel.field;
    const request = ++generation;
    busy = false;
    snapshot = null;
    el('field').textContent = field;
    el('scope').textContent = '';
    el('status').textContent = 'Antworten werden geladen…';
    el('prompt').value = '';
    el('result').value = '';
    el('facts').replaceChildren();
    el('report').replaceChildren();
    el('export').open = false;
    controls();
    dialog.showModal();
    try {
      const data = await json(`/api/fields/${encodeURIComponent(field)}/learning-gaps`);
      if (request !== generation) return;
      snapshot = data;
      renderFacts(data);
      el('prompt').value = data.prompt;
      el('scope').textContent = `${data.attempts.length} der ${data.available} gespeicherten Antworten · ${data.new_attempt_count ?? data.attempts.length} davon noch nicht analysiert · ${data.memory_context_count || 0} von ${data.memory_count || 0} Erinnerungen und ${data.memory_attempt_count || 0} ältere Belege im Prompt. Höchstens ${data.max_attempts} aktuelle Antworten, begrenzt nach Textumfang. ${data.legacy_count} ältere Versuche ohne Antworttext und ${data.missing_count || 0} Antworten zu entfernten Fragen sind von der Textanalyse ausgeschlossen, vorhandene Fortschrittswerte bleiben berücksichtigt. Fragen und Musterlösungen stammen aus dem aktuellen Fragenkatalog. Analyse hier über ${data.backend}.`;
      el('status').textContent = (data.can_analyze ?? data.attempts.length)
        ? 'Bereit. Erst „Jetzt analysieren“ sendet die angezeigten Belege an das konfigurierte KI-Backend.'
        : data.available ? 'Die neueste Antwort überschreitet das Textlimit der Analyse.'
          : data.missing_count ? 'Die gespeicherten Antworten gehören zu entfernten Fragen und können nicht analysiert werden.'
          : 'Noch keine Antworttexte vorhanden. Neu bewertete Antworten werden ab jetzt gespeichert.';
      renderReport(data.report);
    } catch (error) {
      if (request === generation) el('status').textContent = error.message;
    } finally {
      if (request === generation) controls();
    }
  };

  async function analyze(imported = false) {
    if (busy || !(snapshot?.can_analyze ?? snapshot?.attempts.length)) return;
    if (imported && !el('result').value.trim()) {
      el('status').textContent = 'Bitte das JSON-Ergebnis deiner KI einfügen.';
      el('result').focus();
      return;
    }
    const request = generation;
    busy = true;
    controls();
    el('status').textContent = imported ? 'Ergebnis wird geprüft…' : 'Lernlücken werden analysiert… Der Prompt bleibt exportierbar.';
    try {
      const report = await json(`/api/fields/${encodeURIComponent(field)}/learning-gaps`, {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({fingerprint: snapshot.fingerprint,
          ...(imported ? {result: el('result').value} : {})}),
      });
      if (request !== generation) return;
      renderReport(report);
      el('status').textContent = 'Lerngedächtnis gespeichert. Dieselben Antworten zählen nicht erneut als Belege. Deine Fortschrittswerte bleiben unverändert. Ansicht erneut öffnen, um den aktualisierten Prompt zu exportieren.';
    } catch (error) {
      if (request === generation) el('status').textContent = error.message;
    } finally {
      if (request === generation) { busy = false; controls(); }
    }
  }
  el('analyze').onclick = () => analyze();
  el('import').onclick = () => analyze(true);

  el('copy').onclick = async () => {
    const request = generation;
    try {
      await navigator.clipboard.writeText(el('prompt').value);
      if (request === generation) el('status').textContent = 'Prompt kopiert. Füge ihn in deine bevorzugte KI ein.';
    } catch {
      if (request !== generation) return;
      el('export').open = true;
      el('prompt').focus();
      el('prompt').select();
      el('status').textContent = 'Bitte den markierten Prompt manuell kopieren oder herunterladen.';
    }
  };

  el('download').onclick = () => {
    const url = URL.createObjectURL(new Blob([el('prompt').value], {type: 'text/plain;charset=utf-8'}));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'lernluecken-prompt.txt';
    link.click();
    URL.revokeObjectURL(url);
    el('status').textContent = 'Prompt als Text exportiert.';
  };
})();
