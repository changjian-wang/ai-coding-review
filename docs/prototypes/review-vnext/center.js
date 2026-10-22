(function () {
  'use strict';

  const demo = typeof module !== 'undefined' && module.exports ? require('./app.js') : window.ReviewDemoModel;
  const sources = typeof module !== 'undefined' && module.exports ? require('./sources.js') : window.ReviewSourceModel;
  const feedback = typeof module !== 'undefined' && module.exports ? require('./feedback.js') : window.ReviewFeedbackModel;
  if (!demo) throw new Error('审查中心的示例状态模块未加载');
  if (!sources) throw new Error('需求来源模块未加载');
  if (!feedback) throw new Error('PR 反馈模块未加载');

  const scenarioLabels = {
    standard: '关键问题未闭合', fresh: '从需求确认开始', technical: '无需求的技术审查',
    partial: '证据受限、部分完成', ready: '已处理的独立示例',
  };
  const primaryFiles = { 'F-01': 'submit', 'F-02': 'restore', 'F-03': 'callback', 'F-04': 'service', 'F-05': 'status' };
  const chains = [
    { id: 'payment', title: '支付与结果收敛', description: '超时、再次支付与异步回调', findings: ['F-01', 'F-03'], files: ['submit', 'callback', 'gateway', 'payments'] },
    { id: 'orders', title: '取消与库存恢复', description: '状态恢复，是否也恢复了保障？', findings: ['F-02'], files: ['cancel', 'restore', 'api', 'orders'] },
    { id: 'safeguards', title: '重试与展示边界', description: '全局保障，让局部疑点不再成立', findings: ['F-04', 'F-05'], files: ['service', 'job', 'status', 'decision'] },
  ];
  const stages = [['prepare', '准备'], ['review', '审查'], ['conclusion', '结论']];
  const typeLabels = { requirement: '需求缺陷', implementation: '实现缺陷', question: '待核实', reasonable: '合理取舍' };
  const verdictLabels = { approve: '通过', 'request-changes': '要求修改', comment: '仅评论' };
  const runLabels = { idle: '未开始', running: '模拟审查中', cancelled: '已取消', partial: '部分完成', completed: '预设流程完成' };
  const repositories = [
    { id: 'checkout', name: 'demo/checkout-service', prs: [
      { id: '104', title: '支付超时与订单恢复', head: 'feat/payment-timeout', base: 'main' },
      { id: '105', title: '展示缓存与重试边界', head: 'feat/status-cache', base: 'main' },
    ] },
    { id: 'sandbox', name: 'demo/checkout-sandbox', prs: [{ id: '207', title: '订单恢复验证', head: 'feat/payment-timeout', base: 'main' }], comparisons: { 'feat/payment-timeout|main': ['restore'] } },
  ];
  const branches = [
    { name: 'feat/payment-timeout', version: 'demo-head-v3' },
    { name: 'main', version: 'demo-main-v2' },
    { name: 'release/2026.10', version: 'demo-release-v1' },
    { name: 'feat/status-cache', version: 'demo-cache-v1' },
  ];
  const changedFiles = ['submit', 'callback', 'restore'];
  const snapshotFiles = [...changedFiles, 'cancel', 'status', 'service', 'job', 'api', 'gateway', 'decision', 'payments', 'orders'];
  const comparisons = {
    'feat/payment-timeout|main': changedFiles,
    'feat/payment-timeout|release/2026.10': ['submit', 'restore'],
    'feat/status-cache|main': ['status', 'job'],
    'feat/status-cache|release/2026.10': ['status'],
    'feat/payment-timeout|feat/status-cache': [...changedFiles, 'status', 'job'],
    'main|release/2026.10': [],
  };

  function scopeForSelection(selection) {
    const repository = repositories.find((item) => item.id === selection.repository);
    if (!repository) throw new Error('请选择可用的演示 Repository');
    if (!['pr', 'branch'].includes(selection.kind)) throw new Error('请选择 PR 或分支');
    const pr = selection.kind === 'pr' ? repository.prs.find((item) => item.id === selection.pr) : null;
    if (selection.kind === 'pr' && !pr) throw new Error('所选 PR 不属于这个 Repository');
    const mode = pr ? 'changes' : selection.mode;
    if (!['changes', 'full'].includes(mode)) throw new Error('请选择分支变更或分支全量代码');
    const head = branches.find((item) => item.name === (pr ? pr.head : selection.branch));
    const base = mode === 'changes' ? branches.find((item) => item.name === (pr ? pr.base : selection.base)) : null;
    if (!head || (mode === 'changes' && !base)) throw new Error('所选分支或比较基线不存在');
    if (!Number.isInteger(selection.snapshot) || selection.snapshot < 1) throw new Error('代码快照版本无效');
    const errors = base?.name === head.name ? ['比较基线不能与被审查分支相同。'] : [];
    let files = [...snapshotFiles];
    if (mode === 'changes') {
      files = [];
      if (!errors.length) {
        const comparison = [`${head.name}|${base.name}`, `${base.name}|${head.name}`].find((key) => Object.hasOwn(comparisons, key));
        if (!comparison) throw new Error('此演示比较尚未提供文件清单，不能声称没有变更');
        files = [...(repository.comparisons?.[comparison] || comparisons[comparison])];
      }
      if (!files.length && !errors.length) errors.push('演示比较中没有变更文件，可选择其他比较范围或分支全量代码。');
    }
    const label = pr ? `PR ${pr.id} · ${pr.title}` : `${head.name} · ${mode === 'full' ? '全量代码' : `相对 ${base.name} 的变更`}`;
    return {
      repository, pr, head, base, mode, files, errors, label,
      reason: pr ? `PR ${pr.id} 的变更文件` : mode === 'full' ? '所选分支的全量演示文件清单' : `分支相对 ${base.name} 的变更文件`,
      key: JSON.stringify([repository.id, selection.kind, pr?.id, head.version, base?.version, mode, selection.snapshot]),
      supportsFindings: repository.id === 'checkout' && head.name === 'feat/payment-timeout' && base?.name === 'main' && selection.snapshot === 1,
    };
  }

  function scopeState(state) {
    return scopeForSelection(state.scopeReview.selection);
  }

  function syncFeedbackContext(state) {
    const scope = scopeState(state);
    const pr = scope.pr || (state.center.linkedFeedbackPr ? scope.repository.prs.find((item) => item.id === state.center.linkedFeedbackPr) : null);
    if (!pr) return feedback.bind(state, null);
    if (!scope.pr && pr.head !== scope.head.name) throw new Error('关联 PR 的 head 分支与当前审查分支不一致');
    return feedback.bind(state, {
      repositoryId: scope.repository.id, repositoryName: scope.repository.name, prId: pr.id,
      headRef: pr.head, headVersion: branches.find((item) => item.name === pr.head).version,
      key: JSON.stringify([scope.key, pr.id, state.scopeReview.selection.snapshot]),
    });
  }

  function linkFeedbackPr(state, id) {
    if (state.runStatus === 'running') throw new Error('请先结束或取消模拟审查，再修改 PR 反馈关联');
    const scope = scopeState(state);
    if (scope.pr) throw new Error('PR 模式直接读取所选 PR，不需要额外关联');
    if (id && !scope.repository.prs.some((pr) => pr.id === id && pr.head === scope.head.name)) throw new Error('请选择当前 Repository 且 head 分支匹配的 PR');
    state.center.linkedFeedbackPr = id || null;
    state.center.feedbackId = null;
    syncFeedbackContext(state);
    invalidate(state);
    state.history.push(id ? `人工关联演示 PR ${id} 的反馈；不改变代码范围，也不自动纳入需求。` : '人工移除 PR 反馈关联，不猜测其他 PR。');
  }

  function selectFeedback(state, id) {
    syncFeedbackContext(state);
    const item = feedback.get(state, id);
    Object.assign(state.center, { navigator: 'feedback', feedbackId: id, feedbackReadSource: false, stage: 'review' });
    if (item.source) state.center.file = item.source;
    if (item.findingId && state.findings.some((finding) => finding.id === item.findingId)) state.selectedFinding = item.findingId;
  }

  function importFeedbackRequirement(state, id) {
    if (state.runStatus === 'running') throw new Error('请先结束或取消模拟审查，再纳入需求建议');
    syncFeedbackContext(state);
    if (feedback.session(state)?.syncStatus !== 'ready') throw new Error('反馈未完整同步，请先刷新，再明确纳入需求建议');
    const item = feedback.get(state, id);
    if (item.strategy !== 'requirement') throw new Error('这条反馈不是预设的新需求建议');
    if (item.local.requirementSourceId) {
      const source = sources.getSource(state, item.local.requirementSourceId);
      if (source.selected) throw new Error('该建议已经作为材料保留；请在准备页核对或修订，不重复导入');
      sources.selectSource(state, source.id, true);
      state.center.stage = 'prepare';
      item.local.history.push('人工重新选入此前保留的需求材料；沿用原始快照与来源 ID，不重复创建或自动确认。');
      return source.id;
    }
    const current = feedback.session(state);
    const sourceId = sources.addReviewSource(state, `Reviewer 建议 · ${item.title}`, item.comments[0].body, {
      repository: current.context.repositoryName, prId: current.context.prId,
      threadId: item.remoteId, commentId: item.rootCommentId, author: item.comments[0].author,
    });
    item.local.requirementSourceId = sourceId;
    item.local.history.push('人工明确纳入需求材料，原文与出处保留；仍待确认，未修复代码、未回复或 Resolve。');
    state.center.stage = 'prepare';
    return sourceId;
  }

  function changeScope(state, patch) {
    if (state.runStatus === 'running') throw new Error('请先结束或取消模拟审查，再修改范围');
    const previous = scopeState(state);
    const selection = { ...state.scopeReview.selection, ...patch };
    if (patch.repository && patch.repository !== state.scopeReview.selection.repository) {
      const repository = repositories.find((item) => item.id === patch.repository);
      if (!repository) throw new Error('请选择可用的演示 Repository');
      Object.assign(selection, { pr: repository.prs[0].id, branch: repository.prs[0].head, base: repository.prs[0].base, snapshot: 1 });
    }
    if (patch.pr && patch.pr !== state.scopeReview.selection.pr) {
      const repository = repositories.find((item) => item.id === selection.repository);
      const pr = repository.prs.find((item) => item.id === patch.pr);
      if (!pr) throw new Error('所选 PR 不属于这个 Repository');
      Object.assign(selection, { branch: pr.head, base: pr.base });
    }
    if (selection.kind === 'branch' && selection.mode === 'changes' && selection.branch === selection.base && !Object.hasOwn(patch, 'base')) {
      selection.base = branches.find((item) => item.name !== selection.branch).name;
    }
    const next = scopeForSelection(selection);
    if (next.errors.length) throw new Error(next.errors.join('；'));
    if (next.key === previous.key) {
      state.scopeReview.selection = selection;
      return false;
    }
    const discardedResults = state.hasResults || state.baselineConfirmed || Object.keys(state.center.patches).length > 0;
    const excluded = state.sourceReview.draft
      ? state.sourceReview.draft.candidates.filter((item) => item.include === false)
      : state.sourceReview.excluded;
    if (excluded.length) {
      state.sourceReview.priorScopeExclusions ||= [];
      state.sourceReview.priorScopeExclusions.push({ scope: previous.key, items: JSON.parse(JSON.stringify(excluded)) });
      state.history.push(`旧范围的不适用记录不自动沿用：${excluded.map((item) => `${item.id}（${item.exclusionReason || item.reason}）`).join('；')}。原文与理由已归档，本次重新纳入待核对。`);
    }
    state.sourceReview.acceptedRevision = -1;
    state.scopeReview = { selection, confirmedKey: null, lastRunKey: null, previous: previous.label, discardedResults, reincluded: excluded.length };
    state.findings = [];
    state.selectedFinding = null;
    state.hasResults = false;
    state.runStatus = 'idle';
    state.completedStages = 0;
    state.pending = {};
    const linkedFeedbackPr = !previous.pr && selection.kind === 'branch' && previous.repository.id === next.repository.id && previous.head.name === next.head.name ? state.center.linkedFeedbackPr : null;
    Object.assign(state.center, { stage: 'prepare', file: next.files[0], patches: {}, fixSnapshots: {}, stageIndex: 0, feedbackId: null, feedbackReadSource: false, linkedFeedbackPr });
    state.baselineConfirmed = false;
    state.baselineDirty = true;
    sources.organize(state);
    invalidate(state);
    syncFeedbackContext(state);
    state.history.push(`审查对象改为 ${next.repository.name} / ${next.label}，快照 ${selection.snapshot}。旧发现与示例补丁已移出；保留材料，但需重新确认适用范围。`);
    return true;
  }

  function understandingChecks(requirements, findings = []) {
    const checks = [];
    const questions = [];
    const add = (requirement, text) => checks.push({ id: `CK-${checks.length + 1}`, requirement: requirement.id, text, normative: false, origins: requirement.origins });
    for (const requirement of requirements) {
      if (requirement.id === 'RQ-01' && requirement.text === '支付请求重试、回调重投和人工补单均不得造成重复扣款。') {
        add(requirement, '一起核对支付重试、重复回调与人工补单路径，验证它们不会组合成重复扣款。');
      }
      if (requirement.id === 'RQ-03' && requirement.text === '取消订单应释放占用；恢复订单必须重新校验并原子预留库存。') {
        add(requirement, '沿“取消 → 释放 → 恢复”核对状态与库存是否一起恢复，检查并发下的原子预留。');
      }
      if (requirement.id === 'RQ-02' && requirement.text === '支付请求超时即标记为失败，立即向用户开放再次支付入口。') {
        questions.push({ id: 'U-01', requirement: requirement.id, status: 'pending', text: '“超时等于支付失败”的前提是否成立？需要结合通道契约核实，不能因确认需求就视为正确。' });
      }
      if (requirement.id === 'RQ-04' && requirement.text === '同一支付结果的重复通知不得重复推进业务状态。') {
        questions.push({ id: 'U-02', requirement: requirement.id, status: findings.some((item) => item.id === 'F-03' && item.resolved) ? 'clarified' : 'pending', text: '回调重投时事件标识是否稳定、账本是否有有效去重保障？原需求没有证明这些系统事实。' });
      }
    }
    return {
      checks, questions,
      summary: checks.length === 2 ? '理解重点：支付结果收敛与订单 / 库存一致性。不只核对单次调用，还要检查重试、回调与取消恢复的组合路径。' : '',
    };
  }

  function currentFinding(state) {
    return state.findings.find((finding) => finding.id === state.selectedFinding);
  }

  function currentChain(state) {
    return chains.find((chain) => chain.findings.includes(state.selectedFinding)) || chains[0];
  }

  function preparationState(state) {
    const flow = state.sourceReview;
    const items = flow.draft ? flow.draft.candidates : [
      ...state.requirements,
      ...flow.excluded.map((item) => ({ ...item, include: false, exclusionReason: item.reason })),
    ];
    const requirements = items.filter((item) => item.include !== false);
    const mode = requirements.length ? 'requirements' : 'technical';
    const scope = scopeState(state);
    const reasons = [...scope.errors];
    if (state.runStatus === 'running') reasons.push('审查正在进行，请先结束或取消。');
    if (flow.readingFile) reasons.push('正在读取本地需求文件，请等待完成。');
    if (flow.draft && (flow.draft.revision !== flow.revision || flow.organizedRevision !== flow.revision)) reasons.push('材料发生变化，本次审查理解尚未更新。');
    const missingReasons = items.filter((item) => item.include === false && !item.exclusionReason?.trim());
    if (missingReasons.length) reasons.push(`请在详情中为 ${missingReasons.map((item) => item.id).join('、')} 补充不适用的原因。`);
    if (requirements.some((item) => !item.origins?.length || item.origins.some((origin) => sources.originStatus(state, origin) !== '当前版本'))) reasons.push('部分要求的出处已过期或不再选入，请在详情中修正。');
    const needsConfirmation = mode === 'requirements' && (!state.baselineConfirmed || flow.acceptedRevision !== flow.revision || state.mode !== 'requirements' || state.scopeReview.confirmedKey !== scope.key);
    return {
      requirements, items, mode, scope, ...understandingChecks(requirements, state.hasResults && !state.stale ? state.findings : []), needsConfirmation, canStart: reasons.length === 0, reasons,
      conflicts: flow.draft ? sources.draftConflicts(requirements) : flow.conflicts,
      notices: flow.draft?.notices || [],
      label: needsConfirmation ? '确认需求并开始审查' : '开始审查',
    };
  }

  function prepareForReview(state, explicitConfirmation = false) {
    const preparation = preparationState(state);
    if (!preparation.canStart) throw new Error(preparation.reasons.join('；'));
    if (preparation.needsConfirmation && !explicitConfirmation) throw new Error('请明确确认本次需求后再开始审查');
    switchMode(state, preparation.mode);
    if (preparation.needsConfirmation) {
      state.sourceReview.acknowledged = true;
      confirmBaseline(state);
    } else if (preparation.mode === 'technical' && state.sourceReview.draft) {
      state.sourceReview.excluded = state.sourceReview.draft.candidates.filter((item) => !item.include)
        .map((item) => ({ ...item, reason: item.exclusionReason }));
    }
    if (preparation.scope.supportsFindings && !state.findings.length) {
      state.findings = demo.createState(state.mode === 'technical' ? 'technical' : 'fresh').findings;
      state.selectedFinding = 'F-02';
      state.center.file = 'restore';
      state.center.findingMode = state.mode;
      if (state.requirements.some((item) => item.id === 'RQ-02' && item.text === demo.revisedRequirement)) state.pending.requirement = true;
    }
    return { mode: state.mode, confirmed: preparation.needsConfirmation, reused: preparation.mode === 'requirements' && !preparation.needsConfirmation };
  }

  function chooseMaterial(state, id, selected) {
    sources.selectSource(state, id, selected);
  }

  function changeRequirementInclusion(state, id, included, reason = '') {
    if (!included && !reason.trim()) throw new Error('请说明这条要求为什么不适用于本次审查');
    if (!state.sourceReview.draft) sources.organize(state);
    sources.updateCandidate(state, id, included, reason);
    state.baselineConfirmed = false;
    state.baselineDirty = true;
    state.stale = state.hasResults;
    invalidate(state);
    state.history.push(included ? `${id} 已重新纳入本次审查理解。` : `${id} 不适用于本次审查：${reason.trim()}`);
  }

  function createCenterState(scenario = 'standard') {
    const state = demo.createState(scenario);
    state.selectedFinding = 'F-02';
    state.center = {
      stage: scenario === 'fresh' ? 'prepare' : scenario === 'ready' ? 'conclusion' : 'review',
      navigator: 'business', search: '', inspector: 'judgment', file: 'restore', codeView: 'diff',
      related: true, focus: false, patches: {}, fixSnapshots: {}, stageIndex: 0,
      findingMode: state.mode, patchRevision: 0, feedbackId: null, feedbackReadSource: false, feedbackFilter: 'open', linkedFeedbackPr: null,
    };
    if (scenario === 'ready') {
      state.center.patches['F-01'] = true;
      state.center.patches['F-02'] = true;
      state.requirements.find((item) => item.id === 'RQ-02').title = '支付超时后保留结果未知';
      Object.assign(state.findings.find((item) => item.id === 'F-03'), {
        title: '重复回调的幂等前提已澄清（示例）',
        summary: '独立预设案例已补充稳定事件键与账本唯一约束；没有执行实际验证。',
      });
    }
    sources.initialize(state, demo.revisedRequirement);
    state.scopeReview = {
      selection: { repository: 'checkout', kind: 'pr', pr: '104', branch: 'feat/payment-timeout', mode: 'changes', base: 'main', snapshot: 1 },
      confirmedKey: null, lastRunKey: null, previous: null, discardedResults: false,
    };
    const scope = scopeState(state);
    state.scopeReview.confirmedKey = state.baselineConfirmed ? scope.key : null;
    state.scopeReview.lastRunKey = state.hasResults ? scope.key : null;
    if (scenario === 'fresh') {
      state.requirements = [];
      state.sources.forEach((source) => { source.selected = false; });
      sources.organize(state);
    }
    feedback.initialize(state);
    syncFeedbackContext(state);
    return state;
  }

  function invalidate(state) {
    state.humanConfirmed = false;
    state.submission = null;
  }

  function selectFinding(state, id) {
    if (!state.findings.some((finding) => finding.id === id)) throw new Error('当前示例不存在这个审查问题');
    state.selectedFinding = id;
    state.center.file = primaryFiles[id];
    state.center.stage = 'review';
    state.center.inspector = 'judgment';
    state.center.feedbackId = null;
    if (state.center.navigator === 'feedback') state.center.navigator = 'findings';
  }

  function switchMode(state, mode) {
    if (!['requirements', 'technical'].includes(mode)) throw new Error('未知审查模式');
    if (mode === 'requirements' && !preparationState(state).requirements.length) throw new Error('没有需求材料，请先选择或补充明确要求');
    if (state.mode === mode) return;
    if (!state.hasResults) {
      state.findings = scopeState(state).supportsFindings ? demo.createState(mode === 'technical' ? 'technical' : 'standard').findings : [];
      state.center.findingMode = mode;
      state.selectedFinding = 'F-02';
      state.center.file = 'restore';
    } else if (state.center.findingMode !== mode) state.sourceReview.limited = true;
    state.mode = mode;
    state.stale = state.hasResults;
    invalidate(state);
    state.history.push(`切换为${mode === 'technical' ? '有限技术审查' : '需求驱动审查'}；已知且仍相关的关键问题不会消失。`);
  }

  function completeReview(state) {
    const scope = scopeState(state);
    if (scope.errors.length) throw new Error(scope.errors.join('；'));
    if (!scope.supportsFindings) {
      state.runStatus = 'partial';
      state.hasResults = false;
      state.findings = [];
      state.selectedFinding = null;
      state.stale = false;
      state.scopeReview.lastRunKey = null;
      invalidate(state);
      state.history.push('此范围只演示代码对象选择与文件清单，没有对应的预设审查结果；未连接模型，不能复用另一范围的发现或宣称完成。');
      return;
    }
    const revised = state.pending.requirement;
    const evidenceAdded = state.pending.evidence;
    demo.finishRun(state);
    if (revised) {
      const finding = state.findings.find((item) => item.id === 'F-01');
      Object.assign(finding, {
        type: 'implementation', status: 'confirmed', critical: false, resolved: false, disposition: null,
        title: '超时处理尚未对齐修订后的需求',
        summary: '需求已澄清，但代码仍把超时置为失败；解决需求矛盾并不等于修复实现。',
        origin: '需求修订后待对齐',
        impact: 'RQ-02 已要求保留未知状态，旧分支却仍允许再次扣款。需要修正实现，而不是把需求修订视为整个问题已解决。',
        evidence: [
          { title: '修订后的需求明确保留结果未知', text: '新基线不再把超时当作失败；这是经人工确认的新要求，仍需核对实现。', source: 'payments.md:23 · 当前 RQ-02' },
          { title: '旧实现仍开放再次支付', text: '示例超时分支仍调用 markPaymentFailed() 并返回 canPayAgain: true，没有随需求修订自动变化。', source: 'src/payments/submit.ts:43 · 示例源码' },
        ],
        counter: [
          { title: '需求确认是否能替代代码修改？', text: '不能。当前示例代码仍调用 markPaymentFailed()，需要独立检查实现是否与新需求一致。' },
          { title: '是否存在其他层阻止再次支付？', text: '示例调用链未提供有效保障，因此实现偏离仍需处理。' },
        ],
      });
      const requirement = state.requirements.find((item) => item.id === 'RQ-02');
      if (requirement) {
        requirement.title = '支付超时后保留结果未知';
        requirement.check = 'violated';
      }
      state.history.push('F-01：需求矛盾已闭合，但原根因转为实现待对齐；没有重复生成问题，也没有假装旧代码已修复。');
    }
    if (evidenceAdded) {
      Object.assign(state.findings.find((item) => item.id === 'F-03'), {
        title: '重复回调的幂等前提已澄清（示例）',
        summary: '预设契约已补充稳定事件键与账本唯一约束；这不等于实际执行过回调验证。',
        impact: '决定性前提已在示例分支中澄清，不再作为关键未决项。适用边界仍为当前演示契约。',
        evidence: [{ title: '示例契约与去重边界一致', text: '同一事件重投保持 event.id 稳定，且示例账本对其具有唯一约束。', source: 'gateway-contract.md:24 · 预设补充契约 v2' }],
        counter: [{ title: '能否推广到任意支付通道？', text: '不能。这是当前示例契约的适用条件，不代表其他通道或新版本也满足。' }],
      });
    }
    state.scopeReview.lastRunKey = scope.key;
    if (state.center.findingMode !== state.mode || sources.selectedSources(state).some(sources.needsAnalysis)) state.sourceReview.limited = true;
    if (state.sourceReview.limited) {
      state.runStatus = 'partial';
      state.history.push('来源基线已更新：本原型不分析自定义材料或新增、编辑、排除条目的语义。已有发现保留作对照，不能称为按新基线完成真实评审。');
    }
  }

  function approvalGate(state) {
    const gate = demo.approvalGate(state);
    const sourceCheck = sources.sourceGate(state);
    const scope = scopeState(state);
    const scopeReasons = [...scope.errors];
    if (state.mode === 'requirements' && state.baselineConfirmed && state.scopeReview.confirmedKey !== scope.key) scopeReasons.push('需求理解尚未确认适用于当前代码范围与快照');
    if (state.hasResults && state.scopeReview.lastRunKey !== scope.key) scopeReasons.push('旧结果不属于当前代码范围与快照');
    if (!scope.supportsFindings) scopeReasons.push('此演示范围没有预设分析结果，未执行真实审查');
    return {
      ...gate, eligible: gate.eligible && sourceCheck.reasons.length === 0 && scopeReasons.length === 0,
      feedbackAllowed: gate.feedbackAllowed && scopeReasons.length === 0,
      reasons: [...gate.reasons, ...sourceCheck.reasons, ...scopeReasons],
      critical: [...gate.critical, ...sourceCheck.conflicts],
    };
  }

  function confirmBaseline(state) {
    const readiness = sources.confirmationState(state);
    if (!readiness.canAcknowledge) throw new Error(readiness.message);
    if (state.sourceReview.draft) {
      sources.confirm(state);
      state.scopeReview.confirmedKey = scopeState(state).key;
      return;
    }
    if (!state.sourceReview.acknowledged) throw new Error('请先核对原文、适用范围与冲突');
    demo.confirmBaseline(state);
    state.scopeReview.confirmedKey = scopeState(state).key;
    state.sourceReview.conflicts = sources.draftConflicts(state.requirements);
    state.sourceReview.limited = state.requirements.some((item) => !state.sourceReview.knownTexts[item.id]?.includes(item.text)) || state.center.findingMode !== state.mode;
  }

  function submitVerdict(state, verdict) {
    if (verdict === 'approve' && !approvalGate(state).eligible) throw new Error('存在来源、语义评审或关键问题限制，不能通过');
    if (verdict !== 'approve' && !approvalGate(state).feedbackAllowed) throw new Error('没有与当前代码范围及快照一致的有效结果，不能提交反馈');
    demo.submitVerdict(state, verdict);
  }

  function applySampleFix(state, id) {
    const finding = state.findings.find((item) => item.id === id);
    if (!finding || finding.type !== 'implementation') throw new Error('只能对已澄清的实现问题展示示例修复');
    if (state.center.patches[id]) throw new Error('这份示例修复已经应用');
    state.center.fixSnapshots[id] = {
      finding: JSON.parse(JSON.stringify(finding)),
      check: state.requirements.find((item) => item.id === finding.requirement)?.check,
    };
    demo.markFixed(state, id, '人工接受预设修复，修改的只是浏览器内虚构代码；没有执行测试。');
    state.center.patches[id] = true;
    state.center.patchRevision += 1;
    state.center.file = primaryFiles[id];
    state.history.push(`${id} 仅应用示例补丁，可撤销；未修改真实源码。`);
  }

  function undoSampleFix(state, id) {
    const snapshot = state.center.fixSnapshots[id];
    if (!snapshot) throw new Error('当前没有可撤销的本次示例修复快照');
    const index = state.findings.findIndex((finding) => finding.id === id);
    if (index < 0) throw new Error('修复对应的问题不存在');
    state.findings[index] = snapshot.finding;
    const requirement = state.requirements.find((item) => item.id === snapshot.finding.requirement);
    if (requirement && snapshot.check) requirement.check = snapshot.check;
    delete state.center.fixSnapshots[id];
    delete state.center.patches[id];
    state.center.patchRevision += 1;
    invalidate(state);
    state.history.push(`${id} 已撤销本次示例修复；原问题恢复，旧结论失效。`);
  }

  function sourceFiles(state) {
    const code = (key, path, start, lines, highlighted = [], changes = {}) => ({
      key, path, name: path.split('/').at(-1), kind: 'code', start,
      lines: lines.map((text, index) => ({ text, number: start + index, highlighted: highlighted.includes(index), change: changes[index] || '' })),
    });
    const document = (key, path, title, paragraphs, highlight) => ({
      key, path, name: path.split('/').at(-1), kind: 'document', title, paragraphs, highlight,
    });
    const restored = !!state.center.patches['F-02'];
    const technical = state.center.findingMode === 'technical';
    const timeoutFixed = !!state.center.patches['F-01'];
    const restoreBody = technical
      ? restored
        ? ['  const reservation = await inventory.reserveForOrder(order);', '  await order.restore();', '  return { reservationId: reservation.id };']
        : ['  await order.restore();', '  const reservation = await inventory.findByOrder(order.id);', '  return { reservationId: reservation.id };']
      : restored
        ? ['  await inventory.reserveForOrder(order);', '  await order.restore();', '  return { status: "awaiting_payment" };']
        : ['  await order.restore();', '  return { status: "awaiting_payment" };'];
    const restore = code('restore', 'src/orders/restore.ts', 16, [
      'import { permissions } from "../auth/permissions";',
      'import { inventory } from "../inventory/reservations";',
      'import { orders } from "./repository";',
      '',
      '// Restore a cancelled order to the payment workflow.',
      'export async function restoreOrder(userId: string, orderId: string) {',
      '  const order = await orders.findById(orderId);',
      '  if (!order) throw new Error("Order not found");',
      '  if (order.status !== "cancelled") return order;',
      '',
      '  await permissions.checkOwner(userId, order);',
      ...restoreBody,
      '}',
      '',
      '// Caller: POST /orders/:id/restore',
      '// Related lifecycle: cancelOrder() releases reservations.',
    ], technical ? [13] : [11], { 11: 'added', 12: 'added', ...(restored ? { 13: 'added' } : {}) });
    const submit = code('submit', 'src/payments/submit.ts', 32, [
      'export async function submitPayment(order: Order) {',
      '  await permissions.checkPaymentAccess(order);',
      '  const request = buildPaymentRequest(order);',
      '',
      '  // The transport result is not the final payment result.',
      '  const result = await gateway.submit(request);',
      '  if (result.ok) {',
      '    return { canPayAgain: false };',
      '  }',
      '',
      '  if (result.reason === "TIMEOUT") {',
      timeoutFixed ? '    order.markPaymentUnknown();' : '    order.markPaymentFailed();',
      timeoutFixed ? '    return { canPayAgain: false, status: "unknown" };' : '    return { canPayAgain: true };',
      '  }',
      '',
      '  return mapDefinitiveFailure(result);',
      '}',
      '',
      '// The asynchronous callback may arrive after this method returns.',
    ], [11, 12], { 11: 'added', 12: 'added' });
    const callback = code('callback', 'src/payments/callback.ts', 10, [
      'export async function onPaymentCallback(payload: unknown) {',
      '  await gateway.verifySignature(payload);',
      '  const receivedAt = clock.now();',
      '',
      '  // Replay protection depends on a stable event key.',
      '  const event = await gateway.parse(payload);',
      '  await ledger.applyOnce(event.id, event.result);',
      '',
      '  await audit.recordReceipt(event.id, receivedAt);',
      '  return { accepted: true };',
      '}',
    ], [6], { 6: 'added' });
    const cancel = code('cancel', 'src/orders/cancel.ts', 13, [
      'export async function cancelOrder(orderId: string) {',
      '  const order = await orders.findById(orderId);',
      '  await permissions.checkOwner(order);',
      '',
      '  return database.transaction(async (tx) => {',
      '    await tx.orders.markCancelled(order.id);',
      '    await tx.inventory.releaseReservation(order.id);',
      '    return { status: "cancelled" };',
      '  });',
      '}',
    ], [6]);
    const service = code('service', 'src/payments/service.ts', 25, [
      'export class PaymentService {',
      '  constructor(private readonly gateway: Gateway) {}',
      '',
      '  // One attempt only. The scheduler owns retry policy.',
      '  async submit(order: Order) {',
      '    const request = buildPaymentRequest(order);',
      '    await permissions.checkPaymentAccess(order);',
      '',
      '    // All supported entry points run through PaymentJob.',
      '    return this.gateway.submit(request);',
      '  }',
      '}',
    ], [9]);
    const job = code('job', 'src/jobs/payment-job.ts', 34, [
      'export function runPaymentJob(order: Order) {',
      '  // API submission and compensation both use this job.',
      '  return jobs.run(',
      '    () => paymentService.submit(order),',
      '    {',
      '      retry: {',
      '        backoff: "exponential",',
      '        attempts: 3,',
      '      },',
      '    },',
      '  );',
      '}',
    ], [5, 6, 7]);
    const status = code('status', 'src/queries/order-status.ts', 6, [
      'export async function queryDisplayStatus(order: Order) {',
      '  // Display-only; payment authorization does not read this cache.',
      '  const key = `order-display:${order.id}`;',
      '',
      '  return cache.remember(key, { ttl: 30 }, () => {',
      '    return gateway.queryDisplayStatus(order.paymentId);',
      '  });',
      '}',
    ], [4]);
    const api = code('api', 'src/api/orders.ts', 56, [
      'router.post("/orders/:id/restore", requireUser, async (request) => {',
      '  const user = request.user;',
      '  const orderId = request.params.id;',
      '',
      '  // Authorization only; this route does not reserve inventory.',
      '  return restoreOrder(user.id, orderId);',
      '});',
    ], [5]);
    const questionClosed = state.findings.find((finding) => finding.id === 'F-03')?.resolved;
    const sourceDocument = (source) => ({
      ...document(
        source.id, source.location, source.name,
        sources.snapshot(source).text.split('\n').map((text, index) => [String(index + 1), text]).filter(([, text]) => text.trim()),
        source.id === 'payments' ? '23' : source.id === 'orders' ? '31' : '4',
      ),
      markdownText: sources.snapshot(source).text,
      userProvided: !!source.userProvided,
      sourceInfo: `${sources.kindLabels[source.kind]} · 原文 v${source.version} · ${source.selected ? sources.purposeLabels[source.purpose] : '未纳入本次来源'}`,
    });
    return {
      restore, submit, callback, cancel, service, job, status, api,
      ...Object.fromEntries(state.sources.map((source) => [source.id, sourceDocument(source)])),
      gateway: document('gateway', 'contracts/gateway-contract.md', '支付通道响应语义', [
        ['17', 'TIMEOUT 表示响应未在等待期限内返回，不表示扣款请求已撤销；稍后仍可能收到成功回调。'],
        ['24', questionClosed ? '预设补充契约 v2：同一事件重投保持 event.id 稳定；示例账本对该键有唯一约束。' : '当前材料没有声明所有重投是否保持相同的事件标识。该前提仍需补充。'],
        ['30', '这些段落仅为虚构契约，不描述任何真实支付提供方。'],
      ], state.selectedFinding === 'F-03' ? '24' : '17'),
      decision: document('decision', 'decisions/status-cache.md', '展示缓存的适用边界', [
        ['09', '展示页面允许最长 30 秒延迟，用于控制支付通道查询负载。'],
        ['14', '该缓存不得用于扣款资格、库存提交或其他不可逆业务判断。'],
        ['21', '若后续调用方改变，这份合理取舍必须重新审查，不能永久免责。'],
      ], '14'),
    };
  }

  function summaryText(state, verdict = state.verdict) {
    syncFeedbackContext(state);
    const gate = approvalGate(state);
    const scope = scopeState(state);
    const understanding = understandingChecks(state.requirements, state.hasResults && !state.stale ? state.findings : []);
    const sourceSummary = (sources.selectedSources(state).map((source) => `- [${sources.kindLabels[source.kind]} / ${sources.purposeLabels[source.purpose]}] ${source.location} · 原文 v${source.version}`).join('\n') || '未提供需求来源。') + (state.sourceReview.excluded.length ? `\n排除记录：\n${state.sourceReview.excluded.map((item) => `- ${item.id}：${item.reason}`).join('\n')}` : '');
    const origins = state.requirements.map((item) => `- ${item.id}${state.baselineConfirmed && state.mode === 'requirements' ? '' : '（非本次已确认需求）'}：${item.origins?.map((origin) => `${sources.labelOrigin(state, origin)} [${sources.originStatus(state, origin)}]`).join('；') || '缺少原文引用'}${item.manualRevision ? '；人工修订与原文分别保存' : ''}`).join('\n');
    const report = `Review vNext · 审查中心原型 · ${verdictLabels[verdict]}\n\n代码、业务发现与裁决为预设示例；需求材料可来自示例、粘贴或本地读取，只存页面内存。未连接模型、真实仓库或 GitHub。\nRepository：${scope.repository.name}\n范围：${scope.label}；${scope.files.length} 个审查文件及按需关联核查。\n代码快照：${scope.head.version}${scope.base ? ` / 比较基线 ${scope.base.name} (${scope.base.version})` : ' / 全量快照，不以 Diff 定义范围'}；演示快照 ${state.scopeReview.selection.snapshot}。\n需求：${state.mode === 'technical' ? '有限技术审查，需求一致性未评审；不代表业务需求已满足。' : `基线 v${state.baselineVersion}，${state.baselineConfirmed ? '已人工确认理解' : '待确认'}。确认不等于需求正确或其假设已证实。`}\n执行：${runLabels[state.runStatus]}${state.stale ? '；依据已变化，旧结果待重审。' : '。'}\n\n本次材料：\n${sourceSummary}\n\n需求出处：\n${origins || '无已确认需求。'}\n\n推导检查点（不新增验收门槛）：\n${understanding.checks.map((item) => `- ${item.requirement}：${item.text}`).join('\n') || '无预设推导。'}\n需核实前提（确认不证明成立，当前状态以裁决为准）：\n${understanding.questions.map((item) => `- ${item.requirement} [${item.status === 'clarified' ? '已在预设裁决中澄清' : '待核实'}]：${item.text}`).join('\n') || '未生成预设前提，不代表不存在未知。'}\n\n${gate.reasons.length ? `通过限制：\n${gate.reasons.map((reason) => `- ${reason}`).join('\n')}` : `未发现当前演示规则下的批准阻断；${state.humanConfirmed ? '人工已确认边界。' : '仍需人工确认。'}`}\n\n审查发现：\n${state.hasResults ? state.findings.map((finding) => `- ${finding.id} [${typeLabels[finding.type]} / ${finding.resolved ? '示例已处理或排除' : finding.status === 'unresolved' ? '待核实' : '已确认'}] ${finding.title}`).join('\n') : '尚无有效结果，空列表不代表没有问题。'}\n\n验证边界：没有执行测试、实际复现或修改真实代码；应用预设补丁不等于运行验证通过。${state.sourceReview.limited ? '新增或排除需求尚未语义评审；旧示例发现不能被称为新基线的验证结果。' : ''}\n${state.notes.trim() ? `\n人工补充：\n${state.notes.trim()}` : ''}`;
    return `${report}\n\nPR 反馈与会话状态（演示）：\n${feedback.summary(state)}`;
  }

  function statusLabel(finding) {
    if (finding.status === 'dismissed') return ['已排除', 'green'];
    if (finding.resolved) return ['示例已处理', 'blue'];
    if (finding.status === 'unresolved') return ['尚未确认', 'amber'];
    return ['已确认', 'red'];
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { createCenterState, currentFinding, currentChain, switchMode, selectFinding, completeReview, applySampleFix, undoSampleFix, sourceFiles, summaryText, approvalGate, confirmBaseline, submitVerdict, statusLabel, preparationState, prepareForReview, chooseMaterial, changeRequirementInclusion, repositories, branches, scopeState, changeScope, understandingChecks, syncFeedbackContext, linkFeedbackPr, selectFeedback, importFeedbackRequirement };
    return;
  }

  const svgPaths = {
    check: '<path d="m5 12 4 4L19 6"/>',
    code: '<path d="m8 5-7 7 7 7m8-14 7 7-7 7M14 3l-4 18"/>',
    file: '<path d="M14 2H5v20h14V7l-5-5Z"/><path d="M14 2v6h5M8 12h8M8 16h6"/>',
    branch: '<path d="M6 5v13a3 3 0 0 0 3 3h3M6 11h8a4 4 0 0 0 4-4V5"/><circle cx="6" cy="3" r="2"/><circle cx="18" cy="3" r="2"/><circle cx="14" cy="21" r="2"/>',
    flow: '<rect x="2" y="9" width="5" height="6" rx="1"/><rect x="17" y="2" width="5" height="6" rx="1"/><rect x="17" y="16" width="5" height="6" rx="1"/><path d="M7 12h5V5h5M12 12v7h5"/>',
    bug: '<path d="M8 7h8v11a4 4 0 0 1-8 0V7ZM9 3l3 4 3-4M3 10h5M16 10h5M3 16h5M16 16h5M5 22l4-3M15 19l4 3M12 8v12"/>',
    shield: '<path d="m12 2 8 4v6c0 5-8 10-8 10S4 17 4 12V6l8-4Z"/><path d="m8 12 3 3 5-6"/>',
    arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
    chevron: '<path d="m9 5 7 7-7 7"/>',
    refresh: '<path d="M20 7A9 9 0 1 0 21 14M20 2v6h-6"/>',
    play: '<path d="m8 4 13 8-13 8V4Z"/>',
    search: '<circle cx="10" cy="10" r="6"/><path d="m15 15 6 6"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>',
    lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V6a4 4 0 0 1 8 0v4M12 14v3"/>',
    alert: '<path d="m12 3 10 18H2L12 3Z"/><path d="M12 9v5M12 17h.01"/>',
    message: '<path d="M3 3h18v14H8l-5 4V3Z"/><path d="M7 8h10M7 12h7"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 1v2M12 21v2M1 12h2M21 12h2M4 4l2 2M18 18l2 2M4 20l2-2M18 6l2-2"/>',
    moon: '<path d="M21 13A9 9 0 0 1 11 3a9 9 0 1 0 10 10Z"/>',
    close: '<path d="m6 6 12 12M6 18 18 6"/>',
    edit: '<path d="m16 3 5 5L9 20l-6 1 1-6L16 3ZM13 6l5 5"/>',
    link: '<path d="m9 15 6-6M8 16l-2 2a4 4 0 0 1-5-6l5-5a4 4 0 0 1 6 0M16 8l2-2a4 4 0 0 1 5 6l-5 5a4 4 0 0 1-6 0"/>',
    focus: '<path d="M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5"/>',
    download: '<path d="M12 3v12m-4-4 4 4 4-4M4 17v4h16v-4"/>',
  };
  const icon = (name, extra = '') => `<svg class="${extra}" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round">${svgPaths[name] || svgPaths.file}</svg>`;
  const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  const badge = (text, tone = '', dot = false) => `<span class="badge ${tone}${dot ? ' dot' : ''}">${escape(text)}</span>`;
  const markdown = window.ReviewMarkdown;
  if (!markdown) throw new Error('Markdown 渲染模块未加载，不能提供格式预览');

  function markdownEditor(id, text = '', rows = 6, required = true) {
    return `<div class="markdown-editor" data-markdown-editor>
      <div class="markdown-toolbar"><span>Markdown</span><div class="markdown-controls" role="group" aria-label="内容编辑方式">
        <button class="markdown-mode-button active" type="button" data-action="markdown-edit-mode" data-mode="edit" aria-pressed="true">编辑</button>
        <button class="markdown-mode-button" type="button" data-action="markdown-edit-mode" data-mode="preview" aria-pressed="false">预览</button>
      </div></div>
      <textarea ${required ? 'required' : ''} id="${id}" class="textarea markdown-input" rows="${rows}" data-markdown-input aria-describedby="${id}-help" placeholder="# 业务目标&#10;&#10;- **必须满足的条件**&#10;- [ ] 尚待核实的前提">\n${escape(text)}</textarea>
      <div class="markdown-body markdown-preview" data-markdown-preview tabindex="0" aria-label="Markdown 预览" hidden></div>
      <p class="form-hint markdown-help" id="${id}-help">支持标题、粗体、列表、任务清单、代码块、表格、引用和链接。预览不改变原文，HTML 不执行，图片不自动加载。</p>
      </div>`;
  }

  function setMarkdownEditorMode(editor, mode) {
    const input = editor.querySelector('[data-markdown-input]');
    const preview = editor.querySelector('[data-markdown-preview]');
    const editing = mode === 'edit';
    if (!editing) {
      preview.innerHTML = input.value.trim() ? markdown.render(input.value) : '<p class="markdown-empty">还没有内容，返回编辑后即可预览。</p>';
    }
    input.hidden = !editing;
    preview.hidden = editing;
    editor.querySelectorAll('[data-action="markdown-edit-mode"]').forEach((button) => {
      const active = button.dataset.mode === mode;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    if (editing) input.focus({ preventScroll: true });
  }

  function markdownReader(text) {
    return `<div class="markdown-reader" data-markdown-reader>
      <div class="markdown-toolbar"><span>Markdown · 原文未改写</span><div class="markdown-controls" role="group" aria-label="材料显示方式">
        <button type="button" class="markdown-mode-button active" data-action="markdown-read-mode" data-mode="reading" aria-pressed="true">阅读</button>
        <button type="button" class="markdown-mode-button" data-action="markdown-read-mode" data-mode="raw" aria-pressed="false">原文（行号）</button>
      </div></div>
      <div class="markdown-body markdown-reading" data-markdown-reading>${markdown.render(text)}</div>
      <div class="raw-source markdown-raw" data-markdown-raw hidden>${text.split(/\r?\n/).map((line, index) => `<div class="raw-source-line"><span>L${index + 1}</span><p>${escape(line) || ' '}</p></div>`).join('')}</div>
      </div>`;
  }

  function setMarkdownReaderMode(reader, mode) {
    const reading = mode === 'reading';
    reader.querySelector('[data-markdown-reading]').hidden = !reading;
    reader.querySelector('[data-markdown-raw]').hidden = reading;
    reader.querySelectorAll('[data-action="markdown-read-mode"]').forEach((button) => {
      const active = button.dataset.mode === mode;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
  }

  const main = document.getElementById('review-main');
  const navigator = document.getElementById('review-navigator');
  const inspector = document.getElementById('review-inspector');
  const modal = document.getElementById('center-modal');
  const toast = document.getElementById('center-toast');
  const runStages = ['建立相关业务链', '检查需求与实现', '寻找反证与保障', '形成有边界的结论'];
  let state = createCenterState('fresh');
  let runGeneration = 0;
  let fileReadGeneration = 0;
  let toastTimer;

  function notify(message, warning = false) {
    clearTimeout(toastTimer);
    toast.textContent = message;
    toast.className = `toast${warning ? ' warning' : ''}`;
    toast.hidden = false;
    toastTimer = setTimeout(() => { toast.hidden = true; }, 6000);
  }

  function findingBadges(finding) {
    const [label, tone] = statusLabel(finding);
    return `<span class="mono">${finding.id}</span>${badge(typeLabels[finding.type], finding.type === 'reasonable' ? 'green' : finding.type === 'question' ? 'amber' : 'red')}${badge(label, tone, true)}${!finding.resolved && finding.critical ? badge('关键', 'amber') : ''}`;
  }

  function getFindings() {
    return state.hasResults ? state.findings : [];
  }

  function currentFeedback() {
    if (state.center.navigator !== 'feedback') return null;
    return feedback.session(state)?.items.find((item) => item.id === state.center.feedbackId) || null;
  }

  function showFeedback(id) {
    syncFeedbackContext(state);
    const current = feedback.session(state);
    if (modal.open) modal.close();
    if (current) selectFeedback(state, id || current.items.find((item) => item.id === state.center.feedbackId)?.id || current.items.find((item) => !item.isResolved)?.id || current.items[0].id);
    else Object.assign(state.center, { navigator: 'feedback', feedbackId: null, stage: 'review' });
    render(false);
  }

  function feedbackScopeLink() {
    const current = feedback.session(state);
    if (!current) return '<button class="text-button feedback-scope-link" data-action="feedback-link">关联 PR 反馈（可选）</button>';
    const unresolved = current.items.filter((item) => item.kind === 'thread' && !item.isResolved).length;
    return `<button class="text-button feedback-scope-link" data-action="feedback-open">${current.syncStatus === 'ready' ? `${unresolved} 个待解决会话 · PR 反馈` : '反馈同步失败 · 查看'}</button>${!scopeState(state).pr ? '<button class="text-button feedback-scope-link" data-action="feedback-link">更改关联</button>' : ''}`;
  }

  function renderFeedbackList() {
    const current = feedback.session(state);
    if (!current) return `<div class="feedback-empty"><h3>尚未关联 PR</h3><p>当前分支不会自动猜测对应 PR。显式关联只读取反馈，不改变代码审查范围。</p><button class="button small" data-action="feedback-link">选择关联 PR</button></div>`;
    const search = state.center.search.toLowerCase();
    const items = current.items.filter((item) => {
      const newMessage = item.reviewerRevision > 0 && !feedback.readiness(state, item.id).analyzed;
      const handled = (item.isResolved || item.local.handled) && !newMessage;
      return (state.center.feedbackFilter === 'all' || (state.center.feedbackFilter === 'done' ? handled : !handled))
        && `${item.title} ${item.topic} ${item.comments.map((comment) => `${comment.author} ${comment.body}`).join(' ')}`.toLowerCase().includes(search);
    });
    const ready = feedback.readyFixes(state).length;
    return `<div class="feedback-nav-tools"><p>演示 PR ${escape(current.context.prId)} · ${current.items.length} 项反馈 / ${current.items.reduce((count, item) => count + item.comments.length, 0)} 条公开消息</p>
      <label class="sr-only" for="feedback-filter">反馈筛选</label><select id="feedback-filter" class="text-field">${[['open', '需处理 / 新回复'], ['all', '全部反馈'], ['done', '已处理 / 已解决']].map(([value, label]) => `<option value="${value}" ${state.center.feedbackFilter === value ? 'selected' : ''}>${label}</option>`).join('')}</select>
      <div><button class="text-button" data-action="feedback-refresh">刷新演示快照</button><button class="text-button" data-action="feedback-assess-all">批量分析（演示）</button></div>
      ${ready ? `<button class="button small" data-action="feedback-batch">批量预览已验证修复（${ready}）</button>` : ''}
      ${current.syncStatus !== 'ready' ? '<p class="input-error" role="alert">同步失败，旧记录仍保留，不能据此发布或解决。</p>' : '<p class="form-hint">完整预设快照 · 未读取真实 GitHub</p>'}</div>
      ${[...new Set(items.map((item) => item.topic))].map((topic) => `<div class="nav-group-title">${escape(topic)}</div>${items.filter((item) => item.topic === topic).map((item) => `<button class="feedback-card ${state.center.feedbackId === item.id ? 'active' : ''}" data-action="feedback-select" data-id="${item.id}" aria-pressed="${state.center.feedbackId === item.id}"><span class="feedback-card-meta">${item.id} · ${feedback.kindLabels[item.kind]}${item.isOutdated ? ' · Outdated' : ''}</span><strong>${escape(item.title)}</strong><small>${escape(feedback.status(state, item))}</small><span>${badge(item.kind === 'thread' ? item.isResolved ? 'Resolved' : '未解决' : '无 Resolve', item.isResolved ? 'blue' : '')}${item.reviewerRevision > 0 && !feedback.readiness(state, item.id).analyzed ? badge('有新回复', 'amber') : ''}</span></button>`).join('')}`).join('') || '<p class="small-copy">没有匹配项；不代表其他筛选或未同步部分没有反馈。</p>'}
      <div class="mini-principle">Review 总体状态：${escape(current.reviewState)}。解决会话不等于 Reviewer 批准，也不自动撤销 Request changes。</div>`;
  }

  function feedbackComment(comment) {
    return `<article class="feedback-comment"><div><strong>${escape(comment.author)}</strong>${badge(comment.isToolReply ? '本工具回复 · 模拟已发布' : '原始讨论', comment.isToolReply ? 'blue' : '')}${comment.quotedCommentId ? badge('引用回复 · 非 thread') : ''}${comment.edits?.length ? badge(`已编辑 ${comment.edits.length} 次`) : ''}</div><div class="markdown-body">${markdown.render(comment.body)}</div></article>`;
  }

  function renderFeedbackOverview() {
    const item = currentFeedback();
    const current = feedback.session(state);
    return `<div class="editor-tabs"><div class="editor-tab active">${icon('message')}PR 反馈<span class="tab-kind">原文与上下文</span></div></div><div class="editor-scroll feedback-overview">
      <h1>${item ? escape(item.title) : '选择 PR 反馈'}</h1><p class="small-copy">${current ? `${escape(current.context.repositoryName)} · 演示 PR ${escape(current.context.prId)} · ${escape(current.context.headRef)}` : '尚未关联 PR，不自动猜测或读取。'}</p>
      ${item ? `<div class="inline-notice blue">${icon('info')}<div><strong>${feedback.kindLabels[item.kind]} · 不伪造代码行或 Resolve</strong><p>发布时引用原评论；本地已回复不改变整份 Review 状态。</p></div></div>${feedbackComment(item.comments[0])}<button class="button small" data-action="source" data-source="${scopeState(state).files[0]}">阅读当前范围示例代码</button>` : '<p class="small-copy">分支模式需要明确关联 Repository 与 head 分支匹配的 PR。准备阶段仍然只有三块。</p><button class="button" data-action="feedback-link">关联 PR</button>'}
      <p class="form-hint">所有讨论、账号、ID 与发布结果均为虚构；原型不读取或写入真实 GitHub。</p></div>`;
  }

  function publicationLabel(operation) {
    const labels = { published: '回复已模拟发布，尚未 Resolve', resolved: '已模拟发布并 Resolve', 'reply-failed': '回复发布失败，未 Resolve', 'resolve-failed': '回复已发布，但 Resolve 失败', pending: '回复仍在未发布的 Review 草稿中', unknown: '发布结果未知，禁止重复发送', 'not-published': '回读明确未发布，可重新预览' };
    return labels[operation.status] || '发布状态需要核对';
  }

  function renderFeedbackInspector() {
    const item = currentFeedback();
    if (!item) return `<div class="inspector-heading">PR 反馈</div><div class="inspector-scroll"><div class="empty-state">${icon('message')}<h2>先明确关联 PR</h2><p>不会把当前分支自动绑定到某个 PR。</p><button class="button" data-action="feedback-link">选择关联 PR</button></div></div>`;
    const current = feedback.session(state);
    const ready = feedback.readiness(state, item.id);
    const patch = !!state.center.patches[item.findingId];
    const operation = item.local.operation;
    const uncertain = ['pending', 'unknown'].includes(operation?.status);
    const importedSource = item.local.requirementSourceId ? sources.getSource(state, item.local.requirementSourceId) : null;
    let primary;
    if (current.syncStatus !== 'ready') primary = '<button class="button primary small" data-action="feedback-refresh">重新同步（演示）</button>';
    else if (uncertain) primary = `<button class="button primary small" data-action="feedback-check" data-id="${item.id}">核对发布状态（演示）</button>`;
    else if (item.isResolved) primary = `<button class="button small" data-action="feedback-reopen" data-id="${item.id}" ${item.canUnresolve ? '' : 'disabled'}>明确重新打开（演示）</button>`;
    else if (!ready.analyzed) primary = `<button class="button primary small" data-action="feedback-assess" data-id="${item.id}">分析这条反馈（演示）</button>`;
    else if (ready.canRetryResolve) primary = `<button class="button primary small" data-action="feedback-resolve" data-id="${item.id}">${operation?.status === 'resolve-failed' ? '仅重试 Resolve' : '解决会话'}（演示）</button>`;
    else if (item.strategy === 'fix' && !patch) primary = `<button class="button primary small" data-action="fix-preview" data-id="${item.findingId}" ${state.findings.some((finding) => finding.id === item.findingId) ? '' : 'disabled'}>查看示例修复</button>`;
    else if (item.strategy === 'fix' && !ready.verified) primary = `<button class="button primary small" data-action="feedback-verify" data-id="${item.id}">模拟验证</button>`;
    else if (item.strategy === 'fix' && !ready.delivered) primary = `<button class="button primary small" data-action="feedback-deliver" data-id="${item.id}">模拟提交并推送</button>`;
    else primary = `<button class="button primary small" data-action="feedback-preview" data-id="${item.id}">${feedback.ownReply(state, item) ? '更新本工具回复' : '预览回复'}</button>`;
    const showSecondary = ready.canGenerate && (ready.canRetryResolve || item.strategy === 'fix' && !ready.proofReady);
    const files = sourceFiles(state);
    return `<div class="inspector-heading"><span>Reviewer 反馈处置</span>${badge('模拟 · 未连接 GitHub', 'blue')}</div>
      <div class="inspector-scroll" id="feedback-inspector">
      <div class="feedback-states">${badge(feedback.kindLabels[item.kind])}${badge(item.kind === 'thread' ? item.isResolved ? 'Resolved' : '未解决' : '无 Resolve 状态', item.isResolved ? 'blue' : '')}${item.isOutdated ? badge('Outdated ≠ Resolved', 'amber') : ''}</div>
      <h2 class="inspector-title">${escape(item.title)}</h2><p class="form-hint">${escape(current.context.repositoryName)} / 演示 PR ${escape(current.context.prId)}<br>${item.source ? `${escape(files[item.source].path)} · 原评论 L${item.line}${item.isOutdated ? '（已过时，未自动重定位）' : '（演示锚点）'}` : 'PR 总体讨论，不绑定代码行'}</p>
      <section class="feedback-section"><h3>完整讨论 · ${item.comments.length} 条</h3>${item.comments.map(feedbackComment).join('')}</section>
      ${uncertain ? `<div class="feedback-notice amber" role="status"><strong>${publicationLabel(operation)}</strong><p>${operation.status === 'pending' ? '不擅自提交、替换或丢弃用户已有的 Pending Review；在外部明确发布后再同步。' : '先核对远端是否已发布，不能因超时就再次发送。'}当前没有 Resolve。</p></div>` : operation ? `<div class="feedback-notice ${operation.status.includes('failed') ? 'error' : 'blue'}" role="status"><strong>上次发布：${publicationLabel(operation)}</strong><p>当前会话状态以上方标记为准。Reply 与 Resolve 分步记录；Review 仍为 ${escape(current.reviewState)}。</p></div>` : ''}
      ${item.local.analysis ? `<section class="feedback-section"><h3>${feedback.decisions[item.local.analysis.decision]}${ready.analyzed ? ' · 预设分析' : ' · 已过期'}</h3><p class="small-copy">${escape(item.local.analysis.message)}</p><div class="feedback-related">${item.related.filter((key) => files[key]).map((key) => `<button class="text-button" data-action="source" data-source="${key}">${icon('link')}${escape(files[key].name)}</button>`).join('')}</div></section>` : '<p class="small-copy">先放到相关业务链中核实，不因 Reviewer 提出就直接接受或改代码。</p>'}
      ${item.strategy === 'fix' ? `<section class="feedback-section"><h3>修改、验证、交付分别记录</h3><ul class="feedback-checks"><li>${patch ? '浏览器示例补丁已应用' : '浏览器示例补丁未应用'}</li><li>${ready.verified ? '当前修改模拟验证通过 · 未运行测试/CI' : item.local.verification?.passed === false ? '上次模拟验证失败，不能宣称修复已完成' : '当前修改尚无有效模拟验证'}</li><li>${ready.delivered ? `${escape(item.local.delivery.commit)} → ${escape(item.local.delivery.headRef)}（仅演示）` : item.local.delivery?.success === false ? '上次模拟推送失败，不能将本地补丁当作已交付' : '尚未模拟推送到 PR head 分支'}</li></ul><p class="form-hint">同根因的 ${current.items.filter((entry) => entry.findingId === item.findingId && entry.strategy === 'fix').length} 个会话可复用一次修复与验证，但分别 Reply / Resolve。</p></section>` : ''}
      ${item.strategy === 'fix' && ready.analyzed && !patch && !state.findings.some((finding) => finding.id === item.findingId) ? '<p class="form-hint">当前代码范围没有对应的预设修复；可先说明进度，不能套用其他快照的补丁。</p>' : ''}
      ${item.strategy === 'requirement' ? `<section class="feedback-section"><h3>需求建议，不是已确认标准</h3><p class="small-copy">原评论只作为反馈保留。人工明确纳入后仍需回准备页确认，不能直接声称需求正确或已解决。</p><button class="button small" data-action="feedback-requirement" data-id="${item.id}" ${importedSource?.selected || current.syncStatus !== 'ready' ? 'disabled' : ''}>${importedSource ? importedSource.selected ? '已纳入材料，仍待核对' : '重新选入原需求材料' : '作为需求补充（待确认）'}</button></section>` : ''}
      ${ready.resolveReasons.length && !item.isResolved ? `<p class="form-hint">${escape(ready.resolveReasons[0])}</p>` : ''}
      <details class="feedback-identifiers"><summary>原始 ID 与目标</summary><p>会话 / 反馈：${escape(item.remoteId)}<br>原评论：${escape(item.rootCommentId)}<br>发布账号：${escape(state.feedback.viewer)}（演示）</p></details>
      <details class="feedback-history"><summary>完整处置记录 · ${item.local.history.length}</summary><ol>${item.local.history.map((entry) => `<li>${escape(entry)}</li>`).join('') || '<li>尚无处置记录。</li>'}</ol></details>
      <details class="feedback-demo-tools"><summary>演示异常与新消息</summary><div><button class="button small" data-action="feedback-new-comment" data-id="${item.id}">模拟 Reviewer 新回复</button>${item.kind === 'thread' ? `<button class="button small" data-action="feedback-permission" data-id="${item.id}">模拟${item.canResolve ? '失去' : '恢复'} Resolve 权限</button>` : ''}<button class="button small" data-action="feedback-sync-fail">模拟同步失败</button></div></details>
      <p class="verification-caption">代码、验证、推送、发布与 Resolve 全部为页面内模拟；不会访问 GitHub 或修改真实文件。普通评论与总体 Review 不伪装成可 Resolve 会话。</p></div>
      <div class="inspector-actions"><div class="inspector-action-row">${primary}${showSecondary ? `<button class="button small" data-action="feedback-preview" data-id="${item.id}" data-intent="${item.strategy === 'fix' && !ready.proofReady ? 'progress' : 'final'}">${feedback.ownReply(state, item) ? '更新本工具回复' : item.strategy === 'fix' && !ready.proofReady ? '先回复进度' : '回复预览'}</button>` : ''}${state.center.fixSnapshots[item.findingId] ? `<button class="button small" data-action="undo-fix" data-id="${item.findingId}">撤销示例修复</button>` : ''}</div><p>发布前预览确认；已回复不等于已解决，也不等于 Reviewer 批准。</p></div>`;
  }

  function issueNav(finding) {
    const [, tone] = statusLabel(finding);
    return `<button class="issue-nav ${finding.id === state.selectedFinding ? 'active' : ''}" data-action="finding" data-id="${finding.id}" aria-pressed="${finding.id === state.selectedFinding}"><span class="issue-dot ${tone}"></span><span><strong>${escape(finding.title)}</strong><small>${finding.id} · ${typeLabels[finding.type]}${finding.resolved ? ' · 已处理/排除' : finding.critical ? ' · 关键' : ''}</small></span></button>`;
  }

  function renderNavigator() {
    const activeChain = currentChain(state);
    const search = state.center.search.toLowerCase();
    const findings = getFindings().filter((finding) => `${finding.title} ${finding.source} ${finding.id}`.toLowerCase().includes(search));
    const sources = sourceFiles(state);
    let content;
    if (state.center.navigator === 'feedback') {
      content = renderFeedbackList();
    } else if (state.center.navigator === 'files') {
      content = `<div class="nav-group-title">审查对象与关联证据</div>${Object.values(sources).filter((file) => `${file.path} ${file.name}`.toLowerCase().includes(search)).map((file) => `<button class="file-nav ${state.center.file === file.key ? 'active' : ''}" data-action="source" data-source="${file.key}">${icon('file')}<span>${escape(file.name)}</span><small class="file-change">${['submit', 'restore', 'callback'].includes(file.key) ? 'M' : '·'}</small></button>`).join('')}<div class="mini-principle">文件是核实证据的入口，不是业务判断的边界。</div>`;
    } else if (state.center.navigator === 'findings') {
      content = `<div class="nav-group-title">待判断与确认缺陷 <span>${findings.filter((finding) => finding.type !== 'reasonable').length}</span></div>${findings.filter((finding) => finding.type !== 'reasonable').map(issueNav).join('') || '<div class="small-copy">没有匹配的有效结果。</div>'}<div class="nav-group-title" style="margin-top:18px">已排除的局部疑点</div>${findings.filter((finding) => finding.type === 'reasonable').map(issueNav).join('')}`;
    } else {
      content = `<div class="nav-group-title">围绕行为，而非文件 <span>${chains.filter((chain) => state.findings.some((finding) => chain.findings.includes(finding.id))).length} 条链路</span></div>${chains.map((chain) => {
        const members = findings.filter((finding) => chain.findings.includes(finding.id));
        if (search && !members.length && !chain.title.includes(search)) return '';
        const unresolved = members.filter((finding) => !finding.resolved).length;
        const defaultFinding = chain.findings.find((id) => state.findings.some((finding) => finding.id === id));
        if (!defaultFinding) return '';
        return `<button class="chain-card ${activeChain.id === chain.id ? 'active' : ''}" data-action="finding" data-id="${defaultFinding}" aria-pressed="${activeChain.id === chain.id}"><div class="chain-card-top">${icon('flow')}<span>${chain.title}</span>${badge(state.hasResults ? `${unresolved || members.length}` : '—', unresolved ? 'amber' : members.length && members.every((finding) => finding.status === 'dismissed') ? 'green' : '')}</div><p>${chain.description}</p></button>${activeChain.id === chain.id && state.hasResults ? `<div class="chain-members">${members.map(issueNav).join('')}</div>` : ''}`;
      }).join('')}<div class="mini-principle"><strong>精准，不等于只报小问题。</strong><br>同一份业务依据，同时支持缺陷发现和局部误报的推翻。</div>`;
    }
    return `<div class="navigator-heading"><span>审查导航</span><span class="muted">工作区</span></div><div class="nav-segments" role="tablist" aria-label="导航方式">${[['business', '业务', 'flow'], ['findings', '发现', 'bug'], ['feedback', 'PR反馈', 'message'], ['files', '文件', 'file']].map(([id, label, symbol]) => `<button class="nav-segment ${state.center.navigator === id ? 'active' : ''}" role="tab" aria-selected="${state.center.navigator === id}" data-action="navigator" data-tab="${id}">${icon(symbol)}${label}</button>`).join('')}</div><div class="navigator-search">${icon('search')}<input id="center-search" type="search" placeholder="搜索业务、问题、反馈或文件" aria-label="搜索导航内容" value="${escape(state.center.search)}"></div><div class="navigator-scroll ${state.center.navigator === 'business' ? 'business-nav' : state.center.navigator === 'feedback' ? 'feedback-nav' : ''}">${content}</div><div class="navigator-footer"><button class="baseline-link" data-action="stage" data-stage="prepare">${icon('file')}<div><strong>${state.mode === 'technical' ? '有限技术审查' : `需求基线 v${state.baselineVersion}`}</strong><small>${state.mode === 'technical' ? '需求一致性未评审' : `${state.requirements.length} 条需求 · ${state.baselineConfirmed ? '已确认' : '待人工确认'}`}</small></div>${icon('chevron')}</button><button class="scope-link" data-action="scope"><span>${scopeState(state).files.length} 个审查文件 · ${state.scopeReview.selection.kind === 'pr' ? 'PR' : '分支'}</span><span>查看范围</span></button></div>`;
  }

  function renderTop() {
    const gate = approvalGate(state);
    const scope = scopeState(state);
    const preparing = state.center.stage === 'prepare';
    document.getElementById('stage-navigation').innerHTML = stages.map(([id, label], index) => `${index ? '<span class="stage-divider" aria-hidden="true"></span>' : ''}<button class="stage-button ${state.center.stage === id ? 'active' : ''}" data-action="stage" data-stage="${id}" ${state.center.stage === id ? 'aria-current="step"' : ''}><span class="stage-index">${index === 0 && state.baselineConfirmed ? icon('check') : index + 1}</span>${label}</button>`).join('');
    document.getElementById('product-mark').innerHTML = icon('shield');
    document.getElementById('repository-context').textContent = `${scope.repository.name} · 演示 Repository`;
    document.querySelector('.command-actions [data-action="help"]').innerHTML = icon('info');
    const dark = document.documentElement.dataset.theme === 'dark';
    document.getElementById('center-theme').innerHTML = icon(dark ? 'sun' : 'moon');
    document.getElementById('center-theme').setAttribute('aria-label', `切换为${dark ? '浅色' : '深色'}主题`);
    document.getElementById('center-reset').innerHTML = icon('refresh');
    document.getElementById('demo-scenario').value = state.scenario;
    const running = state.runStatus === 'running';
    const run = document.getElementById('run-review');
    run.hidden = preparing;
    run.disabled = running;
    run.innerHTML = `${icon(running ? 'refresh' : 'play', running ? 'spin' : '')}${running ? '模拟审查中' : state.stale ? '重审受影响链路' : ['partial', 'cancelled'].includes(state.runStatus) ? '继续审查' : state.runStatus === 'idle' ? '一键审查' : '重新审查'}`;
    document.getElementById('context-bar').innerHTML = `<div class="context-left"><button class="text-button branch-detail" data-action="scope">${icon('branch')}${escape(scope.pr ? `PR ${scope.pr.id}` : scope.head.name)}</button><span class="scope-detail">${icon('file')}${scope.files.length} 个审查文件 · ${scope.mode === 'full' ? '全量快照' : `相对 ${escape(scope.base.name)}`}</span>${badge(state.mode === 'technical' ? '需求未评审' : `需求 v${state.baselineVersion} · ${state.baselineConfirmed ? '已确认理解' : '待确认'}`, 'blue')}${state.stale ? badge('依据已变 · 待重审', 'amber') : ''}</div><div class="context-right"><span>${icon('check')}${runLabels[state.runStatus]}</span><button class="text-button ${gate.eligible ? 'ready' : ''}" data-action="stage" data-stage="conclusion">${icon(gate.eligible ? 'shield' : 'lock')}${gate.eligible ? '待人工结论' : gate.critical.length ? `${gate.critical.length} 项关键阻断` : '查看结论边界'} ${icon('arrow')}</button></div>`;
    document.getElementById('center-status').innerHTML = `<div class="status-left"><span>${icon('shield')}本地原型 · 不修改真实文件</span><span>${state.mode === 'technical' ? '需求一致性未评审' : '需求与实现双向校验'}</span></div><div class="status-right"><span>逻辑推演示例 · 未执行测试</span><span>模型未连接</span><button class="text-button" data-action="help">使用说明</button></div>`;
    document.querySelector('.review-shell').classList.toggle('focus-layout', state.center.focus && state.center.stage === 'review');
    document.querySelector('.review-shell').classList.toggle('prepare-layout', preparing);
  }

  function progressStrip() {
    if (state.runStatus === 'running') return `<div class="progress-strip" aria-live="polite">${icon('refresh', 'spin')}<strong>模拟步骤 ${Math.min(state.center.stageIndex + 1, 4)} / 4</strong><span>${runStages[Math.min(state.center.stageIndex, 3)]}</span><button class="text-button" data-action="cancel">取消</button></div>`;
    if (state.runStatus === 'cancelled') return `<div class="progress-strip">${icon('info')}模拟已取消，保留此前有效结果；不能据此完整通过。<button class="text-button" data-action="run">继续</button></div>`;
    if (state.stale) return `<div class="progress-strip">${icon('refresh')}依据已变化：旧结果仅供回看，不可直接用于结论。<button class="text-button" data-action="${state.mode === 'requirements' && !state.baselineConfirmed ? 'stage' : 'run'}" data-stage="prepare">${state.mode === 'requirements' && !state.baselineConfirmed ? '先确认需求' : '重审'}</button></div>`;
    if (state.sourceReview.limited) return `<div class="progress-strip">${icon('info')}自定义材料或变更条目尚未语义评审。原型只验证来源流程，旧示例发现保留作对照，不代表新基线已通过。</div>`;
    return '';
  }

  function syntax(text) {
    return text.split(/("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`[^`]*`|\/\/.*$|\b(?:export|async|await|function|return|if|throw|new|const|import|from|class|constructor|private|readonly|true|false|null)\b|\b\d+\b)/g).map((part) => {
      if (/^["'`]/.test(part)) return `<span class="syntax-string">${escape(part)}</span>`;
      if (part.startsWith('//')) return `<span class="syntax-comment">${escape(part)}</span>`;
      if (/^(?:export|async|await|function|return|if|throw|new|const|import|from|class|constructor|private|readonly|true|false|null)$/.test(part)) return `<span class="syntax-keyword">${part}</span>`;
      if (/^\d+$/.test(part)) return `<span class="syntax-number">${part}</span>`;
      return escape(part);
    }).join('');
  }

  function editorTabs(files) {
    const chain = currentChain(state);
    const item = currentFeedback();
    const primary = item ? item.source : primaryFiles[state.selectedFinding];
    const keys = [...new Set(item ? [primary, ...item.related, state.center.file] : currentFinding(state) ? [primary, ...chain.files, state.center.file] : [...scopeState(state).files, state.center.file])].filter((key) => files[key]);
    return `<div class="editor-tabs" role="tablist" aria-label="当前业务链关联文件">${keys.map((key) => `<button class="editor-tab ${state.center.file === key ? 'active' : ''}" role="tab" aria-selected="${state.center.file === key}" data-action="source" data-source="${key}">${icon(files[key].kind === 'code' ? 'code' : 'file')}${escape(files[key].name)}<span class="tab-kind">${key === primary ? '问题位置' : files[key].kind === 'document' ? '依据' : '关联'}</span></button>`).join('')}</div>`;
  }

  function journey() {
    const chain = currentChain(state);
    const nodes = chain.id === 'orders'
      ? [['cancel', '取消订单'], ['cancel', '释放占用'], ['restore', '恢复订单'], ['api', '履约前提']]
      : chain.id === 'payment'
        ? [['submit', '请求发起'], ['gateway', '超时语义'], ['payments', '再次支付'], ['callback', '结果回调']]
        : [['service', '服务执行'], ['job', '调度重试'], ['status', '状态展示'], ['decision', '适用边界']];
    return `<div class="editor-journey"><div class="journey-caption"><strong>${chain.title}</strong><span>业务链路 · 点击节点对照</span></div><div class="journey-nodes">${nodes.map(([key, label], index) => `${index ? '<span class="journey-arrow" aria-hidden="true">→</span>' : ''}<button class="journey-node ${state.center.file === key ? 'active' : ''} ${key === 'gateway' ? 'alert' : ''}" data-action="source" data-source="${key}"><small>0${index + 1}</small>${label}</button>`).join('')}</div></div>`;
  }

  function inlineFinding(finding) {
    if (!state.hasResults) return '';
    const [, tone] = statusLabel(finding);
    const label = finding.type === 'reasonable' ? '局部疑点已被全局证据推翻' : finding.resolved ? '当前示例已处置 · 未执行测试' : finding.type === 'question' ? '必要前提未证实，不是确认缺陷' : '这个位置，需要放到整条链路中判断';
    return `<div class="inline-finding ${tone}"><div class="inline-finding-head">${icon(finding.resolved ? 'shield' : finding.type === 'question' ? 'info' : 'bug')}<span>${finding.id} · ${label}</span></div><strong>${escape(finding.title)}</strong><p>${escape(finding.summary)}</p><div class="inline-finding-footer"><span>定位是入口，判断依赖完整上下文</span><button class="text-button" data-action="inspector-tab" data-tab="evidence">${icon('link')}对照证据与反证</button></div></div>`;
  }

  function relatedContext(files) {
    if (!currentFinding(state)) return '';
    const lookup = {
      'F-01': ['gateway', '“超时”不是支付失败的证明。', 'TIMEOUT = result unknown; the original request may still succeed.'],
      'F-02': ['cancel', '取消路径已经释放库存；恢复状态并不会自动恢复占用。', 'await tx.orders.markCancelled(order.id);\nawait tx.inventory.releaseReservation(order.id);'],
      'F-03': ['gateway', currentFinding(state).resolved ? '示例契约已补充稳定事件键与唯一约束，适用范围仍需保留。' : '必须知道重投事件键是否稳定，才能判断账本去重的覆盖范围。', currentFinding(state).resolved ? 'Example contract v2: stable event.id + unique ledger constraint.' : 'Stable event identity: not established by the original contract.'],
      'F-04': ['job', '重试由调度层统一承担。重复加在服务层会叠加尝试次数。', 'jobs.run(() => paymentService.submit(order), {\n  retry: { backoff: "exponential", attempts: 3 }\n});'],
      'F-05': ['decision', '展示缓存有明确的容忍度，也明确不用于不可逆决策。', 'Display only · maximum staleness: 30s\nNever use this cache to authorize payment.'],
    };
    const [key, explanation, snippet] = lookup[state.selectedFinding];
    return `<section class="related-context"><div class="related-heading"><span>${icon('link')}决定性上下文 · ${files[key].name}</span><button class="text-button" data-action="source" data-source="${key}">在主区对照 ${icon('arrow')}</button></div>${state.center.related ? `<div class="related-body"><p>${explanation}</p><pre>${escape(snippet)}</pre></div>` : ''}</section>`;
  }

  function renderEditor() {
    const item = currentFeedback();
    if (state.center.navigator === 'feedback' && (!item || !item.source && !state.center.feedbackReadSource)) return renderFeedbackOverview();
    const files = sourceFiles(state);
    const file = files[state.center.file];
    if (!file) throw new Error('找不到当前示例文件');
    const finding = item ? null : currentFinding(state);
    const source = state.center.codeView === 'source';
    let body;
    if (file.kind === 'document') {
      body = `<article class="document-copy"><p class="doc-kicker">${escape(file.sourceInfo || '需求 / 契约证据')} · ${file.userProvided ? '用户提供的原文快照 · 仅存页面内存' : '虚构原文 · 非实际仓库文件'}</p><h2>${escape(file.title)}</h2>${typeof file.markdownText === 'string' ? markdownReader(file.markdownText) : file.paragraphs.map(([line, text]) => `<div class="doc-paragraph ${line === file.highlight ? 'highlighted' : ''}"><span class="mono">L${line}</span><p>${escape(text)}</p></div>`).join('')}<div class="inline-notice blue">${icon('info')}<div><strong>阅读原文不会改写需求，也不代表已完成核查</strong><p>${item ? `右侧仍保留 ${item.id} 的反馈上下文。` : finding ? `右侧仍保留 ${finding.id} 的判断上下文。` : '当前范围尚无有效的审查发现。'}条目可能经过人工修订，不能把其表述当作这里的原文。</p></div></div></article>`;
    } else {
      const primary = !!finding && primaryFiles[state.selectedFinding] === file.key;
      const lines = file.lines.map((line, index) => `<div class="code-line ${source ? 'source-view' : ''} ${!source && line.change ? line.change : ''} ${(item ? item.source === file.key && !item.isOutdated && line.number === item.line : line.highlighted) ? 'emphasized' : ''}" id="sample-line-${line.number}">${source ? '' : `<span class="line-no">${line.change ? '' : line.number}</span>`}<span class="line-no">${line.number}</span><span class="change">${source ? '' : line.change === 'added' ? '+' : line.change === 'removed' ? '−' : ''}</span><code>${syntax(line.text) || ' '}</code></div>${primary && index === Math.min(file.lines.length - 1, file.lines.findIndex((item) => item.highlighted) + 2) ? inlineFinding(finding) : ''}`).join('');
      body = `<div class="code-caption"><span>旧 / 新行号 · ${source ? '当前源码' : '行内 Diff（预设差异）'}</span><strong>上下文片段 ${file.start}–${file.lines.at(-1).number} · 非完整文件</strong></div><div class="code-table">${lines}</div>${item ? '' : relatedContext(files)}`;
    }
    const context = item ? `<div class="feedback-location"><strong>${item.id} · ${escape(item.title)}</strong><span>${!item.source ? '此反馈没有代码行锚点，阅读代码不改变回复目标。' : item.isOutdated ? '原位置 Outdated；当前代码只作对照，未自动重定位。' : `原评论 L${item.line} · 演示锚点，不是模型推断位置。`}</span>${item.originalDiff ? `<button class="text-button" data-action="feedback-original" data-id="${item.id}">查看评论时的 Diff</button>` : ''}</div>` : finding ? journey() : '<div class="progress-strip">范围与阅读交互预览 · 无本次有效发现，片段不代表这个版本的完整源码。</div>';
    const footer = item ? `<span>右侧保留 ${item.id} · Reply 目标不会因阅读关联文件而改变</span><button class="text-button" data-action="feedback-select" data-id="${item.id}">回到评论位置</button><button class="text-button" data-action="next">下一反馈 · F8</button>` : `<span>${state.center.patches[state.selectedFinding] ? '示例补丁已应用 · 未执行验证' : '只读示例 · 不接触真实仓库'}</span>${finding ? `<button class="text-button" data-action="related">${state.center.related ? '收起' : '展开'}关联上下文</button><button class="text-button" data-action="recheck">${icon('refresh')}重审关联范围</button><button class="text-button" data-action="next">${icon('arrow')}下一问题 <span class="mono">F8</span></button>` : '<button class="text-button" data-action="stage" data-stage="prepare">返回准备阶段</button>'}`;
    return `<h1 class="sr-only">源码与证据审查</h1>${editorTabs(files)}<div class="editor-tools"><div class="editor-breadcrumb">${escape(scopeState(state).repository.name)} <span class="muted">/</span> <strong>${escape(file.path)}</strong></div><div class="editor-view-controls">${file.kind === 'code' ? `<button class="tiny-toggle ${!source ? 'active' : ''}" data-action="code-view" data-view="diff">Diff</button><button class="tiny-toggle ${source ? 'active' : ''}" data-action="code-view" data-view="source">源码</button>` : badge('需求 / 契约原文', 'blue')}<button class="icon-button focus-button" data-action="focus" aria-label="${state.center.focus ? '恢复业务导航' : '收起导航，专注代码'}" title="收起/恢复导航">${icon('focus')}</button></div></div>${progressStrip()}${context}<div class="editor-scroll">${body}</div><div class="editor-bottom">${footer}</div>`;
  }

  function requirementMarkup(requirement) {
    const included = requirement.include !== false;
    return `<article class="requirement-item ${included ? '' : 'excluded'}" data-understanding-id="${requirement.id}">
      <div class="requirement-item-head"><span class="rq-id">${requirement.id}</span><h3>${escape(requirement.title)}</h3>${badge(included ? requirement.basis === 'human' ? '人工补充 / 修订' : '原文明确要求' : '不适用', included ? 'blue' : '')}</div>
      <div class="markdown-body requirement-markdown">${markdown.render(requirement.text)}</div>
      ${!included ? `<p class="form-hint">排除原因：${escape(requirement.exclusionReason || '尚未说明')}</p>` : ''}
      <div class="requirement-item-footer"><button class="text-button origin-button" data-action="trace-requirement" data-id="${requirement.id}">${icon('link')}查看 ${requirement.origins?.length || 0} 处原文</button><span><button class="text-button" data-action="edit-requirement" data-id="${requirement.id}">${icon('edit')}修订</button><button class="text-button" data-action="${included ? 'exclude-requirement' : 'include-requirement'}" data-id="${requirement.id}">${included ? '不适用于本次审查' : '重新纳入'}</button></span></div>
      </article>`;
  }

  function renderSourceChoices() {
    return `<p class="small-copy">选择你希望本次参考的材料，选择立即生效。示例会区分其中的要求、事实与改动说明，无需给整份材料分类。</p>
      <div class="material-picker-list">${state.sources.map((source) => `<div class="material-picker-row"><label><input type="checkbox" name="material-selection" value="${source.id}" ${source.selected ? 'checked' : ''}><span><strong>${escape(source.name)}</strong><small>${sources.kindLabels[source.kind]} · ${escape(source.location)}</small>${source.kind === 'pr' ? '<small>仅明确的验收片段进入要求；改动摘要不反推为需求。</small>' : ''}</span></label><button class="text-button" data-action="material" data-source-id="${source.id}">原文</button></div>`).join('')}</div>
      <p class="form-hint" id="materials-count">${sources.selectedSources(state).length} 份材料已选入。预设快照明确标为演示；你选取的本地文本仅在浏览器读取，不上传。PR 描述不会因为选了 PR 就自动成为需求。</p>`;
  }

  function conflictMarkup(conflicts) {
    return conflicts.map((conflict) => `<div class="inline-notice source-conflict">${icon('alert')}<div><strong>${conflict.id} · ${escape(conflict.title)}（预设）</strong><p>${escape(conflict.detail)}</p><p class="form-hint">${conflict.left} ↔ ${conflict.right} · 确认基线不代表冲突已解决。</p></div></div>`).join('');
  }

  function renderCandidateDraft() {
    const preparation = preparationState(state);
    return `<p class="small-copy">这些要求来自选入材料的明确片段。可修正理解或说明不适用的原因；事实背景仍参与审查，不会因为没有生成要求就被忽略。</p>
      ${conflictMarkup(preparation.conflicts)}
      ${preparation.notices.map((notice) => `<div class="inline-notice blue">${icon('info')}<div><p>${escape(notice)}</p></div></div>`).join('')}
      ${state.sourceReview.draft?.removed.length ? `<div class="inline-notice">${icon('info')}<div><strong>旧条目 ${state.sourceReview.draft.removed.join('、')} 未在新材料中提取</strong><p>原文与历史仍保留，旧结论失效。已有关键问题不会自动消失。</p></div></div>` : ''}
      <div class="requirement-list understanding-details">${preparation.items.map(requirementMarkup).join('') || '<div class="candidate-empty"><strong>当前未形成明确的审查要求</strong><p>可以直接开始技术审查；不会声称需求已满足。也可以补充一条明确要求。</p></div>'}</div>
      ${understandingExtras(preparation, true)}
      <p class="form-hint">原型只运行预设映射，不对自定义文本执行模型分析。确认依据不等于证明其逻辑或实现正确。</p>`;
  }

  function renderScopeSelection() {
    const scope = scopeState(state);
    const selection = state.scopeReview.selection;
    const disabled = state.runStatus === 'running' ? 'disabled' : '';
    const branchOptions = (value, omit = '') => branches.map((branch) => `<option value="${escape(branch.name)}" ${branch.name === value ? 'selected' : ''} ${branch.name === omit ? 'disabled' : ''}>${escape(branch.name)}</option>`).join('');
    return `<div class="scope-form">
      <label class="scope-field" for="scope-repository"><span>Repository</span><select id="scope-repository" class="text-field" ${disabled}>${repositories.map((repository) => `<option value="${repository.id}" ${repository.id === selection.repository ? 'selected' : ''}>${repository.name}</option>`).join('')}</select></label>
      <fieldset class="scope-kind"><legend>审查对象</legend><div>${[['pr', 'PR'], ['branch', '分支']].map(([value, label]) => `<label><input type="radio" name="scope-kind" value="${value}" ${selection.kind === value ? 'checked' : ''} ${disabled}><span>${label}</span></label>`).join('')}</div></fieldset>
      ${selection.kind === 'pr'
        ? `<label class="scope-field scope-wide" for="scope-pr"><span>PR</span><select id="scope-pr" class="text-field" ${disabled}>${scope.repository.prs.map((pr) => `<option value="${pr.id}" ${selection.pr === pr.id ? 'selected' : ''}>PR ${pr.id} · ${pr.title}</option>`).join('')}</select></label>`
        : `<label class="scope-field" for="scope-branch"><span>被审查分支</span><select id="scope-branch" class="text-field" ${disabled}>${branchOptions(selection.branch)}</select></label><label class="scope-field" for="scope-mode"><span>分支范围</span><select id="scope-mode" class="text-field" ${disabled}><option value="changes" ${selection.mode === 'changes' ? 'selected' : ''}>分支变更（默认）</option><option value="full" ${selection.mode === 'full' ? 'selected' : ''}>分支全量代码</option></select></label>${selection.mode === 'changes' ? `<label class="scope-field scope-wide" for="scope-base"><span>比较基线</span><select id="scope-base" class="text-field" ${disabled}>${branchOptions(selection.base, selection.branch)}</select></label>` : ''}`}
      </div><p class="scope-caption">${icon('branch')}<span>${escape(scope.head.name)}${scope.base ? ` → ${escape(scope.base.name)}` : ' · 全量快照，不以 Diff 定义范围'}<strong>${scope.files.length} 个审查文件 · 整文件及相关业务链核查</strong>${feedbackScopeLink()}</span></p>
      <p class="form-hint">${scope.pr ? '文件来自 PR 演示变更列表；描述不自动成为需求。' : scope.mode === 'full' ? '所选分支的全量演示清单，不实际扫描仓库。' : '文件来自分支相对基线的演示差异，不限于新增行。'} ${!scope.supportsFindings ? '此范围暂无预设分析结果。' : '未连接真实仓库。'}</p>
      ${state.scopeReview.discardedResults || state.scopeReview.reincluded ? `<p class="form-hint scope-changed">范围已变更：旧发现与补丁不再沿用，需求需重新核对适用范围。${state.scopeReview.reincluded ? `旧范围 ${state.scopeReview.reincluded} 项不适用记录已归档并重新纳入，不静默跳过。` : ''}</p>` : ''}`;
  }

  function understandingExtras(preparation, expanded = false) {
    if (!preparation.checks.length && !preparation.questions.length) return '';
    const pending = preparation.questions.filter((item) => item.status !== 'clarified');
    const clarified = preparation.questions.filter((item) => item.status === 'clarified');
    return `<details class="understanding-extras" ${expanded ? 'open' : ''}><summary>推导检查点 ${preparation.checks.length} 项 · 待核实前提 ${pending.length} 项${clarified.length ? ` · 已澄清 ${clarified.length} 项（演示）` : ''}</summary>
      ${preparation.checks.length ? `<h3>推导检查点 · 不新增验收门槛</h3><ul>${preparation.checks.map((item) => `<li><span class="mono">${item.requirement}</span> ${escape(item.text)}</li>`).join('')}</ul>` : ''}
      ${pending.length ? `<h3>待核实 · 确认后仍需验证</h3><ul>${pending.map((item) => `<li><span class="mono">${item.requirement}</span> ${escape(item.text)}</li>`).join('')}</ul>` : ''}
      ${clarified.length ? `<h3>已在当前预设裁决中澄清 · 非真实验证</h3><ul>${clarified.map((item) => `<li><span class="mono">${item.requirement}</span> ${escape(item.text)}</li>`).join('')}</ul>` : ''}
      <p class="form-hint">这是预设整理示例，不是需求正确性结论。未知可在审查中核实，只有影响关键判断的未决项才限制批准。</p></details>`;
  }

  function renderPrepare() {
    const preparation = preparationState(state);
    const selected = sources.selectedSources(state);
    return `<div class="prepare-scroll simple-prepare">
      <div class="stage-eyebrow">01 / PREPARE <span>确定代码对象，提供依据，核对理解</span></div>
      <h1 class="stage-title">准备一次审查</h1><p class="stage-description">选择 Repository 与 PR / 分支，提供需求材料，再确认本次理解并开始。</p>
      <section class="preparation-card"><div class="prepare-section-title"><h2><span class="preparation-number">1</span>选择审查对象</h2><button class="text-button" data-action="scope">查看范围 ${icon('arrow')}</button></div>
      ${renderScopeSelection()}</section>
      <section class="preparation-card"><div class="prepare-section-title"><h2><span class="preparation-number">2</span>提供需求依据 <small>可选</small></h2><button class="text-button" data-action="materials">${selected.length ? '管理材料' : '示例材料'} ${icon('arrow')}</button></div>
      <div class="material-input-actions"><button class="button small" data-action="paste-material">${icon('edit')}粘贴内容</button><button class="button small" data-action="link-material">${icon('link')}读取链接</button><button class="button small" data-action="file-material" ${state.sourceReview.readingFile ? 'disabled' : ''}>${icon('file')}${state.sourceReview.readingFile ? '读取中…' : '读取本地文件'}</button><button class="text-button" data-action="use-example-materials">载入示例需求</button></div>
      <input type="file" id="requirement-file" accept=".md,.markdown,.txt,text/markdown,text/plain" hidden>
      <p class="form-hint">可组合添加；文本支持 Markdown。本地文件只在浏览器读取，不上传；链接读取在原型中仅提供演示快照。</p>
      <div class="compact-materials">${selected.map((source) => `<button class="material-chip" data-action="material" data-source-id="${source.id}">${icon(source.kind === 'pr' ? 'branch' : source.kind === 'link' ? 'link' : 'file')}<span>${escape(source.name)}</span>${badge(source.userProvided && !source.demoRecognized ? '待分析' : '演示', source.userProvided && !source.demoRecognized ? 'amber' : '')}</button>`).join('')}</div></section>
      <section class="preparation-card"><div class="prepare-section-title"><h2><span class="preparation-number">3</span>AI 对本次需求的理解</h2><button class="text-button" data-action="understanding">详情与修改 ${icon('arrow')}</button></div>
      ${preparation.requirements.length ? `<p class="${preparation.summary ? 'understanding-intent' : 'small-copy'}">${preparation.summary ? escape(preparation.summary) : preparation.needsConfirmation ? '以下为材料中的检查清单 / 验收条件（演示）；请核对是否准确表达本次目标。' : '沿用已确认且未变化的理解，不需要重复确认。'}</p><ul class="understanding-summary" aria-label="检查清单与验收条件">${preparation.requirements.map((item) => `<li>${icon('file')}<span><strong>${escape(item.title)}</strong><small>${escape(item.origins.map((origin) => sources.labelOrigin(state, origin)).join('；'))}</small></span>${badge(item.basis === 'human' ? '人工补充 / 修订' : '原文明确要求', 'blue')}</li>`).join('')}</ul>${understandingExtras(preparation)}` : `<p class="small-copy">${selected.length ? '材料原文已保留；自由文本尚待模型分析，不把“未分析”当作“没有要求”。' : '添加需求材料后自动形成理解；可载入示例体验检查清单。'}没有明确要求也可开始技术审查，但会注明“需求一致性未评审”。</p>`}
      ${preparation.conflicts.length ? `<div class="preparation-warning">${icon('alert')}<span>${preparation.conflicts.length} 项材料冲突将保留在审查中，不能直接批准。</span><button class="text-button" data-action="understanding">查看</button></div>` : ''}
      ${preparation.notices.length ? `<p class="form-hint analysis-pending">${preparation.notices.length} 份材料尚待模型分析或重新提取；不会声称需求已满足。详情中可查看原因或补充明确要求。</p>` : ''}
      ${preparation.reasons.length ? `<div class="inline-notice" role="status">${icon('info')}<div><strong>${escape(preparation.reasons.join('；'))}</strong><button class="text-button" data-action="understanding">在详情中处理</button></div></div>` : ''}
      </section>
      <div class="simple-prepare-footer"><p>${preparation.needsConfirmation ? '确认的是理解准确、适用于当前代码快照；不代表需求一定正确。审查仍双向验证需求与实现。' : preparation.mode === 'technical' ? '本次需求一致性未评审；已知关键未决项仍会限制最终通过。' : '当前理解与代码范围未变化，可直接开始。'}<small>仓库与 AI 为演示；自定义内容不做真实语义分析，输入仅存页面内存。</small></p><button class="button primary" id="prepare-start" data-action="prepare-start" ${preparation.canStart ? '' : 'disabled'}>${icon('play')}${preparation.label}</button></div>
      </div>`;
  }

  function materialsDialog() {
    openModal('管理需求与背景材料', `<div class="modal-body">${renderSourceChoices()}</div>`, '<button class="button" data-action="paste-material">粘贴内容</button><button class="button" data-action="link-material">读取链接</button><button class="button primary" data-action="close">完成</button>');
  }

  function scopeDialog() {
    const scope = scopeState(state);
    const files = sourceFiles(state);
    const current = state.hasResults && state.scopeReview.lastRunKey === scope.key;
    const status = current ? state.runStatus === 'completed' ? '预设核查完成' : '仅示例对照' : state.runStatus === 'running' ? '核查中（模拟）' : '待核查';
    const related = [
      ['cancel', '与恢复路径共享订单及库存状态'],
      ['service', '支付提交的服务实现'],
      ['job', '核对是否由调度层统一负责重试'],
      ['api', '核对调用方是否已经建立库存保障'],
      ['status', '核对展示状态与扣款判断的职责边界'],
      ['gateway', '核对超时与回调重投的通道契约'],
      ['decision', '核对展示缓存的业务容忍与使用限制'],
    ].filter(([key]) => !scope.files.includes(key));
    const row = (key, reason, label) => `<button class="source-pill scope-file" data-action="scope-source" data-source="${key}">${icon(files[key].kind === 'code' ? 'code' : 'file')}<span>${escape(files[key].path)}<small>${escape(reason)}</small></span>${badge(label, label === '仅示例对照' ? 'amber' : '')}</button>`;
    const limits = [];
    if (!scope.supportsFindings) limits.push('此代码范围只有演示清单，未执行分析；没有此快照的预设发现，不能以其他范围的结果替代。');
    if (state.sourceReview.limited) limits.push('自定义材料或变更条目尚未真实语义评审，现有预设发现仅供对照，不能完整批准。');
    if (state.scenario === 'partial' && state.runStatus === 'partial') limits.push('预设场景中通道契约读取受限，回调幂等前提仍无法核实。');
    openModal('审查范围', `<div class="modal-body"><p><strong>${escape(scope.repository.name)}</strong><br>${escape(scope.label)}</p>
      <p class="form-hint">代码 ${escape(scope.head.version)}${scope.base ? ` · 基线 ${escape(scope.base.name)} (${escape(scope.base.version)})` : ' · 全量快照，无比较基线'} · 演示快照 ${state.scopeReview.selection.snapshot}。以下均为虚构位置与片段，不是真实仓库清单。</p>
      <h3 class="scope-group-title">本次审查 · ${scope.files.length} 个文件</h3>${scope.files.map((key) => row(key, scope.reason, status)).join('')}
      <h3 class="scope-group-title">关联核查</h3>${scope.supportsFindings && (current || state.runStatus === 'running') ? related.map(([key, reason]) => row(key, reason, '预设关联')).join('') : '<p class="small-copy">开始审查后按具体判断确定关联范围，不提前宣称已建立完整业务链。</p>'}
      ${limits.length ? `<section class="scope-limits"><h3>覆盖限制</h3><ul>${limits.map((text) => `<li>${escape(text)}</li>`).join('')}</ul></section>` : ''}
      <p class="form-hint">已读取不等于验证正确。相关内容可支持跨文件发现，但不会因读取就被视为已完成整文件审查；不自动扩大为全仓扫描。</p></div>`,
    '<button class="button" data-action="simulate-code-change">模拟新提交</button><button class="button primary" data-action="close">关闭</button>');
  }

  function understandingDialog() {
    openModal('本次审查理解 · 详情与修改', `<div class="modal-body">${renderCandidateDraft()}</div>`, '<button class="button" data-action="add-explicit-requirement">补充明确要求</button><button class="button primary" data-action="close">完成</button>');
  }

  function evidenceTarget(finding, index) {
    if (finding.id === 'F-01' && finding.type === 'implementation') return index === 0 ? 'payments' : 'submit';
    const lookup = { 'F-01': ['payments', 'gateway'], 'F-02': ['cancel', 'api'], 'F-03': ['gateway'], 'F-04': ['job'], 'F-05': ['decision'] };
    return lookup[finding.id][index] || primaryFiles[finding.id];
  }

  function renderJudgment(finding) {
    const requirement = state.requirements.find((item) => item.id === finding.requirement);
    return `${state.center.patches[finding.id] ? `<div class="inline-notice blue">${icon('info')}<div><strong>示例补丁已应用，尚未执行验证</strong><p>下方保留原始发现及依据用于对照，不代表修复后仍复现同一故障。</p></div></div>` : ''}<section class="inspector-section"><div class="section-heading"><h3>${icon('file')}${requirement ? `需求依据 · ${requirement.id}` : '判断依据'}</h3>${requirement ? `<button class="text-button" data-action="source" data-source="${requirement.id === 'RQ-03' ? 'orders' : 'payments'}">对照原文</button>` : ''}</div><blockquote class="quote"><div class="markdown-body">${markdown.render(requirement?.text || (state.mode === 'technical' ? '当前可证实的调用路径和返回值契约；不引用未提供的业务需求。' : '相关入口与调用关系、已确认的职责分层和适用边界。'))}</div><small>${requirement ? '人工确认的规范性依据；其事实前提仍接受验证' : '源码/契约是证据，不自动成为业务需求'}</small></blockquote></section><section class="inspector-section"><div class="section-heading"><h3>${icon('flow')}${state.center.patches[finding.id] ? '原始问题的行为路径' : '把行为串起来'}</h3></div><ol class="reasoning">${finding.steps.map((step) => `<li>${escape(step)}</li>`).join('')}</ol></section><section class="inspector-section"><div class="section-heading"><h3>${icon(finding.type === 'reasonable' ? 'shield' : 'alert')}${finding.type === 'reasonable' ? '为什么不需要修改' : '实际影响与判断边界'}</h3></div><div class="impact-note ${finding.type === 'reasonable' ? 'green' : ''}">${escape(finding.impact)}</div></section><section class="inspector-section"><div class="section-heading"><h3>下一步应核实什么</h3><button class="text-button" data-action="inspector-tab" data-tab="evidence">证据与反证 ${icon('arrow')}</button></div><p class="small-copy">${finding.type === 'requirement' ? '先澄清需求中的错误前提；即使需求改了，实现仍需独立核对。' : finding.type === 'question' ? '明确缺失的契约与适用范围，不把资料不足包装成确定 Bug。' : finding.type === 'reasonable' ? '保留成立条件；新增入口或职责变化时重新评估，而不是永久忽略。' : '核查相关入口有没有替代保障；确认后只修复破坏契约的根因。'}</p></section>`;
  }

  function renderEvidence(finding) {
    return `<section class="inspector-section"><div class="section-heading"><h3>${icon('link')}支持当前判断的证据</h3></div>${finding.evidence.map((item, index) => `<article class="evidence-card"><div class="evidence-card-head">${icon('file')}<span>${escape(item.title)}</span></div><p>${escape(item.text)}</p><button class="evidence-link" data-action="source" data-source="${evidenceTarget(finding, index)}">${icon('link')}${escape(item.source)}</button></article>`).join('')}</section><section class="inspector-section"><div class="section-heading"><h3>${icon('shield')}主动寻找反证</h3>${badge('不是重复论证', 'blue')}</div>${finding.counter.map((item) => `<article class="evidence-card"><div class="evidence-card-head">${icon('search')}<span>${escape(item.title)}</span></div><p>${escape(item.text)}</p></article>`).join('')}</section><div class="inline-notice ${finding.type === 'reasonable' ? 'green' : 'blue'}">${icon('info')}<div><strong>${finding.type === 'reasonable' ? '候选已被推翻，不生成修复任务' : '证据不足就保留未知'}</strong><p>历史忽略、一次点赞、模型意见一致或单个测试通过，都不单独证明业务正确。</p></div></div>`;
  }

  function renderHistory(finding) {
    const history = state.history.filter((entry) => entry.includes(finding.id) || (finding.requirement && entry.includes(finding.requirement)));
    return `<section class="inspector-section"><div class="section-heading"><h3>${icon('message')}处置记录</h3></div>${history.map((entry) => `<article class="evidence-card"><p>${escape(entry)}</p></article>`).join('') || '<p class="small-copy">本次页面会话还没有相关操作。</p>'}<div class="inline-notice blue">${icon('info')}<div><strong>处置与成立性是两回事</strong><p>评论不解除关键阻断；人工接受补丁不等于测试通过；单次反馈不自动生成全局免责规则。</p></div></div></section>`;
  }

  function renderFindingInspector() {
    const finding = currentFinding(state);
    if (!state.hasResults || !finding) return `<div class="inspector-heading">尚无有效发现</div><div class="inspector-scroll"><div class="empty-state">${icon('search')}<h2>${scopeState(state).supportsFindings ? '先建立本次依据' : '此范围未执行分析'}</h2><p>${scopeState(state).supportsFindings ? '准备好后一次启动，不需要逐个文件点击。' : '仅演示选择范围与读取位置；没有此快照的预设分析，不能沿用其他范围的发现。'}当前预览片段不代表已完成审查，空列表不代表没有问题。</p><button class="button" data-action="stage" data-stage="prepare">查看准备阶段</button></div></div>`;
    const requirement = state.requirements.find((item) => item.id === finding.requirement);
    const originCaption = requirement
      ? `<div class="inspector-provenance"><span>${requirement.id} · ${requirement.origins?.length || 0} 处原文${requirement.manualRevision ? ' · 人工已修订表述' : ''}</span><button class="text-button" data-action="trace-requirement" data-id="${requirement.id}">${icon('link')}来源与版本</button></div>`
      : finding.requirement ? `<div class="inline-notice">${icon('info')}<div><strong>原需求 ${finding.requirement} 已不在当前基线</strong><p>此示例发现只供历史对照，不能将未纳入的需求伪装成当前依据。</p></div></div>` : '';
    const content = `${originCaption}${state.center.inspector === 'evidence' ? renderEvidence(finding) : state.center.inspector === 'history' ? renderHistory(finding) : renderJudgment(finding)}`;
    const patch = state.center.patches[finding.id];
    return `<div class="inspector-heading"><span>裁决上下文</span><button class="text-button" data-action="next">下一问题 ${icon('arrow')}</button></div><div class="inspector-scroll"><div class="issue-badges">${findingBadges(finding)}</div><h2 class="inspector-title">${escape(finding.title)}</h2><p class="inspector-summary">${escape(finding.summary)}</p><div class="origin-line">${icon('flow')}<span>${escape(finding.origin)}</span><span>·</span><span>${finding.severity === 'none' ? '不计入缺陷' : finding.severity === 'potential' ? '潜在高影响' : '高业务影响'}</span></div>${finding.disposition === 'commented' && !finding.resolved && finding.critical ? `<div class="inline-notice">${icon('lock')}<div><strong>已记录评论，关键项仍未闭合</strong><p>评论成功不是通过依据。</p></div></div>` : ''}${state.stale ? `<div class="inline-notice">${icon('refresh')}<div><strong>依据变化，当前裁决待重审</strong><p>不能继续引用旧裁决作为有效结论。</p></div></div>` : ''}<div class="inspector-tabs" role="tablist" aria-label="裁决详情">${[['judgment', '业务判断'], ['evidence', '证据与反证'], ['history', '处置']].map(([id, label]) => `<button class="inspector-tab ${state.center.inspector === id ? 'active' : ''}" role="tab" aria-selected="${state.center.inspector === id}" data-action="inspector-tab" data-tab="${id}">${label}</button>`).join('')}</div>${content}<p class="verification-caption">判断方式：预设逻辑推演。位置、原文与证据均为虚构。没有执行实际复现或测试。</p></div><div class="inspector-actions"><div class="inspector-action-row">${finding.type === 'requirement' ? `<button class="button primary small" data-action="edit-requirement" data-id="RQ-02">${icon('edit')}澄清并修订需求</button>` : finding.type === 'question' ? `<button class="button primary small" data-action="evidence">${icon('file')}补充契约证据</button>` : finding.type === 'implementation' ? `<button class="button primary small" data-action="fix-preview" data-id="${finding.id}">${icon('code')}${patch ? '查看已应用的示例' : '修复方案（示例）'}</button>${state.center.fixSnapshots[finding.id] ? `<button class="button small" data-action="undo-fix" data-id="${finding.id}">${icon('refresh')}撤销示例</button>` : ''}` : `<button class="button small" data-action="boundary" data-id="${finding.id}">${icon('message')}补充适用边界</button>`}${finding.type !== 'reasonable' ? `<button class="button small" data-action="comment" data-id="${finding.id}">${icon('message')}评论</button>` : ''}</div><p>${finding.type === 'requirement' ? '不把需求矛盾直接变成改代码任务。' : finding.type === 'question' ? '补充证据后仍需重审，不能直接判定成立或已排除。' : finding.type === 'reasonable' ? '已有保障一旦改变，这份结论就需要重新审查。' : patch ? '只改变浏览器内的示例，未运行测试。' : '保留修复与撤销能力，不修改真实工作区。'}</p></div>`;
  }

  function gateChecks() {
    const gate = approvalGate(state);
    return [
      [state.hasResults && state.scopeReview.lastRunKey === scopeState(state).key, '代码对象与快照一致', `${scopeState(state).repository.name} · ${scopeState(state).label}`],
      [state.mode === 'technical' || state.baselineConfirmed, '审查依据明确', state.mode === 'technical' ? '只评审技术范围，需求未验证' : `需求基线 v${state.baselineVersion}`],
      [!sources.sourceGate(state).reasons.length, '来源与规范性依据可追溯', sources.sourceGate(state).reasons.join('；') || '出处版本、用途与已确认基线一致'],
      [state.runStatus === 'completed', '必要范围完成', runLabels[state.runStatus]],
      [!state.stale, '结果仍与当前依据一致', state.stale ? '已变化，需重新审查' : '使用同一份演示快照'],
      [gate.critical.length === 0, '关键矛盾与前提已闭合', gate.critical.length ? `${gate.critical.length} 项仍未解决` : '非关键未知不单独阻断'],
      [!gate.reasons.some((reason) => reason.includes('实现缺陷')), '确认缺陷已按规则处置', '处置不等于执行验证通过'],
    ];
  }

  function renderConclusion() {
    const gate = approvalGate(state);
    const unresolved = getFindings().filter((finding) => !finding.resolved);
    const dismissed = getFindings().filter((finding) => finding.type === 'reasonable');
    const scope = scopeState(state);
    const boundary = !scope.supportsFindings
      ? '此范围未执行真实分析，也没有对应的预设发现；其他范围的结果未沿用，不能批准或提交伪造反馈。'
      : state.sourceReview.limited
      ? '自定义材料以及新增、编辑或排除条目没有真实语义评审；旧示例发现仅用于对照，不能声称已按新基线完整评审。'
      : state.runStatus === 'partial' ? '通道契约读取受限，不能宣称范围完整。' : '没有连接真实仓库，也没有执行测试。';
    return `<div class="editor-tabs"><div class="editor-tab active">${icon('shield')}审查结论<span class="tab-kind">人工决定</span></div><button class="editor-tab" data-action="stage" data-stage="review">${icon('code')}返回代码现场</button></div>
      ${progressStrip()}<div class="conclusion-scroll">
      <div class="stage-eyebrow">03 / CONCLUDE <span>提交反馈，不等于宣布一切正确</span></div>
      <h1 class="stage-title">${gate.eligible ? '条件已具备，结论仍由你决定' : '先说明哪些问题尚未闭合'}</h1>
      <p class="stage-description">${state.mode === 'technical' ? '本次只批准明确的技术范围，需求一致性未评审。' : '需求、实现和必要契约分别判断，不拿动作完成代替业务正确。'}</p>
      ${conflictMarkup(state.sourceReview.conflicts)}
      ${state.submission ? `<div class="inline-notice blue">${icon('check')}<div><strong>已在当前原型记录：${verdictLabels[state.submission.verdict]}</strong><p>没有写回 GitHub。新的依据或处置会使这份模拟记录失效。</p></div></div>` : ''}
      <div class="prepare-section">
        <section class="summary-box"><h2>${unresolved.length ? `${unresolved.length} 项仍需判断或处理` : '当前示例没有未处理项'}</h2>
        ${unresolved.map((finding) => `<button class="summary-row" data-action="finding" data-id="${finding.id}">${badge(finding.critical ? '关键' : '缺陷', finding.critical ? 'amber' : 'red')}<span><strong>${escape(finding.title)}</strong><p>${finding.disposition === 'commented' ? '已评论，但并未解除关键阻断。' : escape(finding.summary)}</p></span></button>`).join('') || '<p class="small-copy">这不是对代码无缺陷的保证；仍需理解范围与验证方式。</p>'}</section>
        <section class="summary-box"><h2>已排除的局部疑点</h2>${dismissed.map((finding) => `<button class="summary-row" data-action="finding" data-id="${finding.id}">${badge('合理取舍', 'green')}<span><strong>${escape(finding.title)}</strong><p>${escape(finding.summary)}</p></span></button>`).join('')}</section>
        <section class="summary-box"><div class="section-heading"><h2>来源与范围边界</h2><button class="text-button" data-action="scope">查看范围</button></div><p class="small-copy">${escape(scope.repository.name)} · ${escape(scope.label)}<br>${scope.files.length} 个审查文件，相关业务链按需核查；代码快照 ${escape(scope.head.version)} / 演示快照 ${state.scopeReview.selection.snapshot}。<br>${state.mode === 'technical' ? '需求一致性未评审，不代表业务需求已满足。' : `需求基线 v${state.baselineVersion}，${state.baselineConfirmed ? '人工已确认理解' : '仍待确认'}。确认不等于需求或其假设已证实。`}<br>${boundary}</p><div class="conclusion-sources">${sources.selectedSources(state).map((source) => `<button class="text-button origin-button" data-action="material" data-source-id="${source.id}">${icon('link')}${escape(source.name)} · ${sources.purposeLabels[source.purpose]} · v${source.version}</button>`).join('') || '<p class="form-hint">没有选入需求材料。</p>'}</div></section>
      </div>
      <section class="prepare-section summary-box"><div class="section-heading"><h2>PR 反馈与会话状态（演示）</h2><button class="text-button" data-action="feedback-open">查看反馈</button></div><pre class="summary-text">${escape(feedback.summary(state))}</pre><p class="form-hint">既有反馈的 Reply / Resolve 与提交新的 Review 是不同操作。是否允许合并由 GitHub 仓库规则决定；本地不伪造 Review 批准。</p></section>
      <section class="prepare-section"><label class="field-label" for="center-notes">人工补充</label><textarea class="textarea" id="center-notes" placeholder="补充业务判断、风险或需要协调的事项…">${escape(state.notes)}</textarea><p class="form-hint">仅保存在本次页面内存；切换独立场景或刷新会清除。</p></section>
      <section class="prepare-section"><div class="prepare-section-title"><h2>对外摘要预览</h2><button class="text-button" data-action="summary">${icon('download')}查看 / 复制 / 下载</button></div><pre class="summary-text" id="center-summary">${escape(summaryText(state))}</pre></section>
      </div>`;
  }

  function renderConclusionInspector() {
    const gate = approvalGate(state);
    const canSubmit = state.verdict === 'approve' ? gate.eligible && state.humanConfirmed : gate.feedbackAllowed;
    return `<div class="inspector-heading"><span>通过条件与提交</span>${badge(gate.eligible ? '待人工判断' : '不可直接通过', gate.eligible ? 'blue' : 'amber')}</div><div class="inspector-scroll">${gateChecks().map(([ok, title, detail]) => `<div class="gate-row ${ok ? 'ok' : ''}">${icon(ok ? 'check' : 'lock')}<div><strong>${title}</strong><p>${detail}</p></div></div>`).join('')}<div class="verdict-options" role="radiogroup" aria-label="选择审查结论">${[['approve', '通过当前范围', '需要条件满足并人工确认'], ['request-changes', '要求修改', '关键项未闭合也可以反馈'], ['comment', '仅评论', '保留未知，不代表通过']].map(([id, title, note]) => `<label class="verdict-option"><input type="radio" name="center-verdict" value="${id}" ${state.verdict === id ? 'checked' : ''} ${id === 'approve' && !gate.eligible ? 'disabled' : ''}><span><strong>${title}</strong><small>${note}</small></span></label>`).join('')}</div><label class="human-confirm"><input type="checkbox" id="center-human" ${state.humanConfirmed ? 'checked' : ''}><span>我已核对本次边界，理解原型未执行真实分析或测试。</span></label><p class="verification-caption">门禁只演示产品内提交约束，不设置 GitHub 分支保护，不保证所有缺陷均被发现。</p></div><div class="inspector-actions"><div class="inspector-action-row"><button class="button primary" id="center-submit" data-action="submit" ${canSubmit ? '' : 'disabled'}>${icon('message')}模拟提交${verdictLabels[state.verdict]}</button><button class="button small" data-action="summary">${icon('download')}摘要</button></div><p>不发送到任何外部服务，不持久化真实结论。</p></div>`;
  }

  function render(preserve = true) {
    syncFeedbackContext(state);
    const focused = document.activeElement;
    const focusId = focused?.id;
    const selection = focused instanceof HTMLInputElement && focused.type === 'search' ? [focused.selectionStart, focused.selectionEnd] : null;
    const positions = preserve ? Object.fromEntries(['.editor-scroll', '.inspector-scroll', '.navigator-scroll', '.prepare-scroll', '.conclusion-scroll'].map((selector) => [selector, document.querySelector(selector)?.scrollTop || 0])) : {};
    renderTop();
    navigator.innerHTML = state.center.stage === 'prepare' ? '' : renderNavigator();
    main.innerHTML = state.center.stage === 'prepare' ? renderPrepare() : state.center.stage === 'conclusion' ? renderConclusion() : renderEditor();
    inspector.innerHTML = state.center.stage === 'prepare' ? '' : state.center.stage === 'conclusion' ? renderConclusionInspector() : state.center.navigator === 'feedback' ? renderFeedbackInspector() : renderFindingInspector();
    for (const [selector, top] of Object.entries(positions)) {
      const element = document.querySelector(selector);
      if (element) element.scrollTop = top;
    }
    if (focusId) {
      const element = document.getElementById(focusId);
      if (element) {
        element.focus({ preventScroll: true });
        if (selection && element instanceof HTMLInputElement) element.setSelectionRange(...selection);
      }
    }
  }

  function stage(id) {
    if (!stages.some(([key]) => key === id)) throw new Error('未知审查阶段');
    state.center.stage = id;
    render(false);
  }

  function openSource(key) {
    if (!sourceFiles(state)[key]) throw new Error('示例证据位置不存在');
    state.center.file = key;
    state.center.stage = 'review';
    if (currentFeedback()) state.center.feedbackReadSource = true;
    render();
    const scroll = main.querySelector('.editor-scroll');
    if (scroll) scroll.scrollTop = 0;
  }

  function nextFinding() {
    if (state.center.navigator === 'feedback') {
      const items = feedback.session(state)?.items;
      if (!items?.length) return notify('请先明确关联 PR。', true);
      const index = items.findIndex((item) => item.id === state.center.feedbackId);
      return showFeedback(items[(index + 1) % items.length].id);
    }
    const findings = getFindings();
    if (!findings.length) return notify('请先完成模拟审查。', true);
    const index = findings.findIndex((finding) => finding.id === state.selectedFinding);
    selectFinding(state, findings[(index + 1) % findings.length].id);
    render(false);
  }

  function openModal(title, body, footer = '<button class="button" data-action="close">关闭</button>') {
    if (modal.open) modal.close();
    modal.innerHTML = `<div class="modal-header"><h2 id="center-modal-title">${title}</h2><button class="icon-button" data-action="close" aria-label="关闭对话框">${icon('close')}</button></div>${body}<div class="modal-footer">${footer}</div>`;
    modal.classList.toggle('markdown-dialog', !!modal.querySelector('[data-markdown-editor],[data-markdown-reader]'));
    modal.showModal();
  }

  function help() {
    openModal('三块准备，一次确认后审查', `<div class="modal-body"><p>准备：选择 Repository 与 PR / 分支，粘贴需求、提供链接或读取本地文件，核对 AI 理解后一次开始。分支变更明确比较基线，全量代码不以 Diff 定义范围。</p><p>AI 理解区区分原文要求、人工补充、推导检查点与待核实前提。确认的是理解准确，不是需求一定正确；正式审查仍双向验证需求与实现。</p><ul class="principle-list"><li><strong>合理取舍</strong><p>选择“重试与展示边界”，对照服务与调度层，查看局部疑点为何被推翻。</p></li><li><strong>跨文件缺陷</strong><p>选择“取消与库存恢复”，比较两条路径是否维持同一个库存契约。</p></li><li><strong>需求前提错误</strong><p>比较原文、超时语义与实现。修订需求后，旧代码仍可能需要修改。</p></li></ul><p class="form-hint">仓库、代码与结果均为预设。默认演示 PR 104 或对应分支变更可体验预设发现；其他范围仅展示选择和清单，不沿用旧结果。本地 UTF-8 Markdown / TXT 可实际读取，但不上传；链接只提供演示快照，自定义文本不进行真实 AI 分析。刷新清除输入，F8 跳转下一问题。</p><p class="form-hint">早期五页原型保留为 <a href="./concept.html" target="_blank" rel="noopener">概念参考</a>，不是当前交互方案。</p></div>`);
  }

  function sourceDetails(id, version) {
    const source = sources.getSource(state, id);
    const original = sources.snapshot(source, version || source.version);
    openModal(`${escape(source.name)} · 原文 v${original.version}`, `<div class="modal-body"><div class="source-detail-meta">${badge(sources.kindLabels[source.kind], 'blue')}${badge(source.selected ? sources.purposeLabels[source.purpose] : '未选入本次')}${badge(original.version === source.version ? '当前快照' : '历史快照', original.version === source.version ? 'blue' : 'amber')}</div><p class="form-hint">${escape(source.location)} · 可按 Markdown 阅读，也可切换原文核对行号与空白。</p>${markdownReader(original.text)}<p class="form-hint">这是独立保存的材料原文，不会随格式预览或需求修订而改变。链接仅支持 HTTP、HTTPS 与邮件；图片不自动加载。</p></div>`, `<button class="button" data-action="close">关闭</button>${source.snapshots.length > 1 ? `<button class="button" data-action="material" data-source-id="${id}" data-version="${original.version === 1 ? source.version : 1}">查看${original.version === 1 ? '当前' : '最初'}版本</button>` : ''}<button class="button" data-action="edit-source-snapshot" data-source-id="${id}">更新来源快照（演示）</button><button class="button primary" data-action="read-material" data-source-id="${id}">在主区看当前原文</button>`);
  }

  function traceRequirement(id) {
    const candidate = state.sourceReview.draft?.candidates.find((item) => item.id === id);
    const requirement = candidate || state.requirements.find((item) => item.id === id);
    if (!requirement) return notify('这个条目不在当前候选或基线中。', true);
    openModal(`${id} · 从哪里来的？`, `<div class="modal-body"><div class="source-detail-meta">${badge(requirement.manualRevision ? '人工修订' : requirement.originKind || '示例整理', 'blue')}${badge(candidate ? '待核对条目' : state.baselineConfirmed ? `基线 v${state.baselineVersion}` : '历史条目 · 未纳入新基线')}</div><h3 class="trace-heading">当前条目表述</h3><blockquote class="quote markdown-body">${markdown.render(requirement.text)}</blockquote><p class="form-hint">条目表述与原文独立。人工修订不替换下列逐字引用；引用存在也不证明需求假设正确。</p>${(requirement.origins || []).map((origin) => {
      const source = sources.getSource(state, origin.sourceId);
      const status = sources.originStatus(state, origin);
      return `<section class="trace-origin"><div class="trace-origin-heading"><strong>${escape(source.name)}</strong>${badge(status, status === '当前版本' ? 'blue' : 'amber')}</div><p class="form-hint">${escape(sources.labelOrigin(state, origin))} · ${sources.kindLabels[source.kind]}</p><blockquote class="quote raw-quote">${escape(origin.quote)}</blockquote><button class="text-button" data-action="material" data-source-id="${source.id}" data-version="${origin.version}">${icon('link')}查看引用时的原文 v${origin.version}</button></section>`;
    }).join('') || '<div class="inline-notice"><strong>缺少可核对的原文引用，不能当作已确认依据。</strong></div>'}</div>`);
  }

  function editSourceSnapshot(id) {
    const source = sources.getSource(state, id);
    openModal('更新来源快照 · 不修改真实文件', `<form id="source-snapshot-form"><div class="modal-body"><input name="source-id" type="hidden" value="${id}"><label class="field-label" for="source-snapshot-text">${escape(source.name)} · 当前 v${source.version}</label>${markdownEditor('source-snapshot-text', source.text, 12)}<p class="form-hint">保存后自动更新待核对列表，旧引用与原文仍保留。原型不分析自定义文本；未能提取的部分会明确提示，可通过人工输入提供需求。</p></div></form>`, '<button class="button" data-action="close">取消</button><button class="button primary" form="source-snapshot-form" type="submit">保存新快照并使旧结果失效</button>');
  }

  function editRequirement(id) {
    const requirement = preparationState(state).items.find((item) => item.id === id);
    if (!requirement) return notify('当前示例没有对应的需求条目。', true);
    openModal(`修订 ${id} · 不擅自改写需求`, `<form id="center-requirement-form"><div class="modal-body"><input name="requirement-id" type="hidden" value="${id}"><input id="center-preset" type="hidden" value="false"><label class="field-label" for="center-requirement-title">条目标题</label><input id="center-requirement-title" class="text-field" required value="${escape(requirement.title)}"><label class="field-label" for="center-requirement-text">需求与验收条件</label>${markdownEditor('center-requirement-text', requirement.text, 6)}<p class="form-hint">保存后旧结果失效，需确认基线并重审。确认新需求不能自动证明旧代码已满足。</p>${id === 'RQ-02' ? '<button type="button" class="button small" data-action="preset-requirement">填入示例：“超时保持未知”</button><p class="form-hint">该分支可演示：需求矛盾 → 需求已澄清 → 实现尚待对齐。自定义文本不会被原型假装理解。</p>' : ''}</div></form>`, '<button class="button" data-action="close">取消</button><button class="button primary" type="submit" form="center-requirement-form">保存修订并使旧结果失效</button>');
  }

  function materialInput(explicit = false) {
    openModal(explicit ? '补充一条明确要求' : '粘贴需求或业务背景', `<form id="center-source-form"><div class="modal-body">
      <input name="material-kind" type="hidden" value="${explicit ? 'requirement' : 'auto'}">
      <label class="field-label" for="center-source-name">${explicit ? '要求标题' : '材料名称（可选）'}</label><input class="text-field" id="center-source-name" ${explicit ? 'required' : ''} placeholder="${explicit ? '例如：退款不得超过实收金额' : '例如：本次业务背景'}">
      <label class="field-label" for="center-source-text">${explicit ? '你希望实现满足什么条件？' : '原文或补充说明'}</label>${markdownEditor('center-source-text')}
      ${explicit ? '' : '<button class="button small material-example" type="button" data-action="preset-material">填入演示需求（替换输入）</button>'}
      <p class="form-hint">${explicit ? '这是一条由你明确提供的要求，将直接加入本次理解，仍需点击主按钮确认并开始。' : '不需要先给材料分类。原型仅保留自由文本，不会伪造 AI 提取；明确要求可在“详情与修改”中补充。'}只在页面内存保存，不上传。</p>
      </div></form>`, '<button class="button" data-action="close">取消</button><button class="button primary" form="center-source-form" type="submit">保存</button>');
  }

  function linkInput() {
    openModal('读取需求链接', `<form id="requirement-link-form"><div class="modal-body"><label class="field-label" for="requirement-link">需求页面链接</label><input class="text-field" id="requirement-link" type="url" required placeholder="https://…"><p class="form-hint">正式产品需在授权范围内读取并保留原文快照。此离线原型不联网：只提供演示链接的固定快照，其他链接明确报错，不假装读取成功。</p><button class="button small material-example" type="button" data-action="preset-link">填入演示链接</button><p class="form-hint">${escape(sources.exampleLink)}</p><p id="requirement-link-error" class="input-error" role="alert" hidden></p></div></form>`, '<button class="button" data-action="close">取消</button><button class="button primary" form="requirement-link-form" type="submit">读取并加入（演示）</button>');
  }

  function feedbackLinkDialog() {
    const scope = scopeState(state);
    if (scope.pr) return showFeedback();
    const choices = scope.repository.prs.filter((pr) => pr.head === scope.head.name);
    openModal('明确关联 PR 反馈 · 不改变审查范围', `<form id="feedback-link-form"><div class="modal-body"><p>${escape(scope.repository.name)} / ${escape(scope.head.name)}</p><label class="field-label" for="feedback-linked-pr">只列出相同 Repository 与 head 分支的演示 PR</label><select class="text-field" id="feedback-linked-pr"><option value="">不关联 PR</option>${choices.map((pr) => `<option value="${pr.id}" ${state.center.linkedFeedbackPr === pr.id ? 'selected' : ''}>PR ${pr.id} · ${escape(pr.title)}</option>`).join('')}</select><p class="form-hint">${choices.length ? '关联仅用于读取和回复反馈，不改变本次代码范围，也不把评论自动纳入需求。' : '当前分支没有匹配的演示 PR，不会猜测其他 PR。'}</p></div></form>`, '<button class="button" data-action="close">取消</button><button class="button primary" form="feedback-link-form" type="submit">确认关联</button>');
  }

  function feedbackPreview(id, intent = 'final') {
    const item = feedback.get(state, id);
    const draft = feedback.makeDraft(state, id, intent);
    const ready = feedback.readiness(state, id);
    const current = feedback.session(state);
    const previous = feedback.ownReply(state, item);
    openModal('回复预览 · 不发送到真实 GitHub', `<form id="feedback-reply-form"><div class="modal-body">
      <input name="feedback-id" type="hidden" value="${id}"><input name="feedback-draft-id" type="hidden" value="${draft.id}">
      <p><strong>${escape(current.context.repositoryName)} / 演示 PR ${escape(current.context.prId)}</strong><br>${escape(item.title)}</p>
      <details class="feedback-identifiers"><summary>核对原会话与评论 ID</summary><p>${escape(item.remoteId)}<br>${escape(item.rootCommentId)}</p></details>
      <label class="field-label" for="feedback-reply-mode">发布方式</label><select class="text-field" id="feedback-reply-mode">${previous ? '<option value="update" selected>更新本工具自己已发布的回复</option>' : ''}<option value="append">追加${item.kind === 'thread' ? '原会话回复' : '引用原评论的新回复'}</option></select>
      ${previous ? `<details class="feedback-history"><summary>此前本工具已发布的回复 · 只读对照</summary><div class="markdown-body">${markdown.render(previous.body)}</div></details>` : ''}
      <label class="field-label" for="feedback-reply-text">回复内容 · 请核对修改、提交与验证边界</label>${markdownEditor('feedback-reply-text', draft.body, 7)}
      <label class="feedback-resolve-option"><input type="checkbox" id="feedback-resolve" ${ready.canResolve ? '' : 'disabled'}><span>回复发布后，同时解决此会话（模拟）</span></label>
      <p class="form-hint">${ready.canResolve ? '先确认回复已发布，再 Resolve 并回读状态；不是一个原子事务。' : escape(ready.resolveReasons.join('；'))}</p>
      <label class="field-label" for="feedback-publish-outcome">发布分支（演示，用于检查异常恢复）</label><select class="text-field" id="feedback-publish-outcome">${Object.entries(feedback.outcomes).filter(([key]) => key !== 'resolve-failed' || ready.canResolve).map(([value, text]) => `<option value="${value}">${text}</option>`).join('')}</select>
      <p class="form-hint">Pending Review 草稿不会自动提交、丢弃或替换。超时先核对结果；只更新本工具自己的回复，不改 Reviewer 原文。</p><p id="feedback-form-error" class="input-error" role="alert" hidden></p>
      </div></form>`, '<button class="button" data-action="close">保留草稿 / 返回</button><button class="button primary" form="feedback-reply-form" type="submit">确认模拟发布</button>');
  }

  function feedbackStepDialog(step, id) {
    const item = feedback.get(state, id);
    const current = feedback.session(state);
    const verify = step === 'verify';
    openModal(verify ? '验证分支 · 未执行真实测试' : '提交与推送分支 · 不执行 Git 命令', `<form id="feedback-step-form"><div class="modal-body"><input name="feedback-id" type="hidden" value="${id}"><input name="feedback-remote-id" type="hidden" value="${item.remoteId}"><input name="feedback-context" type="hidden" value="${escape(current.context.key)}"><input name="feedback-step" type="hidden" value="${step}">
      <p>${escape(item.title)}</p><p class="form-hint">${verify ? '演示正常恢复、取消后恢复及并发预留的验证记录；不能把模型推演当成测试通过。' : `目标为 ${escape(current.context.repositoryName)} / PR ${escape(current.context.prId)} 的 head 分支 ${escape(current.context.headRef)}，不是 main 或比较基线。演示修复快照不是实际 Git 提交。`}</p>
      <label class="field-label" for="feedback-step-result">${verify ? '模拟验证结果' : '模拟提交 / 推送结果'}</label><select class="text-field" id="feedback-step-result"><option value="success">${verify ? '验证通过（模拟）' : '推送成功（模拟）'}</option><option value="failed">${verify ? '验证失败（模拟）' : '推送失败（模拟）'}</option></select><p id="feedback-form-error" class="input-error" role="alert" hidden></p></div></form>`, '<button class="button" data-action="close">取消</button><button class="button primary" form="feedback-step-form" type="submit">记录演示结果</button>');
  }

  function feedbackCheckDialog(id) {
    const item = feedback.get(state, id);
    openModal('核对发布状态 · 不盲目重试', `<form id="feedback-check-form"><div class="modal-body"><input name="feedback-id" type="hidden" value="${id}"><input name="feedback-remote-id" type="hidden" value="${item.remoteId}"><p>${escape(item.title)}</p><p class="small-copy">这里模拟外部发布后的回读，不会提交或丢弃用户已有的 Review 草稿，也不自动 Resolve。</p><label class="field-label" for="feedback-observed">模拟远端回读结果</label><select class="text-field" id="feedback-observed"><option value="pending">仍是草稿 / 尚未确认</option><option value="published">确认这条回复已经发布</option><option value="not-published">明确未发布，允许重新预览</option></select><p id="feedback-form-error" class="input-error" role="alert" hidden></p></div></form>`, '<button class="button" data-action="close">返回</button><button class="button primary" form="feedback-check-form" type="submit">核对演示状态</button>');
  }

  function feedbackBatchDialog() {
    const items = feedback.readyFixes(state);
    if (!items.length) throw new Error('没有已经核对、验证并模拟推送的待发布修复会话');
    const current = feedback.session(state);
    openModal('批量回复预览 · 每个会话分别记录结果', `<form id="feedback-batch-form"><div class="modal-body"><p>${escape(current.context.repositoryName)} / 演示 PR ${escape(current.context.prId)}</p><p class="form-hint">同一根因可复用修复、验证和提交，但不会把多个原会话混成一条。只处理明确选中的会话，部分失败不冒充全部成功。</p>
      ${items.map((item) => {
        const draft = feedback.makeDraft(state, item.id);
        return `<article class="feedback-batch-entry" data-id="${item.id}" data-draft-id="${draft.id}"><label><input type="checkbox" name="feedback-batch-select" value="${item.id}" checked> ${item.id} · ${escape(item.title)}</label><p class="form-hint">${escape(item.remoteId)}<br>${escape(item.rootCommentId)}</p><label class="field-label" for="feedback-batch-body-${item.id}">回复预览</label>${markdownEditor(`feedback-batch-body-${item.id}`, draft.body, 5, false)}<label class="feedback-resolve-option"><input type="checkbox" name="feedback-batch-resolve" value="${item.id}" ${feedback.readiness(state, item.id).canResolve ? '' : 'disabled'}> 回复发布后 Resolve（模拟，默认不勾选）</label><label class="field-label" for="feedback-batch-outcome-${item.id}">该会话的演示分支</label><select class="text-field" id="feedback-batch-outcome-${item.id}">${Object.entries(feedback.outcomes).map(([value, text]) => `<option value="${value}">${text}</option>`).join('')}</select></article>`;
      }).join('')}<p id="feedback-form-error" class="input-error" role="alert" hidden></p></div></form>`, '<button class="button" data-action="close">取消</button><button class="button primary" form="feedback-batch-form" type="submit">确认模拟发布所选会话</button>');
  }

  function handleFeedbackAction(action, target) {
    if (!action.startsWith('feedback-')) return false;
    try {
      syncFeedbackContext(state);
      const id = target.dataset.id;
      if (action === 'feedback-open' || action === 'feedback-select') { showFeedback(id); return true; }
      if (action === 'feedback-original') {
        const item = feedback.get(state, id);
        if (!item.originalDiff) throw new Error('没有该会话的原始 Diff 快照，不能用当前代码冒充');
        openModal('评论时的原始 Diff · 非当前代码', `<div class="modal-body"><p>${escape(item.title)}</p><pre class="summary-text">${escape(item.originalDiff)}</pre><p class="form-hint">Outdated 与 Resolve 分别记录；不会猜测当前行号。</p></div>`);
        return true;
      }
      if (state.runStatus === 'running') throw new Error('请先结束或取消模拟审查，再修改反馈处置');
      if (action === 'feedback-link') { feedbackLinkDialog(); return true; }
      if (action === 'feedback-preview') { feedbackPreview(id, target.dataset.intent || 'final'); return true; }
      if (action === 'feedback-batch') { feedbackBatchDialog(); return true; }
      if (action === 'feedback-verify' || action === 'feedback-deliver') { feedbackStepDialog(action === 'feedback-verify' ? 'verify' : 'deliver', id); return true; }
      if (action === 'feedback-check') { feedbackCheckDialog(id); return true; }
      if (action === 'feedback-refresh') feedback.refresh(state, true);
      else if (action === 'feedback-assess-all') feedback.assessAll(state);
      else if (action === 'feedback-assess') feedback.assess(state, id);
      else if (action === 'feedback-resolve') feedback.retryResolve(state, id);
      else if (action === 'feedback-reopen') feedback.reopen(state, id);
      else if (action === 'feedback-requirement') importFeedbackRequirement(state, id);
      else if (action === 'feedback-new-comment') feedback.receiveComment(state, id);
      else if (action === 'feedback-permission') feedback.setResolvePermission(state, id, !feedback.get(state, id).canResolve);
      else if (action === 'feedback-sync-fail') feedback.refresh(state, false);
      else throw new Error('未知的 PR 反馈操作');
      render();
      notify(action === 'feedback-resolve' ? '仅模拟 Resolve 并回读，没有重复回复，也没有改变 Review 总体意见。' : action === 'feedback-requirement' ? '建议原文已作为材料保留，仍需确认理解；没有改代码、回复或 Resolve。' : '演示反馈状态已更新，未调用 AI 或写入 GitHub。');
    } catch (error) {
      render();
      notify(error.message, true);
    }
    return true;
  }

  function submitFeedbackForm(form) {
    const targetId = form.elements.namedItem('feedback-id')?.value;
    const previousOperation = feedback.session(state)?.items.find((item) => item.id === targetId)?.local.operation;
    try {
      syncFeedbackContext(state);
      const id = form.elements.namedItem('feedback-id')?.value;
      if (form.id === 'feedback-link-form') {
        linkFeedbackPr(state, document.getElementById('feedback-linked-pr').value);
      } else if (form.id === 'feedback-reply-form') {
        const expectedDraftId = form.elements.namedItem('feedback-draft-id').value;
        if (feedback.get(state, id).local.draft?.id !== expectedDraftId) throw new Error('回复预览或目标已变化，请重新核对原会话');
        feedback.editDraft(state, id, document.getElementById('feedback-reply-text').value, document.getElementById('feedback-reply-mode').value);
        feedback.publish(state, id, {
          expectedDraftId, confirmed: true, resolve: document.getElementById('feedback-resolve').checked,
          outcome: document.getElementById('feedback-publish-outcome').value,
        });
      } else if (form.id === 'feedback-step-form' || form.id === 'feedback-check-form') {
        if (feedback.get(state, id).remoteId !== form.elements.namedItem('feedback-remote-id').value) throw new Error('PR 或会话目标已变化，请重新预览');
        if (form.id === 'feedback-check-form') feedback.checkPublication(state, id, document.getElementById('feedback-observed').value);
        else {
          if (feedback.session(state).context.key !== form.elements.namedItem('feedback-context').value) throw new Error('代码范围已变化，不能沿用之前的演示验证或推送操作');
          const result = document.getElementById('feedback-step-result').value;
          const step = form.elements.namedItem('feedback-step').value;
          if (!['success', 'failed'].includes(result) || !['verify', 'deliver'].includes(step)) throw new Error('未知的验证或交付演示分支，未记录成功');
          const success = result === 'success';
          if (step === 'verify') feedback.recordVerification(state, id, success);
          else feedback.recordDelivery(state, id, success);
        }
      } else if (form.id === 'feedback-batch-form') {
        const entries = [...form.querySelectorAll('input[name="feedback-batch-select"]:checked')].map((input) => {
          const row = input.closest('[data-draft-id]');
          const item = feedback.get(state, input.value);
          if (item.local.draft?.id !== row.dataset.draftId) throw new Error('批量预览的目标或草稿已变化，未发布');
          const body = document.getElementById(`feedback-batch-body-${item.id}`).value;
          if (!body.trim()) throw new Error(`${item.id} 回复内容不能为空`);
          return {
            id: item.id, expectedDraftId: row.dataset.draftId, confirmed: true, body,
            resolve: form.querySelector(`input[name="feedback-batch-resolve"][value="${item.id}"]`).checked,
            outcome: document.getElementById(`feedback-batch-outcome-${item.id}`).value,
          };
        });
        entries.forEach((entry) => feedback.editDraft(state, entry.id, entry.body, feedback.get(state, entry.id).local.draft.mode));
        const results = feedback.publishBatch(state, entries);
        render();
        openModal('逐会话发布结果 · 不合并成笼统成功', `<div class="modal-body">${results.map((result) => `<article class="feedback-batch-result ${result.status === 'failed' ? 'error' : ''}"><strong>${result.id} · ${result.status === 'failed' ? '需要恢复' : escape(publicationLabel({ status: result.status }))}</strong><p class="small-copy">${escape(result.message || '状态仅记录在当前页面，没有写入 GitHub。')}</p><button class="text-button" data-action="feedback-select" data-id="${result.id}">查看会话与下一步</button></article>`).join('')}</div>`);
        return;
      } else throw new Error('未知的反馈表单');
      modal.close();
      render();
      notify('演示结果已逐步记录；请核对 Reply 与 Resolve 的独立状态。没有对外发送或执行真实测试/Git。');
    } catch (error) {
      const id = form.elements.namedItem('feedback-id')?.value;
      const operation = feedback.session(state)?.items.find((item) => item.id === id)?.local.operation;
      if (operation !== previousOperation && operation?.status === 'resolve-failed') modal.close();
      render();
      const message = document.getElementById('feedback-form-error');
      if (message) { message.textContent = error.message; message.hidden = false; }
      notify(error.message, true);
    }
  }

  async function readLocalFile(file) {
    if (!file) return;
    if (state.runStatus === 'running') return notify('请先结束或取消模拟审查，再读取材料。', true);
    const originalState = state;
    const originalScope = scopeState(state).key;
    const generation = ++fileReadGeneration;
    originalState.sourceReview.readingFile = true;
    render();
    try {
      sources.validateFileName(file.name);
      const text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
      if (generation !== fileReadGeneration || state !== originalState || scopeState(state).key !== originalScope) {
        throw new Error('读取期间代码范围或场景已变化，请在当前范围重新选择文件');
      }
      sources.addFileSource(state, file.name, text);
      state.center.stage = 'prepare';
      notify('本地原文已读取，只存浏览器内存、不上传。演示文本按预设整理，自定义内容明确标为待模型分析。');
    } catch (error) {
      notify(`读取本地文件失败：${error.message}。未将该文件纳入审查。`, true);
    } finally {
      originalState.sourceReview.readingFile = false;
      if (state === originalState) render();
    }
  }

  function excludeRequirement(id) {
    const requirement = preparationState(state).items.find((item) => item.id === id);
    if (!requirement) return notify('这条要求不在当前审查理解中。', true);
    openModal('为什么不适用于本次审查？', `<form id="exclude-requirement-form"><div class="modal-body"><input name="requirement-id" type="hidden" value="${id}"><blockquote class="quote markdown-body">${markdown.render(requirement.text)}</blockquote><label class="field-label" for="exclusion-reason">排除原因</label><textarea id="exclusion-reason" class="textarea" required rows="4" placeholder="例如：属于后续版本；这里只是改动说明，不是本次要求…">${escape(requirement.exclusionReason || '')}</textarea><p class="form-hint">保留出处和排除记录，不会自动清除已经发现的关键问题。</p></div></form>`, '<button class="button" data-action="close">取消</button><button class="button primary" form="exclude-requirement-form" type="submit">记录为不适用</button>');
  }

  function noteModal(kind, id) {
    const title = kind === 'comment' ? '记录评论，不解除关键阻断' : '补充适用边界，不生成永久免责';
    openModal(title, `<form id="center-note-form"><div class="modal-body"><input name="finding-id" type="hidden" value="${id}"><input name="note-kind" type="hidden" value="${kind}"><label class="field-label" for="center-note">说明与依据</label><textarea id="center-note" class="textarea" rows="5" required placeholder="说明触发条件、业务取舍或还需核实的证据…"></textarea><p class="form-hint">仅记录在本次原型；不写入 GitHub。补充事实会使相关判断待重审。</p></div></form>`, '<button class="button" data-action="close">取消</button><button class="button primary" type="submit" form="center-note-form">记录到当前示例</button>');
  }

  function fixPreview(id) {
    const finding = state.findings.find((item) => item.id === id);
    if (finding.type !== 'implementation') return notify('需求矛盾或必要前提应先澄清，不能直接生成修复。', true);
    const before = id === 'F-01' ? 'order.markPaymentFailed();\nreturn { canPayAgain: true };' : state.center.findingMode === 'technical' ? 'const reservation = await inventory.findByOrder(order.id);\nreturn { reservationId: reservation.id };' : 'await order.restore();\nreturn { status: "awaiting_payment" };';
    const after = id === 'F-01' ? 'order.markPaymentUnknown();\nreturn { canPayAgain: false, status: "unknown" };' : state.center.findingMode === 'technical' ? 'const reservation = await inventory.reserveForOrder(order);\nawait order.restore();\nreturn { reservationId: reservation.id };' : 'await inventory.reserveForOrder(order);\nawait order.restore();\nreturn { status: "awaiting_payment" };';
    openModal('修复方案 · 仅替换浏览器内示例', `<div class="modal-body"><p>${id === 'F-01' ? '把超时保留为未知状态，暂不开放再次支付。' : '在恢复状态前，重新建立示例库存保障。'}这里只验证交互，不代表真实系统的最终正确修复。</p><pre class="fix-before">${escape(before)}</pre><pre class="fix-after">${escape(after)}</pre><p class="form-hint">不会修改真实文件，不执行测试。接受后标记为人工接受示例补丁；本次应用可撤销。</p></div>`, `<button class="button" data-action="close">返回代码</button><button class="button primary" data-action="apply-fix" data-id="${id}" ${state.center.patches[id] ? 'disabled' : ''}>${state.center.patches[id] ? '示例已应用' : '人工接受并应用到示例'}</button>`);
  }

  async function startRun(fromPreparation = false) {
    if (state.runStatus === 'running') return;
    const preparation = preparationState(state);
    if (fromPreparation) {
      try {
        prepareForReview(state, true);
      } catch (error) {
        render();
        return notify(error.message, true);
      }
    } else if (preparation.needsConfirmation || !preparation.canStart || state.mode !== preparation.mode) {
      stage('prepare');
      return notify('本次依据已变化，请在准备页确认本次理解并开始。无需额外选择审查方式。', true);
    }
    const generation = ++runGeneration;
    state.runStatus = 'running';
    state.center.navigator = 'business';
    state.center.feedbackId = null;
    state.center.stageIndex = 0;
    state.center.stage = 'review';
    invalidate(state);
    render(false);
    for (let index = 0; index < runStages.length; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 420));
      if (generation !== runGeneration) return;
      state.center.stageIndex = index + 1;
      render();
    }
    completeReview(state);
    render();
    notify(!scopeState(state).supportsFindings ? '此范围没有预设分析结果，未执行真实审查；没有沿用其他范围的发现。' : state.sourceReview.limited ? '来源流程演示完成；自定义材料未做语义评审，结果标为部分完成。' : '模拟流程完成：未连接模型、分析输入或执行测试。');
  }

  function openSummary() {
    openModal('审查摘要 · 原型模拟', `<div class="modal-body"><pre class="summary-text">${escape(summaryText(state))}</pre><p class="form-hint">内置浏览器可能不保存下载，可使用复制用文本取得全部内容。</p></div>`, '<button class="button" data-action="close">关闭</button><button class="button" data-action="copy-summary">复制用文本</button><button class="button primary" data-action="download">下载示例</button>');
  }

  function download() {
    const url = URL.createObjectURL(new Blob([summaryText(state)], { type: 'text/markdown;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `review-center-${state.scenario}-demo.md`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    notify('已发起示例摘要下载；内置浏览器未保存时，可选择复制用文本。');
  }

  document.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target.closest('[data-action]') : null;
    if (!target || target.disabled) return;
    const action = target.dataset.action;
    if (handleFeedbackAction(action, target)) return;
    if (action === 'markdown-edit-mode') return setMarkdownEditorMode(target.closest('[data-markdown-editor]'), target.dataset.mode);
    if (action === 'markdown-read-mode') return setMarkdownReaderMode(target.closest('[data-markdown-reader]'), target.dataset.mode);
    if (action === 'close') return modal.close();
    if (action === 'stage') return stage(target.dataset.stage);
    if (action === 'help') return help();
    if (action === 'theme') { document.documentElement.dataset.theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; return render(); }
    if (action === 'reset') { runGeneration += 1; state = createCenterState(state.scenario); if (modal.open) modal.close(); render(false); return notify('已重置到独立演示快照，未改变真实工作区。'); }
    if (action === 'finding') { selectFinding(state, target.dataset.id); return render(false); }
    if (action === 'source') return openSource(target.dataset.source);
    if (action === 'navigator') { if (target.dataset.tab === 'feedback') return showFeedback(); state.center.navigator = target.dataset.tab; return render(); }
    if (action === 'inspector-tab') { state.center.inspector = target.dataset.tab; render(); return; }
    if (action === 'code-view') { state.center.codeView = target.dataset.view; return render(); }
    if (action === 'related') { state.center.related = !state.center.related; return render(); }
    if (action === 'focus') { state.center.focus = !state.center.focus; return render(); }
    if (action === 'next') return nextFinding();
    if (action === 'summary') return openSummary();
    if (action === 'download') return download();
    if (action === 'copy-summary') {
      openModal('摘要纯文本 · 手动复制', `<div class="modal-body"><label class="field-label" for="center-copy">已选中全文，可按 Ctrl+C / ⌘C 复制</label><textarea id="center-copy" class="textarea" rows="15" readonly>${escape(summaryText(state))}</textarea></div>`);
      const text = document.getElementById('center-copy');
      text.focus(); text.select();
      return;
    }
    if (action === 'run') return void startRun();
    if (action === 'prepare-start') return void startRun(true);
    if (action === 'recheck') {
      notify('从当前阅读位置重审关联范围；不是只复查孤立的一行代码。');
      return void startRun();
    }
    if (action === 'cancel') { runGeneration += 1; state.runStatus = 'cancelled'; invalidate(state); render(); return notify('已取消模拟流程，迟到结果不会覆盖当前状态。'); }
    if (action === 'scope') return scopeDialog();
    if (action === 'scope-source') { modal.close(); return openSource(target.dataset.source); }
    if (action === 'trace-requirement') return traceRequirement(target.dataset.id);
    if (action === 'material') return sourceDetails(target.dataset.sourceId, Number(target.dataset.version) || undefined);
    if (action === 'read-material') { modal.close(); return openSource(target.dataset.sourceId); }
    if (action === 'materials') return materialsDialog();
    if (action === 'understanding') return understandingDialog();
    if (state.runStatus === 'running') return notify('请先结束或取消模拟审查，再修改依据或处置。', true);
    if (action === 'simulate-code-change') {
      changeScope(state, { snapshot: state.scopeReview.selection.snapshot + 1 });
      modal.close();
      render();
      return notify('已切换到新的演示代码快照，旧发现、补丁和确认失效；没有分析新代码。');
    }
    if (action === 'edit-source-snapshot') return editSourceSnapshot(target.dataset.sourceId);
    if (action === 'edit-requirement') return editRequirement(target.dataset.id);
    if (action === 'exclude-requirement') return excludeRequirement(target.dataset.id);
    if (action === 'include-requirement') {
      changeRequirementInclusion(state, target.dataset.id, true);
      render();
      return understandingDialog();
    }
    if (action === 'paste-material') return materialInput();
    if (action === 'link-material') return linkInput();
    if (action === 'file-material') return document.getElementById('requirement-file').click();
    if (action === 'use-example-materials') {
      chooseMaterial(state, 'payments', true);
      chooseMaterial(state, 'orders', true);
      render();
      return notify('已载入两份预设需求并整理演示理解；其他材料保持不变，没有调用 AI。');
    }
    if (action === 'preset-material') {
      const example = sources.exampleMaterial(state);
      document.getElementById('center-source-name').value = example.name;
      const input = document.getElementById('center-source-text');
      input.value = example.text;
      if (input.hidden) setMarkdownEditorMode(input.closest('[data-markdown-editor]'), 'preview');
      return;
    }
    if (action === 'preset-link') {
      document.getElementById('requirement-link').value = sources.exampleLink;
      document.getElementById('requirement-link-error').hidden = true;
      return;
    }
    if (action === 'add-explicit-requirement') return materialInput(true);
    if (action === 'preset-requirement') {
      document.getElementById('center-requirement-title').value = '支付超时后保留结果未知';
      const input = document.getElementById('center-requirement-text');
      input.value = demo.revisedRequirement;
      if (input.hidden) setMarkdownEditorMode(input.closest('[data-markdown-editor]'), 'preview');
      document.getElementById('center-preset').value = 'true';
      return;
    }
    if (action === 'comment' || action === 'boundary') return noteModal(action, target.dataset.id);
    if (action === 'fix-preview') return fixPreview(target.dataset.id);
    if (action === 'apply-fix') { applySampleFix(state, target.dataset.id); modal.close(); render(); return notify('仅应用到浏览器内示例，未运行测试，可撤销。'); }
    if (action === 'undo-fix') { undoSampleFix(state, target.dataset.id); render(); return notify('示例补丁已撤销，原问题与通过限制已恢复。'); }
    if (action === 'evidence') return openModal('补充关键契约 · 预设证据分支', `<form id="center-evidence-form"><div class="modal-body"><p>本分支演示稳定事件键与唯一约束得到补充。它不是对任意输入执行的实际契约验证。</p><label class="field-label" for="center-evidence">来源与适用范围</label><textarea id="center-evidence" class="textarea" required rows="5">示例契约 v2 第 4 条：同一支付事件重投保持 event.id 稳定；示例账本对该键具备唯一约束。仅适用于当前演示。</textarea><p class="form-hint">补充后仍要重审，关键前提不会在点击保存时立即解除。</p></div></form>`, '<button class="button" data-action="close">取消</button><button class="button primary" form="center-evidence-form" type="submit">补充示例证据，等待重审</button>');
    if (action === 'submit') {
      const gate = approvalGate(state);
      if (state.verdict === 'approve' ? !gate.eligible || !state.humanConfirmed : !gate.feedbackAllowed) return notify('提交条件尚未满足，不能绕过关键阻断或有效性检查。', true);
      return openModal(`模拟记录 · ${verdictLabels[state.verdict]}`, `<div class="modal-body"><p>仅在当前页面记录结论，不会写入 GitHub、真实扩展或磁盘。${state.mode === 'technical' ? '摘要保留“需求一致性未评审”。' : '评论和要求修改不会自动解除关键矛盾。'}</p></div>`, '<button class="button" data-action="close">返回检查</button><button class="button primary" data-action="confirm-submit">确认模拟记录</button>');
    }
    if (action === 'confirm-submit') { submitVerdict(state, state.verdict); modal.close(); render(); return notify(`已在当前原型记录“${verdictLabels[state.verdict]}”，未写回 GitHub。`); }
  });

  document.addEventListener('submit', (event) => {
    if (!(event.target instanceof HTMLFormElement)) return;
    event.preventDefault();
    const form = event.target;
    if (!form.reportValidity()) return;
    if (state.runStatus === 'running') return notify('请先结束或取消模拟审查。', true);
    if (form.id.startsWith('feedback-')) return submitFeedbackForm(form);
    if (form.id === 'center-requirement-form') {
      const text = document.getElementById('center-requirement-text').value;
      const title = document.getElementById('center-requirement-title').value.trim();
      if (!text.trim() || !title) return notify('需求标题和内容不能为空。', true);
      const id = form.elements.namedItem('requirement-id').value;
      try {
        sources.reviseCandidate(state, id, title, text);
      } catch (error) {
        return notify(error.message, true);
      }
      if (id === 'RQ-02') state.pending.requirement = document.getElementById('center-preset').value === 'true' && text === demo.revisedRequirement;
      state.center.stage = 'prepare';
      notify('本次理解已修订，原文保留。点击主按钮确认并开始，仍会独立检查实现。');
    } else if (form.id === 'center-note-form') {
      const note = document.getElementById('center-note').value.trim();
      if (!note) return notify('请填写说明和依据。', true);
      const id = form.elements.namedItem('finding-id').value;
      if (form.elements.namedItem('note-kind').value === 'comment') demo.recordComment(state, id, note);
      else {
        state.history.push(`${id} 补充适用边界：${note}。需要重新核实，未自动建立永久免责。`);
        state.stale = state.hasResults;
        invalidate(state);
      }
      notify('已记录。评论不会解除关键阻断，补充事实需要重审。');
    } else if (form.id === 'center-evidence-form') {
      const text = document.getElementById('center-evidence').value.trim();
      if (!text) return notify('证据说明不能为空。', true);
      demo.attachEvidence(state, text);
      notify('示例契约已补充，重审后才更新关键裁决。');
    } else if (form.id === 'center-source-form') {
      const providedName = document.getElementById('center-source-name').value.trim();
      const kind = form.elements.namedItem('material-kind').value;
      if (kind === 'requirement' && !providedName) return notify('请为这条明确要求填写标题。', true);
      const name = providedName || '本次业务补充';
      const text = document.getElementById('center-source-text').value;
      if (!text.trim()) return notify('补充内容不能为空。', true);
      try {
        sources.addManualSource(state, name, text, kind);
      } catch (error) {
        return notify(error.message, true);
      }
      state.center.stage = 'prepare';
      notify('材料已加入，原文保留。仅演示文本按固定映射整理，自定义内容不会伪造 AI 理解。');
    } else if (form.id === 'requirement-link-form') {
      try {
        sources.addLinkSource(state, document.getElementById('requirement-link').value.trim());
      } catch (error) {
        const feedback = document.getElementById('requirement-link-error');
        feedback.textContent = error.message;
        feedback.hidden = false;
        return notify(error.message, true);
      }
      state.center.stage = 'prepare';
      notify('已加入演示链接的固定原文快照并整理检查项；未发生网络读取。');
    } else if (form.id === 'exclude-requirement-form') {
      const reason = document.getElementById('exclusion-reason').value.trim();
      if (!reason) return notify('请说明不适用的原因。', true);
      changeRequirementInclusion(state, form.elements.namedItem('requirement-id').value, false, reason);
      state.center.stage = 'prepare';
      notify('已保留不适用原因与原文。已有关键问题不会因此消失。');
    } else if (form.id === 'source-snapshot-form') {
      const text = document.getElementById('source-snapshot-text').value;
      if (!text.trim()) return notify('原文不能为空。', true);
      sources.updateSource(state, form.elements.namedItem('source-id').value, text);
      state.center.stage = 'prepare';
      notify('新原文快照已保存，待核对条目已自动更新。原型不会分析自定义文本，请查看未提取说明。');
    } else return;
    modal.close();
    render();
  });

  document.addEventListener('input', (event) => {
    if (event.target.matches('[data-markdown-input]') && event.target.hidden) {
      setMarkdownEditorMode(event.target.closest('[data-markdown-editor]'), 'preview');
    }
    if (event.target.id === 'center-search') { state.center.search = event.target.value; render(); }
    if (event.target.id === 'center-notes') {
      state.notes = event.target.value;
      const preview = document.getElementById('center-summary');
      if (preview) preview.textContent = summaryText(state);
    }
  });

  document.addEventListener('invalid', (event) => {
    if (event.target.matches('[data-markdown-input]') && event.target.hidden) {
      setMarkdownEditorMode(event.target.closest('[data-markdown-editor]'), 'edit');
    }
  }, true);

  document.addEventListener('change', (event) => {
    if (event.target.id === 'feedback-filter') { state.center.feedbackFilter = event.target.value; render(); return; }
    if (event.target.id === 'demo-scenario') {
      runGeneration += 1;
      if (modal.open) modal.close();
      state = createCenterState(event.target.value);
      render(false);
      return notify('已切换独立演示快照，不是清除当前审查的关键阻断。');
    }
    if (event.target.id === 'requirement-file') return void readLocalFile(event.target.files[0]);
    const scopeFields = { 'scope-repository': 'repository', 'scope-pr': 'pr', 'scope-branch': 'branch', 'scope-mode': 'mode', 'scope-base': 'base' };
    const scopeField = event.target.name === 'scope-kind' ? 'kind' : scopeFields[event.target.id];
    if (scopeField) {
      try {
        changeScope(state, { [scopeField]: event.target.value });
      } catch (error) {
        render();
        return notify(error.message, true);
      }
      render();
      return notify('审查对象已更新，材料保留；文件来自明确范围，不根据名称识别“入口”。');
    }
    if (event.target.name === 'material-selection') {
      if (state.runStatus === 'running') {
        event.target.checked = sources.getSource(state, event.target.value).selected;
        return notify('模拟进行中不能修改材料。', true);
      }
      chooseMaterial(state, event.target.value, event.target.checked);
      render();
      const count = document.getElementById('materials-count');
      if (count) count.textContent = `${sources.selectedSources(state).length} 份材料已选入；本次理解已自动更新。`;
      return;
    }
    if (event.target.name === 'center-verdict') {
      if (event.target.value === 'approve' && !approvalGate(state).eligible) { render(); return notify('关键阻断或其他通过条件尚未满足。', true); }
      state.verdict = event.target.value;
      render();
    }
    if (event.target.id === 'center-human') { state.humanConfirmed = event.target.checked; render(); }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && modal.open) { event.preventDefault(); modal.close(); }
    if (event.key === 'F8' && !modal.open) { event.preventDefault(); nextFinding(); }
  });
  window.addEventListener('error', (event) => notify(`原型脚本错误：${event.message}`, true));
  window.addEventListener('unhandledrejection', (event) => notify(`原型操作失败：${String(event.reason)}`, true));
  render(false);
}());
