export const API_PLATFORM = new Map([
  [12, '5.0.0'], [13, '5.0.1'], [14, '5.0.2'], [15, '5.0.3'], [16, '5.0.4'], [17, '5.0.5'],
  [18, '5.1.0'], [19, '5.1.1'], [20, '6.0.0'], [21, '6.0.1'], [22, '6.0.2'], [23, '6.1.0'],
  [24, '6.1.1'], [26, '26.0.0'],
]);
const PLATFORM_API = new Map([...API_PLATFORM].map(([level, platform]) => [platform, level]));
const CHANNEL_RANK = { canary: 0, beta: 1, release: 2 };

export function parseHarmonyVersion(input) {
  if (!['string', 'number'].includes(typeof input)) throw new Error('SDK version must be a string or number');
  let value = String(input).trim().replace(/^HarmonyOS_/i, '').replaceAll('_', ' ');
  if (/^\d+$/.test(value)) {
    const platform = API_PLATFORM.get(Number(value));
    if (!platform) throw new Error(`Unknown HarmonyOS API level: ${value}`);
    value = `${platform}(${value})`;
  }
  const match = value.match(/^(\d+)\.(\d+)\.(\d+)(?:\((\d+)(?:\.\d+\.\d+)?\))?(?:\s+(Canary|Beta|Release)(\d*)?)?$/i);
  if (!match) throw new Error(`Unsupported SDK version: ${input}`);
  let platformVersion = `${match[1]}.${match[2]}.${match[3]}`;
  const apiLevel = match[4] ? Number(match[4]) : PLATFORM_API.get(platformVersion) ?? null;
  if (apiLevel === 26 && platformVersion === '7.0.0') platformVersion = '26.0.0';
  const [major, minor, patch] = platformVersion.split('.').map(Number);
  const channel = (match[5] || 'Release').toLowerCase();
  const channelNumber = Number(match[6] || 0);
  const rank = apiLevel ?? major;
  return { raw: String(input), platformVersion, major, minor, patch, apiLevel, rank,
    channel, channelNumber, channelRank: CHANNEL_RANK[channel],
    key: [rank, major, minor, patch, CHANNEL_RANK[channel], channelNumber] };
}

export function compareHarmonyVersions(left, right) {
  const a = typeof left === 'object' ? left : parseHarmonyVersion(left);
  const b = typeof right === 'object' ? right : parseHarmonyVersion(right);
  const key = value => [value.apiLevel ?? value.rank ?? value.major,
    ...(value.platformVersion ? value.platformVersion.split('.').map(Number) : [value.major, value.minor, value.patch]),
    CHANNEL_RANK[value.channel], value.channelNumber];
  const ak = key(a), bk = key(b);
  for (let i = 0; i < ak.length; i += 1) if (ak[i] !== bk[i]) return Math.sign(ak[i] - bk[i]);
  return 0;
}

// Build profiles contain platform/API versions, not SDK release channels.
export function compareConfigurationVersions(left, right) {
  const a = typeof left === 'object' ? left : parseHarmonyVersion(left);
  const b = typeof right === 'object' ? right : parseHarmonyVersion(right);
  return compareHarmonyVersions({ ...a, channel: 'release', channelNumber: 0 },
    { ...b, channel: 'release', channelNumber: 0 });
}

export function canonicalHarmonyVersion(input, includeChannel = true) {
  const v = typeof input === 'object' ? input : parseHarmonyVersion(input);
  const base = `${v.platformVersion ?? `${v.major}.${v.minor}.${v.patch}`}${v.apiLevel === null ? '' : `(${v.apiLevel})`}`;
  return includeChannel ? `${base} ${v.channel[0].toUpperCase()}${v.channel.slice(1)}${v.channelNumber || ''}` : base;
}

export function parseVersion(input) {
  const version = parseHarmonyVersion(input);
  if (version.apiLevel === null) throw new Error(`SDK API level is required for unknown version: ${input}`);
  return version;
}

export function assertUpgradeRange(from, to) {
  const start = parseVersion(from);
  const end = parseVersion(to);
  if (compareHarmonyVersions(start, end) >= 0) {
    throw new Error(`--from must be lower than --to: ${from} >= ${to}`);
  }
  return { start, end };
}

export function devecoVersionName(version) {
  const parsed = typeof version === 'string' ? parseVersion(version) : version;
  const channel = parsed.channel === 'release' ? 'Release'
    : `${parsed.channel[0].toUpperCase()}${parsed.channel.slice(1)}${parsed.channelNumber || ''}`;
  return `HarmonyOS_${parsed.platformVersion}(${parsed.apiLevel})_${channel}`;
}
