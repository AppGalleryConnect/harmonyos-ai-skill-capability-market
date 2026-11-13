import { spawn } from 'node:child_process';
import path from 'node:path';

const WINDOWS_SHELL_EXTENSIONS = new Set(['.cmd', '.bat']);
const WINDOWS_META_CHARACTERS = /([()%!^"<>&|;, *?])/g;

export function prependPath(env, directories, platform = process.platform) {
  const result = { ...env };
  const keys = Object.keys(env).filter(key => platform === 'win32' ? key.toLowerCase() === 'path' : key === 'PATH');
  const key = keys[0] ?? 'PATH';
  const previous = env.PATH ?? env[key] ?? '';
  for (const name of keys) delete result[name];
  result[key] = [...directories.filter(Boolean), previous].filter(Boolean).join(platform === 'win32' ? ';' : ':');
  return result;
}

function assertCommandValue(value) {
  const text = String(value);
  if (/[\0\r\n]/.test(text)) throw new Error('Command arguments cannot contain NUL or newlines');
  return text;
}

function escapeWindowsCommand(value) {
  return assertCommandValue(value).replace(WINDOWS_META_CHARACTERS, '^$1');
}

function escapeWindowsArgument(value) {
  let escaped = assertCommandValue(value);
  escaped = escaped.replace(/(\\*)"/g, '$1$1\\"');
  escaped = escaped.replace(/(\\*)$/, '$1$1');
  escaped = `"${escaped}"`;
  return escaped.replace(WINDOWS_META_CHARACTERS, '^$1');
}

export function commandInvocation(command, args = [], platform = process.platform, env = process.env) {
  const extension = path.extname(command).toLowerCase();
  if (platform === 'win32' && WINDOWS_SHELL_EXTENSIONS.has(extension)) {
    const executable = env.ComSpec || env.COMSPEC || 'cmd.exe';
    const commandLine = [escapeWindowsCommand(command), ...args.map(escapeWindowsArgument)].join(' ');
    return {
      command: executable,
      args: ['/d', '/s', '/v:off', '/c', `"${commandLine}"`],
      windowsVerbatimArguments: true,
    };
  }
  return { command, args, windowsVerbatimArguments: false };
}

function waitForClose(child, timeoutMs) {
  return new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve(true);
    const done = () => { clearTimeout(timer); child.removeListener('close', closed); resolve(false); };
    const closed = () => { clearTimeout(timer); resolve(true); };
    const timer = setTimeout(done, timeoutMs);
    child.once('close', closed);
  });
}

async function taskkill(pid, env) {
  return new Promise(resolve => {
    const executable = env.SystemRoot ? path.win32.join(env.SystemRoot, 'System32', 'taskkill.exe') : 'taskkill.exe';
    const child = spawn(executable, ['/pid', String(pid), '/t', '/f'], { env, shell: false, windowsHide: true, stdio: 'ignore' });
    let settled = false;
    const finish = result => { if (settled) return; settled = true; clearTimeout(timer); resolve(result); };
    const timer = setTimeout(() => { child.kill(); child.unref(); finish({ error: 'taskkill timed out' }); }, 2000);
    child.once('error', error => finish({ error: error.message }));
    child.once('close', exitCode => finish({ exitCode }));
  });
}

export async function terminateProcessTree(child, {
  platform = process.platform, env = process.env, detached = false, graceMs = 3000,
} = {}) {
  if (!child?.pid) return { attempted: false, warning: 'process was not spawned' };
  const exited = child.exitCode !== null || child.signalCode !== null;
  if (platform === 'win32') {
    // A departed PID can be reused; do not kill an unrelated process by that PID.
    if (exited) return { attempted: false, warning: 'parent exited; descendant cleanup could not be confirmed' };
    const result = await taskkill(child.pid, env);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    const closed = await waitForClose(child, Math.min(graceMs, 2000));
    return { attempted: true, method: 'taskkill', ...result, ...(!closed ? { warning: 'parent termination could not be confirmed' } : {}) };
  }
  if (exited && !detached) return { attempted: false, warning: 'parent exited without an owned process group' };
  const signal = name => {
    try { if (detached) process.kill(-child.pid, name); else child.kill(name); return null; }
    catch (error) { return error.code === 'ESRCH' ? null : error.message; }
  };
  const error = signal('SIGTERM');
  const closed = await waitForClose(child, Math.min(graceMs, 2000));
  // Give the owned process its requested grace before killing remaining group members.
  if (detached || !closed) signal('SIGKILL');
  if (!closed) await waitForClose(child, 500);
  return { attempted: true, method: detached ? 'process-group' : 'process', ...(error ? { error } : {}) };
}

export function processDiagnostics(result) {
  return Object.fromEntries(['invocation', 'pid', 'detached', 'events', 'stdoutBytes', 'stderrBytes', 'lastOutputAt',
    'durationMs', 'termination', 'errorCode'].map(key => [key, result[key] ?? null]));
}

export function runProcess(command, args = [], options = {}) {
  const platform = options.platform ?? process.platform, env = options.env ?? process.env;
  const invocation = commandInvocation(command, args, platform, env);
  const detached = platform !== 'win32' && options.detached === true;
  return new Promise(resolve => {
    const started = Date.now(), events = [];
    let settled = false, stopping = false, stdout = '', stderr = '', timedOut = false;
    let error = null, errorCode = null, termination = null, lastOutputAt = null;
    let stdoutBytes = 0, stderrBytes = 0, timer, drainTimer, cleanupTimer;
    const event = type => { if (!settled) events.push({ type, at: new Date().toISOString() }); };
    const child = spawn(invocation.command, invocation.args, {
      cwd: options.cwd, env, shell: false, windowsHide: true,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments, detached, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const finish = forced => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); clearTimeout(drainTimer); clearTimeout(cleanupTimer);
      if (forced) { child.stdout?.destroy(); child.stderr?.destroy(); child.unref(); }
      resolve({ stdout, stderr, timedOut, exitCode: errorCode === 'SPAWN_FAILED' ? null : child.exitCode, signal: child.signalCode, error, errorCode,
        invocation, pid: child.pid ?? null, detached, events: [...events], stdoutBytes, stderrBytes,
        lastOutputAt, durationMs: Date.now() - started, termination });
    };
    const stop = async (code, message) => {
      if (settled || stopping) return;
      stopping = true; errorCode ??= code; error ??= message;
      clearTimeout(timer); clearTimeout(drainTimer);
      cleanupTimer = setTimeout(() => {
        termination = { ...(termination ?? {}), warning: 'cleanup exceeded five seconds' }; finish(true);
      }, 5000);
      try { termination = await terminateProcessTree(child, { platform, env, detached, graceMs: options.terminationGraceMs }); }
      catch (failure) { termination = { attempted: true, error: failure.message }; }
      finish(true);
    };
    if (options.timeoutMs) timer = setTimeout(() => {
      timedOut = true; event('timeout');
      const exited = child.exitCode !== null || child.signalCode !== null;
      // Existing callers distinguish ordinary timeouts from execution/output errors.
      void stop(exited ? 'STDIO_CLOSE_TIMEOUT' : 'PROCESS_TIMEOUT', exited ? 'process exited but output pipes exceeded the deadline' : null);
    }, options.timeoutMs);
    child.once('spawn', () => event('spawn'));
    child.once('error', failure => { event('error'); error = failure.message; errorCode = 'SPAWN_FAILED'; finish(true); });
    child.once('exit', () => {
      event('exit');
      if (!settled && !stopping) drainTimer = setTimeout(() => {
        void stop('STDIO_CLOSE_TIMEOUT', 'process exited but inherited output pipes remained open');
      }, options.stdioCloseTimeoutMs ?? 500);
    });
    child.once('close', () => { event('close'); if (!stopping) finish(false); });
    child.stdout?.setEncoding('utf8'); child.stderr?.setEncoding('utf8');
    const output = (chunk, stream) => {
      if (settled) return;
      lastOutputAt = new Date().toISOString();
      if (stream === 'stdout') { stdoutBytes += Buffer.byteLength(chunk); if (options.captureStdout !== false) stdout += chunk; }
      else { stderrBytes += Buffer.byteLength(chunk); if (options.captureStderr !== false) stderr += chunk; }
      if (errorCode !== 'OUTPUT_WRITE_FAILED') try { options.onOutput?.(chunk, stream); }
      catch (failure) { error = failure.message; errorCode = 'OUTPUT_WRITE_FAILED'; void stop('OUTPUT_WRITE_FAILED', failure.message); }
    };
    child.stdout?.on('data', chunk => output(chunk, 'stdout'));
    child.stderr?.on('data', chunk => output(chunk, 'stderr'));
  });
}
