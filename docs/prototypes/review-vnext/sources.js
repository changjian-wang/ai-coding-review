(function () {
  'use strict';

  const clone = (value) => JSON.parse(JSON.stringify(value));
  const kindLabels = { local: '本地需求文档', pr: 'PR Description', issue: '关联需求 Issue', design: '设计与决策记录', manual: '人工输入', link: '需求链接 · 演示快照', review: 'Reviewer 建议 · 人工纳入' };
  const purposeLabels = { auto: '按内容识别要求与背景', requirement: '人工明确的要求', context: '事实与背景材料' };
  const exampleLink = 'https://requirements.example/checkout/review';

  function textAtLines(entries) {
    const lines = new Array(Math.max(...entries.map(([line]) => line))).fill('');
    entries.forEach(([line, text]) => { lines[line - 1] = text; });
    return lines.join('\n');
  }

  function getSource(state, id) {
    const source = state.sources.find((item) => item.id === id);
    if (!source) throw new Error('找不到这份需求来源');
    return source;
  }

  function snapshot(source, version = source.version) {
    const result = source.snapshots.find((item) => item.version === version);
    if (!result) throw new Error('找不到引用的原文版本，不能用当前文本替代');
    return result;
  }

  function originFor(source, line, quote) {
    const endLine = line + quote.split('\n').length - 1;
    const actual = snapshot(source).text.split('\n').slice(line - 1, endLine).join('\n');
    if (actual !== quote) throw new Error('引用片段与原文位置不一致');
    return { sourceId: source.id, version: source.version, line, endLine, quote };
  }

  function labelOrigin(state, origin) {
    const source = getSource(state, origin.sourceId);
    return `${source.location}:L${origin.line}${origin.endLine === origin.line ? '' : `–${origin.endLine}`} · v${origin.version}`;
  }

  function originStatus(state, origin) {
    const source = getSource(state, origin.sourceId);
    if (!source.selected) return '来源已移出';
    if (source.purpose === 'context') return '事实与背景材料';
    if (source.version !== origin.version) return '原文已更新';
    const text = snapshot(source, origin.version).text.split('\n').slice(origin.line - 1, origin.endLine).join('\n');
    return text === origin.quote ? '当前版本' : '引用不匹配';
  }

  function initialize(state, revisedText) {
    const requirements = clone(state.requirements);
    const paymentRules = requirements.filter((item) => item.id !== 'RQ-03');
    const orderRule = requirements.find((item) => item.id === 'RQ-03');
    const make = (id, kind, name, location, purpose, entries, templates, selected = false) => {
      const text = textAtLines(entries);
      return { id, kind, name, location, purpose, selected, version: 1, text, snapshots: [{ version: 1, text }], templateVersion: 1, templates };
    };
    const defaultRules = [
      ['RQ-01', '同一订单最多成功扣款一次', '支付请求重试、回调重投和人工补单均不得造成重复扣款。', 12],
      ['RQ-02', '支付超时后允许立即重新支付', '支付请求超时即标记为失败，立即向用户开放再次支付入口。', 23],
      ['RQ-04', '支付回调能够安全重复投递', '同一支付结果的重复通知不得重复推进业务状态。', 38],
    ];
    const payments = defaultRules.map(([id, title, text, line]) => ({ ...(paymentRules.find((item) => item.id === id) || { id, title, text, kind: '业务规则', check: 'unknown' }), line }));
    const orders = orderRule || { id: 'RQ-03', title: '恢复已取消订单前重新预留库存', text: '取消订单应释放占用；恢复订单必须重新校验并原子预留库存。', kind: '业务规则', check: 'unknown' };
    state.sources = [
      make('payments', 'local', 'payments.md', 'requirements/payments.md', 'auto', [[1, '# 支付结果与再次支付规则'], ...payments.map((item) => [item.line, item.text])], payments, state.mode !== 'technical'),
      make('orders', 'local', 'orders.md', 'requirements/orders.md', 'auto', [[1, '# 订单取消与恢复'], [24, '取消订单后，应释放其占用的库存资源。'], [31, orders.text]], [{ ...orders, line: 31 }], state.mode !== 'technical'),
      make('pr-description', 'pr', '演示 PR 104 · 描述与验收说明', '演示 PR 104 Description / 独立材料快照', 'auto', [
        [1, '# 本次改动说明'],
        [3, '根据实现整理：支付超时后标记失败，并开放再次支付入口。'],
        [5, '# 验收说明'],
        [6, orders.text],
        [8, '本文混有改动总结与验收说明；不能把代码总结直接当作原始需求。'],
      ], [{ ...orders, line: 6 }]),
      make('linked-issue', 'issue', '支付状态语义 · PAY-014', '示例需求卡 PAY-014 / 验收条件', 'auto', [
        [1, '# 支付状态语义'],
        [4, '支付超时只代表结果未知；最终结果确认前不得开放新的扣款。'],
        [7, '这与旧支付文档的“超时即失败”存在矛盾，需人工确认取舍及适用版本。'],
      ], [{ id: 'RQ-05', title: '支付超时不等于支付失败', text: '支付超时只代表结果未知；最终结果确认前不得开放新的扣款。', kind: '验收条件', check: 'unknown', line: 4 }]),
      make('design', 'design', '展示缓存的适用边界', 'decisions/status-cache.md', 'auto', [
        [9, '展示页面允许最长 30 秒延迟，以控制支付通道查询负载。'],
        [14, '展示缓存不得用于扣款资格或其他不可逆业务判断。'],
      ], []),
    ];
    state.sourceReview = {
      revision: 0, organizedRevision: state.baselineConfirmed ? 0 : -1, acceptedRevision: state.baselineConfirmed ? 0 : -1,
      draft: null, acknowledged: false, conflicts: [], excluded: [], edits: {}, nextManual: 1, limited: false,
      knownTexts: Object.fromEntries([...payments, orders].map((item) => [item.id, item.id === 'RQ-02' && revisedText ? [item.text, revisedText] : [item.text]])),
    };
    for (const requirement of state.requirements) {
      const source = getSource(state, requirement.id === 'RQ-03' ? 'orders' : 'payments');
      const template = source.templates.find((item) => item.id === requirement.id);
      requirement.origins = [originFor(source, template.line, template.text)];
      requirement.source = labelOrigin(state, requirement.origins[0]);
      requirement.originKind = '示例整理';
      requirement.basis = 'explicit';
    }
    if (!state.baselineConfirmed && state.mode === 'requirements') organize(state);
  }

  function invalidate(state, reason) {
    state.sourceReview.revision += 1;
    state.sourceReview.organizedRevision = -1;
    state.sourceReview.draft = null;
    state.sourceReview.acknowledged = false;
    state.baselineConfirmed = false;
    state.baselineDirty = true;
    state.stale = state.hasResults;
    state.humanConfirmed = false;
    state.submission = null;
    state.history.push(`${reason}；本次理解已自动更新，旧结论失效；有明确要求时需重新确认后开始。`);
    organize(state);
  }

  function selectSource(state, id, selected) {
    const source = getSource(state, id);
    if (source.selected === selected) return;
    source.selected = selected;
    invalidate(state, `${source.name} ${selected ? '加入' : '移出'}本次来源`);
  }

  function setPurpose(state, id, purpose) {
    if (!Object.hasOwn(purposeLabels, purpose)) throw new Error('未知的材料用途');
    const source = getSource(state, id);
    if (source.purpose === purpose) return;
    source.purpose = purpose;
    if (source.kind === 'manual' && purpose === 'requirement') {
      source.templates = [{ id: `RQ-M${source.id.slice('manual-'.length)}`, title: source.name, text: source.text, kind: '人工候选', check: 'unknown', line: 1 }];
      source.templateVersion = source.version;
    }
    invalidate(state, `${source.name} 用途改为${purposeLabels[purpose]}`);
  }

  function updateSource(state, id, text) {
    const source = getSource(state, id);
    if (!text.trim()) throw new Error('原文不能为空');
    if (text === source.text) return;
    source.version += 1;
    source.text = text;
    source.snapshots.push({ version: source.version, text });
    if (source.kind === 'manual' && source.purpose === 'requirement') {
      source.templates[0].text = text;
      source.templateVersion = source.version;
    }
    if (source.selected || state.requirements.some((item) => item.origins?.some((origin) => origin.sourceId === id))) invalidate(state, `${source.name} 原文更新至 v${source.version}`);
    else state.history.push(`${source.name} 的未纳入快照更新至 v${source.version}，不影响本次基线。`);
  }

  function exampleMaterial(state) {
    const lines = ['# 本次需求（演示）'];
    const templates = [];
    for (const sourceId of ['payments', 'orders']) {
      for (const template of getSource(state, sourceId).templates) {
        lines.push('', `## ${template.title}`, template.text);
        templates.push({ ...clone(template), line: lines.length });
      }
    }
    return { name: '支付与订单恢复需求（演示）', text: lines.join('\n'), templates };
  }

  function needsAnalysis(source) {
    return source.version !== source.templateVersion || (!!source.userProvided && !source.demoRecognized);
  }

  function addInputSource(state, name, text, purpose, kind, location) {
    if (typeof name !== 'string' || typeof text !== 'string' || !name.trim() || !text.trim()) throw new Error('材料名称与原文不能为空');
    if (text.includes('\0')) throw new Error('文件含有二进制内容，请使用 UTF-8 Markdown 或纯文本');
    if (!Object.hasOwn(purposeLabels, purpose)) throw new Error('请选择材料用途');
    const sequence = state.sourceReview.nextManual++;
    const id = `manual-${sequence}`;
    const example = exampleMaterial(state);
    const demoRecognized = purpose === 'auto' && text === example.text;
    const source = {
      id, kind, name: name.trim(), location, purpose, selected: true, userProvided: true, demoRecognized,
      version: 1, text, snapshots: [{ version: 1, text }], templateVersion: 1,
      templates: purpose === 'requirement'
        ? [{ id: `RQ-M${sequence}`, title: name.trim(), text, kind: '人工明确要求', check: 'unknown', line: 1 }]
        : demoRecognized ? example.templates : [],
    };
    state.sources.push(source);
    invalidate(state, `读取并加入材料 ${source.name}`);
    return id;
  }

  function addManualSource(state, name, text, purpose) {
    return addInputSource(state, name, text, purpose, 'manual', `人工输入 / ${typeof name === 'string' ? name.trim() : ''}`);
  }

  function addReviewSource(state, name, text, origin) {
    if (!origin || ['repository', 'prId', 'threadId', 'commentId', 'author'].some((key) => typeof origin[key] !== 'string' || !origin[key].trim())) throw new Error('Reviewer 建议缺少可追溯的 PR、会话或评论出处');
    const location = `${origin.repository} / 演示 PR ${origin.prId} / ${origin.threadId} / ${origin.commentId}`;
    const id = addInputSource(state, name, text, 'requirement', 'review', location);
    getSource(state, id).feedbackOrigin = clone(origin);
    return id;
  }

  function validateFileName(name) {
    if (typeof name !== 'string' || !/\.(md|markdown|txt)$/i.test(name)) throw new Error('原型仅支持 UTF-8 的 .md、.markdown 或 .txt 文件；PDF、Word 等格式尚未接入');
  }

  function addFileSource(state, name, text) {
    validateFileName(name);
    return addInputSource(state, name, text, 'auto', 'local', `本地读取 / ${name}`);
  }

  function addLinkSource(state, address) {
    let url;
    try { url = new URL(address); } catch { throw new Error('请输入完整的 HTTP 或 HTTPS 需求链接'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('只支持不含账号密码的 HTTP 或 HTTPS 需求链接');
    if (url.href !== exampleLink) throw new Error('原型未联网，无法读取这个链接。请粘贴原文，或使用界面提供的演示链接；不会将未读取的内容当作需求');
    const example = exampleMaterial(state);
    return addInputSource(state, example.name, example.text, 'auto', 'link', exampleLink);
  }

  function draftConflicts(requirements) {
    const left = requirements.find((item) => item.id === 'RQ-02');
    const right = requirements.find((item) => item.id === 'RQ-05');
    if (!left || !right || left.text !== '支付请求超时即标记为失败，立即向用户开放再次支付入口。') return [];
    return [{
      id: 'SC-01', title: '原始材料对支付超时语义存在冲突', critical: true, resolved: false,
      left: left.id, right: right.id,
      detail: '本地文档要求超时即失败并允许再次支付，关联需求卡要求保留未知。两份原文都被保留，不自动按来源类型、更新时间或多数意见裁决。',
    }];
  }

  function organize(state) {
    const candidates = [];
    const notices = [];
    for (const source of state.sources.filter((item) => item.selected && item.purpose !== 'context')) {
      if (source.version !== source.templateVersion) {
        notices.push(`${source.name} 原文已编辑：没有调用模型，不能沿用旧提取；请通过人工输入明确候选。`);
        continue;
      }
      if (source.userProvided && source.purpose === 'auto' && !source.templates.length) {
        notices.push(`${source.name} 已读取并保留原文，但未从自由文本提取要求：原型未连接模型。不能把“尚未分析”当作“没有需求”；可在详情中补充明确要求。`);
      }
      for (const template of source.templates) {
        const previous = state.sourceReview.edits[template.id] || state.requirements.find((item) => item.id === template.id && item.manualRevision);
        const candidate = previous
          ? { id: template.id, kind: template.kind, originKind: source.kind === 'manual' ? '人工输入' : '示例整理', ...clone(previous), check: 'unknown', origins: [], include: true, exclusionReason: '' }
          : { id: template.id, title: template.title, text: template.text, kind: template.kind, check: 'unknown', origins: [], originKind: source.kind === 'manual' ? '人工输入' : '示例整理', include: true, exclusionReason: '' };
        candidate.basis = candidate.manualRevision || source.purpose === 'requirement' && ['manual', 'review'].includes(source.kind) ? 'human' : 'explicit';
        if (source.kind === 'review') candidate.originKind = 'Reviewer 建议 · 人工纳入，待确认';
        if (source.demoRecognized) candidate.originKind = '预设映射 · 非真实 AI 分析';
        const origin = originFor(source, template.line, template.text);
        const same = candidates.find((item) => item.text === candidate.text);
        if (same) same.origins.push(origin);
        else {
          candidate.origins = [origin];
          candidates.push(candidate);
        }
      }
    }
    if (state.sourceReview.acceptedRevision === state.sourceReview.revision) {
      for (const candidate of candidates) {
        const excluded = state.sourceReview.excluded.find((item) => item.id === candidate.id);
        if (excluded) {
          candidate.include = false;
          candidate.exclusionReason = excluded.reason;
        }
      }
    }
    const present = new Set(candidates.map((item) => item.id));
    state.sourceReview.draft = {
      revision: state.sourceReview.revision, candidates, notices,
      removed: state.requirements.filter((item) => !present.has(item.id)).map((item) => item.id),
    };
    state.sourceReview.organizedRevision = state.sourceReview.revision;
    state.sourceReview.acknowledged = false;
    state.baselineConfirmed = false;
    state.baselineDirty = true;
    state.stale = state.hasResults;
    state.humanConfirmed = false;
    state.submission = null;
    return state.sourceReview.draft;
  }

  function updateCandidate(state, id, include, exclusionReason = '') {
    const candidate = state.sourceReview.draft?.candidates.find((item) => item.id === id);
    if (!candidate) throw new Error('找不到当前待核对条目，请检查来源及自动更新状态');
    candidate.include = include;
    candidate.exclusionReason = exclusionReason;
    state.sourceReview.acknowledged = false;
  }

  function reviseCandidate(state, id, title, text) {
    if (!title.trim() || !text.trim()) throw new Error('要求标题和内容不能为空');
    if (!state.sourceReview.draft) organize(state);
    const candidate = state.sourceReview.draft.candidates.find((item) => item.id === id);
    if (!candidate) throw new Error('这条要求不在当前材料中，请先选入其来源，或补充明确要求');
    const edit = { title: title.trim(), text, manualRevision: true, basis: 'human' };
    state.sourceReview.edits[id] = edit;
    Object.assign(candidate, edit);
    state.sourceReview.acknowledged = false;
    state.baselineConfirmed = false;
    state.baselineDirty = true;
    state.stale = state.hasResults;
    state.humanConfirmed = false;
    state.submission = null;
    state.history.push(`${id} 已人工修订；原文未覆盖，等待确认本次理解并重新审查。`);
  }

  function confirmationState(state) {
    const flow = state.sourceReview;
    const draft = flow.draft;
    if (state.mode !== 'requirements') {
      return { canAcknowledge: false, reason: 'technical', message: '当前为有限技术审查，无需确认需求基线。' };
    }
    if (flow.organizedRevision !== flow.revision || (draft && draft.revision !== flow.revision)) {
      return { canAcknowledge: false, reason: 'not-ready', message: '待核对条目尚未就绪，请检查来源是否可读及自动更新状态。' };
    }
    const selected = draft ? draft.candidates.filter((item) => item.include) : state.requirements;
    if (!selected.length) {
      return { canAcknowledge: false, reason: 'empty', message: '没有可确认的需求。可补充明确要求，或直接开始有限技术审查并说明需求未评审。' };
    }
    const missingReasons = draft?.candidates.filter((item) => !item.include && !item.exclusionReason.trim()) || [];
    if (missingReasons.length) {
      return { canAcknowledge: false, reason: 'exclusion', message: `请先为 ${missingReasons.map((item) => item.id).join('、')} 填写排除原因，再核对确认。` };
    }
    if (selected.some((item) => !item.origins?.length || item.origins.some((origin) => originStatus(state, origin) !== '当前版本'))) {
      return { canAcknowledge: false, reason: 'origins', message: '条目引用的来源已更新、移出或用途改变，请检查当前出处；不能沿用旧引用确认。' };
    }
    return { canAcknowledge: true, reason: 'ready', message: `${selected.length} 条要求已准备好。点击“确认需求并开始审查”即明确确认本次依据，不需要额外勾选。` };
  }

  function confirm(state) {
    const flow = state.sourceReview;
    const draft = flow.draft;
    const readiness = confirmationState(state);
    if (!readiness.canAcknowledge) throw new Error(readiness.message);
    if (!draft) throw new Error('缺少当前待核对条目，请检查自动更新状态');
    if (!flow.acknowledged) throw new Error('请先核对原文、适用范围与冲突，并明确确认');
    const selected = draft.candidates.filter((item) => item.include);
    flow.previousBaseline = clone(state.requirements);
    flow.excluded = draft.candidates.filter((item) => !item.include).map((item) => ({ ...clone(item), reason: item.exclusionReason }));
    state.requirements = selected.map(({ include, exclusionReason, ...item }) => ({
      ...clone(item), source: item.origins.map((origin) => labelOrigin(state, origin)).join('；'), check: 'unknown',
    }));
    flow.conflicts = draftConflicts(state.requirements);
    const initialIds = ['RQ-01', 'RQ-02', 'RQ-03', 'RQ-04'];
    flow.limited = selected.length !== initialIds.length
      || selected.some((item) => !initialIds.includes(item.id) || item.originKind === '人工输入' || !flow.knownTexts[item.id]?.includes(item.text))
      || selectedSources(state).some(needsAnalysis);
    flow.acceptedRevision = flow.revision;
    flow.draft = null;
    state.baselineConfirmed = true;
    state.baselineDirty = false;
    state.baselineVersion += 1;
    state.humanConfirmed = false;
    state.submission = null;
    state.history.push(`人工确认来源基线 v${state.baselineVersion}，纳入 ${selected.length} 条；原文冲突与已知关键问题不会因确认而自动解决。`);
  }

  function sourceGate(state) {
    const flow = state.sourceReview;
    const reasons = [];
    if (state.mode === 'requirements' && flow.organizedRevision !== flow.revision) reasons.push('待核对条目尚未自动更新到当前来源版本');
    if (state.mode === 'requirements' && flow.acceptedRevision !== flow.revision) reasons.push('当前来源版本尚未人工确认');
    if (flow.limited) reasons.push('自定义材料或变更条目没有真实语义评审；仅演示来源与追溯，不能完整批准');
    flow.conflicts.forEach((conflict) => reasons.push(`${conflict.id} · ${conflict.title}`));
    return { reasons, conflicts: flow.conflicts };
  }

  function selectedSources(state) {
    return state.sources.filter((item) => item.selected);
  }

  const api = {
    kindLabels, purposeLabels, initialize, getSource, snapshot, labelOrigin, originStatus,
    selectSource, setPurpose, updateSource, addManualSource, addReviewSource, addFileSource, validateFileName, addLinkSource, exampleMaterial, exampleLink, needsAnalysis, organize, updateCandidate, reviseCandidate, confirm,
    draftConflicts, sourceGate, selectedSources, confirmationState,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else window.ReviewSourceModel = Object.freeze(api);
}());
