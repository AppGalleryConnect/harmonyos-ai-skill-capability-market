"""进程入口；语法/待填项检查发生在连接设备之前。"""
import argparse
import importlib.metadata
import json
import sys
from pathlib import Path

# Isolated mode ignores the run directory and PYTHONPATH. Load our installed siblings.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from case_data import load_case
from runtime import Operations, run_case, validate_image

for stream in (sys.stdout, sys.stderr):
    if hasattr(stream, 'reconfigure'): stream.reconfigure(encoding='utf-8')
parser = argparse.ArgumentParser()
parser.add_argument('command', choices=['check', 'run', 'image', 'environment'])
parser.add_argument('file', nargs='?')
parser.add_argument('sha256', nargs='?')
parser.add_argument('plan', nargs='?')
parser.add_argument('case_id', nargs='?')
args = parser.parse_args()
if args.command == 'check':
    plan = json.loads(Path(args.plan).read_text(encoding='utf-8'))
    case = next(case for case in plan['cases']['cases'] if case['id'] == args.case_id)
    load_case(args.file, case, args.sha256)
elif args.command == 'image':
    validate_image(args.file)
elif args.command == 'environment':
    from hypium import UiDriver
    import PIL
    assert importlib.metadata.version('hypium') == '6.1.0.210', '需要hypium==6.1.0.210'
    print(json.dumps({'python': sys.version, 'hypium': importlib.metadata.version('hypium'), 'pillow': PIL.__version__}))
else:
    request = json.loads(Path(args.file).read_text(encoding='utf-8'))
    script_hash = request['scriptSha256']
    program = load_case(request['script'], request['case'], script_hash)
    from hypium import UiDriver
    if importlib.metadata.version('hypium') != '6.1.0.210': raise RuntimeError('Hypium版本不匹配')
    driver = UiDriver.connect(device_sn=request['device']['serial'])
    ops = Operations(driver, request['output'], request['case'], request['phase'], request['runId'], request['attempt'])
    result = run_case(program, script_hash, ops, request['package'])
    print(json.dumps({'status': result['status'], 'reason': result['reason']}, ensure_ascii=False))
    sys.exit(0 if result['status'] == 'EXECUTED' else 2)
