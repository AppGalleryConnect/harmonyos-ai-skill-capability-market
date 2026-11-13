"""设备动作、功能断言与取证；不选择CSV范围，不做视觉判定。"""
import hashlib
import json
import re
import struct
import time
import zlib
from pathlib import Path
from case_data import execute_steps


def digest(file):
    return hashlib.sha256(Path(file).read_bytes()).hexdigest()


def write_json(file, value):
    Path(file).write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def validate_image(file):
    """PNG必须具备完整分块/CRC/像素流；其他格式用Pillow实际解码。"""
    data = Path(file).read_bytes()
    if data.startswith(b'\x89PNG\r\n\x1a\n'):
        offset, streams, ended, header = 8, [], False, None
        while offset < len(data):
            if offset + 12 > len(data): raise ValueError('PNG分块截断')
            length = struct.unpack('>I', data[offset:offset + 4])[0]
            kind = data[offset + 4:offset + 8]
            end = offset + 8 + length
            if end + 4 > len(data): raise ValueError('PNG数据截断')
            content = data[offset + 8:end]
            if zlib.crc32(kind + content) & 0xffffffff != struct.unpack('>I', data[end:end + 4])[0]:
                raise ValueError('PNG校验失败')
            if kind == b'IHDR': header = struct.unpack('>IIBBBBB', content)
            if kind == b'IDAT': streams.append(content)
            offset = end + 4
            if kind == b'IEND': ended = True; break
        if not ended or offset != len(data) or not header: raise ValueError('PNG结构不完整')
        pixels = zlib.decompress(b''.join(streams))
        width, height, depth, color, compression, filtering, interlace = header
        if not width or not height or compression or filtering: raise ValueError('PNG图像头无效')
        valid_depths = {0: {1, 2, 4, 8, 16}, 2: {8, 16}, 3: {1, 2, 4, 8}, 4: {8, 16}, 6: {8, 16}}
        if depth not in valid_depths.get(color, set()): raise ValueError('PNG位深/颜色组合无效')
        if not interlace:
            channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}.get(color)
            if channels is None: raise ValueError('PNG颜色类型无效')
            stride = (width * channels * depth + 7) // 8 + 1
            if len(pixels) != stride * height or any(pixels[i] > 4 for i in range(0, len(pixels), stride)):
                raise ValueError('PNG像素流不完整')
        if interlace or depth != 8 or color == 3:
            from PIL import Image
            with Image.open(file) as img: img.verify()
            with Image.open(file) as img: img.load()
        else:
            # 无第三方包的fake-driver回归可验证8位直接颜色像素流；真实环境还实际解码。
            try:
                from PIL import Image
            except ImportError:
                Image = None
            if Image:
                with Image.open(file) as img: img.verify()
                with Image.open(file) as img: img.load()
        return 'png'
    from PIL import Image
    with Image.open(file) as img:
        img.verify()
    with Image.open(file) as img:
        img.load()
        if img.format != 'JPEG': raise ValueError('仅支持PNG/JPEG证据')
    if not data.endswith(b'\xff\xd9'): raise ValueError('JPEG数据截断')
    return 'jpeg'


def nodes(root):
    yield root
    for child in root.get('children', []): yield from nodes(child)


def bounds(node):
    value = (node.get('attributes') or {}).get('bounds', '')
    nums = re.findall(r'-?\d+', str(value))
    return tuple(map(int, nums)) if len(nums) == 4 else None


class Operations:
    def __init__(self, driver, output, case, phase, run_id, attempt):
        self.driver, self.output, self.case, self.phase = driver, Path(output), case, phase
        self.run_id, self.attempt = run_id, attempt
        self.output.mkdir(parents=True, exist_ok=True)
        self.observations, self.captures, self.actions = [], [], []
        self.data_state = None

    def record(self, action, **data):
        event = dict(action=action, time=time.time()); event.update(data)
        self.actions.append(event)
        with (self.output / 'actions.jsonl').open('a', encoding='utf-8') as stream:
            stream.write(json.dumps(event, ensure_ascii=False) + '\n')

    def tree(self):
        file = self.output / '_query.json'
        self.driver.UiTree.dump_to_file(str(file))
        root = json.loads(file.read_text(encoding='utf-8'))
        if not isinstance(root, dict): raise ValueError('布局树不是对象')
        return root

    def require_visible(self, locator, scope=None, root=None):
        root = root if root is not None else self.tree()
        viewport = bounds(root)
        if not viewport: raise RuntimeError('布局树缺少窗口范围')
        if not isinstance(locator, dict) or not locator or not set(locator) <= {'key', 'text', 'type', 'hint', 'contains'}:
            raise ValueError('定位器仅支持key/text/type/hint/contains')

        def find(base, selector):
            found = []
            def visit(n, visible=True):
                attrs = n.get('attributes', {})
                visible = visible and attrs.get('visible', True) not in (False, 'false', 0)
                box = bounds(n)
                in_view = box and box[2] > box[0] and box[3] > box[1] and min(box[2], viewport[2]) > max(box[0], viewport[0]) and min(box[3], viewport[3]) > max(box[1], viewport[1])
                match = all(attrs.get(k) == v for k, v in selector.items() if k != 'contains')
                if 'contains' in selector:
                    match = match and any(all(x.get('attributes', {}).get(k) == v for k, v in selector['contains'].items()) for x in nodes(n))
                if visible and in_view and match: found.append(n)
                for child in n.get('children', []): visit(child, visible)
            visit(base)
            if 'contains' in selector:
                # 有源码依据的最小容器，不以同名控件数组的首个元素定位。
                found = [n for n in found if not any(other is not n and any(x is other for x in nodes(n)) for other in found)]
            if len(found) != 1: raise RuntimeError(f'定位目标必须唯一可见，实际{len(found)}: {selector}')
            return found[0]
        base = find(root, scope) if scope else root
        return find(base, locator)

    def wait_visible(self, locator, scope=None, timeout=8):
        if type(timeout) not in (int, float) or not 0 < timeout <= 30:
            raise ValueError('定位等待必须大于0且最多30秒')
        deadline = time.monotonic() + timeout
        failure = None
        remaining = timeout
        while remaining > 0:
            try: return self.require_visible(locator, scope)
            except RuntimeError as error:
                failure = error
                remaining = deadline - time.monotonic()
                if remaining > 0: time.sleep(min(0.1, remaining))
                remaining = deadline - time.monotonic()
        raise failure

    def click(self, locator, scope=None):
        root = self.tree(); target = self.require_visible(locator, scope, root)
        box, viewport = bounds(target), bounds(root)
        # 由唯一实际布局节点算出比例位置；不是模型猜测的固定坐标。
        position = ((box[0] + box[2]) / 2 / viewport[2], (box[1] + box[3]) / 2 / viewport[3])
        self.record('click', locator=locator, scope=scope, bounds=box, position=position)
        self.driver.click(position)

    def repeat_click(self, locator, count=2, interval=0.05, scope=None):
        if not 2 <= count <= 5 or not 0 <= interval <= 1: raise ValueError('连续操作必须有界')
        root = self.tree(); target = self.require_visible(locator, scope, root)
        box, viewport = bounds(target), bounds(root)
        position = ((box[0] + box[2]) / 2 / viewport[2], (box[1] + box[3]) / 2 / viewport[3])
        started = time.monotonic()
        for i in range(count):
            self.driver.click(position)
            if i + 1 < count: time.sleep(interval)
        self.record('repeat-click', locator=locator, scope=scope, bounds=box, count=count,
                    interval=interval, elapsed=time.monotonic() - started)

    def input(self, locator, text, scope=None):
        root = self.tree(); target = self.require_visible(locator, scope, root)
        box, viewport = bounds(target), bounds(root)
        position = ((box[0] + box[2]) / 2 / viewport[2], (box[1] + box[3]) / 2 / viewport[3])
        self.record('input', locator=locator, scope=scope, bounds=box, value=text)
        self.driver.input_text(position, text)

    def back(self):
        from hypium import KeyCode
        self.driver.press_key(KeyCode.BACK); self.record('back')

    def wait(self, seconds):
        if not 0 <= seconds <= 30: raise ValueError('等待超出有界范围')
        time.sleep(seconds)

    def expected(self, assertion_id):
        assertion = next((a for a in self.case['assertions'] if a['id'] == assertion_id and a['kind'] == 'functional'), None)
        if assertion is None: raise ValueError('未知功能断言: ' + assertion_id)
        return assertion['beforeExpected' if self.phase == 'before' else 'afterExpected']

    def data_ready(self, actual):
        expected = self.case['preconditions']['state']
        if actual != expected: raise RuntimeError('前置数据复位未成立')
        self.data_state = dict(actual=actual, expected=expected, verifiedAt=time.time())
        self.record('data-ready', **self.data_state)

    def locator(self, name):
        return self.case['phaseLocators'][name][self.phase]

    def action(self, name):
        return self.case['phaseActions'][name][self.phase]

    def check(self, assertion_id, actual):
        expected = self.expected(assertion_id)
        if any(x['assertionId'] == assertion_id for x in self.observations): raise ValueError('功能断言重复执行')
        result = dict(assertionId=assertion_id, expected=expected, actual=actual,
                      status='PASS' if actual == expected else 'FAIL', time=time.time())
        self.observations.append(result); self.record('assertion', **result)
        if actual != expected: raise AssertionError(f'{assertion_id}: {actual!r} != {expected!r}')

    def capture(self, capture_id):
        if capture_id not in {p['id'] for p in self.case['capturePoints']} or any(c['captureId'] == capture_id for c in self.captures):
            raise ValueError('采集点未声明或重复: ' + capture_id)
        folder = self.output / 'captures'; folder.mkdir(exist_ok=True)
        shot, tree = folder / (capture_id + '.jpeg'), folder / (capture_id + '.json')
        if shot.exists() or tree.exists(): raise FileExistsError('采集文件已存在')
        self.driver.capture_screen(str(shot), in_pc=True)
        self.driver.UiTree.dump_to_file(str(tree))
        fmt = validate_image(shot)
        root = json.loads(tree.read_text(encoding='utf-8'))
        if not isinstance(root, dict): raise ValueError('布局树不是对象')
        if shot.suffix != '.' + fmt:
            renamed = shot.with_suffix('.' + fmt); shot.rename(renamed); shot = renamed
        capture = dict(captureId=capture_id, phase=self.phase, caseId=self.case['id'], runId=self.run_id,
                       attempt=self.attempt, screenshot=shot.relative_to(self.output).as_posix(), layoutTree=tree.relative_to(self.output).as_posix(),
                       screenshotSha256=digest(shot), layoutSha256=digest(tree), time=time.time())
        self.captures.append(capture); self.record('capture', **capture)
        return capture


def run_case(program, script_hash, ops, package):
    started = time.time(); status, reason = 'EXECUTED', ''
    try:
        ops.driver.wake_up_display()
        ops.driver.stop_app(package['package']); ops.driver.start_app(package['package'], package['ability'])
        ops.wait_visible(ops.case['preconditions']['startAnchor'])
        saved = {}
        execute_steps(program['verify_preconditions'], ops, saved)
        if ops.data_state is None: raise RuntimeError('缺少实际前置数据/复位观测')
        ops.record('preconditions-verified')
        for name in ('navigate', 'verify_target', 'scenarios'): execute_steps(program[name], ops, saved)
        required = {a['id'] for a in ops.case['assertions'] if a['kind'] == 'functional'}
        if required != {a['assertionId'] for a in ops.observations}: raise RuntimeError('未执行全部功能断言')
        if {c['id'] for c in ops.case['capturePoints']} != {c['captureId'] for c in ops.captures}:
            raise RuntimeError('未完成全部采集点')
    except AssertionError as error:
        status, reason = 'EXECUTED', str(error)
        if not any(o['status'] == 'FAIL' for o in ops.observations): status = 'BLOCKED'
    except Exception as error:
        status, reason = 'BLOCKED', f'{type(error).__name__}: {error}'
    finally:
        if reason:
            ops.record('failure', status=status, reason=reason)
            try:
                ops.driver.UiTree.dump_to_file(str(ops.output / 'diagnostic-layout.json'))
                ops.driver.capture_screen(str(ops.output / 'diagnostic.jpeg'), in_pc=True)
                validate_image(ops.output / 'diagnostic.jpeg')
            except Exception as error:
                ops.record('diagnostic-unavailable', reason=str(error))
        try: ops.driver.close()
        except Exception as error: reason += '; close: ' + str(error)
    result = dict(schemaVersion=1, runId=ops.run_id, phase=ops.phase, caseId=ops.case['id'], attempt=ops.attempt,
                  status=status, reason=reason, startedAt=started, finishedAt=time.time(),
                  scriptSha256=script_hash, dataState=ops.data_state, observations=ops.observations, captures=ops.captures)
    write_json(ops.output / 'result.json', result)
    return result
