import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeDocumentUrl,ruleDocumentLink} from '../platform/document-links.mjs';
test('synthetic and other-rule anchors cannot override a verified canonical change entry',()=>{
 const expected='https://developer.huawei.com/consumer/cn/doc/doccenter-release-notes/changelogs-ux-7001#ch2026031846233';
 const old='https://developer.huawei.com/consumer/cn/doc/harmonyos-releases/changelogs-ux-7001/';
 for(const [fragment,reason]of [['scan-a45022895e24852a8a1f','SYNTHETIC_SCAN_ANCHOR'],['ch2026032801249','RULE_LINK_MISMATCH']]){
  const result=ruleDocumentLink({url:expected},old+'#'+fragment);assert.equal(result.url,expected);assert.equal(result.rejectedReason,reason);
 }
 assert.equal(normalizeDocumentUrl(old+'#ch2026031846233'),expected);
 assert.equal(ruleDocumentLink({url:expected},old+'#ch2026031846233').source,'VERIFIED_DEVECO_REPORT');
 assert.equal(ruleDocumentLink({url:old},old+'#scan-fake').url,'');
});
