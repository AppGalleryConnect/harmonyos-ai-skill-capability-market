#!/usr/bin/env node
import { execute, usage } from '../core/cli.mjs';
import { serializeError } from '../../shared/platform/errors.mjs';

Error.stackTraceLimit = Math.max(Error.stackTraceLimit, 50);

try {
  const result = await execute(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify({ ok: true, result }, null, 2)}\n`);
} catch (error) {
  if (error && typeof error === 'object') error.code ??= 'SCAN_FAILED';
  process.stderr.write(`${JSON.stringify({ ok: false,
    error: serializeError(error, { command: process.argv[2] }) }, null, 2)}\n`);
  process.exitCode = 1;
}

export { usage };
