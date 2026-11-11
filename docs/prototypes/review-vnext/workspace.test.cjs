const test = require('node:test');
const assert = require('node:assert/strict');
const sources = require('./sources.js');
const {
  createWorkspaceState, addRepositories, loadRepositoryTarget, currentReviewTask, openRepository, closeRepository, createReviewTask, selectReviewTask,
  rememberRepositoryMaterial, configureSkill, parseWorkspace, preparationState, prepareForReview,
  scopeState, applySampleFix, recordFixValidation, completeReview, approvalGate, undoSampleFix, statusLabel,
  saveManualEdit, undoManualEdit, fixValidationKey, sourceFiles, fileNavigation, changeScope,
} = require('./center.js');

test('首页从零Repo开始，单选直接进入，多选等待选定Repo，不预建审查', () => {
  const workspace = createWorkspaceState();
  assert.deepEqual(workspace.openRepositories, []);
  assert.equal(workspace.selectedRepository, null);
  assert.equal(workspace.view, 'repository');
  assert.equal(workspace.remember, false);
  assert.equal(currentReviewTask(workspace), null);
  addRepositories(workspace, ['checkout', 'sandbox', 'checkout']);
  assert.deepEqual(workspace.openRepositories, ['checkout', 'sandbox']);
  assert.equal(workspace.selectedRepository, null);
  assert.deepEqual(workspace.tasks, []);
  openRepository(workspace, 'sandbox');
  openRepository(workspace, 'checkout');
  assert.deepEqual(workspace.openRepositories, ['checkout', 'sandbox']);
  const single = createWorkspaceState();
  addRepositories(single, ['checkout']);
  assert.equal(single.selectedRepository, 'checkout');
  assert.equal(currentReviewTask(single), null);
  assert.deepEqual(single.tasks, []);
  assert.throws(() => addRepositories(single, []), /至少选择/);
  assert.throws(() => addRepositories(single, ['sandbox', 'unknown']), /演示 Repo/);
  assert.deepEqual(single.openRepositories, ['checkout']);
  assert.throws(() => openRepository(workspace, 'unknown'), /演示 Repo/);
});

test('明确选择分支PR后才加载代码，分支固定整仓，选相同对象不丢材料和状态', () => {
  const workspace = createWorkspaceState();
  assert.throws(() => loadRepositoryTarget(workspace, 'checkout', 'pr:104'), /先从左侧选择/);
  addRepositories(workspace, ['sandbox']);
  const task = loadRepositoryTarget(workspace, 'sandbox', 'branch:main');
  assert.equal(scopeState(task.state).head.name, 'main');
  assert.equal(scopeState(task.state).mode, 'full');
  assert.equal(task.state.hasResults, false);
  const sourceId = sources.addManualSource(task.state, '保留要求', '仅此Repo适用的验收要求。', 'requirement');
  task.state.center.file = 'cancel';
  assert.equal(loadRepositoryTarget(workspace, 'sandbox', 'branch:main'), task);
  assert.equal(task.state.center.file, 'cancel');
  assert.ok(task.state.sources.some((item) => item.id === sourceId));
  assert.equal(workspace.tasks.length, 1);
});

test('切Repo保留上下文，换目标不冒用旧结果，失败保留已有代码且不新增任务', () => {
  const workspace = createWorkspaceState();
  addRepositories(workspace, ['checkout', 'sandbox']);
  openRepository(workspace, 'checkout');
  const first = loadRepositoryTarget(workspace, 'checkout', 'pr:104');
  prepareForReview(first.state, true);
  completeReview(first.state);
  applySampleFix(first.state, 'F-02');
  first.state.notes = '保留当前人工判断';
  first.state.center.readingPositions = { '.editor-scroll': 128 };
  const sourceId = sources.addManualSource(first.state, '当前需求', '这个Repo自己的要求。', 'requirement');
  openRepository(workspace, 'sandbox');
  assert.equal(currentReviewTask(workspace), null);
  const second = loadRepositoryTarget(workspace, 'sandbox', 'pr:207');
  assert.ok(!second.state.sources.some((item) => item.id === sourceId));
  openRepository(workspace, 'checkout');
  assert.equal(currentReviewTask(workspace), first);
  assert.equal(first.state.center.patches['F-02'], true);
  assert.equal(first.state.notes, '保留当前人工判断');
  assert.equal(first.state.center.readingPositions['.editor-scroll'], 128);
  const before = JSON.stringify(first.state);
  assert.throws(() => loadRepositoryTarget(workspace, 'checkout', 'pr:207'), /未替换已有代码/);
  assert.equal(JSON.stringify(first.state), before);
  assert.equal(loadRepositoryTarget(workspace, 'checkout', 'pr:105'), first);
  assert.equal(first.state.hasResults, false);
  assert.equal(first.state.findings.length, 0);
  assert.deepEqual(first.state.center.patches, {});
  assert.equal(first.state.scopeReview.discardedResults, true);
  assert.equal(first.state.center.file, 'status');
  assert.ok(first.state.sources.some((item) => item.id === sourceId));
  assert.equal(workspace.tasks.length, 2);
});

test('零Repo和多Repo未选中状态可恢复，未完成修订不允许被换目标清除', () => {
  const empty = parseWorkspace(JSON.stringify(createWorkspaceState()));
  assert.deepEqual(empty.openRepositories, []);
  assert.equal(empty.selectedRepository, null);
  const workspace = createWorkspaceState();
  addRepositories(workspace, ['checkout', 'sandbox']);
  assert.equal(parseWorkspace(JSON.stringify(workspace)).selectedRepository, null);
  openRepository(workspace, 'checkout');
  const task = loadRepositoryTarget(workspace, 'checkout', 'pr:104');
  task.state.center.requirementEdit = { title: '未保存输入' };
  assert.throws(() => loadRepositoryTarget(workspace, 'checkout', 'pr:105'), /保存、取消需求修订/);
  assert.equal(scopeState(task.state).pr.id, '104');
  assert.equal(task.state.center.requirementEdit.title, '未保存输入');
});

test('关闭仓库只隐藏列表，关闭最后一个后回首页，重新添加可恢复审查进度', () => {
  const workspace = createWorkspaceState();
  addRepositories(workspace, ['checkout', 'local-checkout']);
  openRepository(workspace, 'checkout');
  const task = loadRepositoryTarget(workspace, 'checkout', 'pr:104');
  task.state.notes = '关闭后仍保留的草稿';
  task.state.center.readingPositions = { '.editor-scroll': 96 };
  closeRepository(workspace, 'checkout');
  assert.equal(workspace.selectedRepository, 'local-checkout');
  assert.equal(workspace.tasks[0], task);
  closeRepository(workspace, 'local-checkout');
  assert.deepEqual(workspace.openRepositories, []);
  assert.equal(workspace.selectedRepository, null);
  const restored = parseWorkspace(JSON.stringify(workspace));
  addRepositories(restored, ['checkout']);
  assert.equal(currentReviewTask(restored).id, task.id);
  assert.equal(currentReviewTask(restored).state.notes, '关闭后仍保留的草稿');
  assert.equal(currentReviewTask(restored).state.center.readingPositions['.editor-scroll'], 96);
  assert.equal(scopeState(currentReviewTask(restored).state).pr.id, '104');
});

test('审查或文件读取中不能关闭仓库，失败保持当前上下文不变', () => {
  const workspace = createWorkspaceState();
  addRepositories(workspace, ['checkout']);
  const task = loadRepositoryTarget(workspace, 'checkout', 'pr:104');
  for (const status of ['running', 'reading']) {
    task.state.runStatus = status === 'running' ? 'running' : 'idle';
    task.state.sourceReview.readingFile = status === 'reading';
    const before = JSON.stringify(workspace);
    assert.throws(() => closeRepository(workspace, 'checkout'), /先结束审查或文件读取/);
    assert.equal(JSON.stringify(workspace), before);
  }
  assert.throws(() => closeRepository(workspace, 'missing'), /不在当前工作区/);
});

test('同名GitHub与本地Repo分别保留上下文，本地无需远程授权即可加载分支', () => {
  const workspace = createWorkspaceState();
  addRepositories(workspace, ['checkout', 'local-checkout']);
  openRepository(workspace, 'checkout');
  const remote = loadRepositoryTarget(workspace, 'checkout', 'pr:104');
  const sourceId = sources.addManualSource(remote.state, '远程要求', '仅用于远程仓库。', 'requirement');
  remote.state.notes = '远程审查进度';
  openRepository(workspace, 'local-checkout');
  assert.equal(currentReviewTask(workspace), null);
  const local = loadRepositoryTarget(workspace, 'local-checkout', 'branch:feat/payment-timeout');
  assert.equal(scopeState(local.state).repository.source, 'local');
  assert.equal(scopeState(local.state).repository.path, 'C:\\demo\\checkout-service');
  assert.equal(scopeState(remote.state).repository.source, 'github');
  assert.equal(scopeState(local.state).files.length, 12);
  assert.equal(fileNavigation(local.state).rows.filter((row) => row.status === 'M').length, 3);
  assert.ok(!local.state.sources.some((source) => source.id === sourceId));
  local.state.notes = '本地审查进度';
  const before = JSON.stringify(local.state);
  assert.throws(() => loadRepositoryTarget(workspace, 'local-checkout', 'pr:104'), /未替换已有代码/);
  assert.equal(JSON.stringify(local.state), before);
  addRepositories(workspace, ['checkout', 'local-checkout']);
  assert.deepEqual(workspace.openRepositories, ['checkout', 'local-checkout']);
  openRepository(workspace, 'checkout');
  assert.equal(currentReviewTask(workspace), remote);
  assert.equal(remote.state.notes, '远程审查进度');
  assert.equal(local.state.notes, '本地审查进度');
});

test('新增本地来源不破坏旧工作区存档，恢复时两来源仍独立', () => {
  const workspace = createWorkspaceState();
  const remote = createReviewTask(workspace, 'checkout');
  remote.state.notes = '旧存档的内容';
  delete workspace.repositoryMaterials['local-checkout'];
  delete workspace.repositoryMaterials['local-sandbox'];
  const restored = parseWorkspace(JSON.stringify(workspace));
  assert.equal(currentReviewTask(restored).state.notes, '旧存档的内容');
  assert.deepEqual(restored.openRepositories, ['checkout']);
  assert.equal(restored.repositoryMaterials['local-checkout'][0].purpose, 'context');
  addRepositories(restored, ['local-checkout']);
  openRepository(restored, 'local-checkout');
  const local = loadRepositoryTarget(restored, 'local-checkout', 'branch:main');
  local.state.notes = '本地内容';
  const reopened = parseWorkspace(JSON.stringify(restored));
  assert.equal(currentReviewTask(reopened).state.notes, '本地内容');
  openRepository(reopened, 'checkout');
  assert.equal(currentReviewTask(reopened).state.notes, '旧存档的内容');
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
