const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createState, approvalGate, recordComment, reviseRequirement, confirmBaseline,
  attachEvidence, markFixed, finishRun, submitVerdict, revisedRequirement,
} = require('./app.js');

test('默认场景包含需求矛盾和关键前提，不允许批准但允许反馈', () => {
  const state = createState();
  assert.equal(approvalGate(state).eligible, false);
  assert.equal(approvalGate(state).critical.length, 2);
  assert.equal(approvalGate(state).feedbackAllowed, true);
});

test('评论只改变处置，不解除关键阻断', () => {
  const state = createState();
  recordComment(state, 'F-01', '需要澄清超时状态。');
  recordComment(state, 'F-03', '请补充幂等键约束。');
  assert.equal(approvalGate(state).critical.length, 2);
  assert.equal(state.findings[0].disposition, 'commented');
  assert.equal(state.findings[0].resolved, false);
});

test('需求修订使基线待确认、结果过期，不能直接解除矛盾', () => {
  const state = createState();
  reviseRequirement(state, 'RQ-02', revisedRequirement, true);
  assert.equal(state.baselineConfirmed, false);
  assert.equal(state.stale, true);
  assert.equal(approvalGate(state).critical.length, 2);
  assert.equal(approvalGate(state).feedbackAllowed, false);
  assert.throws(() => finishRun(state), /确认需求基线/);
  confirmBaseline(state);
  assert.equal(state.baselineVersion, 2);
  assert.equal(state.stale, true);
  finishRun(state);
  assert.equal(approvalGate(state).critical.length, 1);
});

test('自定义文本不被原型假装理解，不自动进入预设的已解决分支', () => {
  const state = createState();
  reviseRequirement(state, 'RQ-02', '任意输入，不应被当作已分析。');
  confirmBaseline(state);
  finishRun(state);
  assert.equal(state.findings.find((finding) => finding.id === 'F-01').resolved, false);
});

test('即使 preset 为真，非预设文本也不会伪造需求修订裁决', () => {
  const state = createState();
  reviseRequirement(state, 'RQ-02', '另一个需求。', true);
  confirmBaseline(state);
  finishRun(state);
  assert.equal(approvalGate(state).critical.length, 2);
});

test('补充证据后仍需重审，不能立即解除必要前提', () => {
  const state = createState();
  attachEvidence(state, '示例稳定事件键与唯一约束。');
  assert.equal(state.stale, true);
  assert.equal(approvalGate(state).critical.length, 2);
  finishRun(state);
  assert.equal(approvalGate(state).critical.length, 1);
});

test('完整示例路径需要修订需求、补证据、处置实现问题及人工确认', () => {
  const state = createState();
  reviseRequirement(state, 'RQ-02', revisedRequirement, true);
  confirmBaseline(state);
  attachEvidence(state, '示例契约 v2。');
  finishRun(state);
  assert.equal(approvalGate(state).eligible, false);
  markFixed(state, 'F-02', '人工在示例中确认恢复路径预留库存。');
  assert.equal(approvalGate(state).eligible, true);
  assert.throws(() => submitVerdict(state, 'approve'), /人工确认/);
  state.humanConfirmed = true;
  submitVerdict(state, 'approve');
  assert.equal(state.submission.verdict, 'approve');
});

test('有限技术审查没有需求条目，不引入虚假的需求阻断', () => {
  const state = createState('technical');
  assert.equal(state.mode, 'technical');
  assert.deepEqual(state.requirements, []);
  assert.equal(approvalGate(state).critical.length, 0);
  markFixed(state, 'F-02', '人工处理示例实现缺陷。');
  assert.equal(approvalGate(state).eligible, true);
  state.humanConfirmed = true;
  submitVerdict(state, 'approve');
  assert.equal(state.submission.mode, 'technical');
});

test('部分完成不能批准，但可以评论或要求修改', () => {
  const state = createState('partial');
  assert.equal(approvalGate(state).eligible, false);
  submitVerdict(state, 'comment');
  assert.equal(state.submission.verdict, 'comment');
  submitVerdict(state, 'request-changes');
  assert.equal(state.submission.verdict, 'request-changes');
  assert.equal(approvalGate(state).critical.length, 2);
});

test('就绪场景仍需要人工确认，模型不会自动批准', () => {
  const state = createState('ready');
  assert.equal(approvalGate(state).eligible, true);
  assert.throws(() => submitVerdict(state, 'approve'), /人工确认/);
  assert.equal(state.submission, null);
});

test('尚未开始不能用空发现证明通过或提交有效反馈', () => {
  const state = createState('fresh');
  assert.equal(approvalGate(state).eligible, false);
  assert.equal(approvalGate(state).feedbackAllowed, false);
  assert.throws(() => submitVerdict(state, 'comment'), /有效结果/);
});

test('取消或过期状态不能沿用就绪场景的通过资格', () => {
  const state = createState('ready');
  state.runStatus = 'cancelled';
  assert.equal(approvalGate(state).eligible, false);
  state.runStatus = 'completed';
  state.stale = true;
  state.humanConfirmed = true;
  assert.throws(() => submitVerdict(state, 'approve'), /不能通过/);
});

test('需求问题不能机械标记为代码已修复', () => {
  const state = createState();
  assert.throws(() => markFixed(state, 'F-01', '假装修复。'), /需求问题/);
  assert.equal(approvalGate(state).critical.length, 2);
});

test('空证据、空评论、未知问题与未知结论显式失败', () => {
  const state = createState();
  assert.throws(() => attachEvidence(state, ' '), /证据说明/);
  assert.throws(() => recordComment(state, 'F-01', ' '), /评论内容/);
  assert.throws(() => recordComment(state, 'missing', '说明'), /找不到/);
  assert.throws(() => submitVerdict(state, 'invalid'), /未知/);
});

test('已经模拟批准后再修改需求，旧结论与相关免责不能继续有效', () => {
  const state = createState('ready');
  state.humanConfirmed = true;
  submitVerdict(state, 'approve');
  reviseRequirement(state, 'RQ-02', '再次修改为未经验证的假设。');
  assert.equal(state.submission, null);
  assert.equal(state.humanConfirmed, false);
  assert.equal(state.findings.find((finding) => finding.id === 'F-01').resolved, false);
  confirmBaseline(state);
  finishRun(state);
  assert.equal(approvalGate(state).eligible, false);
});

test('已有模拟结论在证据补充后失效，不能保留绿色通过记录', () => {
  const state = createState('ready');
  state.humanConfirmed = true;
  submitVerdict(state, 'approve');
  attachEvidence(state, '更新后的示例证据。');
  assert.equal(state.submission, null);
  assert.equal(state.stale, true);
  assert.equal(state.humanConfirmed, false);
});

test('有限技术样例不伪造需求编号，以实际返回值契约解释问题', () => {
  const state = createState('technical');
  assert.ok(state.findings.every((finding) => finding.requirement === null));
  const finding = state.findings.find((item) => item.id === 'F-02');
  assert.ok(finding.steps.some((step) => step.includes('空值解引用')));
  assert.ok(finding.impact.includes('业务需求一致性仍未评审'));
});
