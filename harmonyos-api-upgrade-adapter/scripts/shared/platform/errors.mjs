function stackLines(error, limit) {
  if (typeof error?.stack !== 'string' || !error.stack) return undefined;
  return error.stack.split(/\r?\n/).slice(0, limit).join('\n');
}

export function serializeError(error, {
  command = undefined,
  stage = undefined,
  maxStackLines = 50,
  maxCauseDepth = 4,
  depth = 0,
} = {}) {
  const source = error && typeof error === 'object' ? error : new Error(String(error));
  const result = {
    name: source.name ?? 'Error',
    code: source.code ?? undefined,
    message: source.message ?? String(source),
    command: command ?? source.command ?? undefined,
    stage: source.stage ?? stage ?? undefined,
    stack: stackLines(source, maxStackLines),
    details: source.details ?? undefined,
    validationErrors: source.validationErrors ?? undefined,
    artifactPaths: source.artifactPaths ?? undefined,
    cleanupWarning: source.cleanupWarning ?? undefined,
  };
  if (source.cause !== undefined && depth < maxCauseDepth) {
    result.cause = serializeError(source.cause, {
      maxStackLines,
      maxCauseDepth,
      depth: depth + 1,
    });
  }
  return result;
}

export function errorWithCode(message, code, details = undefined) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}
