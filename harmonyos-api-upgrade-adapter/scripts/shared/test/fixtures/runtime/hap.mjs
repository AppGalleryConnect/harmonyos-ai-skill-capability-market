// 最小真实ZIP容器，用于包身份核对；不冒充SDK构建产物。
export function hap(target = 22) {
  const filename = Buffer.from('module.json'), data = Buffer.from(JSON.stringify({ app: { bundleName: 'example.app',
    targetAPIVersion: target, minAPIVersion: 22, versionCode: 1 }, module: { name: 'entry', mainElement: 'Ability' } }));
  const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4);
  header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(filename.length, 26);
  const local = Buffer.concat([header, filename, data]);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 6);
  central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(filename.length, 28);
  const directory = Buffer.concat([central, filename]), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(local.length, 16);
  return Buffer.concat([local, directory, end]);
}
