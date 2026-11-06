(function () {
  'use strict';

  const demo = typeof module !== 'undefined' && module.exports ? require('./app.js') : window.ReviewDemoModel;
  const sources = typeof module !== 'undefined' && module.exports ? require('./sources.js') : window.ReviewSourceModel;
  const feedback = typeof module !== 'undefined' && module.exports ? require('./feedback.js') : window.ReviewFeedbackModel;
  if (!demo) throw new Error('审查中心的示例状态模块未加载');
  if (!sources) throw new Error('需求来源模块未加载');
  if (!feedback) throw new Error('PR 反馈模块未加载');

  const scenarioLabels = {
    standard: '关键问题未闭合', fresh: '选择对象与可选需求', technical: '无需求的整仓 Bug 审查',
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
  const severityLabels = { critical: '严重', high: '高影响', medium: '中影响', low: '低影响', potential: '风险待核实', none: '非缺陷' };
  const verdictLabels = { approve: '通过', 'request-changes': '要求修改', comment: '仅评论' };
  const runLabels = { idle: '未开始', running: '模拟审查中', cancelled: '已取消', partial: '部分完成', completed: '预设流程完成' };
  const repositories = [
    { id: 'checkout', name: 'demo/checkout-service', defaultBranch: 'main', prs: [
      { id: '104', title: '支付超时与订单恢复', head: 'feat/payment-timeout', base: 'main' },
      { id: '105', title: '展示缓存与重试边界', head: 'feat/status-cache', base: 'main' },
    ] },
    { id: 'sandbox', name: 'demo/checkout-sandbox', defaultBranch: 'main', prs: [{ id: '207', title: '订单恢复验证', head: 'feat/payment-timeout', base: 'main' }], comparisons: { 'feat/payment-timeout|main': ['restore'] } },
  ];
  const branches = [
    { name: 'feat/payment-timeout', version: 'demo-head-v3' },
    { name: 'main', version: 'demo-main-v2' },
    { name: 'release/2026.10', version: 'demo-release-v1' },
    { name: 'feat/status-cache', version: 'demo-cache-v1' },
  ];
  const changedFiles = ['submit', 'callback', 'restore'];
  const snapshotFiles = [...changedFiles, 'cancel', 'status', 'service', 'job', 'api', 'gateway', 'decision', 'payments', 'orders'];
  const repositoryFiles = { checkout: snapshotFiles, sandbox: ['restore', 'cancel', 'api', 'orders'] };
  const comparisons = {
    'feat/payment-timeout|main': changedFiles,
    'feat/payment-timeout|release/2026.10': ['submit', 'restore'],
    'feat/status-cache|main': ['status', 'job'],
    'feat/status-cache|release/2026.10': ['status'],
    'feat/payment-timeout|feat/status-cache': [...changedFiles, 'status', 'job'],
    'main|release/2026.10': [],
  };
  const gitStatusLabels = { M: '修改', A: '新增', D: '删除', R: '重命名' };
  const reviewSkills = [
    { id: 'business-path', name: '业务链与反证审查', version: 1, description: '追踪入口、状态与关联保障，核实反例；不从现有代码反推需求。' },
    { id: 'state-machine', name: '状态与幂等检查', version: 1, description: '检查状态迁移、重复请求和异步结果收敛，不擅自增加业务规则。' },
    { id: 'compatibility', name: '接口兼容性检查', version: 1, description: '对照调用方、接口契约和配置，检查兼容边界与失败路径。' },
  ];

  function defaultRepositoryMaterials(repositoryId) {
    const repository = repositories.find((item) => item.id === repositoryId);
    if (!repository) throw new Error('请选择可用的演示 Repository');
    const text = repositoryId === 'checkout'
      ? '# 支付与订单工程约定（演示）\n\n核对支付入口、异步回调和订单恢复之间的契约。职责由调用链和证据证明，不重复添加已有保障。\n\n这里只提供 Repo 背景；本次需求和验收条件仍需单独提供、确认。'
      : '# 订单恢复验证约定（演示）\n\n此 Repo 只包含订单恢复相关示例。核对取消、恢复与资源预留的配合，不沿用其他 Repo 的支付审查结果。';
    return [{
      id: `repo-${repositoryId}-1`, kind: 'design', binding: 'repository', name: `${repositoryId === 'checkout' ? '支付与订单' : '订单恢复'}工程约定`,
      location: `${repository.name} / Repo 参考快照`, purpose: 'context', selected: true,
      version: 1, text, snapshots: [{ version: 1, text }], templateVersion: 1, templates: [],
    }];
  }

  function createWorkspaceState() {
    return {
      version: 1, nextTask: 1, openRepositories: [], selectedRepository: null,
      activeTasks: {}, view: 'repository', tasks: [], remember: false,
      repositoryMaterials: Object.fromEntries(repositories.map((item) => [item.id, defaultRepositoryMaterials(item.id)])),
    };
  }

  function addRepositories(workspace, ids) {
    if (!Array.isArray(ids) || !ids.length) throw new Error('请至少选择一个 Repo');
    if (ids.some((id) => !repositories.some((item) => item.id === id))) throw new Error('原型只支持列表中的演示 Repo，不会读取真实仓库');
    const added = [...new Set(ids)].filter((id) => !workspace.openRepositories.includes(id));
    workspace.openRepositories.push(...added);
    if (!workspace.selectedRepository && workspace.openRepositories.length === 1) openRepository(workspace, workspace.openRepositories[0]);
    return added;
  }

  function currentReviewTask(workspace) {
    return workspace.tasks.find((task) => task.id === workspace.activeTasks[workspace.selectedRepository]) || null;
  }

  function openRepository(workspace, id) {
    if (!repositories.some((item) => item.id === id)) throw new Error('原型只支持列表中的演示 Repo，不会读取真实仓库');
    if (!workspace.openRepositories.includes(id)) workspace.openRepositories.push(id);
    workspace.selectedRepository = id;
    workspace.view = currentReviewTask(workspace) ? 'task' : 'repository';
    return currentReviewTask(workspace);
  }

  function reviewTaskTitle(state) {
    const scope = scopeState(state);
    return scope.pr ? `PR ${scope.pr.id} · ${scope.pr.title}` : `${scope.head.name} · 分支审查`;
  }

  function createReviewTask(workspace, repositoryId, options = {}) {
    const repository = repositories.find((item) => item.id === repositoryId);
    if (!repository) throw new Error('请先打开一个演示 Repo');
    if (options.selection?.repository && options.selection.repository !== repositoryId) throw new Error('审查任务只能属于创建时选定的 Repo');
    const nextState = createCenterState(options.scenario || 'fresh');
    changeScope(nextState, { repository: repositoryId, ...options.selection });
    for (const material of workspace.repositoryMaterials[repositoryId]) nextState.sources.push(JSON.parse(JSON.stringify(material)));
    nextState.reviewContext.skillIds = ['business-path'];
    if (!nextState.hasResults) sources.organize(nextState);
    else if (workspace.repositoryMaterials[repositoryId].some(sources.needsAnalysis)) {
      nextState.sourceReview.limited = true;
      nextState.stale = true;
    }
    const task = {
      id: `review-${workspace.nextTask++}`, repositoryId, title: options.title?.trim() || reviewTaskTitle(nextState),
      customTitle: !!options.title?.trim(), createdAt: new Date().toISOString(), state: nextState,
    };
    nextState.reviewContext.taskId = task.id;
    workspace.tasks.push(task);
    selectReviewTask(workspace, task.id);
    return task;
  }

  function loadRepositoryTarget(workspace, repositoryId, target) {
    const repository = repositories.find((item) => item.id === repositoryId);
    if (!repository || !workspace.openRepositories.includes(repositoryId) || workspace.selectedRepository !== repositoryId) throw new Error('请先从左侧选择一个已添加的 Repo');
    if (typeof target !== 'string') throw new Error('请选择分支或 PR');
    const kind = target.startsWith('pr:') ? 'pr' : target.startsWith('branch:') ? 'branch' : null;
    const value = target.slice(target.indexOf(':') + 1);
    const pr = kind === 'pr' ? repository.prs.find((item) => item.id === value) : null;
    const branch = kind === 'branch' ? branches.find((item) => item.name === value) : null;
    if (!pr && !branch) throw new Error('所选分支或 PR 不属于当前 Repo 的演示列表，未替换已有代码');
    const task = currentReviewTask(workspace);
    const previous = task?.state.scopeReview.selection;
    if (previous?.kind === kind && (pr ? previous.pr === pr.id : previous.branch === branch.name)) {
      workspace.view = 'task';
      return task;
    }
    if (task?.state.sourceReview.readingFile || task?.state.center.requirementEdit) throw new Error('请先完成文件读取或保存、取消需求修订，再切换审查对象');
    const selection = {
      kind, pr: pr?.id ?? repository.prs[0].id, branch: pr?.head ?? branch.name,
      base: pr?.base ?? repository.defaultBranch, mode: pr ? 'changes' : 'full', snapshot: 1,
    };
    const loaded = task || createReviewTask(workspace, repositoryId, { selection });
    if (task) changeScope(task.state, selection);
    loaded.title = reviewTaskTitle(loaded.state);
    loaded.state.center.stage = 'review';
    loaded.state.center.readingPositions = {};
    loaded.state.center.search = '';
    loaded.state.center.file = fileNavigation(loaded.state).rows[0]?.key ?? scopeState(loaded.state).files[0];
    workspace.view = 'task';
    return loaded;
  }

  function selectReviewTask(workspace, id) {
    const task = workspace.tasks.find((item) => item.id === id);
    if (!task) throw new Error('找不到这个审查任务');
    openRepository(workspace, task.repositoryId);
    workspace.activeTasks[task.repositoryId] = task.id;
    workspace.view = 'task';
    return task;
  }

  function rememberRepositoryMaterial(workspace, taskId, sourceId, version) {
    const task = workspace.tasks.find((item) => item.id === taskId);
    if (!task) throw new Error('请先选择审查任务');
    const source = sources.getSource(task.state, sourceId);
    const original = sources.snapshot(source, version ?? source.version);
    const materials = workspace.repositoryMaterials[task.repositoryId];
    if (materials.some((item) => item.name === source.name && item.text === original.text)) throw new Error('这份原文已经在本 Repo 的常用参考材料中');
    const material = {
      id: `repo-${task.repositoryId}-${materials.length + 1}`, kind: 'design', binding: 'repository',
      name: source.name, location: `${source.location} / 引用原文 v${original.version}`,
      purpose: 'context', selected: true, userProvided: !!source.userProvided,
      version: 1, text: original.text, snapshots: [{ version: 1, text: original.text }], templateVersion: 1, templates: [],
    };
    materials.push(material);
    return material;
  }

  function configureSkill(state, id, enabled) {
    if (!reviewSkills.some((item) => item.id === id) || typeof enabled !== 'boolean') throw new Error('请选择可用的审查 Skill');
    if (state.runStatus === 'running') throw new Error('请先结束或取消审查，再调整 Skill');
    const ids = state.reviewContext.skillIds;
    if (ids.includes(id) === enabled) return;
    state.reviewContext.skillIds = enabled ? [...ids, id] : ids.filter((item) => item !== id);
    state.stale = state.hasResults;
    invalidate(state);
    state.history.push(`审查方法已调整：${enabled ? '启用' : '停用'} ${reviewSkills.find((item) => item.id === id).name}；旧结果待重审，不改变已确认需求。`);
  }

  function parseWorkspace(text) {
    const workspace = JSON.parse(text);
    const knownRepository = (id) => repositories.some((item) => item.id === id);
    const invalid = () => { throw new Error('保存的工作区格式无效，未覆盖原存档；可清除存档后重新创建'); };
    if (!workspace || workspace.version !== 1 || !Array.isArray(workspace.tasks) || !Array.isArray(workspace.openRepositories)
      || workspace.openRepositories.some((id) => !knownRepository(id))
      || new Set(workspace.openRepositories).size !== workspace.openRepositories.length
      || workspace.selectedRepository !== null && !workspace.openRepositories.includes(workspace.selectedRepository)
      || !['repository', 'task'].includes(workspace.view)
      || !Number.isSafeInteger(workspace.nextTask) || workspace.nextTask < 1 || !workspace.activeTasks || !workspace.repositoryMaterials) invalid();
    const ids = new Set();
    for (const repository of repositories) {
      const materials = workspace.repositoryMaterials[repository.id];
      if (!Array.isArray(materials) || materials.some((item) => typeof item.id !== 'string' || typeof item.name !== 'string'
        || typeof item.text !== 'string' || item.purpose !== 'context' || item.binding !== 'repository' || !Array.isArray(item.snapshots))) invalid();
    }
    for (const task of workspace.tasks) {
      if (!task || !/^review-[1-9]\d*$/.test(task.id) || ids.has(task.id) || Number(task.id.slice(7)) >= workspace.nextTask
        || !knownRepository(task.repositoryId) || typeof task.title !== 'string' || !task.title.trim()
        || task.state?.scopeReview?.selection?.repository !== task.repositoryId || task.state.reviewContext?.taskId !== task.id
        || !Array.isArray(task.state.sources) || !Array.isArray(task.state.findings) || !Array.isArray(task.state.history)
        || !Array.isArray(task.state.reviewContext.skillIds) || task.state.reviewContext.skillIds.some((id) => !reviewSkills.some((item) => item.id === id))) invalid();
      ids.add(task.id);
      scopeState(task.state);
      preparationState(task.state);
      fileNavigation(task.state);
      if (task.state.runStatus === 'running') {
        task.state.runStatus = 'cancelled';
        task.state.history.push('页面恢复：上次模拟运行已中断，未将未完成步骤标为成功。');
      }
      if (task.state.sourceReview.readingFile) {
        task.state.sourceReview.readingFile = false;
        task.state.history.push('页面恢复：文件读取已中断，请重新选择文件。');
      }
    }
    for (const [repositoryId, id] of Object.entries(workspace.activeTasks)) {
      if (!workspace.tasks.some((task) => task.id === id && task.repositoryId === repositoryId)) invalid();
    }
    if (workspace.view === 'task' && !currentReviewTask(workspace)) invalid();
    workspace.view = currentReviewTask(workspace) ? 'task' : 'repository';
    workspace.remember = true;
    return workspace;
  }

  function comparisonChanges(repository, head, base) {
    if (head.name === base.name) return [];
    const direct = `${head.name}|${base.name}`, reverse = `${base.name}|${head.name}`;
    const key = [direct, reverse].find((item) => Object.hasOwn(repository.comparisons ?? {}, item) || Object.hasOwn(comparisons, item));
    if (!key) throw new Error('此演示比较尚未提供文件清单，不能声称没有变更');
    return (repository.comparisons?.[key] ?? comparisons[key]).map((entry) => {
      const change = typeof entry === 'string' ? { key: entry, status: 'M' } : { ...entry };
      if (!change.key || !Object.hasOwn(gitStatusLabels, change.status)) throw new Error('演示文件的 Git 状态无效');
      if (change.status === 'R' && (!change.previousPath || !change.path)) throw new Error('重命名必须保留原路径与新路径');
      if (key === reverse) {
        if (change.status === 'A') change.status = 'D';
        else if (change.status === 'D') change.status = 'A';
        else if (change.status === 'R') [change.path, change.previousPath] = [change.previousPath, change.path];
      }
      return change;
    });
  }

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
    const files = [...repositoryFiles[repository.id]];
    let comparedFiles = [];
    if (mode === 'changes') {
      if (!errors.length) {
        comparedFiles = comparisonChanges(repository, head, base).map((change) => change.key);
      }
    }
    const label = pr ? `PR ${pr.id} · ${pr.title} · 整仓快照` : `${head.name} · 整仓快照`;
    return {
      repository, pr, head, base, mode, files, changedFiles: comparedFiles, errors, label,
      reason: '所选分支 / PR 头提交的完整仓库文件；比较基线只标记变更，不缩小审查范围',
      key: JSON.stringify([repository.id, selection.kind, pr?.id, head.version, base?.version, mode, selection.snapshot]),
      supportsFindings: repository.id === 'checkout' && head.name === 'feat/payment-timeout' && selection.snapshot === 1,
    };
  }

  function scopeState(state) {
    const scope = scopeForSelection(state.scopeReview.selection);
    if (Object.keys(state.center.manualEdits).length) scope.supportsFindings = false;
    return scope;
  }

  function fileNavigation(state) {
    const scope = scopeState(state);
    const base = scope.pr ? scope.base : branches.find((branch) => branch.name === scope.repository.defaultBranch);
    if (!base) throw new Error('仓库默认分支不存在，不能标注文件状态');
    const changes = comparisonChanges(scope.repository, scope.head, base);
    const files = sourceFiles(state), byKey = new Map(changes.map((change) => [change.key, change]));
    const keys = scope.pr ? changes.map((change) => change.key) : [...new Set([...scope.files, ...changes.filter((change) => change.status === 'D').map((change) => change.key)])];
    return {
      base, changes, label: scope.pr ? 'Changes' : '文件',
      rows: keys.map((key) => {
        const file = files[key], change = byKey.get(key);
        if (!file) throw new Error('文件状态对应的演示源码不存在');
        return { key, kind: file.kind, path: change?.path ?? file.path, previousPath: change?.previousPath, status: change?.status ?? '' };
      }),
    };
  }

  function coverageLimits(state) {
    const limits = [];
    if (Object.keys(state.center.manualEdits).length) limits.push('手动编辑了浏览器代码副本；原型不能分析自定义实现，不沿用修改前的发现或验证。');
    else if (!scopeState(state).supportsFindings) limits.push('当前代码范围未执行分析，也没有对应的预设发现；不能沿用其他范围的结果。');
    if (state.sourceReview.limited) limits.push('自定义材料或变更条目尚未真实语义评审，预设发现仅供对照，不能完整批准。');
    if (state.scenario === 'partial' && state.runStatus === 'partial') limits.push('通道契约读取受限，回调幂等前提仍无法核实，不能宣称审查完整。');
    return limits;
  }

  function changeScope(state, patch) {
    if (state.runStatus === 'running') throw new Error('请先结束或取消模拟审查，再修改范围');
    const previous = scopeState(state);
    const selection = { ...state.scopeReview.selection, ...patch };
    if (patch.repository && patch.repository !== state.scopeReview.selection.repository) {
      const repository = repositories.find((item) => item.id === patch.repository);
      if (!repository) throw new Error('请选择可用的演示 Repository');
      Object.assign(selection, { pr: repository.prs[0].id, branch: repository.prs[0].head, base: repository.prs[0].base, snapshot: 1 }, patch);
    }
    if (selection.kind === 'pr' && patch.pr && patch.pr !== state.scopeReview.selection.pr) {
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
    Object.assign(state.center, { stage: 'prepare', settingsOpen: true, sourceOpen: false, opinionOpen: false, navigator: 'files', targetLine: null, file: next.files[0], patches: {}, fixSnapshots: {}, fixValidations: {}, manualEdits: {}, detailsOpen: false, stageIndex: 0, requirementEdit: null, feedbackId: null, feedbackReadSource: false, linkedFeedbackPr });
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

  function problemGroups(state) {
    const findings = state.hasResults ? state.findings : [];
    const closed = (finding) => finding.resolved || finding.status === 'dismissed' || finding.type === 'reasonable';
    return { open: findings.filter((finding) => !closed(finding)), closed: findings.filter(closed) };
  }

  function findingLocation(state, id = state.selectedFinding) {
    const finding = state.findings.find((item) => item.id === id);
    if (!finding) throw new Error('当前快照没有这个问题');
    const key = primaryFiles[id], file = sourceFiles(state)[key];
    if (!file || !scopeState(state).files.includes(key)) throw new Error('问题对应文件不在当前仓库快照');
    return { file: key, path: file.path, line: file.lines?.find((line) => line.highlighted)?.number ?? Number(file.highlight) };
  }

  function selectFile(state, key) {
    const allowed = scopeState(state).files.includes(key) || fileNavigation(state).rows.some((row) => row.key === key) || sources.selectedSources(state).some((source) => source.id === key);
    const file = sourceFiles(state)[key];
    if (!allowed || !file) throw new Error('这个文件不属于当前仓库快照或已选材料');
    state.center.file = key;
    state.center.targetLine = file.lines?.find((line) => line.highlighted)?.number ?? Number(file.highlight);
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
    if (state.center.requirementEdit) reasons.push('请先保存或取消当前需求修订。');
    if (flow.draft && (flow.draft.revision !== flow.revision || flow.organizedRevision !== flow.revision)) reasons.push('材料发生变化，本次审查理解尚未更新。');
    const missingReasons = items.filter((item) => item.include === false && !item.exclusionReason?.trim());
    if (missingReasons.length) reasons.push(`请为 ${missingReasons.map((item) => item.id).join('、')} 补充不适用的原因。`);
    if (requirements.some((item) => !item.origins?.length || item.origins.some((origin) => sources.originStatus(state, origin) !== '当前版本'))) reasons.push('部分要求的出处已过期或不再选入，请核对材料来源。');
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

  function beginRequirementEdit(state, id, preset = false) {
    if (state.runStatus === 'running' || state.sourceReview.readingFile) throw new Error('请先等待当前审查或材料读取完成');
    const current = state.center.requirementEdit;
    if (current && current.id !== id) throw new Error('请先保存或取消当前需求修订');
    if (current && !preset) return current;
    const requirement = preparationState(state).items.find((item) => item.id === id);
    if (!requirement) throw new Error('这条要求不在当前审查理解中');
    state.center.requirementEdit = {
      id, revision: state.sourceReview.revision,
      original: JSON.parse(JSON.stringify(requirement)),
      title: preset && id === 'RQ-02' ? '支付超时后保留结果未知' : requirement.title,
      text: preset && id === 'RQ-02' ? demo.revisedRequirement : requirement.text,
      preset: preset && id === 'RQ-02', preview: false,
    };
    state.center.stage = 'prepare';
    state.center.settingsOpen = true;
    return state.center.requirementEdit;
  }

  function saveRequirementEdit(state) {
    const edit = state.center.requirementEdit;
    if (!edit) throw new Error('没有待保存的需求修订');
    if (edit.revision !== state.sourceReview.revision) throw new Error('材料已变化，请取消修订后重新核对；当前输入仍保留');
    if (!edit.title.trim() || !edit.text.trim()) throw new Error('要求标题和内容不能为空');
    sources.reviseCandidate(state, edit.id, edit.title, edit.text);
    if (edit.id === 'RQ-02') state.pending.requirement = edit.preset && edit.text === demo.revisedRequirement;
    state.center.requirementEdit = null;
    state.center.stage = 'prepare';
  }

  function createCenterState(scenario = 'standard') {
    const state = demo.createState(scenario);
    state.selectedFinding = 'F-02';
    state.center = {
      stage: scenario === 'fresh' ? 'prepare' : scenario === 'ready' ? 'conclusion' : 'review',
      navigator: scenario === 'fresh' ? 'files' : 'findings', search: '', inspector: 'judgment', file: scenario === 'fresh' ? 'submit' : 'restore', codeView: 'diff',
      targetLine: null,
      settingsOpen: scenario === 'fresh', opinionOpen: scenario === 'ready', sourceOpen: false, contextExpanded: true,
      closedOpen: false, evidenceOpen: false, basisOpen: false, historyOpen: false,
      focus: false, patches: {}, fixSnapshots: {}, stageIndex: 0, requirementEdit: null,
      detailsOpen: false, fixValidations: {}, manualEdits: {},
      readingPositions: {},
      findingMode: state.mode, patchRevision: 0, feedbackId: null, feedbackReadSource: false, feedbackFilter: 'open', linkedFeedbackPr: null,
    };
    state.reviewContext = { taskId: null, skillIds: [] };
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

  function updateNotes(state, text) {
    if (typeof text !== 'string') throw new Error('补充说明必须是文本');
    const changed = text.trim() !== state.notes.trim();
    state.notes = text;
    if (changed) invalidate(state);
    return changed;
  }

  function selectFinding(state, id) {
    if (!state.findings.some((finding) => finding.id === id)) throw new Error('当前示例不存在这个审查问题');
    state.selectedFinding = id;
    state.center.file = primaryFiles[id];
    state.center.stage = 'review';
    state.center.feedbackId = null;
    if (state.center.navigator !== 'findings') state.center.search = '';
    state.center.navigator = 'findings';
    state.center.inspector = 'judgment';
    state.center.sourceOpen = false;
    state.center.evidenceOpen = false;
    state.center.basisOpen = false;
    state.center.historyOpen = false;
    state.center.targetLine = findingLocation(state, id).line;
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
    state.history.push(`切换为${mode === 'technical' ? '整仓 Bug 审查（无需求）' : '整仓 Bug 与需求一致性审查'}；审查范围不缩小，已知关键问题不会消失。`);
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
    for (const id of Object.keys(state.center.patches)) {
      const finding = state.findings.find((item) => item.id === id);
      if (!finding || finding.type !== 'implementation') continue;
      if (state.center.fixSnapshots[id]) {
        const validation = state.center.fixValidations[id];
        if (!validation?.passed || validation.key !== fixValidationKey(state)) {
          finding.resolved = false;
          finding.status = 'confirmed';
          finding.disposition = validation?.passed === false ? 'validation-failed' : 'patch-applied';
          continue;
        }
      }
      Object.assign(finding, { resolved: true, status: 'resolved', disposition: 'demo-rechecked' });
      const requirement = state.requirements.find((item) => item.id === finding.requirement);
      if (requirement) requirement.check = 'supported';
      state.history.push(`${id} 已走过预设复审分支；仅是状态演示，没有执行真实测试。`);
    }
    state.scopeReview.lastRunKey = scope.key;
    if (state.selectedFinding) selectFinding(state, state.selectedFinding);
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
    const readingReasons = state.sourceReview.readingFile ? ['正在读取需求材料，请等待完成后提交'] : [];
    const editReasons = state.center.requirementEdit ? ['存在尚未保存的需求修订，请先保存或取消'] : [];
    const runningReasons = state.runStatus === 'running' ? ['审查正在进行，请先结束或取消再提交'] : [];
    const fixReasons = Object.keys(state.center.fixSnapshots).filter((id) => {
      const validation = state.center.fixValidations[id];
      return !state.findings.find((item) => item.id === id)?.resolved || !validation?.passed || validation.key !== fixValidationKey(state);
    }).map((id) => `${id} 的示例修复尚未完成当前依据下的验证与复审`);
    return {
      ...gate, eligible: gate.eligible && sourceCheck.reasons.length === 0 && scopeReasons.length === 0 && readingReasons.length === 0 && editReasons.length === 0 && fixReasons.length === 0,
      feedbackAllowed: gate.feedbackAllowed && scopeReasons.length === 0 && readingReasons.length === 0 && runningReasons.length === 0,
      reasons: [...gate.reasons, ...sourceCheck.reasons, ...scopeReasons, ...readingReasons, ...editReasons, ...fixReasons],
      feedbackReasons: [...(!state.hasResults ? ['尚无有效审查结果，请先开始审查'] : []), ...(state.stale ? ['依据已变化，请重新审查后提交反馈'] : []), ...scopeReasons, ...readingReasons, ...runningReasons],
      critical: [...gate.critical, ...sourceCheck.conflicts],
    };
  }

  function conclusionState(state, verdict = state.verdict) {
    if (!Object.hasOwn(verdictLabels, verdict)) throw new Error('未知审查结论');
    const gate = approvalGate(state);
    return verdict === 'approve'
      ? { allowed: gate.eligible, blockers: gate.reasons }
      : { allowed: gate.feedbackAllowed, blockers: gate.feedbackReasons };
  }

  function requestApproval(state) {
    if (state.verdict !== 'approve') throw new Error('请先选择通过当前范围');
    if (!approvalGate(state).eligible) throw new Error('当前条件不允许通过，请先处理阻断项');
    return {
      scopeKey: scopeState(state).key, baselineVersion: state.baselineVersion,
      sourceRevision: state.sourceReview.revision, content: summaryText(state, 'approve'),
    };
  }

  function confirmApproval(state, request) {
    const current = requestApproval(state);
    if (!request || Object.keys(current).some((key) => current[key] !== request[key])) throw new Error('审查依据或待提交内容已变化，请重新确认');
    state.humanConfirmed = true;
    submitVerdict(state, 'approve');
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
    if (!state.hasResults || state.stale || state.runStatus === 'running') throw new Error('请先完成当前快照的有效审查，再应用示例修复');
    state.center.fixSnapshots[id] = {
      finding: JSON.parse(JSON.stringify(finding)),
      check: state.requirements.find((item) => item.id === finding.requirement)?.check,
    };
    finding.disposition = 'patch-applied';
    finding.resolved = false;
    state.stale = true;
    invalidate(state);
    state.center.patches[id] = true;
    state.center.patchRevision += 1;
    delete state.center.fixValidations[id];
    state.center.file = primaryFiles[id];
    state.history.push(`${id} 仅应用示例补丁，结果过期、等待复审；未修改真实源码或执行验证。`);
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
    delete state.center.fixValidations[id];
    state.center.patchRevision += 1;
    state.stale = state.hasResults;
    invalidate(state);
    state.history.push(`${id} 已撤销本次示例修复；原问题恢复，旧结论失效。`);
  }

  function fixValidationKey(state) {
    return JSON.stringify([state.reviewContext.taskId, scopeState(state).key, state.sourceReview.revision, state.center.patchRevision,
      state.reviewContext.skillIds.map((id) => [id, reviewSkills.find((item) => item.id === id).version])]);
  }

  function recordFixValidation(state, id, passed) {
    if (typeof passed !== 'boolean') throw new Error('请选择明确的验证演示结果');
    if (!state.center.fixSnapshots[id] || !state.center.patches[id]) throw new Error('请先应用本次任务的示例补丁');
    if (state.runStatus === 'running' || state.sourceReview.readingFile) throw new Error('请等待当前审查或材料读取完成');
    if (Object.keys(state.center.manualEdits).length) throw new Error('自定义代码副本未分析，不能使用固定示例的验证结果');
    const finding = state.findings.find((item) => item.id === id);
    if (!finding) throw new Error('修复对应的问题不存在');
    state.center.fixValidations[id] = { passed, key: fixValidationKey(state) };
    finding.resolved = false;
    finding.disposition = passed ? 'patch-applied' : 'validation-failed';
    state.stale = true;
    invalidate(state);
    state.history.push(`${id} 预设验证${passed ? '通过，仍需复审' : '失败，保留问题与补丁，禁止通过'}；未执行真实测试或 CI。`);
  }

  function saveManualEdit(state, key, text, expectedKey) {
    if (state.runStatus === 'running' || state.sourceReview.readingFile) throw new Error('请等待当前审查或材料读取完成');
    if (expectedKey !== fixValidationKey(state)) throw new Error('修改目标或依据已变化，请重新打开代码副本');
    const file = sourceFiles(state)[key];
    if (!scopeState(state).files.includes(key) || file?.kind !== 'code') throw new Error('只能修改当前 Repo 范围中的演示代码');
    if (typeof text !== 'string' || !text.trim()) throw new Error('演示代码片段不能为空');
    state.center.manualEdits[key] = { text };
    state.center.patchRevision += 1;
    state.center.file = key;
    state.center.codeView = 'source';
    state.center.navigator = 'files';
    state.center.detailsOpen = false;
    state.center.stage = 'review';
    state.hasResults = false;
    state.stale = true;
    invalidate(state);
    state.history.push(`${file.path} 已手动修改浏览器副本；修改前的预设发现与验证不可沿用，未写入真实分支。`);
  }

  function undoManualEdit(state, key) {
    if (state.runStatus === 'running') throw new Error('请先结束或取消审查');
    if (!state.center.manualEdits[key]) throw new Error('当前文件没有手动修改的代码副本');
    delete state.center.manualEdits[key];
    state.center.patchRevision += 1;
    state.hasResults = false;
    state.stale = true;
    state.runStatus = 'idle';
    invalidate(state);
    state.history.push(`${key} 已撤销手动编辑；原始示例恢复，但旧结论不会自动恢复，需重新审查。`);
  }

  function sourceFiles(state) {
    const code = (key, path, start, lines, highlighted = [], changes = {}) => ({
      key, path, name: path.split('/').at(-1), kind: 'code', start,
      lines: (state.center.manualEdits[key] ? state.center.manualEdits[key].text.split(/\r?\n/) : lines)
        .map((text, index) => ({ text, number: start + index, highlighted: !state.center.manualEdits[key] && highlighted.includes(index), change: state.center.manualEdits[key] ? '' : changes[index] || '' })),
    });
    const document = (key, path, title, paragraphs, highlight) => ({
      key, path, name: path.split('/').at(-1), kind: 'document', title, paragraphs, highlight,
    });
    const restored = !!state.center.patches['F-02'];
    const technical = state.center.findingMode === 'technical';
    const timeoutFixed = !!state.center.patches['F-01'];
    const restoreBody = restored
      ? ['  const reservation = await inventory.reserveForOrder(order);', '  await order.restore();', '  return { reservationId: reservation.id };']
      : ['  await order.restore();', '  const reservation = await inventory.findByOrder(order.id);', '  return { reservationId: reservation.id };'];
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
    const gate = approvalGate(state);
    const scope = scopeState(state);
    const navigation = fileNavigation(state);
    const understanding = understandingChecks(state.requirements, state.hasResults && !state.stale ? state.findings : []);
    const sourceSummary = (sources.selectedSources(state).map((source) => `- [${sources.kindLabels[source.kind]} / ${sources.purposeLabels[source.purpose]}] ${source.location} · 原文 v${source.version}`).join('\n') || '未提供需求来源。') + (state.sourceReview.excluded.length ? `\n排除记录：\n${state.sourceReview.excluded.map((item) => `- ${item.id}：${item.reason}`).join('\n')}` : '');
    const origins = state.requirements.map((item) => `- ${item.id}${state.baselineConfirmed && state.mode === 'requirements' ? '' : '（非本次已确认需求）'}：${item.origins?.map((origin) => `${sources.labelOrigin(state, origin)} [${sources.originStatus(state, origin)}]`).join('；') || '缺少原文引用'}${item.manualRevision ? '；人工修订与原文分别保存' : ''}`).join('\n');
    const limits = coverageLimits(state);
    return [
      `Review vNext · 审查中心原型 · ${verdictLabels[verdict]}`, '',
      `Repository：${scope.repository.name}`,
      `任务：${state.reviewContext.taskId || '独立演示'}；Skill：${state.reviewContext.skillIds.map((id) => { const skill = reviewSkills.find((item) => item.id === id); return `${skill.name} v${skill.version}`; }).join('、') || '未启用'}（仅配置演示，未调用模型）。`,
      `范围：${scope.label}；整仓 ${scope.files.length} 个文件；${navigation.changes.length} 个变更文件只用于定位和归因。`,
      `代码快照：${scope.head.version} / 文件状态基线 ${navigation.base.name} (${navigation.base.version})；全量快照，不以 Diff 定义范围；演示快照 ${state.scopeReview.selection.snapshot}。`,
      `需求：${state.mode === 'technical' ? '无需求，整仓综合 Bug 审查；需求一致性未评审，不代表业务需求已满足。' : `基线 v${state.baselineVersion}，${state.baselineConfirmed ? '已人工确认理解' : '待确认'}。同时整仓查 Bug；需求仅约束适用业务链，不缩小代码范围。`}`,
      `执行：${runLabels[state.runStatus]}${state.stale ? '；依据已变化，旧结果待重审。' : '。'}`, '',
      '本次材料：', sourceSummary, '',
      '需求出处：', origins || '无已确认需求。', '',
      '推导检查点（不新增验收门槛）：',
      understanding.checks.map((item) => `- ${item.requirement}：${item.text}`).join('\n') || '无预设推导。',
      '需核实前提（确认不证明成立，当前状态以裁决为准）：',
      understanding.questions.map((item) => `- ${item.requirement} [${item.status === 'clarified' ? '已在预设裁决中澄清' : '待核实'}]：${item.text}`).join('\n') || '未生成预设前提，不代表不存在未知。', '',
      gate.reasons.length ? `通过限制：\n${gate.reasons.map((reason) => `- ${reason}`).join('\n')}` : `未发现当前演示规则下的批准阻断；${state.humanConfirmed ? '人工已确认边界。' : '仍需人工确认。'}`, '',
      '审查发现：',
      state.hasResults ? state.findings.map((finding) => `- ${finding.id} [${typeLabels[finding.type]} / ${finding.resolved ? '示例已处理或排除' : finding.status === 'unresolved' ? '待核实' : '已确认'}] ${finding.title}`).join('\n') : '尚无有效结果，空列表不代表没有问题。',
      ...(limits.length ? ['', '覆盖限制：', ...limits.map((limit) => `- ${limit}`)] : []),
      ...(state.notes.trim() ? ['', '人工补充：', state.notes.trim()] : []), '',
      '验证边界：仓库代码与审查发现为预设；用户材料默认只在页面内存，明确启用本机保存后才写入当前浏览器。未连接模型、真实仓库或 GitHub，没有执行测试、实际复现或修改真实代码；应用示例补丁不等于运行验证通过。',
    ].concat(['', 'PR 反馈与会话状态（演示）：', feedback.summary(state)]).join('\n');
  }

  function statusLabel(finding) {
    if (finding.disposition === 'validation-failed') return ['验证失败 · 演示', 'red'];
    if (finding.disposition === 'patch-applied') return ['已应用 · 待复审', 'amber'];
    if (finding.status === 'dismissed') return ['已排除', 'green'];
    if (finding.resolved) return ['示例已处理', 'blue'];
    if (finding.status === 'unresolved') return ['尚未确认', 'amber'];
    return ['已确认', 'red'];
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

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { createCenterState, currentFinding, currentChain, problemGroups, findingLocation, selectFile, fileNavigation, comparisonChanges, gitStatusLabels, switchMode, selectFinding, completeReview, applySampleFix, undoSampleFix, sourceFiles, summaryText, approvalGate, confirmBaseline, submitVerdict, statusLabel, preparationState, prepareForReview, chooseMaterial, changeRequirementInclusion, repositories, branches, scopeState, changeScope, coverageLimits, understandingChecks, beginRequirementEdit, saveRequirementEdit, conclusionState, requestApproval, confirmApproval, updateNotes, linkFeedbackPr, selectFeedback, importFeedbackRequirement, syncFeedbackContext,
      createWorkspaceState, addRepositories, loadRepositoryTarget, currentReviewTask, openRepository, createReviewTask, selectReviewTask, rememberRepositoryMaterial, configureSkill, parseWorkspace, reviewSkills, recordFixValidation, saveManualEdit, undoManualEdit, fixValidationKey };
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
  const modal = document.getElementById('center-modal');
  const toast = document.getElementById('center-toast');
  const runStages = ['建立相关业务链', '检查需求与实现', '寻找反证与保障', '形成有边界的结论'];
  const storageKey = 'review-vnext-workspace-v1';
  let workspace = createWorkspaceState();
  let state = createCenterState('fresh');
  let runGeneration = 0;
  const runningTasks = new Map();
  const targetLoadErrors = new Map();
  let fileReadGeneration = 0;
  let toastTimer;
  let pendingApproval = null;
  let pendingFix = null;
  let modalRenderer = null;
  let storageError = '';

  function notify(message, warning = false) {
    clearTimeout(toastTimer);
    toast.textContent = message;
    toast.className = `toast${warning ? ' warning' : ''}`;
    toast.hidden = false;
    toastTimer = setTimeout(() => { toast.hidden = true; }, 6000);
  }

  function activeTask() {
    return workspace.view === 'task' ? currentReviewTask(workspace) : null;
  }

  function persistWorkspace() {
    if (!workspace.remember) return true;
    try {
      localStorage.setItem(storageKey, JSON.stringify(workspace));
      storageError = '';
      return true;
    } catch (error) {
      workspace.remember = false;
      storageError = `本机保存失败：${error.message}。当前任务仍在内存，未宣称保存成功。`;
      notify(storageError, true);
      return false;
    }
  }

  function showWorkspaceSelection() {
    rememberReadingPosition();
    pendingFix = null;
    pendingApproval = null;
    modalRenderer = null;
    if (modal.open) modal.close();
    state = currentReviewTask(workspace)?.state || createCenterState('fresh');
    render(false);
    restoreReadingPosition();
  }

  function restoreReadingPosition() {
    for (const [selector, top] of Object.entries(state.center.readingPositions || {})) {
      const element = main.querySelector(selector);
      if (element) element.scrollTop = top;
    }
    if (activeTask()) locateCurrentCode(false);
  }

  function rememberReadingPosition() {
    state.center.readingPositions = Object.fromEntries(
      ['.problem-list', '.editor-scroll', '.navigator-scroll'].map((selector) => [selector, main.querySelector(selector)?.scrollTop || 0]),
    );
  }

  function loadTarget(value) {
    rememberReadingPosition();
    const previousKey = activeTask() ? scopeState(state).key : null;
    try {
      const task = loadRepositoryTarget(workspace, workspace.selectedRepository, value);
      targetLoadErrors.delete(workspace.selectedRepository);
      state = task.state;
    } catch (error) {
      targetLoadErrors.set(workspace.selectedRepository, { value, message: error.message });
      render();
      return notify(error.message, true);
    }
    pendingFix = null;
    pendingApproval = null;
    const changed = scopeState(state).key !== previousKey;
    render(!changed);
    if (changed) locateCurrentCode();
  }

  function resetDemoScenario(scenario) {
    const task = activeTask();
    if (!task) return notify('请先选择 Repo 和分支 / PR。', true);
    runningTasks.delete(state);
    const selection = state.scopeReview.selection;
    state = createCenterState(scenario);
    changeScope(state, selection);
    state.reviewContext = { taskId: task.id, skillIds: ['business-path'] };
    state.sources.push(...JSON.parse(JSON.stringify(workspace.repositoryMaterials[task.repositoryId])));
    if (!state.hasResults) sources.organize(state);
    task.state = state;
    pendingApproval = null;
    if (modal.open) modal.close();
    modalRenderer = null;
    render(false);
  }

  function renderRepositoryWelcome() {
    return `<section class="repo-welcome" aria-labelledby="repo-welcome-title">${icon('branch')}<h1 id="repo-welcome-title">选择 Repo，开始代码审查</h1><p>添加一个或多个 Repo，再选择分支或 PR 查看代码。</p><button class="button primary" data-action="open-repository">选择 Repo</button><p class="form-hint">离线原型仅提供虚构 Repo，不读取真实仓库。</p>${storageError ? `<p class="input-error" role="status">${escape(storageError)}</p>` : ''}</section>`;
  }

  function renderRepositoryList() {
    return `<section class="repo-navigation" aria-label="Repo 列表"><div class="repo-list-heading"><h2>Repo</h2><button class="text-button" data-action="open-repository" ${workspace.openRepositories.length === repositories.length ? 'disabled title="所有演示 Repo 均已添加"' : ''}>＋ 添加 Repo</button></div><div class="repo-list">${workspace.openRepositories.map((id) => {
      const repository = repositories.find((item) => item.id === id);
      const running = workspace.tasks.some((item) => item.repositoryId === id && item.state.runStatus === 'running');
      return `<button class="repo-item ${id === workspace.selectedRepository ? 'active' : ''}" data-action="select-repository" data-id="${id}" aria-pressed="${id === workspace.selectedRepository}" title="${escape(repository.name)}${running ? ' · 审查中' : ''}">${icon(running ? 'refresh' : 'branch', running ? 'spin' : '')}<span>${escape(repository.name)}</span></button>`;
    }).join('')}</div>${storageError ? `<p class="input-error" role="status">${escape(storageError)}</p>` : ''}</section>`;
  }

  function openRepositoryDialog() {
    const available = repositories.filter((repository) => !workspace.openRepositories.includes(repository.id));
    if (!available.length) return notify('所有演示 Repo 均已添加，可从左侧切换。');
    openModal('选择 Repo', `<form id="repository-selection-form"><div class="modal-body"><p class="small-copy">支持多选。这里只加载虚构示例，不读取本地磁盘或远程仓库。</p><div class="repository-options">${available.map((repository) => `<label class="context-choice"><input type="checkbox" name="repository" value="${repository.id}"><span><strong>${escape(repository.name)}</strong><small>${repository.id === 'checkout' ? '支付、订单与跨文件业务链示例' : '独立的订单恢复示例'}</small></span></label>`).join('')}</div><p id="repository-selection-error" class="input-error" role="alert" hidden></p></div></form>`, '<button class="button" data-action="close">取消</button><button class="button primary" type="submit" form="repository-selection-form">添加所选 Repo</button>');
  }

  function storageDialog() {
    openModal('工作区保存与隐私', `<form id="workspace-storage-form"><div class="modal-body"><p>默认只在页面内存中保留任务，刷新后清除。开启本机保存后，可在刷新后恢复多个 Repo、任务、原文与处理进度。</p><label class="context-choice"><input id="remember-workspace" type="checkbox" ${workspace.remember ? 'checked' : ''}><span><strong>保存工作区到当前浏览器</strong><small>包含粘贴内容和导入文件原文。只写本机浏览器存储，不上传；不建议在共享设备开启。</small></span></label><p class="form-hint">关闭并应用设置会删除已保存的存档，但保留当前页面内存中的任务。中断的运行恢复为未完成，不会假装继续执行成功。</p>${storageError ? `<p class="input-error">${escape(storageError)}</p>` : ''}</div></form>`, '<button class="button" data-action="close">取消</button><button class="button" data-action="clear-workspace-storage">清除本机存档</button><button class="button primary" type="submit" form="workspace-storage-form">应用保存设置</button>');
  }

  function findingBadges(finding) {
    const [label, tone] = statusLabel(finding);
    return `<span class="mono">${finding.id}</span>${badge(typeLabels[finding.type], finding.type === 'reasonable' ? 'green' : finding.type === 'question' ? 'amber' : 'red')}${badge(severityLabels[finding.severity])}${badge(label, tone, true)}${!finding.resolved && finding.critical ? badge('关键', 'amber') : ''}`;
  }

  function getFindings() {
    return state.hasResults ? state.findings : [];
  }

  function issueNav(finding) {
    const [label, tone] = statusLabel(finding);
    return `<button class="issue-nav ${finding.id === state.selectedFinding ? 'active' : ''}" data-action="finding" data-id="${finding.id}" aria-pressed="${finding.id === state.selectedFinding}"><span class="issue-dot ${tone}"></span><span><strong>${escape(finding.title)}</strong><small>${finding.id} · ${typeLabels[finding.type]} · ${severityLabels[finding.severity]}<br>${escape(label)}${!finding.resolved && finding.critical ? ' · 关键' : ''}</small></span></button>`;
  }

  function renderContextControls() {
    const task = activeTask(), scope = task ? scopeState(state) : null;
    const preparation = task ? preparationState(state) : null;
    const summary = scope ? scope.pr ? `PR ${scope.pr.id}` : scope.head.name : '选择分支 / PR';
    const status = state.runStatus === 'running' ? runStages[Math.min(state.center.stageIndex, 3)] : state.scopeReview.discardedResults && !state.hasResults ? '对象已更换，旧结果已失效' : state.stale ? '判断已过期，请重新审查' : state.runStatus === 'partial' ? '结果受限' : runLabels[state.runStatus];
    return `<details id="context-bar" class="context-bar" aria-label="审查对象与需求" ${state.center.contextExpanded ? 'open' : ''}><summary class="context-toggle" title="${escape(summary)}">${icon('chevron')}<span>${escape(summary)}</span></summary><div class="context-controls">${renderScopeSelection()}${task ? `<button class="button" data-action="requirements">${state.center.requirementEdit ? '需求 · 修订未保存' : preparation.requirements.length ? `需求 ${preparation.requirements.length}${preparation.needsConfirmation ? ' · 待确认' : ''}` : '需求（可选）'}</button><span id="review-status" class="${state.stale ? 'status-warning' : ''}" role="status" title="${escape([...coverageLimits(state), ...preparation.reasons].join('；'))}">${escape(status)}</span>` : ''}</div></details>`;
  }

  function renderNavigator() {
    const repositoryList = renderRepositoryList();
    if (!workspace.selectedRepository) return repositoryList;
    if (!activeTask()) return repositoryList + renderContextControls();
    const search = state.center.search.toLowerCase();
    const groups = problemGroups(state);
    const matches = (finding) => `${finding.title} ${finding.source} ${finding.id}`.toLowerCase().includes(search);
    const navigation = fileNavigation(state), fileView = state.center.navigator === 'files';
    const fileList = navigation.rows.filter((file) => `${file.path} ${file.previousPath ?? ''}`.toLowerCase().includes(search)).map((file) => {
      const path = file.previousPath ? `${file.previousPath} → ${file.path}` : file.path;
      const status = file.status ? `${gitStatusLabels[file.status]} · 相对 ${navigation.base.name}` : `未变化 · 相对 ${navigation.base.name}`;
      return `<button class="file-nav ${state.center.file === file.key ? 'active' : ''}" data-action="source" data-source="${file.key}" aria-pressed="${state.center.file === file.key}" title="${escape(path)} · ${escape(status)}">${icon(file.kind === 'code' ? 'code' : 'file')}<span>${escape(path)}</span>${file.status ? `<small class="file-role git-status git-${file.status.toLowerCase()}" aria-label="${escape(status)}">${file.status}</small>` : ''}</button>`;
    }).join('');
    return `${repositoryList}${renderContextControls()}<div class="navigator-heading"><h2>审查导航</h2></div>
      <div class="nav-segments" role="tablist" aria-label="问题与文件"><button class="nav-segment ${!fileView ? 'active' : ''}" role="tab" aria-selected="${!fileView}" data-action="navigator" data-tab="findings">问题 ${groups.open.length}</button><button class="nav-segment ${fileView ? 'active' : ''}" role="tab" aria-selected="${fileView}" data-action="navigator" data-tab="files" title="状态相对 ${escape(navigation.base.name)}">${navigation.label} ${navigation.rows.length}</button></div>
      <div class="navigator-search">${icon('search')}<input id="center-search" type="search" placeholder="${fileView ? `搜索${navigation.label === 'Changes' ? '变更文件' : '仓库文件'}` : '搜索问题'}" aria-label="搜索导航" value="${escape(state.center.search)}"></div>
      <div class="navigator-scroll">${fileView ? fileList || '<p class="small-copy">没有匹配的仓库文件。</p>' : groups.open.filter(matches).map(issueNav).join('') || `<p class="small-copy">${search ? '没有匹配的问题。' : state.hasResults ? '本次没有待处理问题。' : '尚未开始审查，可以先浏览代码。'}</p>`}
      ${!fileView && groups.closed.length ? `<details id="closed-problems" ${state.center.closedOpen ? 'open' : ''}><summary>已处理 / 排除 · ${groups.closed.length}</summary>${groups.closed.filter(matches).map(issueNav).join('')}</details>` : ''}</div>`;
  }

  function renderTop() {
    const task = activeTask();
    const preparation = preparationState(state);
    document.getElementById('product-mark').innerHTML = icon('shield');
    document.getElementById('repository-context').textContent = '离线原型 · 未连接模型与真实仓库';
    document.querySelector('.command-actions [data-action="help"]').innerHTML = icon('info');
    const dark = document.documentElement.dataset.theme === 'dark';
    document.getElementById('center-theme').innerHTML = icon(dark ? 'sun' : 'moon');
    document.getElementById('center-theme').setAttribute('aria-label', `切换为${dark ? '浅色' : '深色'}主题`);
    document.getElementById('demo-scenario').value = state.scenario;
    const running = state.runStatus === 'running';
    const toolsDisabled = !task || running || state.sourceReview.readingFile || !!state.center.requirementEdit;
    document.querySelectorAll('#demo-tools button').forEach((button) => { button.disabled = button.dataset.action !== 'workspace-storage' && toolsDisabled; });
    document.getElementById('demo-scenario').disabled = toolsDisabled;
    document.getElementById('center-reset').disabled = !task;
    document.getElementById('demo-requirement').disabled = toolsDisabled || !preparationState(state).items.some((item) => item.id === 'RQ-02');
    const sourcePicker = document.getElementById('demo-source');
    const selectedSource = sourcePicker.value;
    sourcePicker.innerHTML = state.sources.map((item) => `<option value="${escape(item.id)}" ${item.id === selectedSource ? 'selected' : ''}>${escape(item.name)} · v${item.version}</option>`).join('');
    sourcePicker.disabled = toolsDisabled;
    const run = document.getElementById('run-review');
    run.hidden = !task;
    run.dataset.action = running ? 'cancel' : 'prepare-start';
    const loadError = targetLoadErrors.get(workspace.selectedRepository);
    run.disabled = !running && (!preparation.canStart || !!loadError);
    run.title = loadError ? '新对象未加载，当前保留旧代码。请重试或重新选择分支 / PR。' : preparation.canStart ? '' : preparation.reasons.join('；');
    run.innerHTML = `${icon(running ? 'close' : 'play')}${running ? '取消审查' : preparation.needsConfirmation ? preparation.label : ['partial', 'cancelled'].includes(state.runStatus) && !state.stale ? '继续审查' : state.runStatus === 'idle' ? '开始审查' : '重新审查'}`;
    document.getElementById('review-opinion-toggle').hidden = !task || !state.hasResults;
  }

  function progressStrip() {
    let progress = '';
    if (state.runStatus === 'running') progress = `<div class="progress-strip" aria-live="polite">${icon('refresh', 'spin')}<strong>模拟步骤 ${Math.min(state.center.stageIndex + 1, 4)} / 4</strong><span>${runStages[Math.min(state.center.stageIndex, 3)]}</span></div>`;
    else if (state.runStatus === 'cancelled') progress = `<div class="progress-strip">${icon('info')}${state.hasResults ? '审查已取消，保留此前有效结果。' : '审查已取消，本次尚未形成有效结果。'}可使用顶部按钮继续审查。</div>`;
    else if (state.stale) progress = `<div class="progress-strip">${icon('refresh')}依据已变化，旧结果不可直接用于结论。${state.mode === 'requirements' && !state.baselineConfirmed ? '<button class="text-button" data-action="stage" data-stage="prepare">重新确认需求</button>' : '请使用顶部按钮重新审查。'}</div>`;
    const limits = coverageLimits(state);
    const coverage = limits.length ? `<div class="progress-strip coverage-limits" role="status">${icon('alert')}${state.center.stage === 'conclusion' ? `<span>${limits.length} 项覆盖限制，详情见下方待提交内容。</span>` : `<div><strong>审查覆盖受限</strong><ul>${limits.map((limit) => `<li>${escape(limit)}</li>`).join('')}</ul></div>`}</div>` : '';
    return progress + coverage;
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

  function findingMarker(finding) {
    if (!state.hasResults) return '';
    const [label, tone] = statusLabel(finding);
    return `<button class="finding-marker ${tone}" data-action="focus-finding" aria-label="查看 ${finding.id}：${escape(finding.title)}">${icon(finding.resolved ? 'shield' : finding.type === 'question' ? 'info' : 'bug')}<strong>${finding.id}</strong><span>${label}${state.center.patches[finding.id] ? ' · 待验证' : ''}</span><span>查看判断 ${icon('arrow')}</span></button>`;
  }

  function renderEditor() {
    const files = sourceFiles(state);
    const file = files[state.center.file];
    if (!file) throw new Error('找不到当前示例文件');
    const item = currentFeedback();
    const finding = item ? null : currentFinding(state);
    const scope = scopeState(state);
    const patched = Object.keys(state.center.patches).length > 0;
    const navigation = fileNavigation(state), change = navigation.changes.find((entry) => entry.key === file.key);
    const path = change?.path ?? file.path;
    const diffAvailable = file.kind === 'code' && !!change && !state.center.manualEdits[file.key];
    const source = state.center.codeView === 'source' || !diffAvailable;
    let body;
    if (file.kind === 'document') {
      body = `<article class="document-copy"><p class="doc-kicker">${escape(file.sourceInfo || '需求 / 契约证据')} · ${file.userProvided ? '用户提供的原文快照' : '演示原文'}</p><h2>${escape(file.title)}</h2>${typeof file.markdownText === 'string' ? markdownReader(file.markdownText) : file.paragraphs.map(([line, text]) => `<div id="sample-doc-line-${line}" class="doc-paragraph ${line === file.highlight ? 'highlighted' : ''}"><span class="mono">L${line}</span><p>${escape(text)}</p></div>`).join('')}</article>`;
    } else {
      const displayedLines = file.lines.map((line) => ({ ...line, change: change?.status === 'A' ? 'added' : change?.status === 'D' ? 'removed' : line.change }));
      const lines = displayedLines.map((line) => `<div class="code-line ${source ? 'source-view' : ''} ${!source && line.change ? line.change : ''} ${line.highlighted ? 'emphasized' : ''}" id="sample-line-${line.number}">${source ? '' : `<span class="line-no">${line.change === 'added' ? '' : line.number}</span>`}<span class="line-no">${!source && line.change === 'removed' ? '' : line.number}</span><span class="change">${source ? '' : line.change === 'added' ? '+' : line.change === 'removed' ? '−' : ''}</span><code>${syntax(line.text) || ' '}</code></div>`).join('');
      body = `<div class="code-caption"><span>${change?.status === 'D' ? '删除前源码' : source ? '当前源码' : `行内 Diff · 相对 ${escape(navigation.base.name)}`}</span><strong>演示片段 ${file.start}–${file.lines.at(-1).number} · 非完整文件</strong></div><div class="code-table">${lines}</div>`;
    }
    const feedbackContext = item ? `<div class="feedback-location"><strong>${escape(item.id)} · ${escape(item.title)}</strong><span>${item.isOutdated ? '原位置 Outdated；当前代码只作对照，不会自动重定位。' : '阅读关联代码不会改变 Reply 目标。'}</span>${item.originalDiff ? `<button class="text-button" data-action="feedback-original" data-id="${item.id}">查看评论时的 Diff</button>` : ''}</div>` : '';
    return `<div class="editor-tools"><div class="editor-breadcrumb" title="${escape(path)} · ${escape(scope.head.version)} · 只读演示${patched ? ` · 浏览器补丁 ${state.center.patchRevision}` : ''}${scope.pr && !change ? ' · 关联文件，不在 PR Changes 内' : ''}"><strong>${escape(path)}</strong></div><div class="editor-view-controls">${diffAvailable ? `<button class="tiny-toggle ${!source ? 'active' : ''}" data-action="code-view" data-view="diff">Diff</button><button class="tiny-toggle ${source ? 'active' : ''}" data-action="code-view" data-view="source">源码</button>` : badge(file.kind === 'code' ? '源码' : '项目文档', 'blue')}${file.kind === 'code' ? `<button class="button small" data-action="manual-edit" data-source="${file.key}" ${state.runStatus === 'running' ? 'disabled' : ''}>修改代码副本</button>` : ''}${state.center.manualEdits[file.key] ? `<button class="button small" data-action="undo-manual" data-source="${file.key}">撤销手动修改</button>` : ''}${state.hasResults && finding ? '<button class="button small" data-action="finding-details">问题详情</button>' : ''}</div></div>${feedbackContext}<div class="code-snapshot">${escape(scope.repository.name)} · ${escape(scope.head.name)} · ${escape(scope.head.version)}${state.center.manualEdits[file.key] ? ' · 手动编辑副本，未分析，不能复用旧结论' : patched ? ` · 浏览器补丁 ${state.center.patchRevision}` : ' · 只读快照'}</div><div class="editor-scroll">${progressStrip()}${body}</div>`;
  }

  function requirementOrigins(requirement) {
    return (requirement.origins || []).map((origin) => {
      const source = sources.getSource(state, origin.sourceId);
      const status = sources.originStatus(state, origin);
      return `<section class="trace-origin"><div class="trace-origin-heading"><strong>${escape(source.name)}</strong>${badge(status, status === '当前版本' ? 'blue' : 'amber')}</div><p class="form-hint">${escape(sources.labelOrigin(state, origin))}</p><blockquote class="quote raw-quote">${escape(origin.quote)}</blockquote><button class="text-button" data-action="material" data-source-id="${source.id}" data-version="${origin.version}">查看引用时的原文 v${origin.version}</button></section>`;
    }).join('') || '<p class="input-error">缺少可核对的原文引用，不能当作已确认依据。</p>';
  }

  function requirementMarkup(requirement) {
    const included = requirement.include !== false;
    const edit = state.center.requirementEdit?.id === requirement.id ? state.center.requirementEdit : null;
    const disabled = state.center.requirementEdit || state.runStatus === 'running' ? 'disabled' : '';
    return `<article class="requirement-item ${included ? '' : 'excluded'}" data-understanding-id="${requirement.id}">
      <div class="requirement-item-head"><span class="rq-id">${requirement.id}</span><h3>${escape(requirement.title)}</h3>${badge(included ? requirement.basis === 'human' ? '人工补充 / 修订' : '原文明确要求' : '不适用', included ? 'blue' : '')}</div>
      ${edit ? `<form id="center-requirement-form" class="requirement-editor"><label class="field-label" for="center-requirement-title">条目标题</label><input id="center-requirement-title" class="text-field" required value="${escape(edit.title)}"><label class="field-label" for="center-requirement-text">需求与验收条件</label>${markdownEditor('center-requirement-text', edit.text, 5)}${edit.revision !== state.sourceReview.revision ? '<p class="input-error">材料已变化，当前输入仍保留。请取消修订后重新核对来源。</p>' : ''}<div class="requirement-edit-actions"><button type="button" class="button small" data-action="cancel-requirement-edit">取消修订</button><button type="submit" class="button primary small">保存修订</button></div></form>` : `<div class="markdown-body requirement-markdown">${markdown.render(requirement.text)}</div>`}
      ${!included ? `<p class="form-hint">排除原因：${escape(requirement.exclusionReason || '尚未说明')}</p>` : ''}
      <details class="requirement-provenance"><summary>来源与版本 · ${requirement.origins?.length || 0} 处原文</summary>${requirementOrigins(requirement)}</details>
      ${edit ? '' : `<div class="requirement-item-footer"><button class="text-button" data-action="edit-requirement" data-id="${requirement.id}" ${disabled}>${icon('edit')}修订</button><button class="text-button" data-action="${included ? 'exclude-requirement' : 'include-requirement'}" data-id="${requirement.id}" ${disabled}>${included ? '不适用于本次审查' : '重新纳入'}</button></div>`}
      </article>`;
  }

  function renderSourceChoices() {
    return `<p class="small-copy">选择立即生效；包含预设示例与本次已提供的原文，不会自动把事实背景当作要求。</p>
      <div class="material-picker-list">${state.sources.map((source) => `<div class="material-picker-row"><label><input type="checkbox" name="material-selection" value="${source.id}" ${source.selected ? 'checked' : ''}><span><strong>${escape(source.name)}</strong><small>${sources.kindLabels[source.kind]} · ${escape(source.location)}</small>${source.kind === 'pr' ? '<small>仅明确的验收片段进入要求；改动摘要不反推为需求。</small>' : ''}</span></label><button class="text-button" data-action="material" data-source-id="${source.id}">原文</button></div>`).join('')}</div>
      <p class="form-hint" id="materials-count">${sources.selectedSources(state).length} 份材料已选入。PR 描述不会因为选了 PR 就自动成为需求。</p>`;
  }

  function conflictMarkup(conflicts) {
    return conflicts.map((conflict) => `<div class="inline-notice source-conflict">${icon('alert')}<div><strong>${conflict.id} · ${escape(conflict.title)}（预设）</strong><p>${escape(conflict.detail)}</p><p class="form-hint">${conflict.left} ↔ ${conflict.right} · 确认基线不代表冲突已解决。</p></div></div>`).join('');
  }

  function renderScopeSelection() {
    const task = activeTask();
    const repository = repositories.find((item) => item.id === workspace.selectedRepository);
    const selection = task?.state.scopeReview.selection;
    const disabled = task && (state.runStatus === 'running' || state.sourceReview.readingFile || state.center.requirementEdit) ? 'disabled' : '';
    const selected = selection ? selection.kind === 'pr' ? `pr:${selection.pr}` : `branch:${selection.branch}` : '';
    const loadError = targetLoadErrors.get(repository.id);
    return `<div class="scope-form compact-scope">
      <label class="scope-field" for="scope-target"><span>分支 / PR</span><select id="scope-target" class="text-field" ${disabled}><option value="" disabled ${!selection ? 'selected' : ''}>选择分支或 PR</option><optgroup label="PR">${repository.prs.map((pr) => `<option value="pr:${pr.id}" ${selected === `pr:${pr.id}` ? 'selected' : ''}>PR ${pr.id} · ${escape(pr.title)}</option>`).join('')}</optgroup><optgroup label="分支">${branches.map((branch) => `<option value="branch:${escape(branch.name)}" ${selected === `branch:${branch.name}` ? 'selected' : ''}>${escape(branch.name)}</option>`).join('')}</optgroup></select></label>
      ${loadError ? `<div id="scope-load-error" class="target-load-error" role="alert"><p>${escape(loadError.message)}</p><button class="text-button" data-action="retry-target">重试加载</button></div>` : ''}
      ${task ? `<p class="scope-caption">${escape(scopeState(state).head.version)} · 快照 ${selection.snapshot}<br>${selection.kind === 'pr' ? `Changes 相对 ${escape(scopeState(state).base.name)}` : `文件状态相对 ${escape(repository.defaultBranch)}`}</p>` : ''}
      </div>`;
  }

  function understandingExtras(preparation, expanded = false) {
    if (!preparation.checks.length && !preparation.questions.length) return '';
    const pending = preparation.questions.filter((item) => item.status !== 'clarified');
    const clarified = preparation.questions.filter((item) => item.status === 'clarified');
    return `<details class="understanding-extras" ${expanded ? 'open' : ''}><summary>推导检查点 ${preparation.checks.length} 项 · 待核实前提 ${pending.length} 项${clarified.length ? ` · 已澄清 ${clarified.length} 项（演示）` : ''}</summary>
      ${preparation.checks.length ? `<h3>推导检查点 · 不新增验收门槛</h3><ul>${preparation.checks.map((item) => `<li><span class="mono">${item.requirement}</span> ${escape(item.text)}</li>`).join('')}</ul>` : ''}
      ${pending.length ? `<h3>待核实 · 确认后仍需验证</h3><ul>${pending.map((item) => `<li><span class="mono">${item.requirement}</span> ${escape(item.text)}</li>`).join('')}</ul>` : ''}
      ${clarified.length ? `<h3>已在当前预设裁决中澄清 · 非真实验证</h3><ul>${clarified.map((item) => `<li><span class="mono">${item.requirement}</span> ${escape(item.text)}</li>`).join('')}</ul>` : ''}
      <p class="form-hint">检查点不增加要求；前提仍需核实。</p></details>`;
  }

  function renderPrepare() {
    const preparation = preparationState(state);
    const selected = sources.selectedSources(state);
    const edit = state.center.requirementEdit;
    const items = edit && !preparation.items.some((item) => item.id === edit.id) ? [edit.original, ...preparation.items] : preparation.items;
    return `<div class="settings-body">
      <section class="requirements-settings"><div class="prepare-section-title"><h2>本次参考材料 <small>需求可选</small></h2><button class="button small" data-action="add-material" ${state.runStatus === 'running' || state.sourceReview.readingFile ? 'disabled' : ''}>${icon('edit')}添加参考材料</button></div>
      <p class="form-hint">${preparation.requirements.length ? '需求是适用业务链的审核标准；同时整仓查 Bug。' : '无需求时默认整仓综合 Bug 审查，不需要额外选择。'}</p>
      <div class="compact-materials">${selected.map((source) => `<div class="material-row"><button class="material-chip" data-action="material" data-source-id="${source.id}">${icon(source.kind === 'pr' ? 'branch' : source.kind === 'link' ? 'link' : 'file')}<span>${escape(source.name)}</span>${badge(source.userProvided && !source.demoRecognized ? '待分析' : '演示', source.userProvided && !source.demoRecognized ? 'amber' : '')}</button><button class="text-button" data-action="remove-material" data-source-id="${source.id}" aria-label="移除 ${escape(source.name)}">移除</button></div>`).join('')}</div></section>
      <details id="understanding-details" ${edit || preparation.needsConfirmation && items.length ? 'open' : ''}><summary>本次理解 · ${preparation.requirements.length} 条明确要求${preparation.needsConfirmation ? ' · 开始前需确认' : ''}</summary>
      <div class="understanding-body"><div class="prepare-section-title"><h2>核对需求理解</h2><button class="text-button" data-action="add-explicit-requirement">补充明确要求</button></div>
      ${preparation.summary ? `<p class="understanding-intent">${escape(preparation.summary)}</p>` : ''}
      ${conflictMarkup(preparation.conflicts)}
      <div class="requirement-list">${items.map(requirementMarkup).join('') || `<p class="small-copy">${selected.length ? '原文已保留，尚未形成可确认的要求。' : '尚未提供明确要求。'}可补充要求，或开始需求一致性未评审的技术审查。</p>`}</div>
      ${understandingExtras(preparation)}
      ${preparation.notices.length ? `<details class="analysis-pending"><summary>${preparation.notices.length} 份材料尚待分析或重新提取</summary><ul>${preparation.notices.map((notice) => `<li>${escape(notice)}</li>`).join('')}</ul></details>` : ''}
      ${state.sourceReview.draft?.removed.length ? `<p class="form-hint analysis-pending">旧条目 ${state.sourceReview.draft.removed.join('、')} 未在新材料中提取；原文与历史保留，旧结论失效。</p>` : ''}
      ${preparation.reasons.length ? `<div class="inline-notice" role="status">${icon('info')}<strong>${escape(preparation.reasons.join('；'))}</strong></div>` : ''}
      <p class="form-hint">${preparation.needsConfirmation ? '使用顶部按钮确认理解并开始；确认不代表需求本身正确。' : '来源与修订分别保存，不改变原文。'}</p></div></details>
      </div>`;
  }

  function addMaterialDialog() {
    openModal('添加参考材料', `<div class="modal-body material-input-actions">
      <button class="button" data-action="paste-material">${icon('edit')}粘贴内容</button>
      <button class="button" data-action="link-material">${icon('link')}读取链接</button>
      <button class="button" data-action="file-material">${icon('file')}读取本地文件</button>
      <p class="form-hint">适合本次需求、设计和验收标准，无需改写成 Skill。支持 Markdown / 文本，本地读取不上传；链接仅支持演示快照。</p>
      <button class="button small" data-action="use-example-materials">载入示例需求（演示）</button></div>`);
  }

  function materialsDialog() {
    openModal('选择可用材料 · 演示工具', `<div class="modal-body">${renderSourceChoices()}</div>`);
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
    return `<section class="inspector-section"><div class="section-heading"><h3>${icon('link')}支持当前判断的证据</h3></div>${finding.evidence.map((item, index) => `<article class="evidence-card"><div class="evidence-card-head">${icon('file')}<span>${escape(item.title)}</span></div><p>${escape(item.text)}</p><button class="evidence-link" data-action="source" data-source="${evidenceTarget(finding, index)}">${icon('link')}${escape(item.source)}</button></article>`).join('')}</section><section class="inspector-section"><div class="section-heading"><h3>${icon('shield')}反证与保障</h3></div>${finding.counter.map((item) => `<article class="evidence-card"><div class="evidence-card-head">${icon('search')}<span>${escape(item.title)}</span></div><p>${escape(item.text)}</p></article>`).join('')}</section>`;
  }

  function renderHistory(finding) {
    const history = state.history.filter((entry) => entry.includes(finding.id) || (finding.requirement && entry.includes(finding.requirement)));
    return `<section class="inspector-section"><div class="section-heading"><h3>${icon('message')}处置记录</h3></div>${history.map((entry) => `<article class="evidence-card"><p>${escape(entry)}</p></article>`).join('') || '<p class="small-copy">尚无相关操作。</p>'}</section>`;
  }

  function renderFindingInspector() {
    const finding = currentFinding(state);
    if (!state.hasResults || !finding) return `<div class="judgment-body empty-state">${icon('search')}<h2>${state.runStatus === 'idle' ? '尚未开始审查' : '当前没有有效问题判断'}</h2><p>可以先浏览左侧文件。审查完成后，点击问题自动定位代码，并在这里核对判断与操作。</p></div>`;
    if (!problemGroups(state).open.length && !state.center.closedOpen) return `<div class="judgment-body empty-state">${icon('search')}<h2>本次没有待处理问题</h2><p>展开左侧已处理 / 排除记录可查看依据。代码仍可阅读；演示结果不证明真实代码正确。</p></div>`;
    const keyEvidence = finding.evidence[0];
    const files = sourceFiles(state);
    const linked = currentChain(state).files.filter((key) => files[key]);
    const patched = !!state.center.patches[finding.id], busy = state.runStatus === 'running';
    const cannotFix = busy || !patched && (state.stale || finding.resolved);
    const location = findingLocation(state);
    return `<div class="judgment-body"><div class="problem-heading"><div class="issue-badges">${findingBadges(finding)}</div><button class="text-button" data-action="next" title="下一问题（F8）" aria-keyshortcuts="F8" ${problemGroups(state).open.length ? '' : 'disabled'}>下一问题 ${icon('arrow')}</button></div>
      <h2 class="inspector-title" tabindex="-1">${escape(finding.title)}</h2><p class="inspector-summary">${escape(finding.summary)}</p>
      <p class="form-hint">归因：${scopeState(state).head.name !== fileNavigation(state).base.name ? escape(finding.origin) : '当前为默认分支，未区分新增与既有'} · 演示判断</p>
      ${finding.resolved ? '<p class="form-hint">当前显示已处理或排除的判断，用于对照，不作为待修改问题。</p>' : ''}
      <button class="evidence-link primary-location" data-action="locate-finding" data-id="${finding.id}">${icon('link')}${escape(location.path)}:${location.line} · 定位主要代码</button>
      ${finding.disposition === 'patch-applied' ? '<div class="inline-notice">示例补丁已应用 · 待验证和复审。应用不等于问题已解决。</div>' : finding.disposition === 'validation-failed' ? '<div class="inline-notice source-conflict">预设验证失败。保留补丁与问题，不能通过；可撤销或重新验证。</div>' : ''}
      <section class="problem-impact"><h3>${finding.type === 'reasonable' ? '成立的边界' : '影响与触发条件'}</h3><p>${escape(finding.impact)}</p></section>
      ${keyEvidence ? `<section class="key-evidence"><h3>关键证据</h3><p>${escape(keyEvidence.text)}</p><button class="evidence-link" data-action="source" data-source="${evidenceTarget(finding, 0)}">${icon('link')}${escape(keyEvidence.source)}</button></section>` : ''}
      ${finding.counter[0] ? `<p class="counter-summary"><strong>反证核查：</strong>${escape(finding.counter[0].title)}——${escape(finding.counter[0].text)}</p>` : ''}
      <details id="problem-basis" ${state.center.basisOpen ? 'open' : ''}><summary>业务路径与需求依据</summary>${renderJudgment(finding)}</details>
      <details id="problem-evidence" ${state.center.evidenceOpen ? 'open' : ''}><summary>全部证据与反证 · ${finding.evidence.length + finding.counter.length}</summary>${renderEvidence(finding)}</details>
      <details class="related-source-list"><summary>关联文件与原文 · ${linked.length}</summary><div class="related-files">${linked.map((key) => `<button class="text-button" data-action="source" data-source="${key}">${escape(files[key].path)}</button>`).join('')}</div></details>
      <details id="problem-history" ${state.center.historyOpen ? 'open' : ''}><summary>记录与处理${finding.disposition === 'commented' && finding.critical && !finding.resolved ? ' · 已评论，关键项仍未闭合' : ''}</summary>${renderHistory(finding)}
      </details></div><div class="judgment-actions">${finding.type === 'implementation' ? `<button class="button primary" data-action="fix-preview" data-id="${finding.id}" ${cannotFix ? 'disabled' : ''}>${icon('code')}${patched ? '查看已应用的示例' : '生成修复方案（演示）'}</button>` : finding.type === 'requirement' ? `<button class="button primary" data-action="edit-requirement" data-id="${finding.requirement}" ${busy ? 'disabled' : ''}>澄清需求</button>` : finding.type === 'question' ? `<button class="button primary" data-action="evidence" ${busy ? 'disabled' : ''}>补充契约证据</button>` : ''}
      ${state.center.fixSnapshots[finding.id] ? `<button class="button outline-accent" data-action="validate-fix" data-id="${finding.id}" ${busy ? 'disabled' : ''}>验证与复审（演示）</button><button class="button" data-action="undo-fix" data-id="${finding.id}" ${busy ? 'disabled' : ''}>撤销示例补丁</button>` : ''}
      <button class="button" data-action="${finding.type === 'reasonable' ? 'boundary' : 'comment'}" data-id="${finding.id}" ${busy ? 'disabled' : ''}>${finding.type === 'reasonable' ? '记录边界' : '记录说明 / 反证'}</button></div>`;
  }

  function renderConclusion() {
    return `<div class="conclusion-scroll">
      ${state.submission ? `<div class="inline-notice blue submission-record">${icon('check')}<div><strong>已在当前原型记录：${verdictLabels[state.submission.verdict]}</strong><p>没有写回 GitHub。新的依据、内容或处置会使这份模拟记录失效。</p></div></div>` : ''}
      <section class="prepare-section"><label class="field-label" for="center-notes">补充说明 <span class="muted">可选</span></label><textarea class="textarea" id="center-notes" placeholder="补充业务判断、风险或需要协调的事项…">${escape(state.notes)}</textarea></section>
      <section class="prepare-section submission-preview"><div class="prepare-section-title"><h2>待提交内容</h2><div class="summary-actions"><button class="text-button" data-action="copy-summary">复制</button><button class="text-button" data-action="download">${icon('download')}下载</button></div></div><div class="summary-text" id="center-summary">${escape(summaryText(state))}</div></section>
      </div>`;
  }

  function renderConclusionInspector() {
    const gate = approvalGate(state);
    const decision = conclusionState(state);
    const preparation = preparationState(state);
    const needsPreparation = !preparation.canStart || preparation.needsConfirmation || !preparation.scope.supportsFindings;
    const status = state.submission?.verdict === state.verdict ? `已记录${verdictLabels[state.verdict]}` : decision.allowed ? state.verdict === 'approve' ? '待最终确认' : '可提交反馈' : '暂不可提交';
    return `<div class="opinion-status">${badge(status, decision.allowed ? 'blue' : 'amber')}</div><div class="verdict-options" role="radiogroup" aria-label="选择审查意见">${[['request-changes', '要求修改', '需要修改或核实的问题'], ['comment', '仅评论', '反馈不代表通过'], ['approve', '通过当前范围', gate.eligible ? '提交时最终确认边界' : `${gate.reasons.length} 项通过限制`]].map(([id, title, note]) => `<label class="verdict-option"><input type="radio" name="center-verdict" value="${id}" ${state.verdict === id ? 'checked' : ''}><span><strong>${title}</strong><small>${note}</small></span></label>`).join('')}</div>
      ${decision.blockers.length ? `<section class="decision-blockers" role="status"><h2>当前不能${verdictLabels[state.verdict]}</h2><ul>${decision.blockers.map((reason) => `<li>${escape(reason)}</li>`).join('')}</ul>${needsPreparation ? '<button class="text-button" data-action="settings">就地核对审查设置</button>' : ''}</section>` : gate.critical.length ? `<p class="form-hint">${gate.critical.length} 项关键未决仍保留，不因提交反馈解除。</p>` : ''}
      <button class="button primary" id="center-submit" data-action="submit" ${decision.allowed ? '' : 'disabled'}>${icon('message')}记录${verdictLabels[state.verdict]}（演示）</button>`;
  }

  function render(preserve = true) {
    const focused = document.activeElement;
    const focusId = focused?.id;
    const selection = focused instanceof HTMLTextAreaElement || focused instanceof HTMLInputElement && ['text', 'search', 'url'].includes(focused.type) ? [focused.selectionStart, focused.selectionEnd] : null;
    const positions = preserve ? Object.fromEntries(['.problem-list', '.editor-scroll', '.navigator-scroll', '.judgment-body'].map((selector) => [selector, document.querySelector(selector)?.scrollTop || 0])) : {};
    renderTop();
    main.innerHTML = !workspace.openRepositories.length ? renderRepositoryWelcome()
      : `<div class="linked-workspace"><aside class="problem-list" aria-label="Repo、问题与仓库文件">${renderNavigator()}</aside><section id="review-code" class="code-pane" aria-label="代码块与定位">${activeTask() ? renderEditor() : `<div class="target-placeholder">${icon(workspace.selectedRepository ? 'code' : 'branch')}<h2>${workspace.selectedRepository ? '选择分支或 PR' : '选择一个 Repo'}</h2><p>${workspace.selectedRepository ? '从左侧选择审查对象，即可浏览代码。无需先开始审查。' : '从左侧 Repo 列表选择一个仓库，再选择分支或 PR。'}</p></div>`}</section></div>`;
    if (modal.open && modalRenderer) {
      modal.querySelector('#workspace-dialog-body').innerHTML = modalRenderer();
      if (state.center.requirementEdit?.preview) setMarkdownEditorMode(modal.querySelector('#center-requirement-form [data-markdown-editor]'), 'preview');
    }
    for (const [selector, top] of Object.entries(positions)) {
      const element = document.querySelector(selector);
      if (element) element.scrollTop = top;
    }
    if (focusId) {
      const element = document.getElementById(focusId);
      if (element) {
        element.focus({ preventScroll: true });
        if (selection && (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) element.setSelectionRange(...selection);
      }
    }
    if (state.center.requirementEdit?.preview) {
      const editor = document.querySelector('#center-requirement-form [data-markdown-editor]');
      if (editor) setMarkdownEditorMode(editor, 'preview');
    }
    persistWorkspace();
  }

  function stage(id) {
    if (!stages.some(([key]) => key === id)) throw new Error('未知审查阶段');
    if (id === 'prepare') state.center.stage = 'prepare';
    render();
    if (id === 'prepare') openRequirements();
    if (id === 'conclusion') openOpinion();
  }

  function openSource(key) {
    selectFile(state, key);
    state.center.stage = 'review';
    render();
    locateCurrentCode();
  }

  function locateCurrentCode(scrollToTarget = true) {
    const scroll = main.querySelector('#review-code .editor-scroll');
    if (!scroll) return;
    const line = state.center.targetLine ?? (state.hasResults && state.center.file === primaryFiles[state.selectedFinding] ? findingLocation(state).line : null);
    const target = line ? scroll.querySelector(`#sample-line-${line},#sample-doc-line-${line}`) : null;
    scroll.querySelectorAll('.targeted-line').forEach((element) => element.classList.remove('targeted-line'));
    if (target) {
      target.classList.add('targeted-line');
      if (scrollToTarget) scroll.scrollTop += target.getBoundingClientRect().top - scroll.getBoundingClientRect().top - scroll.clientHeight / 3;
    } else if (scrollToTarget) scroll.scrollTop = 0;
  }

  function nextFinding() {
    if (state.center.navigator === 'feedback') {
      const items = feedback.session(state)?.items || [];
      if (!items.length) return notify('当前没有已同步的 PR 反馈。', true);
      const at = items.findIndex((item) => item.id === state.center.feedbackId);
      return showFeedback(items[(at + 1) % items.length].id);
    }
    const findings = problemGroups(state).open;
    if (!findings.length) return notify(state.hasResults ? '本次没有待处理问题，已处理记录可单独查看。' : '请先开始审查。', !state.hasResults);
    const index = findings.findIndex((finding) => finding.id === state.selectedFinding);
    selectFinding(state, findings[(index + 1) % findings.length].id);
    render(false);
    locateCurrentCode();
  }

  function openModal(title, body, footer = '<button class="button" data-action="close">关闭</button>') {
    pendingApproval = null;
    pendingFix = null;
    modalRenderer = null;
    modal.classList.remove('workspace-dialog');
    if (modal.open) modal.close();
    const headerClose = footer.includes('data-action="close"') ? '' : `<button class="icon-button" data-action="close" aria-label="关闭对话框">${icon('close')}</button>`;
    modal.innerHTML = `<div class="modal-header"><h2 id="center-modal-title">${title}</h2>${headerClose}</div>${body}<div class="modal-footer">${footer}</div>`;
    modal.classList.toggle('markdown-dialog', !!modal.querySelector('[data-markdown-editor],[data-markdown-reader]'));
    modal.showModal();
  }

  function openWorkspaceDialog(title, renderer) {
    openModal(title, `<div class="modal-body" id="workspace-dialog-body">${renderer()}</div>`);
    modalRenderer = renderer;
    modal.classList.add('workspace-dialog');
  }

  function openRequirements() {
    openWorkspaceDialog('需求与参考材料', renderPrepare);
  }

  function openOpinion() {
    openWorkspaceDialog('审查意见', () => `<div class="opinion-layout"><div id="opinion-controls">${renderConclusionInspector()}</div>${renderConclusion()}</div>`);
  }

  function help() {
    openModal('原型说明', `<div class="modal-body"><p>先选择一个或多个 Repo，从左侧选定一个，再选择分支或 PR，即可直接阅读代码，无需先创建审查任务。</p><p>PR 只列 Changes，分支列出全部文件并相对默认分支标注状态。两种方式都保留整仓审查上下文，变更清单不限制审查范围。</p><p>需求是可选标准。没有需求时整仓查 Bug，并明确保留“需求一致性未评审”的边界。使用顶部唯一的按钮开始或重新审查。</p><p>点击问题定位代码；问题详情、证据与修复按需打开。应用补丁不等于验证成功，修改代码或审查对象后旧结果不能继续使用。</p><p>切换 Repo 保留各自的需求、代码位置和进度。默认只保留在页面内存；本机保存与隐私设置位于演示工具中。</p><p class="form-hint">不连接模型、真实仓库或 GitHub，不执行真实测试；只提供虚构代码片段和预设分析。</p></div>`);
  }

  function sourceDetails(id, version) {
    const source = sources.getSource(state, id);
    const original = sources.snapshot(source, version || source.version);
    openModal(`${escape(source.name)} · 原文 v${original.version}`, `<div class="modal-body"><div class="source-detail-meta">${badge(sources.kindLabels[source.kind], 'blue')}${badge(source.selected ? sources.purposeLabels[source.purpose] : '未选入本次')}${badge(original.version === source.version ? '当前快照' : '历史快照', original.version === source.version ? 'blue' : 'amber')}</div><p class="form-hint">${escape(source.location)}</p>${markdownReader(original.text)}</div>`, `<button class="button" data-action="close">关闭</button>${source.binding !== 'repository' ? `<button class="button" data-action="remember-repository-material" data-source-id="${id}" data-version="${original.version}">保存为 Repo 常用参考</button>` : ''}${source.snapshots.length > 1 ? `<button class="button" data-action="material" data-source-id="${id}" data-version="${original.version === 1 ? source.version : 1}">查看${original.version === 1 ? '当前' : '最初'}版本</button>` : ''}`);
  }

  function traceRequirement(id) {
    const candidate = state.sourceReview.draft?.candidates.find((item) => item.id === id);
    const requirement = candidate || state.requirements.find((item) => item.id === id);
    if (!requirement) return notify('这个条目不在当前候选或基线中。', true);
    openModal(`${id} · 从哪里来的？`, `<div class="modal-body"><div class="source-detail-meta">${badge(requirement.manualRevision ? '人工修订' : requirement.originKind || '示例整理', 'blue')}${badge(candidate ? '待核对条目' : state.baselineConfirmed ? `基线 v${state.baselineVersion}` : '历史条目 · 未纳入新基线')}</div><h3 class="trace-heading">当前条目表述</h3><blockquote class="quote markdown-body">${markdown.render(requirement.text)}</blockquote><p class="form-hint">人工修订不替换原文；来源引用不证明需求假设正确。</p>${requirementOrigins(requirement)}</div>`);
  }

  function editSourceSnapshot(id) {
    const source = sources.getSource(state, id);
    openModal('更新来源快照 · 不修改真实文件', `<form id="source-snapshot-form"><div class="modal-body"><input name="source-id" type="hidden" value="${id}"><label class="field-label" for="source-snapshot-text">${escape(source.name)} · 当前 v${source.version}</label>${markdownEditor('source-snapshot-text', source.text, 12)}<p class="form-hint">保存后自动更新待核对列表，旧引用与原文仍保留。原型不分析自定义文本；未能提取的部分会明确提示，可通过人工输入提供需求。</p></div></form>`, '<button class="button" data-action="close">取消</button><button class="button primary" form="source-snapshot-form" type="submit">保存新快照并使旧结果失效</button>');
  }

  function editRequirement(id, preset = false) {
    try {
      beginRequirementEdit(state, id, preset);
    } catch (error) {
      return notify(error.message, true);
    }
    render();
    openRequirements();
    document.getElementById('center-requirement-title').focus();
  }

  function materialInput(explicit = false, example = false) {
    const material = example ? sources.exampleMaterial(state) : null;
    openModal(explicit ? '补充一条明确要求' : '粘贴需求或业务背景', `<form id="center-source-form"><div class="modal-body">
      <input name="material-kind" type="hidden" value="${explicit ? 'requirement' : 'auto'}">
      <label class="field-label" for="center-source-name">${explicit ? '要求标题' : '材料名称（可选）'}</label><input class="text-field" id="center-source-name" ${explicit ? 'required' : ''} value="${escape(material?.name || '')}" placeholder="${explicit ? '例如：退款不得超过实收金额' : '例如：本次业务背景'}">
      <label class="field-label" for="center-source-text">${explicit ? '你希望实现满足什么条件？' : '原文或补充说明'}</label>${markdownEditor('center-source-text', material?.text || '')}
      <p class="form-hint">${explicit ? '作为人工明确要求加入理解，仍需核对后开始。' : '自由文本只保留原文，尚待模型分析；也可直接补充明确要求。'}${workspace.remember ? '已开启本机保存，此原文会保存在当前浏览器，不上传。' : '默认仅留在页面内存，不上传；明确开启本机保存后才持久化。'}</p>
      </div></form>`, '<button class="button" data-action="close">取消</button><button class="button primary" form="center-source-form" type="submit">保存</button>');
  }

  function linkInput(example = false) {
    openModal('读取需求链接', `<form id="requirement-link-form"><div class="modal-body"><label class="field-label" for="requirement-link">需求页面链接</label><input class="text-field" id="requirement-link" type="url" required value="${example ? escape(sources.exampleLink) : ''}" placeholder="https://…"><p class="form-hint">离线原型仅支持演示工具中的示例链接；其他链接请粘贴原文。</p><p id="requirement-link-error" class="input-error" role="alert" hidden></p></div></form>`, '<button class="button" data-action="close">取消</button><button class="button primary" form="requirement-link-form" type="submit">读取并加入</button>');
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
      notify(`本地原文已读取，不上传；${workspace.remember ? '按你的设置保存到当前浏览器' : '默认只留在页面内存'}。自定义内容标为待模型分析。`);
    } catch (error) {
      notify(`读取本地文件失败：${error.message}。未将该文件纳入审查。`, true);
    } finally {
      originalState.sourceReview.readingFile = false;
      if (state === originalState) render();
      else persistWorkspace();
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

  function fixContextKey(id) {
    return JSON.stringify([id, fixValidationKey(state)]);
  }

  function fixPreview(id) {
    const finding = state.findings.find((item) => item.id === id);
    if (!finding || finding.type !== 'implementation') return notify('需求矛盾或必要前提应先澄清，不能直接生成修复。', true);
    if (!state.center.patches[id] && (state.stale || finding.resolved)) return notify('当前判断已过期或已处理，请先完成有效复审。', true);
    const location = findingLocation(state, id);
    const before = id === 'F-01' ? 'order.markPaymentFailed();\nreturn { canPayAgain: true };' : 'await order.restore();\nconst reservation = await inventory.findByOrder(order.id);\nreturn { reservationId: reservation.id };';
    const after = id === 'F-01' ? 'order.markPaymentUnknown();\nreturn { canPayAgain: false, status: "unknown" };' : 'const reservation = await inventory.reserveForOrder(order);\nawait order.restore();\nreturn { reservationId: reservation.id };';
    const scope = scopeState(state);
    openModal('修复方案 · 预览后再应用', `<div class="modal-body"><section class="fix-target"><strong>修改目标 · 浏览器内的隔离副本</strong><p>${escape(scope.repository.name)} / ${escape(state.reviewContext.taskId || '独立演示')}</p><p>${escape(scope.head.name)} · ${escape(scope.head.version)} · 演示快照 ${state.scopeReview.selection.snapshot}</p><p class="form-hint">真实实现须先准备对应 checkout / worktree，不能覆盖当前其他分支。本原型不检出、不写文件、不提交或推送。</p></section><p><strong>${escape(location.path)}</strong></p><p>${id === 'F-01' ? '把超时保留为未知状态，暂不开放再次支付。' : '在恢复状态前，重新建立示例库存保障。'}</p><h3>修改前</h3><pre class="fix-before">${escape(before)}</pre><h3>示例方案</h3><pre class="fix-after">${escape(after)}</pre><label class="context-choice"><input id="fix-target-confirm" type="checkbox" ${state.center.patches[id] ? 'disabled' : ''}><span>已核对 Repo、任务、分支与快照；只应用到此浏览器副本。</span></label><p class="form-hint">应用不等于验证通过。之后需明确模拟验证并重新审查，失败时问题保持未解决。</p></div>`, `<button class="button" data-action="close">返回代码</button><button id="fix-apply" class="button primary" data-action="apply-fix" data-id="${id}" disabled>${state.center.patches[id] ? '示例已应用' : '应用到浏览器副本 · 待验证'}</button>`);
    pendingFix = { id, key: fixContextKey(id) };
  }

  function validationDialog(id) {
    if (!state.center.fixSnapshots[id]) return notify('请先应用本次任务的示例补丁。', true);
    openModal('验证与复审 · 不执行真实测试', `<form id="fix-validation-form"><div class="modal-body"><input type="hidden" name="finding-id" value="${escape(id)}"><input type="hidden" name="validation-key" value="${escape(fixValidationKey(state))}"><p><strong>${escape(scopeState(state).repository.name)} / ${escape(scopeState(state).head.name)} / ${escape(id)}</strong></p><p>演示核对修复路径、失败路径及重复调用的处理；以下选择仅驱动预设状态，不执行仓库脚本、单元测试或 CI。</p><label class="field-label" for="fix-validation-result">预设验证结果</label><select id="fix-validation-result" class="text-field"><option value="passed">预设检查通过，再进行模拟复审</option><option value="failed">预设检查失败，保留问题与补丁</option></select><p class="form-hint">材料、Skill、代码或任务变化后，不能沿用这个验证结果。</p></div></form>`, '<button class="button" data-action="close">取消</button><button class="button primary" type="submit" form="fix-validation-form">记录演示结果</button>');
  }

  function manualEditDialog(key) {
    const file = sourceFiles(state)[key];
    if (file?.kind !== 'code') return notify('只能修改当前演示代码片段。', true);
    openModal('手动修改代码副本 · 非真实源码', `<form id="manual-code-form"><div class="modal-body"><input name="file-key" type="hidden" value="${escape(key)}"><input name="edit-key" type="hidden" value="${escape(fixValidationKey(state))}"><p><strong>${escape(scopeState(state).repository.name)} / ${escape(scopeState(state).head.name)}</strong></p><label class="field-label" for="manual-code-text">${escape(file.path)} · 从 L${file.start} 开始的演示片段，不是完整文件</label><textarea id="manual-code-text" class="textarea mono" required rows="16">${escape(file.lines.map((line) => line.text).join('\n'))}</textarea><p class="form-hint">仅修改本任务的浏览器副本，不覆盖真实分支。原型无法分析自定义实现，保存后移出旧预设发现并标为待分析；可撤销后重新运行示例。</p></div></form>`, '<button class="button" data-action="close">取消</button><button class="button primary" type="submit" form="manual-code-form">保存副本，标为待分析</button>');
  }

  async function startRun(fromPreparation = false) {
    if (!activeTask()) return;
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
      return notify('本次依据已变化，请在当前页核对审查设置，再用顶部按钮开始。', true);
    }
    const runState = state;
    const generation = ++runGeneration;
    runningTasks.set(runState, generation);
    runState.runStatus = 'running';
    runState.center.stageIndex = 0;
    runState.center.stage = 'review';
    runState.center.settingsOpen = false;
    invalidate(runState);
    if (modal.open) modal.close();
    modalRenderer = null;
    render(false);
    for (let index = 0; index < runStages.length; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 420));
      if (runningTasks.get(runState) !== generation) return;
      runState.center.stageIndex = index + 1;
      if (state === runState) render();
      else render();
    }
    completeReview(runState);
    runningTasks.delete(runState);
    persistWorkspace();
    render();
    if (state === runState) locateCurrentCode();
    const task = workspace.tasks.find((item) => item.state === runState);
    notify(`${task?.title || '审查任务'}：${!scopeState(runState).supportsFindings ? '当前范围没有可用的预设分析，不沿用旧发现。' : runState.sourceReview.limited ? '流程演示完成，自定义材料未做语义评审，结果受限。' : '模拟复审完成；未调用模型或执行真实测试。'}`);
  }

  function manualCopy(text, reason) {
    openModal('手动复制摘要', `<div class="modal-body"><p>${escape(reason)}</p><label class="field-label" for="center-copy">全文已选中，可按 Ctrl+C / ⌘C 复制</label><textarea id="center-copy" class="textarea" rows="15" readonly>${escape(text)}</textarea></div>`);
    const input = document.getElementById('center-copy');
    input.focus();
    input.select();
    notify(reason, true);
  }

  async function copySummary() {
    const text = summaryText(state);
    const currentState = state;
    if (!window.navigator.clipboard?.writeText) return manualCopy(text, '当前浏览器不支持直接复制，已提供手动复制。');
    try {
      await window.navigator.clipboard.writeText(text);
      notify('已复制点击时的审查摘要。');
    } catch (error) {
      if (currentState !== state || text !== summaryText(state)) return notify('摘要已变化，请重新复制。', true);
      if (error instanceof DOMException && ['NotAllowedError', 'SecurityError', 'NotSupportedError'].includes(error.name)) {
        return manualCopy(text, '浏览器未允许直接复制，已提供手动复制。');
      }
      notify(`复制失败：${error instanceof Error ? error.message : String(error)}`, true);
    }
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
    notify('已发起摘要下载；浏览器未保存时可使用“复制”。');
  }

  document.addEventListener('click', (event) => {
    const contextToggle = event.target instanceof Element ? event.target.closest('#context-bar > summary') : null;
    if (contextToggle) { state.center.contextExpanded = !contextToggle.parentElement.open; return; }
    const target = event.target instanceof Element ? event.target.closest('[data-action]') : null;
    if (!target || target.disabled) return;
    const action = target.dataset.action;
    if (action === 'open-repository') return openRepositoryDialog();
    if (action === 'workspace-storage') return storageDialog();
    if (action === 'select-repository') {
      try {
        openRepository(workspace, target.dataset.id);
      } catch (error) {
        return notify(error.message, true);
      }
      showWorkspaceSelection();
      return;
    }
    if (action === 'retry-target') {
      const failed = targetLoadErrors.get(workspace.selectedRepository);
      if (!failed) return notify('没有待重试的代码加载，请重新选择分支 / PR。', true);
      return loadTarget(failed.value);
    }
    if (action === 'clear-workspace-storage') return openModal('清除本机存档', '<div class="modal-body"><p>删除此原型在当前浏览器保存的任务和材料原文；当前页面内存中的工作区仍保留，不影响真实仓库。</p></div>', '<button class="button" data-action="close">取消</button><button class="button danger" data-action="confirm-clear-storage">确认清除本机存档</button>');
    if (action === 'confirm-clear-storage') {
      workspace.remember = false;
      try {
        localStorage.removeItem(storageKey);
        storageError = '';
      } catch (error) {
        storageError = `清除本机存档失败：${error.message}。已停止继续保存，但旧存档可能仍存在。`;
        render();
        return notify(storageError, true);
      }
      modal.close();
      render();
      return notify('本机存档已清除，当前页面任务仍在内存。');
    }
    if (handleFeedbackAction(action, target)) return;
    if (target.closest('#demo-tools')) document.getElementById('demo-tools').open = false;
    if (action === 'markdown-edit-mode') {
      if (target.closest('#center-requirement-form') && state.center.requirementEdit) state.center.requirementEdit.preview = target.dataset.mode === 'preview';
      return setMarkdownEditorMode(target.closest('[data-markdown-editor]'), target.dataset.mode);
    }
    if (action === 'markdown-read-mode') return setMarkdownReaderMode(target.closest('[data-markdown-reader]'), target.dataset.mode);
    if (action === 'close') { pendingApproval = null; return modal.close(); }
    if (action === 'help') return help();
    if (action === 'theme') { document.documentElement.dataset.theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; return render(); }
    if (!activeTask()) return notify('请先选择 Repo 和分支 / PR。', true);
    if (action === 'stage') return stage(target.dataset.stage);
    if (action === 'requirements') return openRequirements();
    if (action === 'opinion') return openOpinion();
    if (action === 'finding-details') return openWorkspaceDialog('问题详情', renderFindingInspector);
    if (action === 'reset') {
      resetDemoScenario(state.scenario);
      return notify('仅重置当前 Repo 的演示，其他 Repo 保持不变。');
    }
    if (action === 'finding' || action === 'locate-finding') { if (modal.open) modal.close(); selectFinding(state, target.dataset.id); render(false); return locateCurrentCode(); }
    if (action === 'source') { if (modal.open) modal.close(); return openSource(target.dataset.source); }
    if (action === 'navigator') { state.center.navigator = target.dataset.tab; state.center.search = ''; return render(); }
    if (action === 'inspector-tab') { state.center.inspector = target.dataset.tab; render(); return; }
    if (action === 'code-view') { state.center.codeView = target.dataset.view; return render(); }
    if (action === 'focus-finding') {
      state.center.inspector = 'judgment';
      selectFinding(state, state.selectedFinding);
      render();
      return locateCurrentCode();
    }
    if (action === 'focus') { state.center.focus = !state.center.focus; return render(); }
    if (action === 'next') return nextFinding();
    if (action === 'download') return download();
    if (action === 'copy-summary') return void copySummary();
    if (action === 'run') return void startRun();
    if (action === 'prepare-start') return void startRun(true);
    if (action === 'cancel') { runningTasks.delete(state); state.runStatus = 'cancelled'; invalidate(state); render(); return notify('已取消当前 Repo 的模拟流程，不影响其他 Repo。'); }
    if (action === 'trace-requirement') return traceRequirement(target.dataset.id);
    if (action === 'material') return sourceDetails(target.dataset.sourceId, Number(target.dataset.version) || undefined);
    if (action === 'materials') return materialsDialog();
    if (action === 'settings') return stage('prepare');
    if (state.runStatus === 'running') return notify('请先结束或取消模拟审查，再修改依据或处置。', true);
    if (action === 'simulate-code-change') {
      changeScope(state, { snapshot: state.scopeReview.selection.snapshot + 1 });
      render();
      return notify('已切换到新的演示代码快照，旧发现、补丁和确认失效；没有分析新代码。');
    }
    if (action === 'demo-update-source') return editSourceSnapshot(document.getElementById('demo-source').value);
    if (action === 'demo-requirement') return editRequirement('RQ-02', true);
    if (action === 'demo-paste') return materialInput(false, true);
    if (action === 'demo-link') return linkInput(true);
    if (action === 'edit-requirement') return editRequirement(target.dataset.id);
    if (action === 'cancel-requirement-edit') { state.center.requirementEdit = null; return render(); }
    if (action === 'exclude-requirement') return excludeRequirement(target.dataset.id);
    if (action === 'include-requirement') {
      changeRequirementInclusion(state, target.dataset.id, true);
      render();
      return;
    }
    if (action === 'remove-material') { chooseMaterial(state, target.dataset.sourceId, false); return render(); }
    if (action === 'add-material') return addMaterialDialog();
    if (action === 'paste-material') return materialInput();
    if (action === 'link-material') return linkInput();
    if (action === 'file-material') { if (modal.open) modal.close(); return document.getElementById('requirement-file').click(); }
    if (action === 'use-example-materials') {
      chooseMaterial(state, 'payments', true);
      chooseMaterial(state, 'orders', true);
      if (modal.open) modal.close();
      render();
      return notify('已载入两份预设需求并整理演示理解；其他材料保持不变，没有调用 AI。');
    }
    if (action === 'add-explicit-requirement') return materialInput(true);
    if (action === 'comment' || action === 'boundary') return noteModal(action, target.dataset.id);
    if (action === 'remember-repository-material') {
      try {
        rememberRepositoryMaterial(workspace, activeTask().id, target.dataset.sourceId, Number(target.dataset.version));
      } catch (error) {
        return notify(error.message, true);
      }
      modal.close();
      render();
      return notify('已保存为此 Repo 的常用参考，只影响之后创建的任务；已有任务的原文快照不变。');
    }
    if (action === 'manual-edit') return manualEditDialog(target.dataset.source);
    if (action === 'undo-manual') {
      try { undoManualEdit(state, target.dataset.source); } catch (error) { return notify(error.message, true); }
      render();
      return notify('已撤销手动修改，恢复示例源码；仍需重新审查。');
    }
    if (action === 'validate-fix') return validationDialog(target.dataset.id);
    if (action === 'fix-preview') return fixPreview(target.dataset.id);
    if (action === 'apply-fix') {
      if (!pendingFix || pendingFix.id !== target.dataset.id || pendingFix.key !== fixContextKey(target.dataset.id)) return notify('修复方案对应的快照已变化，请重新预览。', true);
      if (!document.getElementById('fix-target-confirm')?.checked) return notify('请先核对并确认修改目标。', true);
      applySampleFix(state, target.dataset.id); pendingFix = null; modal.close(); render(); locateCurrentCode();
      return notify('仅应用到浏览器示例，原判断过期、等待复审；未运行测试。');
    }
    if (action === 'undo-fix') { undoSampleFix(state, target.dataset.id); render(); return notify('示例补丁已撤销，原问题与通过限制已恢复。'); }
    if (action === 'evidence') return openModal('补充关键契约 · 预设证据分支', `<form id="center-evidence-form"><div class="modal-body"><p>本分支演示稳定事件键与唯一约束得到补充。它不是对任意输入执行的实际契约验证。</p><label class="field-label" for="center-evidence">来源与适用范围</label><textarea id="center-evidence" class="textarea" required rows="5">示例契约 v2 第 4 条：同一支付事件重投保持 event.id 稳定；示例账本对该键具备唯一约束。仅适用于当前演示。</textarea><p class="form-hint">补充后仍要重审，关键前提不会在点击保存时立即解除。</p></div></form>`, '<button class="button" data-action="close">取消</button><button class="button primary" form="center-evidence-form" type="submit">补充示例证据，等待重审</button>');
    if (action === 'submit') {
      const decision = conclusionState(state);
      if (!decision.allowed) return notify(decision.blockers.join('；'), true);
      if (state.verdict === 'approve') {
        const request = requestApproval(state);
        const scope = scopeState(state);
        openModal('确认通过当前范围', `<div class="modal-body"><p><strong>${escape(scope.repository.name)} · ${escape(scope.label)}</strong></p><p>代码 ${escape(scope.head.version)} · 演示快照 ${state.scopeReview.selection.snapshot}。${state.mode === 'technical' ? '仅通过技术范围，需求一致性未评审。' : `需求基线 v${state.baselineVersion}。`}</p><p>确认后仅在当前离线原型记录，不会写入 GitHub。</p></div>`, '<button class="button" data-action="close">返回检查</button><button class="button primary" data-action="confirm-submit">确认通过</button>');
        pendingApproval = request;
        return;
      }
      submitVerdict(state, state.verdict);
      render();
      return notify(`已在当前原型记录“${verdictLabels[state.verdict]}”，未写回 GitHub。`);
    }
    if (action === 'confirm-submit') {
      const request = pendingApproval;
      pendingApproval = null;
      try {
        confirmApproval(state, request);
      } catch (error) {
        modal.close();
        render();
        return notify(error.message, true);
      }
      modal.close();
      render();
      return notify('已在当前原型记录“通过”，未写回 GitHub。');
    }
  });

  document.addEventListener('submit', (event) => {
    if (!(event.target instanceof HTMLFormElement)) return;
    event.preventDefault();
    const form = event.target;
    if (!form.reportValidity()) return;
    if (form.id === 'repository-selection-form') {
      try {
        addRepositories(workspace, new FormData(form).getAll('repository'));
      } catch (error) {
        const message = document.getElementById('repository-selection-error');
        message.textContent = error.message;
        message.hidden = false;
        return;
      }
      showWorkspaceSelection();
      return;
    }
    if (form.id === 'workspace-storage-form') {
      if (document.getElementById('remember-workspace').checked) {
        workspace.remember = true;
        if (!persistWorkspace()) { render(); return; }
      } else {
        workspace.remember = false;
        try {
          localStorage.removeItem(storageKey);
          storageError = '';
        } catch (error) {
          storageError = `关闭保存后未能删除旧存档：${error.message}。旧原文可能仍在浏览器中。`;
          render();
          return notify(storageError, true);
        }
      }
      modal.close();
      render();
      return notify(workspace.remember ? '已明确启用本机保存，包含任务与材料原文；不上传。' : '已关闭本机保存并删除存档，当前任务只留在页面内存。');
    }
    if (state.runStatus === 'running') return notify('请先结束或取消模拟审查。', true);
    if (form.id.startsWith('feedback-')) { submitFeedbackForm(form); return; }
    if (form.id === 'manual-code-form') {
      try {
        saveManualEdit(state, form.elements.namedItem('file-key').value, document.getElementById('manual-code-text').value, form.elements.namedItem('edit-key').value);
      } catch (error) {
        return notify(error.message, true);
      }
      notify('代码副本已保存，旧发现和验证不可沿用；自定义实现未做模型分析。');
    } else if (form.id === 'fix-validation-form') {
      try {
        if (form.elements.namedItem('validation-key').value !== fixValidationKey(state)) throw new Error('验证对应的任务或依据已变化，请重新打开验证');
        const passed = document.getElementById('fix-validation-result').value === 'passed';
        recordFixValidation(state, form.elements.namedItem('finding-id').value, passed);
        modal.close();
        render();
        if (passed) return void startRun(true);
        return notify('预设验证失败：补丁保留、问题未解决，没有执行真实测试。', true);
      } catch (error) {
        return notify(error.message, true);
      }
    } else if (form.id === 'center-requirement-form') {
      if (!state.center.requirementEdit) return notify('没有待保存的需求修订。', true);
      state.center.requirementEdit.title = document.getElementById('center-requirement-title').value;
      state.center.requirementEdit.text = document.getElementById('center-requirement-text').value;
      try {
        saveRequirementEdit(state);
      } catch (error) {
        return notify(error.message, true);
      }
      notify('修订已保存，原文保留。请重新确认理解并开始审查。');
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
    if (modal.open) modal.close();
    render();
    if (['center-requirement-form', 'center-source-form', 'requirement-link-form', 'exclude-requirement-form', 'source-snapshot-form'].includes(form.id)) openRequirements();
  });

  document.addEventListener('input', (event) => {
    if (event.target.matches('[data-markdown-input]') && event.target.hidden) {
      setMarkdownEditorMode(event.target.closest('[data-markdown-editor]'), 'preview');
    }
    if (event.target.id === 'center-search') { state.center.search = event.target.value; render(); }
    if (state.center.requirementEdit) {
      if (event.target.id === 'center-requirement-title') state.center.requirementEdit.title = event.target.value;
      if (event.target.id === 'center-requirement-text') state.center.requirementEdit.text = event.target.value;
    }
    if (event.target.id === 'center-notes') {
      const hadSubmission = !!state.submission;
      const changed = updateNotes(state, event.target.value);
      const preview = document.getElementById('center-summary');
      if (preview) preview.textContent = summaryText(state);
      if (changed) {
        modal.querySelector('.submission-record')?.remove();
        renderTop();
        document.getElementById('opinion-controls').innerHTML = renderConclusionInspector();
        if (hadSubmission) notify('待提交内容已变化，请重新提交结论。');
      }
    }
  });

  document.addEventListener('invalid', (event) => {
    if (event.target.matches('[data-markdown-input]') && event.target.hidden) {
      setMarkdownEditorMode(event.target.closest('[data-markdown-editor]'), 'edit');
    }
  }, true);

  document.addEventListener('change', (event) => {
    if (event.target.id === 'fix-target-confirm') {
      const button = document.getElementById('fix-apply');
      if (button) button.disabled = !event.target.checked;
      return;
    }
    if (event.target.id === 'feedback-filter') { state.center.feedbackFilter = event.target.value; render(); return; }
    if (event.target.id === 'demo-scenario') {
      const scenario = event.target.value;
      document.getElementById('demo-tools').open = false;
      resetDemoScenario(scenario);
      return notify('已切换当前 Repo 的演示场景；没有调用模型，不影响其他 Repo。');
    }
    if (event.target.id === 'requirement-file') return void readLocalFile(event.target.files[0]);
    if (event.target.id === 'scope-target') return loadTarget(event.target.value);
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
      state.verdict = event.target.value;
      render();
    }
  });

  document.addEventListener('toggle', (event) => {
    if (!(event.target instanceof HTMLDetailsElement) || !event.target.isConnected) return;
    const fields = { 'context-bar': 'contextExpanded', 'review-settings': 'settingsOpen', 'review-opinion': 'opinionOpen', 'review-source': 'sourceOpen',
      'closed-problems': 'closedOpen', 'problem-basis': 'basisOpen', 'problem-evidence': 'evidenceOpen', 'problem-history': 'historyOpen' };
    const field = fields[event.target.id];
    if (field) state.center[field] = event.target.open;
  }, true);

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && modal.open) { event.preventDefault(); pendingApproval = null; modal.close(); }
    else if (event.key === 'Escape') document.getElementById('demo-tools').open = false;
    if (event.key === 'F8' && !modal.open && state.hasResults) { event.preventDefault(); nextFinding(); }
  });
  window.addEventListener('error', (event) => notify(`原型脚本错误：${event.message}`, true));
  window.addEventListener('unhandledrejection', (event) => notify(`原型操作失败：${String(event.reason)}`, true));
  window.addEventListener('pagehide', () => { rememberReadingPosition(); persistWorkspace(); });
  try {
    const saved = localStorage.getItem(storageKey);
    if (saved) {
      workspace = parseWorkspace(saved);
      state = currentReviewTask(workspace)?.state || createCenterState('fresh');
    }
  } catch (error) {
    storageError = `无法恢复本机工作区：${error.message}。原存档未删除，当前使用页面内存。`;
    notify(storageError, true);
  }
  render(false);
  restoreReadingPosition();
}());
