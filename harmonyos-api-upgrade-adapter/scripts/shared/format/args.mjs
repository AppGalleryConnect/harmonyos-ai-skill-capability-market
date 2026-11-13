export function parseArgs(argv) {
  const result = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      result._.push(token);
      continue;
    }
    const separator = token.indexOf('=');
    const key = separator === -1 ? token.slice(2) : token.slice(2, separator);
    const value = separator === -1 ? argv[index + 1] : token.slice(separator + 1);
    if (separator === -1 && (value === undefined || value.startsWith('--'))) {
      addArg(result, key, true);
      continue;
    }
    addArg(result, key, value);
    if (separator === -1) index += 1;
  }
  return result;
}

function addArg(result, key, value) {
  if (result[key] === undefined) {
    result[key] = value;
  } else if (Array.isArray(result[key])) {
    result[key].push(value);
  } else {
    result[key] = [result[key], value];
  }
}

export function requireString(args, name) {
  const value = args[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Missing required argument --${name}`);
  }
  return value;
}

export function stringList(value) {
  if (value === undefined) return [];
  return (Array.isArray(value) ? value : [value]).flatMap((item) => String(item).split(','))
    .map((item) => item.trim()).filter(Boolean);
}

export function integerArg(value, fallback, name) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`--${name} must be a positive integer`);
  }
  return parsed;
}

export function booleanArg(value, fallback = false) {
  if (value === undefined) {
    return fallback;
  }
  if (value === true || value === 'true' || value === '1') {
    return true;
  }
  if (value === false || value === 'false' || value === '0') {
    return false;
  }
  throw new Error(`Expected boolean value, received ${String(value)}`);
}
