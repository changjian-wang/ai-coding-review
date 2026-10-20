(function () {
  'use strict';

  const demo = typeof module !== 'undefined' && module.exports ? require('./app.js') : window.ReviewDemoModel;
  const sources = typeof module !== 'undefined' && module.exports ? require('./sources.js') : window.ReviewSourceModel;
  if (!demo) throw new Error('审查中心的示例状态模块未加载');
  if (!sources) throw new Error('需求来源模块未加载');

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
  const checkLabels = { supported: ['有证据支持', 'green'], violated: ['实现未满足', 'red'], conflict: ['需求前提冲突', 'amber'], unknown: ['证据不足', 'blue'] };

  function currentFinding(state) {
    return state.findings.find((finding) => finding.id === state.selectedFinding);
  }

  function currentChain(state) {
    return chains.find((chain) => chain.findings.includes(state.selectedFinding)) || chains[0];
  }

  function createCenterState(scenario = 'standard') {
    const state = demo.createState(scenario);
    state.selectedFinding = 'F-02';
    state.center = {
      stage: scenario === 'fresh' ? 'prepare' : scenario === 'ready' ? 'conclusion' : 'review',
      navigator: 'business', search: '', inspector: 'judgment', file: 'restore', codeView: 'diff',
      related: true, focus: false, patches: {}, fixSnapshots: {}, stageIndex: 0,
      findingMode: state.mode,
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
  }

  function switchMode(state, mode) {
    if (!['requirements', 'technical'].includes(mode)) throw new Error('未知审查模式');
    if (mode === 'requirements' && !state.requirements.length && !sources.selectedSources(state).some((source) => source.purpose === 'requirement')) throw new Error('没有需求材料，请先选择或补充候选需求来源');
    if (state.mode === mode) return;
    if (!state.hasResults) {
      state.findings = demo.createState(mode === 'technical' ? 'technical' : 'standard').findings;
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
    if (state.center.findingMode !== state.mode || sources.selectedSources(state).some((source) => source.kind === 'manual' || source.version !== source.templateVersion)) state.sourceReview.limited = true;
    if (state.sourceReview.limited) {
      state.runStatus = 'partial';
      state.history.push('来源基线已更新：本原型不分析自定义材料或新增、编辑、排除条目的语义。已有发现保留作对照，不能称为按新基线完成真实评审。');
    }
  }

  function approvalGate(state) {
    const gate = demo.approvalGate(state);
    const sourceCheck = sources.sourceGate(state);
    return {
      ...gate, eligible: gate.eligible && sourceCheck.reasons.length === 0,
      reasons: [...gate.reasons, ...sourceCheck.reasons],
      critical: [...gate.critical, ...sourceCheck.conflicts],
    };
  }

  function confirmBaseline(state) {
    if (state.sourceReview.draft) return sources.confirm(state);
    if (state.sourceReview.organizedRevision !== state.sourceReview.revision) throw new Error('来源尚未整理，请先整理候选');
    if (!state.sourceReview.acknowledged) throw new Error('请先核对原文、适用范围与冲突');
    demo.confirmBaseline(state);
    state.sourceReview.conflicts = sources.draftConflicts(state.requirements);
    state.sourceReview.limited = state.requirements.some((item) => !state.sourceReview.knownTexts[item.id]?.includes(item.text)) || state.center.findingMode !== state.mode;
  }

  function submitVerdict(state, verdict) {
    if (verdict === 'approve' && !approvalGate(state).eligible) throw new Error('存在来源、语义评审或关键问题限制，不能通过');
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
    const technical = state.scenario === 'technical';
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
    const sourceSummary = (sources.selectedSources(state).map((source) => `- [${sources.kindLabels[source.kind]} / ${sources.purposeLabels[source.purpose]}] ${source.location} · 原文 v${source.version}`).join('\n') || '未提供需求来源。') + (state.sourceReview.excluded.length ? `\n排除记录：\n${state.sourceReview.excluded.map((item) => `- ${item.id}：${item.reason}`).join('\n')}` : '');
    const origins = state.requirements.map((item) => `- ${item.id}${state.baselineConfirmed && state.mode === 'requirements' ? '' : '（非本次已确认需求）'}：${item.origins?.map((origin) => `${sources.labelOrigin(state, origin)} [${sources.originStatus(state, origin)}]`).join('；') || '缺少原文引用'}${item.manualRevision ? '；人工修订与原文分别保存' : ''}`).join('\n');
    return `Review vNext · 审查中心原型 · ${verdictLabels[verdict]}\n\n所有文件、业务与裁决均为预设示例；未连接模型、真实仓库或 GitHub。\n范围：5 个入口文件及按需关联证据。\n需求：${state.mode === 'technical' ? '有限技术审查，需求一致性未评审；不代表业务需求已满足。' : `基线 v${state.baselineVersion}，${state.baselineConfirmed ? '已人工确认' : '待确认'}。确认需求不等于其假设已经证实。`}\n执行：${runLabels[state.runStatus]}${state.stale ? '；依据已变化，旧结果待重审。' : '。'}\n\n本次材料：\n${sourceSummary}\n\n需求出处：\n${origins || '无已确认需求。'}\n\n${gate.reasons.length ? `通过限制：\n${gate.reasons.map((reason) => `- ${reason}`).join('\n')}` : `未发现当前演示规则下的批准阻断；${state.humanConfirmed ? '人工已确认边界。' : '仍需人工确认。'}`}\n\n审查发现：\n${state.hasResults ? state.findings.map((finding) => `- ${finding.id} [${typeLabels[finding.type]} / ${finding.resolved ? '示例已处理或排除' : finding.status === 'unresolved' ? '待核实' : '已确认'}] ${finding.title}`).join('\n') : '尚无有效结果，空列表不代表没有问题。'}\n\n验证边界：没有执行测试、实际复现或修改真实代码；应用预设补丁不等于运行验证通过。${state.sourceReview.limited ? '新增或排除需求尚未语义评审；旧示例发现不能被称为新基线的验证结果。' : ''}\n${state.notes.trim() ? `\n人工补充：\n${state.notes.trim()}` : ''}`;
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { createCenterState, currentFinding, currentChain, switchMode, selectFinding, completeReview, applySampleFix, undoSampleFix, sourceFiles, summaryText, approvalGate, confirmBaseline, submitVerdict };
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
  const main = document.getElementById('review-main');
  const navigator = document.getElementById('review-navigator');
  const inspector = document.getElementById('review-inspector');
  const modal = document.getElementById('center-modal');
  const toast = document.getElementById('center-toast');
  const runStages = ['建立相关业务链', '检查需求与实现', '寻找反证与保障', '形成有边界的结论'];
  let state = createCenterState();
  let runGeneration = 0;
  let toastTimer;

  function notify(message, warning = false) {
    clearTimeout(toastTimer);
    toast.textContent = message;
    toast.className = `toast${warning ? ' warning' : ''}`;
    toast.hidden = false;
    toastTimer = setTimeout(() => { toast.hidden = true; }, 6000);
  }

  function statusLabel(finding) {
    if (finding.status === 'dismissed') return ['已排除', 'green'];
    if (finding.resolved) return ['示例已处理', 'green'];
    if (finding.status === 'unresolved') return ['尚未确认', 'amber'];
    return ['已确认', 'red'];
  }

  function findingBadges(finding) {
    const [label, tone] = statusLabel(finding);
    return `<span class="mono">${finding.id}</span>${badge(typeLabels[finding.type], finding.type === 'reasonable' ? 'green' : finding.type === 'question' ? 'amber' : 'red')}${badge(label, tone, true)}${!finding.resolved && finding.critical ? badge('关键', 'amber') : ''}`;
  }

  function getFindings() {
    return state.hasResults ? state.findings : [];
  }

  function issueNav(finding) {
    return `<button class="issue-nav ${finding.id === state.selectedFinding ? 'active' : ''}" data-action="finding" data-id="${finding.id}" aria-pressed="${finding.id === state.selectedFinding}"><span class="issue-dot ${finding.resolved ? 'green' : finding.type === 'question' ? 'amber' : ''}"></span><span><strong>${escape(finding.title)}</strong><small>${finding.id} · ${typeLabels[finding.type]}${finding.resolved ? ' · 已处理/排除' : finding.critical ? ' · 关键' : ''}</small></span></button>`;
  }

  function renderNavigator() {
    const activeChain = currentChain(state);
    const search = state.center.search.toLowerCase();
    const findings = getFindings().filter((finding) => `${finding.title} ${finding.source} ${finding.id}`.toLowerCase().includes(search));
    const sources = sourceFiles(state);
    let content;
    if (state.center.navigator === 'files') {
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
        return `<button class="chain-card ${activeChain.id === chain.id ? 'active' : ''}" data-action="finding" data-id="${defaultFinding}" aria-pressed="${activeChain.id === chain.id}"><div class="chain-card-top">${icon('flow')}<span>${chain.title}</span>${badge(state.hasResults ? `${unresolved || members.length}` : '—', unresolved ? 'amber' : 'green')}</div><p>${chain.description}</p></button>${activeChain.id === chain.id && state.hasResults ? `<div class="chain-members">${members.map(issueNav).join('')}</div>` : ''}`;
      }).join('')}<div class="mini-principle"><strong>精准，不等于只报小问题。</strong><br>同一份业务依据，同时支持缺陷发现和局部误报的推翻。</div>`;
    }
    return `<div class="navigator-heading"><span>审查导航</span><span class="muted">工作区</span></div><div class="nav-segments" role="tablist" aria-label="导航方式">${[['business', '业务', 'flow'], ['findings', '发现', 'bug'], ['files', '文件', 'file']].map(([id, label, symbol]) => `<button class="nav-segment ${state.center.navigator === id ? 'active' : ''}" role="tab" aria-selected="${state.center.navigator === id}" data-action="navigator" data-tab="${id}">${icon(symbol)}${label}</button>`).join('')}</div><div class="navigator-search">${icon('search')}<input id="center-search" type="search" placeholder="搜索业务、问题或文件" aria-label="搜索导航内容" value="${escape(state.center.search)}"></div><div class="navigator-scroll ${state.center.navigator === 'business' ? 'business-nav' : ''}">${content}</div><div class="navigator-footer"><button class="baseline-link" data-action="stage" data-stage="prepare">${icon('file')}<div><strong>${state.mode === 'technical' ? '有限技术审查' : `需求基线 v${state.baselineVersion}`}</strong><small>${state.mode === 'technical' ? '需求一致性未评审' : `${state.requirements.length} 条需求 · ${state.baselineConfirmed ? '已确认' : '待人工确认'}`}</small></div>${icon('chevron')}</button><button class="scope-link" data-action="scope"><span>范围：当前分支的 5 个入口文件</span><span>查看</span></button></div>`;
  }

  function renderTop() {
    const gate = approvalGate(state);
    document.getElementById('stage-navigation').innerHTML = stages.map(([id, label], index) => `${index ? '<span class="stage-divider" aria-hidden="true"></span>' : ''}<button class="stage-button ${state.center.stage === id ? 'active' : ''}" data-action="stage" data-stage="${id}" ${state.center.stage === id ? 'aria-current="step"' : ''}><span class="stage-index">${index === 0 && state.baselineConfirmed ? icon('check') : index + 1}</span>${label}</button>`).join('');
    document.getElementById('product-mark').innerHTML = icon('shield');
    document.querySelector('.command-actions [data-action="help"]').innerHTML = icon('info');
    const dark = document.documentElement.dataset.theme === 'dark';
    document.getElementById('center-theme').innerHTML = icon(dark ? 'sun' : 'moon');
    document.getElementById('center-theme').setAttribute('aria-label', `切换为${dark ? '浅色' : '深色'}主题`);
    document.getElementById('center-reset').innerHTML = icon('refresh');
    document.getElementById('demo-scenario').value = state.scenario;
    const running = state.runStatus === 'running';
    const run = document.getElementById('run-review');
    run.disabled = running;
    run.innerHTML = `${icon(running ? 'refresh' : 'play', running ? 'spin' : '')}${running ? '模拟审查中' : state.stale ? '重审受影响链路' : ['partial', 'cancelled'].includes(state.runStatus) ? '继续审查' : state.runStatus === 'idle' ? '一键审查' : '重新审查'}`;
    document.getElementById('context-bar').innerHTML = `<div class="context-left"><span class="branch-detail">${icon('branch')}feat/payment-timeout</span><span class="scope-detail">${icon('file')}5 个入口 · 按需关联上下文</span>${badge(state.mode === 'technical' ? '需求未评审' : `需求 v${state.baselineVersion} · ${state.baselineConfirmed ? '已确认' : '待确认'}`, state.mode === 'technical' || !state.baselineConfirmed ? 'blue' : 'green')}${state.stale ? badge('依据已变 · 待重审', 'amber') : ''}</div><div class="context-right"><span>${icon('check')}${runLabels[state.runStatus]}</span><button class="text-button" data-action="stage" data-stage="conclusion">${icon(gate.eligible ? 'shield' : 'lock')}${gate.eligible ? '待人工结论' : gate.critical.length ? `${gate.critical.length} 项关键阻断` : '查看结论边界'} ${icon('arrow')}</button></div>`;
    document.getElementById('center-status').innerHTML = `<div class="status-left"><span>${icon('shield')}本地原型 · 不修改真实文件</span><span>${state.mode === 'technical' ? '需求一致性未评审' : '需求与实现双向校验'}</span></div><div class="status-right"><span>逻辑推演示例 · 未执行测试</span><span>模型未连接</span><button class="text-button" data-action="help">使用说明</button></div>`;
    document.querySelector('.review-shell').classList.toggle('focus-layout', state.center.focus);
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
    const primary = primaryFiles[state.selectedFinding];
    const keys = [...new Set([primary, ...chain.files, state.center.file])].filter((key) => files[key]);
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
    const tone = finding.resolved ? 'green' : finding.type === 'question' ? 'amber' : '';
    const label = finding.type === 'reasonable' ? '局部疑点已被全局证据推翻' : finding.resolved ? '当前示例已处置 · 未执行测试' : finding.type === 'question' ? '必要前提未证实，不是确认缺陷' : '这个位置，需要放到整条链路中判断';
    return `<div class="inline-finding ${tone}"><div class="inline-finding-head">${icon(finding.resolved ? 'shield' : finding.type === 'question' ? 'info' : 'bug')}<span>${finding.id} · ${label}</span></div><strong>${escape(finding.title)}</strong><p>${escape(finding.summary)}</p><div class="inline-finding-footer"><span>定位是入口，判断依赖完整上下文</span><button class="text-button" data-action="inspector-tab" data-tab="evidence">${icon('link')}对照证据与反证</button></div></div>`;
  }

  function relatedContext(files) {
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
    const files = sourceFiles(state);
    const file = files[state.center.file];
    if (!file) throw new Error('找不到当前示例文件');
    const finding = currentFinding(state);
    const source = state.center.codeView === 'source';
    let body;
    if (file.kind === 'document') {
      body = `<article class="document-copy"><p class="doc-kicker">${escape(file.sourceInfo || '需求 / 契约证据')} · 虚构原文，空行隐藏 · 非实际本地文件</p><h2>${escape(file.title)}</h2>${file.paragraphs.map(([line, text]) => `<div class="doc-paragraph ${line === file.highlight ? 'highlighted' : ''}"><span class="mono">L${line}</span><p>${escape(text)}</p></div>`).join('')}<div class="inline-notice blue">${icon('info')}<div><strong>阅读原文不会改写需求，也不会切换当前问题</strong><p>右侧仍保留 ${finding.id} 的判断上下文。当前条目可能经过人工修订，不能把其表述当作这里的原文。</p></div></div></article>`;
    } else {
      const primary = primaryFiles[state.selectedFinding] === file.key;
      const lines = file.lines.map((line, index) => `<div class="code-line ${source ? 'source-view' : ''} ${!source && line.change ? line.change : ''} ${line.highlighted ? 'emphasized' : ''}" id="sample-line-${line.number}">${source ? '' : `<span class="line-no">${line.change ? '' : line.number}</span>`}<span class="line-no">${line.number}</span><span class="change">${source ? '' : line.change === 'added' ? '+' : line.change === 'removed' ? '−' : ''}</span><code>${syntax(line.text) || ' '}</code></div>${primary && index === Math.min(file.lines.length - 1, file.lines.findIndex((item) => item.highlighted) + 2) ? inlineFinding(finding) : ''}`).join('');
      body = `<div class="code-caption"><span>旧 / 新行号 · ${source ? '当前源码' : '行内 Diff（预设差异）'}</span><strong>上下文片段 ${file.start}–${file.lines.at(-1).number} · 非完整文件</strong></div><div class="code-table">${lines}</div>${relatedContext(files)}`;
    }
    return `<h1 class="sr-only">源码与证据审查</h1>${editorTabs(files)}<div class="editor-tools"><div class="editor-breadcrumb">checkout-service <span class="muted">/</span> <strong>${escape(file.path)}</strong></div><div class="editor-view-controls">${file.kind === 'code' ? `<button class="tiny-toggle ${!source ? 'active' : ''}" data-action="code-view" data-view="diff">Diff</button><button class="tiny-toggle ${source ? 'active' : ''}" data-action="code-view" data-view="source">源码</button>` : badge('需求 / 契约原文', 'blue')}<button class="icon-button focus-button" data-action="focus" aria-label="${state.center.focus ? '恢复业务导航' : '收起导航，专注代码'}" title="收起/恢复导航">${icon('focus')}</button></div></div>${progressStrip()}${journey()}<div class="editor-scroll">${body}</div><div class="editor-bottom"><span>${state.center.patches[state.selectedFinding] ? '示例补丁已应用 · 未执行验证' : '只读示例 · 不接触真实仓库'}</span><button class="text-button" data-action="related">${state.center.related ? '收起' : '展开'}关联上下文</button><button class="text-button" data-action="recheck">${icon('refresh')}重审关联范围</button><button class="text-button" data-action="next">${icon('arrow')}下一问题 <span class="mono">F8</span></button></div>`;
  }

  function requirementMarkup(requirement) {
    const valid = requirement.origins?.every((origin) => sources.originStatus(state, origin) === '当前版本');
    const [label, tone] = state.mode === 'technical' ? ['本次未评审', 'blue'] : !state.baselineConfirmed || !valid ? ['出处 / 基线待确认', 'amber'] : !state.hasResults || state.stale ? ['待校验', 'blue'] : checkLabels[requirement.check];
    return `<article class="requirement-item"><div class="requirement-item-head"><span class="rq-id">${requirement.id}</span><h3>${escape(requirement.title)}</h3>${badge(label, tone)}</div><p>${escape(requirement.text)}</p><div class="requirement-item-footer"><button class="text-button origin-button" data-action="trace-requirement" data-id="${requirement.id}">${icon('link')}${requirement.origins?.length || 0} 处原文 · ${valid ? '查看来源' : '出处待更新'}</button><span>${badge(requirement.manualRevision ? '人工修订' : requirement.originKind || '示例整理', requirement.manualRevision ? 'blue' : '')}<button class="text-button" data-action="edit-requirement" data-id="${requirement.id}">${icon('edit')}修订</button></span></div></article>`;
  }

  function renderSourceChoices() {
    const selected = sources.selectedSources(state);
    const flow = state.sourceReview;
    return `<section class="prepare-section source-section" id="source-section"><div class="prepare-section-title"><h2>需求从哪里来？</h2><button class="text-button" data-action="add-source">${icon('edit')}人工输入</button></div><p class="source-intro">先选择材料及用途，再整理候选。当前分支没有真实连接 PR；下方全部是可选的虚构材料，不会读取磁盘或网络。</p><div class="source-workflow"><span class="active">1 选择来源</span><span>→</span><span>2 整理候选</span><span>→</span><span>3 对照原文确认</span></div><div class="source-grid">${state.sources.map((source) => `<article class="source-choice ${source.selected ? 'selected' : ''}" data-source-card="${source.id}"><div class="source-choice-top"><label><input type="checkbox" name="selected-source" value="${source.id}" ${source.selected ? 'checked' : ''}><span>${icon(source.kind === 'pr' ? 'branch' : source.kind === 'issue' ? 'message' : 'file')}<strong>${sources.kindLabels[source.kind]}</strong></span></label>${badge(source.selected ? '已选入' : '未选入', source.selected ? 'green' : '')}</div><p class="source-choice-name">${escape(source.name)}</p><p class="source-choice-location">${escape(source.location)} · 原文 v${source.version}</p>${source.kind === 'pr' ? '<p class="source-warning">可能混有 AI 生成的改动总结，不等于原始需求。</p>' : source.kind === 'issue' ? '<p class="source-warning">此预设材料与旧文档有冲突；选入后不会自动决定谁正确。</p>' : ''}<div class="source-choice-bottom"><label><span class="sr-only">${escape(source.name)}的用途</span><select name="source-purpose" data-source-id="${source.id}" ${source.selected ? '' : 'disabled'}><option value="requirement" ${source.purpose === 'requirement' ? 'selected' : ''}>候选需求依据</option><option value="context" ${source.purpose === 'context' ? 'selected' : ''}>仅作上下文</option></select></label><button class="text-button" data-action="material" data-source-id="${source.id}">查看原文</button></div></article>`).join('')}</div><div class="source-actions"><span>${selected.length} 份选入 · ${selected.filter((source) => source.purpose === 'requirement').length} 份候选依据${flow.organizedRevision !== flow.revision ? ' · 来源已变，待整理' : ''}</span><button class="button small outline-accent" data-action="organize-sources">${icon('file')}整理候选（模拟）</button></div><p class="form-hint">“整理”只演示预设条目映射，不调用模型。仅作上下文的材料不自动生成验收要求；相同文本合并出处，不以来源数量证明正确。</p></section>`;
  }

  function conflictMarkup(conflicts) {
    return conflicts.map((conflict) => `<div class="inline-notice source-conflict">${icon('alert')}<div><strong>${conflict.id} · ${escape(conflict.title)}（预设）</strong><p>${escape(conflict.detail)}</p><p class="form-hint">${conflict.left} ↔ ${conflict.right} · 确认基线不代表冲突已解决。</p></div></div>`).join('');
  }

  function renderCandidateDraft() {
    const draft = state.sourceReview.draft;
    if (!draft) return '';
    const conflicts = sources.draftConflicts(draft.candidates.filter((item) => item.include));
    return `<section class="prepare-section" id="candidate-section"><div class="prepare-section-title"><h2>${draft.candidates.length} 条候选 · 尚未人工确认</h2>${badge('来源整理结果', 'blue')}</div>${draft.notices.map((notice) => `<div class="inline-notice blue">${icon('info')}<div><p>${escape(notice)}</p></div></div>`).join('')}${draft.removed.length ? `<div class="inline-notice">${icon('info')}<div><strong>旧基线中 ${draft.removed.join('、')} 的出处不再纳入</strong><p>旧条目留作历史，不能继续当作当前依据。已知关键问题不会因此自动消失。</p></div></div>` : ''}${conflictMarkup(conflicts)}<div class="requirement-list draft-list">${draft.candidates.map((item) => `<article class="requirement-item ${item.include ? '' : 'excluded'}" data-candidate="${item.id}"><div class="requirement-item-head"><label class="candidate-check"><input type="checkbox" name="candidate-include" value="${item.id}" ${item.include ? 'checked' : ''}><span class="rq-id">${item.id}</span></label><h3>${escape(item.title)}</h3>${badge(item.manualRevision ? '人工修订' : item.originKind, 'blue')}</div><p>${escape(item.text)}</p><div class="requirement-item-footer"><button class="text-button origin-button" data-action="trace-requirement" data-id="${item.id}">${icon('link')}核对 ${item.origins.length} 处原文及版本</button><span>${item.include ? '待纳入，不等于事实已验证' : '不纳入本次基线'}</span></div>${!item.include ? `<label class="exclusion-label">排除原因<input class="text-field" data-candidate-reason="${item.id}" aria-label="${item.id}排除原因" value="${escape(item.exclusionReason)}" placeholder="说明适用范围、重复或不属于本次目标的依据"></label>` : ''}</article>`).join('') || '<div class="candidate-empty"><strong>没有候选需求</strong><p>仅有变更上下文不会变成需求。可补充候选依据、明确人工需求，或选择有限技术审查。</p></div>'}</div></section>`;
  }

  function renderPrepare() {
    const flow = state.sourceReview;
    const canConfirm = flow.organizedRevision === flow.revision && flow.acknowledged && (flow.draft ? flow.draft.candidates.some((item) => item.include) : state.requirements.length > 0);
    const canSelectRequirements = state.requirements.length > 0 || sources.selectedSources(state).some((source) => source.purpose === 'requirement');
    return `<div class="editor-tabs"><div class="editor-tab active">${icon('file')}本次审查依据<span class="tab-kind">准备</span></div></div>${progressStrip()}<div class="prepare-scroll"><div class="stage-eyebrow">01 / PREPARE <span>来源明确，判断才有依据</span></div><h1 class="stage-title">这次的原始需求，来自哪里？</h1><p class="stage-description">PR 描述是入口之一，不是默认真相。把变更说明、需求原文与人工补充选清楚，再确认本次审查基线。</p><section class="prepare-section"><div class="prepare-section-title"><h2>审查范围</h2>${badge('本地分支示例', 'green')}</div><div class="scope-summary">${icon('branch')}<div><strong>当前分支 · feat/payment-timeout</strong><p>5 个入口文件；无须存在 PR 才能提供需求。</p></div><button class="text-button" data-action="scope">查看范围 ${icon('arrow')}</button></div></section>${renderSourceChoices()}<section class="prepare-section"><div class="prepare-section-title"><h2>本次审查方式</h2></div><div class="mode-options"><label class="mode-option"><input type="radio" name="review-mode" value="requirements" ${state.mode === 'requirements' ? 'checked' : ''} ${canSelectRequirements ? '' : 'disabled'}><strong>需求驱动审查</strong><p>以人工确认的条目检查实现，同时验证需求前提。</p></label><label class="mode-option"><input type="radio" name="review-mode" value="technical" ${state.mode === 'technical' ? 'checked' : ''}><strong>有限技术审查</strong><p>没有明确需求时，只评审可证实的技术契约。</p></label></div>${state.mode === 'technical' ? `<div class="inline-notice blue">${icon('info')}<div><strong>需求一致性未评审</strong><p>仅选择材料或切换模式，不会把已知关键矛盾静默清除。</p></div></div>` : ''}</section>${renderCandidateDraft()}${!flow.draft && state.requirements.length ? `<section class="prepare-section"><div class="prepare-section-title"><h2>${state.requirements.length} 条${state.baselineConfirmed ? '已确认需求' : '历史 / 待确认条目'}</h2>${badge(`基线 v${state.baselineVersion} · ${state.baselineConfirmed ? '已确认' : '待确认'}`, state.baselineConfirmed ? 'green' : 'amber')}</div>${conflictMarkup(flow.conflicts)}<div class="requirement-list">${state.requirements.map(requirementMarkup).join('')}</div><p class="form-hint">每条都能追溯来源、版本与引用片段。人工修订不覆盖材料原文。</p></section>` : ''}${state.mode === 'requirements' && !state.baselineConfirmed ? `<label class="human-confirm source-acknowledgment"><input id="source-acknowledgment" type="checkbox" ${flow.acknowledged ? 'checked' : ''} ${flow.organizedRevision === flow.revision ? '' : 'disabled'}><span>我已核对候选与原文、适用范围及已展示的冲突。确认只建立审查基准，不表示需求逻辑或实现已经正确。</span></label>` : ''}<div class="prepare-footer"><p>原文、输入与选择仅在页面内存中保存。</p>${state.mode === 'requirements' && !state.baselineConfirmed ? `<button class="button primary" data-action="confirm-baseline" ${canConfirm ? '' : 'disabled'}>确认当前基线，进入审查</button>` : '<button class="button primary" data-action="run">开始本次模拟审查</button>'}</div></div>`;
  }

  function renderPrepareInspector() {
    const selected = sources.selectedSources(state);
    return `<div class="inspector-heading"><span>来源与用途，不混为一谈</span>${badge(`${selected.length} 份已选材料`, 'green')}</div><div class="inspector-scroll"><div class="section-heading"><h3>${icon('file')}本次选入的材料</h3><button class="text-button" data-action="add-source">补充</button></div>${selected.map((source) => `<button class="source-pill" data-action="material" data-source-id="${source.id}">${icon(source.kind === 'pr' ? 'branch' : 'file')}<span>${escape(source.name)}<small>${sources.purposeLabels[source.purpose]} · 原文 v${source.version}</small></span>${icon('chevron')}</button>`).join('') || '<p class="small-copy">还没有选入需求材料。可以继续有限技术审查，但不能宣称需求满足。</p>'}<div class="inspector-section"><div class="section-heading"><h3>为什么不只读 PR Description？</h3></div><ul class="principle-list"><li><strong>变更摘要 ≠ 原始需求</strong><p>描述可能由实现反推。用它证明同一实现正确，会形成循环自证。</p></li><li><strong>同一份材料，可以有不同用途</strong><p>默认把 PR 描述用于理解变更；明确的目标或验收条件须显式选择为候选依据。</p></li><li><strong>来源冲突必须保留</strong><p>本地文档与 Issue 不一致时，不自动按平台、时间或数量决定谁正确。</p></li><li><strong>原文与修订各自保存</strong><p>需求被人修订后，仍能查看原始引用；来源更新后不能用新文本冒充旧版本。</p></li></ul></div><div class="inspector-section"><blockquote class="quote">材料选择 → 候选整理 → 原文核对 → 人工确认<small>示例整理不会分析自定义文本，也不会把模型推断自动确认为需求。</small></blockquote></div><p class="verification-caption">当前只有本地虚构快照。不访问 PR、Issue 或磁盘文件，不上传输入。</p></div><div class="inspector-actions"><div class="inspector-action-row"><button class="button small" data-action="organize-sources">${icon('file')}整理候选（模拟）</button></div><p>选择来源并不等于已经接受其中的所有要求。</p></div>`;
  }

  function evidenceTarget(finding, index) {
    if (finding.id === 'F-01' && finding.type === 'implementation') return index === 0 ? 'payments' : 'submit';
    const lookup = { 'F-01': ['payments', 'gateway'], 'F-02': ['cancel', 'api'], 'F-03': ['gateway'], 'F-04': ['job'], 'F-05': ['decision'] };
    return lookup[finding.id][index] || primaryFiles[finding.id];
  }

  function renderJudgment(finding) {
    const requirement = state.requirements.find((item) => item.id === finding.requirement);
    return `${state.center.patches[finding.id] ? `<div class="inline-notice blue">${icon('info')}<div><strong>示例补丁已应用，尚未执行验证</strong><p>下方保留原始发现及依据用于对照，不代表修复后仍复现同一故障。</p></div></div>` : ''}<section class="inspector-section"><div class="section-heading"><h3>${icon('file')}${requirement ? `需求依据 · ${requirement.id}` : '判断依据'}</h3>${requirement ? `<button class="text-button" data-action="source" data-source="${requirement.id === 'RQ-03' ? 'orders' : 'payments'}">对照原文</button>` : ''}</div><blockquote class="quote">${escape(requirement?.text || (state.mode === 'technical' ? '当前可证实的调用路径和返回值契约；不引用未提供的业务需求。' : '相关入口与调用关系、已确认的职责分层和适用边界。'))}<small>${requirement ? '人工确认的规范性依据；其事实前提仍接受验证' : '源码/契约是证据，不自动成为业务需求'}</small></blockquote></section><section class="inspector-section"><div class="section-heading"><h3>${icon('flow')}${state.center.patches[finding.id] ? '原始问题的行为路径' : '把行为串起来'}</h3></div><ol class="reasoning">${finding.steps.map((step) => `<li>${escape(step)}</li>`).join('')}</ol></section><section class="inspector-section"><div class="section-heading"><h3>${icon(finding.type === 'reasonable' ? 'shield' : 'alert')}${finding.type === 'reasonable' ? '为什么不需要修改' : '实际影响与判断边界'}</h3></div><div class="impact-note ${finding.type === 'reasonable' ? 'green' : ''}">${escape(finding.impact)}</div></section><section class="inspector-section"><div class="section-heading"><h3>下一步应核实什么</h3><button class="text-button" data-action="inspector-tab" data-tab="evidence">证据与反证 ${icon('arrow')}</button></div><p class="small-copy">${finding.type === 'requirement' ? '先澄清需求中的错误前提；即使需求改了，实现仍需独立核对。' : finding.type === 'question' ? '明确缺失的契约与适用范围，不把资料不足包装成确定 Bug。' : finding.type === 'reasonable' ? '保留成立条件；新增入口或职责变化时重新评估，而不是永久忽略。' : '核查相关入口有没有替代保障；确认后只修复破坏契约的根因。'}</p></section>`;
  }

  function renderEvidence(finding) {
    return `<section class="inspector-section"><div class="section-heading"><h3>${icon('link')}支持当前判断的证据</h3></div>${finding.evidence.map((item, index) => `<article class="evidence-card"><div class="evidence-card-head">${icon('file')}<span>${escape(item.title)}</span></div><p>${escape(item.text)}</p><button class="evidence-link" data-action="source" data-source="${evidenceTarget(finding, index)}">${icon('link')}${escape(item.source)}</button></article>`).join('')}</section><section class="inspector-section"><div class="section-heading"><h3>${icon('shield')}主动寻找反证</h3>${badge('不是重复论证', 'green')}</div>${finding.counter.map((item) => `<article class="evidence-card"><div class="evidence-card-head">${icon('search')}<span>${escape(item.title)}</span></div><p>${escape(item.text)}</p></article>`).join('')}</section><div class="inline-notice ${finding.type === 'reasonable' ? 'green' : 'blue'}">${icon('info')}<div><strong>${finding.type === 'reasonable' ? '候选已被推翻，不生成修复任务' : '证据不足就保留未知'}</strong><p>历史忽略、一次点赞、模型意见一致或单个测试通过，都不单独证明业务正确。</p></div></div>`;
  }

  function renderHistory(finding) {
    const history = state.history.filter((entry) => entry.includes(finding.id) || (finding.requirement && entry.includes(finding.requirement)));
    return `<section class="inspector-section"><div class="section-heading"><h3>${icon('message')}处置记录</h3></div>${history.map((entry) => `<article class="evidence-card"><p>${escape(entry)}</p></article>`).join('') || '<p class="small-copy">本次页面会话还没有相关操作。</p>'}<div class="inline-notice blue">${icon('info')}<div><strong>处置与成立性是两回事</strong><p>评论不解除关键阻断；人工接受补丁不等于测试通过；单次反馈不自动生成全局免责规则。</p></div></div></section>`;
  }

  function renderFindingInspector() {
    const finding = currentFinding(state);
    if (!state.hasResults) return `<div class="inspector-heading">等待审查</div><div class="inspector-scroll"><div class="empty-state">${icon('search')}<h2>先建立本次依据</h2><p>准备好后一次启动，不需要逐个文件点击。当前预览代码不代表已经完成审查。</p><button class="button" data-action="stage" data-stage="prepare">查看准备阶段</button></div></div>`;
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
    const boundary = state.sourceReview.limited
      ? '自定义材料以及新增、编辑或排除条目没有真实语义评审；旧示例发现仅用于对照，不能声称已按新基线完整评审。'
      : state.runStatus === 'partial' ? '通道契约读取受限，不能宣称范围完整。' : '没有连接真实仓库，也没有执行测试。';
    return `<div class="editor-tabs"><div class="editor-tab active">${icon('shield')}审查结论<span class="tab-kind">人工决定</span></div><button class="editor-tab" data-action="stage" data-stage="review">${icon('code')}返回代码现场</button></div>
      ${progressStrip()}<div class="conclusion-scroll">
      <div class="stage-eyebrow">03 / CONCLUDE <span>提交反馈，不等于宣布一切正确</span></div>
      <h1 class="stage-title">${gate.eligible ? '条件已具备，结论仍由你决定' : '先说明哪些问题尚未闭合'}</h1>
      <p class="stage-description">${state.mode === 'technical' ? '本次只批准明确的技术范围，需求一致性未评审。' : '需求、实现和必要契约分别判断，不拿动作完成代替业务正确。'}</p>
      ${conflictMarkup(state.sourceReview.conflicts)}
      ${state.submission ? `<div class="inline-notice green">${icon('check')}<div><strong>已在当前原型记录：${verdictLabels[state.submission.verdict]}</strong><p>没有写回 GitHub。新的依据或处置会使这份模拟记录失效。</p></div></div>` : ''}
      <div class="prepare-section">
        <section class="summary-box"><h2>${unresolved.length ? `${unresolved.length} 项仍需判断或处理` : '当前示例没有未处理项'}</h2>
        ${unresolved.map((finding) => `<button class="summary-row" data-action="finding" data-id="${finding.id}">${badge(finding.critical ? '关键' : '缺陷', finding.critical ? 'amber' : 'red')}<span><strong>${escape(finding.title)}</strong><p>${finding.disposition === 'commented' ? '已评论，但并未解除关键阻断。' : escape(finding.summary)}</p></span></button>`).join('') || '<p class="small-copy">这不是对代码无缺陷的保证；仍需理解范围与验证方式。</p>'}</section>
        <section class="summary-box"><h2>已排除的局部疑点</h2>${dismissed.map((finding) => `<button class="summary-row" data-action="finding" data-id="${finding.id}">${badge('合理取舍', 'green')}<span><strong>${escape(finding.title)}</strong><p>${escape(finding.summary)}</p></span></button>`).join('')}</section>
        <section class="summary-box"><div class="section-heading"><h2>来源与范围边界</h2><button class="text-button" data-action="stage" data-stage="prepare">回看来源</button></div><p class="small-copy">${state.mode === 'technical' ? '需求一致性未评审，不代表业务需求已满足。' : `需求基线 v${state.baselineVersion}，${state.baselineConfirmed ? '人工已确认' : '仍待确认'}。已确认条目不等于所有假设已证实。`}<br>5 个入口文件，相关证据按需纳入。${boundary}</p><div class="conclusion-sources">${sources.selectedSources(state).map((source) => `<button class="text-button origin-button" data-action="material" data-source-id="${source.id}">${icon('link')}${escape(source.name)} · ${sources.purposeLabels[source.purpose]} · v${source.version}</button>`).join('') || '<p class="form-hint">没有选入需求材料。</p>'}</div></section>
      </div>
      <section class="prepare-section"><label class="field-label" for="center-notes">人工补充</label><textarea class="textarea" id="center-notes" placeholder="补充业务判断、风险或需要协调的事项…">${escape(state.notes)}</textarea><p class="form-hint">仅保存在本次页面内存；切换独立场景或刷新会清除。</p></section>
      <section class="prepare-section"><div class="prepare-section-title"><h2>对外摘要预览</h2><button class="text-button" data-action="summary">${icon('download')}查看 / 复制 / 下载</button></div><pre class="summary-text" id="center-summary">${escape(summaryText(state))}</pre></section>
      </div>`;
  }

  function renderConclusionInspector() {
    const gate = approvalGate(state);
    const canSubmit = state.verdict === 'approve' ? gate.eligible && state.humanConfirmed : gate.feedbackAllowed;
    return `<div class="inspector-heading"><span>通过条件与提交</span>${badge(gate.eligible ? '待人工判断' : '不可直接通过', gate.eligible ? 'green' : 'amber')}</div><div class="inspector-scroll">${gateChecks().map(([ok, title, detail]) => `<div class="gate-row ${ok ? 'ok' : ''}">${icon(ok ? 'check' : 'lock')}<div><strong>${title}</strong><p>${detail}</p></div></div>`).join('')}<div class="verdict-options" role="radiogroup" aria-label="选择审查结论">${[['approve', '通过当前范围', '需要条件满足并人工确认'], ['request-changes', '要求修改', '关键项未闭合也可以反馈'], ['comment', '仅评论', '保留未知，不代表通过']].map(([id, title, note]) => `<label class="verdict-option"><input type="radio" name="center-verdict" value="${id}" ${state.verdict === id ? 'checked' : ''} ${id === 'approve' && !gate.eligible ? 'disabled' : ''}><span><strong>${title}</strong><small>${note}</small></span></label>`).join('')}</div><label class="human-confirm"><input type="checkbox" id="center-human" ${state.humanConfirmed ? 'checked' : ''}><span>我已核对本次边界，理解原型未执行真实分析或测试。</span></label><p class="verification-caption">门禁只演示产品内提交约束，不设置 GitHub 分支保护，不保证所有缺陷均被发现。</p></div><div class="inspector-actions"><div class="inspector-action-row"><button class="button primary" id="center-submit" data-action="submit" ${canSubmit ? '' : 'disabled'}>${icon('message')}模拟提交${verdictLabels[state.verdict]}</button><button class="button small" data-action="summary">${icon('download')}摘要</button></div><p>不发送到任何外部服务，不持久化真实结论。</p></div>`;
  }

  function render(preserve = true) {
    const focused = document.activeElement;
    const focusId = focused?.id;
    const selection = focused instanceof HTMLInputElement && focused.type === 'search' ? [focused.selectionStart, focused.selectionEnd] : null;
    const positions = preserve ? Object.fromEntries(['.editor-scroll', '.inspector-scroll', '.navigator-scroll', '.prepare-scroll', '.conclusion-scroll'].map((selector) => [selector, document.querySelector(selector)?.scrollTop || 0])) : {};
    renderTop();
    navigator.innerHTML = renderNavigator();
    main.innerHTML = state.center.stage === 'prepare' ? renderPrepare() : state.center.stage === 'conclusion' ? renderConclusion() : renderEditor();
    inspector.innerHTML = state.center.stage === 'prepare' ? renderPrepareInspector() : state.center.stage === 'conclusion' ? renderConclusionInspector() : renderFindingInspector();
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
    render();
    const scroll = main.querySelector('.editor-scroll');
    if (scroll) scroll.scrollTop = 0;
  }

  function nextFinding() {
    const findings = getFindings();
    if (!findings.length) return notify('请先完成模拟审查。', true);
    const index = findings.findIndex((finding) => finding.id === state.selectedFinding);
    selectFinding(state, findings[(index + 1) % findings.length].id);
    render(false);
  }

  function openModal(title, body, footer = '<button class="button" data-action="close">关闭</button>') {
    if (modal.open) modal.close();
    modal.innerHTML = `<div class="modal-header"><h2 id="center-modal-title">${title}</h2><button class="icon-button" data-action="close" aria-label="关闭对话框">${icon('close')}</button></div>${body}<div class="modal-footer">${footer}</div>`;
    modal.showModal();
  }

  function help() {
    openModal('源码主场，而不是五页看板', `<div class="modal-body"><p>三个阶段：准备、审查、结论。审查阶段一直保留业务导航、代码阅读和判断上下文。</p><ul class="principle-list"><li><strong>合理取舍</strong><p>选择“重试与展示边界”，对照服务与调度层，查看局部疑点为何被推翻。</p></li><li><strong>跨文件缺陷</strong><p>选择“取消与库存恢复”，在主区切换取消与恢复路径，在右侧核实同一个库存契约。</p></li><li><strong>需求前提错误</strong><p>选择“支付与结果收敛”，比较需求原文、超时语义与实现。修订需求后，旧代码仍可能需要修改。</p></li></ul><p class="form-hint">全部案例、位置与结果为预设示例。输入只存在页面内存，不调用模型或访问真实仓库。F8 跳转下一问题。</p><p class="form-hint">早期五页原型保留为 <a href="./concept.html" target="_blank" rel="noopener">概念参考</a>，不是当前交互方案。</p></div>`);
  }

  function sourceDetails(id, version) {
    const source = sources.getSource(state, id);
    const original = sources.snapshot(source, version || source.version);
    openModal(`${escape(source.name)} · 原文 v${original.version}`, `<div class="modal-body"><div class="source-detail-meta">${badge(sources.kindLabels[source.kind], 'blue')}${badge(source.selected ? sources.purposeLabels[source.purpose] : '未选入本次')}${badge(original.version === source.version ? '当前快照' : '历史快照', original.version === source.version ? 'green' : 'amber')}</div><p class="form-hint">${escape(source.location)} · 所有位置均为虚构示例。以下隐藏空行，保留片段的原始行号。</p><div class="raw-source">${original.text.split('\n').map((text, index) => text.trim() ? `<div class="raw-source-line"><span>L${index + 1}</span><p>${escape(text)}</p></div>` : '').join('')}</div><p class="form-hint">这是独立保存的材料原文，不会随需求条目的人工修订而改变。</p></div>`, `<button class="button" data-action="close">关闭</button>${source.snapshots.length > 1 ? `<button class="button" data-action="material" data-source-id="${id}" data-version="${original.version === 1 ? source.version : 1}">查看${original.version === 1 ? '当前' : '最初'}版本</button>` : ''}<button class="button" data-action="edit-source-snapshot" data-source-id="${id}">更新来源快照（演示）</button><button class="button primary" data-action="read-material" data-source-id="${id}">在主区看当前原文</button>`);
  }

  function traceRequirement(id) {
    const requirement = state.sourceReview.draft?.candidates.find((item) => item.id === id) || state.requirements.find((item) => item.id === id);
    if (!requirement) return notify('这个条目不在当前候选或基线中。', true);
    openModal(`${id} · 从哪里来的？`, `<div class="modal-body"><div class="source-detail-meta">${badge(requirement.manualRevision ? '人工修订' : requirement.originKind || '示例整理', 'blue')}${badge(state.sourceReview.draft ? '候选待确认' : state.baselineConfirmed ? `基线 v${state.baselineVersion}` : '旧基线待更新')}</div><h3 class="trace-heading">当前条目表述</h3><blockquote class="quote">${escape(requirement.text)}</blockquote><p class="form-hint">条目表述与原文独立。人工修订不替换下列引用；引用存在也不证明需求假设正确。</p>${(requirement.origins || []).map((origin) => {
      const source = sources.getSource(state, origin.sourceId);
      const status = sources.originStatus(state, origin);
      return `<section class="trace-origin"><div class="trace-origin-heading"><strong>${escape(source.name)}</strong>${badge(status, status === '当前版本' ? 'green' : 'amber')}</div><p class="form-hint">${escape(sources.labelOrigin(state, origin))} · ${sources.kindLabels[source.kind]}</p><blockquote class="quote raw-quote">${escape(origin.quote)}</blockquote><button class="text-button" data-action="material" data-source-id="${source.id}" data-version="${origin.version}">${icon('link')}查看引用时的原文 v${origin.version}</button></section>`;
    }).join('') || '<div class="inline-notice"><strong>缺少可核对的原文引用，不能当作已确认依据。</strong></div>'}</div>`);
  }

  function editSourceSnapshot(id) {
    const source = sources.getSource(state, id);
    openModal('更新来源快照 · 不修改真实文件', `<form id="source-snapshot-form"><div class="modal-body"><input name="source-id" type="hidden" value="${id}"><label class="field-label" for="source-snapshot-text">${escape(source.name)} · 当前 v${source.version}</label><textarea id="source-snapshot-text" class="textarea" rows="12" required>${escape(source.text)}</textarea><p class="form-hint">保存为新版本，旧引用与原文仍保留。原型不对自定义文本做提取；更新后需重新整理，必要时明确提供人工候选。</p></div></form>`, '<button class="button" data-action="close">取消</button><button class="button primary" form="source-snapshot-form" type="submit">保存新快照并使旧结果失效</button>');
  }

  function editRequirement(id) {
    const requirement = state.requirements.find((item) => item.id === id);
    if (!requirement) return notify('当前示例没有对应的需求条目。', true);
    openModal(`修订 ${id} · 不擅自改写需求`, `<form id="center-requirement-form"><div class="modal-body"><input name="requirement-id" type="hidden" value="${id}"><input id="center-preset" type="hidden" value="false"><label class="field-label" for="center-requirement-title">条目标题</label><input id="center-requirement-title" class="text-field" required value="${escape(requirement.title)}"><label class="field-label" for="center-requirement-text">需求与验收条件</label><textarea id="center-requirement-text" class="textarea" rows="5" required>${escape(requirement.text)}</textarea><p class="form-hint">保存后旧结果失效，需确认基线并重审。确认新需求不能自动证明旧代码已满足。</p>${id === 'RQ-02' ? '<button type="button" class="button small" data-action="preset-requirement">填入示例：“超时保持未知”</button><p class="form-hint">该分支可演示：需求矛盾 → 需求已澄清 → 实现尚待对齐。自定义文本不会被原型假装理解。</p>' : ''}</div></form>`, '<button class="button" data-action="close">取消</button><button class="button primary" type="submit" form="center-requirement-form">保存修订并使旧结果失效</button>');
  }

  function noteModal(kind, id) {
    const title = kind === 'comment' ? '记录评论，不解除关键阻断' : '补充适用边界，不生成永久免责';
    openModal(title, `<form id="center-note-form"><div class="modal-body"><input name="finding-id" type="hidden" value="${id}"><input name="note-kind" type="hidden" value="${kind}"><label class="field-label" for="center-note">说明与依据</label><textarea id="center-note" class="textarea" rows="5" required placeholder="说明触发条件、业务取舍或还需核实的证据…"></textarea><p class="form-hint">仅记录在本次原型；不写入 GitHub。补充事实会使相关判断待重审。</p></div></form>`, '<button class="button" data-action="close">取消</button><button class="button primary" type="submit" form="center-note-form">记录到当前示例</button>');
  }

  function fixPreview(id) {
    const finding = state.findings.find((item) => item.id === id);
    if (finding.type !== 'implementation') return notify('需求矛盾或必要前提应先澄清，不能直接生成修复。', true);
    const before = id === 'F-01' ? 'order.markPaymentFailed();\nreturn { canPayAgain: true };' : state.scenario === 'technical' ? 'const reservation = await inventory.findByOrder(order.id);\nreturn { reservationId: reservation.id };' : 'await order.restore();\nreturn { status: "awaiting_payment" };';
    const after = id === 'F-01' ? 'order.markPaymentUnknown();\nreturn { canPayAgain: false, status: "unknown" };' : state.scenario === 'technical' ? 'const reservation = await inventory.reserveForOrder(order);\nawait order.restore();\nreturn { reservationId: reservation.id };' : 'await inventory.reserveForOrder(order);\nawait order.restore();\nreturn { status: "awaiting_payment" };';
    openModal('修复方案 · 仅替换浏览器内示例', `<div class="modal-body"><p>${id === 'F-01' ? '把超时保留为未知状态，暂不开放再次支付。' : '在恢复状态前，重新建立示例库存保障。'}这里只验证交互，不代表真实系统的最终正确修复。</p><pre class="fix-before">${escape(before)}</pre><pre class="fix-after">${escape(after)}</pre><p class="form-hint">不会修改真实文件，不执行测试。接受后标记为人工接受示例补丁；本次应用可撤销。</p></div>`, `<button class="button" data-action="close">返回代码</button><button class="button primary" data-action="apply-fix" data-id="${id}" ${state.center.patches[id] ? 'disabled' : ''}>${state.center.patches[id] ? '示例已应用' : '人工接受并应用到示例'}</button>`);
  }

  async function startRun() {
    if (state.runStatus === 'running') return;
    if (state.mode === 'requirements' && (!state.baselineConfirmed || state.sourceReview.acceptedRevision !== state.sourceReview.revision)) {
      stage('prepare');
      return notify('请先确认需求基线。模型推断不能自动成为已确认需求。', true);
    }
    const generation = ++runGeneration;
    state.runStatus = 'running';
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
    notify(state.sourceReview.limited ? '来源流程演示完成；新增或排除条目未做语义评审，结果标为部分完成。' : '模拟流程完成：未连接模型、分析输入或执行测试。');
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
    if (action === 'close') return modal.close();
    if (action === 'stage') return stage(target.dataset.stage);
    if (action === 'help') return help();
    if (action === 'theme') { document.documentElement.dataset.theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; return render(); }
    if (action === 'reset') { runGeneration += 1; state = createCenterState(state.scenario); if (modal.open) modal.close(); render(false); return notify('已重置到独立演示快照，未改变真实工作区。'); }
    if (action === 'finding') { selectFinding(state, target.dataset.id); return render(false); }
    if (action === 'source') return openSource(target.dataset.source);
    if (action === 'navigator') { state.center.navigator = target.dataset.tab; return render(); }
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
    if (action === 'recheck') {
      notify('从当前阅读位置重审关联范围；不是只复查孤立的一行代码。');
      return void startRun();
    }
    if (action === 'cancel') { runGeneration += 1; state.runStatus = 'cancelled'; invalidate(state); render(); return notify('已取消模拟流程，迟到结果不会覆盖当前状态。'); }
    if (action === 'scope') {
      const files = sourceFiles(state);
      return openModal('范围账本 · 不自动扩大真实权限', `<div class="modal-body"><p>当前分支中的入口文件是正式审查对象；其他文件用于理解契约与保障。以下全部为虚构位置。</p>${['submit', 'callback', 'cancel', 'restore', 'status'].map((key) => `<button class="source-pill" data-action="scope-source" data-source="${key}">${icon('code')}<span>${files[key].path}</span>${badge('入口')}</button>`).join('')}<p class="form-hint">${state.runStatus === 'partial' ? '通道契约仍读取受限；不能宣称全部范围完成。' : '未列出的外部系统实现保持未知，不靠猜测补全。'}</p></div>`);
    }
    if (action === 'scope-source') { modal.close(); return openSource(target.dataset.source); }
    if (action === 'trace-requirement') return traceRequirement(target.dataset.id);
    if (action === 'material') return sourceDetails(target.dataset.sourceId, Number(target.dataset.version) || undefined);
    if (action === 'read-material') { modal.close(); return openSource(target.dataset.sourceId); }
    if (state.runStatus === 'running') return notify('请先结束或取消模拟审查，再修改依据或处置。', true);
    if (action === 'organize-sources') {
      sources.organize(state);
      state.center.stage = 'prepare';
      render();
      main.querySelector('#candidate-section')?.scrollIntoView({ block: 'start', behavior: 'instant' });
      return notify('仅整理预设映射和明确的人工候选；尚未确认需求，不进行真实语义提取。');
    }
    if (action === 'edit-source-snapshot') return editSourceSnapshot(target.dataset.sourceId);
    if (action === 'confirm-baseline') {
      try {
        confirmBaseline(state);
      } catch (error) {
        return notify(error.message, true);
      }
      stage('review');
      return notify('需求基线已确认；原文冲突不会自动解决，旧结果仍需重审。');
    }
    if (action === 'edit-requirement') return editRequirement(target.dataset.id);
    if (action === 'preset-requirement') { document.getElementById('center-requirement-title').value = '支付超时后保留结果未知'; document.getElementById('center-requirement-text').value = demo.revisedRequirement; document.getElementById('center-preset').value = 'true'; return; }
    if (action === 'comment' || action === 'boundary') return noteModal(action, target.dataset.id);
    if (action === 'fix-preview') return fixPreview(target.dataset.id);
    if (action === 'apply-fix') { applySampleFix(state, target.dataset.id); modal.close(); render(); return notify('仅应用到浏览器内示例，未运行测试，可撤销。'); }
    if (action === 'undo-fix') { undoSampleFix(state, target.dataset.id); render(); return notify('示例补丁已撤销，原问题与通过限制已恢复。'); }
    if (action === 'evidence') return openModal('补充关键契约 · 预设证据分支', `<form id="center-evidence-form"><div class="modal-body"><p>本分支演示稳定事件键与唯一约束得到补充。它不是对任意输入执行的实际契约验证。</p><label class="field-label" for="center-evidence">来源与适用范围</label><textarea id="center-evidence" class="textarea" required rows="5">示例契约 v2 第 4 条：同一支付事件重投保持 event.id 稳定；示例账本对该键具备唯一约束。仅适用于当前演示。</textarea><p class="form-hint">补充后仍要重审，关键前提不会在点击保存时立即解除。</p></div></form>`, '<button class="button" data-action="close">取消</button><button class="button primary" form="center-evidence-form" type="submit">补充示例证据，等待重审</button>');
    if (action === 'add-source') return openModal('人工输入 · 先说明用途', `<form id="center-source-form"><div class="modal-body"><label class="field-label" for="center-source-name">材料 / 候选条目名称</label><input required class="text-field" id="center-source-name" placeholder="例如：取消订单恢复的业务边界"><label class="field-label" for="center-source-purpose">这段输入用于什么？</label><select id="center-source-purpose" class="text-field"><option value="context">仅作业务上下文，不生成验收要求</option><option value="requirement">一条明确的人工需求候选，仍待核对确认</option></select><label class="field-label" for="center-source-text">原文或补充说明</label><textarea required class="textarea" id="center-source-text" rows="5"></textarea><p class="form-hint">选择候选用途时，这段原文整体作为人工候选；不是模型提取，不会自动确认。只在页面内存保存，不上传。</p></div></form>`, '<button class="button" data-action="close">取消</button><button class="button primary" form="center-source-form" type="submit">加入材料，等待整理</button>');
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
    if (form.id === 'center-requirement-form') {
      const text = document.getElementById('center-requirement-text').value.trim();
      const title = document.getElementById('center-requirement-title').value.trim();
      if (!text || !title) return notify('需求标题和内容不能为空。', true);
      const id = form.elements.namedItem('requirement-id').value;
      demo.reviseRequirement(state, id, text, document.getElementById('center-preset').value === 'true');
      const requirement = state.requirements.find((item) => item.id === id);
      requirement.title = title;
      requirement.manualRevision = true;
      state.sourceReview.acknowledged = false;
      state.sourceReview.draft = null;
      state.center.stage = 'prepare';
      notify('需求已修订，旧结果失效。确认后重审，代码仍需独立核对。');
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
      const name = document.getElementById('center-source-name').value.trim();
      const text = document.getElementById('center-source-text').value.trim();
      if (!name || !text) return notify('来源名称与内容不能为空。', true);
      sources.addManualSource(state, name, text, document.getElementById('center-source-purpose').value);
      state.center.stage = 'prepare';
      notify('已加入人工材料；需整理和明确确认，不自动生成已确认需求。');
    } else if (form.id === 'source-snapshot-form') {
      const text = document.getElementById('source-snapshot-text').value;
      if (!text.trim()) return notify('原文不能为空。', true);
      sources.updateSource(state, form.elements.namedItem('source-id').value, text);
      state.center.stage = 'prepare';
      notify('已保存新原文快照，旧引用保留但不再有效；请重新整理来源。');
    } else return;
    modal.close();
    render();
  });

  document.addEventListener('input', (event) => {
    if (event.target.id === 'center-search') { state.center.search = event.target.value; render(); }
    if (event.target.id === 'center-notes') {
      state.notes = event.target.value;
      const preview = document.getElementById('center-summary');
      if (preview) preview.textContent = summaryText(state);
    }
    if (event.target.dataset.candidateReason) {
      const candidate = state.sourceReview.draft.candidates.find((item) => item.id === event.target.dataset.candidateReason);
      sources.updateCandidate(state, candidate.id, candidate.include, event.target.value);
      const acknowledgment = document.getElementById('source-acknowledgment');
      if (acknowledgment) acknowledgment.checked = false;
      const confirm = main.querySelector('[data-action="confirm-baseline"]');
      if (confirm) confirm.disabled = true;
    }
  });

  document.addEventListener('change', (event) => {
    if (event.target.id === 'demo-scenario') {
      runGeneration += 1;
      if (modal.open) modal.close();
      state = createCenterState(event.target.value);
      render(false);
      return notify('已切换独立演示快照，不是清除当前审查的关键阻断。');
    }
    if (event.target.name === 'review-mode') {
      if (state.runStatus === 'running') { render(); return notify('模拟进行中不能切换依据。', true); }
      switchMode(state, event.target.value);
      render();
      return notify('审查模式已变更；已知关键矛盾仍保留，旧结果待重审。');
    }
    if (event.target.name === 'selected-source' || event.target.name === 'source-purpose') {
      if (state.runStatus === 'running') { render(); return notify('模拟进行中不能修改来源。', true); }
      if (event.target.name === 'selected-source') sources.selectSource(state, event.target.value, event.target.checked);
      else sources.setPurpose(state, event.target.dataset.sourceId, event.target.value);
      render();
      return notify('来源或用途已变更，旧结果失效；请重新整理候选并人工确认。');
    }
    if (event.target.name === 'candidate-include') {
      const candidate = state.sourceReview.draft.candidates.find((item) => item.id === event.target.value);
      sources.updateCandidate(state, candidate.id, event.target.checked, candidate.exclusionReason);
      render();
      return;
    }
    if (event.target.id === 'source-acknowledgment') {
      state.sourceReview.acknowledged = event.target.checked;
      render();
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
