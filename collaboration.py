"""CodeMirror's central editing authority. Clients rebase rejected concurrent edits."""
import time
import rooms


def apply_changes(document, changes):
    """Apply CodeMirror ChangeSet JSON using JavaScript's UTF-16 coordinates."""
    if not isinstance(changes, list):
        raise ValueError('Invalid edit')
    raw = document.encode('utf-16-le')
    offset = 0
    output = []
    for part in changes:
        if type(part) is int and part >= 0:
            end = offset + part * 2
            output.append(raw[offset:end])
        elif (isinstance(part, list) and len(part) >= 1 and type(part[0]) is int
              and part[0] >= 0 and all(isinstance(line, str) for line in part[1:])):
            end = offset + part[0] * 2
            output.append('\n'.join(part[1:]).encode('utf-16-le'))
        else:
            raise ValueError('Invalid edit')
        if end > len(raw):
            raise ValueError('Edit exceeds document')
        offset = end
    if offset != len(raw):
        raise ValueError('Edit does not match document')
    try:
        result = b''.join(output).decode('utf-16-le')
        if len(result) > 16000:
            raise ValueError('Answer must contain at most 16000 characters')
        return result
    except UnicodeError:
        raise ValueError('Invalid text boundaries') from None


def document(code, profile, round_id=None, version=None):
    with rooms.transaction(code, write=False) as room:
        rooms._member(room, profile)
        current = room['round']
        if room['mode'] != 'coop':
            return None
        updates = current.get('editor_updates', [])
        response = {'round_id': current['id'], 'doc': current.get('draft', ''), 'version': len(updates)}
        if round_id == current['id'] and type(version) is int and 0 <= version <= len(updates):
            response['from'] = version
            response['updates'] = updates[version:]
        return response


def update(code, profile, round_id, version, updates, client_id):
    with rooms.transaction(code) as room:
        rooms._member(room, profile)['seen'] = time.time()
        current = room['round']
        if room['mode'] != 'coop' or room['closed'] or current['submissions'] or round_id != current['id']:
            raise ValueError('This shared answer is no longer editable')
        history = current.setdefault('editor_updates', [])
        if type(version) is not int or not 0 <= version <= len(history):
            raise ValueError('Invalid editor version')
        if version != len(history):
            return {'type': 'updates', 'round_id': round_id, 'from': version, 'updates': history[version:]}
        if not isinstance(updates, list) or not 1 <= len(updates) <= 128:
            raise ValueError('Invalid edits')
        draft = current.get('draft', '')
        accepted = []
        for entry in updates:
            if not isinstance(entry, dict) or entry.get('clientID') != client_id:
                raise ValueError('Invalid editor client')
            draft = apply_changes(draft, entry.get('changes'))
            accepted.append({'changes': entry['changes'], 'clientID': client_id})
        current['draft'] = draft
        current['draft_revision'] = current.get('draft_revision', 0) + 1
        current['editor_updates'] = history + accepted
        return {'type': 'updates', 'round_id': round_id, 'from': version, 'updates': accepted}
