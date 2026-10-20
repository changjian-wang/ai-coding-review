(function () {
  'use strict';

  const clone = (value) => JSON.parse(JSON.stringify(value));
  const kindLabels = { local: '本地需求文档', pr: 'PR Description', issue: '关联需求 Issue', design: '设计与决策记录', manual: '人工输入' };
  const purposeLabels = { requirement: '候选需求依据', context: '仅作上下文' };

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
    if (source.purpose !== 'requirement') return '仅作上下文';
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
      make('payments', 'local', 'payments.md', 'requirements/payments.md', 'requirement', [[1, '# 支付结果与再次支付规则'], ...payments.map((item) => [item.line, item.text])], payments, state.mode !== 'technical'),
      make('orders', 'local', 'orders.md', 'requirements/orders.md', 'requirement', [[1, '# 订单取消与恢复'], [24, '取消订单后，应释放其占用的库存资源。'], [31, orders.text]], [{ ...orders, line: 31 }], state.mode !== 'technical'),
      make('pr-description', 'pr', '当前分支的示例关联 PR', 'PR Description / 示例快照', 'context', [
        [1, '# 本次改动说明'],
        [3, '根据实现整理：支付超时后标记失败，并开放再次支付入口。'],
        [5, '# 验收说明'],
        [6, orders.text],
        [8, '本文混有改动总结与验收说明；不能把代码总结直接当作原始需求。'],
      ], [{ ...orders, line: 6 }]),
      make('linked-issue', 'issue', '支付状态语义 · PAY-014', '示例需求卡 PAY-014 / 验收条件', 'requirement', [
        [1, '# 支付状态语义'],
        [4, '支付超时只代表结果未知；最终结果确认前不得开放新的扣款。'],
        [7, '这与旧支付文档的“超时即失败”存在矛盾，需人工确认取舍及适用版本。'],
      ], [{ id: 'RQ-05', title: '支付超时不等于支付失败', text: '支付超时只代表结果未知；最终结果确认前不得开放新的扣款。', kind: '验收条件', check: 'unknown', line: 4 }]),
      make('design', 'design', '展示缓存的适用边界', 'decisions/status-cache.md', 'context', [
        [9, '展示页面允许最长 30 秒延迟，以控制支付通道查询负载。'],
        [14, '展示缓存不得用于扣款资格或其他不可逆业务判断。'],
      ], []),
    ];
    state.sourceReview = {
      revision: 0, organizedRevision: state.baselineConfirmed ? 0 : -1, acceptedRevision: state.baselineConfirmed ? 0 : -1,
      draft: null, acknowledged: false, conflicts: [], excluded: [], nextManual: 1, limited: false,
      knownTexts: Object.fromEntries([...payments, orders].map((item) => [item.id, item.id === 'RQ-02' && revisedText ? [item.text, revisedText] : [item.text]])),
    };
    for (const requirement of state.requirements) {
      const source = getSource(state, requirement.id === 'RQ-03' ? 'orders' : 'payments');
      const template = source.templates.find((item) => item.id === requirement.id);
      requirement.origins = [originFor(source, template.line, template.text)];
      requirement.source = labelOrigin(state, requirement.origins[0]);
      requirement.originKind = '示例整理';
    }
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
    state.history.push(`${reason}；旧基线与结论失效，须重新整理并人工确认。`);
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

  function addManualSource(state, name, text, purpose) {
    if (!name.trim() || !text.trim()) throw new Error('材料名称与原文不能为空');
    if (!Object.hasOwn(purposeLabels, purpose)) throw new Error('请选择材料用途');
    const sequence = state.sourceReview.nextManual++;
    const id = `manual-${sequence}`;
    const source = {
      id, kind: 'manual', name: name.trim(), location: `人工输入 / ${name.trim()}`, purpose, selected: true,
      version: 1, text, snapshots: [{ version: 1, text }], templateVersion: 1,
      templates: purpose === 'requirement' ? [{ id: `RQ-M${sequence}`, title: name.trim(), text, kind: '人工候选', check: 'unknown', line: 1 }] : [],
    };
    state.sources.push(source);
    invalidate(state, `加入人工材料 ${source.name}`);
    return id;
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
    for (const source of state.sources.filter((item) => item.selected && item.purpose === 'requirement')) {
      if (source.version !== source.templateVersion) {
        notices.push(`${source.name} 原文已编辑：没有调用模型，不能沿用旧提取；请通过人工输入明确候选。`);
        continue;
      }
      for (const template of source.templates) {
        const previous = state.requirements.find((item) => item.id === template.id && item.manualRevision);
        const candidate = previous
          ? { ...clone(previous), origins: [], include: true, exclusionReason: '' }
          : { id: template.id, title: template.title, text: template.text, kind: template.kind, check: 'unknown', origins: [], originKind: source.kind === 'manual' ? '人工输入' : '示例整理', include: true, exclusionReason: '' };
        const origin = originFor(source, template.line, template.text);
        const same = candidates.find((item) => item.text === candidate.text);
        if (same) same.origins.push(origin);
        else {
          candidate.origins = [origin];
          candidates.push(candidate);
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
    if (!candidate) throw new Error('找不到当前候选条目，请重新整理来源');
    candidate.include = include;
    candidate.exclusionReason = exclusionReason;
    state.sourceReview.acknowledged = false;
  }

  function confirm(state) {
    const flow = state.sourceReview;
    const draft = flow.draft;
    if (!draft || draft.revision !== flow.revision || flow.organizedRevision !== flow.revision) throw new Error('来源已变化或尚未整理，请先整理候选');
    if (!flow.acknowledged) throw new Error('请先核对原文、适用范围与冲突，并明确确认');
    if (draft.candidates.some((item) => !item.include && !item.exclusionReason.trim())) throw new Error('不纳入的候选需要填写排除原因');
    const selected = draft.candidates.filter((item) => item.include);
    if (!selected.length) throw new Error('没有可确认的需求；请提供材料或明确选择有限技术审查');
    if (selected.some((item) => !item.origins.length || item.origins.some((origin) => originStatus(state, origin) !== '当前版本'))) throw new Error('候选引用的来源已移出、更新或用途改变，需重新整理');
    flow.previousBaseline = clone(state.requirements);
    flow.excluded = draft.candidates.filter((item) => !item.include).map((item) => ({ id: item.id, reason: item.exclusionReason, origins: clone(item.origins) }));
    state.requirements = selected.map(({ include, exclusionReason, ...item }) => ({
      ...clone(item), source: item.origins.map((origin) => labelOrigin(state, origin)).join('；'), check: 'unknown',
    }));
    flow.conflicts = draftConflicts(state.requirements);
    const initialIds = ['RQ-01', 'RQ-02', 'RQ-03', 'RQ-04'];
    flow.limited = selected.length !== initialIds.length
      || selected.some((item) => !initialIds.includes(item.id) || item.originKind === '人工输入' || !flow.knownTexts[item.id]?.includes(item.text))
      || selectedSources(state).some((source) => source.kind === 'manual' || source.version !== source.templateVersion);
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
    if (state.mode === 'requirements' && flow.organizedRevision !== flow.revision) reasons.push('来源尚未重新整理为候选条目');
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
    selectSource, setPurpose, updateSource, addManualSource, organize, updateCandidate, confirm,
    draftConflicts, sourceGate, selectedSources,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else window.ReviewSourceModel = Object.freeze(api);
}());
