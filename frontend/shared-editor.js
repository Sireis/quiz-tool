import {ChangeSet, Compartment, EditorState, StateEffect, StateField} from '@codemirror/state';
import {Decoration, EditorView, WidgetType, drawSelection, keymap} from '@codemirror/view';
import {defaultKeymap, history, historyKeymap} from '@codemirror/commands';
import {collab, getSyncedVersion, receiveUpdates, sendableUpdates} from '@codemirror/collab';

const presence = StateEffect.define();
class Cursor extends WidgetType {
  constructor(person) { super(); this.person = person; }
  eq(other) { return JSON.stringify(this.person) === JSON.stringify(other.person); }
  toDOM() {
    const cursor = document.createElement('span');
    cursor.className = 'collab-cursor';
    cursor.style.setProperty('--cursor-color', this.person.color);
    const label = document.createElement('span');
    label.className = 'collab-cursor-label';
    label.textContent = this.person.name;
    cursor.append(label);
    return cursor;
  }
}
function decorations(people) {
  const ranges = [];
  for (const person of people.values()) {
    const from = Math.min(person.anchor, person.head), to = Math.max(person.anchor, person.head);
    if (from !== to) ranges.push(Decoration.mark({attributes: {style: `background-color:${person.color}40`}}).range(from, to));
    ranges.push(Decoration.widget({widget: new Cursor(person), side: 1}).range(person.head));
  }
  return Decoration.set(ranges, true);
}
const cursors = StateField.define({
  create: () => ({people: new Map(), decorations: Decoration.none}),
  update(previous, transaction) {
    const people = new Map([...previous.people].map(([id, person]) => [id, {...person,
      anchor: transaction.changes.mapPos(person.anchor), head: transaction.changes.mapPos(person.head)}]));
    for (const effect of transaction.effects) if (effect.is(presence)) {
      if (effect.value.anchor == null) people.delete(effect.value.client);
      else people.set(effect.value.client, effect.value);
    }
    return {people, decorations: decorations(people)};
  },
  provide: field => EditorView.decorations.from(field, value => value.decorations),
});

class SharedEditor {
  static build = 'cursor-presence-3';
  constructor(parent, client, send, resync) {
    Object.assign(this, {parent, client, send, resync});
    this.view = null;
    this.round = null;
    this.connected = false;
    this.inflight = false;
    this.waiters = [];
    this.remote = new Map();
    this.accepted = new Map();
    this.lock = new Compartment();
    this.cursorTimer = null;
    this.lastCursor = null;
  }
  get version() { return this.view ? getSyncedVersion(this.view.state) : null; }
  get text() { return this.view?.state.doc.toString() || ''; }
  get pending() { return this.view ? sendableUpdates(this.view.state).length : 0; }
  mount(doc, color) {
    this.view?.destroy();
    this.round = doc.round_id;
    this.inflight = false;
    this.remote.clear();
    this.accepted.clear();
    this.lastCursor = null;
    this.view = new EditorView({parent: this.parent, state: EditorState.create({
      doc: doc.doc,
      extensions: [
        collab({startVersion: doc.version, clientID: this.client}), history(),
        keymap.of([{key: 'Ctrl-Enter', run: () => { globalThis.sharedPractice?.submit(); return true; }},
          ...defaultKeymap, ...historyKeymap]), drawSelection(), EditorView.lineWrapping, cursors,
        this.lock.of([EditorState.readOnly.of(true), EditorView.editable.of(false)]),
        EditorView.contentAttributes.of({'aria-label': 'Eure gemeinsame Antwort', 'aria-multiline': 'true'}),
        EditorView.theme({
          '&': {color: 'var(--text)', backgroundColor: 'var(--background)', border: '1px solid var(--border2)', borderRadius: '8px'},
          '.cm-content': {minHeight: '140px', padding: '14px', fontFamily: 'inherit', lineHeight: '1.65'},
          '.cm-scroller': {fontFamily: 'inherit', overflow: 'auto'},
          '.cm-cursor, .cm-dropCursor': {borderLeftColor: color},
          '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {backgroundColor: `${color}40`},
          '&.cm-focused': {outline: '2px solid var(--accent)', outlineOffset: '2px'},
        }),
        EditorView.updateListener.of(update => {
          if (update.docChanged && this.lastCursor) {
            this.lastCursor = {anchor: update.changes.mapPos(this.lastCursor.anchor, 1),
              head: update.changes.mapPos(this.lastCursor.head, 1)};
          }
          if (update.docChanged) queueMicrotask(() => this.push());
          if (update.docChanged || update.selectionSet || update.focusChanged) this.sendCursorSoon();
        }),
      ],
    })});
    this.view.contentDOM.id = 'shared-answer-text';
  }
  sync(doc, color) {
    if (!doc) return;
    if (!this.view || this.round !== doc.round_id) this.mount(doc, color);
    else if (doc.updates) this.receive({round_id: doc.round_id, from: doc.from, updates: doc.updates});
    this.inflight = false;
    this.push();
  }
  receive(message) {
    if (!this.view || message.round_id !== this.round) { this.resync(); return; }
    const version = this.version;
    if (message.from > version) { this.resync(); return; }
    const updates = message.updates.slice(Math.max(0, version - message.from));
    if (updates.length) {
      const decoded = updates.map(update => ({...update, changes: ChangeSet.fromJSON(update.changes)}));
      decoded.forEach((update, index) => this.accepted.set(version + index, update.changes));
      while (this.accepted.size > 512) this.accepted.delete(this.accepted.keys().next().value);
      this.view.dispatch(receiveUpdates(this.view.state, decoded));
    }
    this.inflight = false;
    for (const [id, person] of [...this.remote]) {
      this.remote.delete(id);
      this.cursor(person);
    }
    this.push();
    if (!this.pending) {
      this.waiters.splice(0).forEach(resolve => resolve());
      this.sendCursorSoon();
    }
  }
  push() {
    if (!this.connected || !this.view || this.inflight || !this.pending) return;
    this.inflight = true;
    if (!this.send({type: 'edits', round_id: this.round, version: this.version,
      updates: sendableUpdates(this.view.state).slice(0, 128).map(update => ({changes: update.changes.toJSON(), clientID: this.client}))})) {
      this.inflight = false;
    }
  }
  setConnected(value) {
    this.connected = value;
    this.inflight = false;
  }
  setWritable(value) {
    if (!this.view) return;
    this.view.dispatch({effects: this.lock.reconfigure([EditorState.readOnly.of(!value), EditorView.editable.of(value)])});
  }
  freeze(doc, color) {
    if (this.text !== doc.doc || this.pending) this.mount(doc, color);
    this.setWritable(false);
  }
  cursor(person) {
    if (!this.view || person.client === this.client) return;
    if (person.anchor == null) {
      this.remote.delete(person.client);
      this.view.dispatch({effects: presence.of(person)});
    } else if (person.round_id === this.round) {
      if (person.version > this.version) { this.remote.set(person.client, person); return; }
      let {anchor, head} = person;
      // Presence is expressed in the server document; account for acknowledged
      // changes and then the local edits that haven't been acknowledged yet.
      for (let version = person.version; version < this.version; version++) {
        const changes = this.accepted.get(version);
        if (!changes) return;
        anchor = changes.mapPos(anchor, 1);
        head = changes.mapPos(head, 1);
      }
      for (const update of sendableUpdates(this.view.state)) {
        anchor = update.changes.mapPos(anchor, 1);
        head = update.changes.mapPos(head, 1);
      }
      this.view.dispatch({effects: presence.of({...person, anchor, head, version: this.version})});
    }
  }
  sendCursorSoon() {
    clearTimeout(this.cursorTimer);
    this.cursorTimer = setTimeout(() => {
      if (!this.connected || !this.view || this.pending) return;
      if (this.view.hasFocus) {
        const {anchor, head} = this.view.state.selection.main;
        this.lastCursor = {anchor, head};
      }
      if (!this.lastCursor) return;
      this.send({type: 'cursor', round_id: this.round, version: this.version,
        ...this.lastCursor});
    }, 60);
  }
  async flush() {
    if (!this.connected || !this.view) throw new Error('Warte auf die Verbindung zum Raum.');
    if (this.pending) {
      this.push();
      let timer;
      await Promise.race([
        new Promise(resolve => this.waiters.push(resolve)),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Die gemeinsame Antwort wird noch synchronisiert.')), 10000); }),
      ]).finally(() => clearTimeout(timer));
    }
    return {answer: this.text.trim(), editor_version: this.version};
  }
  diagnostics() {
    return {build: SharedEditor.build, mounted: !!this.view, version: this.version,
      pending: this.pending, focused: this.view?.hasFocus || false,
      lastCursor: this.lastCursor, queuedCursors: this.remote.size,
      activeCursors: this.view?.state.field(cursors).people.size || 0,
      cursorElements: this.parent?.querySelectorAll('.collab-cursor').length || 0};
  }
  destroy() {
    clearTimeout(this.cursorTimer);
    this.view?.destroy();
    this.view = null;
    this.round = null;
    this.remote.clear();
    this.accepted.clear();
    this.lastCursor = null;
    this.waiters.splice(0).forEach(resolve => resolve());
  }
}
globalThis.SharedEditor = SharedEditor;
