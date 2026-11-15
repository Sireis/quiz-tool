const assert = require('node:assert/strict');
const {test} = require('node:test');
const {readFileSync} = require('node:fs');
const {join} = require('node:path');
const vm = require('node:vm');

function setup() {
  const events = {}, focus = [];
  const menu = name => ({name, open: true, contains: target => target.menu === name,
    querySelector: () => ({focus: () => focus.push(name)})});
  const profile = menu('profile'), stats = menu('stats');
  const context = {document: {
    querySelectorAll: () => [profile, stats],
    addEventListener(type, handler, capture) {events[type] = {handler, capture};},
  }};
  vm.runInNewContext(readFileSync(join(__dirname, '../static/controls.js'), 'utf8'), context);
  return {events, profile, stats, focus};
}

test('choosing an action closes the popup before a dialog can capture its invoker', () => {
  const app = setup();
  assert.equal(app.events.click.capture, true);
  app.events.click.handler({target: {menu: 'profile', closest: () => ({})}});
  assert.equal(app.profile.open, false);
  assert.equal(app.stats.open, false);
  assert.deepEqual(app.focus, ['profile']);
});

test('outside clicks close popups without moving focus and Escape restores the trigger', () => {
  const app = setup();
  app.events.click.handler({target: {menu: 'outside'}});
  assert.equal(app.profile.open, false);
  assert.deepEqual(app.focus, []);
  app.stats.open = true;
  let prevented = false, stopped = false;
  app.events.keydown.handler({key: 'Escape', preventDefault() {prevented = true;}, stopImmediatePropagation() {stopped = true;}});
  assert.equal(app.stats.open, false);
  assert.deepEqual(app.focus, ['stats']);
  assert.equal(prevented && stopped, true);
});
