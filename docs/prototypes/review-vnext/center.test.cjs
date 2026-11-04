const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const demo = require('./app.js');
const sources = require('./sources.js');
const {
  createCenterState, currentFinding, currentChain, problemGroups, findingLocation, selectFile, switchMode, selectFinding,
  completeReview, applySampleFix, undoSampleFix, recordFixValidation, sourceFiles, summaryText, statusLabel,
  preparationState, prepareForReview, chooseMaterial, changeRequirementInclusion, approvalGate, submitVerdict,
  scopeState, changeScope, fileNavigation, comparisonChanges, gitStatusLabels, coverageLimits, understandingChecks,
  beginRequirementEdit, saveRequirementEdit, conclusionState, requestApproval, confirmApproval, updateNotes,
} = require('./center.js');

function preparedFreshState() {
  const state = createCenterState('fresh');
  chooseMaterial(state, 'payments', true);
  chooseMaterial(state, 'orders', true);
  return state;
}

test('默认选中问题的主要代码，设置与意见仍是原页区域', () => {
  const state = createCenterState();
  assert.equal(state.center.stage, 'review');
  assert.equal(state.center.file, 'restore');
  assert.equal(currentFinding(state).id, 'F-02');
  assert.equal(currentChain(state).id, 'orders');
  assert.equal(state.center.navigator, 'findings');
  assert.equal(state.center.settingsOpen, false);
  assert.deepEqual(findingLocation(state), { file: 'restore', path: 'src/orders/restore.ts', line: 27 });
});

test('未开始可先浏览文件，就绪仅展开原页意见', () => {
  assert.equal(createCenterState('fresh').center.stage, 'prepare');
  assert.equal(createCenterState('ready').center.stage, 'conclusion');
  assert.equal(createCenterState('fresh').center.settingsOpen, true);
  assert.equal(createCenterState('fresh').center.opinionOpen, false);
  assert.equal(createCenterState('ready').center.opinionOpen, true);
  assert.equal(createCenterState('fresh').center.navigator, 'files');
  assert.equal(createCenterState('fresh').center.file, 'submit');
});

test('待处理问题与已处理或排除的问题分开，未执行分析不展示预设发现', () => {
  const standard = problemGroups(createCenterState());
  assert.deepEqual(standard.open.map((finding) => finding.id), ['F-01', 'F-02', 'F-03']);
  assert.deepEqual(standard.closed.map((finding) => finding.id), ['F-04', 'F-05']);
  assert.deepEqual(problemGroups(createCenterState('fresh')), { open: [], closed: [] });
  assert.equal(problemGroups(createCenterState('ready')).open.length, 0);
});

test('切换问题保留当前页设置与意见，只重置关联阅读内容', () => {
  const state = createCenterState();
  Object.assign(state.center, { settingsOpen: true, opinionOpen: true, sourceOpen: true, evidenceOpen: true });
  updateNotes(state, '保留人工说明。');
  selectFinding(state, 'F-03');
  assert.equal(state.center.settingsOpen, true);
  assert.equal(state.center.opinionOpen, true);
  assert.equal(state.center.sourceOpen, false);
  assert.equal(state.center.evidenceOpen, false);
  assert.equal(state.notes, '保留人工说明。');
});

test('工作区区分任务准备和代码审查，问题详情按需展开而不挤入准备页', () => {
  const html = readFileSync(join(__dirname, 'index.html'), 'utf8');
  const controller = readFileSync(join(__dirname, 'center.js'), 'utf8');
  assert.doesNotMatch(html, /id="stage-navigation"|id="review-navigator"|id="review-inspector"/);
  const renderer = controller.slice(controller.indexOf('  function render(preserve'), controller.indexOf('  function stage(id)'));
  for (const id of ['linked-workspace', 'review-code', 'problem-list']) assert.ok(renderer.includes(id));
  assert.doesNotMatch(renderer, /id="review-settings"|class="review-result"|id="review-opinion"|class="judgment-pane"|result-heading/);
  assert.match(renderer, /renderRepositoryOverview\(\)/);
  assert.match(renderer, /renderTaskPreparation\(\)/);
  assert.match(renderer, /class="issue-inspector"/);
  const navigation = controller.slice(controller.indexOf('  function renderNavigator()'), controller.indexOf('  function renderTop()'));
  assert.match(navigation, /data-tab="files"/);
  assert.match(navigation, /data-tab="findings"/);
  assert.doesNotMatch(navigation, /data-tab="business"|data-tab="feedback"/);
  assert.match(controller, /problemGroups\(state\)\.open/);
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

test('有无需求都审整仓，PR差异只标记变更文件', () => {
  const without = createCenterState('fresh');
  const withRequirements = preparedFreshState();
  assert.deepEqual(scopeState(without).files, scopeState(withRequirements).files);
  assert.equal(scopeState(without).files.length, 12);
  assert.equal(scopeState(without).changedFiles.length, 3);
  assert.ok(scopeState(without).files.includes('service'));
  assert.ok(!scopeState(without).changedFiles.includes('service'));
  prepareForReview(without);
  completeReview(without);
  assert.equal(without.mode, 'technical');
  assert.match(summaryText(without), /整仓综合 Bug 审查/);
});

test('PR文件导航只列Changes，但整仓审查及关联代码读取不被缩小', () => {
  const state = createCenterState('fresh');
  const navigation = fileNavigation(state);
  assert.equal(navigation.label, 'Changes');
  assert.equal(navigation.base.name, 'main');
  assert.deepEqual(navigation.rows.map((row) => [row.key, row.status]), [['submit', 'M'], ['callback', 'M'], ['restore', 'M']]);
  assert.equal(scopeState(state).files.length, 12);
  selectFile(state, 'service');
  assert.equal(state.center.file, 'service');
  assert.equal(fileNavigation(state).rows.length, 3);
  changeScope(state, { pr: '105' });
  assert.deepEqual(fileNavigation(state).rows.map((row) => row.key), ['status', 'job']);
});

test('分支导航列完整仓库，状态始终相对默认分支而不是当前工作区或自选基线', () => {
  const state = createCenterState('fresh');
  changeScope(state, { kind: 'branch', mode: 'full' });
  const navigation = fileNavigation(state);
  assert.equal(navigation.label, '文件');
  assert.equal(navigation.rows.length, 12);
  assert.equal(navigation.base.name, 'main');
  assert.equal(navigation.rows.filter((row) => row.status === 'M').length, 3);
  assert.equal(navigation.rows.filter((row) => row.status === '').length, 9);
  changeScope(state, { mode: 'changes', base: 'release/2026.10' });
  assert.equal(fileNavigation(state).base.name, 'main');
  assert.equal(fileNavigation(state).rows.filter((row) => row.status === 'M').length, 3);
  changeScope(state, { branch: 'main', mode: 'full' });
  assert.equal(fileNavigation(state).rows.length, 12);
  assert.ok(fileNavigation(state).rows.every((row) => row.status === ''));
});

test('Git状态保留新增删除重命名语义，反向比较正确交换状态与路径', () => {
  const repository = { comparisons: { 'feature|main': [
    { key: 'new', status: 'A' }, { key: 'old', status: 'D' },
    { key: 'rename', status: 'R', previousPath: 'src/old.ts', path: 'src/new.ts' }, { key: 'edit', status: 'M' },
  ] } };
  assert.deepEqual(comparisonChanges(repository, { name: 'feature' }, { name: 'main' }).map((entry) => entry.status), ['A', 'D', 'R', 'M']);
  const reverse = comparisonChanges(repository, { name: 'main' }, { name: 'feature' });
  assert.deepEqual(reverse.map((entry) => entry.status), ['D', 'A', 'R', 'M']);
  assert.equal(reverse[2].previousPath, 'src/new.ts');
  assert.equal(reverse[2].path, 'src/old.ts');
  assert.deepEqual(gitStatusLabels, { M: '修改', A: '新增', D: '删除', R: '重命名' });
  assert.throws(() => comparisonChanges({ comparisons: { 'feature|main': [{ key: 'x', status: 'R' }] } }, { name: 'feature' }, { name: 'main' }), /原路径与新路径/);
});

test('需求与比较基线都不能改写同一个头提交的代码', () => {
  const withRequirements = createCenterState('standard');
  const without = createCenterState('technical');
  const text = (state, key) => sourceFiles(state)[key].lines.map((line) => line.text).join('\n');
  for (const key of scopeState(without).files.filter((key) => sourceFiles(without)[key].kind === 'code')) {
    assert.equal(text(withRequirements, key), text(without, key));
  }
  const original = text(withRequirements, 'restore');
  changeScope(withRequirements, { kind: 'branch', base: 'release/2026.10' });
  assert.equal(text(withRequirements, 'restore'), original);
});

test('任务绑定Repo，分支提供明确比较基线与全量选项，需求与意见按需查看', () => {
  const controller = readFileSync(join(__dirname, 'center.js'), 'utf8');
  assert.doesNotMatch(controller, /changeReviewFocus|review-focus|reviewFocuses|optional-focus/);
  const controls = controller.slice(controller.indexOf('  function renderScopeSelection()'), controller.indexOf('  function understandingExtras('));
  assert.match(controls, /id="scope-base"/);
  assert.match(controls, /id="scope-mode"/);
  assert.doesNotMatch(controls, /id="scope-repository"/);
  assert.match(controller, /function openRequirements\(\)/);
  assert.match(controller, /function openOpinion\(\)/);
  assert.match(controller, /modalRenderer = renderer/);
});

test('问题定位到主要代码而非第一条证据，跨文件阅读不改变问题', () => {
  const state = createCenterState();
  for (const [id, file, line] of [['F-01', 'submit', 43], ['F-02', 'restore', 27], ['F-03', 'callback', 16]]) {
    selectFinding(state, id);
    assert.equal(state.center.file, file);
    assert.equal(state.center.targetLine, line);
    assert.equal(findingLocation(state).line, line);
  }
  selectFinding(state, 'F-02');
  selectFile(state, 'cancel');
  assert.equal(state.selectedFinding, 'F-02');
  assert.equal(state.center.file, 'cancel');
  assert.equal(state.center.targetLine, 19);
  assert.equal(findingLocation(state).file, 'restore');
  assert.equal(findingLocation(createCenterState('technical')).line, 29);
});

test('从文件搜索定位问题不继承错误过滤条件，问题搜索仍保留', () => {
  const state = createCenterState();
  Object.assign(state.center, { navigator: 'files', search: 'callback.ts' });
  selectFinding(state, 'F-03');
  assert.equal(state.center.navigator, 'findings');
  assert.equal(state.center.search, '');
  state.center.search = 'F-03';
  selectFinding(state, 'F-03');
  assert.equal(state.center.search, 'F-03');
});

test('文件读取与修复不得跨仓库或绕过当前快照有效性', () => {
  const state = createCenterState();
  state.stale = true;
  assert.throws(() => applySampleFix(state, 'F-02'), /有效审查/);
  assert.throws(() => applySampleFix(createCenterState('fresh'), 'F-02'), /有效审查/);
  changeScope(state, { repository: 'sandbox' });
  selectFile(state, 'restore');
  assert.throws(() => selectFile(state, 'submit'), /不属于/);
  assert.throws(() => selectFile(state, 'missing'), /不属于/);
});

test('不同PR头快照不能冒用当前预设分析，完整文件仍可阅读', () => {
  const state = createCenterState('fresh');
  changeScope(state, { pr: '105' });
  prepareForReview(state);
  completeReview(state);
  assert.equal(scopeState(state).files.length, 12);
  assert.equal(scopeState(state).changedFiles.length, 2);
  assert.equal(state.hasResults, false);
  assert.equal(state.runStatus, 'partial');
  assert.equal(approvalGate(state).feedbackAllowed, false);
});

test('局部疑点被推翻后，不允许生成代码修复', () => {
  const state = createCenterState();
  assert.throws(() => applySampleFix(state, 'F-04'), /已澄清的实现/);
  assert.equal(state.findings.find((finding) => finding.id === 'F-04').status, 'dismissed');
});

test('应用示例补丁先使判断过期，预设复审后才可处理，撤销再次过期', () => {
  const state = createCenterState('technical');
  const before = sourceFiles(state).restore.lines.map((line) => line.text).join('\n');
  applySampleFix(state, 'F-02');
  assert.equal(state.stale, true);
  assert.equal(state.findings.find((finding) => finding.id === 'F-02').resolved, false);
  assert.equal(approvalGate(state).eligible, false);
  assert.ok(sourceFiles(state).restore.lines.some((line) => line.text.includes('reserveForOrder')));
  recordFixValidation(state, 'F-02', true);
  completeReview(state);
  assert.equal(state.stale, false);
  assert.equal(approvalGate(state).eligible, true);
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
  assert.equal(demo.approvalGate(state).eligible, false);
  recordFixValidation(state, 'F-01', true);
  completeReview(state);
  applySampleFix(state, 'F-02');
  assert.equal(demo.approvalGate(state).eligible, false);
  recordFixValidation(state, 'F-01', true);
  recordFixValidation(state, 'F-02', true);
  completeReview(state);
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
  assert.deepEqual(statusLabel(state.findings.find((item) => item.id === 'F-02')), ['已应用 · 待复审', 'amber']);
  assert.equal(state.findings.find((item) => item.id === 'F-02').resolved, false);
  recordFixValidation(state, 'F-02', true);
  completeReview(state);
  assert.deepEqual(statusLabel(state.findings.find((item) => item.id === 'F-02')), ['示例已处理', 'blue']);
  assert.equal(state.findings.find((item) => item.id === 'F-02').disposition, 'demo-rechecked');
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
  assert.equal(preparation.scope.files.length, 12);
  assert.deepEqual(preparation.scope.changedFiles, ['submit', 'callback', 'restore']);
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
  assert.deepEqual(scopeState(state).files, ['restore', 'cancel', 'api', 'orders']);
  assert.deepEqual(scopeState(state).changedFiles, ['restore']);
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
  assert.equal(scope.files.length, 12);
  assert.deepEqual(scope.changedFiles, ['status', 'job']);
  assert.equal(state.findings.length, 0);
  assert.equal(state.baselineConfirmed, false);
  changeScope(state, { kind: 'branch' });
  assert.equal(scopeState(state).head.name, 'feat/status-cache');
  assert.equal(scopeState(state).files.length, 12);
  assert.deepEqual(scopeState(state).changedFiles, ['status', 'job']);
});

test('比较基线只改变差异清单，所有分支模式都使用整仓范围', () => {
  const state = preparedFreshState();
  changeScope(state, { kind: 'branch' });
  assert.equal(scopeState(state).base.name, 'main');
  assert.equal(scopeState(state).files.length, 12);
  assert.deepEqual(scopeState(state).changedFiles, ['submit', 'callback', 'restore']);
  changeScope(state, { base: 'release/2026.10' });
  assert.equal(scopeState(state).files.length, 12);
  assert.deepEqual(scopeState(state).changedFiles, ['submit', 'restore']);
  changeScope(state, { mode: 'full' });
  const scope = scopeState(state);
  assert.equal(scope.mode, 'full');
  assert.equal(scope.base, null);
  assert.equal(scope.files.length, 12);
  assert.equal(new Set(scope.files).size, scope.files.length);
  assert.ok(scope.files.every((key) => sourceFiles(state)[key]));
  prepareForReview(state, true);
  completeReview(state);
  assert.equal(state.runStatus, 'completed');
  assert.equal(state.hasResults, true);
  assert.ok(state.findings.length > 0);
  assert.equal(approvalGate(state).eligible, false);
  assert.equal(approvalGate(state).feedbackAllowed, true);
  assert.match(summaryText(state), /全量快照，不以 Diff 定义范围/);
});

test('非法对象和同分支基线不改状态，空差异仍允许整仓审查', () => {
  const state = createCenterState('fresh');
  const original = scopeState(state).key;
  assert.throws(() => changeScope(state, { repository: 'missing' }), /Repository/);
  assert.throws(() => changeScope(state, { pr: '207' }), /不属于/);
  assert.throws(() => changeScope(state, { kind: 'branch', base: 'feat/payment-timeout' }), /不能与/);
  assert.throws(() => changeScope(state, { snapshot: 0 }), /快照版本无效/);
  assert.equal(scopeState(state).key, original);
  changeScope(state, { kind: 'branch', branch: 'main', base: 'release/2026.10' });
  assert.equal(scopeState(state).files.length, 12);
  assert.deepEqual(scopeState(state).changedFiles, []);
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

test('覆盖限制直接提供给审查和结论，正常示例不额外制造限制', () => {
  assert.deepEqual(coverageLimits(createCenterState()), []);
  assert.deepEqual(coverageLimits(createCenterState('ready')), []);
  const state = createCenterState('partial');
  assert.equal(coverageLimits(state).length, 1);
  assert.match(coverageLimits(state)[0], /通道契约读取受限/);
  state.sourceReview.limited = true;
  assert.equal(coverageLimits(state).length, 2);
  assert.ok(coverageLimits(state).some((limit) => /尚未.*语义评审/.test(limit)));
});

test('新快照缺少分析与自定义材料受限分别说明，不能互相覆盖', () => {
  const state = createCenterState('ready');
  changeScope(state, { snapshot: 2 });
  state.sourceReview.limited = true;
  const limits = coverageLimits(state);
  assert.equal(limits.length, 2);
  assert.match(limits[0], /没有对应的预设发现/);
  assert.match(limits[1], /预设发现仅供对照/);
  assert.equal(approvalGate(state).eligible, false);
  assert.equal(approvalGate(state).feedbackAllowed, false);
});

test('没有独立范围弹窗，源码从证据和关联文件就地展开', () => {
  const controller = readFileSync(join(__dirname, 'center.js'), 'utf8');
  assert.doesNotMatch(controller, /function scopeDialog\b|data-action="scope(?:-source)?"/);
  assert.doesNotMatch(controller, /action === 'scope(?:-source)?'/);
  assert.match(controller, /data-action="source" data-source="\$\{key\}"/);
  assert.match(controller, /selectFile\(state, key\)/);
  assert.match(controller, /locateCurrentCode\(\)/);
});

test('模拟新提交只在原型演示工具中提供，不再藏在范围弹窗', () => {
  const html = readFileSync(join(__dirname, 'index.html'), 'utf8');
  const controls = html.match(/<details id="demo-tools"[\s\S]*?<\/details>/);
  assert.ok(controls);
  assert.match(controls[0], /data-action="simulate-code-change"/);
  assert.equal([...html.matchAll(/data-action="simulate-code-change"/g)].length, 1);
  const controller = readFileSync(join(__dirname, 'center.js'), 'utf8');
  assert.doesNotMatch(controller, /data-action="simulate-code-change"/);
});

test('场景切换仅属于演示工具，不常驻产品顶部或被当作实际审查状态', () => {
  const html = readFileSync(join(__dirname, 'index.html'), 'utf8');
  const controls = html.match(/<details id="demo-tools"[\s\S]*?<\/details>/);
  assert.ok(controls);
  assert.match(controls[0], /id="demo-scenario"/);
  assert.match(controls[0], /演示场景（非实际审查状态）/);
  assert.doesNotMatch(html.replace(controls[0], ''), /id="demo-scenario"/);
  assert.equal([...html.matchAll(/id="demo-scenario"/g)].length, 1);
});

test('仓库与对象选择放在左侧审查导航上方，不挤入顶栏或代码区', () => {
  const html = readFileSync(join(__dirname, 'index.html'), 'utf8');
  const header = html.match(/<header class="command-bar">[\s\S]*?<\/header>/);
  assert.ok(header);
  assert.doesNotMatch(header[0], /id="context-bar"/);
  const controller = readFileSync(join(__dirname, 'center.js'), 'utf8');
  const navigation = controller.slice(controller.indexOf('  function renderNavigator()'), controller.indexOf('  function renderTop()'));
  assert.match(navigation, /renderContextControls\(\)/);
  assert.ok(navigation.indexOf('renderContextControls()') < navigation.indexOf('navigator-heading'));
  assert.equal([...controller.matchAll(/id="context-bar"/g)].length, 1);
});

test('审查对象可手动折叠，选择、审查与范围切换不覆盖手动状态', () => {
  const state = createCenterState('fresh');
  assert.equal(state.center.contextExpanded, true);
  state.center.contextExpanded = false;
  selectFile(state, 'callback');
  prepareForReview(state);
  completeReview(state);
  selectFinding(state, 'F-02');
  assert.equal(state.center.contextExpanded, false);
  changeScope(state, { repository: 'sandbox' });
  assert.equal(state.center.contextExpanded, false);
  const controller = readFileSync(join(__dirname, 'center.js'), 'utf8');
  assert.match(controller, /<details id="context-bar"/);
  assert.match(controller, /class="context-toggle"/);
  assert.match(controller, /'context-bar': 'contextExpanded'/);
});

test('折叠箭头复用固定尺寸SVG图标，不用字体字符模拟箭头', () => {
  const controller = readFileSync(join(__dirname, 'center.js'), 'utf8');
  const control = controller.slice(controller.indexOf('  function renderContextControls()'), controller.indexOf('  function renderNavigator()'));
  assert.ok(control.includes("${icon('chevron')}<span>"));
  const css = readFileSync(join(__dirname, 'center.css'), 'utf8');
  assert.doesNotMatch(css, /\.context-toggle::before/);
  assert.match(css, /\.context-toggle > svg\s*\{[^}]*width: 12px;[^}]*height: 12px;/);
  assert.match(css, /\.context-toggle\s*\{[^}]*align-items: center;/);
});

test('需求就地修订先保留草稿，保存不覆盖来源原文', () => {
  const state = preparedFreshState();
  const original = sources.getSource(state, 'payments').text;
  const draft = beginRequirementEdit(state, 'RQ-01');
  assert.equal(draft.text, preparationState(state).items.find((item) => item.id === 'RQ-01').text);
  draft.title = '补充扣款边界';
  draft.text = '**人工补充**：失败重试和人工补单也必须满足单次扣款约束。';
  assert.equal(preparationState(state).canStart, false);
  assert.throws(() => prepareForReview(state, true), /保存或取消/);
  saveRequirementEdit(state);
  assert.equal(state.center.requirementEdit, null);
  assert.equal(sources.getSource(state, 'payments').text, original);
  const revised = preparationState(state).items.find((item) => item.id === 'RQ-01');
  assert.equal(revised.text, draft.text);
  assert.equal(revised.basis, 'human');
  assert.equal(preparationState(state).needsConfirmation, true);
});

test('未保存修订不能批准，也不能静默被另一条修订替换', () => {
  const state = createCenterState('ready');
  beginRequirementEdit(state, 'RQ-01');
  assert.equal(approvalGate(state).eligible, false);
  assert.throws(() => beginRequirementEdit(state, 'RQ-02'), /保存或取消/);
  assert.equal(state.center.requirementEdit.id, 'RQ-01');
  state.center.requirementEdit = null;
  assert.equal(approvalGate(state).eligible, true);
});

test('材料变化后拒绝保存旧修订草稿，但保留输入供核对', () => {
  const state = preparedFreshState();
  const draft = beginRequirementEdit(state, 'RQ-01');
  draft.text = '尚未保存的输入';
  chooseMaterial(state, 'design', true);
  assert.throws(() => saveRequirementEdit(state), /材料已变化/);
  assert.equal(state.center.requirementEdit.text, '尚未保存的输入');
  assert.equal(state.baselineConfirmed, false);
});

test('移出来源后保留完整修订快照，不把过期草稿当作当前要求', () => {
  const state = preparedFreshState();
  const draft = beginRequirementEdit(state, 'RQ-01');
  const quote = draft.original.origins[0].quote;
  draft.text = '尚未保存的原文修订';
  chooseMaterial(state, 'payments', false);
  assert.equal(preparationState(state).items.some((item) => item.id === 'RQ-01'), false);
  assert.equal(preparationState(state).canStart, false);
  assert.equal(state.center.requirementEdit.original.origins[0].quote, quote);
  assert.equal(state.center.requirementEdit.text, '尚未保存的原文修订');
  assert.throws(() => saveRequirementEdit(state), /材料已变化/);
});

test('演示需求修订仍需保存、确认和重审，不直接解除问题', () => {
  const state = createCenterState();
  const draft = beginRequirementEdit(state, 'RQ-02', true);
  assert.equal(draft.text, demo.revisedRequirement);
  assert.equal(state.pending.requirement, undefined);
  saveRequirementEdit(state);
  assert.equal(state.pending.requirement, true);
  assert.equal(state.baselineConfirmed, false);
  assert.equal(state.stale, true);
  assert.equal(approvalGate(state).eligible, false);
});

test('结论只展示当前动作的阻断，关键问题不阻止有效评论', () => {
  const state = createCenterState('partial');
  const approval = conclusionState(state, 'approve');
  assert.equal(approval.allowed, false);
  assert.ok(approval.blockers.some((reason) => reason.includes('F-01')));
  const feedback = conclusionState(state, 'comment');
  assert.equal(feedback.allowed, true);
  assert.deepEqual(feedback.blockers, []);
  assert.throws(() => conclusionState(state, 'unknown'), /未知/);
});

test('新范围无有效结果时，反馈说明有效性问题而不是批准专用条件', () => {
  const state = createCenterState();
  changeScope(state, { pr: '105' });
  const feedback = conclusionState(state, 'request-changes');
  assert.equal(feedback.allowed, false);
  assert.ok(feedback.blockers.some((reason) => reason.includes('有效')));
  assert.equal(feedback.blockers.some((reason) => reason.includes('F-01')), false);
});

test('批准只在最终确认时记录人工意图，打开确认不算批准', () => {
  const state = createCenterState('ready');
  const request = requestApproval(state);
  assert.equal(state.humanConfirmed, false);
  assert.equal(state.submission, null);
  assert.throws(() => submitVerdict(state, 'approve'), /人工确认/);
  confirmApproval(state, request);
  assert.equal(state.humanConfirmed, true);
  assert.equal(state.submission.verdict, 'approve');
});

test('确认期间待提交内容或结论改变，旧批准意图不能沿用', () => {
  const state = createCenterState('ready');
  const request = requestApproval(state);
  state.notes = '新增的待提交说明';
  assert.throws(() => confirmApproval(state, request), /变化/);
  assert.equal(state.humanConfirmed, false);
  assert.equal(state.submission, null);
  state.notes = '';
  state.verdict = 'comment';
  assert.throws(() => confirmApproval(state, request), /通过/);
});

test('待提交正文改变使旧记录失效，但不要求重复分析未变代码', () => {
  const state = createCenterState('ready');
  confirmApproval(state, requestApproval(state));
  assert.equal(updateNotes(state, '新增需要提交的说明'), true);
  assert.equal(state.submission, null);
  assert.equal(state.humanConfirmed, false);
  assert.equal(state.stale, false);
  assert.equal(state.hasResults, true);
  assert.equal(approvalGate(state).eligible, true);
});

test('输出未变的空白调整不增加确认，非文本说明显式报错', () => {
  const state = createCenterState('ready');
  confirmApproval(state, requestApproval(state));
  const record = state.submission;
  assert.equal(updateNotes(state, ' \n'), false);
  assert.equal(state.submission, record);
  assert.equal(state.humanConfirmed, true);
  assert.throws(() => updateNotes(state, null), /文本/);
});

test('代码快照改变或关键问题未闭合时不能生成或确认批准意图', () => {
  const blocked = createCenterState();
  blocked.verdict = 'approve';
  assert.throws(() => requestApproval(blocked), /通过/);
  const state = createCenterState('ready');
  const request = requestApproval(state);
  changeScope(state, { snapshot: 2 });
  assert.throws(() => confirmApproval(state, request), /通过/);
  assert.equal(state.humanConfirmed, false);
});

test('材料读取中阻止提交和最终确认，不能抢在迟到结果前批准', () => {
  const state = createCenterState('ready');
  const request = requestApproval(state);
  state.sourceReview.readingFile = true;
  assert.equal(conclusionState(state, 'approve').allowed, false);
  assert.equal(conclusionState(state, 'comment').allowed, false);
  assert.throws(() => confirmApproval(state, request), /通过|读取/);
  assert.equal(state.humanConfirmed, false);
});

test('审查运行中按钮状态与提交约束一致，取消后可提交仍有效的反馈', () => {
  const state = createCenterState('ready');
  state.runStatus = 'running';
  assert.equal(conclusionState(state, 'comment').allowed, false);
  assert.ok(conclusionState(state, 'comment').blockers.some((reason) => reason.includes('审查正在进行')));
  assert.throws(() => submitVerdict(state, 'comment'), /有效结果/);
  state.runStatus = 'cancelled';
  assert.equal(conclusionState(state, 'comment').allowed, true);
});

test('摘要保留覆盖限制，但界面不再设置第二套全文或批准复选框', () => {
  const state = createCenterState('partial');
  assert.match(summaryText(state), /覆盖限制/);
  assert.match(summaryText(state), /通道契约读取受限/);
  const controller = readFileSync(join(__dirname, 'center.js'), 'utf8');
  assert.equal(/function (understandingDialog|openSummary|editorTabs|journey|relatedContext|gateChecks)\b/.test(controller), false);
  assert.equal(/data-action="(?:summary|recheck|related|read-material)"/.test(controller), false);
  assert.equal(/id="center-human"/.test(controller), false);
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

test('字号统一为12px辅助、13px操作、14px正文和16/20px标题', () => {
  const root = stylesheet.match(/^:root\s*\{([^}]+)\}/m)[1];
  const sizes = Object.fromEntries([...root.matchAll(/--font-(\w+):\s*(\d+)px;/g)]
    .map((match) => [match[1], Number(match[2])]));
  assert.deepEqual(sizes, { xs: 12, sm: 13, md: 14, lg: 16, xl: 20 });
  assert.match(root, /font-size:\s*var\(--font-md\)/);
  for (const selector of ['.button', '.scope-field select', '.context-toggle', '.code-linked .file-nav > span']) {
    const rule = stylesheet.slice(stylesheet.indexOf(`${selector} {`)).split('}')[0];
    assert.match(rule, /font-size:\s*var\(--font-sm\)/, selector);
  }
  for (const selector of ['.requirement-item p', '.markdown-body', '.reasoning li']) {
    const rule = stylesheet.slice(stylesheet.indexOf(`${selector} {`)).split('}')[0];
    assert.match(rule, /font-size:\s*var\(--font-md\)/, selector);
  }
});

test('源码沿用14px等宽字号与行高，响应式规则不再压小主工作区文字', () => {
  assert.match(stylesheet, /\.code-table\s*\{[^}]*font:\s*var\(--font-md\)\/1\.75 "Cascadia Code", Consolas, monospace;/);
  const codeRules = [...stylesheet.matchAll(/\.code-line code\s*\{([^}]+)\}/g)];
  assert.equal(codeRules.length, 1);
  assert.match(codeRules[0][1], /font-size:\s*inherit/);
  assert.match(codeRules[0][1], /line-height:\s*inherit/);
  for (const selector of ['.product-lockup strong', '.product-lockup span:not(.product-mark)', '.code-line .line-no', '.inspector-title', '.reasoning li']) {
    const rules = [...stylesheet.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter((match) => match[1].trim() === selector);
    for (const rule of rules) {
      assert.doesNotMatch(rule[2], /font-size:\s*\d+px/, selector);
    }
  }
});

test('窄屏导航允许整体滚动，不因较大字号把文件列表压成不可操作区域', () => {
  const mobile = stylesheet.slice(stylesheet.indexOf('@media (max-width: 620px)'));
  assert.match(mobile, /\.problem-list\s*\{[^}]*overflow:\s*auto;/);
  assert.match(mobile, /\.code-linked \.problem-list \.navigator-scroll\s*\{[^}]*flex:\s*none;[^}]*overflow:\s*visible;/);
});

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

test('文件状态使用GitHub Primer深浅主题前景色，与交互和审核结果颜色分离', () => {
  const expected = [
    { 'git-modified': '#d29922', 'git-added': '#3fb950', 'git-deleted': '#f85149', 'git-renamed': '#9198a1' },
    { 'git-modified': '#9a6700', 'git-added': '#1a7f37', 'git-deleted': '#d1242f', 'git-renamed': '#59636e' },
  ];
  assert.equal(palettes.length, expected.length);
  for (const [index, colors] of expected.entries()) {
    for (const [name, hex] of Object.entries(colors)) {
      assert.equal(palettes[index][name], hex);
      for (const background of ['surface', 'hover']) {
        assert.ok(contrast(hex, palettes[index][background]) >= 3, `${name}/${background} 状态指示对比不足`);
      }
    }
    assert.notEqual(palettes[index]['git-modified'], palettes[index].accent);
  }
  for (const [status, name] of [['m', 'modified'], ['a', 'added'], ['d', 'deleted'], ['r', 'renamed']]) {
    assert.ok(stylesheet.includes(`.file-role.git-${status} { color: var(--git-${name}); }`));
  }
});

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
