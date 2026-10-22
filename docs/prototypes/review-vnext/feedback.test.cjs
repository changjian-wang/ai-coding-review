const test = require('node:test');
const assert = require('node:assert/strict');
const feedback = require('./feedback.js');
const sources = require('./sources.js');
const {
  createCenterState, applySampleFix, undoSampleFix, changeScope, linkFeedbackPr, selectFeedback,
  importFeedbackRequirement, preparationState, syncFeedbackContext, approvalGate,
  summaryText,
} = require('./center.js');

function readyState() {
  const state = createCenterState();
  feedback.assessAll(state);
  applySampleFix(state, 'F-02');
  feedback.recordVerification(state, 'R-01', true);
  feedback.recordDelivery(state, 'R-01');
  return state;
}

function post(state, id = 'R-01', options = {}) {
  const draft = feedback.makeDraft(state, id);
  return feedback.publish(state, id, { expectedDraftId: draft.id, confirmed: true, ...options });
}

test('所选PR自动载入完整演示会话，三种评论类型和原始ID独立保留', () => {
  const state = createCenterState();
  const current = feedback.session(state);
  assert.equal(current.context.prId, '104');
  assert.equal(current.items.length, 7);
  assert.equal(current.items.filter((item) => item.kind === 'thread').length, 5);
  assert.equal(feedback.get(state, 'R-01').comments.length, 3);
  assert.notEqual(feedback.get(state, 'R-01').remoteId, feedback.get(state, 'R-01').rootCommentId);
  assert.equal(feedback.get(state, 'R-05').isResolved, null);
  assert.equal(feedback.get(state, 'R-06').kind, 'review');
});

test('分支不猜测关联PR，显式关联不改变代码范围，换仓库后不沿用', () => {
  const state = createCenterState();
  changeScope(state, { kind: 'branch' });
  assert.equal(feedback.session(state), null);
  const selection = JSON.stringify(state.scopeReview.selection);
  assert.throws(() => linkFeedbackPr(state, '105'), /head 分支匹配/);
  linkFeedbackPr(state, '104');
  assert.equal(feedback.session(state).context.prId, '104');
  assert.equal(JSON.stringify(state.scopeReview.selection), selection);
  changeScope(state, { base: 'release/2026.10' });
  assert.equal(feedback.session(state).context.prId, '104');
  changeScope(state, { repository: 'sandbox' });
  assert.equal(feedback.session(state), null);
  linkFeedbackPr(state, '207');
  assert.equal(feedback.session(state).context.repositoryId, 'sandbox');
});

test('分析区分修复、解释、澄清和需求建议，不自动改代码或确认需求', () => {
  const state = createCenterState('fresh');
  assert.equal(feedback.assessAll(state), 7);
  assert.equal(feedback.get(state, 'R-01').local.analysis.decision, 'fix');
  assert.equal(feedback.get(state, 'R-02').local.analysis.decision, 'explain');
  assert.equal(feedback.get(state, 'R-03').local.analysis.decision, 'clarify');
  assert.equal(feedback.get(state, 'R-04').local.analysis.decision, 'requirement');
  assert.deepEqual(state.center.patches, {});
  assert.equal(state.requirements.length, 0);
  assert.equal(state.baselineConfirmed, false);
});

test('需要修复时不能把未修改、未验证或未推送当作已解决', () => {
  const state = createCenterState();
  feedback.assess(state, 'R-01');
  assert.throws(() => feedback.recordVerification(state, 'R-01', true), /先审阅并应用/);
  assert.throws(() => feedback.recordDelivery(state, 'R-01'), /尚无有效验证/);
  assert.throws(() => feedback.makeDraft(state, 'R-01'), /尚未完成/);
  const draft = feedback.makeDraft(state, 'R-01', 'progress');
  assert.equal(feedback.readiness(state, 'R-01').canResolve, false);
  assert.throws(() => feedback.publish(state, 'R-01', { expectedDraftId: draft.id, confirmed: true, resolve: true }), /未完成|进度说明/);
});

test('修复验证推送后按原始会话发布并解决，不改变Review总体状态或其他会话', () => {
  const state = readyState();
  const item = feedback.get(state, 'R-01');
  const original = item.comments.map((comment) => ({ ...comment }));
  const result = post(state, 'R-01', { resolve: true });
  assert.equal(result.status, 'resolved');
  assert.equal(item.isResolved, true);
  assert.equal(item.comments.at(-1).replyTo, item.rootCommentId);
  assert.deepEqual(item.comments.slice(0, original.length), original);
  assert.equal(feedback.get(state, 'R-07').isResolved, false);
  assert.equal(feedback.session(state).reviewState, 'CHANGES_REQUESTED');
  assert.equal(approvalGate(state).eligible, false);
});

test('同根因只需一次修复验证和演示推送，批量发布仍逐会话记录部分失败', () => {
  const state = readyState();
  assert.equal(feedback.readyFixes(state).length, 2);
  assert.equal(feedback.get(state, 'R-01').local.delivery.commit, feedback.get(state, 'R-07').local.delivery.commit);
  const entries = ['R-01', 'R-07'].map((id) => ({
    id, expectedDraftId: feedback.makeDraft(state, id).id, confirmed: true, resolve: true,
    outcome: id === 'R-01' ? 'success' : 'resolve-failed',
  }));
  const result = feedback.publishBatch(state, entries);
  assert.equal(result[0].status, 'resolved');
  assert.equal(result[1].status, 'failed');
  assert.match(result[1].message, /回复已模拟发布/);
  assert.equal(feedback.readyFixes(state).length, 0);
  const count = feedback.get(state, 'R-07').comments.length;
  feedback.retryResolve(state, 'R-07');
  assert.equal(feedback.get(state, 'R-07').comments.length, count);
  assert.equal(feedback.get(state, 'R-07').isResolved, true);
});

test('回复发布失败不产生回复或Resolve，可明确重新发送', () => {
  const state = readyState();
  const item = feedback.get(state, 'R-01');
  const count = item.comments.length;
  const draft = feedback.makeDraft(state, item.id);
  assert.throws(() => feedback.publish(state, item.id, { expectedDraftId: draft.id, confirmed: true, resolve: true, outcome: 'reply-failed' }), /发布失败/);
  assert.equal(item.comments.length, count);
  assert.equal(item.isResolved, false);
  feedback.publish(state, item.id, { expectedDraftId: draft.id, confirmed: true });
  assert.equal(item.comments.length, count + 1);
});

for (const outcome of ['pending', 'unknown']) {
  test(`${outcome}不能伪装发布成功，不盲目重试；核对后仅继续Resolve`, () => {
    const state = readyState();
    const item = feedback.get(state, 'R-01');
    const count = item.comments.length;
    const result = post(state, item.id, { resolve: true, outcome });
    assert.equal(result.status, outcome);
    assert.equal(item.comments.length, count);
    assert.equal(item.isResolved, false);
    assert.equal(feedback.readiness(state, item.id).canGenerate, false);
    assert.throws(() => feedback.makeDraft(state, item.id), /核对上次发布结果/);
    feedback.checkPublication(state, item.id, 'pending');
    assert.equal(item.comments.length, count);
    feedback.checkPublication(state, item.id, 'published');
    assert.equal(item.comments.length, count + 1);
    assert.equal(item.isResolved, false);
    feedback.retryResolve(state, item.id);
    assert.equal(item.comments.length, count + 1);
    assert.equal(item.isResolved, true);
  });
}

test('明确回读未发布后才允许重新预览，而不是自动重发', () => {
  const state = readyState();
  post(state, 'R-01', { outcome: 'unknown' });
  const count = feedback.get(state, 'R-01').comments.length;
  feedback.checkPublication(state, 'R-01', 'not-published');
  assert.equal(feedback.get(state, 'R-01').comments.length, count);
  assert.equal(feedback.readiness(state, 'R-01').canGenerate, true);
  post(state);
  assert.equal(feedback.get(state, 'R-01').comments.length, count + 1);
});

test('普通评论和Review总体意见使用引用回复，没有伪造thread Resolve', () => {
  const state = createCenterState();
  feedback.assessAll(state);
  for (const id of ['R-05', 'R-06']) {
    const item = feedback.get(state, id);
    assert.equal(feedback.readiness(state, id).canResolve, false);
    const draft = feedback.makeDraft(state, id);
    assert.throws(() => feedback.publish(state, id, { expectedDraftId: draft.id, confirmed: true, resolve: true }), /没有同样的 Resolve/);
    feedback.publish(state, id, { expectedDraftId: draft.id, confirmed: true });
    assert.equal(item.isResolved, null);
    assert.equal(item.comments.at(-1).replyTo, null);
    assert.equal(item.comments.at(-1).quotedCommentId, item.rootCommentId);
    assert.equal(item.local.handled, true);
  }
  assert.equal(feedback.session(state).reviewState, 'CHANGES_REQUESTED');
});

test('解释和澄清默认只回复，不将局部意见盲目改为代码修复或直接关闭', () => {
  const state = createCenterState();
  feedback.assessAll(state);
  for (const id of ['R-02', 'R-03', 'R-04']) {
    const draft = feedback.makeDraft(state, id);
    assert.throws(() => feedback.publish(state, id, { expectedDraftId: draft.id, confirmed: true, resolve: true }), /等待 Reviewer|权限/);
    feedback.publish(state, id, { expectedDraftId: draft.id, confirmed: true });
    assert.equal(feedback.get(state, id).isResolved, false);
    assert.match(feedback.status(state, feedback.get(state, id)), /等待复核/);
  }
  assert.deepEqual(state.center.patches, {});
});

test('缓存反馈使用展示消费者与业务决策证据，不套用重试解释模板', () => {
  const state = createCenterState('fresh');
  changeScope(state, { pr: '105' });
  feedback.assess(state, 'R-01');
  const item = feedback.get(state, 'R-01');
  assert.deepEqual(item.related, ['decision', 'submit']);
  assert.match(item.local.analysis.message, /缓存只用于展示/);
  const draft = feedback.makeDraft(state, item.id);
  assert.match(draft.body, /展示缓存|扣款资格/);
  assert.doesNotMatch(draft.body, /调度|重试/);
});

test('可更新本工具自己的回复，不追加重复消息或改写同账号的人工回复', () => {
  const state = readyState();
  const item = feedback.get(state, 'R-01');
  const human = item.comments.find((comment) => comment.id.endsWith('-human'));
  const humanBody = human.body;
  post(state);
  const count = item.comments.length;
  const own = feedback.ownReply(state, item);
  const draft = feedback.makeDraft(state, item.id);
  assert.equal(draft.mode, 'update');
  feedback.editDraft(state, item.id, '**补充当前修复与验证边界**', 'update');
  feedback.publish(state, item.id, { expectedDraftId: draft.id, confirmed: true });
  assert.equal(item.comments.length, count);
  assert.equal(feedback.ownReply(state, item).id, own.id);
  assert.match(own.body, /补充当前/);
  assert.equal(human.body, humanBody);
  assert.equal(own.edits.length, 1);
  const forged = feedback.makeDraft(state, item.id);
  forged.replyId = human.id;
  const previousOperation = JSON.stringify(item.local.operation);
  assert.throws(() => feedback.publish(state, item.id, { expectedDraftId: forged.id, confirmed: true }), /不能改写/);
  assert.equal(human.body, humanBody);
  assert.equal(JSON.stringify(item.local.operation), previousOperation);
});

test('权限按会话检查，无权限可回复但不Resolve，恢复权限后仅重试解决', () => {
  const state = readyState();
  feedback.setResolvePermission(state, 'R-01', false);
  assert.equal(feedback.readiness(state, 'R-01').canResolve, false);
  post(state);
  const count = feedback.get(state, 'R-01').comments.length;
  assert.throws(() => feedback.retryResolve(state, 'R-01'), /权限/);
  feedback.setResolvePermission(state, 'R-01', true);
  feedback.retryResolve(state, 'R-01');
  assert.equal(feedback.get(state, 'R-01').comments.length, count);
});

test('Outdated不等于Resolved，原Diff保留，关闭和重新打开均为明确动作', () => {
  const state = readyState();
  const item = feedback.get(state, 'R-01');
  const original = item.originalDiff;
  assert.equal(item.isOutdated, true);
  assert.equal(item.isResolved, false);
  post(state, item.id, { resolve: true });
  assert.equal(item.originalDiff, original);
  assert.equal(item.isOutdated, true);
  feedback.reopen(state, item.id);
  assert.equal(item.isResolved, false);
  assert.equal(item.comments.filter((comment) => comment.isToolReply).length, 1);
});

test('新回复使旧分析、验证和草稿失效，不自动改变远端Resolve状态', () => {
  const state = readyState();
  const draft = feedback.makeDraft(state, 'R-01');
  feedback.receiveComment(state, 'R-01');
  assert.equal(feedback.readiness(state, 'R-01').canPublish, false);
  assert.throws(() => feedback.publish(state, 'R-01', { expectedDraftId: draft.id, confirmed: true, resolve: true }), /讨论已变化|旧|快照/);
  feedback.assess(state, 'R-01');
  assert.equal(feedback.readiness(state, 'R-01').proofReady, false);
  const other = readyState();
  post(other, 'R-01', { resolve: true });
  other.humanConfirmed = true;
  other.submission = { verdict: 'comment' };
  feedback.receiveComment(other, 'R-01');
  assert.equal(feedback.get(other, 'R-01').isResolved, true);
  assert.match(feedback.status(other, feedback.get(other, 'R-01')), /有新回复/);
  assert.equal(other.humanConfirmed, false);
  assert.equal(other.submission, null);
});

test('撤销补丁或需求变更后旧验证推送失效，不能继续发布已修复回复', () => {
  const state = readyState();
  const draft = feedback.makeDraft(state, 'R-01');
  undoSampleFix(state, 'F-02');
  assert.equal(feedback.readiness(state, 'R-01').canPublish, false);
  assert.throws(() => feedback.publish(state, 'R-01', { expectedDraftId: draft.id, confirmed: true }), /过期|尚未验证/);
  sources.addManualSource(state, '新的背景', '这段内容尚未分析。', 'auto');
  assert.equal(feedback.readiness(state, 'R-01').analyzed, false);
});

test('切换PR后不串回复，已经模拟发布/解决的远端状态不会被清空', () => {
  const state = readyState();
  const first = post(state, 'R-01', { resolve: true });
  const before = feedback.get(state, 'R-01').remoteId;
  changeScope(state, { pr: '105' });
  assert.notEqual(feedback.get(state, 'R-01').remoteId, before);
  assert.throws(() => feedback.publish(state, 'R-01', { expectedDraftId: first.draftId, confirmed: true }), /目标或预览/);
  changeScope(state, { pr: '104' });
  assert.equal(feedback.get(state, 'R-01').remoteId, before);
  assert.equal(feedback.get(state, 'R-01').isResolved, true);
  assert.equal(feedback.get(state, 'R-01').comments.at(-1).id, first.replyId);
});

test('新代码快照保留讨论，但旧草稿和验证不再适用于新head', () => {
  const state = readyState();
  const draft = feedback.makeDraft(state, 'R-01');
  const count = feedback.get(state, 'R-01').comments.length;
  changeScope(state, { snapshot: 2 });
  assert.equal(feedback.get(state, 'R-01').comments.length, count);
  assert.equal(feedback.readiness(state, 'R-01').canPublish, false);
  assert.throws(() => feedback.publish(state, 'R-01', { expectedDraftId: draft.id, confirmed: true }), /变化|过期/);
});

test('同步失败保留旧评论并阻止发布，不用空列表冒充没有反馈', () => {
  const state = readyState();
  feedback.makeDraft(state, 'R-01');
  assert.throws(() => feedback.refresh(state, false), /保留旧会话/);
  assert.equal(feedback.session(state).items.length, 7);
  assert.equal(feedback.readiness(state, 'R-01').canPublish, false);
  assert.match(feedback.summary(state), /失败、保留旧快照/);
  assert.throws(() => importFeedbackRequirement(state, 'R-04'), /未完整同步/);
  feedback.refresh(state, true);
  assert.equal(feedback.readiness(state, 'R-01').canPublish, true);
  const resolved = readyState();
  post(resolved, 'R-01', { resolve: true });
  assert.throws(() => feedback.refresh(resolved, false), /保留旧会话/);
  assert.throws(() => feedback.reopen(resolved, 'R-01'), /未完整同步/);
  assert.equal(feedback.get(resolved, 'R-01').isResolved, true);
});

test('验证或模拟推送失败均显式保留失败，不放行最终回复', () => {
  const state = createCenterState();
  feedback.assessAll(state);
  applySampleFix(state, 'F-02');
  assert.throws(() => feedback.recordVerification(state, 'R-01', false), /模拟验证失败/);
  assert.throws(() => feedback.recordDelivery(state, 'R-01'), /尚无有效验证/);
  feedback.recordVerification(state, 'R-01', true);
  assert.throws(() => feedback.recordDelivery(state, 'R-01', false), /模拟推送失败/);
  assert.equal(feedback.readiness(state, 'R-01').proofReady, false);
});

test('Reviewer新需求只在人工明确纳入后成为待确认材料，原文和ID可追溯', () => {
  const state = createCenterState('fresh');
  selectFeedback(state, 'R-04');
  const item = feedback.get(state, 'R-04');
  assert.equal(preparationState(state).requirements.length, 0);
  const id = importFeedbackRequirement(state, item.id);
  const source = sources.getSource(state, id);
  assert.equal(source.text, item.comments[0].body);
  assert.equal(source.feedbackOrigin.threadId, item.remoteId);
  assert.equal(source.feedbackOrigin.commentId, item.rootCommentId);
  assert.equal(source.kind, 'review');
  assert.equal(preparationState(state).requirements[0].basis, 'human');
  assert.equal(state.baselineConfirmed, false);
  assert.equal(state.center.stage, 'prepare');
  assert.equal(item.isResolved, false);
  assert.equal(item.comments.filter((comment) => comment.isToolReply).length, 0);
  assert.throws(() => importFeedbackRequirement(state, item.id), /不重复导入/);
});

test('发布必须明确确认，目标、内容和演示分支无效时不能产生写入', () => {
  const state = readyState();
  const draft = feedback.makeDraft(state, 'R-01');
  const count = feedback.get(state, 'R-01').comments.length;
  assert.throws(() => feedback.publish(state, 'R-01', { expectedDraftId: draft.id }), /明确确认/);
  assert.throws(() => feedback.publish(state, 'R-01', { expectedDraftId: 'wrong', confirmed: true }), /目标或预览/);
  assert.throws(() => feedback.publish(state, 'R-01', { expectedDraftId: draft.id, outcome: 'invalid', confirmed: true }), /未知/);
  assert.throws(() => feedback.publish(state, 'R-01', { expectedDraftId: draft.id, outcome: 'resolve-failed', confirmed: true }), /同时解决/);
  assert.throws(() => feedback.editDraft(state, 'R-01', ' ', 'append'), /不能为空/);
  assert.throws(() => feedback.get(state, 'missing'), /当前 PR/);
  assert.equal(feedback.get(state, 'R-01').comments.length, count);
  syncFeedbackContext(state);
});

test('移出Reviewer需求材料后可重新选入原快照，不重复建来源或自动确认', () => {
  const state = createCenterState('fresh');
  const id = importFeedbackRequirement(state, 'R-04');
  const count = state.sources.length;
  sources.selectSource(state, id, false);
  assert.equal(preparationState(state).requirements.length, 0);
  assert.equal(importFeedbackRequirement(state, 'R-04'), id);
  assert.equal(state.sources.length, count);
  assert.equal(sources.getSource(state, id).selected, true);
  assert.equal(preparationState(state).requirements.length, 1);
  assert.equal(state.baselineConfirmed, false);
});

test('无效上下文与空发布方式不悄悄回退为另一PR或追加回复', () => {
  const state = readyState();
  const active = state.feedback.active;
  assert.throws(() => feedback.bind(state, { repositoryId: 'checkout', prId: '104', headRef: 'main', key: 'other' }), /缺少反馈/);
  assert.equal(state.feedback.active, active);
  assert.throws(() => feedback.makeDraft(state, 'R-01', 'final', ''), /只能更新/);
});

test('审查进行中底层同样阻止发布、Resolve和需求/PR关联修改', () => {
  const state = readyState();
  const draft = feedback.makeDraft(state, 'R-01');
  state.runStatus = 'running';
  assert.equal(feedback.readiness(state, 'R-01').canPublish, false);
  assert.throws(() => feedback.publish(state, 'R-01', { expectedDraftId: draft.id, confirmed: true }), /进行中/);
  assert.throws(() => feedback.recordVerification(state, 'R-01', true), /结束或取消/);
  assert.throws(() => importFeedbackRequirement(state, 'R-04'), /结束或取消/);
  assert.throws(() => linkFeedbackPr(state, ''), /结束或取消/);
});

test('重复核对已确认发布的回复不会新增第二条消息', () => {
  const state = readyState();
  post(state, 'R-01', { outcome: 'unknown' });
  feedback.checkPublication(state, 'R-01', 'published');
  const count = feedback.get(state, 'R-01').comments.length;
  assert.throws(() => feedback.checkPublication(state, 'R-01', 'published'), /没有需要核对/);
  assert.equal(feedback.get(state, 'R-01').comments.length, count);
});

test('结论摘要保留会话状态、Reply边界和未改变的Request changes', () => {
  const state = readyState();
  post(state, 'R-01', { resolve: true });
  const report = summaryText(state);
  assert.match(report, /PR 反馈与会话状态/);
  assert.match(report, /已解决（模拟）/);
  assert.match(report, /CHANGES_REQUESTED/);
  assert.match(report, /没有写入 GitHub/);
});
