const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const demo = require('./app.js');
const sources = require('./sources.js');
const {
  createCenterState, currentFinding, currentChain, switchMode, selectFinding,
  completeReview, applySampleFix, undoSampleFix, sourceFiles, summaryText, statusLabel,
  preparationState, prepareForReview, chooseMaterial, changeRequirementInclusion, approvalGate, submitVerdict,
  scopeState, changeScope, understandingChecks,
} = require('./center.js');

function preparedFreshState() {
  const state = createCenterState('fresh');
  chooseMaterial(state, 'payments', true);
  chooseMaterial(state, 'orders', true);
  return state;
}

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

test('颜色区分已排除、人工已处理、确认缺陷和必要前提，不改变真实状态', () => {
  const state = createCenterState();
  assert.deepEqual(statusLabel(state.findings.find((item) => item.id === 'F-01')), ['已确认', 'red']);
  assert.deepEqual(statusLabel(state.findings.find((item) => item.id === 'F-03')), ['尚未确认', 'amber']);
  assert.deepEqual(statusLabel(state.findings.find((item) => item.id === 'F-04')), ['已排除', 'green']);
  applySampleFix(state, 'F-02');
  assert.deepEqual(statusLabel(state.findings.find((item) => item.id === 'F-02')), ['示例已处理', 'blue']);
  assert.equal(state.findings.find((item) => item.id === 'F-02').disposition, 'fixed');
});

test('一次明确动作确认依据，未变化的要求再次开始时直接复用', () => {
  const state = preparedFreshState();
  assert.equal(preparationState(state).label, '确认需求并开始审查');
  assert.throws(() => prepareForReview(state), /明确确认/);
  assert.equal(state.baselineConfirmed, false);
  const first = prepareForReview(state, true);
  assert.equal(first.confirmed, true);
  assert.equal(state.baselineVersion, 1);
  assert.equal(state.baselineConfirmed, true);
  assert.equal(preparationState(state).label, '开始审查');
  const second = prepareForReview(state);
  assert.equal(second.reused, true);
  assert.equal(state.baselineVersion, 1);
  assert.equal(state.humanConfirmed, false);
});

test('没有明确要求时自动选择技术边界，不要求选择审查方式', () => {
  const state = createCenterState('fresh');
  chooseMaterial(state, 'payments', false);
  chooseMaterial(state, 'orders', false);
  chooseMaterial(state, 'design', true);
  const preparation = preparationState(state);
  assert.equal(preparation.mode, 'technical');
  assert.equal(preparation.requirements.length, 0);
  assert.equal(preparation.needsConfirmation, false);
  assert.equal(preparation.label, '开始审查');
  prepareForReview(state);
  assert.equal(state.mode, 'technical');
  assert.ok(state.findings.every((finding) => finding.requirement === null));
  assert.match(summaryText(state), /需求一致性未评审/);
});

test('混合PR不需要整份分类，只采用其中明确验收而不采用改动摘要', () => {
  const state = createCenterState('fresh');
  chooseMaterial(state, 'payments', false);
  chooseMaterial(state, 'orders', false);
  chooseMaterial(state, 'pr-description', true);
  const preparation = preparationState(state);
  assert.equal(preparation.requirements.length, 1);
  assert.equal(preparation.requirements[0].id, 'RQ-03');
  assert.equal(preparation.requirements[0].origins[0].sourceId, 'pr-description');
  assert.equal(preparation.requirements[0].origins[0].line, 6);
  assert.equal(preparation.requirements.some((item) => item.text.includes('根据实现整理')), false);
});

test('材料更新不能复用旧确认，变更依据后必须有新的明确确认动作', () => {
  const state = createCenterState('ready');
  chooseMaterial(state, 'linked-issue', true);
  assert.equal(preparationState(state).needsConfirmation, true);
  assert.throws(() => prepareForReview(state), /明确确认/);
  prepareForReview(state, true);
  assert.equal(state.sourceReview.conflicts.length, 0);
  assert.equal(state.baselineVersion, 3);
  assert.equal(approvalGate(state).eligible, false);
});

test('没有材料或全部要求被排除，不会清除已有的关键问题', () => {
  const state = createCenterState();
  chooseMaterial(state, 'payments', false);
  chooseMaterial(state, 'orders', false);
  prepareForReview(state);
  completeReview(state);
  assert.equal(state.mode, 'technical');
  assert.equal(approvalGate(state).critical.length, 2);
  assert.equal(approvalGate(state).eligible, false);
});

test('详情中不适用必须说明原因，确认后也保留记录并能恢复', () => {
  const state = preparedFreshState();
  assert.throws(() => changeRequirementInclusion(state, 'RQ-03', false), /为什么不适用/);
  changeRequirementInclusion(state, 'RQ-03', false, '该功能属于后续版本，当前范围不实现。');
  assert.equal(preparationState(state).requirements.length, 3);
  prepareForReview(state, true);
  const excluded = preparationState(state).items.find((item) => item.id === 'RQ-03');
  assert.equal(excluded.include, false);
  assert.match(excluded.exclusionReason, /后续版本/);
  sources.reviseCandidate(state, 'RQ-01', '单次扣款约束', state.requirements.find((item) => item.id === 'RQ-01').text);
  assert.equal(preparationState(state).requirements.length, 3);
  changeRequirementInclusion(state, 'RQ-03', true);
  assert.equal(preparationState(state).requirements.length, 4);
  assert.equal(preparationState(state).needsConfirmation, true);
});

test('详情可修正新提取的要求，材料变化后保留修订但不覆盖原文', () => {
  const state = createCenterState('fresh');
  chooseMaterial(state, 'linked-issue', true);
  const original = state.sourceReview.draft.candidates.find((item) => item.id === 'RQ-05').origins[0].quote;
  sources.reviseCandidate(state, 'RQ-05', '人工修订的状态规则', '补充已确认的适用条件后再判断结果。');
  chooseMaterial(state, 'design', true);
  const candidate = state.sourceReview.draft.candidates.find((item) => item.id === 'RQ-05');
  assert.equal(candidate.title, '人工修订的状态规则');
  assert.equal(candidate.origins[0].quote, original);
  assert.equal(state.baselineConfirmed, false);
});

test('单次确认启动后，需求修订仍不能自动修复旧实现', () => {
  const state = preparedFreshState();
  sources.reviseCandidate(state, 'RQ-02', '支付超时保留未知', demo.revisedRequirement);
  state.pending.requirement = true;
  prepareForReview(state, true);
  completeReview(state);
  const finding = state.findings.find((item) => item.id === 'F-01');
  assert.equal(finding.type, 'implementation');
  assert.equal(finding.resolved, false);
  assert.equal(state.requirements.find((item) => item.id === 'RQ-02').manualRevision, true);
});

test('自由粘贴内容保留为原文，不假装已经识别并验证其中的要求', () => {
  const state = preparedFreshState();
  sources.addManualSource(state, '自由业务说明', '一段可能混有目标和事实的文本。', 'auto');
  const preparation = preparationState(state);
  assert.equal(preparation.requirements.length, 4);
  assert.ok(preparation.notices.some((item) => item.includes('未从自由文本提取')));
  prepareForReview(state, true);
  completeReview(state);
  assert.equal(state.runStatus, 'partial');
  assert.equal(approvalGate(state).eligible, false);
});

test('精简准备动作不会替代最终的人工批准，也不能跳过无效出处', () => {
  const state = createCenterState('ready');
  prepareForReview(state);
  assert.throws(() => submitVerdict(state, 'approve'), /人工确认/);
  chooseMaterial(state, 'linked-issue', true);
  state.sourceReview.draft.candidates[0].origins[0].quote = '无效片段';
  assert.equal(preparationState(state).canStart, false);
  assert.throws(() => prepareForReview(state, true), /出处/);
});

test('空白准备从仓库和PR确定文件，不预置四条无出处的需求', () => {
  const state = createCenterState('fresh');
  const preparation = preparationState(state);
  assert.equal(sources.selectedSources(state).length, 0);
  assert.equal(preparation.requirements.length, 0);
  assert.equal(preparation.checks.length, 0);
  assert.equal(preparation.label, '开始审查');
  assert.equal(preparation.canStart, true);
  assert.equal(preparation.scope.repository.name, 'demo/checkout-service');
  assert.equal(preparation.scope.pr.id, '104');
  assert.deepEqual(preparation.scope.files, ['submit', 'callback', 'restore']);
  assert.equal(preparation.scope.base.name, 'main');
  changeScope(state, { pr: '105' });
  assert.equal(state.scopeReview.discardedResults, false);
});

test('仓库切换清除旧发现与补丁，但保留材料重新核对适用范围', () => {
  const state = createCenterState('ready');
  state.humanConfirmed = true;
  submitVerdict(state, 'approve');
  assert.equal(changeScope(state, { repository: 'sandbox' }), true);
  assert.equal(scopeState(state).repository.id, 'sandbox');
  assert.equal(scopeState(state).pr.id, '207');
  assert.deepEqual(scopeState(state).files, ['restore']);
  assert.equal(state.findings.length, 0);
  assert.equal(state.hasResults, false);
  assert.deepEqual(state.center.patches, {});
  assert.equal(state.submission, null);
  assert.equal(state.humanConfirmed, false);
  assert.equal(state.baselineConfirmed, false);
  assert.equal(state.scopeReview.discardedResults, true);
  assert.equal(sources.selectedSources(state).length, 2);
  assert.equal(preparationState(state).needsConfirmation, true);
  assert.equal(approvalGate(state).feedbackAllowed, false);
  assert.match(summaryText(state), /Repository：demo\/checkout-sandbox/);
  assert.match(summaryText(state), /尚无有效结果/);
});

test('同仓库切换PR会换对应分支与文件，不沿用另一个PR的发现', () => {
  const state = createCenterState();
  changeScope(state, { pr: '105' });
  const scope = scopeState(state);
  assert.equal(scope.repository.id, 'checkout');
  assert.equal(scope.pr.id, '105');
  assert.equal(scope.head.name, 'feat/status-cache');
  assert.deepEqual(scope.files, ['status', 'job']);
  assert.equal(state.findings.length, 0);
  assert.equal(state.baselineConfirmed, false);
  changeScope(state, { kind: 'branch' });
  assert.equal(scopeState(state).head.name, 'feat/status-cache');
  assert.deepEqual(scopeState(state).files, ['status', 'job']);
});

test('分支变更有明确基线，换基线改变文件，全量范围不按Diff筛选', () => {
  const state = preparedFreshState();
  changeScope(state, { kind: 'branch' });
  assert.equal(scopeState(state).base.name, 'main');
  assert.deepEqual(scopeState(state).files, ['submit', 'callback', 'restore']);
  changeScope(state, { base: 'release/2026.10' });
  assert.deepEqual(scopeState(state).files, ['submit', 'restore']);
  changeScope(state, { mode: 'full' });
  const scope = scopeState(state);
  assert.equal(scope.mode, 'full');
  assert.equal(scope.base, null);
  assert.equal(scope.files.length, 12);
  assert.equal(new Set(scope.files).size, scope.files.length);
  assert.ok(scope.files.every((key) => sourceFiles(state)[key]));
  prepareForReview(state, true);
  completeReview(state);
  assert.equal(state.runStatus, 'partial');
  assert.equal(state.hasResults, false);
  assert.equal(state.findings.length, 0);
  assert.equal(approvalGate(state).eligible, false);
  assert.equal(approvalGate(state).feedbackAllowed, false);
  assert.match(summaryText(state), /全量快照，不以 Diff 定义范围/);
});

test('不存在或不属于当前仓库的对象、同分支基线和空差异显式报错而不改状态', () => {
  const state = createCenterState('fresh');
  const original = scopeState(state).key;
  assert.throws(() => changeScope(state, { repository: 'missing' }), /Repository/);
  assert.throws(() => changeScope(state, { pr: '207' }), /不属于/);
  assert.throws(() => changeScope(state, { kind: 'branch', base: 'feat/payment-timeout' }), /不能与/);
  assert.throws(() => changeScope(state, { kind: 'branch', branch: 'main', base: 'release/2026.10' }), /没有变更/);
  assert.throws(() => changeScope(state, { snapshot: 0 }), /快照版本无效/);
  assert.equal(scopeState(state).key, original);
});

test('新提交快照使旧确认与结论失效，不将旧发现带到未分析快照', () => {
  const state = createCenterState('ready');
  const oldKey = scopeState(state).key;
  changeScope(state, { snapshot: 2 });
  assert.notEqual(scopeState(state).key, oldKey);
  assert.equal(state.scopeReview.confirmedKey, null);
  assert.equal(state.scopeReview.lastRunKey, null);
  assert.equal(state.baselineConfirmed, false);
  assert.throws(() => prepareForReview(state), /明确确认/);
  prepareForReview(state, true);
  completeReview(state);
  assert.equal(state.hasResults, false);
  assert.equal(approvalGate(state).eligible, false);
  assert.throws(() => submitVerdict(state, 'comment'), /有效结果/);
});

test('底层门禁也核对范围和快照，不只靠UI清除旧记录', () => {
  const state = createCenterState('ready');
  state.scopeReview.selection.snapshot = 2;
  state.humanConfirmed = true;
  const gate = approvalGate(state);
  assert.equal(gate.eligible, false);
  assert.equal(gate.feedbackAllowed, false);
  assert.ok(gate.reasons.some((reason) => reason.includes('旧结果不属于')));
  assert.throws(() => submitVerdict(state, 'approve'), /不能通过/);
  assert.throws(() => submitVerdict(state, 'comment'), /有效结果/);
});

test('未变化的范围不无故清除确认或示例修复，进行中禁止换范围', () => {
  const state = createCenterState('ready');
  const version = state.baselineVersion;
  assert.equal(changeScope(state, { kind: 'pr', pr: '104' }), false);
  assert.equal(state.baselineConfirmed, true);
  assert.equal(state.center.patches['F-02'], true);
  assert.equal(state.baselineVersion, version);
  state.runStatus = 'running';
  assert.throws(() => changeScope(state, { kind: 'branch' }), /结束或取消/);
});

test('回到支持的范围必须重新确认，重建发现不继承旧修复并对齐新需求', () => {
  const state = createCenterState('ready');
  changeScope(state, { repository: 'sandbox' });
  changeScope(state, { repository: 'checkout' });
  assert.throws(() => prepareForReview(state), /明确确认/);
  prepareForReview(state, true);
  completeReview(state);
  assert.equal(state.center.patches['F-02'], undefined);
  assert.equal(state.findings.find((item) => item.id === 'F-02').resolved, false);
  assert.equal(state.findings.find((item) => item.id === 'F-01').type, 'implementation');
  assert.equal(state.scopeReview.lastRunKey, scopeState(state).key);
  assert.equal(state.scopeReview.confirmedKey, scopeState(state).key);
});

test('旧范围的不适用不能静默套用到新范围，保留原文与理由并重新纳入', () => {
  const state = preparedFreshState();
  changeRequirementInclusion(state, 'RQ-03', false, '旧范围暂不包含订单恢复。');
  prepareForReview(state, true);
  assert.equal(state.requirements.length, 3);
  changeScope(state, { kind: 'branch' });
  assert.equal(preparationState(state).requirements.length, 4);
  assert.equal(state.scopeReview.reincluded, 1);
  const archived = state.sourceReview.priorScopeExclusions[0].items[0];
  assert.equal(archived.id, 'RQ-03');
  assert.match(archived.reason, /旧范围/);
  assert.ok(archived.origins.length);
  prepareForReview(state, true);
  assert.equal(state.sourceReview.excluded.length, 0);
});

test('本地材料读取未完成时禁止抢先启动', () => {
  const state = createCenterState('fresh');
  state.sourceReview.readingFile = true;
  assert.equal(preparationState(state).canStart, false);
  assert.throws(() => prepareForReview(state), /正在读取/);
});

test('推导检查点和待核实前提可追溯，但不会变成额外已确认需求', () => {
  const state = preparedFreshState();
  const preparation = preparationState(state);
  assert.equal(preparation.requirements.length, 4);
  assert.equal(preparation.checks.length, 2);
  assert.equal(preparation.questions.length, 2);
  for (const check of preparation.checks) {
    assert.equal(check.normative, false);
    assert.ok(preparation.requirements.some((item) => item.id === check.requirement));
    assert.ok(check.origins.every((origin) => sources.originStatus(state, origin) === '当前版本'));
  }
  prepareForReview(state, true);
  assert.equal(state.requirements.length, 4);
  assert.ok(state.requirements.every((item) => item.basis === 'explicit'));
  assert.equal(understandingChecks(state.requirements).questions.length, 2);
  assert.equal(approvalGate(state).eligible, false);
});

test('模糊要求不擅自生成量化阈值，人工明确的内容单独标注', () => {
  const state = createCenterState('fresh');
  sources.addManualSource(state, '响应体验', '操作响应及时。', 'requirement');
  const preparation = preparationState(state);
  assert.equal(preparation.requirements.length, 1);
  assert.equal(preparation.requirements[0].basis, 'human');
  assert.equal(preparation.requirements[0].text, '操作响应及时。');
  assert.equal(preparation.checks.length, 0);
  assert.equal(preparation.questions.length, 0);
  assert.doesNotMatch(JSON.stringify(preparation.requirements), /200|毫秒|ms/);
});

test('人工改写需求后不继续套用旧语义检查点', () => {
  const state = preparedFreshState();
  sources.reviseCandidate(state, 'RQ-04', '新目标', '本版本不处理支付回调。');
  assert.equal(preparationState(state).questions.some((item) => item.id === 'U-02'), false);
  sources.reviseCandidate(state, 'RQ-01', '人工新约束', '这是尚未被原型分析的新目标。');
  assert.equal(preparationState(state).checks.some((item) => item.requirement === 'RQ-01'), false);
});

test('预设已澄清前提不再伪装成当前待核实项，过期后重新待核实', () => {
  const state = createCenterState('ready');
  assert.equal(preparationState(state).questions.find((item) => item.id === 'U-02').status, 'clarified');
  assert.match(summaryText(state), /已在预设裁决中澄清/);
  state.stale = true;
  assert.equal(preparationState(state).questions.find((item) => item.id === 'U-02').status, 'pending');
});

const stylesheet = readFileSync(join(__dirname, 'center.css'), 'utf8');
const palettes = [...stylesheet.matchAll(/(?:^:root|^\[data-theme="light"\])\s*\{([^}]+)\}/gm)]
  .map((match) => Object.fromEntries([...match[1].matchAll(/--([\w-]+):\s*(#[0-9a-f]+)\s*;/gi)].map((color) => [color[1], color[2]])));

test('本地材料长文件名可以换行，不挤出窄屏对话框或原文阅读区', () => {
  const modalHeading = stylesheet.match(/\.modal-header h2\s*\{([^}]+)\}/);
  const documentHeading = stylesheet.match(/\.document-copy h2\s*\{([^}]+)\}/);
  const modalBody = stylesheet.match(/\.modal-body\s*\{([^}]+)\}/);
  assert.match(modalHeading[1], /min-width:\s*0/);
  assert.match(modalHeading[1], /overflow-wrap:\s*anywhere/);
  assert.match(documentHeading[1], /overflow-wrap:\s*anywhere/);
  assert.match(modalBody[1], /overflow-wrap:\s*anywhere/);
});

function luminance(hex) {
  const digits = hex.slice(1);
  const expanded = digits.length === 3 ? [...digits].map((digit) => digit + digit).join('') : digits;
  const [red, green, blue] = expanded.match(/../g).map((channel) => {
    const value = parseInt(channel, 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrast(first, second) {
  const a = luminance(first);
  const b = luminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

test('两套配色的正文与辅助文字在普通、选中和状态底色上至少4.5:1', () => {
  assert.equal(palettes.length, 2);
  for (const palette of palettes) {
    for (const foreground of ['text', 'secondary', 'muted']) {
      for (const background of ['canvas', 'surface', 'surface-raised', 'editor', 'subtle', 'hover', 'accent-soft', 'success-soft', 'red-soft', 'amber-soft', 'added', 'removed']) {
        assert.ok(contrast(palette[foreground], palette[background]) >= 4.5, `${foreground} / ${background} 对比度不足`);
      }
    }
  }
});

test('语法和注释色在源码及Diff增删背景上至少4.5:1', () => {
  for (const palette of palettes) {
    for (const foreground of ['code-string', 'code-keyword', 'code-function', 'code-comment', 'code-number']) {
      for (const background of ['editor', 'added', 'removed']) {
        assert.ok(contrast(palette[foreground], palette[background]) >= 4.5, `${foreground} / ${background} 对比度不足`);
      }
    }
  }
});

test('交互蓝、结果绿独立，按钮与语义标签文字保持可读', () => {
  for (const palette of palettes) {
    assert.notEqual(palette.accent, palette.success);
    for (const background of ['canvas', 'surface', 'editor']) {
      const digits = palette[background].slice(1).match(/../g);
      assert.equal(new Set(digits).size, 1, `${background} 不应带蓝绿色偏色`);
    }
    for (const background of ['accent-strong', 'accent-hover']) {
      assert.ok(contrast(palette['on-accent'], palette[background]) >= 4.5);
    }
    for (const [foreground, background] of [['accent', 'accent-soft'], ['success', 'success-soft'], ['red', 'red-soft'], ['amber', 'amber-soft']]) {
      assert.ok(contrast(palette[foreground], palette[background]) >= 4.5);
    }
  }
});

test('问题定位不覆盖Diff底色，行号不再通过透明度降低对比', () => {
  const emphasis = stylesheet.match(/\.code-line\.emphasized\s*\{([^}]+)\}/);
  const lineNumber = stylesheet.match(/\.code-line \.line-no\s*\{([^}]+)\}/);
  assert.ok(emphasis && lineNumber);
  assert.doesNotMatch(emphasis[1], /background/);
  assert.match(emphasis[1], /border-left-color:\s*var\(--accent\)/);
  assert.doesNotMatch(lineNumber[1], /opacity/);
});
