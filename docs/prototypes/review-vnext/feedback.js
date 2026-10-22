(function () {
  'use strict';

  const clone = (value) => JSON.parse(JSON.stringify(value));
  const kindLabels = { thread: '代码审查会话', conversation: 'PR 普通评论', review: 'Review 总体意见' };
  const decisions = { fix: '需要修改', explain: '已有保障，建议解释', clarify: '需要澄清', requirement: '新增需求建议，待确认' };
  const outcomes = {
    success: '正常发布', 'reply-failed': '回复发布失败', pending: '回复留在 Review 草稿',
    unknown: '回复请求超时、结果未知', 'resolve-failed': '回复成功但 Resolve 失败',
  };

  function initialize(state) {
    state.feedback = { viewer: 'demo-author', active: null, sessions: {} };
  }

  function fixtures(context) {
    const seeds = context.prId === '104' ? [
      ['R-01', '取消与恢复必须维持同一个库存契约', '订单恢复', 'thread', 'fix', 'restore', 26, 'F-02',
        '取消已经释放库存，恢复却只改变订单状态。请一起核对取消与恢复路径，避免重复承诺库存。'],
      ['R-02', 'PaymentService 是否需要再加一层重试？', '重试保障', 'thread', 'explain', 'submit', 40, 'F-04',
        '这个服务没有本地重试，遇到暂时失败是否会丢请求？'],
      ['R-03', '重复回调的事件标识与去重保障是什么？', '支付与幂等', 'thread', 'clarify', 'callback', 16, 'F-03',
        '请确认重投是否保持同一个事件标识，以及账本去重的唯一约束。需求本身不能证明这些事实。'],
      ['R-04', '建议超时十秒后自动发起新的扣款', '需求建议', 'thread', 'requirement', 'submit', 43, 'F-01',
        '能否在支付超时十秒后自动重新扣款？这会改变现有的支付行为，需要确认适用范围与验收条件。'],
      ['R-05', '请在 PR 总结中交代验证与未覆盖范围', 'PR 总体', 'conversation', 'clarify', null, null, null,
        '请说明实际执行了哪些验证、没有验证什么，以及剩余风险。'],
      ['R-06', 'Request changes · 修改后请重新请求审查', 'PR 总体', 'review', 'clarify', null, null, null,
        '库存恢复和支付超时前提需要复核。修改完成后请重新请求审查；关闭讨论不等于我已经批准。'],
      ['R-07', '并发恢复也需要原子预留保障', '订单恢复', 'thread', 'fix', 'restore', 27, 'F-02',
        '同一根因还影响并发恢复，请确认预留与恢复的组合路径，而不只是修改一个返回值。'],
    ] : context.prId === '105' ? [
      ['R-01', '展示缓存是否被用于扣款资格判断？', '展示边界', 'thread', 'explain', 'status', 10, 'F-05',
        '请说明缓存延迟的业务容忍度，以及是否有不可逆操作依赖它。'],
      ['R-02', '补充验证说明', 'PR 总体', 'conversation', 'clarify', null, null, null, '请补充验证方式与未覆盖范围。'],
    ] : [
      ['R-01', '订单接口的兼容条件仍需补充', '订单契约', 'thread', 'clarify', 'restore', 26, null,
        '请补充上游订单接口的兼容条件，目前不能凭文件片段确认外部系统的保证。'],
    ];
    return seeds.map(([id, title, topic, kind, strategy, source, line, findingId, body]) => {
      const remoteId = `demo-${kind}-${context.repositoryId}-${context.prId}-${id}`;
      const comments = [{ id: `${remoteId}-root`, author: 'demo-reviewer', body, isToolReply: false }];
      if (id === 'R-01' && context.prId === '104') {
        comments.push(
          { id: `${remoteId}-followup`, author: 'demo-reviewer', body: '请同时覆盖正常恢复和并发恢复，不要仅修补孤立的一行。', isToolReply: false },
          { id: `${remoteId}-human`, author: 'demo-author', body: '收到，我会核对库存生命周期。', isToolReply: false },
        );
      }
      return {
        id, remoteId, rootCommentId: comments[0].id, title, topic, kind, strategy, source, line, findingId, comments,
        isResolved: kind === 'thread' ? false : null, canResolve: kind === 'thread' && id !== 'R-03',
        canUnresolve: kind === 'thread', isOutdated: id === 'R-01' && context.prId === '104',
        originalDiff: source === 'restore' ? '@@ 原评论快照 @@\n await order.restore();\n return { status: "awaiting_payment" };' : null,
        related: source === 'restore' ? ['cancel', 'api'] : source === 'status' ? ['decision', 'submit'] : strategy === 'explain' ? ['service', 'job'] : ['gateway'],
        reviewerRevision: 0,
        local: { analysis: null, verification: null, delivery: null, draft: null, operation: null, history: [], handled: false },
      };
    });
  }

  function bind(state, context) {
    if (!context) { state.feedback.active = null; return null; }
    if (['repositoryId', 'repositoryName', 'prId', 'headRef', 'key'].some((field) => typeof context[field] !== 'string' || !context[field].trim())) throw new Error('缺少反馈所关联的 Repository、PR 或代码快照');
    const key = `${context.repositoryId}/${context.prId}`;
    if (!state.feedback.sessions[key]) {
      state.feedback.sessions[key] = {
        context: clone(context), items: fixtures(context), syncStatus: 'ready', syncVersion: 1,
        reviewState: 'CHANGES_REQUESTED', nextReply: 1, nextDraft: 1, nextCommit: 1,
      };
    }
    state.feedback.active = key;
    state.feedback.sessions[key].context = clone(context);
    return state.feedback.sessions[key];
  }

  function session(state) {
    return state.feedback.active ? state.feedback.sessions[state.feedback.active] : null;
  }

  function requiredSession(state) {
    const current = session(state);
    if (!current) throw new Error('尚未明确关联 PR，不能读取或发布反馈');
    return current;
  }

  function get(state, id) {
    const item = requiredSession(state).items.find((entry) => entry.id === id);
    if (!item) throw new Error('当前 PR 中不存在这条反馈，不能用其他 PR 的会话替代');
    return item;
  }

  function inputKey(state, item) {
    const flow = state.sourceReview;
    const requirements = (flow.draft?.candidates || state.requirements).map(({ id, text, title, include, exclusionReason }) => ({ id, text, title, include, exclusionReason }));
    return JSON.stringify([requiredSession(state).context.key, flow.revision, state.baselineVersion, state.baselineConfirmed, requirements, item.reviewerRevision]);
  }

  function proofKey(state, item) {
    return JSON.stringify([inputKey(state, item), state.center.patchRevision || 0, state.center.patches]);
  }

  function analyzed(state, item) {
    return item.local.analysis?.key === inputKey(state, item);
  }

  function assertAnalyzed(state, item) {
    if (state.runStatus === 'running') throw new Error('请先结束或取消模拟审查，再修改反馈处置');
    if (requiredSession(state).syncStatus !== 'ready') throw new Error('反馈未完整同步，不能沿用旧快照发布或解决会话');
    if (!analyzed(state, item)) throw new Error('请先核对当前代码、需求与最新讨论；旧分析已失效');
  }

  function ownReply(state, item) {
    return item.comments.findLast((comment) => comment.isToolReply && comment.author === state.feedback.viewer && comment.canEdit);
  }

  function assess(state, id) {
    const item = get(state, id);
    if (requiredSession(state).syncStatus !== 'ready') throw new Error('反馈同步失败，请先刷新完整快照');
    const message = item.strategy === 'fix'
      ? '预设路径表明：取消释放库存，恢复状态却没有重新预留。两个会话共享这个根因，应一起核对状态、库存与并发保障。'
      : item.strategy === 'explain'
        ? item.source === 'status'
          ? '预设缓存只用于展示，设计记录明确允许延迟且禁止用于不可逆决策。应核对实际消费者和支付提交路径，不能把展示延迟直接判为扣款错误。'
          : '预设调度层统一负责重试。应先核对调用路径的覆盖范围，避免在服务层重复重试而放大请求；不是只看当前文件有没有重试。'
        : item.strategy === 'requirement'
          ? '这是新的行为建议，不是已确认需求；可能与单次扣款约束冲突。只有人工明确纳入并确认，才能作为本次验收依据。'
          : '材料不足以证明请求的前提。应明确询问缺失的契约或验证信息，保留未知，而不是假装已经修复。';
    item.local.analysis = { key: inputKey(state, item), message, decision: item.strategy };
    item.local.history.push('完成预设分析：未调用 AI，不自动接受 Reviewer 意见，也不改变原文或远端 Resolve 状态。');
    return item.local.analysis;
  }

  function assessAll(state) {
    const items = requiredSession(state).items.filter((item) => !item.isResolved);
    items.forEach((item) => assess(state, item.id));
    return items.length;
  }

  function recordVerification(state, id, passed) {
    const item = get(state, id);
    assertAnalyzed(state, item);
    if (typeof passed !== 'boolean') throw new Error('验证结果必须明确为通过或失败');
    if (item.strategy !== 'fix' || !state.center.patches[item.findingId]) throw new Error('请先审阅并应用对应的浏览器示例修复，不能把未修改当作验证通过');
    for (const related of requiredSession(state).items.filter((entry) => entry.findingId === item.findingId && entry.strategy === 'fix' && analyzed(state, entry))) {
      related.local.verification = { key: proofKey(state, related), passed };
      related.local.delivery = null;
      related.local.draft = null;
      related.local.history.push(`模拟验证${passed ? '通过' : '失败'}：正常/取消后恢复/并发路径；没有执行真实测试或 CI。`);
    }
    if (!passed) throw new Error('模拟验证失败，不能生成已修复回复或 Resolve；可修正后重试');
  }

  function recordDelivery(state, id, success = true) {
    const item = get(state, id);
    assertAnalyzed(state, item);
    const key = proofKey(state, item);
    if (!item.local.verification?.passed || item.local.verification.key !== key) throw new Error('当前修改尚无有效验证记录，不能宣称已推送修复');
    const current = requiredSession(state);
    if (typeof success !== 'boolean') throw new Error('推送结果必须明确为成功或失败');
    const commit = success ? `demo-fix-${current.context.prId}-${current.nextCommit++}` : null;
    for (const related of current.items.filter((entry) => entry.findingId === item.findingId && entry.local.verification?.passed && entry.local.verification.key === proofKey(state, entry))) {
      related.local.delivery = { key: proofKey(state, related), success, commit, headRef: current.context.headRef };
      related.local.history.push(`模拟提交与推送${success ? `成功：${commit} → ${current.context.headRef}` : '失败'}；没有执行 Git 命令，也没有改变真实 PR。`);
    }
    if (!success) throw new Error('模拟推送失败，不能将本地补丁当作已交付修复');
    return commit;
  }

  function proofReady(state, item) {
    const key = proofKey(state, item);
    return item.local.verification?.passed && item.local.verification.key === key && item.local.delivery?.success && item.local.delivery.key === key;
  }

  function unresolvedPublication(item) {
    return ['pending', 'unknown'].includes(item.local.operation?.status);
  }

  function readiness(state, id) {
    const item = get(state, id);
    const reasons = [];
    if (state.runStatus === 'running') reasons.push('模拟审查进行中，暂不能发布或解决反馈');
    if (requiredSession(state).syncStatus !== 'ready') reasons.push('反馈未完整同步');
    if (!analyzed(state, item)) reasons.push('代码、需求或讨论已变化，请重新分析');
    if (item.isResolved) reasons.push('会话已 Resolve，继续处理前请明确重新打开');
    if (unresolvedPublication(item)) reasons.push('上次回复仍是草稿或结果待确认；先核对发布状态，不要重复发送');
    const resolveReasons = [...reasons];
    if (item.kind !== 'thread') resolveReasons.push('普通评论与 Review 总体意见没有同样的 Resolve 状态');
    if (!item.canResolve) resolveReasons.push('当前会话未返回 Resolve 权限');
    if (item.strategy !== 'fix') resolveReasons.push('解释、澄清和新需求建议默认等待 Reviewer 复核，不直接关闭');
    if (item.strategy === 'fix' && !proofReady(state, item)) resolveReasons.push('修复尚未完成当前快照的模拟验证与推送');
    const draft = item.local.draft;
    const publishReasons = [...reasons];
    if (!draft) publishReasons.push('请先生成并核对回复草稿');
    else {
      if (!draft.body.trim()) publishReasons.push('回复内容不能为空');
      if (draft.key !== proofKey(state, item)) publishReasons.push('回复草稿的代码或讨论快照已过期');
      if (draft.consumed) publishReasons.push('这份回复已发布，请更新自己的回复或仅重试 Resolve');
      if (item.strategy === 'fix' && draft.intent === 'final' && !proofReady(state, item)) publishReasons.push('修复尚未验证并推送，不能发布已修复回复');
      if (draft.intent !== 'final') resolveReasons.push('进度说明不是修复完成，不能随回复 Resolve');
    }
    const operation = item.local.operation;
    const published = operation?.replyId && item.comments.some((comment) => comment.id === operation.replyId && comment.isToolReply);
    const canRetryResolve = !!published && operation.intent === 'final' && operation.key === proofKey(state, item) && resolveReasons.length === 0;
    return {
      canGenerate: reasons.length === 0, canPublish: publishReasons.length === 0,
      canResolve: resolveReasons.length === 0, canRetryResolve,
      reasons: publishReasons, resolveReasons, analyzed: analyzed(state, item), proofReady: !!proofReady(state, item),
      verified: !!item.local.verification?.passed && item.local.verification.key === proofKey(state, item),
      delivered: !!item.local.delivery?.success && item.local.delivery.key === proofKey(state, item),
    };
  }

  function makeDraft(state, id, intent = 'final', mode) {
    const item = get(state, id);
    assertAnalyzed(state, item);
    if (!['final', 'progress'].includes(intent)) throw new Error('未知的回复用途');
    if (unresolvedPublication(item)) throw new Error('请先核对上次发布结果，不能重复发送待确认的回复');
    if (item.isResolved) throw new Error('会话已解决，请先明确重新打开');
    if (item.strategy === 'fix' && intent === 'final' && !proofReady(state, item)) throw new Error('当前补丁尚未完成模拟验证与推送，可先发送进度说明');
    const previous = ownReply(state, item);
    mode ??= previous ? 'update' : 'append';
    if (!['update', 'append'].includes(mode) || mode === 'update' && !previous) throw new Error('只能更新本工具自己已发布且可编辑的回复');
    const current = requiredSession(state);
    const body = intent === 'progress' ? '我正在核对这条反馈；修复、验证或交付尚未完成。当前不将该会话标为已解决。（原型演示，不发送）'
      : item.strategy === 'fix'
        ? `已在浏览器示例中补齐恢复前的库存校验与原子预留，覆盖“${item.title}”。演示修复快照 ${item.local.delivery.commit}，目标分支 ${current.context.headRef}。验证与推送仅为模拟，未执行真实测试/CI、Git 提交或 GitHub 写入。`
        : item.strategy === 'explain'
          ? item.source === 'status'
            ? '预设设计允许展示缓存延迟，并明确禁止将其用于扣款资格或其他不可逆判断。应结合展示消费者和支付提交路径确认边界，而不是把所有延迟都视为错误。请 Reviewer 复核用途及调用覆盖；边界变化后需重审。（原型演示）'
            : '预设调用链由 PaymentJob 统一承担重试，PaymentService 保持单次调用；再加一层可能叠加尝试次数。请结合调度配置及所有相关调用方复核覆盖范围，不能永久假定保障成立。（原型演示）'
          : item.strategy === 'requirement'
            ? '这条建议涉及新的业务行为与验收标准，目前尚未确认。请先明确适用范围，并核实超时语义与单次扣款约束；不会因收到评论就直接改写需求或代码。（原型演示）'
            : '请补充这条反馈所依赖的契约、验证方式及未覆盖范围。目前证据不足，不能宣称已满足或已修复；等待补充后再核实。（原型演示）';
    item.local.draft = {
      id: `demo-draft-${current.context.repositoryId}-${current.context.prId}-${current.nextDraft++}`,
      target: { remoteId: item.remoteId, rootCommentId: item.rootCommentId },
      key: proofKey(state, item), body, intent, mode, replyId: mode === 'update' ? previous.id : null, consumed: false,
    };
    return item.local.draft;
  }

  function editDraft(state, id, body, mode) {
    const item = get(state, id);
    const draft = item.local.draft;
    if (!draft || draft.consumed) throw new Error('缺少可编辑的当前草稿，请重新生成回复预览');
    if (typeof body !== 'string' || !body.trim()) throw new Error('回复内容不能为空');
    if (!['update', 'append'].includes(mode)) throw new Error('未知的回复发布方式');
    const previous = ownReply(state, item);
    if (mode === 'update' && !previous) throw new Error('没有本工具自己可编辑的回复，不能修改 Reviewer 或人工原文');
    Object.assign(draft, { body, mode, replyId: mode === 'update' ? previous.id : null });
  }

  function assertTarget(state, item, expectedDraftId) {
    const draft = item.local.draft;
    if (!draft || draft.id !== expectedDraftId || draft.target.remoteId !== item.remoteId || draft.target.rootCommentId !== item.rootCommentId) throw new Error('回复目标或预览已变化，请重新核对 Repository、PR 与原会话');
  }

  function publishComment(state, item, operation) {
    const current = requiredSession(state);
    let comment;
    if (operation.mode === 'update') {
      comment = item.comments.find((entry) => entry.id === operation.editReplyId);
      if (!comment?.isToolReply || !comment.canEdit || comment.author !== state.feedback.viewer) throw new Error('不能改写 Reviewer、人工回复或无编辑权限的内容');
      comment.edits ||= [];
      comment.edits.push(comment.body);
      comment.body = operation.body;
    } else {
      comment = {
        id: `demo-reply-${item.remoteId}-${current.nextReply++}`, author: state.feedback.viewer, body: operation.body,
        isToolReply: true, canEdit: true, replyTo: item.kind === 'thread' ? item.rootCommentId : null,
        quotedCommentId: item.kind !== 'thread' ? item.rootCommentId : null,
      };
      item.comments.push(comment);
    }
    operation.replyId = comment.id;
    operation.status = 'published';
    item.local.handled = item.kind !== 'thread';
    item.local.history.push(`模拟${operation.mode === 'update' ? '更新本工具回复' : '发布回复'}：${comment.id}；目标始终为 ${item.remoteId} / ${item.rootCommentId}。`);
    return comment;
  }

  function publish(state, id, { expectedDraftId, resolve = false, outcome = 'success', confirmed = false }) {
    const item = get(state, id);
    assertTarget(state, item, expectedDraftId);
    if (!confirmed) throw new Error('请先预览并明确确认对外回复及是否 Resolve');
    if (!Object.hasOwn(outcomes, outcome)) throw new Error('未知的发布演示分支');
    if (outcome === 'resolve-failed' && !resolve) throw new Error('Resolve 失败分支需要明确选择“同时解决会话”');
    const ready = readiness(state, id);
    if (!ready.canPublish) throw new Error(ready.reasons.join('；'));
    if (resolve && !ready.canResolve) throw new Error(ready.resolveReasons.join('；'));
    const draft = item.local.draft;
    if (draft.mode === 'update') {
      const previous = item.comments.find((comment) => comment.id === draft.replyId);
      if (!previous?.isToolReply || !previous.canEdit || previous.author !== state.feedback.viewer) throw new Error('不能改写 Reviewer、人工回复或无编辑权限的内容');
    }
    const operation = {
      draftId: draft.id, key: draft.key, body: draft.body, mode: draft.mode, editReplyId: draft.replyId,
      intent: draft.intent, resolveRequested: resolve, target: clone(draft.target), replyId: null, status: outcome,
    };
    item.local.operation = operation;
    if (outcome === 'reply-failed') {
      item.local.history.push('模拟回复发布失败：没有产生新回复，也没有 Resolve。');
      throw new Error('模拟回复发布失败，未 Resolve；确认未发布后可重新预览发送');
    }
    if (outcome === 'pending' || outcome === 'unknown') {
      item.local.history.push(outcome === 'pending' ? '回复仍在未发布的 Review 草稿中；未自动提交、丢弃或替换用户已有草稿。' : '回复请求超时，结果未知；先核对远端，禁止盲目重试。');
      return operation;
    }
    publishComment(state, item, operation);
    draft.consumed = true;
    if (resolve && outcome === 'resolve-failed') {
      operation.status = 'resolve-failed';
      item.local.history.push('模拟回复已发布，但 Resolve 失败；只可重试解决，不重复回复。');
      throw new Error('回复已模拟发布，但 Resolve 失败；请仅重试解决会话');
    }
    if (resolve) {
      item.isResolved = true;
      operation.status = 'resolved';
      item.local.history.push('模拟 Resolve 成功并回读状态；没有改变 Review 的 Request changes 或批准状态。');
    }
    return operation;
  }

  function retryResolve(state, id) {
    const item = get(state, id);
    if (!readiness(state, id).canRetryResolve) throw new Error('没有当前快照下已发布、可解决的修复回复；请检查权限、验证、新消息与代码版本');
    item.isResolved = true;
    item.local.operation.status = 'resolved';
    item.local.history.push('仅重试 Resolve 成功；没有再次发布回复。');
  }

  function checkPublication(state, id, observed) {
    const item = get(state, id);
    const operation = item.local.operation;
    if (!unresolvedPublication(item)) throw new Error('没有需要核对的草稿或未知发布结果');
    if (!['published', 'pending', 'not-published'].includes(observed)) throw new Error('未知的远端发布状态');
    if (observed === 'pending') {
      item.local.history.push('模拟回读：回复仍未发布；保留 Review 草稿，不自动 Resolve。');
      return;
    }
    if (observed === 'not-published') {
      operation.status = 'not-published';
      item.local.history.push('模拟回读明确未发布：允许重新预览，但不自动重发。');
      return;
    }
    publishComment(state, item, operation);
    if (item.local.draft?.id === operation.draftId) item.local.draft.consumed = true;
    item.local.history.push('模拟回读确认回复已发布；仍未自动 Resolve，请核对后单独继续。');
  }

  function refresh(state, success = true) {
    const current = requiredSession(state);
    current.syncStatus = success ? 'ready' : 'failed';
    if (success) current.syncVersion += 1;
    if (!success) throw new Error('模拟同步失败：保留旧会话并标记未完整同步，不转换为空评论或已全部处理');
  }

  function receiveComment(state, id) {
    const item = get(state, id);
    item.reviewerRevision += 1;
    item.comments.push({
      id: `${item.remoteId}-new-${item.reviewerRevision}`, author: 'demo-reviewer',
      body: '有新的复核意见：请再次核对当前代码版本及并发/异常路径，再决定是否关闭讨论。', isToolReply: false,
    });
    item.local.history.push('收到模拟新回复：旧分析、验证与回复草稿失效；Outdated/Resolved 仍按远端状态分别保留。');
    state.humanConfirmed = false;
    state.submission = null;
  }

  function setResolvePermission(state, id, allowed) {
    if (typeof allowed !== 'boolean') throw new Error('Resolve 权限必须是明确的布尔值');
    const item = get(state, id);
    if (item.kind !== 'thread') throw new Error('这种评论没有 Review thread 的 Resolve 权限');
    item.canResolve = allowed;
  }

  function reopen(state, id) {
    if (state.runStatus === 'running') throw new Error('请先结束或取消模拟审查，再重新打开会话');
    if (requiredSession(state).syncStatus !== 'ready') throw new Error('反馈未完整同步，请先刷新状态再重新打开');
    const item = get(state, id);
    if (item.kind !== 'thread' || !item.canUnresolve || !item.isResolved) throw new Error('当前会话不能重新打开');
    item.isResolved = false;
    item.local.history.push('人工明确模拟重新打开会话；不撤销已经发布的回复，也不修改 Reviewer 原文。');
  }

  function status(state, item) {
    if (item.reviewerRevision > 0 && !analyzed(state, item)) return '有新回复，待核对';
    if (item.local.operation?.status === 'pending') return '回复草稿未发布';
    if (item.local.operation?.status === 'unknown') return '发布结果待确认';
    if (item.local.operation?.status === 'resolve-failed') return '已回复，Resolve 失败';
    if (item.local.operation?.status === 'reply-failed') return '回复发布失败';
    if (item.isResolved) return '已解决（模拟）';
    if (item.local.handled) return '本地已回复（无 Resolve）';
    if (!analyzed(state, item)) return item.local.analysis ? '快照已变，待重审' : '待判断';
    if (item.local.operation?.replyId) return '已回复，等待复核';
    if (proofReady(state, item)) return '已模拟推送，待回复';
    if (item.local.verification?.passed && item.local.verification.key === proofKey(state, item)) return '已模拟验证，待推送';
    return item.strategy === 'fix' ? '待修复 / 验证' : '待解释 / 澄清';
  }

  function readyFixes(state) {
    return requiredSession(state).items.filter((item) => item.strategy === 'fix' && !item.isResolved && readiness(state, item.id).canGenerate && proofReady(state, item) && !(item.local.operation?.replyId && item.local.operation.key === proofKey(state, item)));
  }

  function publishBatch(state, entries) {
    if (!entries.length || new Set(entries.map((entry) => entry.id)).size !== entries.length) throw new Error('请选择不重复的待发布会话');
    entries.forEach((entry) => assertTarget(state, get(state, entry.id), entry.expectedDraftId));
    return entries.map((entry) => {
      try {
        const result = publish(state, entry.id, entry);
        return { id: entry.id, status: result.status };
      } catch (error) {
        return { id: entry.id, status: 'failed', message: error.message };
      }
    });
  }

  function summary(state) {
    const current = session(state);
    if (!current) return '未关联 PR 反馈；分支模式不猜测对应的 PR。';
    const unresolved = current.items.filter((item) => item.kind === 'thread' && !item.isResolved).length;
    return `${current.context.repositoryName} / 演示 PR ${current.context.prId}：${current.items.length} 项反馈，${unresolved} 个未解决会话；同步${current.syncStatus === 'ready' ? '完成（演示）' : '失败、保留旧快照'}。\nReview 总体状态：${current.reviewState}；Resolve 不等于 Reviewer 批准。\n${current.items.map((item) => `- ${item.id} [${kindLabels[item.kind]} / ${status(state, item)}] ${item.title}；${item.remoteId}；${item.isOutdated ? '原位置过时，不代表已解决' : '原始位置保留'}`).join('\n')}\n所有反馈、回复、验证、推送和 Resolve 均为页面内模拟；没有写入 GitHub。`;
  }

  const api = {
    kindLabels, decisions, outcomes, initialize, bind, session, get, assess, assessAll, recordVerification, recordDelivery,
    readiness, makeDraft, editDraft, publish, retryResolve, checkPublication, refresh, receiveComment,
    setResolvePermission, reopen, status, readyFixes, publishBatch, summary, ownReply,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else window.ReviewFeedbackModel = Object.freeze(api);
}());
