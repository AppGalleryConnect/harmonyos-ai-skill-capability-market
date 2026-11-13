"""Parse and execute bounded device instructions from JSON."""
import hashlib
import json
import math
import re
from pathlib import Path


STAGES = ('verify_preconditions', 'navigate', 'verify_target', 'scenarios')
MAX_CASE_BYTES = 256 * 1024
MAX_STEPS = 256
RESULT_NAME = re.compile(r'[A-Za-z][A-Za-z0-9_-]{0,63}')

# Minimum and maximum positional arguments, and whether a result can be saved.
OPERATIONS = {
    'tree': (0, 0, True), 'require_visible': (1, 2, True), 'wait_visible': (1, 3, True),
    'click': (1, 2, False), 'repeat_click': (1, 4, False), 'input': (2, 3, False),
    'back': (0, 0, False), 'wait': (1, 1, False),
    'locator': (1, 1, True), 'action': (1, 1, True),
    'data_ready': (1, 1, False), 'check': (2, 2, False), 'capture': (1, 1, False),
}


def object_fields(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('JSON字段重复: ' + key)
        result[key] = value
    return result


def finite_number(text):
    value = float(text)
    if not math.isfinite(value):
        raise ValueError('用例JSON不能包含非有限数值')
    return value


def validate_value(value, saved, depth=0):
    if depth > 16:
        raise ValueError('操作参数嵌套过深')
    if isinstance(value, dict):
        if '$ref' in value:
            ref = value['$ref']
            if (set(value) != {'$ref'} or not isinstance(ref, list) or not 1 <= len(ref) <= 16
                or not isinstance(ref[0], str) or ref[0] not in saved
                or any(not isinstance(key, str) and (type(key) is not int or key < 0) for key in ref[1:])):
                raise ValueError('引用必须指向已保存结果的字段或数组下标')
            return
        for child in value.values():
            validate_value(child, saved, depth + 1)
    elif isinstance(value, list):
        for child in value:
            validate_value(child, saved, depth + 1)


def parse_case(source, case):
    program = json.loads(source, object_pairs_hook=object_fields, parse_float=finite_number, parse_constant=finite_number)
    if (not isinstance(program, dict) or set(program) != {'schemaVersion', *STAGES}
        or type(program['schemaVersion']) is not int or program['schemaVersion'] != 1):
        raise ValueError('用例必须为版本1的四段JSON操作清单')
    saved, checks, captures = set(), set(), set()
    expected_checks = {item['id'] for item in case['assertions'] if item['kind'] == 'functional'}
    expected_captures = {item['id'] for item in case['capturePoints']}
    total, data_ready = 0, 0
    for stage in STAGES:
        steps = program[stage]
        if not isinstance(steps, list) or (stage != 'navigate' and not steps):
            raise ValueError('用例缺少操作: ' + stage)
        total += len(steps)
        if total > MAX_STEPS:
            raise ValueError('用例操作数量超限')
        for step in steps:
            if not isinstance(step, dict) or not set(step) <= {'op', 'args', 'save'}:
                raise ValueError('操作字段只允许op、args、save')
            op, args = step.get('op'), step.get('args', [])
            if not isinstance(op, str) or op not in OPERATIONS:
                raise ValueError('未知设备操作')
            low, high, can_save = OPERATIONS[op]
            if not isinstance(args, list) or not low <= len(args) <= high:
                raise ValueError('操作参数数量错误: ' + op)
            validate_value(args, saved)
            if op in ('check', 'capture'):
                used, expected = (checks, expected_checks) if op == 'check' else (captures, expected_captures)
                if not isinstance(args[0], str) or args[0] not in expected or args[0] in used:
                    raise ValueError('断言或采集点未声明或重复: ' + op)
                used.add(args[0])
            if op in ('locator', 'action'):
                declarations = case.get('phaseLocators' if op == 'locator' else 'phaseActions', {})
                if not isinstance(args[0], str) or args[0] not in declarations:
                    raise ValueError('缺少冻结的阶段声明: ' + op)
            if op == 'data_ready':
                if stage != 'verify_preconditions' or data_ready:
                    raise ValueError('仅在前置阶段核对一次复位状态')
                data_ready += 1
            if 'save' in step:
                name = step['save']
                if not can_save or not isinstance(name, str) or not RESULT_NAME.fullmatch(name) or name in saved:
                    raise ValueError('结果保存名非法或重复: ' + op)
                saved.add(name)
    if not data_ready or checks != expected_checks or captures != expected_captures:
        raise ValueError('用例缺少前置数据核对、功能断言或采集点')
    return program


def load_case(file, case, expected_hash):
    with Path(file).open('rb') as stream:
        source = stream.read(MAX_CASE_BYTES + 1)
    if len(source) > MAX_CASE_BYTES:
        raise ValueError('用例文件超过256 KiB')
    if hashlib.sha256(source).hexdigest() != expected_hash:
        raise ValueError('冻结用例内容发生变化')
    return parse_case(source.decode('utf-8'), case)


def resolve_value(value, saved):
    if isinstance(value, dict):
        if '$ref' in value:
            name, *keys = value['$ref']
            result = saved[name]
            for key in keys:
                if isinstance(result, dict) and isinstance(key, str) and key in result:
                    result = result[key]
                elif isinstance(result, list) and type(key) is int and key < len(result):
                    result = result[key]
                else:
                    raise ValueError('找不到已保存结果中的字段: ' + str(key))
            return result
        return {key: resolve_value(child, saved) for key, child in value.items()}
    if isinstance(value, list):
        return [resolve_value(child, saved) for child in value]
    return value


def execute_steps(steps, ops, saved):
    handlers = {name: getattr(ops, name) for name in OPERATIONS}
    for step in steps:
        args = resolve_value(step.get('args', []), saved)
        result = handlers[step['op']](*args)
        if 'save' in step:
            saved[step['save']] = result
