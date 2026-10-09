const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');

// Exercise SVG geometry and interaction without a browser or added dependencies.
class Element {
  constructor(tag) {
    this.tag = tag; this.children = []; this.attrs = {}; this.events = {}; this.classes = new Set();
    this.classList = { toggle: (name, enabled) => enabled ? this.classes.add(name) : this.classes.delete(name) };
    this.styles = {};
    this.style = { setProperty: (key, value) => { this.styles[key] = value; } };
    this.captured = new Set();
  }
  setAttribute(key, value) { this.attrs[key] = String(value); }
  append(...elements) { this.children.push(...elements); elements.forEach(el => el.parentElement = this); }
  replaceChildren(...elements) { this.children = []; this.append(...elements); }
  addEventListener(key, callback) { this.events[key] = callback; }
  showModal() { this.open = true; }
  close() { this.open = false; this.events.close(); }
  focus() { this.focused = true; }
  getScreenCTM() { return { inverse() { return {}; } }; }
  setPointerCapture(id) { this.captured.add(id); }
  hasPointerCapture(id) { return this.captured.has(id); }
}
const event = extra => ({ stopPropagation() {}, preventDefault() {}, ...extra });
const activate = el => (el.events.click || el.onclick)(event());
const node = (name, concepts = []) => ({ name, concepts, total: 2, attempted: 1,
  preparation: { rating: 'yellow', counts: { red: 1, yellow: 1, green: 0 } } });
const topics = () => [
  { ...node('Parent', ['Shared', 'Second', 'Unique']), direct_concepts: [], children: [node('Child', ['Shared', 'Second']), node('Sibling', ['Unique'])] },
  { ...node('Other', ['Shared', 'Second']), children: [] },
  { ...node('Unrelated'), children: [node('Child')] },
];
async function render(data = topics(), dimensions = {}) {
  const ids = Object.fromEntries(['dialog', 'svg', 'status', 'open', 'close', 'field', 'minus', 'plus', 'fit',
    'legend', 'preparation-legend', 'details', 'detail-content', 'detail-close', 'info', 'info-open', 'info-close']
    .map(key => ['constellation-' + key, new Element()]));
  ids['constellation-info'].hidden = ids['constellation-details'].hidden = true;
  Object.assign(ids['constellation-svg'], dimensions);
  let quizLoads = 0;
  const context = {
    document: { getElementById: id => ids[id], createElementNS: (_, tag) => new Element(tag), createElement: tag => new Element(tag) },
    sel: { field: 'Test' }, fetch: async () => ({ ok: true, json: async () => data }),
    highlightSel() {}, updateHeaderCtx() {}, mobileGoMain() {}, refreshStats: async () => {},
    loadNextQuestion: async () => { quizLoads++; },
    DOMPoint: class { constructor(x, y) { this.x = x; this.y = y; } matrixTransform() { return this; } },
  };
  vm.createContext(context);
  vm.runInContext(readFileSync(join(__dirname, '../static/constellation-layout.js'), 'utf8'), context);
  vm.runInContext(readFileSync(join(__dirname, '../static/constellation.js'), 'utf8'), context);
  await activate(ids['constellation-open']);
  const world = ids['constellation-svg'].children.find(item => item.attrs.class === 'constellation-world');
  return { ids, context, world, clouds: world.children[0].children, links: world.children[1].children,
    connections: world.children[2].children, nodes: world.children[3].children,
    content: ids['constellation-detail-content'], loads: () => quizLoads };
}
const position = item => item.attrs.transform.match(/[-\d.]+/g).map(Number);
const distance = (view, a, b) => {
  const [ax, ay] = position(view.nodes[a]), [bx, by] = position(view.nodes[b]);
  return (ax - bx) ** 2 + (ay - by) ** 2;
};

test('tapping or keyboard-activating a node reveals details before starting the filtered quiz', async () => {
  const view = await render();
  assert.equal(view.ids['constellation-details'].hidden, true);
  await activate(view.nodes[1]);
  assert.equal(view.ids['constellation-details'].hidden, false);
  assert.equal(view.content.children[1].textContent, 'Child');
  assert.match(view.content.children[2].textContent, /Im Aufbau · 2 Fragen/);
  assert.match(view.content.children[3].textContent, /Übungsbedarf: 1/);
  assert.match(view.content.children[4].textContent, /Shared · Second/);
  assert.equal(view.loads(), 0);
  assert.ok(view.nodes[1].classes.has('node-selected'));
  assert.ok(view.nodes[3].classes.has('concept-related'));
  await activate(view.content.children.find(item => item.className === 'primary'));
  assert.equal(view.context.sel.topic, 'Parent');
  assert.equal(view.context.sel.subtopic, 'Child');
  assert.equal(view.loads(), 1);
  assert.equal(view.ids['constellation-dialog'].open, false);
});

test('shared concept connections have tap targets and explain the exact concepts', async () => {
  const view = await render();
  assert.equal(view.links.length, 3);
  assert.equal(view.connections.length, 1);
  const connection = view.connections[0];
  assert.equal(connection.attrs.role, 'button');
  assert.equal(connection.children[1].attrs.class, 'concept-hit');
  connection.events.keydown(event({key:'Enter'}));
  assert.equal(view.content.children[1].textContent, 'Child ↔ Other');
  assert.equal(view.content.children[3].textContent, 'Shared · Second');
  assert.ok(connection.children[0].classes.has('concept-link-active'));
  assert.ok(!view.content.children.some(item => item.className === 'primary'));
  activate(view.ids['constellation-detail-close']);
  assert.ok(connection.focused);
  assert.equal(view.ids['constellation-details'].hidden, true);
});

test('direct topic concepts connect independently and supplied labels stay plain text', async () => {
  const data = topics();
  data[0].direct_concepts = ['Unique']; data[0].children[1].concepts = ['Unique', '<Concept>'];
  const view = await render(data);
  assert.equal(view.connections.length, 2);
  view.nodes[2].events.keydown(event({key:' '}));
  assert.match(view.content.children[4].textContent, /<Concept>/);
  assert.ok(view.connections.some(item => item.attrs['aria-label'].includes('Parent und Sibling: Unique')));
});

test('organic clouds replace rectangles; preparation changes keep topic identity and layout stable', async () => {
  const data = topics(), before = await render(data);
  data[0].attempted = 0; data[1].preparation.rating = 'green'; data[0].children[0].preparation.rating = 'green';
  const after = await render(data);
  assert.deepEqual(after.nodes.map(position), before.nodes.map(position));
  assert.deepEqual(after.nodes.map(n => n.attrs.style.split(';')[0]), before.nodes.map(n => n.attrs.style.split(';')[0]));
  assert.ok(after.clouds.every(cloud => cloud.children[0].tag === 'ellipse'));
  assert.match(after.clouds[0].attrs.class, /island-unattempted/);
  assert.match(after.nodes[0].attrs.class, /island-unattempted/);
  assert.equal(after.nodes[0].children[0].attrs['stroke-dasharray'], '3 4');
  assert.match(after.nodes[1].attrs.style, /195 90% 72%/);
  assert.equal(after.ids['constellation-legend'].children.length, 3);
});

test('info is hidden initially, opens on demand, and Escape dismisses it before the map', async () => {
  const view = await render();
  assert.equal(view.ids['constellation-info'].hidden, true);
  assert.equal(view.ids['constellation-preparation-legend'].children.length, 4);
  activate(view.ids['constellation-info-open']);
  assert.equal(view.ids['constellation-info'].hidden, false);
  assert.equal(view.ids['constellation-info-open'].attrs['aria-expanded'], 'true');
  let prevented = false;
  view.ids['constellation-dialog'].events.cancel(event({preventDefault() { prevented = true; }}));
  assert.ok(prevented);
  assert.equal(view.ids['constellation-info'].hidden, true);
  assert.equal(view.ids['constellation-dialog'].open, true);
});

test('dense banks retain all nodes with collision avoidance and deterministic positions', async () => {
  const data = topics(); data[0].children = Array.from({length:168}, (_, i) => node(`Child ${i}`));
  const view = await render(data), repeated = await render(data);
  assert.equal(view.nodes.length, 172);
  assert.deepEqual(view.nodes.map(position), repeated.nodes.map(position));
  view.nodes.forEach((a, i) => view.nodes.slice(i + 1).forEach(b => {
    const [ax, ay] = position(a), [bx, by] = position(b);
    const radiusA = Number(a.children[0].attrs.r), radiusB = Number(b.children[0].attrs.r);
    assert.ok(Math.hypot(ax-bx, ay-by) >= radiusA + radiusB + 10, `${i}: ${Math.hypot(ax-bx, ay-by)} < ${radiusA+radiusB+10}`);
  }));
});

test('concept attraction shortens relationships while keeping all connections', async () => {
  const data = [
    { ...node('A'), direct_concepts:[], children:[node('AX',['X']),node('AY',['Y'])] },
    { ...node('B'), direct_concepts:[], children:[node('BY',['Y']),node('BX',['X'])] },
  ];
  const optimized = await render(data), plain = structuredClone(data);
  plain.forEach(topic => topic.children.forEach(child => {child.concepts=[];}));
  const baseline = await render(plain);
  assert.ok(distance(optimized,1,5)+distance(optimized,2,4) < distance(baseline,1,5)+distance(baseline,2,4));
  assert.equal(optimized.connections.length,2);
});

test('mobile fit, pinch zoom, and pan work without opening a node during a drag', async () => {
  const view = await render(topics(), {clientWidth:390, clientHeight:844});
  const svg = view.ids['constellation-svg'];
  assert.equal(svg.attrs.viewBox, '0 0 390 844');
  const initial = view.world.attrs.transform;
  const p = (id, clientX, clientY) => event({button:0, pointerId:id, clientX, clientY});
  svg.events.pointerdown(p(1,100,150)); svg.events.pointerdown(p(2,200,150));
  svg.events.pointermove(p(2,300,150));
  assert.notEqual(view.world.attrs.transform, initial);
  assert.ok(!view.world.attrs.transform.includes('NaN'));
  svg.events.pointerup(p(2,300,150)); svg.events.pointerup(p(1,100,150));
  const pinched = view.world.attrs.transform;
  svg.events.pointerdown(p(3,100,100)); svg.events.pointermove(p(3,170,140)); svg.events.pointerup(p(3,170,140));
  assert.notEqual(view.world.attrs.transform, pinched);
  activate(view.nodes[1]);
  assert.equal(view.ids['constellation-details'].hidden, true);
  svg.events.pointerdown(p(4,100,100)); svg.events.pointerup(p(4,100,100));
  activate(view.nodes[1]);
  assert.equal(view.ids['constellation-details'].hidden, false);
  activate(view.ids['constellation-fit']);
  assert.equal(view.world.attrs.transform, initial);
  const scale = Number(initial.match(/scale\(([^)]+)/)[1]);
  assert.ok(view.nodes.every(item => Number(item.children[1].attrs.r)*scale >= 16 - 0.001));
});

test('topic detail can focus its cluster and still start a parent-topic quiz', async () => {
  const view = await render();
  activate(view.nodes[0]);
  const focus = view.content.children.find(item => item.className === 'secondary');
  const initial = view.world.attrs.transform;
  activate(focus);
  assert.notEqual(view.world.attrs.transform, initial);
  assert.equal(view.ids['constellation-details'].hidden, true);
  activate(view.nodes[0]);
  await activate(view.content.children.find(item => item.className === 'primary'));
  assert.equal(view.context.sel.topic, 'Parent');
  assert.equal(view.context.sel.subtopic, null);
});

test('banks without concepts keep hierarchy edges and no invented relationships', async () => {
  const data = topics();
  data.forEach(topic => { delete topic.concepts; delete topic.direct_concepts; topic.children.forEach(child=>{delete child.concepts;}); });
  const view = await render(data);
  assert.equal(view.connections.length,0);
  assert.equal(view.links.length,3);
});
