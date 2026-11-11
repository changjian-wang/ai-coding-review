const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createState, getPR, definition, listPRs, current, beginReview, cancelReview, completeReview,
  snapshotKey, decide, applyPatch, validatePatches, undoPatch, updateSnapshot, setContext,
  codeFiles, publishGate, publish, reviewed, changeConnection, toggleRepo, answer,
} = require('./app.js');

function run(state, id) { beginReview(state, id); completeReview(getPR(state, id)); }

test('PR 队列组合风险、仓库与搜索条件，不混用审查对象', () => {
  const state = createState();
  assert.equal(listPRs(state).length, 4);
  state.filter = 'high';
  assert.deepEqual(listPRs(state).map((pr) => pr.id), ['renewal', 'exports']);
  state.repo = 'billing-service';
  state.search = '218';
  assert.deepEqual(listPRs(state).map((pr) => pr.id), ['renewal']);
  getPR(state, 'renewal').notes = '只属于这份审查';
  assert.equal(getPR(state, 'exports').notes, null);
  assert.throws(() => getPR(state, 'missing'), /找不到/);
});

test('分析绑定快照，中断不能被当作有效结果或发布', () => {
  const state = createState(), pr = getPR(state, 'exports');
  assert.throws(() => decide(pr, 'R1', 'confirmed'), /当前快照/);
  beginReview(state, pr.id);
  assert.throws(() => updateSnapshot(pr), /先取消/);
  assert.throws(() => setContext(pr, '新要求'), /审查中/);
  cancelReview(pr);
  assert.equal(current(pr), false);
  assert.throws(() => completeReview(pr), /未把旧结果/);
  assert.ok(publishGate(state, pr, 'comment', '说明').some((r) => r.includes('完成')));
  run(state, pr.id);
  assert.equal(current(pr), true);
  assert.equal(pr.findings[0].file, 'export');
});

test('不采纳必须说明依据，原发现保留且可重新核查', () => {
  const pr = getPR(createState(), 'renewal');
  assert.throws(() => decide(pr, 'R1', 'dismissed', '  '), /说明/);
  decide(pr, 'R1', 'dismissed', '示例反证：此部署有已核实的外层去重。');
  assert.equal(pr.findings[0].status, 'dismissed');
  assert.match(pr.findings[0].reason, /外层去重/);
  decide(pr, 'R1', 'open');
  assert.equal(pr.findings[0].reason, '');
  assert.throws(() => decide(pr, 'R1', 'made-up'), /未知/);
});

test('修复创建演示提交并改变代码，不能直接宣称问题解决', () => {
  const state = createState(), pr = getPR(state, 'renewal');
  const other = getPR(state, 'exports'), otherCode = JSON.stringify(codeFiles(other));
  const oldHead = pr.head, token = snapshotKey(pr);
  applyPatch(pr, 'R1', token);
  assert.notEqual(pr.head, oldHead);
  assert.match(codeFiles(pr).find((f) => f.id === 'renewal').rows.find((r) => r.n === 35).text, /createOnce\(invoice.id/);
  assert.equal(pr.findings[0].status, 'patch-applied');
  assert.equal(current(pr), false);
  assert.equal(JSON.stringify(codeFiles(other)), otherCode);
  assert.ok(publishGate(state, pr, 'approve', '通过').length > 0);
});

test('旧修复预览拒绝写入变化后的快照，不部分改变状态', () => {
  const state = createState(), pr = getPR(state, 'renewal'), token = snapshotKey(pr);
  setContext(pr, '新的标准');
  run(state, pr.id);
  const before = JSON.stringify(pr);
  assert.throws(() => applyPatch(pr, 'R1', token), /快照已变化/);
  assert.equal(JSON.stringify(pr), before);
});

test('检查失败保留修复和问题；通过后必须重新审查才更新处置', () => {
  const state = createState(), pr = getPR(state, 'renewal');
  applyPatch(pr, 'R1', snapshotKey(pr));
  validatePatches(pr, 'failed');
  run(state, pr.id);
  assert.equal(pr.findings[0].status, 'confirmed');
  assert.equal(pr.patches.R1.validation, 'failed');
  validatePatches(pr, 'passed');
  assert.equal(pr.findings[0].status, 'confirmed');
  run(state, pr.id);
  assert.equal(pr.findings[0].status, 'fixed');
  assert.ok(publishGate(state, pr, 'approve', '通过').some((r) => r.includes('未闭合')));
});

test('新修复使旧检查失效，全部当前提交复审后才可通过', () => {
  const state = createState(), pr = getPR(state, 'renewal');
  applyPatch(pr, 'R1', snapshotKey(pr));
  validatePatches(pr, 'passed'); run(state, pr.id);
  applyPatch(pr, 'R2', snapshotKey(pr));
  assert.equal(pr.findings[0].status, 'patch-applied');
  run(state, pr.id);
  assert.notEqual(pr.findings[0].status, 'fixed');
  validatePatches(pr, 'passed'); run(state, pr.id);
  assert.deepEqual(pr.findings.map((f) => f.status), ['fixed', 'fixed']);
  assert.deepEqual(publishGate(state, pr, 'approve', '演示修复检查后通过。'), []);
  undoPatch(pr, 'R1');
  assert.equal(current(pr), false);
  assert.equal(pr.findings[0].status, 'open');
  assert.match(codeFiles(pr).find((f) => f.id === 'renewal').rows.find((r) => r.n === 35).text, /charges.create\(/);
});

test('自定义上下文明确受限，不能被预设分析包装成通过', () => {
  const state = createState(), pr = getPR(state, 'copy');
  setContext(pr, '必须满足这条尚未实际分析的新约束。');
  run(state, pr.id);
  assert.equal(pr.review.phase, 'limited');
  assert.ok(publishGate(state, pr, 'approve', '通过').some((r) => r.includes('覆盖受限')));
  assert.deepEqual(publishGate(state, pr, 'comment', '该新增上下文尚未分析。'), []);
});

test('新外部提交清除旧发现和修复，有不同输入但不伪造新的分析', () => {
  const state = createState(), pr = getPR(state, 'renewal'), before = JSON.stringify(codeFiles(pr));
  updateSnapshot(pr);
  assert.notEqual(JSON.stringify(codeFiles(pr)), before);
  assert.equal(pr.findings.length, 0);
  run(state, pr.id);
  assert.equal(pr.review.phase, 'limited');
  assert.equal(pr.findings.length, 0);
});

test('发布预览绑定快照，历史不被后续提交改写', () => {
  const state = createState(), pr = getPR(state, 'copy');
  run(state, pr.id);
  const token = snapshotKey(pr), record = publish(state, pr, 'approve', '本次预设检查没有可报告问题。', token);
  assert.equal(record.verdict, 'approve');
  assert.equal(reviewed(state, pr), true);
  assert.equal(listPRs(state).some((p) => p.id === pr.id), false);
  updateSnapshot(pr);
  assert.equal(reviewed(state, pr), false);
  assert.equal(state.records[0].key, token);
  assert.throws(() => publish(state, pr, 'approve', '旧结果', token), /预览已过期/);
});

test('只将采纳的发现作为评论记录，关键未决不妨碍有边界的评论', () => {
  const state = createState(), pr = getPR(state, 'renewal');
  decide(pr, 'R1', 'confirmed');
  decide(pr, 'R2', 'dismissed', '仅此演示中假定金额约定由调用方承担。');
  const record = publish(state, pr, 'changes', '请修复扣费幂等问题。', snapshotKey(pr));
  assert.deepEqual(record.comments.map((f) => f.id), ['R1']);
  assert.deepEqual(publishGate(state, pr, 'comment', '仍需处理未闭合问题。'), []);
  assert.ok(publishGate(state, pr, 'approve', '通过').length);
});

test('上下文改变后，旧历史不冒充当前有效审查', () => {
  const state = createState(), pr = getPR(state, 'copy');
  run(state, pr.id);
  publish(state, pr, 'comment', '原上下文的检查。', snapshotKey(pr));
  setContext(pr, '新增要求');
  assert.equal(reviewed(state, pr), false);
  assert.equal(state.records.length, 1);
});

test('断开或移除仓库阻止运行和发布，缓存与草稿保留', () => {
  const state = createState(), pr = getPR(state, 'renewal');
  pr.notes = '未发布的草稿';
  changeConnection(state, false);
  assert.throws(() => beginReview(state, pr.id), /未连接/);
  assert.ok(publishGate(state, pr, 'comment', '反馈').some((r) => r.includes('未连接')));
  assert.equal(pr.findings.length, 2);
  assert.equal(pr.notes, '未发布的草稿');
  changeConnection(state, true);
  toggleRepo(state, definition(pr).repo, false);
  assert.throws(() => beginReview(state, pr.id), /未连接/);
  toggleRepo(state, definition(pr).repo, true);
  beginReview(state, pr.id);
  assert.throws(() => changeConnection(state, false), /先结束/);
  assert.throws(() => toggleRepo(state, definition(pr).repo, false), /正在审查/);
});

test('问答保留 PR 上下文，未知问题明确说明没有真实模型', () => {
  const state = createState(), pr = getPR(state, 'renewal');
  assert.match(answer(pr, '变更目的'), /预设 PR 摘要/);
  assert.match(answer(pr, '解释当前问题'), /幂等/);
  assert.match(answer(pr, '验证建议'), /不会执行真实测试/);
  assert.match(answer(pr, '帮我设计一艘船'), /未调用模型/);
  const key = snapshotKey(pr);
  assert.equal(pr.messages[0].key, key);
  updateSnapshot(pr);
  assert.notEqual(snapshotKey(pr), key);
  assert.equal(pr.messages[0].key, key);
  assert.equal(getPR(state, 'exports').messages.length, 0);
  assert.throws(() => answer(pr, '   '), /请输入/);
});
