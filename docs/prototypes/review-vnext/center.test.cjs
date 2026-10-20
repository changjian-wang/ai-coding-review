const test = require('node:test');
const assert = require('node:assert/strict');
const demo = require('./app.js');
const {
  createCenterState, currentFinding, currentChain, switchMode, selectFinding,
  completeReview, applySampleFix, undoSampleFix, sourceFiles, summaryText,
} = require('./center.js');

test('默认以代码与跨文件问题为主场，而不是统计概览', () => {
  const state = createCenterState();
  assert.equal(state.center.stage, 'review');
  assert.equal(state.center.file, 'restore');
  assert.equal(currentFinding(state).id, 'F-02');
  assert.equal(currentChain(state).id, 'orders');
});

test('准备和就绪示例分别落在正确阶段', () => {
  assert.equal(createCenterState('fresh').center.stage, 'prepare');
  assert.equal(createCenterState('ready').center.stage, 'conclusion');
});

test('三个关键案例都能映射到业务链和有效源码', () => {
  const state = createCenterState();
  for (const [id, chain] of [['F-01', 'payment'], ['F-02', 'orders'], ['F-04', 'safeguards']]) {
    selectFinding(state, id);
    assert.equal(currentChain(state).id, chain);
    assert.ok(sourceFiles(state)[state.center.file]);
    assert.equal(state.center.stage, 'review');
  }
});

test('局部疑点被推翻后，不允许生成代码修复', () => {
  const state = createCenterState();
  assert.throws(() => applySampleFix(state, 'F-04'), /已澄清的实现/);
  assert.equal(state.findings.find((finding) => finding.id === 'F-04').status, 'dismissed');
});

test('示例修复和撤销恢复原问题与通过限制', () => {
  const state = createCenterState('technical');
  const before = sourceFiles(state).restore.lines.map((line) => line.text).join('\n');
  applySampleFix(state, 'F-02');
  assert.ok(demo.approvalGate(state).eligible);
  assert.ok(sourceFiles(state).restore.lines.some((line) => line.text.includes('reserveForOrder')));
  state.humanConfirmed = true;
  demo.submitVerdict(state, 'approve');
  undoSampleFix(state, 'F-02');
  assert.equal(sourceFiles(state).restore.lines.map((line) => line.text).join('\n'), before);
  assert.equal(demo.approvalGate(state).eligible, false);
  assert.equal(state.submission, null);
  assert.throws(() => undoSampleFix(state, 'F-02'), /没有可撤销/);
});

test('不能靠切换技术审查清除已有关键问题', () => {
  const state = createCenterState();
  switchMode(state, 'technical');
  assert.equal(demo.approvalGate(state).critical.length, 2);
  assert.equal(state.stale, true);
  completeReview(state);
  assert.equal(demo.approvalGate(state).eligible, false);
  assert.equal(demo.approvalGate(state).critical.length, 2);
  assert.match(summaryText(state), /需求一致性未评审/);
});

test('独立技术示例不虚构需求，不引入需求缺陷', () => {
  const state = createCenterState('technical');
  assert.equal(state.requirements.length, 0);
  assert.ok(state.findings.every((finding) => finding.requirement === null));
  assert.throws(() => switchMode(state, 'requirements'), /没有需求材料/);
});

test('需求修订不是自动修复：原根因转为待对齐的实现问题', () => {
  const state = createCenterState();
  demo.reviseRequirement(state, 'RQ-02', demo.revisedRequirement, true);
  demo.confirmBaseline(state);
  completeReview(state);
  const finding = state.findings.find((item) => item.id === 'F-01');
  assert.equal(finding.type, 'implementation');
  assert.equal(finding.resolved, false);
  assert.equal(finding.disposition, null);
  assert.match(finding.title, /尚未对齐/);
  assert.equal(state.requirements.find((item) => item.id === 'RQ-02').check, 'violated');
  assert.ok(sourceFiles(state).submit.lines.some((line) => line.text.includes('markPaymentFailed')));
  applySampleFix(state, 'F-01');
  assert.ok(sourceFiles(state).submit.lines.some((line) => line.text.includes('markPaymentUnknown')));
});

test('完整路径需处理需求、契约、实现，最后人工确认', () => {
  const state = createCenterState();
  demo.recordComment(state, 'F-01', '仅评论不解除矛盾。');
  assert.equal(demo.approvalGate(state).critical.length, 2);
  demo.reviseRequirement(state, 'RQ-02', demo.revisedRequirement, true);
  demo.confirmBaseline(state);
  demo.attachEvidence(state, '示例稳定事件键契约。');
  completeReview(state);
  assert.equal(demo.approvalGate(state).critical.length, 0);
  assert.equal(demo.approvalGate(state).eligible, false);
  applySampleFix(state, 'F-01');
  applySampleFix(state, 'F-02');
  assert.equal(demo.approvalGate(state).eligible, true);
  assert.throws(() => demo.submitVerdict(state, 'approve'), /人工确认/);
  state.humanConfirmed = true;
  demo.submitVerdict(state, 'approve');
  assert.equal(state.submission.verdict, 'approve');
  assert.match(summaryText(state), /没有执行测试/);
});

test('裁决切换不混用旧问题的文件和详情标签', () => {
  const state = createCenterState();
  state.center.inspector = 'history';
  selectFinding(state, 'F-04');
  assert.equal(state.center.file, 'service');
  assert.equal(state.center.inspector, 'judgment');
  assert.throws(() => selectFinding(state, 'missing'), /不存在/);
});

test('部分完成仍可反馈，摘要包含范围与验证边界', () => {
  const state = createCenterState('partial');
  demo.submitVerdict(state, 'comment');
  assert.equal(state.submission.verdict, 'comment');
  assert.match(summaryText(state), /部分完成/);
  assert.match(summaryText(state), /没有执行测试/);
  assert.equal(demo.approvalGate(state).eligible, false);
});

test('预设就绪案例的示例代码与修复状态一致', () => {
  const state = createCenterState('ready');
  assert.equal(demo.approvalGate(state).eligible, true);
  assert.ok(sourceFiles(state).restore.lines.some((line) => line.text.includes('reserveForOrder')));
  assert.ok(sourceFiles(state).submit.lines.some((line) => line.text.includes('markPaymentUnknown')));
});
