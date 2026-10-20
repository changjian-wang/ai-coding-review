(function () {
  'use strict';

  const copy = (value) => JSON.parse(JSON.stringify(value));
  const requirementsSeed = [
    { id: 'RQ-01', title: '同一订单最多成功扣款一次', text: '支付请求重试、回调重投和人工补单均不得造成重复扣款。', kind: '业务规则', source: '需求示例 / payments.md:12', check: 'supported' },
    { id: 'RQ-02', title: '支付超时后允许立即重新支付', text: '支付请求超时即标记为失败，立即向用户开放再次支付入口。', kind: '验收条件', source: '需求示例 / payments.md:23', check: 'conflict' },
    { id: 'RQ-03', title: '恢复已取消订单前重新预留库存', text: '取消订单应释放占用；恢复订单必须重新校验并原子预留库存。', kind: '业务规则', source: '需求示例 / orders.md:31', check: 'violated' },
    { id: 'RQ-04', title: '支付回调能够安全重复投递', text: '同一支付结果的重复通知不得重复推进业务状态。', kind: '必要契约', source: '需求示例 / payments.md:38', check: 'unknown' },
  ];
  const findingsSeed = [
    {
      id: 'F-01', type: 'requirement', status: 'confirmed', severity: 'high', critical: true, resolved: false,
      title: '把支付超时当作失败，会允许重复支付', summary: '代码遵循了需求字面，但“超时等于失败”的前提不成立。',
      origin: '本次暴露', source: '需求 RQ-02 · payments.md:23', requirement: 'RQ-02', disposition: null,
      steps: ['支付通道已接收扣款请求，但响应在返回途中超时。', '应用将订单标为失败，并允许用户发起一笔新的支付。', '原支付随后成功，新的支付也可能成功，同一订单出现两笔扣款。'],
      impact: '违背 RQ-01 的单次扣款约束。需要先确认超时后的查询与状态收敛策略，而不是只在当前函数增加重试。',
      evidence: [
        { title: '原文明确把超时等同于失败', text: '这是已确认的需求条目，不是模型从代码反推的要求。', source: 'payments.md:23 · RQ-02' },
        { title: '通道契约允许响应超时后继续处理', text: '在这个虚构案例中，TIMEOUT 只表示未收到结果，不代表请求被撤销。', source: 'gateway-contract.md:17 · 示例契约' },
      ],
      counter: [
        { title: '是否由上游先查单再开放支付？', text: '示例调用链中没有查单步骤；不能用不存在的上游保证推翻此问题。' },
        { title: '是否只是实现偏离需求？', text: '不是。实现符合 RQ-02 字面，需要反向修订需求假设。' },
      ],
      code: { file: '示例 src/payments/submit.ts', start: 42, lines: ['if (result.reason === "TIMEOUT") {', '  order.markPaymentFailed();', '  return { canPayAgain: true };', '}'], highlight: [1, 2] },
    },
    {
      id: 'F-02', type: 'implementation', status: 'confirmed', severity: 'high', critical: false, resolved: false,
      title: '恢复订单绕过库存重新预留', summary: '取消路径释放了库存，恢复路径却直接回到待支付状态。',
      origin: '本次引入', source: 'src/orders/restore.ts:28', requirement: 'RQ-03', disposition: null,
      steps: ['订单取消后，releaseReservation() 释放了对应库存。', '库存可以被其他订单正常预留。', '恢复路径直接更新状态，没有重新校验与预留，后续履约缺少库存保障。'],
      impact: '违反已确认的恢复规则，可能导致资源重复承诺。根因涉及取消与恢复两条路径，不是两个独立的文件问题。',
      evidence: [
        { title: '取消路径确实释放资源', text: '两个单独看都合理的状态更新，组合后缺少重新预留步骤。', source: 'src/orders/cancel.ts:19 · 示例源码' },
        { title: '恢复入口没有替代保障', text: '调用方只负责权限判断，未提供库存预留。', source: 'src/api/orders.ts:61 · 示例源码' },
      ],
      counter: [
        { title: '库存是否仍由原订单占用？', text: '不是。取消路径已经释放了占用。' },
        { title: '调用方是否完成了预留？', text: '示例入口没有调用预留服务，因此不能以职责分层为由排除。' },
      ],
      code: { file: '示例 src/orders/restore.ts', start: 26, lines: ['await permissions.checkOwner(order);', 'await order.restore();', 'return { status: "awaiting_payment" };'], highlight: [1] },
    },
    {
      id: 'F-03', type: 'question', status: 'unresolved', severity: 'potential', critical: true, resolved: false,
      title: '重复回调的幂等前提尚未证实', summary: '需要确认幂等键的约束范围，才能判断重复事件是否安全。',
      origin: '必要前提', source: '外部支付通道契约', requirement: 'RQ-04', disposition: null,
      steps: ['应用可能收到相同支付结果的多次回调。', '当前可见资料没有说明幂等键是否在所有重投之间稳定。', '该前提决定严重重复处理风险能否排除；不能直接认定已发生 Bug。'],
      impact: '这是关键待核实项，不是已确认缺陷。需要有明确版本和适用范围的契约证据。',
      evidence: [{ title: '已知重复投递是正常行为', text: 'RQ-04 要求重复通知安全，但要求本身不能证明通道幂等键的真实行为。', source: 'payments.md:38 · RQ-04' }],
      counter: [{ title: '测试中同一事件的键是否足够？', text: '单一测试样例不能证明所有生产重投都保持该键，当前不足以解除前提。' }],
      code: { file: '示例 src/payments/callback.ts', start: 15, lines: ['const event = await gateway.parse(payload);', 'await ledger.applyOnce(event.id, event.result);'], highlight: [1] },
    },
    {
      id: 'F-04', type: 'reasonable', status: 'dismissed', severity: 'none', critical: false, resolved: true,
      title: 'PaymentService 没有本地重试', summary: '调度层已统一承担重试；在服务层重复重试会放大调用。',
      origin: '已推翻的局部疑点', source: 'src/payments/service.ts:34', requirement: null, disposition: null,
      steps: ['局部阅读认为服务函数缺少失败重试。', '继续追踪发现所有相关入口通过 PaymentJob 执行。', '调度层负责退避与重试，服务层保持单次执行符合职责约定。'],
      impact: '当前实现是有依据的职责划分，不进入正式缺陷，也不提供“补一层重试”的修复动作。',
      evidence: [{ title: '相关入口共享同一个调度保障', text: '在本示例的已检查范围中，不存在绕过调度层的直接入口。', source: 'src/jobs/payment-job.ts:40 · 示例源码' }],
      counter: [{ title: '是否仅有一个入口获得保护？', text: '已核对示例中的 API 与定时补偿入口；两者均经过统一调度。若新增绕过入口，此结论应失效。' }],
      code: { file: '示例 src/jobs/payment-job.ts', start: 39, lines: ['return jobs.run(() => paymentService.submit(order), {', '  retry: { backoff: "exponential", attempts: 3 },', '});'], highlight: [] },
    },
    {
      id: 'F-05', type: 'reasonable', status: 'dismissed', severity: 'none', critical: false, resolved: true,
      title: '展示页面使用了短时状态缓存', summary: '仅用于信息展示，业务已接受最多 30 秒延迟；不参与扣款决策。',
      origin: '合理业务取舍', source: 'src/queries/order-status.ts:12', requirement: null, disposition: null,
      steps: ['查询结果只用于页面展示，不直接驱动支付或库存操作。', '设计说明允许展示状态短时延迟，以保护支付通道查询额度。', '“每次必须查最新状态”不属于已确认要求，不应作为缺陷。'],
      impact: '合理取舍不等于永久免责。若未来把缓存结果用于不可逆业务决策，应重新审查。',
      evidence: [{ title: '例外具有明确的适用边界', text: '仅用于信息展示，延迟不超过 30 秒，付款操作使用独立的权威状态检查。', source: 'decisions/status-cache.md:9 · 示例决策' }],
      counter: [{ title: '缓存是否影响支付资格？', text: '当前示例没有这条依赖；不能凭变量名称推断会驱动支付。' }],
      code: { file: '示例 src/queries/order-status.ts', start: 11, lines: ['return cache.remember(order.id, { ttl: 30 }, () => {', '  return gateway.queryDisplayStatus(order.paymentId);', '});'], highlight: [] },
    },
  ];
  const filesSeed = [
    ['src/payments/submit.ts', '审查对象', '支付发起'],
    ['src/payments/callback.ts', '审查对象', '支付回调'],
    ['src/orders/cancel.ts', '审查对象', '订单取消'],
    ['src/orders/restore.ts', '审查对象', '订单恢复'],
    ['src/queries/order-status.ts', '审查对象', '状态展示'],
    ['src/jobs/payment-job.ts', '关联证据', '统一重试'],
    ['contracts/gateway-contract.md', '关联证据', '通道契约'],
    ['tests/orders.integration.ts', '关联证据', '已有测试'],
  ];
  const revisedRequirement = '支付超时后保留结果未知状态；先查单或等待权威结果收敛，再决定是否允许新的支付。';

  function createState(scenario = 'standard') {
    if (!['standard', 'fresh', 'technical', 'partial', 'ready'].includes(scenario)) throw new Error('未知的演示场景');
    const state = {
      scenario, page: 'overview', selectedFinding: 'F-01', filter: 'all', search: '', detailTab: 'impact',
      chain: 'payment', selectedNode: 1, mode: scenario === 'technical' ? 'technical' : 'requirements',
      baselineConfirmed: scenario !== 'fresh' && scenario !== 'technical', baselineVersion: scenario === 'fresh' ? 0 : 1,
      baselineDirty: scenario === 'fresh', stale: false, runStatus: scenario === 'fresh' ? 'idle' : scenario === 'partial' ? 'partial' : 'completed',
      hasResults: scenario !== 'fresh', completedStages: scenario === 'partial' ? 2 : scenario === 'fresh' ? 0 : 4,
      requirements: scenario === 'technical' ? [] : copy(requirementsSeed),
      findings: copy(findingsSeed), sources: scenario === 'technical' ? [] : [
        { name: 'payments.md', kind: '需求材料 · 虚构示例', text: '同一订单最多成功扣款一次。\n支付请求超时即标记失败，允许立即再次支付。\n支付回调必须能够安全重复投递。' },
        { name: 'orders.md', kind: '业务规则 · 虚构示例', text: '取消订单应释放库存占用。\n恢复订单必须重新校验并原子预留库存。' },
      ],
      pending: {}, history: [], humanConfirmed: false, verdict: scenario === 'ready' ? 'approve' : 'request-changes',
      notes: '', submission: null,
    };
    if (scenario === 'technical') {
      state.findings = state.findings.filter((finding) => ['F-02', 'F-04', 'F-05'].includes(finding.id));
      const technicalFinding = state.findings.find((finding) => finding.id === 'F-02');
      Object.assign(technicalFinding, {
        title: '恢复订单后读取了已释放的库存占用',
        summary: '取消路径删除占用记录，恢复后却直接解引用可能为空的对象。',
        requirement: null,
        steps: ['示例取消路径删除了订单对应的库存占用记录。', '恢复路径查询该记录，但没有重新建立记录或处理空返回值。', '后续直接读取 reservation.id，存在可达的空值解引用路径。'],
        impact: '这是由示例实现和返回值契约支持的技术问题，不依赖一条被反推出来的业务需求；业务需求一致性仍未评审。',
        evidence: [
          { title: '取消操作删除占用记录', text: '示例实现会移除记录，后续查询可能返回 null。', source: 'src/orders/cancel.ts:19 · 示例源码' },
          { title: '调用方没有保证记录存在', text: '恢复入口只检查订单所有权，没有为该查询提供非空保证。', source: 'src/api/orders.ts:61 · 示例源码' },
        ],
        counter: [
          { title: '查询接口是否保证非空？', text: '此独立示例的查询契约允许返回 null。' },
          { title: '是否由上游重新创建记录？', text: '已提供的示例入口没有这一步，不能凭空假设存在保障。' },
        ],
        code: { file: '示例 src/orders/restore.ts', start: 26, lines: ['await order.restore();', 'const reservation = await inventory.findByOrder(order.id);', 'return { reservationId: reservation.id };'], highlight: [2] },
      });
      state.selectedFinding = 'F-02';
    }
    if (scenario === 'ready') {
      state.requirements[1].text = revisedRequirement;
      state.requirements.forEach((requirement) => { requirement.check = 'supported'; });
      state.baselineVersion = 2;
      state.findings.forEach((finding) => {
        if (finding.type === 'requirement' || finding.type === 'question') {
          finding.resolved = true;
          finding.status = 'resolved';
        } else if (finding.type === 'implementation') {
          finding.resolved = true;
          finding.disposition = 'fixed';
        }
      });
      state.history.push('预设已处理场景：需求已修订，必要契约已澄清，实现问题由示例 reviewer 标记修复。没有执行真实验证。');
    }
    return state;
  }

  function visibleFindings(state) {
    return state.hasResults ? state.findings : [];
  }

  function approvalGate(state) {
    const reasons = [];
    if (state.runStatus !== 'completed') reasons.push(state.runStatus === 'partial' ? '关联契约证据受限，审查范围尚未完成' : state.runStatus === 'running' ? '演示审查正在进行' : '当前范围尚未完成审查');
    if (state.stale) reasons.push('需求或证据已变化，旧结果待重审');
    if (state.mode === 'requirements' && !state.baselineConfirmed) reasons.push('需求基线尚未确认');
    const critical = visibleFindings(state).filter((finding) => finding.critical && !finding.resolved);
    critical.forEach((finding) => reasons.push(`${finding.id} · ${finding.title}`));
    const unhandled = visibleFindings(state).filter((finding) => finding.status === 'confirmed' && !finding.resolved && !finding.disposition && !finding.critical);
    if (unhandled.length) reasons.push(`${unhandled.length} 项已确认实现缺陷尚未处置`);
    return {
      eligible: reasons.length === 0,
      reasons,
      critical,
      feedbackAllowed: state.hasResults && !state.stale,
    };
  }

  function findingById(state, id) {
    const finding = state.findings.find((item) => item.id === id);
    if (!finding) throw new Error('找不到对应的示例问题');
    return finding;
  }

  function invalidateConclusion(state) {
    if (state.submission) state.history.push('之前记录的模拟结论已失效，需依据新上下文重新判断。');
    state.submission = null;
    state.humanConfirmed = false;
  }

  function recordComment(state, id, note) {
    if (!note.trim()) throw new Error('请填写评论内容');
    const finding = findingById(state, id);
    finding.disposition = 'commented';
    state.history.push(`${id} 已记录评论：${note.trim()}。评论不等于矛盾已解决。`);
    invalidateConclusion(state);
  }

  function reviseRequirement(state, id, text, preset = false) {
    if (!text.trim()) throw new Error('需求内容不能为空');
    const requirement = state.requirements.find((item) => item.id === id);
    if (!requirement) throw new Error('找不到对应的需求条目');
    requirement.text = text.trim();
    requirement.check = 'unknown';
    state.baselineConfirmed = false;
    state.baselineDirty = true;
    state.stale = state.hasResults;
    invalidateConclusion(state);
    state.findings.filter((finding) => finding.requirement === id).forEach((finding) => {
      finding.resolved = false;
      finding.disposition = null;
      finding.status = finding.type === 'question' ? 'unresolved' : 'confirmed';
    });
    if (id === 'RQ-02') state.pending.requirement = preset && text.trim() === revisedRequirement;
    if (id === 'RQ-04') state.pending.evidence = false;
    state.history.push(`${id} 已修订，等待确认基线并重审。自定义文本不会被原型进行语义分析。`);
  }

  function confirmBaseline(state) {
    if (state.mode === 'technical' || !state.requirements.length) throw new Error('当前为有限技术审查，没有可确认的需求基线');
    if (!state.baselineConfirmed) {
      state.baselineVersion += 1;
      state.baselineConfirmed = true;
      state.baselineDirty = false;
      invalidateConclusion(state);
      state.history.push(`人工确认需求基线 v${state.baselineVersion}；确认需求不代表其假设已被证明。`);
    }
  }

  function attachEvidence(state, note) {
    if (!note.trim()) throw new Error('请填写证据说明');
    findingById(state, 'F-03');
    state.pending.evidence = true;
    state.stale = true;
    invalidateConclusion(state);
    state.history.push(`F-03 已补充示例契约：${note.trim()}。必须重审后才更新裁决。`);
  }

  function markFixed(state, id, note) {
    if (!note.trim()) throw new Error('请填写修复说明');
    const finding = findingById(state, id);
    if (finding.type !== 'implementation') throw new Error('需求问题不能标记为代码已修复');
    finding.disposition = 'fixed';
    finding.resolved = true;
    invalidateConclusion(state);
    state.history.push(`${id} 人工标记已修复：${note.trim()}。原型未执行测试或修改源码。`);
    const requirement = state.requirements.find((item) => item.id === finding.requirement);
    if (requirement) requirement.check = 'unknown';
  }

  function finishRun(state) {
    if (state.mode === 'requirements' && !state.baselineConfirmed) throw new Error('确认需求基线后才能开始需求驱动审查');
    if (state.pending.requirement) {
      const finding = findingById(state, 'F-01');
      finding.resolved = true;
      finding.status = 'resolved';
      const requirement = state.requirements.find((item) => item.id === 'RQ-02');
      if (requirement) requirement.check = 'supported';
    }
    if (state.pending.evidence) {
      const finding = findingById(state, 'F-03');
      finding.resolved = true;
      finding.status = 'resolved';
      const requirement = state.requirements.find((item) => item.id === 'RQ-04');
      if (requirement) requirement.check = 'supported';
    }
    state.pending = {};
    state.runStatus = 'completed';
    state.completedStages = 4;
    state.hasResults = true;
    state.stale = false;
    invalidateConclusion(state);
    if (state.verdict === 'approve' && !approvalGate(state).eligible) state.verdict = 'request-changes';
    state.history.push('模拟流程完成；结果来自预设分支，不是实际模型分析或执行验证。');
  }

  function submitVerdict(state, verdict) {
    if (!['approve', 'request-changes', 'comment'].includes(verdict)) throw new Error('未知的审查结论');
    const gate = approvalGate(state);
    if (verdict === 'approve' && (!gate.eligible || !state.humanConfirmed)) throw new Error('不能通过：请先解决阻断、完成有效审查并人工确认边界');
    if (verdict !== 'approve' && !gate.feedbackAllowed) throw new Error('当前没有可提交的有效结果，请先完成审查或重审过期结果');
    state.submission = { verdict, mode: state.mode, baselineVersion: state.baselineVersion };
    state.history.push(`已在原型内模拟记录“${verdict}”；未提交到 GitHub，也未持久化到真实审查会话。`);
  }

  const demoModel = { createState, approvalGate, recordComment, reviseRequirement, confirmBaseline, attachEvidence, markFixed, finishRun, submitVerdict, revisedRequirement };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = demoModel;
    return;
  }
  if (document.documentElement.dataset.prototype === 'review-center') {
    window.ReviewDemoModel = Object.freeze(demoModel);
    return;
  }

  const svgPaths = {
    grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
    file: '<path d="M14 2H5v20h14V7l-5-5Z"/><path d="M14 2v6h5M8 12h8M8 16h6"/>',
    flow: '<rect x="2" y="9" width="5" height="6" rx="1"/><rect x="17" y="2" width="5" height="6" rx="1"/><rect x="17" y="16" width="5" height="6" rx="1"/><path d="M7 12h5V5h5M12 12v7h5"/>',
    bug: '<path d="M8 7h8v11a4 4 0 0 1-8 0V7ZM9 3l3 4 3-4M3 10h5M16 10h5M2 16h6M16 16h6M5 22l4-3M15 19l4 3M12 8v12"/>',
    shield: '<path d="m12 2 8 4v6c0 5-8 10-8 10S4 17 4 12V6l8-4Z"/><path d="m8 12 3 3 5-6"/>',
    play: '<path d="m8 4 13 8-13 8V4Z"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    alert: '<path d="m12 3 10 18H2L12 3Z"/><path d="M12 9v5M12 17h.01"/>',
    arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
    branch: '<path d="M6 5v13a3 3 0 0 0 3 3h3M6 11h8a4 4 0 0 0 4-4V5"/><circle cx="6" cy="3" r="2"/><circle cx="18" cy="3" r="2"/><circle cx="14" cy="21" r="2"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    search: '<circle cx="10" cy="10" r="6"/><path d="m15 15 6 6"/>',
    lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V6a4 4 0 0 1 8 0v4M12 14v3"/>',
    message: '<path d="M3 3h18v14H8l-5 4V3Z"/><path d="M7 8h10M7 12h7"/>',
    refresh: '<path d="M20 7A9 9 0 1 0 21 14M20 2v6h-6"/>',
    moon: '<path d="M21 13A9 9 0 0 1 11 3a9 9 0 1 0 10 10Z"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 1v2M12 21v2M1 12h2M21 12h2M4 4l2 2M18 18l2 2M4 20l2-2M18 6l2-2"/>',
    close: '<path d="m6 6 12 12M6 18 18 6"/>',
    plus: '<path d="M12 4v16M4 12h16"/>',
    download: '<path d="M12 3v12m-4-4 4 4 4-4M4 17v4h16v-4"/>',
    edit: '<path d="m16 3 5 5L9 20l-6 1 1-6L16 3ZM13 6l5 5"/>',
    code: '<path d="m8 5-7 7 7 7m8-14 7 7-7 7M14 3l-4 18"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>',
    link: '<path d="m10 13 4-4M8 16l-2 2a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0M16 8l2-2a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0" transform="translate(1 0) scale(.9)"/>',
  };
  const icon = (name, className = '') => `<svg class="${className}" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round">${svgPaths[name] || svgPaths.file}</svg>`;
  const escape = (value) => String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  const badge = (text, tone = '', dot = false) => `<span class="badge ${tone}${dot ? ' dot' : ''}">${escape(text)}</span>`;
  const navItems = [['overview', '审查概览', 'grid'], ['requirements', '需求基线', 'file'], ['chains', '业务链路', 'flow'], ['findings', '发现与裁决', 'bug'], ['conclusion', '审查结论', 'shield']];
  const typeLabels = { requirement: '需求缺陷', implementation: '实现缺陷', question: '待核实', reasonable: '合理取舍' };
  const checkLabels = { supported: ['有证据支持', 'green'], conflict: ['需求前提冲突', 'amber'], violated: ['实现未满足', 'red'], unknown: ['证据不足', 'blue'] };
  const verdictLabels = { approve: '通过', 'request-changes': '要求修改', comment: '仅评论' };
  const stageLabels = ['建立业务影响链', '需求与实现双向校验', '验证与反证', '形成范围化结论'];
  const pageEl = document.getElementById('page');
  const navEl = document.getElementById('navigation');
  const modal = document.getElementById('modal');
  const toastEl = document.getElementById('toast');
  let state = createState();
  let runGeneration = 0;
  let toastTimer;

  function metrics() {
    const findings = visibleFindings(state);
    return {
      confirmed: findings.filter((finding) => finding.status === 'confirmed').length,
      unknown: findings.filter((finding) => finding.status === 'unresolved' && !finding.resolved).length,
      dismissed: findings.filter((finding) => finding.status === 'dismissed').length,
      supported: state.requirements.filter((requirement) => requirement.check === 'supported').length,
      critical: approvalGate(state).critical.length,
    };
  }

  function findingBadges(finding) {
    const tone = finding.type === 'question' ? 'blue' : finding.type === 'reasonable' ? 'green' : 'red';
    const status = finding.status === 'dismissed' ? '已排除' : finding.status === 'resolved' ? '已澄清' : finding.status === 'unresolved' ? '尚未确认' : '已确认';
    return `${badge(typeLabels[finding.type], tone)}${finding.severity !== 'none' ? badge(finding.severity === 'potential' ? '潜在高影响' : '高影响', 'outline') : ''}${badge(status, finding.status === 'unresolved' ? 'blue' : finding.resolved ? 'green' : '', true)}`;
  }

  function showToast(message, warning = false) {
    clearTimeout(toastTimer);
    toastEl.textContent = message;
    toastEl.className = `toast${warning ? ' warning' : ''}`;
    toastEl.hidden = false;
    toastTimer = setTimeout(() => { toastEl.hidden = true; }, 6500);
  }

  function header(title, description, action = true) {
    const running = state.runStatus === 'running';
    const startLabel = state.runStatus === 'idle' ? '开始审查' : state.runStatus === 'partial' || state.runStatus === 'cancelled' ? '继续审查' : state.stale ? '重新审查受影响范围' : '重新审查';
    return `<div class="page-heading"><div><div class="eyebrow"><span>REVIEW VNEXT</span> / ${state.mode === 'technical' ? '有限技术审查' : '需求驱动审查'}</div><h1>${title}</h1><p>${description}</p></div>${action ? `<div class="heading-actions"><button class="button" data-action="export">${icon('download')}导出示例摘要</button><button class="button primary" data-action="run" ${running ? 'disabled' : ''}>${icon(running ? 'refresh' : 'play', running ? 'spin' : '')}${running ? '模拟审查中' : startLabel}</button></div>` : ''}</div>`;
  }

  function notice() {
    if (state.stale) return `<div class="notice">${icon('refresh')}<div><strong>审查依据已变化，相关结果待重审</strong><p>旧发现仅供回看，不能继续作为有效通过结论。修订需求还需先确认基线。</p></div><button class="text-button" data-action="${state.baselineConfirmed ? 'run' : 'nav'}" data-page="requirements">${state.baselineConfirmed ? '重审受影响范围' : '确认需求基线'} ${icon('arrow')}</button></div>`;
    if (state.mode === 'technical') return `<div class="notice blue">${icon('info')}<div><strong>有限技术审查 · 需求一致性未评审</strong><p>可以检查真实逻辑与技术契约，但不能据此声称业务需求已全部满足。此标识会保留在结论中。</p></div></div>`;
    if (!state.baselineConfirmed) return `<div class="notice blue">${icon('file')}<div><strong>请先确认本次需求基线</strong><p>模型提取或推断不等于已确认需求；确认条目也不代表其前提必然正确。</p></div><button class="text-button" data-action="nav" data-page="requirements">查看并确认 ${icon('arrow')}</button></div>`;
    if (state.runStatus === 'partial') return `<div class="notice">${icon('alert')}<div><strong>一项关联证据未完成，不能宣称审查完整</strong><p>通道契约的示例读取受限。仍可提交有效的评论或要求修改，不能批准。</p></div><button class="text-button" data-action="run">继续未完成项 ${icon('arrow')}</button></div>`;
    const gate = approvalGate(state);
    if (gate.critical.length) return `<div class="notice">${icon('lock')}<div><strong>${gate.critical.length} 项关键问题尚未闭合，当前不能批准</strong><p>包含需求前提冲突与必要契约待澄清。记录评论不等于问题已解决；仍可提交反馈。</p></div><button class="text-button" data-action="nav" data-page="conclusion">查看结论依据 ${icon('arrow')}</button></div>`;
    if (gate.eligible) return `<div class="notice green">${icon('shield')}<div><strong>已具备提交通过结论的条件，等待人工判断</strong><p>这是预设演示状态，不是模型或测试的真实验证结果；最终结论仍需人工确认。</p></div><button class="text-button" data-action="nav" data-page="conclusion">确认审查边界 ${icon('arrow')}</button></div>`;
    return '';
  }

  function progress() {
    if (state.runStatus !== 'running' && state.runStatus !== 'cancelled') return '';
    return `<div class="progress-panel" aria-live="polite"><div class="progress-head">${icon('refresh', state.runStatus === 'running' ? 'spin' : '')}<strong>${state.runStatus === 'running' ? '正在播放预设审查流程' : '演示审查已取消'}</strong><span class="subtle">不调用模型，不执行代码</span>${state.runStatus === 'running' ? '<button class="text-button" data-action="cancel-run">取消</button>' : ''}</div><div class="progress-stages">${stageLabels.map((label, index) => `<div class="progress-stage ${index < state.completedStages ? 'done' : index === state.completedStages ? 'current' : ''}">${index < state.completedStages ? '✓' : `0${index + 1}`} ${label}</div>`).join('')}</div></div>`;
  }

  function metricCard(label, value, suffix, foot, symbol, tone = '') {
    return `<div class="metric"><div class="metric-label">${label}${icon(symbol)}</div><div class="metric-value">${value}<small>${suffix}</small></div><div class="metric-foot ${tone}">${foot}</div></div>`;
  }

  function priorityRow(finding) {
    return `<button class="priority-row" data-action="finding" data-id="${finding.id}"><span class="priority-icon ${finding.type === 'question' ? 'amber' : ''}">${icon(finding.type === 'question' ? 'info' : 'alert')}</span><span class="priority-row-content"><span class="row-badges"><span class="mono">${finding.id}</span>${badge(typeLabels[finding.type], finding.type === 'question' ? 'blue' : 'red')}${badge(finding.origin, 'outline')}${finding.resolved ? badge('已处理', 'green') : ''}</span><strong>${escape(finding.title)}</strong><p>${escape(finding.summary)}</p></span><span class="row-arrow">${icon('arrow')}</span></button>`;
  }

  function miniFlow() {
    return `<div class="flow">${[['请求发起', 'submit.ts'], ['超时判定', state.mode === 'technical' ? 'domain.ts' : 'RQ-02'], ['再次支付', 'payment.ts'], ['结果回调', 'callback.ts']].map(([label, file], index) => `${index ? '<span class="flow-arrow" aria-hidden="true">→</span>' : ''}<button class="flow-node ${index === 1 ? 'warning' : ''}" data-action="flow-node" data-node="${index}"><small>0${index + 1}</small><strong>${label}</strong><code>${file}</code></button>`).join('')}</div>`;
  }

  function renderOverview() {
    const count = metrics();
    const items = visibleFindings(state).filter((finding) => finding.type !== 'reasonable').slice(0, 3);
    return `${header('支付与订单一致性审查', '从需求意图出发，沿真实业务链寻找问题；让每一个判断都有上下文。')}
      <div class="inline-meta"><span>${icon('branch')}feat/payment-timeout</span><span>${icon('file')}5 个审查文件 · 3 个关联证据</span><span>${icon('clock')}预设演示快照 · 非真实分析</span>${badge(state.mode === 'technical' ? '需求未评审' : `需求基线 v${state.baselineVersion}${state.baselineConfirmed ? ' · 已确认' : ' · 待确认'}`, state.baselineConfirmed ? 'green' : 'blue')}</div>
      ${progress()}${notice()}
      <section class="metrics-grid" aria-label="审查指标">
        ${metricCard('需求逐项校验', state.mode === 'technical' ? '—' : state.hasResults ? count.supported : '—', state.mode === 'technical' ? '' : `/ ${state.requirements.length}`, state.mode === 'technical' ? '未提供需求，不推断为已满足' : '有证据支持 ≠ 所有路径正确', 'file')}
        ${metricCard('已确认缺陷', count.confirmed, '项', '区分需求问题与实现问题', 'bug')}
        ${metricCard('关键待澄清', count.unknown, '项', count.unknown ? '缺少决定性证据，不冒充 Bug' : '必要前提状态明确', 'info', count.unknown ? 'amber' : '')}
        ${metricCard('已排除局部误报', count.dismissed, '项', '全局证据支持合理取舍', 'shield', 'green')}
      </section>
      <div class="overview-grid"><div class="column-stack">
        <section class="panel"><div class="panel-header"><div><h2>优先关注真正影响业务的问题</h2><p>按根因聚合，而不是按文件重复评论</p></div><button class="text-button" data-action="nav" data-page="findings">全部发现 ${icon('arrow')}</button></div>${items.length ? items.map(priorityRow).join('') : `<div class="empty-state">${icon('search')}<h3>尚未产生审查发现</h3><p>先确认需求，再一键播放预设审查流程。空列表不代表代码没有问题。</p><button class="button" data-action="nav" data-page="requirements">确认需求基线</button></div>`}</section>
        <section class="panel"><div class="panel-header"><div><h2>一条业务链，连接需求与代码</h2><p>支付结果的状态收敛 · 关联 4 个角色</p></div><button class="text-button" data-action="nav" data-page="chains">展开链路 ${icon('arrow')}</button></div><div class="panel-body">${miniFlow()}<div class="flow-caption">${icon('alert')}${state.mode === 'technical' ? '当前仅核对技术调用与返回契约；业务需求仍未评审。' : '局部实现符合字面需求，全局却可能违背“单次扣款”约束。'}</div></div></section>
      </div><div class="column-stack side-column">
        <section class="panel"><div class="panel-header"><h2>本次判断的依据</h2>${badge('来源可追溯', 'green')}</div><div class="panel-body">
          <div class="basis-row">${icon('file')}<div><strong>${state.mode === 'technical' ? '需求材料未提供' : `${state.requirements.length} 条需求 · 人工确认基线`}</strong><p>${state.mode === 'technical' ? '仅审查可证实的技术契约' : 'payments.md / orders.md · 虚构示例'}</p></div></div>
          <div class="basis-row">${icon('flow')}<div><strong>2 条相关业务链</strong><p>支付与回调 · 取消与库存恢复</p></div></div>
          <div class="basis-row">${icon('shield')}<div><strong>保障与例外也接受核实</strong><p>统一重试 · 展示缓存 · 幂等契约</p></div></div>
          <button class="text-button" data-action="nav" data-page="requirements">查看需求与假设 ${icon('arrow')}</button>
        </div><div class="panel-note">代码现状不是需求，历史偏好不是正确性证明。</div></section>
        <section class="panel"><div class="panel-header"><h2>审查过程</h2>${badge('预设流程', 'outline')}</div><div class="panel-body"><ol class="timeline">
          ${[['需求与假设分离', state.mode === 'technical' ? '有限技术审查 · 需求未验证' : state.baselineConfirmed ? `人工确认 v${state.baselineVersion}` : '等待人工确认'], ['沿业务链建立上下文', '调用方、契约、状态与配置'], ['双向验证 + 反证', '既检查实现，也检验需求前提'], ['结论保留边界', '未知、失败和合理取舍分别呈现']].map(([title, detail], index) => `<li><span class="timeline-mark">${state.hasResults || index === 0 ? icon('check') : icon('clock')}</span><div><strong>${title}</strong><p>${detail}</p></div></li>`).join('')}
        </ol></div></section>
      </div></div>`;
  }

  function requirementBadge(requirement) {
    if (!state.hasResults || state.stale) return badge(state.stale ? '待重审' : '待校验', 'blue');
    const [text, tone] = checkLabels[requirement.check];
    return badge(text, tone, true);
  }

  function renderRequirements() {
    return `${header('先确认“应该做什么”', '需求是审查基准，不是免于逻辑验证的真理。将原文、推断与事实前提分开。', false)}
      ${progress()}${notice()}<div class="requirement-grid"><div>
        <section class="panel"><div class="panel-header"><div><h2>需求基线 ${state.mode === 'technical' ? '' : `v${state.baselineVersion}`}</h2><p>确认代表审查依据已明确，不代表需求假设已被证明</p></div>${state.requirements.length ? `<button class="button ${state.baselineConfirmed ? '' : 'primary'} small" data-action="confirm-baseline" ${state.baselineConfirmed ? 'disabled' : ''}>${icon('check')}${state.baselineConfirmed ? '基线已确认' : '确认当前基线'}</button>` : badge('未提供', 'blue')}</div>
        ${state.requirements.length ? state.requirements.map((requirement) => `<article class="requirement-row"><div class="requirement-row-head"><span class="requirement-id">${requirement.id}</span><strong>${escape(requirement.title)}</strong>${requirementBadge(requirement)}</div><p>${escape(requirement.text)}</p><div class="requirement-meta"><span>${badge(requirement.kind)} <span>${escape(requirement.source)}</span></span><button class="text-button" data-action="edit-requirement" data-id="${requirement.id}">${icon('edit')}编辑条目</button></div></article>`).join('') : `<div class="empty-state">${icon('file')}<h3>这次只进行有限技术审查</h3><p>没有需求时，不把现有代码反推成已确认的要求。可切换到独立的“从需求确认开始”示例体验完整流程。</p><button class="button" data-action="scenario-fresh">打开需求确认示例</button></div>`}
        </section>
        ${state.requirements.length ? `<section class="assumption"><div class="row-badges">${badge('模型推断', 'blue')}${badge(state.assumptionIncluded ? '已纳入 · 尚待验证' : '未纳入需求', 'outline')}</div><h3>支付通道的查询接口对所有订单始终可用</h3><p>这只是示例模型推断，不能据此声称查询永远成功。纳入后仍需验证适用范围，而不是变成“已证实事实”。</p><button class="text-button" data-action="include-assumption" ${state.assumptionIncluded ? 'disabled' : ''}>${state.assumptionIncluded ? '已作为待验证假设保留' : '纳入待验证假设'} ${icon('arrow')}</button></section>` : ''}
      </div><div class="column-stack">
        <section class="panel"><div class="panel-header"><h2>来源材料</h2><button class="text-button" data-action="add-source">${icon('plus')}补充材料</button></div><div class="panel-body">${state.sources.length ? state.sources.map((source, index) => `<div class="source-card"><strong>${icon('file')}${escape(source.name)}</strong><p>${escape(source.kind)}</p><button class="text-button" data-action="source" data-index="${index}">查看原文 ${icon('arrow')}</button></div>`).join('') : '<p class="subtle">尚未提供需求材料。</p>'}<p class="form-hint">原型仅在当前页面内存保存输入，不读取你的本地文件，不进行自动提取或上传。</p></div></section>
        <section class="panel"><div class="panel-header"><h2>三类依据，不混为一谈</h2></div><div class="panel-body"><dl class="key-value"><div><dt>已确认需求</dt><dd>规定本次应该实现什么</dd></div><div><dt>实现与契约证据</dt><dd>证明系统实际如何运行</dd></div><div><dt>待验证假设</dt><dd>需要进一步核实，不能直接定罪</dd></div></dl></div></section>
      </div></div>`;
  }

  function codeBlock(code) {
    return `<div class="code-block"><div class="code-header"><span>${escape(code.file)}</span><span>虚构源码 · 只读</span></div><div class="code-lines">${code.lines.map((line, index) => `<div class="code-line ${code.highlight.includes(index) ? 'highlight' : ''}"><span class="line-number">${code.start + index}</span><code>${escape(line)}</code></div>`).join('')}</div></div>`;
  }

  function renderChains() {
    const payment = state.chain === 'payment';
    const nodes = payment ? [
      ['请求发起', 'submit.ts', '接收订单支付请求，向支付通道发起单次扣款。'],
      ['超时判定', state.mode === 'technical' ? 'domain.ts' : 'RQ-02 / domain', '关键假设：没有收到结果，是否就代表支付失败？'],
      ['再次支付', 'payment.ts', '如果过早开放重付入口，可能创建第二笔扣款。'],
      ['结果回调', 'callback.ts', '原请求可能在稍后回调成功，需要与请求侧状态收敛。'],
    ] : [
      ['订单取消', 'cancel.ts', '取消状态使原库存占用释放。'],
      ['库存释放', 'inventory.ts', '释放的资源可以被其他订单预留。'],
      ['订单恢复', 'restore.ts', '恢复为待支付前应重新校验并原子预留。'],
      ['后续履约', 'fulfillment.ts', '没有有效库存保障的订单不能被当成可履约订单。'],
    ];
    const node = nodes[Math.min(state.selectedNode, nodes.length - 1)];
    return `${header('看完整条业务链，而不只看当前文件', '把目标、状态变化和上下游保障放在一起，才能判断局部疑点是否真的成立。')}
      ${progress()}${state.mode === 'technical' ? notice() : ''}<div class="chain-tabs" role="tablist" aria-label="业务链选择"><button role="tab" aria-selected="${payment}" class="tab-button ${payment ? 'active' : ''}" data-action="chain" data-chain="payment">支付与结果收敛</button><button role="tab" aria-selected="${!payment}" class="tab-button ${!payment ? 'active' : ''}" data-action="chain" data-chain="orders">取消与库存恢复</button></div>
      <div class="chain-layout"><div class="column-stack"><section class="panel"><div class="panel-header"><div><h2>${payment ? '支付请求 → 状态判断 → 最终结果' : '取消 → 资源释放 → 恢复 → 履约'}</h2><p>按同一业务行为组织，不按文件字母顺序拆散</p></div>${badge('示例影响链', 'green')}</div><div class="panel-body"><div class="flow">${nodes.map(([title, file], index) => `${index ? '<span class="flow-arrow" aria-hidden="true">→</span>' : ''}<button class="flow-node ${index === state.selectedNode ? 'selected' : ''} ${index === 1 ? 'warning' : ''}" data-action="flow-node" data-node="${index}"><small>0${index + 1}</small><strong>${title}</strong><code>${file}</code></button>`).join('')}</div><div class="chain-contract"><strong>贯穿链路的业务不变式</strong><p>${payment ? '同一订单最多成功扣款一次；未知结果不能直接变成确定失败。' : '取消时释放资源，恢复时必须重新建立资源保障，不能只恢复状态。'}</p></div><div class="detail-section"><h3>${icon('link')}跨节点判断</h3><p>${payment ? '请求侧和回调侧各自看起来正常，但对“支付失败”的定义不一致。需要同时审查需求语义、通道事实与应用状态机。' : '取消和恢复各自只修改了一点状态；真正的问题是两条路径没有维持同一个库存契约。'}</p></div></div></section>
      <section class="panel"><div class="panel-header"><div><h2>范围与证据账本</h2><p>5 个审查对象，3 个只读关联证据 · 不代表模型逐行理解</p></div>${badge(state.runStatus === 'partial' ? '7 / 8 已完成' : state.hasResults ? '8 / 8 范围有状态' : '等待审查', state.runStatus === 'partial' ? 'amber' : 'outline')}</div><div class="table-wrap"><table class="scope-table"><thead><tr><th>示例文件</th><th>角色</th><th>状态</th><th><span class="sr-only">操作</span></th></tr></thead><tbody>${filesSeed.map(([path, kind, role], index) => `<tr><td><code>${path}</code><div class="subtle">${role}</div></td><td>${kind}</td><td>${badge(!state.hasResults ? '未开始' : state.stale ? '待重审' : state.runStatus === 'partial' && index === 6 ? '读取受限' : '已纳入分析', !state.hasResults || state.stale ? 'blue' : state.runStatus === 'partial' && index === 6 ? 'amber' : 'green')}</td><td><button class="text-button" data-action="file-evidence" data-index="${index}">查看</button></td></tr>`).join('')}</tbody></table></div><div class="panel-note">选定范围不是证据边界。未连接的外部实现保持未知，不自动补全。</div></section></div>
      <div class="column-stack"><section class="panel"><div class="panel-header"><h2>当前节点</h2>${badge(`0${state.selectedNode + 1}`, 'outline')}</div><div class="panel-body"><dl class="key-value"><div><dt>业务角色</dt><dd>${node[0]}</dd></div><div><dt>关联位置</dt><dd><code>${node[1]}</code></dd></div><div><dt>当前判断</dt><dd>${node[2]}</dd></div><div><dt>需要一起看的上下文</dt><dd>需求条目、调用方、状态转换与必要契约</dd></div></dl><div class="section-gap"><button class="text-button" data-action="finding" data-id="${payment && state.mode !== 'technical' ? 'F-01' : 'F-02'}">查看关联问题 ${icon('arrow')}</button></div></div></section><section class="panel"><div class="panel-header"><h2>已有保障，不等于盲目信任</h2></div><div class="panel-body"><p class="subtle">调度层负责重试；展示缓存有明确的适用边界。保障一旦变化，依赖它的旧裁决也应失效。</p><div class="section-gap"><button class="text-button" data-action="show-dismissed">查看被推翻的局部疑点 ${icon('arrow')}</button></div></div></section></div></div>`;
  }

  function renderFindingDetail(finding) {
    if (!finding) return `<section class="panel"><div class="empty-state">${icon('search')}<h3>没有匹配的发现</h3><p>尝试更换筛选或搜索内容。空结果不是审查通过结论。</p></div></section>`;
    const requirement = state.requirements.find((item) => item.id === finding.requirement);
    let content;
    if (state.detailTab === 'evidence') {
      content = `<div class="detail-section"><h3>${icon('file')}支持证据</h3>${finding.evidence.map((evidence) => `<div class="evidence-row">${icon('check')}<div><strong>${evidence.title}</strong><p>${evidence.text}</p><code>${evidence.source}</code></div></div>`).join('')}</div><div class="detail-section"><h3>${icon('shield')}主动反证检查</h3>${finding.counter.map((counter) => `<div class="evidence-row">${icon('search')}<div><strong>${counter.title}</strong><p>${counter.text}</p></div></div>`).join('')}</div>${codeBlock(finding.code)}`;
    } else if (state.detailTab === 'history') {
      const history = state.history.filter((entry) => entry.includes(finding.id) || entry.includes(finding.requirement || '__none__'));
      content = `<div class="detail-section"><h3>${icon('clock')}处置与判断分开记录</h3>${history.length ? history.map((entry) => `<div class="evidence-row">${icon('message')}<div><p>${escape(entry)}</p></div></div>`).join('') : '<p>尚无本次页面会话的操作记录。</p>'}<div class="section-gap notice blue slim">${icon('info')}<div><strong>记录评论不等于消除问题</strong><p>关键矛盾仍需补充依据、确认修订并重新审查。一次忽略不生成全局免责规则。</p></div></div></div>`;
    } else {
      content = `${requirement ? `<div class="detail-section"><h3>${icon('file')}对应需求 · ${requirement.id}</h3><blockquote class="requirement-quote">${escape(requirement.text)}<footer>${escape(requirement.source)} · ${state.baselineConfirmed ? '人工已确认的需求，不代表前提必然成立' : '基线待确认'}</footer></blockquote></div>` : '<div class="detail-section"><h3>判断依据</h3><p>当前范围内的实际技术契约与可追溯业务取舍，不伪造需求编号。</p></div>'}<div class="detail-section"><h3>${icon('flow')}最小行为路径</h3><ol class="reasoning">${finding.steps.map((step) => `<li>${step}</li>`).join('')}</ol></div><div class="detail-section"><h3>${icon(finding.type === 'reasonable' ? 'shield' : 'alert')}${finding.type === 'reasonable' ? '为什么不作为缺陷' : '业务影响与判断边界'}</h3><div class="${finding.type === 'reasonable' ? 'chain-contract' : 'impact-box'}">${finding.impact}</div></div>${codeBlock(finding.code)}`;
    }
    const actions = finding.type === 'reasonable' ? `<button class="button small" data-action="feedback" data-id="${finding.id}">${icon('message')}补充适用边界</button>` : `${finding.type === 'requirement' ? `<button class="button primary small" data-action="edit-requirement" data-id="RQ-02">${icon('edit')}修订需求</button>` : finding.type === 'question' ? `<button class="button primary small" data-action="evidence">${icon('file')}补充契约证据</button>` : `<button class="button primary small" data-action="fix" data-id="${finding.id}" ${finding.disposition === 'fixed' ? 'disabled' : ''}>${icon('check')}${finding.disposition === 'fixed' ? '已人工标记修复' : '标记已修复'}</button>`}<button class="button small" data-action="comment" data-id="${finding.id}">${icon('message')}${finding.disposition === 'commented' ? '继续记录评论' : '记录评论'}</button>`;
    return `<article class="panel finding-detail"><div class="row-badges"><span class="mono">${finding.id}</span>${findingBadges(finding)}${finding.critical && !finding.resolved ? badge('关键阻断', 'amber') : ''}</div><h2>${escape(finding.title)}</h2><p class="lead">${escape(finding.summary)}</p><div class="inline-meta section-gap"><span>${icon('file')}${escape(finding.source)}</span><span>${finding.origin}</span></div>${finding.disposition === 'commented' && finding.critical && !finding.resolved ? `<div class="notice slim">${icon('lock')}<div><strong>已记录评论，但关键问题仍未解决</strong><p>此动作没有解除通过限制。</p></div></div>` : ''}${finding.resolved && finding.type !== 'reasonable' ? `<div class="notice green slim">${icon('check')}<div><strong>${finding.disposition === 'fixed' ? '人工标记已修复，未执行测试验证' : '示例裁决已更新'}</strong><p>仅演示状态变化，不代表真实代码、需求或契约已被验证。</p></div></div>` : ''}<div class="detail-tabs" role="tablist" aria-label="发现详情">${[['impact', '业务影响'], ['evidence', '证据与反证'], ['history', '处置记录']].map(([id, label]) => `<button class="detail-tab ${state.detailTab === id ? 'active' : ''}" role="tab" aria-selected="${state.detailTab === id}" data-action="detail-tab" data-tab="${id}">${label}</button>`).join('')}</div>${content}<div class="detail-actions">${actions}<button class="text-button" data-action="nav" data-page="conclusion">查看结论限制 ${icon('arrow')}</button></div><p class="verification-note">判断方式：预设逻辑推演。所有位置与证据均为示例；没有实际复现、运行测试或修改文件。</p></article>`;
  }

  function renderFindings() {
    const all = visibleFindings(state);
    const search = state.search.toLowerCase();
    const filtered = all.filter((finding) => (state.filter === 'all' || (state.filter === 'confirmed' && finding.status === 'confirmed') || (state.filter === 'unknown' && finding.status === 'unresolved') || (state.filter === 'dismissed' && finding.type === 'reasonable')) && `${finding.title} ${finding.source} ${finding.requirement || ''} ${finding.id}`.toLowerCase().includes(search));
    const selected = filtered.find((finding) => finding.id === state.selectedFinding) || filtered[0];
    return `${header('发现问题，也验证“问题是否成立”', '类型、影响和证据确定性分别表达；把合理取舍从正式缺陷中排除。')}${progress()}${notice()}<div class="findings-layout"><section class="panel findings-list-panel"><div class="list-toolbar"><div class="search-wrap">${icon('search')}<input id="finding-search" type="search" aria-label="搜索审查发现" placeholder="搜索问题、需求或文件…" value="${escape(state.search)}"></div><div class="filter-bar" aria-label="发现类型筛选">${[['all', '全部'], ['confirmed', '确认缺陷'], ['unknown', '待核实'], ['dismissed', '已排除']].map(([id, label]) => `<button class="filter-button ${state.filter === id ? 'active' : ''}" data-action="filter" data-filter="${id}" aria-pressed="${state.filter === id}">${label}</button>`).join('')}</div></div><div class="finding-list">${filtered.length ? filtered.map((finding) => `<button class="finding-card ${selected?.id === finding.id ? 'active' : ''}" data-action="select-finding" data-id="${finding.id}" aria-pressed="${selected?.id === finding.id}"><span class="row-badges"><span class="mono">${finding.id}</span>${badge(typeLabels[finding.type], finding.type === 'reasonable' ? 'green' : finding.type === 'question' ? 'blue' : 'red')}</span><h3>${escape(finding.title)}</h3><p>${escape(finding.source)}</p><span class="finding-card-bottom">${icon(finding.resolved ? 'check' : finding.critical ? 'lock' : 'bug')}${finding.resolved ? finding.type === 'reasonable' ? '全局证据已推翻' : '示例已处理' : finding.status === 'unresolved' ? '关键前提未证实' : `${finding.origin} · 已复核`}${finding.disposition === 'commented' ? ' · 已评论' : ''}</span></button>`).join('') : '<div class="empty-state"><p>没有匹配结果</p></div>'}</div><div class="panel-note">已排除的疑点不计入正式缺陷。</div></section>${renderFindingDetail(selected)}</div>`;
  }

  function summaryText(verdict = state.verdict) {
    const gate = approvalGate(state);
    return `Review vNext · ${verdictLabels[verdict]}（原型模拟）\n\n所有业务、证据与裁决均为预设示例，未调用模型或写回 GitHub。\n审查范围：5 个示例文件、3 个关联证据。\n需求边界：${state.mode === 'technical' ? '有限技术审查；需求一致性未评审，不代表业务需求已满足。' : `需求基线 v${state.baselineVersion}${state.baselineConfirmed ? ' 已确认' : ' 待确认'}；${state.stale ? '依据变化，旧结果待重审。' : '结论仅覆盖已提供的示例范围。'}`}\n执行状态：${({ idle: '未开始', running: '模拟执行中', partial: '部分完成：通道契约受限', cancelled: '已取消，不能完整通过', completed: '预设流程完成' })[state.runStatus]}\n\n${gate.reasons.length ? `当前通过限制：\n${gate.reasons.map((reason) => `• ${reason}`).join('\n')}` : `通过条件：无未解决的关键阻断；${state.humanConfirmed ? '人工已确认本次边界。' : '仍需人工确认审查边界。'}`}\n\n审查结果：\n${visibleFindings(state).filter((finding) => finding.type !== 'reasonable').map((finding) => `• ${finding.id} [${typeLabels[finding.type]} / ${finding.resolved ? '示例已处理' : finding.status === 'unresolved' ? '待核实' : '已确认'}] ${finding.title}${finding.disposition === 'commented' && !finding.resolved ? '（已评论，不等于已解决）' : ''}`).join('\n') || '尚无有效发现；不能据此推断代码正确。'}\n\n验证说明：没有实际执行测试或复现。人工标记修复不等于执行验证通过。${state.notes.trim() ? `\n\n人工补充：\n${state.notes.trim()}` : ''}`;
  }

  function renderConclusion() {
    const gate = approvalGate(state);
    const checks = [
      [state.mode === 'technical' || state.baselineConfirmed, state.mode === 'technical' ? '明确选择了有限技术范围' : '需求基线已经人工确认', state.mode === 'technical' ? '需求一致性仍然未评审' : `当前基线 v${state.baselineVersion}`],
      [state.runStatus === 'completed', '必要审查范围完整', state.runStatus === 'partial' ? '存在读取受限的关联证据' : '每个范围项都有状态，完成不等于穷尽正确性'],
      [!state.stale, '结果与当前依据一致', state.stale ? '依据已变化，需重审' : '当前为同一示例快照'],
      [gate.critical.length === 0, '关键矛盾与必要前提已闭合', gate.critical.length ? `${gate.critical.length} 项关键问题仍未解决` : '非关键未知不单独阻止批准'],
      [!gate.reasons.some((reason) => reason.includes('实现缺陷')), '确认问题已按规则处置', '处置与修复验证是不同状态'],
    ];
    const submitDisabled = state.verdict === 'approve' ? !gate.eligible || !state.humanConfirmed : !gate.feedbackAllowed;
    return `${header('结论有依据，也有边界', '允许先反馈有效问题，不要求在关键矛盾未解决时勉强给出“通过”。', false)}${notice()}${state.submission ? `<div class="notice green">${icon('message')}<div><strong>已在原型内记录：${verdictLabels[state.submission.verdict]}</strong><p>未提交到 GitHub，未保存到真实扩展；刷新或重置会清除本页演示记录。</p></div></div>` : ''}<div class="conclusion-grid"><section class="panel"><div class="panel-header"><h2>人工审查结论</h2>${badge('仅模拟提交', 'outline')}</div><div class="panel-body"><div class="verdict-options" role="radiogroup" aria-label="审查结论">${[['approve', 'shield', '批准当前范围', gate.eligible ? '条件就绪，仍需人工确认' : '存在阻断，暂不可选'], ['request-changes', 'edit', '要求修改', '指出缺陷或需求澄清项'], ['comment', 'message', '仅评论', '保留边界，先提交反馈']].map(([id, symbol, title, caption]) => `<label class="verdict-option"><input type="radio" name="verdict" value="${id}" ${state.verdict === id ? 'checked' : ''} ${id === 'approve' && !gate.eligible ? 'disabled' : ''}>${icon(id === 'approve' && !gate.eligible ? 'lock' : symbol)}<strong>${title}</strong><small>${caption}</small></label>`).join('')}</div><div class="detail-section"><label class="field-label" for="conclusion-notes">补充审查说明</label><textarea id="conclusion-notes" class="textarea" placeholder="补充你对业务影响、风险或待确认事项的判断…">${escape(state.notes)}</textarea><p class="form-hint">输入仅保存在当前页面内存；不会上传。切换独立演示场景会重置。</p></div><div class="detail-section"><div class="panel-header" style="padding:0 0 9px;border:0"><h3>摘要预览</h3><button class="text-button" data-action="preview-summary">展开最新摘要 ${icon('arrow')}</button></div><pre class="summary-preview">${escape(summaryText())}</pre></div><label class="human-check"><input id="human-confirmation" type="checkbox" ${state.humanConfirmed ? 'checked' : ''}><span>我已核对审查范围与已知限制；理解这是原型演示，不代表模型或测试证明。</span></label><div class="submission-actions"><button class="button" data-action="export">${icon('download')}下载示例摘要</button><button id="submit-verdict" class="button primary" data-action="submit" ${submitDisabled ? 'disabled' : ''}>${icon('message')}模拟提交${verdictLabels[state.verdict]}</button></div></div></section><div class="column-stack"><section class="panel"><div class="panel-header"><h2>通过条件检查</h2>${badge(gate.eligible ? '待人工判断' : '暂不可批准', gate.eligible ? 'green' : 'amber')}</div><div class="panel-body">${checks.map(([ok, title, detail]) => `<div class="gate-item ${ok ? 'ok' : 'block'}">${icon(ok ? 'check' : 'lock')}<div><strong>${title}</strong><p>${detail}</p></div></div>`).join('')}</div><div class="panel-note">这里演示产品内提交约束，不执行 GitHub 分支保护。</div></section>${gate.critical.length ? `<section class="panel"><div class="panel-header"><h2>需要闭合的关键项</h2></div><div class="panel-body">${gate.critical.map((finding) => `<div class="source-card"><strong>${escape(finding.title)}</strong><p>${finding.type === 'requirement' ? '确认需求修订后重新审查' : '补充决定性契约依据后重审'}</p><button class="text-button" data-action="finding" data-id="${finding.id}">查看证据与解除条件 ${icon('arrow')}</button></div>`).join('')}</div></section>` : ''}</div></div>`;
  }

  function render() {
    const focused = document.activeElement;
    const focusId = focused?.id;
    const selection = focused instanceof HTMLInputElement && focused.type === 'search' ? [focused.selectionStart, focused.selectionEnd] : null;
    const count = metrics();
    navEl.innerHTML = navItems.map(([id, label, symbol]) => `<button class="nav-item" data-action="nav" data-page="${id}" ${state.page === id ? 'aria-current="page"' : ''}>${icon(symbol)}${label}${id === 'findings' ? `<span class="nav-count">${count.confirmed + count.unknown}</span>` : id === 'requirements' ? `<span class="nav-count">${state.requirements.length}</span>` : id === 'conclusion' && count.critical ? `<span class="nav-count alert">${count.critical}</span>` : ''}</button>`).join('');
    document.getElementById('breadcrumb-title').textContent = navItems.find(([id]) => id === state.page)[1];
    document.getElementById('scenario-select').value = state.scenario;
    const dark = document.documentElement.dataset.theme === 'dark';
    const themeToggle = document.getElementById('theme-toggle');
    themeToggle.innerHTML = icon(dark ? 'sun' : 'moon');
    themeToggle.setAttribute('aria-label', dark ? '切换为浅色主题' : '切换为深色主题');
    document.querySelector('[data-action="reset"]').innerHTML = icon('refresh');
    pageEl.innerHTML = ({ overview: renderOverview, requirements: renderRequirements, chains: renderChains, findings: renderFindings, conclusion: renderConclusion })[state.page]();
    if (focusId && document.getElementById(focusId)) {
      const replacement = document.getElementById(focusId);
      replacement.focus({ preventScroll: true });
      if (selection && replacement instanceof HTMLInputElement) replacement.setSelectionRange(...selection);
    }
  }

  function navigate(page) {
    state.page = page;
    render();
    window.scrollTo({ top: 0, behavior: 'instant' });
  }

  function openModal(title, body, footer = '<button class="button" data-action="close-modal">关闭</button>') {
    if (modal.open) modal.close();
    modal.innerHTML = `<div class="modal-heading"><h2 id="modal-title">${title}</h2><button class="icon-button" data-action="close-modal" aria-label="关闭对话框">${icon('close')}</button></div>${body}<div class="modal-footer">${footer}</div>`;
    modal.showModal();
  }

  function helpModal() {
    openModal('这是页面原型，不是真实审查器', `<div class="modal-body"><p>五个视图展示 Review vNext 的信息架构与关键状态。所有业务、路径与裁决均为虚构，不读取真实仓库、不调用模型、不写入 GitHub，也不在本地持久化输入。</p><ol class="modal-list"><li>右上角可切换互相独立的演示场景，切换会重置操作，不是绕过当前审查门禁。</li><li>在需求基线中修订条目，观察旧结果失效。</li><li>记录评论不会解除关键阻断。需求修订和补充契约均需重审。</li><li>选择“问题已处理”场景，体验人工确认后批准。</li><li>主题可切换；摘要可下载，内容同样带原型标识。</li></ol><p class="form-hint">中文优先的独立设计稿；正式扩展实现仍需遵循双语与真实模型/状态持久化约定。</p></div>`);
  }

  function editRequirementModal(id) {
    const requirement = state.requirements.find((item) => item.id === id);
    if (!requirement) return showToast('当前场景没有对应需求。', true);
    openModal(`修订需求 · ${id}`, `<form id="requirement-form"><div class="modal-body"><label class="field-label" for="requirement-text">需求原文 / 人工修订</label><textarea required id="requirement-text" class="textarea" rows="5">${escape(requirement.text)}</textarea><input type="hidden" name="requirement-id" value="${id}"><input type="hidden" id="revision-preset" value="false"><p class="form-hint">保存后，需求基线变为待确认，相关审查结果失效。原型不理解自定义文本，也不会把它伪装成已分析。</p>${id === 'RQ-02' ? '<div class="section-gap"><button type="button" class="button small" data-action="apply-revision-preset">填入“超时保持未知”的示例修订</button><p class="form-hint">该按钮进入预设的可闭合演示分支；仍需确认基线并重审。</p></div>' : ''}</div></form>`, '<button class="button" data-action="close-modal">取消</button><button class="button primary" form="requirement-form" type="submit">保存修订，标记待重审</button>');
  }

  function noteModal(kind, id) {
    const titles = { comment: '记录审查评论', fix: '人工标记已修复', feedback: '补充业务取舍的适用边界' };
    const hints = { comment: '仅模拟记录，不提交 GitHub。评论不会解除关键需求矛盾或未决前提。', fix: '这是人工声明，不修改源码、不执行测试，不代表执行验证通过。', feedback: '只作为本次上下文，不自动成为整个仓库的永久免责规则。' };
    openModal(`${titles[kind]} · ${id}`, `<form id="note-form"><div class="modal-body"><input type="hidden" name="note-kind" value="${kind}"><input type="hidden" name="finding-id" value="${id}"><label class="field-label" for="action-note">${kind === 'fix' ? '修复说明' : '补充说明'}</label><textarea required id="action-note" class="textarea" rows="4" placeholder="请说明依据、适用条件或需要确认的内容…"></textarea><p class="form-hint">${hints[kind]}</p></div></form>`, '<button class="button" data-action="close-modal">取消</button><button class="button primary" form="note-form" type="submit">记录到当前原型</button>');
  }

  async function startRun() {
    if (state.runStatus === 'running') return;
    if (state.mode === 'requirements' && !state.baselineConfirmed) {
      navigate('requirements');
      showToast('请先人工确认需求基线。确认需求不等于其前提已被证明。', true);
      return;
    }
    const generation = ++runGeneration;
    state.runStatus = 'running';
    state.completedStages = 0;
    invalidateConclusion(state);
    render();
    for (let stage = 0; stage < stageLabels.length; stage += 1) {
      await new Promise((resolve) => setTimeout(resolve, 450));
      if (generation !== runGeneration) return;
      state.completedStages = stage + 1;
      render();
    }
    finishRun(state);
    render();
    showToast('预设审查流程已播放完成。没有调用模型、分析输入或执行测试。');
  }

  function downloadSummary() {
    const blob = new Blob([summaryText()], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `review-vnext-${state.scenario}-demo.md`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast('已发起示例摘要下载。若内置浏览器未保存，可展开摘要预览复制；没有发送到任何服务。');
  }

  document.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target.closest('[data-action]') : null;
    if (!target || target.disabled) return;
    const action = target.dataset.action;
    if (action === 'close-modal') return modal.close();
    if (action === 'nav') return navigate(target.dataset.page);
    if (action === 'help') return helpModal();
    if (action === 'theme') {
      document.documentElement.dataset.theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      return render();
    }
    if (action === 'reset' || action === 'scenario-fresh') {
      runGeneration += 1;
      state = createState(action === 'scenario-fresh' ? 'fresh' : state.scenario);
      navigate(state.page);
      return showToast('已重置到独立演示快照，未改变任何真实审查。');
    }
    if (action === 'run') return void startRun();
    if (action === 'cancel-run') {
      runGeneration += 1;
      state.runStatus = 'cancelled';
      invalidateConclusion(state);
      render();
      return showToast('模拟执行已取消；迟到阶段不会覆盖当前状态。');
    }
    if (action === 'export') return downloadSummary();
    if (action === 'finding' || action === 'select-finding') {
      state.selectedFinding = target.dataset.id;
      if (action === 'finding') { state.filter = 'all'; state.search = ''; state.detailTab = 'impact'; }
      return action === 'finding' ? navigate('findings') : render();
    }
    if (action === 'filter') { state.filter = target.dataset.filter; return render(); }
    if (action === 'detail-tab') { state.detailTab = target.dataset.tab; return render(); }
    if (action === 'chain') { state.chain = target.dataset.chain; state.selectedNode = 1; return render(); }
    if (action === 'flow-node') { state.selectedNode = Number(target.dataset.node); return state.page === 'chains' ? render() : navigate('chains'); }
    if (action === 'show-dismissed') { state.filter = 'dismissed'; state.search = ''; state.selectedFinding = 'F-04'; state.detailTab = 'evidence'; return navigate('findings'); }
    if (action === 'preview-summary') return openModal('审查摘要 · 原型模拟', `<div class="modal-body"><pre class="summary-preview" style="max-height:60vh">${escape(summaryText())}</pre><p class="form-hint">内置浏览器可能接管下载；也可使用下方“复制用文本”手动复制。</p></div>`, '<button class="button" data-action="close-modal">关闭</button><button class="button" data-action="copy-text">复制用文本</button><button class="button primary" data-action="export">下载摘要</button>');
    if (action === 'copy-text') {
      openModal('摘要纯文本 · 手动复制', `<div class="modal-body"><label class="field-label" for="copy-summary">已选中全文，可按 Ctrl+C / ⌘C 复制</label><textarea id="copy-summary" class="textarea" rows="15" readonly>${escape(summaryText())}</textarea><p class="form-hint">不请求剪贴板权限，不自动修改系统剪贴板。下载不可用时也能取得完整摘要。</p></div>`);
      const text = document.getElementById('copy-summary');
      text.focus();
      text.select();
      return;
    }
    if (state.runStatus === 'running') return showToast('请等待或取消模拟审查后，再修改依据或处置。', true);
    if (action === 'confirm-baseline') { confirmBaseline(state); render(); return showToast('需求基线已确认。请重新审查，旧结果不会自动恢复有效。'); }
    if (action === 'edit-requirement') return editRequirementModal(target.dataset.id);
    if (action === 'apply-revision-preset') {
      document.getElementById('requirement-text').value = revisedRequirement;
      document.getElementById('revision-preset').value = 'true';
      return;
    }
    if (action === 'comment' || action === 'fix' || action === 'feedback') return noteModal(action, target.dataset.id);
    if (action === 'include-assumption') {
      state.assumptionIncluded = true;
      state.baselineConfirmed = false;
      state.baselineDirty = true;
      state.stale = state.hasResults;
      invalidateConclusion(state);
      state.history.push('纳入一个待验证假设；没有将其标为已证实事实。');
      render();
      return showToast('已作为待验证假设保留。确认基线后仍需核实，不会自动成为事实。');
    }
    if (action === 'source') {
      const source = state.sources[Number(target.dataset.index)];
      return openModal(`${escape(source.name)} · 示例原文`, `<div class="modal-body"><pre class="summary-preview">${escape(source.text)}</pre><p class="form-hint">这是内置的虚构材料，不是本地文件内容。</p></div>`);
    }
    if (action === 'add-source') return openModal('补充本次上下文', `<form id="source-form"><div class="modal-body"><label class="field-label" for="source-name">材料名称</label><input required id="source-name" class="text-field" placeholder="例如：人工确认的业务边界"><label class="field-label" for="source-text">材料内容</label><textarea required id="source-text" class="textarea" rows="5" placeholder="仅保存在当前页面，不会自动生成或确认需求…"></textarea><p class="form-hint">原型不自动提取输入语义。补充材料会使相关结果待重审。</p></div></form>`, '<button class="button" data-action="close-modal">取消</button><button class="button primary" form="source-form" type="submit">添加到示例上下文</button>');
    if (action === 'evidence') return openModal('补充决定性契约依据', `<form id="evidence-form"><div class="modal-body"><div class="notice blue slim">${icon('info')}<div><strong>使用预设证据分支，不进行真实契约验证</strong><p>示例证据：同一支付事件的所有重投使用稳定 event.id，且数据库对其具有唯一约束。</p></div></div><label class="field-label" for="evidence-note">证据的来源、适用范围与说明</label><textarea required id="evidence-note" class="textarea" rows="4">演示契约 v2 第 4 条：重投保持 event.id 稳定；示例账本具有 event.id 唯一约束。仅适用于当前预设案例。</textarea><p class="form-hint">添加后仍需重审，不能只按“已评论”解除关键前提。</p></div></form>`, '<button class="button" data-action="close-modal">取消</button><button class="button primary" form="evidence-form" type="submit">补充示例证据，等待重审</button>');
    if (action === 'file-evidence') {
      const [path, kind, role] = filesSeed[Number(target.dataset.index)];
      return openModal('范围项 · 虚构文件', `<div class="modal-body"><dl class="key-value"><div><dt>位置</dt><dd><code>${path}</code></dd></div><div><dt>角色</dt><dd>${kind} · ${role}</dd></div><div><dt>使用边界</dt><dd>该文件名只用于原型，不能跳转到真实仓库。</dd></div></dl></div>`, '<button class="button" data-action="close-modal">关闭</button><button class="button primary" data-action="recheck-file">模拟重审文件及相关链路</button>');
    }
    if (action === 'recheck-file') { modal.close(); showToast('将模拟重审关联业务链，而不是仅重新检查该文件。'); return void startRun(); }
    if (action === 'submit') {
      const gate = approvalGate(state);
      if (state.verdict === 'approve' && (!gate.eligible || !state.humanConfirmed)) return showToast('通过条件尚未满足，不能绕过关键阻断或人工确认。', true);
      if (state.verdict !== 'approve' && !gate.feedbackAllowed) return showToast('当前没有可提交的有效结果。', true);
      return openModal(`模拟提交 · ${verdictLabels[state.verdict]}`, `<div class="modal-body"><p>将只在当前原型页面记录该选择。不会调用 GitHub，不会修改源码，也不会保存到真实扩展。</p><p class="form-hint">${state.mode === 'technical' ? '结论将保留“需求一致性未评审”的限制。' : '关键未决项不会因提交评论或要求修改而自动解决。'}</p></div>`, '<button class="button" data-action="close-modal">返回检查</button><button class="button primary" data-action="confirm-submit">确认模拟记录</button>');
    }
    if (action === 'confirm-submit') {
      submitVerdict(state, state.verdict);
      modal.close();
      render();
      return showToast(`已在当前原型记录“${verdictLabels[state.verdict]}”。没有写回 GitHub。`);
    }
  });

  document.addEventListener('submit', (event) => {
    if (!(event.target instanceof HTMLFormElement)) return;
    event.preventDefault();
    const form = event.target;
    if (!form.reportValidity()) return;
    if (state.runStatus === 'running') return showToast('请先结束模拟审查再修改上下文。', true);
    if (form.id === 'requirement-form') {
      if (!document.getElementById('requirement-text').value.trim()) return showToast('需求内容不能为空。', true);
      reviseRequirement(state, form.elements.namedItem('requirement-id').value, document.getElementById('requirement-text').value, document.getElementById('revision-preset').value === 'true');
      showToast('需求已修订，旧结果已失效。请确认基线并重新审查。');
    } else if (form.id === 'note-form') {
      const kind = form.elements.namedItem('note-kind').value;
      const id = form.elements.namedItem('finding-id').value;
      const note = document.getElementById('action-note').value;
      if (!note.trim()) return showToast('请填写有效的补充说明。', true);
      if (kind === 'comment') recordComment(state, id, note);
      else if (kind === 'fix') markFixed(state, id, note);
      else {
        if (!note.trim()) return showToast('请填写适用范围与依据。', true);
        state.history.push(`${id} 补充本次边界：${note.trim()}。不自动推广至整个仓库。`);
      }
      showToast(kind === 'comment' ? '评论已记录。关键阻断不会因此解除。' : kind === 'fix' ? '已人工标记修复，未运行测试验证。' : '已补充本次适用边界，没有形成全局免责规则。');
    } else if (form.id === 'evidence-form') {
      if (!document.getElementById('evidence-note').value.trim()) return showToast('请填写证据说明。', true);
      attachEvidence(state, document.getElementById('evidence-note').value);
      showToast('示例契约已补充；关键裁决需重新审查后更新。');
    } else if (form.id === 'source-form') {
      const name = document.getElementById('source-name').value.trim();
      const text = document.getElementById('source-text').value.trim();
      if (!name || !text) return showToast('名称和内容不能为空。', true);
      state.sources.push({ name, text, kind: '本次手工补充 · 仅页面内存' });
      state.stale = state.hasResults;
      invalidateConclusion(state);
      if (state.mode === 'requirements') { state.baselineConfirmed = false; state.baselineDirty = true; }
      state.history.push('补充材料已加入，未自动生成或确认需求。');
      showToast('材料已添加，未自动提取或上传。相关结果待重审。');
    } else return;
    modal.close();
    render();
  });

  document.addEventListener('input', (event) => {
    if (event.target.id === 'finding-search') { state.search = event.target.value; render(); }
    if (event.target.id === 'conclusion-notes') {
      state.notes = event.target.value;
      const preview = pageEl.querySelector('.summary-preview');
      if (preview) preview.textContent = summaryText();
    }
  });

  document.addEventListener('change', (event) => {
    if (event.target.id === 'scenario-select') {
      runGeneration += 1;
      if (modal.open) modal.close();
      state = createState(event.target.value);
      navigate('overview');
      showToast('已切换到独立预设场景。不是清除上一场景的关键阻断。');
    } else if (event.target.name === 'verdict') {
      if (event.target.value === 'approve' && !approvalGate(state).eligible) {
        showToast('关键阻断尚未解决，不能选择通过。', true);
        return render();
      }
      state.verdict = event.target.value;
      render();
    } else if (event.target.id === 'human-confirmation') {
      state.humanConfirmed = event.target.checked;
      render();
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && modal.open) {
      event.preventDefault();
      modal.close();
    }
  });

  window.addEventListener('error', (event) => { showToast(`原型脚本发生错误：${event.message}`, true); });
  window.addEventListener('unhandledrejection', (event) => { showToast(`原型操作失败：${String(event.reason)}`, true); });
  render();
}());
