// 显式业务验收夹具：映射来自PasswordInput原源码；不是通用用例生成器。
import { createSource, validatePlan } from '../../../../runtime/contracts.mjs';
export function passwordInputPlan(appBytes, libraryBytes, sourceEvidence) {
  const sources = [createSource(appBytes, 'app', 'all'), createSource(libraryBytes, 'library', 'all')];
  const groups = Object.fromEntries(['home', 'input', 'confirm', 'simple', 'full-confirm', 'full-cancel', 'clear', 'debounce'].map(k => [k, []]));
  const gaps = [];
  for (const s of sources) for (const r of s.rows) {
    const ref = { sourceId: s.sourceId, rowId: r.rowId }, line = Number(r.codeLocation.split(':').at(-1));
    let targets;
    if (s.sourceId === 'library') {
      if (r.codeLocation.includes('MainPage.ets')) { gaps.push({ rowRefs: [ref], reason: 'MainPage组件未被此Demo宿主消费，不能由其他页面图替代' }); continue; }
      targets = r.codeLocation.includes('PasswordInput.ets') ? ['input', 'confirm'] : ['simple', 'full-confirm', 'full-cancel'];
    } else {
      const toast = { 125: 'confirm', 151: 'simple', 190: 'full-confirm', 196: 'full-cancel', 217: 'debounce', 227: 'clear' };
      if (toast[line]) targets = [toast[line]];
      else if ([294, 295, 299, 300, 301, 302, 303, 304].includes(line)) targets = ['confirm'];
      else if ([308, 309, 313, 314, 315, 316, 317, 318].includes(line)) targets = ['full-confirm', 'full-cancel'];
      else if ([322, 323, 327, 328, 329, 330, 331, 332].includes(line)) targets = ['simple'];
      else if ([336, 337, 341, 342, 343, 344, 345, 346].includes(line)) targets = ['clear', 'debounce'];
      else targets = ['home', 'input'];
    }
    for (const id of targets) groups[id].push(ref);
  }
  const all = [...new Map(Object.values(groups).flat().map(r => [JSON.stringify(r), r])).values()];
  const descriptions = {
    home: ['首次页面渲染', '标题、标签、按钮和结果区唯一可见'],
    input: ['两个PasswordInput分别输入1234并收起键盘', '两个真实输入值及绘制状态'],
    confirm: ['首框输入1234后点击页面确定', '密码是:1234回调结果与Toast'],
    simple: ['简化版对话框输入5678并确定', '密码:5678回调结果和Dialog显示'],
    'full-confirm': ['完整对话框输入5678并确定', 'Index.ets:190的密码:5678回调'],
    'full-cancel': ['完整对话框输入后取消', 'Index.ets:196已取消回调'],
    clear: ['输入1234、收键盘、普通清空', '输入内容实际清空、结果区密码已清空'],
    debounce: ['500ms内连续两次点击清空', 'Index.ets:217点击太快了分支Toast'],
  };
  const expected = { home: true, input: ['1234', '1234'], confirm: '密码是:1234', simple: '密码:5678',
    'full-confirm': '密码:5678', 'full-cancel': '已取消输入', clear: ['', ''], debounce: '点击太快了' };
  const points = Object.keys(groups).map(id => ({ id, rowRefs: groups[id], routeId: 'home', trigger: descriptions[id][0],
    observable: descriptions[id][1], expectationSource: '原始Index.ets各事件处理器、PasswordInput/Dialog源码及已批准业务预期' }));
  const cases = points.map(p => ({ id: p.id, routeId: 'home', preconditions: { startAnchor: { text: '密码输入 Demo' },
    state: ['', ''], data: '实际读取first_0/again_0容器的输入值，均为空', reset: '每例冷启动重建页面，重新读取输入值；不得假定数据已复位' },
    steps: [p.trigger, p.observable],
    assertions: [{ id: 'F', pointId: p.id, rowRefs: p.rowRefs, kind: 'functional', beforeExpected: expected[p.id], afterExpected: expected[p.id] },
      { id: 'V', pointId: p.id, rowRefs: p.rowRefs, kind: 'visual', beforeExpected: '按原始业务展示输入、结果或对话框，无非预期遮挡',
        afterExpected: '获批关闭沉浸材质后相关功能正常呈现，接受Toast文本新样式', allowedDifferences: ['已批准Toast文本样式变化'] }],
    capturePoints: [{ id: 'effect', assertionIds: ['F', 'V'] }], timeoutMs: 90_000 }));
  const plan = { schemaVersion: 1, sources, routeMap: { schemaVersion: 1, routes: [{ id: 'home', rowRefs: all, sourceEvidence,
    steps: [{ action: 'launch', target: 'EntryAbility', expectPage: 'Index' }] }] },
    spec: { schemaVersion: 1, points, gaps }, cases: { schemaVersion: 1, cases } };
  validatePlan(plan); return plan;
}
