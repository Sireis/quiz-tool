const assert = require('node:assert/strict');
const {test} = require('node:test');
const {readFileSync} = require('node:fs');
const {join} = require('node:path');
const vm = require('node:vm');

async function setup() {
  const elements = new Map(), storage = new Map([['trainer_profile', 'alice']]), calls = [];
  let reloads = 0;
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      id, value: '', textContent: '', dataset: {}, attrs: {}, events: {}, children: [], disabled: false, open: false,
      get options() {return this.children;},
      replaceChildren(...children) {this.children = children;},
      setAttribute(name, value) {this.attrs[name] = value;},
      addEventListener(name, callback) {this.events[name] = callback;},
      querySelector(selector) {return element(selector === 'summary' ? 'profile-trigger' : 'profile-submit');},
      showModal() {this.open = true;}, close() {this.open = false;}, focus() {this.focused = true;},
    });
    return elements.get(id);
  };
  const context = {
    URL, Headers, Request, location: {href: 'http://trainer.test/', origin: 'http://trainer.test', reload() {reloads++;}},
    localStorage: {getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value)},
    document: {getElementById: element, createElement: () => element(`button-${elements.size}`), querySelectorAll: () => element('profile-options').children},
    Option: function(text, value) {this.textContent = text; this.value = value;},
    fetch: async (url, options) => {
      calls.push({url, options});
      return {ok: true, json: async () => [{id: 'alice', name: 'Alice'}, {id: 'bob', name: 'Bob'}]};
    },
    protectAnswerDraft: () => true,
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(readFileSync(join(__dirname, '../static/profiles.js'), 'utf8'), context);
  await context.initProfiles();
  return {context, element, storage, calls, reloads: () => reloads};
}

test('the profile dropdown shows selection and switching preserves the page owner of pending requests', async () => {
  const app = await setup();
  assert.equal(app.element('profile-current').textContent, 'Alice');
  assert.equal(app.element('profile-options').children[0].attrs['aria-pressed'], 'true');
  app.element('profile-options').children[1].onclick();
  assert.equal(app.storage.get('trainer_profile'), 'bob');
  assert.equal(app.reloads(), 1);
  await app.context.fetch('/api/fields');
  assert.equal(app.calls.at(-1).options.headers.get('X-Trainer-Profile'), 'alice');
});

test('a canceled draft guard prevents profile navigation; room locks disable the whole menu', async () => {
  const app = await setup();
  app.context.protectAnswerDraft = () => false;
  app.element('profile-options').children[1].onclick();
  assert.equal(app.reloads(), 0);
  assert.equal(app.element('profile-select').value, 'alice');
  app.element('profile-menu').open = true;
  app.context.setProfileControlsDisabled(true);
  assert.equal(app.element('profile-menu').inert, true);
  assert.equal(app.element('profile-menu').open, false);
  app.element('profile-select').value = 'bob';
  app.context.setProfileControlsDisabled(false);
  assert.equal(app.element('profile-current').textContent, 'Bob');
  assert.equal(app.element('profile-options').children[1].attrs['aria-pressed'], 'true');
  app.element('profile-add').events.click();
  assert.equal(app.element('profile-dialog').open, true);
  assert.equal(app.element('profile-name').focused, true);
});
