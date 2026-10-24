const {test} = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const vm = require('node:vm');

function setup() {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      textContent: '', value: '', disabled: false, children: [], listeners: {},
      append(node) { this.children.push(node); },
      replaceChildren() { this.children = []; },
      addEventListener(type, callback) { this.listeners[type] = callback; },
      showModal() { this.open = true; },
      close() { this.open = false; this.listeners.close?.(); },
      focus() { this.focused = true; }, select() { this.selected = true; },
      click() { this.clicked = true; },
    });
    return elements.get(id);
  };
  const calls = [];
  const copied = [];
  const downloads = [];
  const context = {
    sel: {field: 'Psychologie'}, Date, Map, Blob,
    document: {getElementById: element, createElement: tag => ({
      tag, children: [], textContent: '', append(node) { this.children.push(node); },
      click() { downloads.push(this); },
    })},
    navigator: {clipboard: {writeText: async value => copied.push(value)}},
    URL: {createObjectURL(blob) { downloads.push(blob); return 'blob:test'; }, revokeObjectURL() {}},
    fetch: async (url, options) => {
      calls.push({url, options});
      return {ok: true, json: async () => context.response};
    },
  };
  vm.createContext(context);
  vm.runInContext(readFileSync('static/learning-gaps.js', 'utf8'), context);
  return {context, element: id => element(`gaps-${id}`), calls, copied, downloads};
}

const attempt = {attempt_id: 'a1', question_id: 1, at: '2026-10-10T12:00:00Z',
  student_answer: '<script>answer</script>', question: 'Frage?', reference_answer: 'Referenz',
  feedback: 'Feedback', score: .5, evidence_type: 'individual'};
const report = {created_at: '2026-10-10T12:00:00Z', fingerprint: 'first', attempts: [attempt],
  summary: '<img onerror=alert(1)>', findings: [{title: '<b>Begriff</b>',
    description: 'Hinweis', status: 'tentative', next_step: 'Erklären',
    evidence: [{attempt_id: 'a1', quote: 'answer'}]}]};
const preview = (overrides = {}) => ({attempts: [attempt], available: 1, legacy_count: 5,
  fingerprint: 'first', prompt: 'Instructions\nOriginal answers < & >', report: null,
  max_attempts: 20, backend: 'gpt4all', ...overrides});
const facts = {subject: {attempted: 1, total: 2, completion_percent: 50,
  total_attempts: 3, success_rate: 67, preparation: {counts: {red: 1, yellow: 1, green: 0}}},
  topics: [{name: '<script>Topic</script>', attempted: 1, total: 2, success_rate: 67}], omitted_topics: 0};
function allText(node) {
  return [node.textContent, ...(node.children || []).map(allText)].join(' ');
}

test('opening only previews; copy and download export the full prompt without model calls', async () => {
  const app = setup();
  app.context.response = preview();
  await app.element('open').onclick();
  assert.equal(app.calls.length, 1);
  assert.equal(app.calls[0].options, undefined);
  assert.match(app.calls[0].url, /Psychologie\/learning-gaps$/);
  assert.equal(app.element('prompt').value, preview().prompt);
  assert.equal(app.element('analyze').disabled, false);
  await app.element('copy').onclick();
  assert.equal(app.copied[0], preview().prompt);
  app.element('download').onclick();
  assert.equal(await app.downloads[0].text(), preview().prompt);
  assert.equal(app.downloads[1].download, 'lernluecken-prompt.txt');
  assert.equal(app.calls.length, 1);
});

test('analysis submits the preview fingerprint and renders evidence as plain text', async () => {
  const app = setup();
  app.context.response = preview();
  await app.element('open').onclick();
  app.context.response = report;
  await app.element('analyze').onclick();
  assert.equal(app.calls[1].options.method, 'POST');
  assert.deepEqual(JSON.parse(app.calls[1].options.body), {fingerprint: 'first'});
  const output = allText(app.element('report'));
  assert.match(output, /<img onerror=alert\(1\)>/);
  assert.match(output, /<script>answer<\/script>/);
  assert.match(output, /Referenz/);
  assert.equal(app.element('analyze').disabled, false);
});

test('empty history disables analysis and export; clipboard failure selects the visible prompt', async () => {
  const app = setup();
  app.context.response = preview({attempts: [], available: 0});
  await app.element('open').onclick();
  for (const id of ['analyze', 'copy', 'download']) assert.equal(app.element(id).disabled, true);
  app.element('dialog').close();
  app.context.response = preview();
  await app.element('open').onclick();
  app.context.navigator.clipboard.writeText = async () => { throw Error('Denied'); };
  await app.element('copy').onclick();
  assert.equal(app.element('export').open, true);
  assert.equal(app.element('prompt').selected, true);
});

test('reports retain their original attempt count and explain deleted evidence', async () => {
  const app = setup();
  app.context.response = preview({attempts: [], available: 0, missing_count: 1,
    report: {...report, attempt_ids: ['a1'], attempts: []}});
  await app.element('open').onclick();
  const output = allText(app.element('report'));
  assert.match(output, /1 Antworten/);
  assert.match(output, /Beleg ist nicht mehr verfügbar/);
  assert.match(app.element('scope').textContent, /1 Antworten zu entfernten Fragen/);
  assert.match(app.element('status').textContent, /entfernten Fragen/);
});

test('deterministic progress and persistent resolved memories use the same dialog and export', async () => {
  const app = setup();
  app.context.response = preview({can_analyze: true, deterministic: facts,
    memory_count: 2, memory_context_count: 2, memory_attempt_count: 1, new_attempt_count: 1,
    report: {...report, findings: [{...report.findings[0], memory_id: 'memory-1',
      status: 'resolved', updated_at: '2026-10-11T12:00:00Z'}]}});
  await app.element('open').onclick();
  assert.match(allText(app.element('facts')), /1 von 2 Fragen/);
  assert.match(allText(app.element('facts')), /67% richtige Versuche/);
  assert.match(allText(app.element('facts')), /<script>Topic<\/script>/);
  assert.match(allText(app.element('report')), /Vorläufig aufgelöst/);
  assert.match(app.element('scope').textContent, /2 von 2 Erinnerungen/);
  assert.equal(app.calls.length, 1);
  await app.element('copy').onclick();
  assert.equal(app.copied[0], app.element('prompt').value);
});

test('external results use the same POST and keep the entered JSON when validation fails', async () => {
  const app = setup();
  app.context.response = preview({can_analyze: true, deterministic: facts});
  await app.element('open').onclick();
  app.element('result').value = JSON.stringify({...report, input_fingerprint: 'first'});
  const entered = app.element('result').value;
  app.context.fetch = async (url, options) => {
    app.calls.push({url, options});
    return {ok: false, json: async () => ({error: 'Belege ungültig'})};
  };
  await app.element('import').onclick();
  assert.deepEqual(JSON.parse(app.calls[1].options.body), {fingerprint: 'first', result: entered});
  assert.equal(app.element('result').value, entered);
  assert.equal(app.element('status').textContent, 'Belege ungültig');
  assert.equal(app.element('import').disabled, false);
  app.context.fetch = async () => ({ok: true, json: async () => report});
  await app.element('import').onclick();
  assert.match(allText(app.element('report')), /<b>Begriff<\/b>/);
});

test('legacy progress without answer texts remains available as deterministic context', async () => {
  const app = setup();
  app.context.response = preview({attempts: [], available: 0, can_analyze: true, deterministic: facts});
  await app.element('open').onclick();
  for (const id of ['analyze', 'copy', 'download', 'import']) assert.equal(app.element(id).disabled, false);
  assert.match(allText(app.element('facts')), /3 Versuche/);
});

test('failed analysis retains saved report and export; a stale response cannot overwrite a new dialog', async () => {
  const app = setup();
  app.context.response = preview({report});
  await app.element('open').onclick();
  const original = allText(app.element('report'));
  app.context.fetch = async () => ({ok: false, json: async () => ({error: 'Nicht verfügbar'})});
  await app.element('analyze').onclick();
  assert.equal(app.element('status').textContent, 'Nicht verfügbar');
  assert.equal(allText(app.element('report')), original);
  assert.equal(app.element('copy').disabled, false);
  let finish;
  app.context.fetch = () => new Promise(resolve => { finish = resolve; });
  const pending = app.element('analyze').onclick();
  assert.equal(app.element('analyze').disabled, true);
  app.element('dialog').close();
  app.context.sel.field = 'Other';
  app.context.fetch = async () => ({ok: true, json: async () => preview({fingerprint: 'new', report: null})});
  await app.element('open').onclick();
  finish({ok: true, json: async () => report});
  await pending;
  assert.equal(app.element('field').textContent, 'Other');
  assert.equal(app.element('report').children.length, 0);
  assert.equal(app.element('analyze').disabled, false);
});
