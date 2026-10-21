const assert = require('node:assert/strict');
const {test} = require('node:test');
const {readFileSync} = require('node:fs');
const vm = require('node:vm');
const {join} = require('node:path');
const settle = () => new Promise(resolve => setImmediate(resolve));

function state(overrides = {}) {
  return {
    code: 'ABCDEF12', field: 'test', topic: null, mode: 'compete', closed: false,
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
      setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; },
      focus() {}, scrollIntoView() {}, showModal() { this.open = true; }, close() { this.open = false; },
    };
    if (id) elements.set(id, item);
    return item;
  }
  const storage = new Map(saved ? [['trainer_shared_room', JSON.stringify(saved)]] : []);
  const calls = [];
  let current = state();
  let poll;
  let discover;
  let available = [];
  const fetch = async (path, options) => {
    calls.push({path, options});
    if (path.endsWith('/draft')) current.draft = JSON.parse(options.body).answer;
    const body = path === '/api/rooms' && options?.method !== 'POST' ? structuredClone(available)
      : path === '/api/profiles' ? [{id: 'alice', name: 'Alice'}, {id: 'bob', name: 'Bob'}]
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
    setInterval(callback, delay) { if (delay === 2000) discover = callback; else poll = callback; },
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
    context, element, calls, storage, discover: () => discover(), setAvailable(value) { available = value; }, setState(value) { current = value; }, poll: () => poll(),
    async event(id, type) { await element(id).events[type]({preventDefault() {}}); await settle(); },
    async open() { await element('shared-open').events.click(); await settle(); },
    async start(mode = 'compete') {
      await this.open();
      element('shared-mode').value = mode;
      element('shared-topic').value = '';
      await this.event('shared-create-form', 'submit');
    },
  };
}

test('shared practice uses the normal question and answer frame without losing drafts', async () => {
  const app = await setup();
  await app.open();
  app.element('shared-profile').value = 'bob';
  app.element('shared-mode').value = 'compete';
  await app.event('shared-create-form', 'submit');
  const creation = app.calls.find(call => call.path === '/api/rooms' && call.options?.method === 'POST');
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
  assert.equal(app.element('shared-answer-cards').children.length, 2);
  assert.equal(app.element('shared-answer-cards').children[0].children[2].textContent, 'Answer 0');
  assert.equal(app.element('shared-answer-cards').children[1].children[2].textContent, 'Answer 1');
  assert.equal(app.element('shared-answer-cards').children[1].children[3].textContent, 'Feedback 1');
  assert.equal(app.element('shared-outcome').textContent, 'alice gewinnt diese Runde');
  assert.equal(app.element('answer-area').hidden, true);
  assert.equal(app.element('solo-result').hidden, true);
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

test('Join Room appears on discovery and joins only on click with the selected profile', async () => {
  const app = await setup();
  app.context.pageProfile = 'bob';
  app.setAvailable([{code: 'ABCDEF12', field: 'test', mode: 'coop'}]);
  await app.discover();
  assert.equal(app.element('shared-quick-join').hidden, false);
  assert.equal(app.calls.some(call => call.path.endsWith('/join')), false);
  assert.equal(app.context.sharedPractice.active, false);
  await app.event('shared-quick-join', 'click');
  const call = app.calls.find(call => call.path.endsWith('/join'));
  assert.equal(call.options.headers['X-Trainer-Profile'], 'bob');
  assert.equal(app.context.pageProfile, 'bob');
  assert.equal(app.element('shared-quick-join').hidden, true);
});

test('cooperative typing polls a shared draft and shows one shared assessment', async () => {
  const app = await setup();
  app.setState(state({mode: 'coop', draft: 'Partner started this', draft_revision: 1}));
  await app.start('coop');
  assert.equal(app.element('answer-input').value, 'Partner started this');
  assert.equal(app.element('answer-label').textContent, 'Eure gemeinsame Antwort');
  app.element('answer-input').value = 'Our combined answer';
  await app.event('answer-input', 'input');
  await app.poll();
  const save = app.calls.find(call => call.path.endsWith('/draft'));
  assert.equal(JSON.parse(save.options.body).answer, 'Our combined answer');
  assert.equal(app.element('answer-input').value, 'Our combined answer');
  app.setState(state({mode: 'coop', draft: 'Partner added another point', draft_revision: 3}));
  await app.poll();
  assert.equal(app.element('answer-input').value, 'Partner added another point');
  app.setState(state({
    mode: 'coop', revealed: true, draft: 'Final answer', own_answer: 'Final answer',
    reference_answer: 'Reference', team_preparation: {prepared: 2, total: 10},
    participants: ['alice', 'bob'].map(id => ({id, name: id, online: true, status: 'graded', ready: false,
      answer: 'Final answer', result: {score: 1, result: 'correct', correct: true, feedback: 'Shared feedback'}})),
  }));
  await app.poll();
  assert.equal(app.element('shared-answer-cards').children.length, 1);
  assert.equal(app.element('shared-answer-cards').children[0].children[2].textContent, 'Final answer');
  assert.equal(app.element('answer-area').hidden, true);
  assert.match(app.element('shared-summary').textContent, /2\/10/);
});
