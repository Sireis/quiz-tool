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
  const ids = Object.fromEntries(['dialog', 'svg', 'tooltip', 'status', 'open', 'close', 'field', 'minus', 'plus', 'fit', 'legend', 'preparation-legend']
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
  vm.createContext(context);
  vm.runInContext(readFileSync(join(__dirname, '../static/constellation-layout.js'), 'utf8'), context);
  vm.runInContext(readFileSync(join(__dirname, '../static/constellation.js'), 'utf8'), context);
  await ids['constellation-open'].events.click();
  const world = ids['constellation-svg'].children[0];
  return { ids, context, world, islands: world.children[0].children, links: world.children[1].children,
    edges: world.children[2].children,
    nodes: world.children[3].children.filter(item => item.attrs.class === 'constellation-node'),
    annotations: world.children[3].children.filter(item => item.attrs.class === 'island-annotation'), loads: () => quizLoads };
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

test('missing concepts preserve hierarchy, zoom and fit', async () => {
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
  const before = legacy.world.attrs.transform;
  legacy.ids['constellation-plus'].onclick();
  assert.notEqual(legacy.world.attrs.transform, before);
  legacy.ids['constellation-fit'].onclick();
  assert.equal(legacy.world.attrs.transform, before);
});

test('progress changes island saturation, while topic colors and positions stay fixed', async () => {
  const data = topics();
  const initial = await render(data);
  data[0].attempted = 0;
  data[1].preparation.rating = 'green';
  data[2].preparation.rating = 'red';
  data[0].children[0].preparation.rating = 'green';
  const updated = await render(data);
  assert.deepEqual(updated.nodes.map(n => n.attrs.transform), initial.nodes.map(n => n.attrs.transform));
  assert.deepEqual(updated.nodes.map(n => n.attrs.style), initial.nodes.map(n => n.attrs.style));
  assert.match(updated.islands[0].attrs.style, / 0% 38%/);
  assert.match(updated.islands[1].attrs.style, / 90% 65%/);
  assert.match(updated.islands[2].attrs.style, / 8% 42%/);
  assert.equal(updated.islands[0].children[0].attrs['stroke-dasharray'], '5 7');
  assert.equal(updated.nodes[0].attrs.style, updated.nodes[1].attrs.style);
  assert.notEqual(updated.nodes[0].attrs.style, updated.nodes[3].attrs.style);
  assert.equal(updated.ids['constellation-legend'].children.length, 3);
  assert.equal(updated.ids['constellation-preparation-legend'].children.length, 4);
  assert.ok(updated.annotations.every(item => item.children.every(child => child.attrs.class !== 'island-state-label')));
});

test('islands do not overlap and dense banks retain every node', async () => {
  const data = topics();
  data[0].children = Array.from({length: 168}, (_, i) => node(`Child ${i}`));
  const view = await render(data);
  assert.equal(view.nodes.length, 172);
  assert.equal(new Set(view.nodes.map(n => n.attrs.transform)).size, 172);
  const boxes = view.islands.map(island => {
    const attrs = island.children[0].attrs;
    return Object.fromEntries(['x', 'y', 'width', 'height'].map(key => [key, Number(attrs[key])]));
  });
  boxes.forEach((a, i) => boxes.slice(i + 1).forEach(b => {
    assert.ok(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y);
  }));
  assert.ok(view.nodes.every(n => !n.attrs.transform.includes('NaN')));
});

test('layout shortens crossed concept connections between topic islands', async () => {
  const data = [
    { ...node('A'), direct_concepts: [], children: [node('AX', ['X']), node('AY', ['Y'])] },
    { ...node('B'), direct_concepts: [], children: [node('BY', ['Y']), node('BX', ['X'])] },
  ];
  const optimized = await render(data);
  const plain = structuredClone(data);
  plain.forEach(topic => topic.children.forEach(child => { child.concepts = []; }));
  const baseline = await render(plain);
  const distance = (view, a, b) => {
    const point = index => view.nodes[index].attrs.transform.match(/[\d.]+/g).map(Number);
    const [ax, ay] = point(a), [bx, by] = point(b);
    return (ax - bx) ** 2 + (ay - by) ** 2;
  };
  assert.ok(distance(optimized, 1, 5) + distance(optimized, 2, 4) < distance(baseline, 1, 5) + distance(baseline, 2, 4));
  assert.equal(optimized.edges.length, 2);
});

test('preparation strips show partial progress even when the weakest question keeps the group red', async () => {
  const data = [{ ...node('Partial'), total: 10, attempted: 9,
    preparation: { rating: 'red', counts: { red: 1, yellow: 2, green: 7 } }, children: [] }];
  const view = await render(data);
  const annotation = view.annotations[0];
  assert.match(annotation.attrs['aria-label'], /Übungsbedarf/);
  const strip = annotation.children[0];
  assert.match(strip.attrs['aria-label'], /Übungsbedarf: 1, im Aufbau: 2, gut vorbereitet: 7/);
  const trackWidth = Number(strip.children[0].attrs.width);
  const segments = strip.children.slice(1, 4);
  assert.deepEqual(segments.map(segment => Number(segment.attrs.width) / trackWidth), [0.1, 0.2, 0.7]);
  assert.equal(annotation.children.length, 1);
  data[0].attempted = 0;
  data[0].preparation.counts = {red:10, yellow:0, green:0};
  const unattempted = await render(data);
  assert.match(unattempted.annotations[0].attrs['aria-label'], /Unversucht/);
  assert.equal(unattempted.annotations[0].children[0].children.length, 3);
});

test('fit uses the available canvas dimensions instead of a fixed aspect ratio', async () => {
  const view = await render(topics());
  const svg = view.ids['constellation-svg'];
  svg.clientWidth = 1800;
  svg.clientHeight = 900;
  const before = view.world.attrs.transform;
  view.ids['constellation-fit'].onclick();
  assert.equal(svg.attrs.viewBox, '0 0 1800 900');
  assert.notEqual(view.world.attrs.transform, before);
  view.ids['constellation-plus'].onclick();
  view.ids['constellation-fit'].onclick();
  assert.ok(!view.world.attrs.transform.includes('NaN'));
});
