import { readZipTextEntries } from '../shared/format/zip.mjs';
import { requireValue } from './contracts.mjs';
import { parseVersion } from '../shared/platform/version.mjs';

// 保留包内原始编码，与设备返回原值比较，不从ROM名称或版本字符串猜API编码。
export async function packageIdentity(file, moduleName) {
  const entries = await readZipTextEntries(file, name => name === 'module.json' || name === 'pack.info');
  const modules = entries.filter(e => e.name === 'module.json');
  requireValue(modules.length === 1, 'HAP/HSP缺少唯一module.json');
  const { app, module } = JSON.parse(modules[0].text);
  const pack = entries.find(e => e.name === 'pack.info');
  const api = pack ? JSON.parse(pack.text).summary?.modules?.find(m => m.distro?.moduleName === module.name)?.apiVersion : null;
  requireValue(app && module && typeof app.bundleName === 'string' && Number.isSafeInteger(app.targetAPIVersion) &&
    Number.isSafeInteger(app.minAPIVersion) && Number.isSafeInteger(app.versionCode), '包内身份或版本缺失');
  return { bundle: app.bundleName, module: module.name, ability: module.mainElement,
    target: app.targetAPIVersion, compatible: app.minAPIVersion, versionCode: app.versionCode,
    targetApi: api?.target ?? null, compatibleApi: api?.compatible ?? null,
    primary: module.name === moduleName };
}
export function checkDeclaration(identity, input) {
  if (identity.targetApi !== null) requireValue(identity.targetApi === parseVersion(input.target).apiLevel &&
    identity.compatibleApi === parseVersion(input.compatible).apiLevel, '包内API与构建声明target/compatible不一致');
}
export function checkInstalled(info, expected) {
  const start = info.indexOf('{'); requireValue(start >= 0, '设备未返回包JSON');
  const bundle = JSON.parse(info.slice(start)), app = bundle.applicationInfo;
  requireValue(bundle.name === expected.bundle && app?.apiTargetVersion === expected.target &&
    app.apiCompatibleVersion === expected.compatible && bundle.versionCode === expected.versionCode &&
    Array.isArray(bundle.hapModuleInfos) && bundle.hapModuleInfos.some(m => m.name === expected.module &&
      (m.mainElementName === expected.ability || m.abilities?.some(a => a.name === expected.ability))), '已安装包target/compatible/版本/模块/Ability与归档包不一致');
  return { bundle: bundle.name, target: app.apiTargetVersion, compatible: app.apiCompatibleVersion, versionCode: bundle.versionCode };
}
