"""Read local Codex metadata; never call Codex, read media or alter conversations."""
import argparse
import contextlib
import datetime as dt
import json
import os
from pathlib import Path
import re
import sqlite3
import time

WARN_BYTES = 20_000_000
HANDOFF_BYTES = 25_000_000
CONTROL_METHODS = {'thread/read', 'thread/list', 'thread/turns/list',
                   'mcpServerStatus/list', 'config/read', 'hooks/list'}
PAIR = re.compile(r'\b(\w+)=("[^"\n]*"|[^\s,}]+)')
HTTP_TARGET = 'codex_http_client::request'


def stamp(seconds):
    return dt.datetime.fromtimestamp(seconds, dt.timezone.utc).isoformat().replace('+00:00', 'Z')


def seconds(value):
    parsed = dt.datetime.fromisoformat(value.replace('Z', '+00:00'))
    if parsed.tzinfo is None:
        raise ValueError('Timestamp must include timezone')
    return parsed.timestamp()


def read_json(path, limit=262144):
    if path.stat().st_size > limit:
        raise ValueError('State too large')
    return json.loads(path.read_text(encoding='utf-8-sig'))


def write_json(path, value):
    temporary = path.with_name(path.name + '.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
    os.replace(temporary, path)


def scope(state):
    ids = {state['owner_thread_id']}
    ids.update(t['thread_id'] for t in state['tasks'] if t.get('thread_id'))
    if len(ids) > 100 or not all(isinstance(t, str) and 0 < len(t) <= 100 for t in ids):
        raise ValueError('Invalid monitor scope')
    return sorted(ids)


def parse_http(body, timestamp, thread_id):
    # Only explicit size metadata. No request body, header, media or token estimate.
    values = dict(re.findall(r'\b(pre_compression_bytes|post_compression_bytes)=(\d+)\b', body))
    if 'pre_compression_bytes' not in values:
        return None
    return {'thread_id': thread_id, 'at': timestamp,
            'bytes': int(values['pre_compression_bytes']),
            'compressed_bytes': int(values['post_compression_bytes']) if 'post_compression_bytes' in values else None}


def parse_control(line):
    try:
        at = seconds(line[:24])
    except (ValueError, TypeError):
        return None
    fields = {k: v.strip('"') for k, v in PAIR.findall(line)}
    # The durable/cloud connection is a different channel, often reconnecting on its own.
    if fields.get('hostId', 'local') not in ('local', 'null'):
        return None
    method = fields.get('method')
    if method not in CONTROL_METHODS:
        return None
    duration = fields.get('durationMs', '')
    if 'response_routed' in line and duration.isdigit():
        duration = int(duration)
        return {'at': at, 'method': method, 'kind': 'response', 'duration_ms': duration,
                'bad': duration >= 30000, 'healthy': duration < 5000}
    if 'mcp_request_timeout' in line or 'app_server_client_request_queue_rejected' in line:
        return {'at': at, 'method': method, 'kind': 'timeout', 'bad': True, 'healthy': False}
    return None


def empty_cache():
    return {'schema_version': 1, 'db_cursor': None, 'initialized': [], 'payloads': {},
            'files': {}, 'control_events': [], 'blocked_at': None, 'desktop_last_at': None}


class Monitor:
    def __init__(self, database, desktop_logs, cache=None):
        self.database = Path(database)
        self.desktop_logs = Path(desktop_logs)
        self.cache = cache or empty_cache()

    def read_database(self, targets):
        errors = []
        deadline = time.monotonic() + 2
        con = sqlite3.connect(self.database.resolve().as_uri() + '?mode=ro', uri=True, timeout=.2)
        try:
            con.execute('PRAGMA query_only=ON')
            con.set_progress_handler(lambda: int(time.monotonic() > deadline), 1000)
            maximum = con.execute('SELECT max(id) FROM logs').fetchone()[0] or 0
            cursor = self.cache['db_cursor']
            if cursor is not None and maximum < cursor:
                # Source replaced/rotated: preserve warnings, reseed bounded metadata.
                self.cache['initialized'] = []
                cursor = None
            for thread_id in targets:
                if thread_id in self.cache['initialized']:
                    continue
                rows = con.execute('''SELECT id,ts,body FROM (
                    SELECT id,ts,target,substr(feedback_log_body,1,8192) body
                    FROM logs WHERE thread_id=? ORDER BY id DESC LIMIT 2000
                    ) WHERE target=? ORDER BY id''', (thread_id, HTTP_TARGET))
                for ident, at, body in rows:
                    self.accept_http(parse_http(body or '', at, thread_id))
                self.cache['initialized'].append(thread_id)
            if cursor is not None:
                end = min(maximum, cursor + 20000)
                placeholders = ','.join('?' for _ in targets)
                rows = con.execute(f'''SELECT ts,thread_id,substr(feedback_log_body,1,8192)
                    FROM logs WHERE id>? AND id<=? AND target=?
                    AND thread_id IN ({placeholders}) ORDER BY id''',
                    [cursor, end, HTTP_TARGET, *targets])
                for at, thread_id, body in rows:
                    self.accept_http(parse_http(body or '', at, thread_id))
                if end < maximum:
                    errors.append('database_backlog')
                self.cache['db_cursor'] = end
            else:
                self.cache['db_cursor'] = maximum
        finally:
            con.close()
        return errors

    def accept_http(self, event):
        if not event:
            return
        previous = self.cache['payloads'].get(event['thread_id'], {})
        peak = max(event['bytes'], previous.get('peak_bytes', previous.get('bytes', 0)))
        peak_at = event['at'] if peak == event['bytes'] else previous.get('peak_at', previous.get('at'))
        if event['at'] >= previous.get('at', 0):
            # Critical latch: an isolated small request does not prove history was evicted.
            event['handoff_latched'] = previous.get('handoff_latched', False) or event['bytes'] >= HANDOFF_BYTES
            self.cache['payloads'][event['thread_id']] = event
        elif event['bytes'] >= HANDOFF_BYTES:
            previous['handoff_latched'] = True
        self.cache['payloads'][event['thread_id']].update(peak_bytes=peak, peak_at=peak_at)

    def read_desktop(self, now):
        errors = []
        # Only today's and yesterday's directories; no recursive scan of chat history.
        paths = []
        for delta in (0, 1):
            date = dt.datetime.fromtimestamp(now, dt.timezone.utc) - dt.timedelta(days=delta)
            folder = self.desktop_logs / date.strftime('%Y/%m/%d')
            paths.extend(folder.glob('*.log'))
        if not paths:
            return ['desktop_logs_unavailable']
        # Old rotated files cannot contain a current control event. Avoid rescanning
        # megabytes of historical diagnostics on first start or after rotation.
        paths = [p for p in paths if p.stat().st_mtime >= now - 600]
        paths.sort(key=lambda p: p.stat().st_mtime, reverse=True)
        current = set()
        events = []
        budget = 4 * 1024 * 1024
        for path in paths[:12]:
            key = str(path)
            current.add(key)
            stat = path.stat()
            old = self.cache['files'].get(key) or next((v for v in self.cache['files'].values()
                if v['inode'] == stat.st_ino), None)
            offset = old['offset'] if old and old['inode'] == stat.st_ino and old['offset'] <= stat.st_size else max(0, stat.st_size - 1024 * 1024)
            with path.open('rb') as stream:
                stream.seek(offset)
                if offset and (not old or offset != old['offset']):
                    stream.readline()  # Discard partial initial line.
                while budget > 0:
                    start = stream.tell()
                    raw = stream.readline(min(budget + 1, 65537))
                    if not raw:
                        break
                    if not raw.endswith(b'\n'):
                        if len(raw) >= 65537:
                            # Large non-metadata line: skip to newline in bounded chunks.
                            while raw and not raw.endswith(b'\n') and budget > 0:
                                budget -= len(raw)
                                raw = stream.readline(min(budget + 1, 65537))
                        else:
                            stream.seek(start)  # Incomplete write: retry next poll.
                            break
                    budget -= len(raw)
                    line = raw.decode('utf-8', 'replace')
                    try:
                        at = seconds(line[:24])
                        self.cache['desktop_last_at'] = max(at, self.cache['desktop_last_at'] or 0)
                    except ValueError:
                        continue
                    event = parse_control(line)
                    if event and now - 600 <= event['at'] <= now + 5:
                        events.append(event)
                self.cache['files'][key] = {'offset': stream.tell(), 'inode': stat.st_ino}
                if stream.tell() < stat.st_size:
                    errors.append('desktop_backlog')
            if budget <= 0:
                errors.append('desktop_scan_budget')
                break
        self.cache['files'] = {k: v for k, v in self.cache['files'].items() if k in current}
        self.cache['control_events'].extend(events)
        return errors

    def sample(self, state, now=None):
        now = time.time() if now is None else now
        targets = scope(state)
        errors = []
        for reader, arguments in ((self.read_database, (targets,)), (self.read_desktop, (now,))):
            try:
                errors.extend(reader(*arguments))
            except (OSError, sqlite3.Error, ValueError):
                # Never serialize raw exception strings which may include user data.
                errors.append('database_unavailable' if reader == self.read_database else 'desktop_logs_unavailable')
        # Explicit coordinator probes can supplement buffered Desktop logs. No RPC here.
        probe = state.get('control_probe')
        if probe:
            try:
                at = seconds(probe['at'])
                duration = probe['duration_ms']
                if not isinstance(duration, (int, float)) or duration < 0:
                    raise ValueError('Invalid duration')
                signature = [at, duration, probe['outcome']]
                if now - 600 <= at <= now + 5 and probe['outcome'] in ('ok', 'timeout', 'error') and signature != self.cache.get('probe_seen'):
                    self.cache['control_events'].append({'at': at, 'method': 'coordinator_probe',
                        'kind': probe['outcome'], 'duration_ms': duration,
                        'bad': probe['outcome'] != 'ok' or duration >= 30000,
                        'healthy': probe['outcome'] == 'ok' and duration < 5000})
                    self.cache['probe_seen'] = signature
            except (KeyError, TypeError, ValueError):
                errors.append('invalid_control_probe')
        events = {json.dumps(e, sort_keys=True): e for e in self.cache['control_events'] if now - 600 <= e['at'] <= now + 5}
        events = sorted(events.values(), key=lambda e: e['at'])
        bad = [e['at'] for e in events if e['bad']]
        slow = [e['at'] for e in events if e.get('duration_ms', 0) >= 10000]
        # Two slow controls within 2 min also open the circuit.
        bad += [b for a, b in zip(slow, slow[1:]) if b - a <= 120]
        blocked = self.cache['blocked_at']
        if bad:
            blocked = max(max(bad), blocked or 0)
        healthy = sorted({e['at'] for e in events if e['healthy'] and e['at'] > (blocked or 0)})
        # Recovery requires two distinct successful observations at least 15 seconds apart.
        recovered = len(healthy) >= 2 and healthy[-1] - healthy[0] >= 15
        if blocked and recovered:
            blocked = None
            kept = [e for e in events if e['at'] >= healthy[-1]]
        else:
            # Evaluate before bounding history. Retain the observations needed to
            # prove recovery even if hundreds of fast controls arrive in one burst.
            kept = events[-200:]
            if healthy:
                kept += [e for e in events if e['at'] == healthy[0]]
            if slow:
                kept += [e for e in events if e['at'] == slow[-1]]
        self.cache['control_events'] = list({json.dumps(e, sort_keys=True): e for e in kept}.values())
        self.cache['blocked_at'] = blocked
        control = 'blocked' if blocked else 'ok' if healthy and now - healthy[-1] <= 120 else 'unknown'
        if errors and control != 'blocked':
            control = 'unknown'
        payloads = []
        for thread_id in targets:
            value = self.cache['payloads'].get(thread_id)
            payloads.append({'thread_id': thread_id,
                'level': 'handoff' if value and value['handoff_latched'] else 'warn' if value and value.get('peak_bytes', value['bytes']) >= WARN_BYTES else 'normal' if value else 'unknown',
                'last_http_bytes': value['bytes'] if value else None,
                'last_http_at': stamp(value['at']) if value else None,
                'peak_http_bytes': value.get('peak_bytes', value['bytes']) if value else None,
                'peak_http_at': stamp(value.get('peak_at', value['at'])) if value else None,
                'measurement': 'last_observed_http_only' if value else 'unavailable'})
        self.cache['initialized'] = [i for i in self.cache['initialized'] if i in targets]
        self.cache['payloads'] = {k: v for k, v in self.cache['payloads'].items() if k in targets}
        return {'schema_version': 1, 'workflow_id': state['workflow_id'],
                'owner_thread_id': state['owner_thread_id'], 'generation': state['generation'],
                'sampled_at': stamp(now), 'pid': os.getpid(), 'scope': targets,
                'thresholds_bytes': {'warn': WARN_BYTES, 'handoff': HANDOFF_BYTES},
                'control': {'status': control, 'blocked_at': stamp(blocked) if blocked else None,
                            'last_healthy_at': stamp(healthy[-1]) if healthy else None,
                            'recent_evidence': events[-6:]},
                'sources': {'errors': sorted(set(errors)),
                            'desktop_last_event_at': stamp(self.cache['desktop_last_at']) if self.cache['desktop_last_at'] else None,
                            'body_coverage': 'HTTP metadata only; WebSocket body size unknown'},
                'threads': payloads}


@contextlib.contextmanager
def single_writer(path):
    with path.open('a+b') as handle:
        handle.seek(0)
        handle.write(b'0')
        handle.flush()
        handle.seek(0)
        if os.name == 'nt':
            import msvcrt
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            yield
        finally:
            handle.seek(0)
            if os.name == 'nt':
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(handle, fcntl.LOCK_UN)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--state', required=True, type=Path)
    parser.add_argument('--codex-home', type=Path, default=Path(os.environ.get('CODEX_HOME', Path.home()/'.codex')))
    parser.add_argument('--desktop-logs', type=Path, default=Path(os.environ.get('LOCALAPPDATA', Path.home()))/'Codex/Logs')
    parser.add_argument('--watch', action='store_true')
    parser.add_argument('--duration-seconds', type=int, default=28800)
    args = parser.parse_args()
    directory = args.state.resolve().parent
    cache_file, health_file = directory/'monitor-cursor.json', directory/'health.json'
    with single_writer(directory/'monitor.lock'):
        try:
            cache = read_json(cache_file)
            if cache.get('schema_version') != 1:
                raise ValueError('Unsupported cache')
        except (OSError, ValueError):
            cache = empty_cache()
        monitor = Monitor(args.codex_home/'logs_2.sqlite', args.desktop_logs, cache)
        deadline = time.monotonic() + max(1, args.duration_seconds)
        while True:
            if (directory/'monitor.stop').exists():
                break
            try:
                health = monitor.sample(read_json(args.state))
                write_json(cache_file, monitor.cache)
                write_json(health_file, health)
            except (OSError, ValueError, KeyError, TypeError):
                # Previous health expires in 45 s; never claim successful observation.
                print('Monitor state unreadable; new dispatch must remain paused.', flush=True)
                if not args.watch:
                    return 1
            if not args.watch or time.monotonic() >= deadline:
                break
            time.sleep(min(15, max(0, deadline - time.monotonic())))
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except OSError:
        raise SystemExit('Monitor unavailable or another writer owns this workflow; inspect health.json freshness.')
