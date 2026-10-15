"""Firefox Native Messaging host. Only configured subtitle-cache operations are exposed."""
import base64
import hashlib
import json
import math
import os
from pathlib import Path
import re
import struct
import sys
import tempfile
import uuid

MAX_BYTES = 64 * 1024 * 1024
CHUNK_BYTES = 96 * 1024
KEY = re.compile(r'[a-f0-9]{64}')
REVISION = re.compile(r'rev-[a-f0-9]{32}')


def json_bytes(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode('utf-8')


def safe_child(parent, name):
    child = parent / name
    if child.is_symlink() or (hasattr(child, 'is_junction') and child.is_junction()) or child.resolve().parent != parent.resolve():
        raise ValueError('Invalid cache location')
    return child


def checked_record(value):
    if not isinstance(value, dict) or value.get('version') != 3 or not KEY.fullmatch(str(value.get('id', ''))):
        raise ValueError('Invalid cache')
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,64}', value.get('videoId', '')) or not KEY.fullmatch(value.get('configFingerprint', '')):
        raise ValueError('Invalid identity')
    track = value['track']
    if not isinstance(track.get('language'), str) or not 0 < len(track['language']) <= 60:
        raise ValueError('Invalid track')
    cues = value['cues']
    if not isinstance(cues, list) or not 0 < len(cues) <= 100_000:
        raise ValueError('Invalid cues')
    known, normalized, last, total = set(), [], -1, 0
    for cue in cues:
        if (not isinstance(cue['id'], str) or not 0 < len(cue['id']) <= 160 or cue['id'] in known
                or not isinstance(cue['text'], str) or not cue['text'].strip() or len(cue['text']) > 20_000
                or not all(isinstance(cue[k], (int, float)) and math.isfinite(cue[k]) for k in ('start', 'end'))
                or cue['start'] < max(0, last) or cue['end'] <= cue['start']):
            raise ValueError('Invalid cue')
        last = cue['start']; known.add(cue['id']); total += len(cue['text'])
        normalized.append({k: cue[k] for k in ('id', 'start', 'end', 'text')})
    if total > 5_000_000:
        raise ValueError('Oversize source')
    rows = {}
    for row in value['translations']:
        if row['id'] not in known or row['id'] in rows or not isinstance(row['text'], str) or not row['text'].strip() or len(row['text']) > 40_000:
            raise ValueError('Invalid translation')
        rows[row['id']] = {'id': row['id'], 'text': row['text'].strip()}
    result = {k: value[k] for k in ('id', 'videoId', 'configFingerprint', 'model', 'targetLanguage')}
    if any(not isinstance(result[k], str) or len(result[k]) > 200 for k in result):
        raise ValueError('Invalid metadata')
    if any(not isinstance(value.get(k, 0), (int, float)) or not math.isfinite(value.get(k, 0)) for k in ('createdAt', 'updatedAt')):
        raise ValueError('Invalid timestamps')
    result.update(version=3, title=str(value.get('title', value['videoId']))[:500],
                  track={'id': str(track.get('id', ''))[:160], 'language': track['language'], 'automatic': track.get('automatic') is True},
                  cues=normalized, translations=[rows[c['id']] for c in normalized if c['id'] in rows],
                  revision=max(0, int(value.get('revision', 0))),
                  createdAt=value.get('createdAt', 0), updatedAt=value.get('updatedAt', 0))
    result['state'] = 'complete' if len(rows) == len(cues) else 'paused'
    return result


def stamp(seconds):
    milliseconds = math.floor(seconds * 1000 + .5)
    return f'{milliseconds // 3600000:02}:{milliseconds // 60000 % 60:02}:{milliseconds // 1000 % 60:02},{milliseconds % 1000:03}'


def text(value):
    return '\r\n'.join(line.strip() for line in re.sub(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]', '', value).replace('\r\n', '\n').replace('\r', '\n').split('\n') if line.strip())


def srt(record, bilingual=False):
    rows = {row['id']: row['text'] for row in record['translations']}
    cues = [c for c in record['cues'] if not bilingual or c['id'] in rows]
    return ''.join(f'{i}\r\n{stamp(c["start"])} --> {stamp(c["end"])}\r\n{text(c["text"])}'
                   + ('\r\n' + text(rows[c['id']]) if bilingual else '') + '\r\n\r\n' for i, c in enumerate(cues, 1))


class CacheHost:
    def __init__(self):
        self.folder = None
        self.upload = None
        self.download = None

    def location(self, key):
        if not self.folder or not isinstance(key, str) or not KEY.fullmatch(key):
            raise ValueError('Invalid cache key')
        return safe_child(self.folder, key)

    def read(self, key):
        # A writer can retire the old revision between reading its pointer and
        # opening the source. Retry the pointer, never treat that race as a miss.
        for _ in range(3):
            try:
                return self.read_revision(key)
            except FileNotFoundError:
                continue
        raise ValueError('Cache revision unavailable')

    def read_revision(self, key):
        location = self.location(key)
        pointer = safe_child(location, 'current.json')
        if not pointer.exists():
            return None
        if pointer.stat().st_size > 4096:
            raise ValueError('Invalid pointer')
        revision = json.loads(pointer.read_text('utf-8'))['revision']
        if not isinstance(revision, str) or not REVISION.fullmatch(revision):
            raise ValueError('Invalid revision')
        source = safe_child(safe_child(location, revision), 'subtitles.json')
        if source.stat().st_size > MAX_BYTES:
            raise ValueError('Oversize cache')
        record = checked_record(json.loads(source.read_text('utf-8')))
        if record['id'] != key:
            raise ValueError('Mismatched key')
        return record

    def write(self, record):
        record = checked_record(record)
        location = self.location(record['id']); location.mkdir(exist_ok=True)
        previous = None
        try:
            previous = self.read(record['id'])
        except (ValueError, OSError, KeyError, TypeError):
            pass  # Explicit save may replace a corrupt cache, never a failed write.
        if previous:
            if (any(previous[k] != record[k] for k in ('videoId', 'configFingerprint', 'cues', 'model', 'targetLanguage'))
                    or previous['track']['language'].lower() != record['track']['language'].lower()
                    or previous['track']['automatic'] != record['track']['automatic']):
                raise ValueError('Mismatched source')
            newer, older = (previous, record) if previous['revision'] > record['revision'] else (record, previous)
            merged = {row['id']: row for row in newer['translations']}
            for row in older['translations']:
                merged.setdefault(row['id'], row)
            record['translations'] = [merged[c['id']] for c in record['cues'] if c['id'] in merged]
            record['revision'] = max(record['revision'], previous['revision'])
        record['state'] = 'complete' if len(record['translations']) == len(record['cues']) else 'paused'
        revision = 'rev-' + uuid.uuid4().hex
        stage = safe_child(location, revision); stage.mkdir()
        old_revision = None
        pointer = safe_child(location, 'current.json')
        try:
            if pointer.exists() and pointer.stat().st_size <= 4096:
                old_revision = json.loads(pointer.read_text('utf-8')).get('revision')
        except (ValueError, OSError):
            pass
        pointer_temp = safe_child(location, revision + '.json')
        try:
            safe_child(stage, 'subtitles.json').write_bytes(json_bytes(record))
            safe_child(stage, 'original.srt').write_bytes(srt(record).encode('utf-8'))
            if record['translations']:
                filename = 'bilingual.srt' if record['state'] == 'complete' else 'bilingual.partial.srt'
                safe_child(stage, filename).write_bytes(srt(record, True).encode('utf-8'))
            pointer_temp.write_bytes(json_bytes({'revision': revision, 'videoId': record['videoId'], 'title': record['title'],
                                                 'translatedCount': len(record['translations']), 'total': len(record['cues'])}))
            os.replace(pointer_temp, pointer)
        except Exception:
            pointer_temp.unlink(missing_ok=True)
            self.cleanup_revision(location, revision)
            raise
        if old_revision and old_revision != revision:
            self.cleanup_revision(location, old_revision)
        return {'path': str(stage), 'folder': str(self.folder), 'translatedCount': len(record['translations']),
                'total': len(record['cues']), 'complete': record['state'] == 'complete'}

    @staticmethod
    def cleanup_revision(location, revision):
        # Delete only generated filenames inside the exact verified revision;
        # preserve user-added files and never recursively remove a directory.
        if not isinstance(revision, str) or not REVISION.fullmatch(revision):
            return
        try:
            folder = safe_child(location, revision)
            for name in ('subtitles.json', 'original.srt', 'bilingual.srt', 'bilingual.partial.srt'):
                safe_child(folder, name).unlink(missing_ok=True)
            folder.rmdir()
        except (OSError, ValueError):
            pass

    def handle(self, message):
        op = message['op']
        if op == 'configure':
            folder = Path(message['folder']).expanduser()
            if not folder.is_absolute():
                raise ValueError('Absolute directory required')
            folder.mkdir(parents=True, exist_ok=True)
            folder = folder.resolve(strict=True)
            with tempfile.TemporaryFile(dir=folder):
                pass
            self.folder = folder
            return {'folder': str(folder)}
        if not self.folder:
            raise ValueError('No directory configured')
        if op == 'open':
            if sys.platform != 'win32':
                raise ValueError('Windows only')
            os.startfile(str(self.folder))
            return {'folder': str(self.folder)}
        if op == 'read':
            record = self.read(message['key'])
            self.download = json_bytes(record) if record else None
            return {'size': len(self.download), 'sha256': hashlib.sha256(self.download).hexdigest()} if self.download else None
        if op == 'read-chunk':
            offset, size = message['offset'], message['size']
            if not self.download or type(offset) is not int or type(size) is not int or offset < 0 or not 0 < size <= CHUNK_BYTES or offset + size > len(self.download):
                raise ValueError('Invalid chunk')
            return base64.b64encode(self.download[offset:offset + size]).decode('ascii')
        if op == 'write-begin':
            if type(message['size']) is not int or not 0 < message['size'] <= MAX_BYTES or not KEY.fullmatch(message['sha256']):
                raise ValueError('Invalid upload')
            self.upload = {'size': message['size'], 'sha256': message['sha256'], 'bytes': bytearray()}
            return None
        if op == 'write-chunk':
            if not self.upload or len(message['data']) > CHUNK_BYTES * 4 // 3:
                raise ValueError('Invalid upload chunk')
            chunk = base64.b64decode(message['data'], validate=True)
            if len(self.upload['bytes']) + len(chunk) > self.upload['size']:
                raise ValueError('Oversize upload')
            self.upload['bytes'].extend(chunk)
            return None
        if op == 'write-commit':
            upload, self.upload = self.upload, None
            if not upload or len(upload['bytes']) != upload['size'] or hashlib.sha256(upload['bytes']).hexdigest() != upload['sha256']:
                raise ValueError('Incomplete upload')
            return self.write(json.loads(upload['bytes'].decode('utf-8')))
        raise ValueError('Unknown operation')


def main():
    if sys.platform == 'win32':
        import msvcrt
        msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
        msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)
    host = CacheHost()
    while True:
        header = sys.stdin.buffer.read(4)
        if not header:
            break
        if len(header) != 4:
            break
        length = struct.unpack('<I', header)[0]
        if not 0 < length <= 256 * 1024:
            break
        payload = sys.stdin.buffer.read(length)
        if len(payload) != length:
            break
        request = {}
        try:
            request = json.loads(payload.decode('utf-8'))
            response = {'id': request['id'], 'ok': True, 'data': host.handle(request)}
        except Exception:
            response = {'id': request.get('id'), 'ok': False, 'error': 'cache-operation-failed'}
        body = json_bytes(response)
        sys.stdout.buffer.write(struct.pack('<I', len(body)) + body)
        sys.stdout.buffer.flush()


if __name__ == '__main__':
    main()
