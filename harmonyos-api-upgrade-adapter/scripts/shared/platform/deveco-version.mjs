import { canonicalHarmonyVersion, parseHarmonyVersion } from './version.mjs';
import { errorWithCode } from './errors.mjs';

function formatUpgradeMessage({ installedVersion, targetVersion, requiredVersion }) {
  return `当前 DevEco Studio 版本为 ${installedVersion}。目标 ${canonicalHarmonyVersion(targetVersion, false)} `
    + `需要 DevEco Studio ${requiredVersion} 或更高版本。`
    + '请前往华为官方下载中心下载并安装符合要求的 DevEco Studio，选用覆盖目标的 HarmonyOS SDK 后重新检查环境。'
    + ' https://developer.huawei.com/consumer/cn/download/';
}

export function inspectDevEcoCompatibility(productInfo, targetVersion, contentsRoot = null) {
  const target = typeof targetVersion === 'object' ? targetVersion : parseHarmonyVersion(targetVersion);
  const installedVersion = typeof productInfo?.version === 'string' ? productInfo.version : null;
  const match = installedVersion?.trim().match(/^(\d+)\.(\d+)\.(\d+)(?:\.(\d+))?$/);
  const numbers = match ? match.slice(1).filter(value => value !== undefined).map(Number) : null;
  const result = {
    status: 'UNRESOLVED',
    installedVersion,
    requiredVersion: target.platformVersion,
    targetVersion: canonicalHarmonyVersion(target),
    contentsRoot,
    metadataPath: productInfo?.file ?? null,
  };
  if (!numbers?.every(Number.isSafeInteger)) return result;
  const required = target.platformVersion.split('.').map(Number);
  const different = required.findIndex((value, index) => numbers[index] !== value);
  result.status = different !== -1 && numbers[different] < required[different] ? 'TOO_OLD' : 'COMPATIBLE';
  if (result.status === 'TOO_OLD') result.message = formatUpgradeMessage(result);
  return result;
}

export function assertDevEcoCompatibility(compatibility) {
  if (compatibility.status === 'COMPATIBLE') return;
  const error = compatibility.status === 'TOO_OLD'
    ? errorWithCode(
      compatibility.message ?? formatUpgradeMessage(compatibility),
      'DEVECO_TARGET_NOT_COVERED', compatibility,
    )
    : errorWithCode(
      '无法准确识别本地 DevEco Studio 版本，已停止扫描。'
      + '请修复本地环境或通过 --deveco-home 指定具有有效 product-info.json 的 DevEco Studio 安装后重试。',
      'DEVECO_VERSION_UNRESOLVED', compatibility,
    );
  error.stage = 'VALIDATE_DEVECO_VERSION';
  throw error;
}
