const {test} = require('node:test');
const assert = require('node:assert/strict');

async function fixture() {
  const {EditorState, ChangeSet, Text} = await import('@codemirror/state');
  const {collab} = await import('@codemirror/collab');
  await import('../frontend/shared-editor.js');
  const outgoing = [];
  function peer(client) {
    const editor = new globalThis.SharedEditor(null, client, message => { outgoing.push({editor, message}); return true; }, () => { throw new Error('Unexpected resync'); });
    editor.round = 'round';
    editor.view = {
      state: EditorState.create({doc: 'abc', extensions: [collab({clientID: client})]}),
      hasFocus: false,
      dispatch(transaction) {
        const effects = transaction.effects;
        if (effects && !Array.isArray(effects) && effects.value?.client) this.lastPresence = effects.value;
        this.state = transaction.state || this.state.update(transaction).state;
      },
      destroy() {},
    };
    editor.setConnected(true);
    return editor;
  }
  const a = peer('a'), b = peer('b');
  let doc = Text.of(['abc']);
  const history = [];
  function deliver() {
    let count = 0;
    while (outgoing.length) {
      assert.ok(++count < 100, 'Editing must converge without a resend loop');
      const {editor, message} = outgoing.shift();
      if (message.type !== 'edits') continue;
      if (message.version !== history.length) {
        editor.receive({round_id: 'round', from: message.version, updates: history.slice(message.version)});
      } else {
        for (const update of message.updates) doc = ChangeSet.fromJSON(update.changes).apply(doc);
        history.push(...message.updates);
        const event = {round_id: 'round', from: message.version, updates: message.updates};
        for (const peer of [a, b]) if (peer.connected) peer.receive(event);
      }
    }
  }
  return {a, b, outgoing, deliver, history, document: () => doc.toString()};
}

test('simultaneous edits at the same position rebase and converge', async () => {
  const f = await fixture();
  try {
    f.a.view.dispatch({changes: {from: 1, insert: 'A'}});
    f.b.view.dispatch({changes: {from: 1, insert: 'B'}});
    f.a.push(); f.b.push(); f.deliver();
    assert.equal(f.a.text, f.b.text);
    assert.equal(f.a.text, f.document());
    assert.match(f.a.text, /A/); assert.match(f.a.text, /B/);
    assert.equal(f.a.pending, 0); assert.equal(f.b.pending, 0);
    assert.equal((await f.a.flush()).editor_version, 2);
  } finally { f.a.destroy(); f.b.destroy(); }
});

test('reconnecting keeps local pending edits and merges missed remote changes', async () => {
  const f = await fixture();
  try {
    f.b.setConnected(false);
    f.b.view.dispatch({changes: {from: 3, insert: ' offline'}});
    f.a.view.dispatch({changes: {from: 0, to: 1, insert: '😀'}});
    f.a.push(); f.deliver();
    f.b.setConnected(true);
    f.b.sync({round_id: 'round', doc: f.document(), version: 1, from: 0, updates: f.history}, '#65dccc');
    f.deliver();
    assert.equal(f.a.text, f.b.text);
    assert.equal(f.a.text, '😀bc offline');
    assert.equal((await f.b.flush()).answer, '😀bc offline');
  } finally { f.a.destroy(); f.b.destroy(); }
});

test('a remote cursor remains visible when it arrives while a local edit is unconfirmed', async () => {
  const f = await fixture();
  try {
    f.a.view.dispatch({changes: {from: 0, insert: 'X'}});
    f.a.cursor({client: 'b', round_id: 'round', version: 0, anchor: 1, head: 2, name: 'Bob', color: '#65dccc'});
    f.a.push(); f.deliver();
    assert.ok(f.a.view.lastPresence, 'A delayed cursor must be drawn rather than discarded after the local acknowledgement');
    assert.equal(f.a.view.lastPresence.anchor, 2);
    assert.equal(f.a.view.lastPresence.head, 3);
  } finally { f.a.destroy(); f.b.destroy(); }
});

test('a late cursor maps through already acknowledged edits', async () => {
  const f = await fixture();
  try {
    f.a.view.dispatch({changes: {from: 0, insert: '😀'}});
    f.a.push(); f.deliver();
    f.a.cursor({client: 'b', round_id: 'round', version: 0, anchor: 1, head: 3, name: 'Bob', color: '#65dccc'});
    assert.equal(f.a.view.lastPresence.anchor, 3);
    assert.equal(f.a.view.lastPresence.head, 5);
  } finally { f.a.destroy(); f.b.destroy(); }
});

test('switching tabs keeps the last shared caret visible until disconnect', async () => {
  const f = await fixture();
  try {
    f.a.view.hasFocus = true;
    f.a.sendCursorSoon();
    await new Promise(resolve => setTimeout(resolve, 80));
    const first = f.outgoing.find(entry => entry.message.type === 'cursor').message;
    f.a.view.hasFocus = false;
    f.a.sendCursorSoon();
    await new Promise(resolve => setTimeout(resolve, 80));
    const last = f.outgoing.filter(entry => entry.message.type === 'cursor').at(-1).message;
    assert.equal(last.anchor, first.anchor, 'Switching away must not erase a connected participant’s caret');
    assert.equal(last.head, first.head);
  } finally { f.a.destroy(); f.b.destroy(); }
});
