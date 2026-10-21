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
    question: {id: 1, question: 'Shared question', topic: 'Topic'},
    participants: [
      {id: 'alice', name: 'Alice', status: 'answering', online: true, ready: false},
      {id: 'bob', name: 'Bob', status: 'answering', online: true, ready: false},
    ], revealed: false, own_answer: null, error: null, ...overrides,
  };
}

async function setup(saved = null, search = '') {
  const elements = new Map();
  function element(id = '') {
    if (id && elements.has(id)) return elements.get(id);
    const item = {
      value: '', textContent: '', disabled: false, hidden: false, children: [], events: {},
      addEventListener(name, callback) { this.events[name] = callback; },
      append(...children) { this.children.push(...children); },
      replaceChildren(...children) { this.children = children; if (children[0]?.value !== undefined) this.value = children[0].value; },
      select() {},
    };
    if (id) elements.set(id, item);
    return item;
  }
  const storage = new Map(saved ? [['trainer_shared_room', JSON.stringify(saved)]] : []);
  const calls = [];
  let current = state();
  let poll;
  const context = {
    URL, URLSearchParams, console,
    Option: function(text, value) { this.textContent = text; this.value = value; },
    location: {origin: 'http://trainer.test', search},
    localStorage: {getItem: key => key === 'trainer_profile' ? 'alice' : 'test'},
    sessionStorage: {getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key)},
    document: {getElementById: element, createElement: () => element(), querySelectorAll: () => [], hidden: false},
    navigator: {clipboard: {writeText: async () => {}}}, confirm: () => true,
    setInterval(callback) { poll = callback; },
    fetch: async (path, options) => {
      calls.push({path, options});
      const body = path === '/api/profiles' ? [{id: 'alice', name: 'Alice'}, {id: 'bob', name: 'Bob'}]
        : path === '/api/fields' ? ['test']
        : path.endsWith('/topics') ? ['Topic'] : structuredClone(current);
      return {ok: true, json: async () => body};
    },
  };
  vm.createContext(context);
  vm.runInContext(readFileSync(join(__dirname, '../static/together.js'), 'utf8'), context);
  await settle();
  return {
    element, calls, storage, setState(value) { current = value; },
    poll: () => poll(),
    async event(id, type) { element(id).events[type]({preventDefault() {}}); await settle(); },
  };
}

test('room creation binds selected profile; polling preserves drafts and hides results', async () => {
  const app = await setup();
  app.element('profile').value = 'bob';
  await app.event('create-form', 'submit');
  const creation = app.calls.find(call => call.path === '/api/rooms');
  assert.equal(creation.options.headers['X-Trainer-Profile'], 'bob');
  assert.equal(app.element('room').hidden, false);
  assert.equal(app.element('results').hidden, true);
  assert.equal(app.element('invite').value, 'http://trainer.test/together?room=ABCDEF12');
  app.element('answer').value = 'An unfinished draft';
  await app.poll();
  assert.equal(app.element('answer').value, 'An unfinished draft');
  assert.equal(JSON.parse(app.storage.get('trainer_shared_room')).profile, 'bob');
  await app.event('answer-form', 'submit');
  const submission = app.calls.find(call => call.path.endsWith('/submit'));
  assert.deepEqual(JSON.parse(submission.options.body), {round_id: 'round-1', answer: 'An unfinished draft'});
});

test('competition reveals scores together and next round clears the old answer', async () => {
  const app = await setup();
  await app.event('create-form', 'submit');
  app.element('answer').value = 'Old draft';
  app.setState(state({
    mode: 'compete', revealed: true, own_answer: 'Submitted answer', completed: 1,
    reference_answer: 'Reference solution',
    participants: ['alice', 'bob'].map((id, i) => ({
      id, name: id, online: true, status: 'graded', ready: false,
      answer: `Answer ${i}`, result: {score: i ? .5 : 1, feedback: 'Feedback', correct: !i},
      points: i ? 50 : 100, correct: i ? 0 : 1,
    })),
  }));
  await app.poll();
  assert.equal(app.element('results').hidden, false);
  assert.equal(app.element('answer-form').hidden, true);
  assert.equal(app.element('reference').textContent, 'Reference solution');
  assert.match(app.element('comparison').children[0].children[3].textContent, /100 Punkte/);
  assert.match(app.element('comparison').children[1].children[3].textContent, /50 Punkte/);
  app.setState(state({round_id: 'round-2', number: 2}));
  await app.poll();
  assert.equal(app.element('answer').value, '');
  assert.equal(app.element('results').hidden, true);
  assert.equal(app.element('answer-form').hidden, false);
});

test('invites require choosing a profile; an existing tab reconnects with its own profile', async () => {
  const invite = await setup(null, '?room=ABCDEF12');
  assert.equal(invite.element('code').value, 'ABCDEF12');
  assert.equal(invite.calls.some(call => call.path.endsWith('/join')), false);
  const reconnect = await setup({code: 'ABCDEF12', profile: 'bob'}, '?room=ABCDEF12');
  const call = reconnect.calls.find(call => call.path.endsWith('/join'));
  assert.equal(call.options.headers['X-Trainer-Profile'], 'bob');
  reconnect.setState(state({closed: true}));
  await reconnect.poll();
  assert.equal(reconnect.storage.has('trainer_shared_room'), false);
  assert.equal(reconnect.element('submit').disabled, true);
});
