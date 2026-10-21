const assert = require('node:assert/strict');
const {test} = require('node:test');
const {readFileSync} = require('node:fs');
const vm = require('node:vm');
const {join} = require('node:path');
const settle = () => new Promise(resolve => setImmediate(resolve));

function state(overrides = {}) {
  return {
    code: 'ABCDEF12', field: 'test', topic: null, mode: 'coop', closed: false,
    round_id: 'round-1', number: 1, completed: 0,
    question: {id: 1, question: 'Shared question', topic: 'Topic', preparation: 'red', progress: {}, bookmarked: false},
    participants: [
      {id: 'alice', name: 'Alice', status: 'answering', online: true, ready: false},
      {id: 'bob', name: 'Bob', status: 'answering', online: true, ready: false},
    ], revealed: false, own_answer: null, error: null, ...overrides,
  };
}

async function setup(saved = null, search = '', pathname = '/') {
  const elements = new Map();
  function element(id = '') {
    if (id && elements.has(id)) return elements.get(id);
    const classes = new Set();
    const item = {
      value: '', textContent: '', disabled: false, hidden: false, innerHTML: '', style: {},
      children: [], events: {}, dataset: {}, attrs: {},
      classList: {toggle(name, on) { on ? classes.add(name) : classes.delete(name); }, remove(name) { classes.delete(name); }, contains: name => classes.has(name)},
      get options() { return this.children; },
      addEventListener(name, callback) { this.events[name] = callback; },
      append(...children) { this.children.push(...children); },
      appendChild(child) { this.children.push(child); },
      replaceChildren(...children) { this.children = children; if (children[0]?.value !== undefined) this.value = children[0].value; },
      setAttribute(name, value) { this.attrs[name] = value; },
      removeAttribute(name) { delete this.attrs[name]; },
      focus() {}, scrollIntoView() {}, showModal() { this.open = true; }, close() { this.open = false; },
    };
    if (id) elements.set(id, item);
    return item;
  }
  const storage = new Map(saved ? [['trainer_shared_room', JSON.stringify(saved)]] : []);
  const calls = [];
  let current = state();
  let poll;
  const fetch = async (path, options) => {
    calls.push({path, options});
    const body = path === '/api/profiles' ? [{id: 'alice', name: 'Alice'}, {id: 'bob', name: 'Bob'}]
      : path.endsWith('/topics') ? ['Topic']
      : path.includes('/api/rooms') ? structuredClone(current)
      : path.includes('/question') ? current.question : [];
    return {ok: true, json: async () => body};
  };
  const context = {
    URL, URLSearchParams, console, pageProfile: 'alice', originalFetch: fetch, fetch,
    Option: function(text, value) { this.textContent = text; this.value = value; },
    location: {origin: 'http://trainer.test', search, pathname},
    history: {replaceState() {}},
    localStorage: {getItem: key => key === 'trainer_profile' ? 'alice' : 'test', setItem() {}},
    sessionStorage: {getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key)},
    document: {getElementById: element, createElement: () => element(),
      querySelector: () => element('main'), querySelectorAll: () => [], addEventListener() {}, hidden: false},
    navigator: {clipboard: {writeText: async () => {}}}, confirm: () => true,
    setInterval(callback) { poll = callback; },
  };
  vm.createContext(context);
  vm.runInContext(readFileSync(join(__dirname, '../static/trainer.js'), 'utf8').replace(/init\(\);\s*$/, ''), context);
  vm.runInContext(`
    sel.field = 'test';
    refreshStats = async () => {};
    refreshGoal = async () => {};
    loadTopics = loadExamens = loadSets = loadBookmarks = async () => {};
    highlightSel = updateHeaderCtx = mobileGoMain = () => {};
  `, context);
  vm.runInContext(readFileSync(join(__dirname, '../static/together.js'), 'utf8'), context);
  await context.sharedPractice.init(['test']);
  await settle();
  return {
    context, element, calls, storage, setState(value) { current = value; }, poll: () => poll(),
    async event(id, type) { await element(id).events[type]({preventDefault() {}}); await settle(); },
    async open() { await element('shared-open').events.click(); await settle(); },
    async start() {
      await this.open();
      element('shared-mode').value = 'coop';
      element('shared-topic').value = '';
      await this.event('shared-create-form', 'submit');
    },
  };
}

test('shared practice uses the normal question and answer frame without losing drafts', async () => {
  const app = await setup();
  await app.open();
  app.element('shared-profile').value = 'bob';
  app.element('shared-mode').value = 'coop';
  await app.event('shared-create-form', 'submit');
  const creation = app.calls.find(call => call.path === '/api/rooms');
  assert.equal(creation.options.headers['X-Trainer-Profile'], 'bob');
  assert.equal(app.context.pageProfile, 'bob');
  assert.equal(app.element('profile-select').value, 'bob');
  assert.equal(app.element('profile-select').disabled, true);
  assert.equal(app.element('shared-room').hidden, false);
  assert.equal(app.element('question-text').textContent, 'Shared question');
  assert.equal(app.element('reveal-btn').hidden, true);
  assert.equal(app.element('skip-btn').hidden, true);
  app.element('answer-input').value = 'An unfinished draft';
  await app.poll();
  assert.equal(app.element('answer-input').value, 'An unfinished draft');
  await app.context.submitAnswer();
  const submission = app.calls.find(call => call.path.endsWith('/submit'));
  assert.deepEqual(JSON.parse(submission.options.body), {round_id: 'round-1', answer: 'An unfinished draft'});
  assert.equal(app.calls.some(call => call.path === '/api/assess'), false);
  await app.context.revealAnswer();
  await app.context.loadNextQuestion();
  assert.equal(app.calls.some(call => call.path.endsWith('/ready') || call.path === '/api/reveal-answer'), false);
});

test('own feedback reuses the standard result card, partner feedback and scores reveal together', async () => {
  const app = await setup();
  await app.start();
  app.setState(state({
    mode: 'compete', revealed: true, own_answer: 'Submitted answer', completed: 1,
    reference_answer: 'Reference solution',
    participants: ['alice', 'bob'].map((id, i) => ({
      id, name: id, online: true, status: 'graded', ready: false,
      answer: `Answer ${i}`, result: {score: i ? .5 : 1, feedback: `Feedback ${i}`, correct: !i, result: i ? 'partially_correct' : 'correct'},
      points: i ? 50 : 100, correct: i ? 0 : 1,
    })),
  }));
  await app.poll();
  assert.equal(app.element('result-card').style.display, 'block');
  assert.equal(app.element('result-feedback').textContent, 'Feedback 0');
  assert.equal(app.element('score-bar').style.width, '100%');
  assert.equal(app.element('expected-answer-text').textContent, 'Reference solution');
  assert.equal(app.element('shared-comparison').hidden, false);
  assert.equal(app.element('shared-partner-answer').textContent, 'Answer 1');
  assert.equal(app.element('shared-partner-feedback').textContent, 'Feedback 1');
  assert.match(app.element('shared-summary').textContent, /alice: 100 Punkte · bob: 50 Punkte/);
  app.element('chatgpt-prompt').value = 'My edited follow-up';
  await app.poll();
  assert.equal(app.element('chatgpt-prompt').value, 'My edited follow-up');
  await app.context.loadNextQuestion();
  assert.equal(app.calls.some(call => call.path.endsWith('/ready')), true);
  app.setState(state({round_id: 'round-2', number: 2}));
  await app.poll();
  assert.equal(app.element('answer-input').value, '');
  assert.equal(app.element('result-card').style.display, 'none');
  assert.equal(app.element('shared-comparison').hidden, true);
});

test('room selection is locked and returning to solo restores normal controls', async () => {
  const app = await setup();
  await app.start();
  await app.context.selectField('different');
  await app.context.selectTopic('different');
  app.context.jumpToQuestion(2);
  assert.equal(vm.runInContext('sel.field', app.context), 'test');
  assert.equal(vm.runInContext('sel.topic', app.context), null);
  app.setState(state({closed: true}));
  await app.poll();
  assert.equal(app.element('shared-solo').hidden, false);
  assert.equal(app.storage.has('trainer_shared_room'), false);
  await app.event('shared-solo', 'click');
  assert.equal(app.context.sharedPractice.active, false);
  assert.equal(app.element('reveal-btn').hidden, false);
  assert.equal(app.element('skip-btn').hidden, false);
  assert.equal(app.element('profile-select').disabled, false);
  assert.equal(app.element('shared-room').hidden, true);
  assert.equal(app.element('submit-btn').textContent, 'Antwort prüfen');
  assert.equal(app.calls.some(call => call.path.includes('/question')), true);
});

test('invites open the room dialog and existing tabs reconnect with their own profile', async () => {
  const invite = await setup(null, '?room=ABCDEF12', '/together');
  assert.equal(invite.element('shared-code').value, 'ABCDEF12');
  assert.equal(invite.element('shared-dialog').open, true);
  assert.equal(invite.calls.some(call => call.path.endsWith('/join')), false);
  const reconnect = await setup({code: 'ABCDEF12', profile: 'bob'}, '?room=ABCDEF12', '/together');
  const call = reconnect.calls.find(call => call.path.endsWith('/join'));
  assert.equal(call.options.headers['X-Trainer-Profile'], 'bob');
  assert.equal(reconnect.element('shared-dialog').open, false);
  assert.equal(reconnect.context.pageProfile, 'bob');
});
