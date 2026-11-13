// Scanner provenance: tool identity only.
// This records tool identity only; it does not diagnose or run API adaptation.
import path from 'node:path';
import {readFile} from 'node:fs/promises';
import {listFiles,portableRelative,sha256} from '../../shared/io/fs-utils.mjs';
import {requireScanMode} from '../../shared/platform/scan-mode.mjs';

export async function runtimeIdentity(skillRoot,{mode}={}) {
  requireScanMode(mode);
  const root=path.resolve(skillRoot),adapter=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
  const scanner=JSON.parse(await readFile(path.join(root,'scripts','scanner','package.json'),'utf8')),files=[];
  const selected=[path.join(root,'scripts','shared','platform','scan-version-catalog.json'),
    path.join(root,'scripts','scanner','bin','DevEcoCppBridge.java')];
  for(const directory of [path.join('scripts','shared'),path.join('scripts','scanner')])
    selected.push(...await listFiles(path.join(root,directory),file=>/\.(mjs|cjs)$/.test(file),directory=>path.basename(directory)!=='test'));
  for(const file of selected) {
    const text=(await readFile(file,'utf8')).replace(/^\ufeff/,'').replace(/\r\n?/g,'\n');
    files.push(`${portableRelative(root,file)}\0${sha256(text)}`);
  }
  return {identityVersion:2,featureMode:mode,featureVersion:1,skillRoot:root,adapterVersion:adapter.version,
    scannerVersion:scanner.version,nodeVersion:process.version,platform:process.platform,
    implementationFingerprint:sha256(files.sort().join('\n')),
    capabilities:['independent-scanner','upgrade-plugin-mode','scan-statistics','official-change-links','native-abi-compilation-context']};
}
