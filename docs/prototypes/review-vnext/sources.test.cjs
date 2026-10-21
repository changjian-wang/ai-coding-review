const test = require('node:test');
const assert = require('node:assert/strict');
const sources = require('./sources.js');
const demo = require('./app.js');
const {
  createCenterState, sourceFiles, completeReview, approvalGate, confirmBaseline,
  submitVerdict, summaryText, switchMode,
  prepareForReview, preparationState,
} = require('./center.js');

function preparedFreshState() {
  const state = createCenterState('fresh');
  sources.selectSource(state, 'payments', true);
  sources.selectSource(state, 'orders', true);
  return state;
}

function confirmPrepared(state) {
  state.sourceReview.acknowledged = true;
  confirmBaseline(state);
}

test('默认依据来自两份本地材料，PR与Issue均未擅自读入', () => {
  const state = createCenterState();
  assert.deepEqual(sources.selectedSources(state).map((item) => item.id), ['payments', 'orders']);
  assert.equal(sources.getSource(state, 'pr-description').purpose, 'auto');
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

test('PR混合内容按片段识别：明确验收进入要求，改动摘要不反推为需求', () => {
  const state = createCenterState();
  sources.selectSource(state, 'pr-description', true);
  const draft = state.sourceReview.draft;
  assert.equal(draft.candidates.length, 4);
  assert.equal(draft.candidates.find((item) => item.id === 'RQ-03').origins.length, 2);
  assert.ok(draft.candidates.every((item) => !item.text.includes('根据实现整理')));
  assert.equal(state.baselineConfirmed, false);
  assert.equal(state.stale, true);
});

test('PR被显式用作候选依据后，重复验收说明合并出处而不重复造规则', () => {
  const state = createCenterState();
  sources.selectSource(state, 'pr-description', true);
  sources.setPurpose(state, 'pr-description', 'requirement');
  const draft = state.sourceReview.draft;
  assert.equal(draft.candidates.length, 4);
  const candidate = draft.candidates.find((item) => item.id === 'RQ-03');
  assert.equal(candidate.origins.length, 2);
  assert.deepEqual(candidate.origins.map((origin) => origin.sourceId), ['orders', 'pr-description']);
  assert.ok(draft.candidates.every((item) => !item.text.includes('根据实现整理')));
});

test('只剩事实背景时没有候选，不得确认空需求基线', () => {
  const state = createCenterState('fresh');
  sources.selectSource(state, 'payments', false);
  sources.selectSource(state, 'orders', false);
  sources.selectSource(state, 'design', true);
  assert.equal(state.sourceReview.draft.candidates.length, 0);
  state.sourceReview.acknowledged = true;
  assert.throws(() => confirmBaseline(state), /没有可确认的需求/);
});

test('载入需求后自动整理，不需要额外按钮，但必须明确人工确认', () => {
  const state = preparedFreshState();
  assert.equal(state.sourceReview.draft.candidates.length, 4);
  assert.equal(state.sourceReview.organizedRevision, state.sourceReview.revision);
  assert.equal(sources.confirmationState(state).canAcknowledge, true);
  assert.equal(state.sourceReview.acknowledged, false);
  assert.equal(state.baselineConfirmed, false);
  assert.throws(() => confirmBaseline(state), /核对原文/);
  state.sourceReview.acknowledged = true;
  confirmBaseline(state);
  assert.equal(state.baselineConfirmed, true);
});

test('相互冲突的原始要求保留双方，确认动作不等于冲突解决', () => {
  const state = createCenterState();
  sources.selectSource(state, 'linked-issue', true);
  confirmPrepared(state);
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
  assert.throws(() => confirmBaseline(state), /核对原文/);
  const draft = state.sourceReview.draft;
  assert.equal(state.sourceReview.organizedRevision, state.sourceReview.revision);
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
  assert.equal(state.sourceReview.draft.candidates.length, 4);
  sources.addManualSource(state, '人工定义的约束', '某业务操作必须满足人工明确给出的前提。', 'requirement');
  const draft = state.sourceReview.draft;
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
  confirmPrepared(state);
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
  assert.equal(state.sourceReview.draft.candidates.length, 4);
  sources.setPurpose(state, id, 'requirement');
  let draft = state.sourceReview.draft;
  assert.equal(draft.candidates.length, 5);
  sources.updateSource(state, id, '人工修订后的明确规则。');
  draft = state.sourceReview.draft;
  const candidate = draft.candidates.find((item) => item.originKind === '人工输入');
  assert.equal(candidate.text, '人工修订后的明确规则。');
  assert.equal(candidate.origins[0].version, 2);
});

test('首次准备缺少需求时可选技术审查，不生成未提供的需求缺陷', () => {
  const state = createCenterState('fresh');
  sources.selectSource(state, 'payments', false);
  sources.selectSource(state, 'orders', false);
  switchMode(state, 'technical');
  completeReview(state);
  assert.ok(state.findings.every((finding) => finding.requirement === null));
  assert.equal(approvalGate(state).critical.length, 0);
  assert.match(summaryText(state), /需求一致性未评审/);
});

test('即使人工材料仅作上下文，也不能假装已完成对其语义的评审', () => {
  const state = createCenterState('ready');
  sources.addManualSource(state, '新的关键背景', '这段输入可能改变旧保障的适用条件。', 'context');
  confirmPrepared(state);
  assert.equal(state.requirements.length, 4);
  completeReview(state);
  assert.equal(state.runStatus, 'partial');
  assert.equal(approvalGate(state).eligible, false);
  state.humanConfirmed = true;
  assert.throws(() => submitVerdict(state, 'approve'), /来源/);
});

test('来源变化自动更新条目并清除勾选，旧确认不能复用', () => {
  const state = preparedFreshState();
  state.sourceReview.acknowledged = true;
  sources.selectSource(state, 'linked-issue', true);
  assert.equal(state.sourceReview.draft.candidates.length, 5);
  assert.equal(state.sourceReview.organizedRevision, state.sourceReview.revision);
  assert.equal(state.sourceReview.acknowledged, false);
  assert.equal(sources.confirmationState(state).canAcknowledge, true);
  assert.throws(() => confirmBaseline(state), /核对原文/);
  assert.equal(state.sourceReview.draft.candidates.find((item) => item.id === 'RQ-05').text.includes('结果未知'), true);
});

test('相同的来源和用途不触发更新，也不无故清空已勾选确认', () => {
  const state = preparedFreshState();
  state.sourceReview.acknowledged = true;
  const draft = state.sourceReview.draft;
  sources.selectSource(state, 'payments', true);
  sources.setPurpose(state, 'payments', 'auto');
  assert.equal(state.sourceReview.draft, draft);
  assert.equal(state.sourceReview.acknowledged, true);
});

test('空需求明确给出原因，不留下无法解释的禁用条件', () => {
  const state = createCenterState('fresh');
  sources.selectSource(state, 'payments', false);
  sources.selectSource(state, 'orders', false);
  sources.selectSource(state, 'design', true);
  const readiness = sources.confirmationState(state);
  assert.equal(readiness.canAcknowledge, false);
  assert.equal(readiness.reason, 'empty');
  assert.match(readiness.message, /没有可确认的需求/);
  assert.match(readiness.message, /有限技术审查/);
});

test('排除原因即填即生效，但恢复可勾选不代表自动确认', () => {
  const state = preparedFreshState();
  sources.updateCandidate(state, 'RQ-01', false);
  assert.equal(sources.confirmationState(state).canAcknowledge, false);
  assert.equal(sources.confirmationState(state).reason, 'exclusion');
  assert.match(sources.confirmationState(state).message, /RQ-01.*排除原因/);
  sources.updateCandidate(state, 'RQ-01', false, '该规则不属于当前演示范围，记录人工排除。');
  assert.equal(sources.confirmationState(state).canAcknowledge, true);
  assert.equal(state.sourceReview.acknowledged, false);
  assert.throws(() => confirmBaseline(state), /核对原文/);
});

test('自动条目未就绪或出处不匹配时，底层同样阻止确认', () => {
  const state = preparedFreshState();
  state.sourceReview.organizedRevision = -1;
  state.sourceReview.acknowledged = true;
  assert.equal(sources.confirmationState(state).reason, 'not-ready');
  assert.throws(() => confirmBaseline(state), /尚未就绪/);
  state.sourceReview.organizedRevision = state.sourceReview.revision;
  state.sourceReview.draft.candidates[0].origins[0].quote = '不是引用时的逐字原文';
  assert.equal(sources.confirmationState(state).reason, 'origins');
  assert.throws(() => confirmBaseline(state), /旧引用/);
});

test('有限技术审查不误确认需求，改选需求依据后可直接核对', () => {
  const state = createCenterState('technical');
  sources.selectSource(state, 'payments', true);
  assert.equal(state.sourceReview.draft.candidates.length, 3);
  assert.equal(sources.confirmationState(state).reason, 'technical');
  assert.throws(() => confirmBaseline(state), /有限技术审查/);
  switchMode(state, 'requirements');
  assert.equal(sources.confirmationState(state).canAcknowledge, true);
  assert.equal(state.baselineConfirmed, false);
});

test('粘贴、本地文件与演示链接使用相同原文映射和确认流程', () => {
  for (const method of ['paste', 'file', 'link']) {
    const state = createCenterState('fresh');
    const example = sources.exampleMaterial(state);
    const id = method === 'paste' ? sources.addManualSource(state, example.name, example.text, 'auto')
      : method === 'file' ? sources.addFileSource(state, 'review.MD', example.text)
        : sources.addLinkSource(state, sources.exampleLink);
    const source = sources.getSource(state, id);
    assert.equal(source.text, example.text);
    assert.equal(source.demoRecognized, true);
    assert.equal(sources.needsAnalysis(source), false);
    const preparation = preparationState(state);
    assert.equal(preparation.requirements.length, 4);
    assert.equal(preparation.needsConfirmation, true);
    assert.ok(preparation.requirements.every((item) => item.origins.every((origin) => origin.sourceId === id && sources.originStatus(state, origin) === '当前版本')));
    assert.throws(() => prepareForReview(state), /明确确认/);
    prepareForReview(state, true);
    completeReview(state);
    assert.equal(state.sourceReview.limited, false);
    assert.equal(state.runStatus, 'completed');
    assert.equal(approvalGate(state).critical.length, 2);
  }
});

test('任意本地Markdown保留首尾空白与CRLF，不伪造AI提取或需求通过', () => {
  const state = createCenterState('fresh');
  const text = '\r\n# 用户提供的业务说明\r\n\r\n- **响应及时**\r\n\r\n';
  const id = sources.addFileSource(state, 'business.md', text);
  const source = sources.getSource(state, id);
  assert.equal(source.kind, 'local');
  assert.equal(source.userProvided, true);
  assert.equal(source.text, text);
  assert.equal(sources.snapshot(source).text, text);
  assert.equal(sources.needsAnalysis(source), true);
  assert.equal(preparationState(state).requirements.length, 0);
  assert.match(preparationState(state).notices[0], /未从自由文本提取.*未连接模型/);
  prepareForReview(state);
  completeReview(state);
  assert.equal(state.mode, 'technical');
  assert.equal(state.runStatus, 'partial');
  assert.equal(approvalGate(state).eligible, false);
  assert.match(summaryText(state), /需求一致性未评审/);
  assert.equal(sourceFiles(state)[id].userProvided, true);
});

test('自定义链接、危险协议及含凭据链接失败，不产生伪读取来源', () => {
  const state = createCenterState('fresh');
  const before = state.sources.length;
  const revision = state.sourceReview.revision;
  for (const address of ['不是链接', 'https://example.com/private-requirement', 'javascript:alert(1)', 'file:///C:/private.md', 'https://user:password@requirements.example/checkout/review']) {
    assert.throws(() => sources.addLinkSource(state, address), /HTTP|未联网/);
  }
  assert.equal(state.sources.length, before);
  assert.equal(state.sourceReview.revision, revision);
});

test('空、本地不支持格式和含二进制内容均显式失败，不进入候选', () => {
  const state = createCenterState('fresh');
  const before = state.sources.length;
  assert.throws(() => sources.addFileSource(state, 'requirement.pdf', 'PDF'), /仅支持.*Word/);
  assert.throws(() => sources.addFileSource(state, 'requirement.txt', ' \n'), /不能为空/);
  assert.throws(() => sources.addFileSource(state, 'requirement.md', 'a\0b'), /二进制/);
  assert.throws(() => sources.addFileSource(state, 'requirement.md', null), /不能为空/);
  assert.equal(state.sources.length, before);
  assert.equal(preparationState(state).requirements.length, 0);
});

test('已识别演示文件变更后原文留版本，不继续套用旧映射', () => {
  const state = createCenterState('fresh');
  const example = sources.exampleMaterial(state);
  const id = sources.addFileSource(state, 'review.md', example.text);
  prepareForReview(state, true);
  const origin = state.requirements[0].origins[0];
  sources.updateSource(state, id, `${example.text}\n新增了尚未分析的约束。`);
  assert.equal(sources.snapshot(sources.getSource(state, id), 1).text, example.text);
  assert.equal(sources.originStatus(state, origin), '原文已更新');
  assert.equal(sources.needsAnalysis(sources.getSource(state, id)), true);
  assert.equal(preparationState(state).requirements.length, 0);
  assert.ok(preparationState(state).notices.some((notice) => notice.includes('不能沿用旧提取')));
});
