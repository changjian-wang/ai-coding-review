const test = require('node:test');
const assert = require('node:assert/strict');
const sources = require('./sources.js');
const {
  createWorkspaceState, currentReviewTask, openRepository, createReviewTask, selectReviewTask,
  rememberRepositoryMaterial, configureSkill, parseWorkspace, preparationState, prepareForReview,
  scopeState, applySampleFix, recordFixValidation, completeReview, approvalGate, undoSampleFix, statusLabel,
  saveManualEdit, undoManualEdit, fixValidationKey, sourceFiles, changeScope,
} = require('./center.js');

test('工作区从 Repo 的任务列表开始，支持同时打开多个 Repo', () => {
  const workspace = createWorkspaceState();
  assert.equal(workspace.view, 'repository');
  assert.equal(workspace.remember, false);
  assert.equal(currentReviewTask(workspace), null);
  openRepository(workspace, 'sandbox');
  openRepository(workspace, 'checkout');
  assert.deepEqual(workspace.openRepositories, ['checkout', 'sandbox']);
  assert.throws(() => openRepository(workspace, 'unknown'), /演示 Repo/);
});

test('多 Repo 与同 Repo 的多个任务分别保留范围、原文、输入和进度', () => {
  const workspace = createWorkspaceState();
  const first = createReviewTask(workspace, 'checkout');
  const input = sources.addManualSource(first.state, '仅任务一', '任务一独有的验收原文。', 'requirement');
  first.state.notes = '未完成的人工说明';
  first.state.center.search = 'restore';
  first.state.runStatus = 'running';
  const second = createReviewTask(workspace, 'checkout', { selection: { pr: '105' } });
  const third = createReviewTask(workspace, 'sandbox');
  assert.equal(scopeState(second.state).pr.id, '105');
  assert.equal(scopeState(third.state).pr.id, '207');
  assert.ok(!second.state.sources.some((item) => item.id === input));
  assert.ok(!third.state.sources.some((item) => item.id === input));
  selectReviewTask(workspace, first.id);
  assert.equal(currentReviewTask(workspace), first);
  assert.equal(first.state.runStatus, 'running');
  assert.equal(first.state.notes, '未完成的人工说明');
  assert.equal(first.state.center.search, 'restore');
  openRepository(workspace, 'sandbox');
  assert.equal(currentReviewTask(workspace), third);
  assert.throws(() => createReviewTask(workspace, 'checkout', { selection: { repository: 'sandbox' } }), /只能属于/);
});

test('Repo 参考按快照带入新任务，修改和移除不污染其他任务', () => {
  const workspace = createWorkspaceState();
  const first = createReviewTask(workspace, 'checkout');
  const second = createReviewTask(workspace, 'checkout');
  const material = first.state.sources.find((item) => item.binding === 'repository');
  assert.equal(material.selected, true);
  assert.equal(material.purpose, 'context');
  sources.selectSource(first.state, material.id, false);
  assert.equal(second.state.sources.find((item) => item.id === material.id).selected, true);
  assert.equal(workspace.repositoryMaterials.checkout[0].selected, true);
  assert.equal(preparationState(first.state).mode, 'technical');
});

test('材料提升为 Repo 常用参考只影响该 Repo 之后创建的任务', () => {
  const workspace = createWorkspaceState();
  const first = createReviewTask(workspace, 'checkout');
  const second = createReviewTask(workspace, 'checkout');
  const id = sources.addManualSource(first.state, '工程约定', '# 本 Repo 约定\n\n保留原文。', 'auto');
  const material = rememberRepositoryMaterial(workspace, first.id, id);
  sources.updateSource(first.state, id, '本次任务的后续修改。');
  assert.equal(material.text, '# 本 Repo 约定\n\n保留原文。');
  assert.ok(!second.state.sources.some((item) => item.id === material.id));
  assert.equal(createReviewTask(workspace, 'checkout').state.sources.find((item) => item.id === material.id).text, material.text);
  assert.ok(!createReviewTask(workspace, 'sandbox').state.sources.some((item) => item.name === '工程约定'));
  assert.throws(() => rememberRepositoryMaterial(workspace, first.id, id, 1), /已经/);
});

test('Skill 是方法配置，不自动变成需求；变更后旧判断过期', () => {
  const workspace = createWorkspaceState();
  const task = createReviewTask(workspace, 'checkout', { scenario: 'standard' });
  const requirements = JSON.stringify(task.state.requirements);
  configureSkill(task.state, 'compatibility', true);
  assert.equal(task.state.stale, true);
  assert.equal(task.state.baselineConfirmed, true);
  assert.equal(JSON.stringify(task.state.requirements), requirements);
  assert.equal(approvalGate(task.state).eligible, false);
  assert.throws(() => configureSkill(task.state, 'arbitrary-script', true), /可用/);
  task.state.runStatus = 'running';
  assert.throws(() => configureSkill(task.state, 'state-machine', true), /取消审查/);
});

test('工作区恢复原文与任务隔离，将中断运行和文件读取明确恢复为未完成', () => {
  const workspace = createWorkspaceState();
  const first = createReviewTask(workspace, 'checkout');
  sources.addManualSource(first.state, '本次要求', '刷新后仍能追溯的原文。', 'requirement');
  first.state.runStatus = 'running';
  first.state.sourceReview.readingFile = true;
  const second = createReviewTask(workspace, 'sandbox');
  const restored = parseWorkspace(JSON.stringify(workspace));
  const oldTask = restored.tasks.find((item) => item.id === first.id);
  assert.equal(restored.remember, true);
  assert.equal(currentReviewTask(restored).id, second.id);
  assert.equal(oldTask.state.runStatus, 'cancelled');
  assert.equal(oldTask.state.sourceReview.readingFile, false);
  assert.ok(oldTask.state.sources.some((item) => item.text === '刷新后仍能追溯的原文。'));
  assert.ok(oldTask.state.history.some((entry) => entry.includes('上次模拟运行已中断')));
});

test('拒绝损坏、错配 Repo、重复任务和失效活动任务的存档', () => {
  assert.throws(() => parseWorkspace('{'), SyntaxError);
  assert.throws(() => parseWorkspace('{}'), /格式无效/);
  for (const corrupt of [
    (workspace) => { workspace.tasks[0].repositoryId = 'sandbox'; },
    (workspace) => { workspace.tasks.push(workspace.tasks[0]); },
    (workspace) => { workspace.activeTasks.checkout = 'review-999'; },
    (workspace) => { workspace.nextTask = 1; },
    (workspace) => { workspace.tasks[0].state.reviewContext.skillIds = ['missing']; },
  ]) {
    const workspace = createWorkspaceState();
    createReviewTask(workspace, 'checkout');
    corrupt(workspace);
    assert.throws(() => parseWorkspace(JSON.stringify(workspace)), /格式无效/);
  }
});

test('应用不等于验证，仅重审不能自动关闭尚未验证的修复', () => {
  const workspace = createWorkspaceState();
  const { state } = createReviewTask(workspace, 'checkout', { scenario: 'technical' });
  applySampleFix(state, 'F-02');
  completeReview(state);
  assert.equal(state.findings.find((item) => item.id === 'F-02').resolved, false);
  assert.equal(approvalGate(state).eligible, false);
  assert.ok(approvalGate(state).reasons.some((reason) => reason.includes('验证与复审')));
});

test('验证失败保留补丁与问题，重试成功后仍需复审，撤销使验证失效', () => {
  const workspace = createWorkspaceState();
  const { state } = createReviewTask(workspace, 'checkout', { scenario: 'technical' });
  applySampleFix(state, 'F-02');
  recordFixValidation(state, 'F-02', false);
  completeReview(state);
  assert.deepEqual(statusLabel(state.findings.find((item) => item.id === 'F-02')), ['验证失败 · 演示', 'red']);
  assert.equal(approvalGate(state).eligible, false);
  assert.equal(state.center.patches['F-02'], true);
  recordFixValidation(state, 'F-02', true);
  assert.equal(approvalGate(state).eligible, false);
  prepareForReview(state, true);
  completeReview(state);
  assert.equal(approvalGate(state).eligible, true);
  undoSampleFix(state, 'F-02');
  assert.equal(state.center.fixValidations['F-02'], undefined);
  assert.equal(approvalGate(state).eligible, false);
});

test('Skill 或材料变更后不能复用旧验证', () => {
  const workspace = createWorkspaceState();
  const { state } = createReviewTask(workspace, 'checkout', { scenario: 'technical' });
  applySampleFix(state, 'F-02');
  recordFixValidation(state, 'F-02', true);
  completeReview(state);
  assert.equal(approvalGate(state).eligible, true);
  configureSkill(state, 'state-machine', true);
  completeReview(state);
  assert.equal(approvalGate(state).eligible, false);
  assert.equal(state.findings.find((item) => item.id === 'F-02').resolved, false);
});

test('手动编辑只改本任务的浏览器副本，不沿用预设分析，撤销后仍需重审', () => {
  const workspace = createWorkspaceState();
  const { state } = createReviewTask(workspace, 'checkout', { scenario: 'technical' });
  const other = createReviewTask(workspace, 'checkout', { scenario: 'technical' }).state;
  const original = sourceFiles(state).restore.lines.map((line) => line.text).join('\n');
  saveManualEdit(state, 'restore', 'return { status: "manual-demo" };', fixValidationKey(state));
  assert.equal(sourceFiles(state).restore.lines[0].text, 'return { status: "manual-demo" };');
  assert.equal(sourceFiles(other).restore.lines.map((line) => line.text).join('\n'), original);
  assert.equal(scopeState(state).supportsFindings, false);
  assert.equal(state.hasResults, false);
  completeReview(state);
  assert.equal(state.runStatus, 'partial');
  assert.equal(state.hasResults, false);
  assert.equal(approvalGate(state).eligible, false);
  undoManualEdit(state, 'restore');
  assert.equal(sourceFiles(state).restore.lines.map((line) => line.text).join('\n'), original);
  assert.equal(scopeState(state).supportsFindings, true);
  assert.equal(state.hasResults, false);
});

test('拒绝错配任务、变化快照和非源码材料的手动编辑', () => {
  const workspace = createWorkspaceState();
  const first = createReviewTask(workspace, 'checkout').state;
  const second = createReviewTask(workspace, 'checkout').state;
  assert.throws(() => saveManualEdit(second, 'restore', 'code', fixValidationKey(first)), /目标或依据已变化/);
  const key = fixValidationKey(first);
  changeScope(first, { pr: '105' });
  assert.throws(() => saveManualEdit(first, 'restore', 'code', key), /目标或依据已变化/);
  assert.throws(() => saveManualEdit(first, 'payments', 'text', fixValidationKey(first)), /演示代码/);
});

test('自定义代码不能使用预设验证来冒充检查通过', () => {
  const workspace = createWorkspaceState();
  const { state } = createReviewTask(workspace, 'checkout', { scenario: 'technical' });
  applySampleFix(state, 'F-02');
  saveManualEdit(state, 'restore', 'return customImplementation();', fixValidationKey(state));
  assert.throws(() => recordFixValidation(state, 'F-02', true), /自定义代码副本未分析/);
  assert.equal(approvalGate(state).eligible, false);
});
