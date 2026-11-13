import hashlib
import json
import tempfile
import struct
import unittest
import zlib
from pathlib import Path
from unittest.mock import patch

from case_data import load_case, parse_case
from runtime import Operations, validate_image, run_case

def chunk(kind, data): return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xffffffff)
PNG = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 1, 1, 8, 6, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(b'\x00\x00\x00\x00\xff')) + chunk(b'IEND', b'')

class Tree:
    def dump_to_file(self, file):
        Path(file).write_text(json.dumps(self.root), encoding='utf-8')
    root = {'attributes': {'bounds': '[0,0][100,200]'}, 'children': [
        {'attributes': {'text': '确定', 'type': 'Button', 'bounds': '[10,10][60,50]'}},
        {'attributes': {'text': '确定', 'type': 'Button', 'bounds': '[10,210][60,250]'}},
    ]}

class Driver:
    UiTree = Tree()
    def capture_screen(self, path, in_pc=True): Path(path).write_bytes(PNG)
    def stop_app(self, package): pass
    def start_app(self, package, ability): pass
    def close(self): self.closed = True
    def wake_up_display(self): pass

class RuntimeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.case = {'id': 'C1', 'preconditions': {'startAnchor': {'text': '确定'}, 'state': {'button': '确定'}},
                     'phaseLocators': {'confirm': {'before': {'text': '确定'}, 'after': {'type': 'Button'}}},
                     'assertions': [{'id': 'A1', 'kind': 'functional', 'beforeExpected': '确定', 'afterExpected': '确定'}],
                     'capturePoints': [{'id': 'P1', 'assertionIds': ['A1']}]}
        self.ops = Operations(Driver(), self.temp.name, self.case, 'before', 'R1', 1)

    def program(self):
        text = {'$ref': ['confirm', 'attributes', 'text']}
        return {
            'schemaVersion': 1,
            'verify_preconditions': [
                {'op': 'locator', 'args': ['confirm'], 'save': 'selector'},
                {'op': 'require_visible', 'args': [{'$ref': ['selector']}], 'save': 'confirm'},
                {'op': 'data_ready', 'args': [{'button': text}]},
            ],
            'navigate': [],
            'verify_target': [{'op': 'require_visible', 'args': [{'$ref': ['selector']}]}],
            'scenarios': [{'op': 'check', 'args': ['A1', text]}, {'op': 'capture', 'args': ['P1']}],
        }

    def test_unique_visible_target_and_scope(self):
        self.assertEqual(self.ops.require_visible({'text': '确定'})['attributes']['type'], 'Button')
        root = {'attributes': {'bounds': '[0,0][100,200]'}, 'children': [Tree.root['children'][0]] * 2}
        self.assertRaises(RuntimeError, self.ops.require_visible, {'text': '确定'}, root=root)

    def test_assertion_failure_is_observed_not_a_pass(self):
        self.assertRaises(AssertionError, self.ops.check, 'A1', 'wrong')
        self.assertEqual(self.ops.observations[0]['status'], 'FAIL')
        self.assertRaises(ValueError, self.ops.check, 'unknown', 'x')

    def test_capture_is_explicit_unique_and_rejects_truncation(self):
        # 使用生产校验器检查完整PNG，不能只看文件存在。
        image = Path(self.temp.name) / 'bad.png'; image.write_bytes(PNG[:45])
        self.assertRaises(ValueError, validate_image, image)
        self.ops.capture('P1')
        self.assertRaises(ValueError, self.ops.capture, 'P1')
        self.assertRaises(ValueError, self.ops.capture, 'undeclared')
        self.assertEqual(self.ops.captures[0]['captureId'], 'P1')

    def test_unfilled_or_unknown_actions_and_forward_references_are_refused(self):
        for steps in ([], [{'op': 'driver'}], [{'op': '__class__'}],
                      [{'op': 'check', 'args': ['A1', {'$ref': ['unknown']}]}],
                      [{'op': 'check', 'args': ['A1', 'wrong']}]):
            with self.subTest(steps=steps), self.assertRaises(ValueError):
                parse_case(json.dumps({**self.program(), 'scenarios': steps}), self.case)

    def test_old_python_cannot_access_host_builtins(self):
        source = """
def verify_preconditions(ops, marker=__builtins__["open"]("marker")):
    ops.data_ready({})
def navigate(ops):
    pass
def verify_target(ops):
    ops.tree()
def scenarios(ops):
    ops.tree()
"""
        with self.assertRaises(ValueError):
            parse_case(source, self.case)

    def test_invalid_wait_is_refused_before_querying_driver(self):
        for value in (float('nan'), float('inf'), 0, -1, 31, True):
            with self.subTest(value=value), patch.object(self.ops, 'require_visible', return_value={}) as locate:
                with self.assertRaises(ValueError):
                    self.ops.wait_visible({'text': '确定'}, timeout=value)
                locate.assert_not_called()

    def test_wait_ends_at_deadline_and_keeps_locator_error(self):
        now = [0.0]
        def sleep(duration): now[0] += duration
        with patch('runtime.time.monotonic', side_effect=lambda: now[0]), patch('runtime.time.sleep', side_effect=sleep):
            with patch.object(self.ops, 'require_visible', side_effect=RuntimeError('目标重复')) as locate:
                with self.assertRaisesRegex(RuntimeError, '目标重复'):
                    self.ops.wait_visible({'text': '确定'}, timeout=0.15)
                self.assertEqual(locate.call_count, 2)
        self.assertEqual(now[0], 0.15)

    def test_illegal_png_depth_is_not_valid_evidence(self):
        bad = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 1, 1, 3, 6, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(b'\x00\x00')) + chunk(b'IEND', b'')
        file = Path(self.temp.name) / 'bad-depth.png'; file.write_bytes(bad)
        self.assertRaises(ValueError, validate_image, file)

    def test_capture_names_cannot_overwrite_worker_metadata(self):
        self.case['capturePoints'] += [{'id': 'result', 'assertionIds': ['A1']}, {'id': 'request', 'assertionIds': ['A1']}]
        original = Path(self.temp.name) / 'request.json'; original.write_text('{"request":true}')
        self.ops.capture('result'); self.ops.capture('request')
        self.assertEqual(json.loads(original.read_text()), {'request': True})
        self.assertTrue(all(c['layoutTree'].startswith('captures/') for c in self.ops.captures))

    def test_case_records_real_driver_values_and_capture(self):
        source = json.dumps(self.program()).encode('utf-8')
        script = Path(self.temp.name) / 'case.json'; script.write_bytes(source)
        script_hash = hashlib.sha256(source).hexdigest()
        with self.assertRaisesRegex(ValueError, '冻结用例内容'):
            load_case(script, self.case, 'incorrect')
        program = load_case(script, self.case, script_hash)
        result = run_case(program, script_hash, self.ops, {'package': 'pkg', 'ability': 'Ability'})
        self.assertEqual(result['status'], 'EXECUTED')
        self.assertEqual(result['observations'][0]['actual'], '确定')
        self.assertEqual(result['dataState']['actual'], {'button': '确定'})
        self.assertEqual(result['captures'][0]['captureId'], 'P1')
        self.assertEqual(result['scriptSha256'], script_hash)
        self.assertTrue(self.ops.driver.closed)

if __name__ == '__main__': unittest.main()
