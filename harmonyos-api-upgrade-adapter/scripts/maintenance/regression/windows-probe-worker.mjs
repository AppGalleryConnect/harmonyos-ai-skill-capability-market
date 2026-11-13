// Diagnostic worker only: intentionally reproduces the selected historical detached flag.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { commandInvocation } from '../../shared/platform/process.mjs';

const input = JSON.parse(process.argv[2]);
const invocation = commandInvocation(input.command, input.args);
const trace = { invocation, detached: input.detached, cwd: process.cwd(), events: [], stdoutBytes: 0, stderrBytes: 0 };
const save = type => {
  trace.events.push({ type, at: new Date().toISOString() });
  writeFileSync(input.trace, JSON.stringify(trace, null, 2) + '\n');
};
save('start');
const child = spawn(invocation.command, invocation.args, {
  env: process.env, shell: false, windowsHide: true, detached: input.detached,
  windowsVerbatimArguments: invocation.windowsVerbatimArguments, stdio: ['ignore', 'pipe', 'pipe'],
});
child.once('spawn', () => { trace.pid = child.pid; save('spawn'); });
child.once('error', error => { trace.error = error.message; save('error'); });
child.once('exit', (code, signal) => { trace.exitCode = code; trace.signal = signal; save('exit'); });
for (const stream of ['stdout', 'stderr']) child[stream]?.on('data', chunk => {
  trace[`${stream}Bytes`] += chunk.length;
  process[stream].write(chunk);
});
child.once('close', code => { save('close'); process.exitCode = code ?? 1; });
