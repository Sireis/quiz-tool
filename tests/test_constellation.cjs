const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');

// Exercise the SVG interaction logic without a browser or extra dependencies.
class Element {
  constructor() {
    this.children = [];
    this.attrs = {};
    this.events = {};
    this.classes = new Set();
    this.classList = { toggle: (name, enabled) => enabled ? this.classes.add(name) : this.classes.delete(name) };
    this.style = { setProperty() {} };
    this.offsetWidth = 250;
    this.offsetHeight = 90;
  }
  setAttribute(key, value) { this.attrs[key] = String(value); }
  append(...elements) { this.children.push(...elements); elements.forEach(el => el.parentElement = this); }
  replaceChildren(...elements) { this.children = []; this.append(...elements); }
  addEventListener(key, callback) { this.events[key] = callback; }
  getBoundingClientRect() { return { x: 0, y: 0, width: 1000, height: 640 }; }
  showModal() { this.open = true; }
  close() { this.open = false; this.events.close(); }
}

async function render(topics) {
  const ids = Object.fromEntries(['dialog', 'svg', 'tooltip', 'status', 'open', 'close', 'field', 'minus', 'plus', 'fit']
    .map(key => ['constellation-' + key, new Element()]));
  ids['constellation-svg'].parentElement = new Element();
  let quizLoads = 0;
  const context = {
    document: { getElementById: id => ids[id], createElementNS: () => new Element(), createElement: () => new Element() },
    sel: { field: 'Test' }, PREPARATION_LABELS: { red: 'Weak', yellow: 'Medium', green: 'Strong' },
    fetch: async () => ({ ok: true, json: async () => topics }),
    highlightSel() {}, updateHeaderCtx() {}, mobileGoMain() {}, refreshStats: async () => {},
    loadNextQuestion: async () => { quizLoads++; },
  };
  vm.runInNewContext(readFileSync(join(__dirname, '../static/constellation.js'), 'utf8'), context);
  await ids['constellation-open'].events.click();
  const world = ids['constellation-svg'].children[0];
  return { ids, context, world, links: world.children[0].children,
    edges: world.children[1].children, nodes: world.children[2].children, loads: () => quizLoads };
}

const node = (name, concepts = []) => ({ name, concepts, total: 2, attempted: 1, preparation: { rating: 'yellow' } });
const topics = () => [
  { ...node('Parent', ['Shared', 'Second', 'Unique']), direct_concepts: [], children: [node('Child', ['Shared', 'Second']), node('Sibling', ['Unique'])] },
  { ...node('Other', ['Shared', 'Second']), children: [] },
  { ...node('Unrelated'), children: [node('Child')] },
];

test('shared concepts connect distinct nodes once, without inherited parent duplicates', async () => {
  const view = await render(topics());
  assert.equal(view.links.length, 3);
  assert.equal(view.edges.length, 1);
  assert.match(view.edges[0].children[0].textContent, /Child ↔ Other: Shared, Second/);
  assert.ok(Number(view.edges[0].attrs['stroke-width']) > 1.3);
  view.nodes[1].events.focus();
  assert.ok(view.edges[0].classes.has('concept-link-active'));
  assert.ok(view.nodes[3].classes.has('concept-related'));
  assert.ok(!view.nodes[2].classes.has('concept-related'));
  assert.match(view.ids['constellation-tooltip'].children[3].textContent, /Shared · Second/);
  view.nodes[1].events.blur();
  assert.ok(!view.edges[0].classes.has('concept-link-active'));
  view.nodes[1].events.keydown({ key: 'Enter', preventDefault() {} });
  assert.equal(view.context.sel.topic, 'Parent');
  assert.equal(view.context.sel.subtopic, 'Child');
  assert.equal(view.loads(), 1);
});

test('direct topic concepts connect to subtopics and labels stay plain text', async () => {
  const data = topics();
  data[0].direct_concepts = ['Unique'];
  data[0].children[1].concepts = ['Unique', '<Concept>'];
  const view = await render(data);
  assert.equal(view.edges.length, 2);
  view.nodes[2].events.focus();
  assert.match(view.ids['constellation-tooltip'].children[3].textContent, /<Concept>/);
  assert.ok(view.edges.some(edge => edge.children[0].textContent === 'Parent ↔ Sibling: Unique'));
});

test('missing concepts preserve hierarchy and concept changes do not move nodes', async () => {
  const data = topics();
  const enriched = await render(data);
  data.forEach(topic => {
    delete topic.concepts;
    delete topic.direct_concepts;
    topic.children.forEach(child => { delete child.concepts; });
  });
  const legacy = await render(data);
  assert.equal(legacy.edges.length, 0);
  assert.equal(legacy.links.length, enriched.links.length);
  assert.deepEqual(legacy.nodes.map(n => n.attrs.transform), enriched.nodes.map(n => n.attrs.transform));
  const before = legacy.world.attrs.transform;
  legacy.ids['constellation-plus'].onclick();
  assert.notEqual(legacy.world.attrs.transform, before);
  legacy.ids['constellation-fit'].onclick();
  assert.equal(legacy.world.attrs.transform, before);
});
