const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');

function setup(storage = new Map([['trainer_goal_visible:first', 'on'], ['trainer_goal_visible:second', 'on']])) {
  const elements = new Map();
  const events = {};
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      hidden: false, disabled: false, textContent: '', innerHTML: '', value: '', dataset: {},
      style: {}, attrs: {}, classList: { toggle() {}, remove() {} },
      setAttribute(name, value) { this.attrs[name] = value; }, focus() { this.focused = true; },
      querySelectorAll: () => ['save', 'cancel', 'delete'].map(element),
    });
    return elements.get(id);
  };
  const calls = [];
  const context = {
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    Intl, Date, document: { getElementById: element, querySelectorAll: () => [],
      addEventListener(type, callback) { (events[type] ||= []).push(callback); } },
    fetch: async (url, options) => { calls.push({ url, options }); return { ok: true, json: async () =>
      url.includes('/preview') ? { daily_target: 2, daily_remaining: 2, remaining_work: 40, complete: false }
        : { goal: null, total: 20, today: '2026-10-12' } }; },
  };
  vm.createContext(context);
  vm.runInContext(readFileSync(join(__dirname, '../static/goals.js'), 'utf8'), context);
  vm.runInContext(readFileSync(join(__dirname, '../static/trainer.js'), 'utf8').replace(/init\(\);\s*$/, ''), context);
  vm.runInContext("sel.field = 'first'; refreshStats = async () => {}; updateHeaderCtx = () => {}; mobileGoMain = () => {};", context);
  return { context, element, calls, events, storage, run: source => vm.runInContext(source, context) };
}

const status = (overrides = {}) => ({
  goal: { target_date: '2026-11-15', daily_target: 10, prepared: 8, preparation_percent: 40,
    today_count: 3, daily_complete: false, days_remaining: 34, complete: false,
    strategy: 'steady', daily_remaining: 7, remaining_work: 24, overachievement: 0,
    preparation_counts: { red: 8, yellow: 4, green: 8 }, ...overrides },
  total: 20, today: '2026-10-12',
});

test('creating and editing a goal uses the whole subject and preserves a draft on failure', async () => {
  const app = setup();
  await app.context.refreshGoal('first');
  await app.context.openGoalForm();
  assert.equal(app.element('goal-form').hidden, false);
  assert.equal(app.element('goal-date').value, '2026-11-11');
  assert.equal(app.element('goal-strategy').value, 'steady');
  app.element('goal-date').value = '2026-11-15';
  app.element('goal-strategy').value = 'increasing';
  app.context.fetch = async (url, options) => {
    if (options) {
      assert.equal(options.method, 'PUT');
      const body = JSON.parse(options.body);
      assert.equal(body.target_date, '2026-11-15');
      assert.equal(body.strategy, 'increasing');
      assert.equal(Object.hasOwn(body, 'daily_target'), false);
      assert.equal(typeof body.timezone, 'string');
      return { ok: false, json: async () => ({ error: 'Could not save' }) };
    }
  };
  await app.element('goal-form').onsubmit({ preventDefault() {} });
  assert.equal(app.element('goal-form').hidden, false);
  assert.equal(app.element('goal-strategy').value, 'increasing');
  assert.equal(app.element('goal-status').textContent, 'Could not save');
  assert.equal(app.element('save').disabled, false);
});

test('without a goal the header remains visible and canceling setup keeps it inactive', async () => {
  const app = setup();
  await app.context.refreshGoal('first');
  assert.equal(app.element('goal-card').hidden, true);
  assert.equal(app.element('header-goal').hidden, false);
  await app.context.openGoalForm();
  assert.equal(app.element('goal-card').hidden, false);
  assert.equal(app.element('goal-form').hidden, false);
  app.element('goal-cancel').onclick();
  assert.equal(app.element('goal-card').hidden, true);
  assert.equal(app.calls.some(call => call.options?.method === 'PUT'), false);
});

test('saving an optional goal shows the tracker automatically without another activation step', async () => {
  const app = setup();
  await app.context.refreshGoal('first');
  await app.context.openGoalForm();
  let saved = false;
  app.context.fetch = async (url, options) => {
    if (options?.method === 'PUT') saved = true;
    return { ok: true, json: async () => saved ? status() : { goal: null, total: 20, today: '2026-10-12' } };
  };
  await app.element('goal-form').onsubmit({ preventDefault() {} });
  assert.equal(saved, true);
  assert.equal(app.element('goal-card').hidden, true);
  assert.equal(app.element('header-goal').hidden, false);
  assert.equal(app.element('goal-form').hidden, true);
  assert.equal(app.element('goal-edit').hidden, false);
  assert.doesNotMatch(app.element('goal-summary').innerHTML, /goal-start/);
});

test('a saved goal tracks activity without changing topic or set selection', async () => {
  const app = setup();
  app.run("sel.topic = 'Topic'; sel.set = {name: 'My set'};");
  app.context.fetch = async () => ({ ok: true, json: async () => status() });
  await app.context.refreshGoal('first');
  assert.equal(app.run('sel.topic'), 'Topic');
  assert.equal(app.run('sel.set.name'), 'My set');
  assert.match(app.context.resolveQuestionUrl(), /^\/api\/fields\/first\/question\?/);
  assert.doesNotMatch(app.element('goal-summary').innerHTML, /goal-start/);
  app.context.fetch = async () => ({ ok: true, json: async () => status({ today_count: 11, daily_complete: true, daily_remaining: 0, overachievement: 1 }) });
  await app.context.refreshGoal('first');
  assert.match(app.element('goal-summary').innerHTML, /11<\/strong>/);
  assert.match(app.element('goal-summary').innerHTML, /1 Antwort über deinem Tagesziel/);
});

test('daily completion and overdue targets are reflected in the goal card', async () => {
  const app = setup();
  app.context.fetch = async () => ({ ok: true, json: async () => status({
    today_count: 10, daily_complete: true, days_remaining: -2,
  }) });
  await app.context.refreshGoal('first');
  const html = app.element('goal-summary').innerHTML;
  assert.match(html, /Tagesziel erreicht/);
  assert.match(html, /Zieldatum vor 2 Tagen/);
  assert.doesNotMatch(html, /goal-start/);
  assert.equal(app.element('goal-card').dataset.tier, 'achieved');
});

test('a delayed response from another subject cannot replace the current goal', async () => {
  const app = setup();
  let resolveFirst;
  app.context.fetch = url => url.includes('/first/')
    ? new Promise(resolve => { resolveFirst = resolve; })
    : Promise.resolve({ ok: true, json: async () => status() });
  const first = app.context.refreshGoal('first');
  app.run("sel.field = 'second'");
  await app.context.refreshGoal('second');
  resolveFirst({ ok: true, json: async () => ({ goal: null, total: 1, today: '2026-10-12' }) });
  await first;
  assert.equal(app.element('goal-field').textContent, 'second');
  assert.match(app.element('goal-summary').innerHTML, /40% gut vorbereitet/);
  await app.context.refreshGoal('first');
  assert.equal(app.run('goalField'), 'second');
});

test('deleting a goal switches off the tracker and leaves normal selection available', async () => {
  const app = setup();
  app.context.fetch = async () => ({ ok: true, json: async () => status() });
  await app.context.refreshGoal('first');
  await app.context.openGoalForm();
  app.run("sel.topic = 'Topic'");
  let deleted = false;
  app.context.fetch = async (url, options) => {
    if (options?.method === 'DELETE') deleted = true;
    return { ok: true, json: async () => ({ goal: null, total: 20, today: '2026-10-12' }) };
  };
  await app.element('goal-delete').onclick();
  assert.equal(deleted, true);
  assert.equal(app.run('sel.topic'), 'Topic');
  assert.equal(app.element('goal-card').dataset.tier, 'empty');
  assert.equal(app.element('goal-form').hidden, true);
  assert.equal(app.element('goal-card').hidden, true);
});

test('changing the rhythm updates the preview without saving a goal', async () => {
  const app = setup();
  await app.context.refreshGoal('first');
  await app.context.openGoalForm();
  assert.match(app.element('goal-preview').textContent, /Heute ca. 2/);
  app.context.fetch = async (url, options) => {
    assert.equal(options, undefined);
    assert.match(url, /strategy=frontloaded/);
    assert.match(url, /target_date=2026-11-11/);
    return { ok: true, json: async () => ({ daily_target: 4, daily_remaining: 4, remaining_work: 40 }) };
  };
  app.element('goal-strategy').value = 'frontloaded';
  await app.element('goal-strategy').onchange();
  assert.match(app.element('goal-preview').textContent, /Heute ca. 4/);
  assert.match(app.element('goal-strategy-help').textContent, /am Anfang mehr/);
});

test('a stale workload preview cannot replace a newer strategy choice', async () => {
  const app = setup();
  await app.context.refreshGoal('first');
  await app.context.openGoalForm();
  let resolveFirst;
  app.context.fetch = url => url.includes('strategy=increasing')
    ? new Promise(resolve => { resolveFirst = resolve; })
    : Promise.resolve({ ok: true, json: async () => ({ daily_target: 5, daily_remaining: 5, remaining_work: 40 }) });
  app.element('goal-strategy').value = 'increasing';
  const first = app.element('goal-strategy').onchange();
  app.element('goal-strategy').value = 'frontloaded';
  await app.element('goal-strategy').onchange();
  resolveFirst({ ok: true, json: async () => ({ daily_target: 1, daily_remaining: 1, remaining_work: 40 }) });
  await first;
  assert.match(app.element('goal-preview').textContent, /Heute ca. 5/);
});

test('extra effort unlocks progressively richer tracker effects', async () => {
  const app = setup();
  for (const [count, tier] of [[0, 'active'], [10, 'achieved'], [13, 'glow'],
    [15, 'diamond'], [20, 'rainbow'], [30, 'aurora']]) {
    app.context.fetch = async () => ({ ok: true, json: async () => status({
      today_count: count, overachievement: Math.max(0, count - 10),
      daily_complete: count >= 10, daily_remaining: Math.max(0, 10 - count),
    }) });
    await app.context.refreshGoal('first');
    assert.equal(app.element('goal-card').dataset.tier, tier);
    assert.match(app.element('goal-summary').innerHTML, new RegExp(`${count * 10}%`));
    assert.doesNotMatch(app.element('goal-summary').innerHTML, /goal-start/);
  }
});

test('bonus practice with a zero daily target shows extra answers without invalid percentages', async () => {
  const app = setup();
  app.context.fetch = async () => ({ ok: true, json: async () => status({
    daily_target: 0, today_count: 5, overachievement: 5, daily_complete: true, complete: true,
  }) });
  await app.context.refreshGoal('first');
  const html = app.element('goal-summary').innerHTML;
  assert.match(html, /\+5/);
  assert.match(html, /Bonusantworten/);
  assert.doesNotMatch(html, /Infinity|NaN/);
  assert.equal(app.element('goal-card').dataset.tier, 'rainbow');
});

test('the header keeps the main metrics visible with details collapsed', async () => {
  const app = setup();
  app.context.fetch = async () => ({ ok: true, json: async () => status({
    today_count: 15, overachievement: 5, daily_complete: true, daily_remaining: 0,
  }) });
  await app.context.refreshGoal('first');
  assert.equal(app.element('header-goal').hidden, false);
  assert.equal(app.element('goal-card').hidden, true);
  const html = app.element('header-goal-summary').innerHTML;
  assert.match(html, /15 \/ 10/);
  assert.match(html, /40% bereit/);
  assert.match(html, /34 Tage/);
  assert.match(html, /\+5/);
  assert.equal(app.element('header-goal').dataset.tier, 'diamond');
});

test('chevrons toggle details and live updates preserve the open panel and settings draft', async () => {
  const app = setup();
  app.context.fetch = async () => ({ ok: true, json: async () => status() });
  await app.context.refreshGoal('first');
  app.element('goal-expand').onclick();
  assert.equal(app.element('goal-card').hidden, false);
  assert.equal(app.element('goal-expand').attrs['aria-expanded'], 'true');
  await app.element('goal-edit').onclick();
  app.element('goal-date').value = '2026-12-01';
  await app.context.refreshGoal('first');
  assert.equal(app.element('goal-card').hidden, false);
  assert.equal(app.element('goal-form').hidden, false);
  assert.equal(app.element('goal-date').value, '2026-12-01');
  app.element('goal-expand').onclick();
  assert.equal(app.element('goal-card').hidden, true);
  assert.equal(app.element('goal-expand').attrs['aria-expanded'], 'false');
  app.element('goal-expand').onclick();
  assert.equal(app.element('goal-date').value, '2026-12-01');
});

test('Escape, outside clicks and changing fields close details without stopping tracking', async () => {
  const app = setup();
  app.context.fetch = async () => ({ ok: true, json: async () => status() });
  await app.context.refreshGoal('first');
  app.element('goal-expand').onclick();
  app.events.keydown.forEach(handler => handler({ key: 'Escape', preventDefault() {} }));
  assert.equal(app.element('goal-card').hidden, true);
  assert.equal(app.element('header-goal').hidden, false);
  assert.equal(app.element('goal-expand').focused, true);
  app.element('goal-expand').onclick();
  app.events.click.forEach(handler => handler({ target: { closest: () => null } }));
  assert.equal(app.element('goal-card').hidden, true);
  app.element('goal-expand').onclick();
  app.run("sel.field = 'second'");
  app.context.fetch = async () => ({ ok: true, json: async () => ({ goal: null, total: 20, today: '2026-10-12' }) });
  await app.context.refreshGoal('second');
  assert.equal(app.element('goal-card').hidden, true);
  assert.equal(app.element('header-goal').hidden, false);
});

test('the header toggle hides the tracker and panel while preserving the saved goal', async () => {
  const app = setup();
  app.context.fetch = async () => ({ ok: true, json: async () => status() });
  await app.context.refreshGoal('first');
  app.element('goal-expand').onclick();
  app.element('goal-toggle').onclick();
  assert.equal(app.element('header-goal').hidden, false);
  assert.equal(app.element('header-goal-summary').hidden, true);
  assert.equal(app.element('goal-card').hidden, true);
  assert.equal(app.element('goal-expand').hidden, true);
  assert.equal(app.element('goal-toggle').attrs['aria-checked'], 'false');
  assert.equal(app.run('goalState.goal.strategy'), 'steady');
  await app.context.refreshGoal('first');
  assert.equal(app.element('header-goal-summary').hidden, true);
  app.element('goal-toggle').onclick();
  assert.equal(app.element('header-goal-summary').hidden, false);
  assert.equal(app.element('goal-expand').hidden, false);
  assert.equal(app.element('goal-toggle').attrs['aria-checked'], 'true');
});

test('tracker visibility is remembered independently for each field and after reload', async () => {
  const app = setup();
  app.context.fetch = async () => ({ ok: true, json: async () => status() });
  await app.context.refreshGoal('first');
  app.element('goal-toggle').onclick();
  app.run("sel.field = 'second'");
  await app.context.refreshGoal('second');
  assert.equal(app.element('header-goal-summary').hidden, false);
  app.run("sel.field = 'first'");
  await app.context.refreshGoal('first');
  assert.equal(app.element('header-goal-summary').hidden, true);
  const reloaded = setup(app.storage);
  reloaded.context.fetch = async () => ({ ok: true, json: async () => status() });
  await reloaded.context.refreshGoal('first');
  assert.equal(reloaded.element('header-goal-summary').hidden, true);
  reloaded.element('goal-toggle').onclick();
  assert.equal(reloaded.storage.get('trainer_goal_visible:first'), 'on');
});


test('fresh preferences default off, and the switch opens setup or shows a saved goal', async () => {
  const app = setup(new Map());
  await app.context.refreshGoal('first');
  assert.equal(app.element('header-goal').hidden, false);
  assert.equal(app.element('goal-toggle').attrs['aria-checked'], 'false');
  await app.element('goal-toggle').onclick();
  assert.equal(app.element('goal-form').hidden, false);
  assert.equal(app.element('goal-toggle').attrs['aria-checked'], 'true');
  app.element('goal-cancel').onclick();
  assert.equal(app.element('goal-toggle').attrs['aria-checked'], 'false');
  assert.equal(app.element('goal-toggle').focused, true);
  app.context.fetch = async () => ({ ok: true, json: async () => status() });
  await app.context.refreshGoal('first');
  assert.equal(app.element('header-goal-summary').hidden, true);
  app.element('goal-toggle').onclick();
  assert.equal(app.element('header-goal-summary').hidden, false);
  assert.equal(app.element('goal-card').hidden, true);
});

test('the template provides an accessible sliding switch and no sidebar setup button', () => {
  const html = readFileSync(join(__dirname, '../templates/index.html'), 'utf8');
  assert.match(html, /id="goal-toggle"[^>]*role="switch"[^>]*aria-checked="false"/);
  assert.match(html, /goal-switch-thumb/);
  assert.doesNotMatch(html, /id="goal-setup"/);
});

test('field quick views show daily counts, bonus tiers and capped progress', () => {
  const app = setup();
  const view = app.context.fieldGoalPreview(status({today_count: 20}).goal);
  assert.equal(view.tier, 'rainbow');
  assert.match(view.html, /20\/10/);
  assert.match(view.html, /200%/);
  assert.match(view.html, /width:100%/);
  assert.match(view.label, /40% vorbereitet/);
  const bonus = app.context.fieldGoalPreview(status({daily_target: 0, today_count: 5}).goal);
  assert.match(bonus.html, /\+5/);
  assert.doesNotMatch(bonus.html, /NaN|Infinity/);
});
