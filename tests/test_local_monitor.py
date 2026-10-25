import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('monitor', Path(__file__).parents[1]/'scripts/local-monitor.py')
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
NOW = mod.seconds('2026-01-01T12:00:00Z')


class MonitorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.db = self.root/'logs_2.sqlite'
        self.con = sqlite3.connect(self.db)
        self.con.execute('CREATE TABLE logs (id INTEGER PRIMARY KEY, ts INTEGER, target TEXT, thread_id TEXT, feedback_log_body TEXT)')
        self.folder = self.root/'desktop/2026/01/01'
        self.folder.mkdir(parents=True)
        self.log = self.folder/'desktop.log'
        self.log.write_text('', encoding='utf-8')
        self.state = {'workflow_id': 'test', 'owner_thread_id': 'owner', 'generation': 1,
                      'tasks': [{'thread_id': 'worker'}], 'control_probe':
                      {'at': mod.stamp(NOW), 'duration_ms': 50, 'outcome': 'ok'}}
        self.monitor = mod.Monitor(self.db, self.root/'desktop')

    def tearDown(self):
        self.con.close()
        self.temp.cleanup()

    def request(self, size, timestamp=NOW, thread='worker'):
        self.con.execute('INSERT INTO logs(ts,target,thread_id,feedback_log_body) VALUES(?,?,?,?)',
                         (timestamp, mod.HTTP_TARGET, thread, f'pre_compression_bytes={size} post_compression_bytes=12345'))
        self.con.commit()

    def control(self, timestamp, duration):
        with self.log.open('a', encoding='utf-8') as out:
            out.write(f'{mod.stamp(timestamp).replace("+00:00", "Z").replace("Z", ".000Z")} info response_routed method=thread/read durationMs={duration} queueWaitMs=0\n')

    def sample(self, at=NOW):
        return self.monitor.sample(self.state, at)

    def test_unknown_and_decimal_thresholds(self):
        self.assertEqual(self.sample()['threads'][1]['last_http_bytes'], None)
        for size, level in [(19999999, 'normal'), (20000000, 'warn'), (25000000, 'handoff')]:
            self.request(size)
            self.assertEqual(self.sample()['threads'][1]['level'], level)
        self.request(1000, NOW+1)
        self.assertEqual(self.sample(NOW+1)['threads'][1]['level'], 'handoff')

    def test_fresh_chat_has_no_inherited_payload(self):
        self.request(26000000)
        self.sample()
        self.state['tasks'] = [{'thread_id': 'fresh'}]
        result = self.sample()
        self.assertEqual(result['threads'][0]['level'], 'unknown')
        self.assertNotIn('worker', self.monitor.cache['payloads'])

    def test_delayed_critical_measurement_still_latches(self):
        self.request(1000, NOW+1)
        self.sample(NOW+1)
        self.request(26000000, NOW)
        value = self.sample(NOW+2)['threads'][1]
        self.assertEqual(value['level'], 'handoff')
        self.assertEqual(value['last_http_bytes'], 1000)

    def test_warning_is_not_overwritten_by_small_request_in_same_poll(self):
        self.request(21000000)
        self.request(1000, NOW+1)
        value = self.sample(NOW+1)['threads'][1]
        self.assertEqual(value['level'], 'warn')
        self.assertEqual(value['peak_http_bytes'], 21000000)
        self.assertEqual(value['last_http_bytes'], 1000)

    def test_timeout_latches_until_two_separated_successes(self):
        self.control(NOW, 151502)
        self.assertEqual(self.sample()['control']['status'], 'blocked')
        self.state.pop('control_probe')
        self.assertEqual(self.sample(NOW+900)['control']['status'], 'blocked')
        self.control(NOW+901, 34)
        self.assertEqual(self.sample(NOW+901)['control']['status'], 'blocked')
        self.control(NOW+917, 40)
        self.assertEqual(self.sample(NOW+917)['control']['status'], 'ok')
        self.assertEqual(self.sample(NOW+918)['control']['status'], 'ok')

    def test_two_slow_requests_and_single_long_request_block(self):
        self.control(NOW, 12000)
        self.assertEqual(self.sample()['control']['status'], 'ok')
        self.control(NOW+20, 11000)
        self.assertEqual(self.sample(NOW+20)['control']['status'], 'blocked')

    def test_durable_socket_is_not_local_control_failure(self):
        event = mod.parse_control('2026-01-01T12:00:00.000Z error mcp_request_timeout method=thread/read hostId=durable')
        self.assertIsNone(event)
        self.assertEqual(self.sample()['control']['status'], 'ok')

    def test_missing_database_and_expired_probe_fail_closed(self):
        self.monitor.database = self.root/'nonexistent.sqlite'
        result = self.sample()
        self.assertEqual(result['control']['status'], 'unknown')
        self.assertFalse(self.monitor.database.exists())
        self.monitor.database = self.db
        self.assertEqual(self.sample(NOW+130)['control']['status'], 'unknown')

    def test_partial_line_is_not_consumed_until_complete(self):
        self.log.write_text('2026-01-01T12:00:00.000Z info response_routed method=thread/read durationMs=673386', encoding='utf-8')
        self.assertEqual(self.sample()['control']['status'], 'unknown')
        with self.log.open('a', encoding='utf-8') as out:
            out.write(' queueWaitMs=0\n')
        self.assertEqual(self.sample()['control']['status'], 'blocked')

    def test_rotation_reads_new_file_and_retains_critical_latch(self):
        self.request(34000000)
        self.sample()
        self.control(NOW+1, 10)
        self.log.rename(self.folder/'rotated.log')
        self.control(NOW+2, 60000)
        result = self.sample(NOW+2)
        self.assertEqual(result['control']['status'], 'blocked')
        self.assertEqual(result['threads'][1]['level'], 'handoff')

    def test_outputs_never_contain_raw_payload_or_credentials(self):
        self.con.execute('INSERT INTO logs(ts,target,thread_id,feedback_log_body) VALUES(?,?,?,?)',
                         (NOW, mod.HTTP_TARGET, 'worker', 'SECRET-HEADER data:image/png;base64,SENSITIVE pre_compression_bytes=25000000'))
        self.con.commit()
        output = json.dumps(self.sample()) + json.dumps(self.monitor.cache)
        for forbidden in ('SECRET', 'SENSITIVE', 'data:image'):
            self.assertNotIn(forbidden, output)

    def test_single_writer_lock(self):
        with mod.single_writer(self.root/'monitor.lock'):
            with self.assertRaises(OSError):
                with mod.single_writer(self.root/'monitor.lock'):
                    pass

    def test_old_probe_does_not_reopen_recovered_circuit(self):
        self.state['control_probe'].update(outcome='timeout', duration_ms=30000)
        self.assertEqual(self.sample()['control']['status'], 'blocked')
        self.control(NOW+1, 10)
        self.assertEqual(self.sample(NOW+1)['control']['status'], 'blocked')
        self.control(NOW+17, 10)
        self.assertEqual(self.sample(NOW+17)['control']['status'], 'ok')
        self.assertEqual(self.sample(NOW+18)['control']['status'], 'ok')

    def test_burst_cannot_drop_failure_before_recovery_is_proven(self):
        self.state.pop('control_probe')
        self.monitor.cache['control_events'] = [
            {'at': NOW, 'kind': 'response', 'method': 'thread/read', 'duration_ms': 60000, 'bad': True, 'healthy': False},
            *[{'at': NOW + (i+1)/1000, 'kind': 'response', 'method': 'thread/read', 'duration_ms': 1, 'bad': False, 'healthy': True} for i in range(210)]]
        self.assertEqual(self.sample(NOW+1)['control']['status'], 'blocked')
        self.control(NOW+16, 10)
        self.assertEqual(self.sample(NOW+16)['control']['status'], 'ok')


if __name__ == '__main__':
    unittest.main()
