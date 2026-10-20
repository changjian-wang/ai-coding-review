const test = require('node:test');
const assert = require('node:assert/strict');
const sources = require('./sources.js');
const demo = require('./app.js');
const {
  createCenterState, sourceFiles, completeReview, approvalGate, confirmBaseline,
  submitVerdict, summaryText, switchMode,
} = require('./center.js');

function organizeAndConfirm(state) {
  sources.organize(state);
  state.sourceReview.acknowledged = true;
  confirmBaseline(state);
}

test('默认依据来自两份本地材料，PR与Issue均未擅自读入', () => {
  const state = createCenterState();
  assert.deepEqual(sources.selectedSources(state).map((item) => item.id), ['payments', 'orders']);
  assert.equal(sources.getSource(state, 'pr-description').purpose, 'context');
  assert.equal(sources.getSource(state, 'pr-description').selected, false);
});

test('每条初始需求都能引用原文版本、行号和逐字片段', () => {
  const state = createCenterState();
  for (const item of state.requirements) {
    assert.ok(item.origins.length > 0);
    for (const origin of item.origins) {
      assert.equal(sources.originStatus(state, origin), '当前版本');
      assert.equal(origin.quote, item.text);
      assert.match(sources.labelOrigin(state, origin), /:L\d+ · v1/);
    }
  }
});

test('选入PR描述默认只增加上下文，不把改动摘要反推为需求', () => {
  const state = createCenterState();
  sources.selectSource(state, 'pr-description', true);
  const draft = sources.organize(state);
  assert.equal(draft.candidates.length, 4);
  assert.ok(draft.candidates.every((item) => item.origins.every((origin) => origin.sourceId !== 'pr-description')));
  assert.equal(state.baselineConfirmed, false);
  assert.equal(state.stale, true);
});

test('PR被显式用作候选依据后，重复验收说明合并出处而不重复造规则', () => {
  const state = createCenterState();
  sources.selectSource(state, 'pr-description', true);
  sources.setPurpose(state, 'pr-description', 'requirement');
  const draft = sources.organize(state);
  assert.equal(draft.candidates.length, 4);
  const candidate = draft.candidates.find((item) => item.id === 'RQ-03');
  assert.equal(candidate.origins.length, 2);
  assert.deepEqual(candidate.origins.map((origin) => origin.sourceId), ['orders', 'pr-description']);
  assert.ok(draft.candidates.every((item) => !item.text.includes('根据实现整理')));
});

test('只剩PR变更上下文时没有候选，不得确认空需求基线', () => {
  const state = createCenterState('fresh');
  sources.selectSource(state, 'payments', false);
  sources.selectSource(state, 'orders', false);
  sources.selectSource(state, 'pr-description', true);
  assert.equal(sources.organize(state).candidates.length, 0);
  state.sourceReview.acknowledged = true;
  assert.throws(() => confirmBaseline(state), /没有可确认的需求/);
});

test('整理候选不是确认，确认必须有明确的人工核对动作', () => {
  const state = createCenterState('fresh');
  assert.throws(() => confirmBaseline(state), /尚未整理/);
  sources.organize(state);
  assert.equal(state.baselineConfirmed, false);
  assert.throws(() => confirmBaseline(state), /核对原文/);
  state.sourceReview.acknowledged = true;
  confirmBaseline(state);
  assert.equal(state.baselineConfirmed, true);
});

test('相互冲突的原始要求保留双方，确认动作不等于冲突解决', () => {
  const state = createCenterState();
  sources.selectSource(state, 'linked-issue', true);
  organizeAndConfirm(state);
  assert.equal(state.requirements.length, 5);
  assert.equal(state.sourceReview.conflicts.length, 1);
  assert.ok(state.requirements.find((item) => item.id === 'RQ-02'));
  assert.ok(state.requirements.find((item) => item.id === 'RQ-05'));
  completeReview(state);
  assert.equal(approvalGate(state).eligible, false);
  assert.ok(approvalGate(state).critical.some((item) => item.id === 'SC-01'));
  state.humanConfirmed = true;
  assert.throws(() => submitVerdict(state, 'approve'), /来源/);
  assert.match(summaryText(state), /SC-01/);
});

test('候选排除需要理由，保留可导出的处置记录', () => {
  const state = createCenterState();
  sources.selectSource(state, 'linked-issue', true);
  sources.organize(state);
  sources.updateCandidate(state, 'RQ-05', false);
  state.sourceReview.acknowledged = true;
  assert.throws(() => confirmBaseline(state), /排除原因/);
  sources.updateCandidate(state, 'RQ-05', false, '该材料属于后续版本，本次只验证当前已确认范围。');
  state.sourceReview.acknowledged = true;
  confirmBaseline(state);
  assert.equal(state.sourceReview.conflicts.length, 0);
  assert.equal(state.sourceReview.excluded[0].id, 'RQ-05');
  assert.match(summaryText(state), /后续版本/);
  assert.equal(approvalGate(state).critical.length, 2);
});

test('更新来源版本保留旧原文，旧引用标为过期且不能直接确认', () => {
  const state = createCenterState('ready');
  state.humanConfirmed = true;
  submitVerdict(state, 'approve');
  const origin = state.requirements.find((item) => item.id === 'RQ-02').origins[0];
  const original = sources.snapshot(sources.getSource(state, 'payments')).text;
  sources.updateSource(state, 'payments', `${original}\n人工编辑的新背景。`);
  assert.equal(state.submission, null);
  assert.equal(state.stale, true);
  assert.equal(sources.originStatus(state, origin), '原文已更新');
  assert.equal(sources.snapshot(sources.getSource(state, 'payments'), 1).text, original);
  assert.throws(() => confirmBaseline(state), /尚未整理/);
  const draft = sources.organize(state);
  assert.ok(draft.notices[0].includes('不能沿用旧提取'));
  assert.ok(draft.removed.includes('RQ-02'));
});

test('尚未选入且不被引用的快照更新，不使当前基线失效', () => {
  const state = createCenterState();
  sources.updateSource(state, 'design', '新的未纳入的设计背景。');
  assert.equal(state.baselineConfirmed, true);
  assert.equal(state.stale, false);
});

test('条目修订不覆盖需求原文，也不改变引用时的逐字片段', () => {
  const state = createCenterState();
  const raw = sources.getSource(state, 'payments').text;
  const quote = state.requirements.find((item) => item.id === 'RQ-02').origins[0].quote;
  demo.reviseRequirement(state, 'RQ-02', demo.revisedRequirement, true);
  assert.equal(sources.getSource(state, 'payments').text, raw);
  assert.equal(state.requirements.find((item) => item.id === 'RQ-02').origins[0].quote, quote);
  assert.ok(sourceFiles(state).payments.paragraphs.some(([, text]) => text === quote));
  assert.ok(!sourceFiles(state).payments.paragraphs.some(([, text]) => text === demo.revisedRequirement));
});

test('仅作背景的人工输入不自动生成规则，明确的人工候选仍需确认', () => {
  const state = createCenterState();
  sources.addManualSource(state, '背景说明', '这是一段业务背景。', 'context');
  assert.equal(sources.organize(state).candidates.length, 4);
  sources.addManualSource(state, '人工定义的约束', '某业务操作必须满足人工明确给出的前提。', 'requirement');
  const draft = sources.organize(state);
  const manual = draft.candidates.find((item) => item.originKind === '人工输入');
  assert.ok(manual);
  assert.equal(manual.text, '某业务操作必须满足人工明确给出的前提。');
  assert.equal(state.baselineConfirmed, false);
  state.sourceReview.acknowledged = true;
  confirmBaseline(state);
  completeReview(state);
  assert.equal(state.runStatus, 'partial');
  assert.equal(approvalGate(state).eligible, false);
  assert.match(summaryText(state), /没有真实语义评审|未语义评审|尚未语义评审/);
});

test('移出来源保留历史引用，但不允许旧出处继续证明当前基线', () => {
  const state = createCenterState();
  const origin = state.requirements.find((item) => item.id === 'RQ-03').origins[0];
  sources.selectSource(state, 'orders', false);
  assert.equal(sources.originStatus(state, origin), '来源已移出');
  assert.equal(state.requirements.length, 4);
  organizeAndConfirm(state);
  assert.equal(state.requirements.length, 3);
  completeReview(state);
  assert.equal(approvalGate(state).eligible, false);
  assert.equal(state.sourceReview.previousBaseline.length, 4);
});

test('未知来源、无效用途和空原文显式报错', () => {
  const state = createCenterState();
  assert.throws(() => sources.getSource(state, 'missing'), /找不到/);
  assert.throws(() => sources.setPurpose(state, 'payments', 'invalid'), /未知/);
  assert.throws(() => sources.updateSource(state, 'payments', ' '), /不能为空/);
  assert.throws(() => sources.addManualSource(state, '', '内容', 'context'), /不能为空/);
  assert.throws(() => sources.snapshot(sources.getSource(state, 'payments'), 999), /找不到引用/);
});

test('人工上下文只有经显式改用途才成为人工候选，原文仍保持一致', () => {
  const state = createCenterState();
  const id = sources.addManualSource(state, '人工业务规则', '原文中的一条明确规则。', 'context');
  assert.equal(sources.organize(state).candidates.length, 4);
  sources.setPurpose(state, id, 'requirement');
  let draft = sources.organize(state);
  assert.equal(draft.candidates.length, 5);
  sources.updateSource(state, id, '人工修订后的明确规则。');
  draft = sources.organize(state);
  const candidate = draft.candidates.find((item) => item.originKind === '人工输入');
  assert.equal(candidate.text, '人工修订后的明确规则。');
  assert.equal(candidate.origins[0].version, 2);
});

test('首次准备缺少需求时可选技术审查，不生成未提供的需求缺陷', () => {
  const state = createCenterState('fresh');
  sources.selectSource(state, 'payments', false);
  sources.selectSource(state, 'orders', false);
  sources.organize(state);
  switchMode(state, 'technical');
  completeReview(state);
  assert.ok(state.findings.every((finding) => finding.requirement === null));
  assert.equal(approvalGate(state).critical.length, 0);
  assert.match(summaryText(state), /需求一致性未评审/);
});

test('即使人工材料仅作上下文，也不能假装已完成对其语义的评审', () => {
  const state = createCenterState('ready');
  sources.addManualSource(state, '新的关键背景', '这段输入可能改变旧保障的适用条件。', 'context');
  organizeAndConfirm(state);
  assert.equal(state.requirements.length, 4);
  completeReview(state);
  assert.equal(state.runStatus, 'partial');
  assert.equal(approvalGate(state).eligible, false);
  state.humanConfirmed = true;
  assert.throws(() => submitVerdict(state, 'approve'), /来源/);
});
