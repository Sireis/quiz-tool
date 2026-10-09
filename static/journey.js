/* Actual dated answers are separate from legacy totals with no event history. */
function journeyData(questions) {
  const events = [];
  const legacy = [];
  let attempts = 0;
  let explored = 0;
  for (const q of questions) {
    const p = q.progress || {};
    attempts += p.attempts || 0;
    if (p.attempts > 0) explored++;
    for (const event of p.history || []) {
      if (Number.isFinite(Date.parse(event.at))) events.push({ ...event, question: q });
    }
    const at = p.historical_last_attempt || (!p.history ? p.last_attempt || p.last_seen : null);
    if (at && Number.isFinite(Date.parse(at))) legacy.push({ at, question: q });
  }
  events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return { events, legacy, attempts, explored, total: questions.length,
    undated: Math.max(0, attempts - events.length) };
}
function journeyScope(questions, topic = null) {
  return journeyData(topic === null ? questions : questions.filter(q => q.topic === topic));
}
function journeyTopicCount(events, topic = null) {
  return topic === null ? events.length : events.filter(event => event.question.topic === topic).length;
}
function journeyDay(at) {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function journeyCalendarDates(now = new Date()) {
  const today = new Date(now); today.setHours(12, 0, 0, 0);
  const start = new Date(today); start.setDate(start.getDate() - 364);
  const offset = (start.getDay() + 6) % 7;
  return Array.from({ length: 365 }, (_, i) => {
    const date = new Date(start); date.setDate(start.getDate() + i);
    return { date, row: (date.getDay() + 6) % 7 + 2, column: Math.floor((offset + i) / 7) + 2 };
  });
}
if (typeof module !== 'undefined') module.exports = { journeyData, journeyDay, journeyCalendarDates, journeyTopicCount, journeyScope };
if (typeof document !== 'undefined') {
  const dialog = document.getElementById('journey-dialog');
  const content = document.getElementById('journey-content');
  let requestId = 0;
  const topicFilter = document.getElementById('journey-topic');
  let fieldQuestions = [];
  let topics = [];
  let selectedTopic = null;
  function renderSelection() {
    const topic = selectedTopic;
    const scrollPosition = content.scrollTop;
    render(journeyData(fieldQuestions), topic, journeyScope(fieldQuestions, topic));
    content.scrollTop = scrollPosition;
  }
  topicFilter.addEventListener('click', event => {
    const button = event.target.closest('button[data-topic]');
    if (!button || !topicFilter.contains(button) || button.disabled) return;
    selectedTopic = button.dataset.topic === '' ? null : topics[Number(button.dataset.topic)];
    topicFilter.querySelectorAll('button').forEach(chip => {
      chip.setAttribute('aria-pressed', String(chip === button));
    });
    renderSelection();
  });
  const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const dateLabel = at => new Date(at).toLocaleDateString('de-DE', { day: 'numeric', month: 'short', year: 'numeric' });
  const number = value => value.toLocaleString('de-DE');
  document.getElementById('journey-close').onclick = () => dialog.close();
  document.getElementById('journey-open').onclick = async () => {
    if (!sel.field) return;
    const field = sel.field;
    const id = ++requestId;
    document.getElementById('journey-field').textContent = field;
    selectedTopic = null;
    content.scrollTop = 0;
    topicFilter.scrollTop = 0;
    topicFilter.innerHTML = '<button class="journey-topic-chip" type="button" disabled aria-pressed="true">Alle Themen</button>';
    content.textContent = 'Deine Sterne werden geladen…';
    dialog.showModal();
    try {
      const response = await fetch(`/api/fields/${encodeURIComponent(field)}/questions`);
      if (!response.ok) throw new Error('load');
      const questions = await response.json();
      if (id !== requestId || !dialog.open) return;
      fieldQuestions = questions;
      topics = [...new Set(questions.map(q => q.topic))].sort((a,b) => a.localeCompare(b, 'de'));
      topicFilter.innerHTML = '<button class="journey-topic-chip" type="button" data-topic="" aria-pressed="true">Alle Themen</button>' + topics.map((topic, i) => `<button class="journey-topic-chip" type="button" data-topic="${i}" aria-pressed="false">${escape(topic || 'Ohne Thema')}</button>`).join('');
      renderSelection();
    } catch {
      if (id === requestId) content.textContent = 'Die Lernreise konnte nicht geladen werden. Schließe das Fenster und versuche es erneut.';
    }
  };
  function render(data, topic = null, scope = data) {
    const { events, legacy } = data;
    const { attempts, explored, total, undated } = scope;
    const activeDays = new Set(scope.events.map(event => journeyDay(event.at))).size;
    const coverage = total ? explored / total * 100 : 0;
    const days = new Map();
    events.forEach(event => {
      const key = journeyDay(event.at);
      if (!days.has(key)) days.set(key, []);
      days.get(key).push(event);
    });
    const latest = [...events, ...legacy].sort((a,b) => Date.parse(a.at) - Date.parse(b.at));
    const start = latest.length ? Date.parse(latest[0].at) : Date.now();
    const end = latest.length ? Date.parse(latest.at(-1).at) : start;
    // Same-day sessions still span the chart; a single star sits at the center.
    const x = at => end === start ? 500 : 55 + (Date.parse(at) - start) / (end - start) * 890;
    const color = q => ({ red: 'var(--wrong)', yellow: 'var(--partial)', green: 'var(--correct)' }[q.preparation] || 'var(--muted)');
    const stars = latest.map((event, i) => {
      const historical = !Object.hasOwn(event, 'score');
      const y = 140 + Math.sin(i * 2.39996) * (22 + (i % 13) * 5);
      const label = `${dateLabel(event.at)} · ${event.question.topic} · ${event.question.question}${historical ? ' · Älterer letzter Versuch' : ` · Bewertung: ${Math.round(event.score * 100)}%`}`;
      return `<circle class="journey-star ${historical ? 'journey-legacy' : ''} ${topic !== null && event.question.topic !== topic ? 'journey-muted' : ''}" cx="${x(event.at)}" cy="${y}" r="${historical ? 3 : 4}" style="--star-color:${color(event.question)}" tabindex="0" role="img" aria-label="${escape(label)}" data-detail="${escape(label)}"><title>${escape(label)}</title></circle>`;
    }).join('');
    const metrics = [[`${Math.round(coverage)}%`, topic === null ? 'des Feldes erkundet' : 'des Themas erkundet'], [number(explored), `von ${number(total)} Fragen`], [number(attempts), 'Antworten abgegeben'], [number(activeDays), 'dokumentierte Lerntage']];
    content.innerHTML = `<p class="journey-scope">${topic === null ? 'Statistik für alle Themen' : `Statistik für „${escape(topic || 'Ohne Thema')}“ · Andere Themen bleiben in den Diagrammen grau sichtbar.`}</p><div class="journey-metrics">${metrics.map(([value,label]) => `<div class="metric-box ${value === '0' || value === '0%' ? 'journey-empty-metric' : ''}"><span class="m-val">${value}</span><span class="m-lbl">${label}</span></div>`).join('')}</div>
      <section class="journey-galaxy"><h3>Deine Spuren im Wissensraum</h3><p>Jeder Stern ist ein Versuch. Seine Farbe zeigt den heutigen Vorbereitungsstand der Frage. Wähle einen Stern für Details. ${topic === null ? '' : `„${escape(topic || 'Ohne Thema')}“ ist hervorgehoben; andere Themen bleiben grau sichtbar.`}</p>
      <svg viewBox="0 0 1000 280" role="group" aria-label="Zeitachse deiner Versuche"><path d="M55 140 Q280 70 500 140 T945 140" fill="none" stroke="#b3a0de" stroke-opacity=".2"/>${stars}</svg>
      <div class="journey-axis"><span>${latest.length ? dateLabel(start) : 'Noch keine Versuche'}</span><span>${latest.length ? dateLabel(end) : ''}</span></div>
      <p id="journey-star-detail">${latest.length ? 'Dein Wissen hinterlässt Spuren.' : 'Dein erster beantworteter Versuch lässt hier einen Stern entstehen.'}</p></section>
      <section><h3>Jeder Schritt zählt</h3><div class="journey-milestones">${[25,50,75,100].map(pct => `<div class="journey-milestone ${coverage >= pct ? 'reached' : ''}"><strong>${pct}%</strong><span>${coverage >= pct ? 'Erreicht ✦' : `Noch ${Math.max(0, Math.ceil(total * pct / 100) - explored)} Fragen`}</span></div>`).join('')}</div></section>
      <section><h3>Dein letztes Jahr</h3><p>Abgegebene Antworten pro Tag · ${escape(Intl.DateTimeFormat().resolvedOptions().timeZone)}</p><div class="journey-calendar-scroll" tabindex="0" role="region" aria-label="Aktivität im letzten Jahr, horizontal scrollbar"><div class="journey-calendar" id="journey-calendar"></div></div><div class="journey-key" aria-label="Aktivität von weniger bis mehr"><span>Weniger</span>${[0,1,2,3,4].map(level => `<span class="journey-day level-${level}" aria-hidden="true"></span>`).join('')}<span>Mehr</span></div></section>
      <section><h3>Bewertungen im Verlauf</h3><p>Tagesdurchschnitt der dokumentierten Bewertungen. ${topic === null ? '' : 'Das ausgewählte Thema ist farbig, der Felddurchschnitt grau dargestellt. '}Die Fragen und ihre Schwierigkeit können sich unterscheiden.</p><div id="journey-trend"></div></section>
      <p class="journey-note">${undated ? `${number(undated)} ältere Antworten sind in den Gesamtzahlen enthalten, haben aber keine vollständige Versuchshistorie. Umrandete Sterne zeigen ihren letzten bekannten Zeitpunkt; sie zählen nicht zur täglichen Aktivität oder Bewertungskurve. ` : ''}Neue Versuche werden ab jetzt einzeln aufgezeichnet. Die Zahlen und Meilensteine beziehen sich auf ${topic === null ? 'das gesamte Feld' : 'das ausgewählte Thema'}; Fortschritt ist auf diesem Server gemeinsam gespeichert.</p>`;
    content.querySelectorAll('.journey-star').forEach(star => {
      const show = () => { document.getElementById('journey-star-detail').textContent = star.dataset.detail; };
      star.addEventListener('click', show);
      star.addEventListener('focus', show);
      star.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); show(); } });
    });
    const calendar = document.getElementById('journey-calendar');
    const dates = journeyCalendarDates();
    const peak = Math.max(1, ...dates.map(({date}) => days.get(journeyDay(date))?.length || 0));
    const cells = [];
    const columns = dates.at(-1).column - 1;
    calendar.style.setProperty('--calendar-weeks', columns);
    ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'].forEach((label, i) => {
      cells.push(`<span class="journey-weekday" style="grid-column:1;grid-row:${i + 2}">${label}</span>`);
    });
    let month = null;
    for (const {date: d, row, column} of dates) {
      const monthKey = `${d.getFullYear()}-${d.getMonth()}`;
      if (monthKey !== month) {
        cells.push(`<span class="journey-month" style="grid-column:${column};grid-row:1">${escape(d.toLocaleDateString('de-DE', {month:'short'}))}</span>`);
        month = monthKey;
      }
      const dayEvents = days.get(journeyDay(d)) || [];
      const count = dayEvents.length;
      const selectedCount = journeyTopicCount(dayEvents, topic);
      const level = count ? Math.max(1, Math.ceil(count / peak * 4)) : 0;
      const label = `${dateLabel(d)}: ${count} Antworten${topic === null ? '' : ` · ${selectedCount} im Thema „${topic || 'Ohne Thema'}“`}`;
      const highlight = topic !== null && count ? `--topic-share:${selectedCount / count * 100}%;` : '';
      cells.push(`<button type="button" class="journey-day level-${level} ${topic !== null && count ? 'journey-topic-day' : ''}" style="grid-column:${column};grid-row:${row};${highlight}" aria-label="${escape(label)}" title="${escape(label)}" data-detail="${escape(label)}"></button>`);
    }
    calendar.innerHTML = cells.join('') + '<div id="journey-day-detail" role="status">Wähle einen Tag für Details.</div>';
    calendar.querySelectorAll('button').forEach(button => {
      const show = () => { document.getElementById('journey-day-detail').textContent = button.dataset.detail; };
      button.onclick = show;
      button.onfocus = show;
    });
    const daily = [...days].sort(([a], [b]) => a.localeCompare(b));
    const trend = document.getElementById('journey-trend');
    if (!daily.length) { trend.textContent = 'Mit deinem nächsten Versuch beginnt deine Bewertungskurve.'; return; }
    const point = (day,i) => [daily.length === 1 ? 500 : 55 + i / (daily.length - 1) * 890, 155 - day[1].reduce((sum,e) => sum + e.score,0) / day[1].length * 130];
    const selectedDays = daily.map(([date, dayEvents], i) => ({date, i, events: dayEvents.filter(e => e.question.topic === topic)}));
    let connected = false;
    const selectedPath = selectedDays.map(day => {
      if (!day.events.length) { connected = false; return ''; }
      const [cx, cy] = point([day.date, day.events], day.i);
      const command = connected ? 'L' : 'M'; connected = true;
      return `${command}${cx},${cy}`;
    }).join(' ');
    const selectedCurve = topic === null ? '' : `<path d="${selectedPath}" fill="none" stroke="var(--accent-light)" stroke-width="3"/>${selectedDays.filter(d => d.events.length).map(day => {
      const [cx,cy] = point([day.date,day.events],day.i);
      return `<circle cx="${cx}" cy="${cy}" r="5" fill="var(--accent-light)"><title>${escape(day.date)} · ${escape(topic)}: ${Math.round((155-cy)/130*100)}% · ${day.events.length} Antworten</title></circle>`;
    }).join('')}`;
    trend.innerHTML = `<svg viewBox="0 0 1000 190" role="img" aria-label="Tagesdurchschnitt der Bewertungen von 0 bis 100 Prozent"><text x="4" y="30">100%</text><text x="4" y="160">0%</text><path d="M55 25H945 M55 155H945" stroke="var(--border2)"/><polyline points="${daily.map((day,i) => point(day,i).join(',')).join(' ')}" fill="none" stroke="${topic === null ? 'var(--accent-light)' : '#687084'}" stroke-width="2"/>${daily.map((day,i) => { const [cx,cy] = point(day,i); return `<circle cx="${cx}" cy="${cy}" r="4" fill="${topic === null ? 'var(--accent-light)' : '#687084'}"><title>${escape(day[0])}: ${Math.round((155-cy)/130*100)}% · ${day[1].length} Antworten</title></circle>`; }).join('')}${selectedCurve}</svg><div class="journey-axis"><span>${escape(daily[0][0])}</span><span>${escape(daily.at(-1)[0])}</span></div>`;
  }
}
