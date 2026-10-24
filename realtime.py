"""Single-process WebSocket room events and ephemeral editing presence."""
import json
import logging
import os
from queue import Queue
from threading import RLock, Thread
from urllib.parse import urlsplit

from flask import request
from flask_sock import Sock
from simple_websocket import ConnectionClosed

import collaboration
import rooms


class Peer:
    def __init__(self, ws, code, profile, client):
        self.ws, self.code, self.profile, self.client = ws, code, profile, client
        self.queue = Queue()
        self.cursor = None
        self.identity = None
        self.writer = Thread(target=self._write, daemon=True)
        self.writer.start()

    def send(self, message):
        self.queue.put(message)

    def _write(self):
        try:
            while True:
                message = self.queue.get()
                if message is None:
                    return
                self.ws.send(json.dumps(message, ensure_ascii=False))
        except (ConnectionClosed, OSError):
            return


class Hub:
    def __init__(self):
        self.lock = RLock()
        self.peers = set()

    def members(self, code):
        return [p for p in self.peers if p.code == code]

    def state(self, peer):
        state = rooms.view(peer.code, peer.profile)
        state['_transport'] = {'pid': os.getpid(), 'build': 'cursor-presence-3'}
        online = {p.profile for p in self.members(peer.code)}
        for index, person in enumerate(state['participants']):
            person['online'] = person['id'] in online
            person['color'] = ('#c4abff', '#65dccc')[index % 2]
        return state

    def publish(self, code):
        with self.lock:
            for peer in self.members(code):
                try:
                    peer.send({'type': 'state', 'state': self.state(peer),
                               'editor': collaboration.document(code, peer.profile)})
                except (ValueError, OSError):
                    logging.getLogger(__name__).exception('Could not publish room state')

    def receive(self, peer, message):
        if not isinstance(message, dict):
            raise ValueError('Invalid message')
        with self.lock:
            kind = message.get('type')
            if kind == 'hello':
                peer.send({'type': 'sync', 'state': self.state(peer),
                           'editor': collaboration.document(peer.code, peer.profile,
                                                           message.get('round_id'), message.get('version'))})
                for other in self.members(peer.code):
                    if other != peer and other.cursor:
                        peer.send(other.cursor)
            elif kind == 'edits':
                result = collaboration.update(peer.code, peer.profile, message.get('round_id'),
                                              message.get('version'), message.get('updates'), peer.client)
                if result['from'] == message['version'] and result['updates'] and all(
                        u['clientID'] == peer.client for u in result['updates']):
                    # Duplicate/rebased requests are harmless to already-synchronized peers.
                    for other in self.members(peer.code):
                        other.send(result)
                else:
                    peer.send(result)
            elif kind == 'cursor':
                position = collaboration.cursor(peer.code, peer.profile, message.get('round_id'),
                                                message.get('version'), message.get('anchor'), message.get('head'))
                person = peer.identity
                peer.cursor = {'type': 'cursor', 'client': peer.client, 'profile': peer.profile,
                               'name': person['name'], 'color': person['color'],
                               **position}
                for other in self.members(peer.code):
                    if other != peer:
                        other.send(peer.cursor)
            elif kind == 'ping':
                # Refresh persisted presence for room discovery and recover interrupted grading.
                self.publish(peer.code)
            else:
                raise ValueError('Unknown message')


hub = Hub()


def init_app(app):
    app.config['SOCK_SERVER_OPTIONS'] = {'ping_interval': 25, 'max_message_size': 256 * 1024}
    sock = Sock(app)
    rooms.on_change = hub.publish

    @sock.route('/ws/rooms/<code>')
    def room_socket(ws, code):
        peer = None
        try:
            origin = request.headers.get('Origin')
            if origin and urlsplit(origin).netloc != request.host:
                raise ValueError('Invalid origin')
            profile = request.args.get('profile', '')
            client = request.args.get('client', '')
            if not client or len(client) > 128:
                raise ValueError('Invalid editor client')
            rooms.view(code, profile)  # A socket never joins a profile to a room.
            peer = Peer(ws, code, profile, client)
            with hub.lock:
                hub.peers.add(peer)
                peer.identity = next(p for p in hub.state(peer)['participants'] if p['id'] == profile)
                hub.publish(code)
            while True:
                raw = ws.receive()
                if raw is None:
                    break
                try:
                    hub.receive(peer, json.loads(raw))
                except (ValueError, TypeError, KeyError, UnicodeError) as error:
                    peer.send({'type': 'error', 'message': str(error)})
        except (ValueError, ConnectionClosed, OSError) as error:
            if peer is None:
                try:
                    ws.send(json.dumps({'type': 'error', 'message': str(error)}))
                except (ConnectionClosed, OSError):
                    pass
        finally:
            if peer:
                with hub.lock:
                    hub.peers.discard(peer)
                    for other in hub.members(code):
                        other.send({'type': 'cursor', 'client': peer.client, 'anchor': None})
                    hub.publish(code)
                peer.queue.put(None)

    return sock
