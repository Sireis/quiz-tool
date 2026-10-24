const assert = require('node:assert/strict');
const {test} = require('node:test');
const {readFileSync} = require('node:fs');
const {join} = require('node:path');
const vm = require('node:vm');

function setup() {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      hidden: false, disabled: false, value: '', textContent: '', innerHTML: '', style: {},
      classList: {toggle() {}, remove() {}}, setAttribute() {}, focus() { this.focused = true; },
    });
    return elements.get(id);
  };
  const requests = [];
  const responses = [];
  const context = {
    Date, localStorage: {getItem: () => null},
    document: {getElementById: element, querySelector: () => element('main'), addEventListener() {}},
    fetch: async url => {
      requests.push(url);
      const response = responses.shift();
      return {json: async () => await response};
    },
  };
  vm.createContext(context);
  vm.runInContext(readFileSync(join(__dirname, '../static/trainer.js'), 'utf8').replace(/init\(\);\s*$/, ''), context);
  vm.runInContext("sel.field = 'A / B'; updateChatGptLink = () => {}; mobileGoMain = () => {};", context);
  return {context, element, requests, responses, run: source => vm.runInContext(source, context)};
}

const question = id => ({id, topic: 'Topic', question: `Q${id}`, preparation: 'green'});

test('completed practice offers explicit extra practice and restores the answer form', async () => {
  const app = setup();
  app.responses.push({practice_complete: true, next_due: '2026-10-26T12:00:00Z'});
  await app.context.loadNextQuestion();
  assert.equal(app.element('practice-complete').hidden, false);
  assert.equal(app.element('answer-area').hidden, true);
  assert.equal(app.element('extra-practice-btn').focused, true);
  assert.match(app.element('practice-next-due').textContent, /26\.10\.2026/);
  assert.equal(app.run('currentQuestion'), null);
  app.responses.push(question(12));
  await app.context.loadNextQuestion(true);
  assert.match(app.requests[1], /&extra=1$/);
  assert.equal(app.element('practice-complete').hidden, true);
  assert.equal(app.element('answer-area').hidden, false);
  assert.equal(app.element('question-text').textContent, 'Q12');
  assert.equal(app.element('answer-input').focused, true);
});

test('recently shown questions are explained without claiming coverage is complete', async () => {
  const app = setup();
  app.responses.push({practice_complete: true, recent_only: true, next_due: null});
  await app.context.loadNextQuestion();
  assert.match(app.element('question-text').textContent, /gerade gesehen/);
  assert.equal(app.element('practice-next-due').textContent, '');
});

test('an obsolete completion response cannot hide a newer question', async () => {
  const app = setup();
  let resolveOld;
  app.responses.push(new Promise(resolve => { resolveOld = resolve; }), question(2));
  const old = app.context.loadNextQuestion();
  await app.context.loadNextQuestion();
  resolveOld({practice_complete: true});
  await old;
  assert.equal(app.element('practice-complete').hidden, true);
  assert.equal(app.run('currentQuestion.id'), 2);
});

test('jumping from statistics records the display using the active filter', async () => {
  const app = setup();
  app.run("sel.set = {name: 'Exam / special', bookmark: true};");
  app.responses.push(question(7));
  app.context.jumpToQuestion(7);
  await new Promise(resolve => setImmediate(resolve));
  const url = new URL(app.requests[0], 'https://trainer.test');
  assert.equal(url.pathname, '/api/fields/A%20%2F%20B/question');
  assert.equal(url.searchParams.get('filter'), 'Exam / special');
  assert.equal(url.searchParams.get('filter_type'), 'bookmark');
  assert.equal(url.searchParams.get('id'), '7');
  assert.equal(app.run('currentQuestion.id'), 7);
});
