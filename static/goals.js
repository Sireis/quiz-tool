// A saved goal tracks every graded answer in the selected field automatically.
let goalState = null;
let goalField = null;
let goalRequest = 0;
let goalPreviewRequest = 0;
let goalExpanded = false;
let goalTrackerEnabled = false;
const goalTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
const GOAL_STRATEGIES = {
  steady: { label: 'Gleichmäßig', help: 'Verteile die nötige Übung möglichst gleichmäßig auf die verbleibenden Tage.' },
  increasing: { label: 'Langsam steigern', help: 'Starte mit weniger Antworten pro Tag und steigere das Pensum bis zum Zieldatum.' },
  frontloaded: { label: 'Mehr am Anfang', help: 'Übe am Anfang mehr und reduziere das Pensum zum Zieldatum hin.' },
};

function goalUrl(field, suffix = '') {
  return `/api/fields/${encodeURIComponent(field)}/goal${suffix}?timezone=${encodeURIComponent(goalTimezone)}`;
}

async function goalJson(field, options) {
  const response = await fetch(goalUrl(field), options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Lernziel konnte nicht geladen werden.');
  return data;
}

async function refreshGoal(field) {
  if (sel.field !== field) return;
  const id = ++goalRequest;
  if (goalField !== field) {
    goalField = field;
    try { goalTrackerEnabled = localStorage.getItem(`trainer_goal_visible:${field}`) === 'on'; }
    catch { goalTrackerEnabled = false; }
    goalState = null;
    goalExpanded = false;
    document.getElementById('header-goal').hidden = false;
    document.getElementById('header-goal-summary').hidden = true;
    document.getElementById('goal-disabled-label').hidden = false;
    document.getElementById('goal-disabled-label').textContent = 'Lernziel · Aus';
    document.getElementById('goal-expand').hidden = true;
    document.getElementById('goal-toggle').disabled = true;
    document.getElementById('goal-toggle').setAttribute('aria-checked', 'false');
    document.getElementById('goal-expand').setAttribute('aria-expanded', 'false');
    document.getElementById('goal-card').hidden = true;
    document.getElementById('goal-form').hidden = true;
    document.getElementById('goal-field').textContent = field;
    document.getElementById('goal-summary').textContent = 'Lade Lernziel…';
    document.getElementById('goal-edit').disabled = true;
    document.getElementById('goal-status').textContent = '';
  }
  try {
    const data = await goalJson(field);
    if (id !== goalRequest || sel.field !== field) return;
    goalState = data;
    renderFieldGoalPreview(field, data);
    renderGoal();
  } catch (error) {
    if (id !== goalRequest || sel.field !== field) return;
    document.getElementById('goal-summary').textContent = 'Lernziel nicht verfügbar.';
    document.getElementById('goal-status').textContent = error.message;
  }
}

// Sidebar previews do not change the selected field or header preference.
async function refreshFieldGoalPreview(field) {
  try { renderFieldGoalPreview(field, await goalJson(field)); }
  catch { /* Keep field selection available if a preview cannot be loaded. */ }
}

function fieldGoalPreview(goal) {
  const celebration = goalCelebration(goal);
  const percent = Math.min(100, celebration.percent);
  const count = goal.daily_target > 0 ? `${goal.today_count}/${goal.daily_target}` : `+${goal.today_count}`;
  const label = `Heute ${goal.today_count} Antworten, Tagesziel ${goal.daily_target}; ${goal.preparation_percent}% vorbereitet`;
  return { tier: celebration.tier, label,
    html: `<span class="field-goal-count">${count}<span class="field-goal-percent">${Math.round(celebration.percent)}%</span></span><span class="field-goal-bar" aria-hidden="true"><span style="width:${percent}%"></span></span>` };
}

function renderFieldGoalPreview(field, data) {
  const button = [...document.querySelectorAll('#fields-list .sel-btn')]
    .find(item => item.dataset.selKey === field);
  const preview = button?.querySelector('.field-goal-preview');
  if (!preview) return;
  preview.hidden = !data.goal;
  if (!data.goal) { preview.innerHTML = ''; return; }
  const view = fieldGoalPreview(data.goal);
  preview.dataset.tier = view.tier;
  preview.title = view.label;
  preview.setAttribute('aria-label', view.label);
  preview.innerHTML = view.html;
}

function goalCelebration(goal) {
  const percent = goal.daily_target > 0 ? goal.today_count / goal.daily_target * 100
    : goal.today_count > 0 ? 100 + goal.today_count * 20 : 0;
  if (percent >= 300) return { tier: 'aurora', label: 'Aurora', percent };
  if (percent >= 200) return { tier: 'rainbow', label: 'Regenbogen', percent };
  if (percent >= 150) return { tier: 'diamond', label: 'Diamant', percent };
  if (percent >= 125) return { tier: 'glow', label: 'Extra-Glanz', percent };
  if (percent >= 100) return { tier: 'achieved', label: 'Tagesziel erreicht', percent };
  return { tier: 'active', label: 'Dein Lernrhythmus', percent };
}

function renderGoal() {
  const { goal, total } = goalState;
  const summary = document.getElementById('goal-summary');
  const card = document.getElementById('goal-card');
  const edit = document.getElementById('goal-edit');
  const form = document.getElementById('goal-form');
  card.hidden = !goalExpanded;
  document.getElementById('header-goal').hidden = false;
  document.getElementById('header-goal').dataset.tier = 'off';
  document.getElementById('header-goal-summary').hidden = !goalTrackerEnabled || !goal;
  document.getElementById('goal-disabled-label').hidden = goalTrackerEnabled && !!goal;
  document.getElementById('goal-disabled-label').textContent = goalTrackerEnabled ? 'Lernziel einrichten' : 'Lernziel · Aus';
  document.getElementById('goal-expand').hidden = !goalTrackerEnabled || !goal;
  const toggle = document.getElementById('goal-toggle');
  toggle.disabled = total === 0;
  toggle.setAttribute('aria-checked', String(goalTrackerEnabled));
  const toggleLabel = goalTrackerEnabled ? 'Lernziel-Tracker ausschalten' : 'Lernziel-Tracker einschalten';
  toggle.setAttribute('aria-label', toggleLabel);
  toggle.title = toggleLabel;
  document.getElementById('goal-expand').setAttribute('aria-expanded', String(goalExpanded));
  edit.hidden = !goal;
  edit.disabled = total === 0;
  edit.textContent = goal ? 'Bearbeiten' : 'Lernziel setzen';
  if (!goal) {
    card.dataset.tier = 'empty';
    summary.textContent = 'Bis wann möchtest du dieses Feld lernen? Wähle ein Datum und einen Lernrhythmus – wir berechnen dein tägliches Pensum.';
    return;
  }
  const celebration = goalCelebration(goal);
  card.dataset.tier = celebration.tier;
  document.getElementById('header-goal').dataset.tier = goalTrackerEnabled ? celebration.tier : 'off';
  const deadline = goal.days_remaining < 0 ? `Zieldatum vor ${-goal.days_remaining} Tagen`
    : goal.days_remaining === 0 ? 'Zieldatum heute' : `${goal.days_remaining} Tage verbleibend`;
  const date = new Date(`${goal.target_date}T12:00:00`).toLocaleDateString('de-DE');
  const bonus = goal.overachievement;
  const status = bonus > 0 ? `${bonus} Antwort${bonus === 1 ? '' : 'en'} über deinem Tagesziel`
    : goal.daily_target === 0 ? 'Alles vorbereitet – jede weitere Antwort ist Bonus.'
      : goal.daily_complete ? 'Tagesziel erreicht. Jede weitere Antwort zählt weiter!'
        : `Noch ${goal.daily_remaining} Antwort${goal.daily_remaining === 1 ? '' : 'en'} bis zum Tagesziel`;
  const ringNumber = goal.daily_target > 0 ? `${Math.round(celebration.percent)}%`
    : goal.today_count > 0 ? `+${goal.today_count}` : '✓';
  const ringLabel = goal.daily_target > 0 ? 'Tagesziel' : goal.today_count > 0 ? 'Bonusantworten' : 'Vorbereitet';
  const compactDate = new Date(`${goal.target_date}T12:00:00`).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
  document.getElementById('header-goal-summary').innerHTML = `
    <div class="goal-header-metrics"><span>Heute <strong>${goal.today_count}${goal.daily_target ? ` / ${goal.daily_target}` : ' Bonus'}</strong></span><span class="goal-header-prepared">${goal.preparation_percent}% bereit</span>${bonus > 0 ? `<span class="goal-header-bonus">+${bonus}</span>` : ''}</div>
    <div class="goal-header-deadline"><span>${compactDate} · ${goal.days_remaining < 0 ? `${-goal.days_remaining} Tage überfällig` : goal.days_remaining === 0 ? 'Heute fällig' : `${goal.days_remaining} Tage`}</span><span class="goal-header-tier">${celebration.percent >= 100 ? celebration.label : GOAL_STRATEGIES[goal.strategy || 'steady'].label}</span></div>
    <div class="goal-header-progress-row"><span class="goal-header-progress-label">${goal.daily_target ? `Tagesziel ${Math.round(celebration.percent)}%` : 'Bonus'}</span><div class="goal-header-progress" role="progressbar" aria-label="Tagesziel" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.min(100, Math.round(celebration.percent))}" aria-valuetext="${goal.today_count} Antworten; ${status}"><span style="width:${Math.min(100, celebration.percent)}%"></span></div></div>`;
  const expand = document.getElementById('goal-expand');
  const expandLabel = goalExpanded ? 'Lernziel zuklappen' : 'Lernziel aufklappen';
  expand.setAttribute('aria-label', expandLabel);
  expand.title = expandLabel;
  const counts = goal.preparation_counts;
  const segments = ['green', 'yellow', 'red'].map(color =>
    `<span class="goal-segment goal-segment-${color}" style="width:${total ? counts[color] / total * 100 : 0}%"></span>`).join('');
  summary.innerHTML = `
    <div class="goal-meta">${date} · ${deadline} · ${GOAL_STRATEGIES[goal.strategy || 'steady'].label}</div>
    <div class="goal-today">
      <div class="goal-ring" style="--goal-fill:${Math.min(100, celebration.percent)}%" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.min(100, Math.round(celebration.percent))}" aria-valuetext="${goal.today_count} von ${goal.daily_target} Antworten; ${status}">
        <div class="goal-ring-core"><strong>${ringNumber}</strong><span>${ringLabel}</span></div>
        <svg class="goal-gem" viewBox="0 0 48 40" aria-hidden="true"><path d="M10 3h28l8 12-22 23L2 15Z"/><path d="M10 3l6 12 8 23 8-23 6-12M2 15h44M16 15l8-12 8 12"/></svg>
      </div>
      <div class="goal-today-details">
        <span class="goal-tier-label">${celebration.label}</span>
        <div class="goal-answer-count"><strong>${goal.today_count}</strong><span>${goal.daily_target ? `/ ${goal.daily_target}` : 'Bonus'} Antworten heute</span></div>
        <p class="goal-daily-status">${status}</p>
        <div class="goal-bonus-track" aria-hidden="true">${[100, 125, 150, 200, 300].map((threshold, index) =>
          `<span class="${celebration.percent >= threshold ? 'unlocked' : ''}" title="${threshold}%">${index >= 2 ? '◆' : '✦'}</span>`).join('')}</div>
        <span class="goal-tracking-note">Alle Antworten in diesem Feld zählen automatisch.</span>
      </div>
    </div>
    <div class="goal-preparation">
      <div class="goal-progress-label"><strong>${goal.preparation_percent}% gut vorbereitet</strong><span>${goal.prepared} / ${total} Fragen</span></div>
      <div class="goal-preparation-bar" role="progressbar" aria-label="Gut vorbereitete Fragen" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${goal.preparation_percent}">${segments}</div>
      <div class="goal-preparation-legend"><span><i class="goal-dot-red"></i>${counts.red} offen</span><span><i class="goal-dot-yellow"></i>${counts.yellow} in Übung</span><span><i class="goal-dot-green"></i>${counts.green} sicher</span></div>
    </div>
    <p class="goal-help">${goal.complete ? 'Alle Fragen sind gut vorbereitet. Wiederholen festigt dein Wissen.' : goal.days_remaining <= 0 ? 'Noch offene Fragen: Passe dein Zieldatum an oder übe weiter.' : 'Grün: mindestens zweimal richtig und zuletzt richtig.'} Dein Tagesziel bleibt heute fest; dein Fortschritt fließt in das Pensum der nächsten Tage ein.</p>`;
}

function openGoalForm() {
  if (!goalState) return;
  const { goal, today } = goalState;
  const form = document.getElementById('goal-form');
  form.hidden = false;
  goalExpanded = true;
  renderGoal();
  document.getElementById('goal-card').hidden = false;
  form.dataset.field = sel.field;
  const dateInput = document.getElementById('goal-date');
  dateInput.min = today;
  const suggestedDate = new Date(`${today}T12:00:00Z`);
  suggestedDate.setUTCDate(suggestedDate.getUTCDate() + 30);
  dateInput.value = goal?.target_date || suggestedDate.toISOString().slice(0, 10);
  document.getElementById('goal-strategy').value = goal?.strategy || 'steady';
  document.getElementById('goal-delete').hidden = !goal;
  document.getElementById('goal-status').textContent = '';
  mobileGoMain();
  dateInput.focus();
  return refreshGoalPreview();
}

function closeGoalForm() {
  document.getElementById('goal-form').hidden = true;
  if (!goalState?.goal) return closeGoalDetails();
  renderGoal();
}

function toggleGoalDetails() {
  if (!goalState?.goal || !goalTrackerEnabled) return;
  if (goalExpanded) return closeGoalDetails();
  goalExpanded = true;
  renderGoal();
  document.getElementById('goal-card').focus();
}

function setGoalTrackerEnabled(enabled) {
  goalTrackerEnabled = enabled;
  try { localStorage.setItem(`trainer_goal_visible:${sel.field}`, enabled ? 'on' : 'off'); }
  catch { /* Storage is optional. */ }
}

function toggleGoalTracker() {
  if (!goalState || goalState.total === 0) return;
  setGoalTrackerEnabled(!goalTrackerEnabled);
  if (!goalTrackerEnabled) {
    goalExpanded = false;
    document.getElementById('goal-form').hidden = true;
  } else if (!goalState.goal) return openGoalForm();
  renderGoal();
}

function closeGoalDetails(restoreFocus = true) {
  if (!goalExpanded) return;
  goalExpanded = false;
  if (!goalState?.goal) {
    document.getElementById('goal-form').hidden = true;
    setGoalTrackerEnabled(false);
  }
  renderGoal();
  if (restoreFocus) document.getElementById(goalState?.goal ? 'goal-expand' : 'goal-toggle').focus();
}

async function refreshGoalPreview() {
  const id = ++goalPreviewRequest;
  const field = sel.field;
  const form = document.getElementById('goal-form');
  const preview = document.getElementById('goal-preview');
  const dateInput = document.getElementById('goal-date');
  const strategy = document.getElementById('goal-strategy').value;
  document.getElementById('goal-strategy-help').textContent = GOAL_STRATEGIES[strategy].help;
  if (!dateInput.value || (dateInput.validity && !dateInput.validity.valid)) {
    preview.textContent = 'Wähle ein gültiges Zieldatum für die Berechnung.';
    return;
  }
  preview.textContent = 'Berechne dein Pensum…';
  try {
    const response = await fetch(goalUrl(field, '/preview') +
      `&target_date=${encodeURIComponent(dateInput.value)}&strategy=${encodeURIComponent(strategy)}`);
    const data = await response.json();
    if (id !== goalPreviewRequest || field !== sel.field || form.hidden) return;
    if (!response.ok) throw new Error(data.error || 'Pensum konnte nicht berechnet werden.');
    preview.textContent = data.complete ? 'Alle Fragen sind bereits gut vorbereitet.'
      : `Heute ca. ${data.daily_target} bewertete Antworten (${data.daily_remaining} noch offen). Insgesamt fehlen mindestens ${data.remaining_work} richtige Antworten bis Grün. Heute und das Zieldatum zählen als Lerntage.`;
  } catch (error) {
    if (id === goalPreviewRequest && field === sel.field && !form.hidden) preview.textContent = error.message;
  }
}

async function mutateGoal(remove = false) {
  const form = document.getElementById('goal-form');
  const field = form.dataset.field;
  if (field !== sel.field) return;
  const buttons = [...form.querySelectorAll('button')];
  buttons.forEach(button => { button.disabled = true; });
  const status = document.getElementById('goal-status');
  status.textContent = '';
  try {
    await goalJson(field, {
      method: remove ? 'DELETE' : 'PUT',
      headers: { 'Content-Type': 'application/json' },
      ...(remove ? {} : { body: JSON.stringify({
        target_date: document.getElementById('goal-date').value,
        strategy: document.getElementById('goal-strategy').value,
        timezone: goalTimezone,
      }) }),
    });
    if (sel.field !== field) return;
    form.hidden = true;
    goalExpanded = false;
    setGoalTrackerEnabled(!remove);
    await refreshGoal(field);
    status.textContent = remove ? 'Lernziel entfernt.' : 'Lernziel gespeichert.';
    if (sel.field === field && !remove) document.getElementById('goal-expand').focus();
  } catch (error) {
    if (sel.field === field) status.textContent = error.message;
  } finally {
    buttons.forEach(button => { button.disabled = false; });
  }
}

document.getElementById('goal-expand').onclick = toggleGoalDetails;
document.getElementById('goal-toggle').onclick = toggleGoalTracker;
document.getElementById('goal-close').onclick = () => closeGoalDetails();
document.getElementById('goal-edit').onclick = openGoalForm;
document.getElementById('goal-cancel').onclick = closeGoalForm;
document.getElementById('goal-delete').onclick = () => mutateGoal(true);
document.getElementById('goal-form').onsubmit = event => { event.preventDefault(); return mutateGoal(); };
document.getElementById('goal-date').onchange = refreshGoalPreview;
document.getElementById('goal-strategy').onchange = refreshGoalPreview;
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && sel.field) refreshGoal(sel.field);
});

document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && goalExpanded) {
    event.preventDefault();
    closeGoalDetails();
  }
});
document.addEventListener('click', event => {
  if (goalExpanded && !event.target.closest('#goal-card, #header-goal')) closeGoalDetails(false);
});
