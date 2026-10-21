import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

import collaboration
import profiles
import question_store
import realtime
import rooms


class Peer:
    def __init__(self, code, profile, client):
        self.code, self.profile, self.client = code, profile, client
        self.messages = []
        self.cursor = None
        self.identity = {'name': client, 'color': '#65dccc'}

    def send(self, message):
        self.messages.append(message)


class CollaborationTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        subject = root / 'sets' / 'test'
        subject.mkdir(parents=True)
        (subject / 'questions.json').write_text(json.dumps({'questions': [
            {'id': 1, 'topic': 'Topic', 'question': 'Q', 'answer': 'A'}]}))
        (subject / 'system-prompt.txt').write_text('Grade')
        for target, name, value in (
            (question_store, 'FIELDS_PATH', root / 'sets'),
            (profiles, 'PROFILES_PATH', root / 'profiles'),
            (rooms, 'ROOMS_PATH', root / 'rooms'),
            (rooms, '_executor', Mock()),
        ):
            change = patch.object(target, name, value)
            change.start()
            self.addCleanup(change.stop)
        self.a = profiles.create_profile('Alice')['id']
        self.b = profiles.create_profile('Bob')['id']
        self.c = profiles.create_profile('Charlie')['id']
        self.code = rooms.create(self.a, 'test')
        rooms.join(self.code, self.b)
        self.rid = rooms.view(self.code, self.a)['round_id']

    def update(self, profile, version, changes, client='a'):
        return collaboration.update(self.code, profile, self.rid, version,
                                    [{'changes': changes, 'clientID': client}], client)

    def test_changes_follow_codemirror_utf16_format(self):
        apply = collaboration.apply_changes
        self.assertEqual(apply('abc', [1, [0, '😀x', 'y'], 2]), 'a😀x\nybc')
        self.assertEqual(apply('a😀b', [1, [2, 'X'], 1]), 'aXb')
        self.assertEqual(apply('abc', [1, [1], 1]), 'ac')
        for changes in ([4], [1], [[-1]], [True], [[0, 3]], [[0, 'x' * 16001], 3]):
            with self.assertRaises(ValueError):
                apply('abc', changes)

    def test_stale_edits_receive_history_without_overwriting_document(self):
        self.update(self.a, 0, [[0, 'A']])
        stale = self.update(self.b, 0, [[0, 'B']], 'b')
        self.assertEqual(stale['updates'][0]['clientID'], 'a')
        self.assertEqual(collaboration.document(self.code, self.b)['doc'], 'A')
        self.update(self.b, 1, [1, [0, 'B']], 'b')
        snapshot = collaboration.document(self.code, self.a, self.rid, 1)
        self.assertEqual(snapshot['doc'], 'AB')
        self.assertEqual(snapshot['version'], 2)
        self.assertEqual(len(snapshot['updates']), 1)
        # Replaying a lost-ack update doesn't apply it again.
        self.update(self.b, 1, [1, [0, 'B']], 'b')
        self.assertEqual(collaboration.document(self.code, self.a)['doc'], 'AB')

    def test_membership_round_and_competitive_privacy(self):
        with self.assertRaises(ValueError):
            self.update(self.c, 0, [[0, 'Secret']])
        with self.assertRaises(ValueError):
            collaboration.update(self.code, self.a, 'old-round', 0, [], 'a')
        code = rooms.create(self.a, 'test', 'compete')
        rooms.join(code, self.b)
        rid = rooms.view(code, self.a)['round_id']
        self.assertIsNone(collaboration.document(code, self.b))
        with self.assertRaises(ValueError):
            collaboration.update(code, self.a, rid, 0, [{'changes': [[0, 'Secret']], 'clientID': 'a'}], 'a')

    def test_submission_freezes_only_the_acknowledged_server_document(self):
        self.update(self.a, 0, [[0, 'Together']])
        with self.assertRaises(ValueError):
            rooms.action(self.code, self.a, 'submit', self.rid, 'Together', editor_version=0)
        with self.assertRaises(ValueError):
            rooms.action(self.code, self.a, 'submit', self.rid, 'Different', editor_version=1)
        rooms.action(self.code, self.a, 'submit', self.rid, 'Together', editor_version=1)
        with self.assertRaises(ValueError):
            self.update(self.b, 1, [8, [0, ' late']], 'b')
        with rooms.transaction(self.code, write=False) as room:
            self.assertEqual([s['answer'] for s in room['round']['submissions'].values()], ['Together'] * 2)

    def test_hub_broadcasts_edits_and_ephemeral_coloured_presence(self):
        hub = realtime.Hub()
        a, b = Peer(self.code, self.a, 'a'), Peer(self.code, self.b, 'b')
        hub.peers.update([a, b])
        hub.receive(a, {'type': 'edits', 'round_id': self.rid, 'version': 0,
                        'updates': [{'changes': [[0, 'Hello']], 'clientID': 'a'}]})
        self.assertEqual(b.messages[-1]['type'], 'updates')
        self.assertEqual(a.messages[-1]['type'], 'updates')
        path = rooms.ROOMS_PATH / f'{self.code}.json'
        before = path.read_bytes()
        hub.receive(a, {'type': 'cursor', 'round_id': self.rid, 'version': 1, 'anchor': 1, 'head': 4})
        self.assertEqual(b.messages[-1]['color'], '#65dccc')
        self.assertEqual(b.messages[-1]['name'], 'a')
        self.assertEqual(b.messages[-1]['anchor'], 1)
        self.assertEqual(path.read_bytes(), before)
        hub.receive(b, {'type': 'hello', 'round_id': self.rid, 'version': 0})
        sync = next(m for m in reversed(b.messages) if m['type'] == 'sync')
        self.assertEqual(sync['editor']['updates'][0]['clientID'], 'a')
        with self.assertRaises(ValueError):
            hub.receive(a, {'type': 'cursor', 'round_id': self.rid, 'version': 1, 'anchor': 999, 'head': 999})

    def test_delayed_cursor_is_mapped_to_current_document_instead_of_dropped(self):
        self.update(self.a, 0, [[0, 'a😀bc']])
        self.update(self.a, 1, [1, [2, 'XY'], 2])
        self.update(self.a, 2, [[0, 'start '], 5])
        cursor = collaboration.cursor(self.code, self.b, self.rid, 1, 3, 5)
        self.assertEqual(cursor['version'], 3)
        self.assertEqual(cursor['anchor'], 9)
        self.assertEqual(cursor['head'], 11)
        self.assertIsNone(collaboration.cursor(self.code, self.b, self.rid, 1, None, None)['anchor'])
