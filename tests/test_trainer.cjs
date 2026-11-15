const assert = require('node:assert/strict');
const {test} = require('node:test');
const {readFileSync} = require('node:fs');
const {join} = require('node:path');
const vm = require('node:vm');
const settle = () => new Promise(resolve => setImmediate(resolve));
const question = id => ({id, topic: 'Lernen', question: `Frage ${id}`, preparation: 'red'});
const assessment = {result: 'correct', score: 1, answer: 'Referenz', feedback: 'Gut erklärt.', preparation: 'green', progress: {}};

function setup(storage = new Map(), profile = 'alice') {
  const elements = new Map(), events = {}, windowEvents = {};
  let document;
  const element = id => {
    if (!elements.has(id)) {
      const classes = new Set();
      elements.set(id, {
        id, value: '', textContent: '', innerHTML: '', hidden: false, disabled: false,
        style: {}, attrs: {}, inert: false, open: false,
        classList: {toggle(name, on) { on ? classes.add(name) : classes.delete(name); }, remove(name) { classes.delete(name); }, contains: name => classes.has(name)},
        setAttribute(name, value) { this.attrs[name] = value; }, removeAttribute(name) { delete this.attrs[name]; },
        focus() { if (!this.disabled) document.activeElement = this; },
        contains(other) { return other === this || other?.parent === this; },
      });
    }
    return elements.get(id);
  };
  document = {
    getElementById: element, activeElement: null,
    querySelector: selector => selector === 'dialog[open]' ? (element('dialog').open ? element('dialog') : null) : element('main'),
    querySelectorAll: () => [],
    addEventListener(type, callback) { (events[type] ||= []).push(callback); },
  };
  document.body = element('body');
  const calls = [], responses = [];
  const context = {
    Date, pageProfile: profile, window: {innerWidth: 1200}, document,
    localStorage: {getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key)},
    addEventListener(type, callback) { windowEvents[type] = callback; },
    confirm: () => false,
    fetch: async (url, options) => {
      calls.push({url, options});
      const response = responses.shift();
      return {ok: true, json: async () => await response};
    },
  };
  vm.createContext(context);
  vm.runInContext(readFileSync(join(__dirname, '../static/trainer.js'), 'utf8').replace(/init\(\);\s*$/, ''), context);
  vm.runInContext("sel.field='Psychologie'; updateChatGptLink=()=>{}; refreshStats=async()=>{}; refreshGoal=async()=>{};", context);
  return {
    context, element, calls, responses, storage, windowEvents,
    run: source => vm.runInContext(source, context),
    type(text) { element('answer-input').value = text; events.input.forEach(fn => fn({target: element('answer-input')})); },
    key(id = 'answer-input', key = 'Enter', ctrlKey = true) { events.keydown.forEach(fn => fn({target: element(id), key, ctrlKey, preventDefault() {}})); },
  };
}

test('solo drafts resume the same question after reload and remain scoped by profile, subject and question', async () => {
  const app = setup();
  app.context.displayQuestion(question(1)); app.type('Eigene Erklärung 🧠');
  app.responses.push(question(2)); await app.context.loadNextQuestion();
  app.type('Zweiter Entwurf');
  app.responses.push(question(1)); await app.context.jumpToQuestion(1);
  assert.equal(app.element('answer-input').value, 'Eigene Erklärung 🧠');
  app.context.saveAnswerDraft();
  const restored = setup(app.storage);
  restored.responses.push(question(1)); await restored.context.loadNextQuestion(false, true);
  assert.match(restored.calls[0].url, /&id=1$/);
  assert.equal(restored.element('answer-input').value, 'Eigene Erklärung 🧠');
  const other = setup(app.storage, 'bob'); other.context.displayQuestion(question(1));
  assert.equal(other.element('answer-input').value, '');
  restored.run("sel.field='Statistik'"); restored.context.displayQuestion(question(1));
  assert.equal(restored.element('answer-input').value, '');
});

test('failed question loads preserve the displayed question and draft and allow retry', async () => {
  const app = setup(); app.context.displayQuestion(question(1)); app.type('Behalten');
  app.responses.push({error: 'Netzwerkfehler'}); await app.context.loadNextQuestion();
  assert.equal(app.element('answer-input').value, 'Behalten');
  assert.equal(app.run('currentQuestion.id'), 1);
  assert.equal(app.element('question-text').textContent, 'Frage 1');
  assert.equal(app.element('question-retry').hidden, false);
  assert.equal(app.element('submit-btn').disabled, false);
  app.responses.push(question(2)); await app.context.retryQuestionLoad();
  assert.equal(app.run('currentQuestion.id'), 2);
  assert.equal(app.element('question-notice').hidden, true);
});

test('successful grading removes the draft without recreating it on next-question navigation', async () => {
  const app = setup(); app.context.displayQuestion(question(1)); app.type('Richtig');
  app.responses.push(assessment); await app.context.submitAnswer();
  assert.equal(app.context.readDraft('Psychologie', 1), null);
  assert.equal(app.element('answer-input').disabled, true);
  assert.equal(app.element('profile-select').disabled, false);
  assert.equal(app.element('chatgpt-followup').open, false);
  assert.equal(app.element('chatgpt-followup').hidden, false);
  assert.equal(app.context.document.activeElement.id, 'next-btn');
  app.responses.push(question(2)); await app.context.loadNextQuestion();
  assert.equal(app.context.readDraft('Psychologie', 1), null);
  assert.equal(app.element('answer-input').value, '');
});

test('Ctrl+Enter retries grading after failure rather than advancing or deleting the answer', async () => {
  const app = setup(); app.context.displayQuestion(question(1)); app.type('Noch einmal prüfen');
  app.responses.push({error: 'Dienst nicht erreichbar'}); await app.context.submitAnswer();
  assert.equal(app.run('answerState'), 'error');
  assert.equal(app.element('answer-input').disabled, false);
  assert.equal(app.context.document.activeElement.id, 'answer-input');
  app.responses.push(assessment); app.key(); await settle();
  assert.equal(app.calls.length, 2);
  assert.equal(app.calls[1].url, '/api/assess');
  assert.equal(JSON.parse(app.calls[1].options.body).answer, 'Noch einmal prüfen');
  assert.equal(app.run('currentQuestion.id'), 1);
  assert.equal(app.run('answerState'), 'complete');
});

test('secondary refresh failures preserve successful grading, clear draft and announce saved progress', async () => {
  const app = setup(); app.context.displayQuestion(question(1)); app.type('Antwort');
  app.run("refreshStats=async()=>{throw new Error('offline')}");
  app.responses.push(assessment); await app.context.submitAnswer();
  assert.match(app.element('result-verdict').textContent, /Richtig/);
  assert.match(app.element('answer-status').textContent, /bewertet und gespeichert/);
  assert.equal(app.run('answerState'), 'complete');
  assert.equal(app.context.readDraft('Psychologie', 1), null);
});

test('pending grading blocks repeated submission, reveal and navigation', async () => {
  const app = setup(); app.context.displayQuestion(question(1)); app.type('Antwort');
  let resolve; app.responses.push(new Promise(done => {resolve = done;}));
  const pending = app.context.submitAnswer();
  await app.context.submitAnswer(); await app.context.revealAnswer(); await app.context.loadNextQuestion();
  app.key();
  assert.equal(app.calls.length, 1);
  assert.equal(app.element('skip-btn').disabled, true);
  assert.equal(app.element('profile-select').disabled, true);
  resolve(assessment); await pending;
  assert.equal(app.element('skip-btn').disabled, false);
});

test('shortcut does not act in unrelated fields or open dialogs; empty answers explain the next action', async () => {
  const app = setup(); app.context.displayQuestion(question(1));
  await app.context.submitAnswer(); assert.match(app.element('answer-status').textContent, /zuerst deine Antwort/);
  app.type('Antwort'); app.key('chatgpt-prompt');
  app.element('dialog').open = true; app.key();
  assert.equal(app.calls.length, 0);
});

test('mobile navigation excludes offscreen controls and restores desktop access on resize', () => {
  const app = setup(); app.context.window.innerWidth = 390;
  app.context.mobileToggle('sidebar');
  assert.equal(app.element('sidebar').inert, false);
  assert.equal(app.element('stats-panel').inert, true);
  assert.equal(app.element('main').inert, true);
  assert.equal(app.context.document.activeElement.id, 'sidebar');
  assert.equal(app.element('mnav-sidebar').attrs['aria-expanded'], 'true');
  app.key('mnav-sidebar', 'Escape', false);
  assert.equal(app.element('sidebar').inert, true);
  assert.equal(app.element('main').inert, false);
  assert.equal(app.context.document.activeElement.id, 'mnav-main');
  app.context.window.innerWidth = 1200; app.windowEvents.resize();
  assert.equal(app.element('sidebar').inert, false);
  assert.equal(app.element('stats-panel').inert, true);
  app.context.toggleStatistics();
  assert.equal(app.element('stats-panel').inert, false);
  assert.equal(app.element('stats-toggle').attrs['aria-expanded'], 'true');
  app.context.toggleStatistics();
  assert.equal(app.context.document.activeElement.id, 'stats-toggle');
});

test('shared answers are never written into solo browser drafts', () => {
  const app = setup(); app.context.sharedPractice = {active: true};
  app.context.displayQuestion(question(1)); app.type('Private Wettbewerbsantwort');
  assert.equal(app.storage.size, 0);
});

test('blocked storage keeps the answer and requires confirmation before navigating', async () => {
  const app = setup(); app.context.displayQuestion(question(1));
  app.context.localStorage.setItem = () => {throw new Error('QuotaExceededError');};
  app.type('Nicht verlieren'); await app.context.loadNextQuestion();
  assert.equal(app.calls.length, 0);
  assert.equal(app.element('answer-input').value, 'Nicht verlieren');
  let prevented = false; const event = {preventDefault() {prevented = true;}};
  app.windowEvents.beforeunload(event);
  assert.equal(prevented, true);
  assert.match(app.element('draft-status').textContent, /nicht gespeichert/);
});

test('statistics drilldowns render native buttons for keyboard access', () => {
  const app = setup(), container = app.element('stats-scroll');
  const prep = {counts: {green: 0, yellow: 0, red: 1}};
  const stats = {total: 1, attempted: 0, preparation: prep, topics: [{name: 'Lernen', total: 1, preparation: prep}], questions: [{...question(1), attempts: 0}]};
  app.context.renderStats(stats, 'field', container);
  assert.match(container.innerHTML, /<button type="button" class="breakdown-row"/);
  app.context.renderStats(stats, 'topic', container);
  assert.match(container.innerHTML, /<button type="button" class="stats-q-item"/);
});

test('a failed subject change still submits the preserved answer to its original subject', async () => {
  const app = setup(); app.context.displayQuestion(question(1)); app.type('Psychologie-Antwort');
  app.run("sel.field='SKS'");
  app.responses.push({error: 'offline'}); await app.context.loadNextQuestion();
  app.responses.push(assessment); await app.context.submitAnswer();
  const submitted = JSON.parse(app.calls[1].options.body);
  assert.equal(submitted.field, 'Psychologie');
  assert.equal(submitted.answer, 'Psychologie-Antwort');
});

test('automatic mobile navigation does not steal focus from the newly displayed answer', () => {
  const app = setup(); app.context.window.innerWidth = 390;
  app.context.mobileToggle('sidebar'); app.context.displayQuestion(question(1));
  app.context.mobileGoMain();
  assert.equal(app.context.document.activeElement.id, 'answer-input');
  assert.equal(app.element('sidebar').inert, true);
});

test('tablet navigation keeps a full-width question and excludes offscreen statistics', () => {
  const app = setup(); app.context.window.innerWidth = 768;
  app.context.syncPracticePanels();
  assert.equal(app.element('sidebar').inert, true);
  assert.equal(app.element('stats-panel').inert, true);
  assert.equal(app.element('main').inert, false);
  app.context.mobileToggle('stats');
  assert.equal(app.element('stats-panel').inert, false);
  assert.equal(app.element('main').inert, true);
  app.key('mnav-stats', 'Escape', false);
  assert.equal(app.element('main').inert, false);
});

test('an assessment failure uses an explicit error state and clears stale success styling', () => {
  const app = setup(); app.context.displayQuestion(question(1));
  app.context.showRequestError(new Error('Dienst nicht erreichbar'));
  assert.equal(app.element('result-card').className, 'error');
  assert.equal(app.element('result-verdict').className, 'result-verdict fail');
  assert.equal(app.element('answer-input').disabled, false);
  app.context.showResult(assessment);
  assert.equal(app.element('result-card').className, 'correct');
});

test('the top statistics action opens and closes the compact statistics view', () => {
  const app = setup(); app.context.window.innerWidth = 390;
  app.context.toggleStatistics();
  assert.equal(app.element('stats-panel').inert, false);
  assert.equal(app.element('main').inert, true);
  assert.equal(app.element('stats-toggle').attrs['aria-expanded'], 'true');
  app.context.toggleStatistics();
  assert.equal(app.element('main').inert, false);
  assert.equal(app.element('stats-toggle').attrs['aria-expanded'], 'false');
});


test('statistics keeps its button content and labels the current toggle action', () => {
  const app = setup();
  const toggle = app.element('stats-toggle');
  toggle.textContent = 'Statistik';
  app.context.toggleStatistics();
  assert.equal(toggle.textContent, 'Statistik');
  assert.equal(toggle.attrs['aria-label'], 'Statistik schließen');
  app.context.toggleStatistics();
  assert.equal(toggle.attrs['aria-label'], 'Statistik anzeigen');
});


test('routine draft and assessment updates do not add redundant status messages', async () => {
  const app = setup();
  app.context.displayQuestion(question(1));
  app.type('Meine Antwort');
  assert.equal(app.element('draft-status').textContent, '');
  app.context.displayQuestion(question(1));
  assert.equal(app.element('answer-input').value, 'Meine Antwort');
  assert.equal(app.element('draft-status').textContent, '');
  let resolve;
  app.responses.push(new Promise(done => {resolve = done;}));
  const pending = app.context.submitAnswer();
  assert.equal(app.element('answer-status').textContent, '');
  assert.equal(app.element('loading').classList.contains('visible'), true);
  resolve(assessment);
  await pending;
  assert.equal(app.element('answer-status').textContent, '');
  assert.equal(app.element('draft-status').textContent, '');
  assert.match(app.element('result-verdict').textContent, /Richtig/);
  assert.equal(app.element('result-feedback').textContent, assessment.feedback);
});
