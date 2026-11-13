import { readFile } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';

const CENTRAL_SIGNATURE = 0x02014b50;
const END_SIGNATURE = 0x06054b50;
const LOCAL_SIGNATURE = 0x04034b50;

function assertRange(buffer, offset, length, label) {
  if (offset < 0 || length < 0 || offset + length > buffer.length) {
    throw new Error(`Invalid ZIP ${label} range`);
  }
}

function endOfCentralDirectory(buffer) {
  if (buffer.length < 22) throw new Error('ZIP archive is truncated');
  const minimum = Math.max(0, buffer.length - 65_557);
  for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
    if (buffer.readUInt32LE(offset) === END_SIGNATURE) return offset;
  }
  throw new Error('ZIP end of central directory not found');
}

function centralEntries(buffer) {
  const end = endOfCentralDirectory(buffer);
  const count = buffer.readUInt16LE(end + 10);
  const size = buffer.readUInt32LE(end + 12);
  const start = buffer.readUInt32LE(end + 16);
  if (count === 0xffff || size === 0xffffffff || start === 0xffffffff) {
    throw new Error('ZIP64 archives are not supported');
  }
  assertRange(buffer, start, size, 'central directory');
  const entries = [];
  let offset = start;
  for (let index = 0; index < count; index += 1) {
    assertRange(buffer, offset, 46, 'central header');
    if (buffer.readUInt32LE(offset) !== CENTRAL_SIGNATURE) throw new Error('Invalid ZIP central header');
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    assertRange(buffer, offset + 46, nameLength + extraLength + commentLength, 'central entry');
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    entries.push({ name, flags, method, compressedSize, uncompressedSize, localOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function entryContent(buffer, entry, maxEntrySize) {
  if ((entry.flags & 0x1) !== 0) throw new Error(`Encrypted ZIP entry is not supported: ${entry.name}`);
  if (entry.uncompressedSize > maxEntrySize) throw new Error(`ZIP entry is too large: ${entry.name}`);
  assertRange(buffer, entry.localOffset, 30, 'local header');
  if (buffer.readUInt32LE(entry.localOffset) !== LOCAL_SIGNATURE) throw new Error('Invalid ZIP local header');
  const nameLength = buffer.readUInt16LE(entry.localOffset + 26);
  const extraLength = buffer.readUInt16LE(entry.localOffset + 28);
  const dataOffset = entry.localOffset + 30 + nameLength + extraLength;
  assertRange(buffer, dataOffset, entry.compressedSize, 'entry data');
  const compressed = buffer.subarray(dataOffset, dataOffset + entry.compressedSize);
  const content = entry.method === 0 ? Buffer.from(compressed)
    : entry.method === 8 ? inflateRawSync(compressed)
      : null;
  if (!content) throw new Error(`Unsupported ZIP compression method ${entry.method}: ${entry.name}`);
  if (content.length !== entry.uncompressedSize) throw new Error(`ZIP entry size mismatch: ${entry.name}`);
  return content;
}

export async function listZipEntries(archivePath) {
  return centralEntries(await readFile(archivePath)).map(entry => entry.name);
}

export async function readZipTextEntries(archivePath, predicate = () => true, {
  maxEntrySize = 16 * 1024 * 1024,
  maxTotalSize = 64 * 1024 * 1024,
} = {}) {
  const buffer = await readFile(archivePath);
  const selected = centralEntries(buffer).filter(entry => predicate(entry.name));
  const total = selected.reduce((sum, entry) => sum + entry.uncompressedSize, 0);
  if (total > maxTotalSize) throw new Error('Selected ZIP entries exceed the allowed total size');
  return selected.map(entry => ({
    name: entry.name,
    text: entryContent(buffer, entry, maxEntrySize).toString('utf8'),
  }));
}
