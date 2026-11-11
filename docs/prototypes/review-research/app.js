(function () {
  'use strict';
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const file = (id, path, rows, changed = true) => ({ id, path, changed, rows: rows.map(([n, text, kind = 'context']) => ({ n, text, kind })) });
  const specs = [
    {
      id: 'renewal', number: 218, repo: 'billing-service', title: '订阅续费：合并账单生成与自动扣费', author: 'dev-a', branch: 'feat/renewal-pipeline', base: 'main', head: 'b701c2e', risk: 'high', age: '24 分钟前',
      description: '把续费事件中的账单生成和扣费放到同一条处理链中。需要保持事件重投安全，并以整数分计算剩余周期的费用。',
      checks: ['同一续费周期不应产生重复扣费', '金额以整数分存储，最后一步舍入'],
      files: [
        file('renewal', 'src/billing/renewal.ts', [[31, 'export async function renew(event: RenewalEvent) {'], [32, '  const invoice = await invoices.forPeriod(event.customerId, event.period);'], [34, '  await enqueueCharge(invoice.id);', 'del'], [35, '  await charges.create({ invoiceId: invoice.id, amount: invoice.total });', 'add'], [36, '  await events.markProcessed(event.id);', 'add'], [37, '  return invoice;'], [38, '}']]),
        file('proration', 'src/billing/proration.ts', [[14, 'export function prorate(deltaCents: number, days: number, remaining: number) {'], [15, '  return Math.round(deltaCents / days) * remaining;', 'add'], [16, '}']]),
        file('charges', 'src/payments/charges.ts', [[20, 'export async function create(input: ChargeInput) {'], [21, '  // Caller must supply the idempotency boundary.'], [22, '  return gateway.charge(input);'], [23, '}'], [25, 'export async function createOnce(key: string, input: ChargeInput) {'], [26, '  return ledger.once(key, () => gateway.charge(input));'], [27, '}']], false),
        file('consumer', 'src/events/consumer.ts', [[42, 'try {'], [43, '  await handler(event);'], [44, '  await queue.ack(event.id);'], [45, '} catch (error) {'], [46, '  await queue.retry(event.id);'], [47, '}']], false),
      ],
      findings: [
        { id: 'R1', severity: 'high', title: '续费事件重投可能重复扣费', file: 'renewal', line: 35, summary: '扣费成功、标记事件失败时，消费者会重投同一事件。新的扣费调用没有传入账单幂等键。', trigger: '支付网关已扣费，但 markProcessed 或队列确认失败。', impact: '同一个账单可能被再次扣款；账单查询本身不能防止第二次调用支付网关。', evidence: [{ file: 'consumer', line: 46, text: '消费失败会重投整个处理函数。' }, { file: 'charges', line: 22, text: 'create 直接访问网关；同模块已有带账本去重的 createOnce。' }], counter: '已核对消费者和支付封装：它们没有为 create 补上幂等边界。这里不是要求再加一层通用重试。', fix: [{ n: 35, text: '  await charges.createOnce(invoice.id, { invoiceId: invoice.id, amount: invoice.total });' }], tests: '模拟扣费成功后事件确认失败，再投递同一事件；断言只有一次网关扣费。' },
        { id: 'R2', severity: 'medium', title: '提前舍入造成按比例账单误差', file: 'proration', line: 15, summary: '先舍入每日单价、再乘剩余天数，会累计舍入误差；应在最终金额上舍入。', trigger: '周期差价不能被周期天数整除。', impact: '例如差价 1000 分、周期 30 天、剩余 17 天：当前得到 561 分，最终舍入应为 567 分。', evidence: [{ file: 'proration', line: 15, text: 'Math.round 位于乘法之前，舍入后的每日金额被重复累计。' }], counter: '输入、持久化和支付封装均使用整数分；这不是显示层格式化差异。', fix: [{ n: 15, text: '  return Math.round(deltaCents * remaining / days);' }], tests: '覆盖 1000 / 30 × 17、负差价及完整周期；校验舍入只发生在最终金额。' },
      ],
    },
    {
      id: 'exports', number: 219, repo: 'identity-api', title: '为管理后台增加批量用户导出', author: 'dev-b', branch: 'feat/bulk-export', base: 'main', head: 'c83d42a', risk: 'high', age: '1 小时前',
      description: '允许管理员按传入的用户 ID 导出用户资料。租户管理员只能导出所属租户的数据。',
      checks: ['导出结果必须受当前租户约束'],
      files: [
        file('export', 'src/users/export.ts', [[18, 'export async function exportUsers(request: Request) {'], [19, '  const actor = await requireTenantAdmin(request);'], [20, '  const ids = await request.json();', 'add'], [21, '  return users.findMany({ where: { id: { in: ids } } });', 'add'], [22, '}']]),
        file('auth', 'src/auth/tenant.ts', [[8, 'export async function requireTenantAdmin(request: Request) {'], [9, '  const actor = await session(request);'], [10, '  if (!actor.roles.includes("tenant-admin")) throw new Forbidden();'], [11, '  return actor;'], [12, '}'], [14, '// Database queries must include actor.tenantId; no row-level policy.']], false),
      ],
      findings: [{ id: 'R1', severity: 'high', title: '导出查询遗漏租户边界', file: 'export', line: 21, summary: '鉴权只证明调用者是某个租户的管理员。查询任意 ID 时没有约束 tenantId。', trigger: '传入其他租户的用户 ID。', impact: '可能跨租户导出用户资料。', evidence: [{ file: 'auth', line: 14, text: '鉴权模块明确要求数据查询包含租户条件，数据库没有行级策略兜底。' }], counter: '已区分角色鉴权与数据范围：角色检查不能替代查询的租户过滤。', fix: [{ n: 21, text: '  return users.findMany({ where: { tenantId: actor.tenantId, id: { in: ids } } });' }], tests: '以租户 A 管理员请求 A/B 两租户的 ID，断言导出只含 A 的用户。' }],
    },
    {
      id: 'copy', number: 220, repo: 'billing-service', title: '优化账单空状态文案与帮助入口', author: 'dev-c', branch: 'ui/invoice-empty', base: 'main', head: 'a13e09b', risk: 'low', age: '2 小时前',
      description: '调整无账单时的引导文案，不改变费用计算或账单权限。',
      checks: ['帮助入口使用现有内部路由'],
      files: [file('empty', 'src/ui/invoice-empty.ts', [[5, 'export const emptyState = {'], [6, '  title: "还没有账单",', 'add'], [7, '  description: "账单生成后会显示在这里。",', 'add'], [8, '  helpRoute: routes.billingHelp,'], [9, '};']])],
      findings: [],
    },
    {
      id: 'retry', number: 221, repo: 'event-worker', title: '重试队列支持指数退避', author: 'dev-d', branch: 'feat/retry-backoff', base: 'main', head: 'd63f8e1', risk: 'medium', age: '3 小时前',
      description: '失败任务退避后重新入队。调度失败时，原任务必须仍可重试。',
      checks: ['重新入队成功之前不能确认原任务'],
      files: [
        file('retry', 'src/jobs/retry.ts', [[21, 'export async function reschedule(job: Job) {'], [22, '  const delay = Math.min(60_000, 1000 * 2 ** job.attempt);', 'add'], [23, '  await queue.ack(job.id);', 'add'], [24, '  await queue.schedule(job.payload, delay);', 'add'], [25, '}']]),
        file('queue', 'src/queue/client.ts', [[10, '// ack permanently removes the original job.'], [11, '// schedule may fail; the two operations are not transactional.']], false),
      ],
      findings: [{ id: 'R1', severity: 'high', title: '确认顺序可能导致重试任务丢失', file: 'retry', line: 23, summary: '先确认原任务，再尝试重新入队；调度失败时已经没有可重试的任务。', trigger: 'schedule 调用发生网络错误或调度服务不可用。', impact: '失败任务被静默丢弃。', evidence: [{ file: 'queue', line: 11, text: '确认与调度不是事务操作，调度错误不会恢复原任务。' }], counter: '退避时间已有上限，不需要再报告指数计算风险；问题是两个副作用的先后顺序。', fix: [{ n: 23, text: '  await queue.schedule(job.payload, delay);' }, { n: 24, text: '  await queue.ack(job.id);' }], tests: '让 schedule 抛错，断言 ack 未执行；调度成功后才允许确认。' }],
    },
  ];
  const severityLabel = { high: '高影响', medium: '中影响', low: '低影响' };
  const statusLabel = { open: '待判断', confirmed: '已采纳', dismissed: '不采纳', 'patch-applied': '待检查', fixed: '演示提交已复审' };
  const verdictLabel = { changes: '要求修改', comment: '仅评论', approve: '通过' };
  function definition(pr) { return specs.find((item) => item.id === pr.id); }
  function getPR(state, id) {
    const pr = state.pulls.find((item) => item.id === id);
    if (!pr) throw new Error('找不到这份 PR，未切换当前审查。');
    return pr;
  }
  function seedFindings(pr) { return clone(definition(pr).findings).map((item) => ({ ...item, status: 'open', reason: '' })); }
  function createState() {
    const state = { route: 'inbox', active: null, filter: 'pending', repo: 'all', search: '', connected: true, enabledRepos: ['billing-service', 'identity-api', 'event-worker'], records: [], pulls: [] };
    state.pulls = specs.map((spec, index) => {
      const pr = { id: spec.id, head: spec.head, snapshot: 1, revision: 0, context: '', contextRevision: 0, notes: null, notesKey: null, chatDraft: '', patches: {}, messages: [], findings: [], view: { file: spec.files[0].id, finding: null, tab: 'findings', files: 'changed', code: 'diff' }, review: { phase: index ? 'idle' : 'ready', head: spec.head, revision: 0, stage: 0 } };
      if (!index) { pr.findings = seedFindings(pr); pr.view.finding = pr.findings[0].id; }
      return pr;
    });
    return state;
  }
  function current(pr) { return ['ready', 'limited'].includes(pr.review.phase) && pr.review.head === pr.head && pr.review.revision === pr.revision; }
  function requireCurrent(pr) { if (!current(pr)) throw new Error('结果不对应当前快照，请完成本次审查后再处置。'); }
  function connected(state, pr) {
    if (!state.connected || !state.enabledRepos.includes(definition(pr).repo)) throw new Error('当前仓库未连接。缓存代码仍可阅读，请先在“仓库连接”恢复访问。');
  }
  function beginReview(state, id) {
    const pr = getPR(state, id);
    connected(state, pr);
    if (pr.review.phase === 'running') throw new Error('此 PR 已在审查中。');
    pr.review = { phase: 'running', head: pr.head, revision: pr.revision, stage: 0 };
  }
  function cancelReview(pr) {
    if (pr.review.phase !== 'running') throw new Error('没有进行中的审查。');
    pr.review.phase = 'cancelled';
  }
  function completeReview(pr) {
    if (pr.review.phase !== 'running' || pr.review.head !== pr.head || pr.review.revision !== pr.revision) throw new Error('审查快照已经变化，未把旧结果标为成功。');
    const previous = new Map(pr.findings.map((item) => [item.id, item]));
    pr.findings = pr.snapshot === 1 ? seedFindings(pr).map((item) => {
      const finding = previous.get(item.id) || item, patch = pr.patches[item.id];
      if (patch) finding.status = patch.validation === 'passed' && patch.key === snapshotKey(pr) ? 'fixed' : patch.validation === 'failed' ? 'confirmed' : 'patch-applied';
      return finding;
    }) : [];
    pr.review.phase = pr.snapshot > 1 || pr.context.trim() ? 'limited' : 'ready';
    pr.view.finding = pr.findings.some((f) => f.id === pr.view.finding) ? pr.view.finding : pr.findings[0]?.id ?? null;
  }
  function snapshotKey(pr) { return `${pr.id}/${pr.head}/${pr.revision}/context-${pr.contextRevision}`; }
  function findingById(pr, id) {
    const finding = pr.findings.find((item) => item.id === id);
    if (!finding) throw new Error('当前结果中不存在这条发现。');
    return finding;
  }
  function decide(pr, id, status, reason = '') {
    requireCurrent(pr);
    if (!['confirmed', 'dismissed', 'open'].includes(status)) throw new Error('未知的处置方式。');
    if (pr.patches[id]) throw new Error('请先撤销演示提交，再重新判断原始发现。');
    if (status === 'dismissed' && !reason.trim()) throw new Error('请说明不采纳的依据。');
    Object.assign(findingById(pr, id), { status, reason: status === 'dismissed' ? reason.trim() : '' });
  }
  function applyPatch(pr, id, token) {
    requireCurrent(pr);
    const finding = findingById(pr, id);
    if (token !== snapshotKey(pr)) throw new Error('方案对应的快照已变化，请重新预览。');
    if (pr.patches[id] || finding.status === 'dismissed') throw new Error('这条发现不能重复应用修复。');
    pr.revision += 1;
    pr.head = `${definition(pr).head}-fix${pr.revision}`;
    pr.patches[id] = { validation: 'pending', key: null };
    for (const item of pr.findings) if (pr.patches[item.id]) item.status = 'patch-applied';
    pr.review.phase = 'stale';
    pr.view.file = finding.file;
  }
  function validatePatches(pr, outcome) {
    if (!['passed', 'failed'].includes(outcome) || !Object.keys(pr.patches).length) throw new Error('请选择有效的检查结果，并先生成演示提交。');
    if (pr.review.phase === 'running') throw new Error('审查中不能改写检查结果。');
    for (const patch of Object.values(pr.patches)) Object.assign(patch, { validation: outcome, key: snapshotKey(pr) });
  }
  function undoPatch(pr, id) {
    if (!pr.patches[id] || pr.review.phase === 'running') throw new Error('当前不能撤销该演示提交。');
    delete pr.patches[id];
    pr.revision += 1;
    pr.head = `${definition(pr).head}-fix${pr.revision}`;
    findingById(pr, id).status = 'open';
    for (const item of pr.findings) if (pr.patches[item.id]) item.status = 'patch-applied';
    pr.review.phase = 'stale';
  }
  function updateSnapshot(pr) {
    if (pr.review.phase === 'running') throw new Error('请先取消或完成审查，再更新快照。');
    pr.snapshot += 1;
    pr.head = `${definition(pr).head}-new${pr.snapshot}`;
    pr.revision = 0;
    pr.patches = {};
    pr.findings = [];
    pr.view.finding = null;
    pr.review.phase = 'stale';
  }
  function setContext(pr, text) {
    if (pr.review.phase === 'running') throw new Error('审查中不能修改上下文。');
    if (pr.context === text) return;
    pr.context = text;
    pr.contextRevision += 1;
    pr.review.phase = 'stale';
  }
  function codeFiles(pr) {
    const files = clone(definition(pr).files);
    for (const id of Object.keys(pr.patches)) {
      const finding = definition(pr).findings.find((item) => item.id === id);
      for (const edit of finding.fix) {
        const row = files.find((item) => item.id === finding.file).rows.find((item) => item.n === edit.n && item.kind !== 'del');
        row.text = edit.text;
      }
    }
    if (pr.snapshot > 1) files[0].rows.push({ n: files[0].rows.at(-1).n + 1, text: `// Demo snapshot ${pr.snapshot}: this new commit has not been analyzed.`, kind: 'add' });
    return files;
  }
  function publishGate(state, pr, verdict, body) {
    const reasons = [];
    if (!state.connected || !state.enabledRepos.includes(definition(pr).repo)) reasons.push('仓库未连接，不能发布。');
    if (!current(pr)) reasons.push('请完成当前快照的审查。');
    if (!Object.hasOwn(verdictLabel, verdict)) reasons.push('请选择有效的审查结论。');
    if (!body.trim()) reasons.push('请填写审查摘要。');
    if (verdict === 'approve') {
      if (pr.review.phase === 'limited') reasons.push('覆盖受限，不能通过。');
      if (pr.findings.some((item) => !['dismissed', 'fixed'].includes(item.status))) reasons.push('还有未闭合发现，不能通过。');
    }
    return reasons;
  }
  function publish(state, pr, verdict, body, token) {
    if (token !== snapshotKey(pr)) throw new Error('发布预览已过期，请重新核对当前快照。');
    const reasons = publishGate(state, pr, verdict, body);
    if (reasons.length) throw new Error(reasons.join(' '));
    const record = { id: `review-${state.records.length + 1}`, pr: pr.id, key: snapshotKey(pr), verdict, body: body.trim(), comments: pr.findings.filter((f) => f.status === 'confirmed').map((f) => ({ id: f.id, title: f.title, file: f.file, line: f.line })), at: new Date().toISOString() };
    state.records.unshift(record);
    return record;
  }
  function reviewed(state, pr) { return state.records.some((r) => r.key === snapshotKey(pr)); }
  function listPRs(state) {
    const query = state.search.trim().toLowerCase();
    return state.pulls.filter((pr) => {
      const spec = definition(pr);
      return (state.repo === 'all' || spec.repo === state.repo) && (!query || `${spec.title} ${spec.repo} ${spec.number}`.toLowerCase().includes(query)) && (state.filter !== 'pending' || !reviewed(state, pr)) && (state.filter !== 'high' || spec.risk === 'high');
    });
  }
  function changeConnection(state, value) {
    if (state.pulls.some((pr) => pr.review.phase === 'running')) throw new Error('请先结束进行中的审查，再修改连接。');
    state.connected = value;
  }
  function toggleRepo(state, repo, enabled) {
    if (!specs.some((item) => item.repo === repo)) throw new Error('未知仓库。');
    if (state.pulls.some((pr) => definition(pr).repo === repo && pr.review.phase === 'running')) throw new Error('该仓库正在审查中，不能移除。');
    state.enabledRepos = enabled ? [...new Set([...state.enabledRepos, repo])] : state.enabledRepos.filter((item) => item !== repo);
  }
  function answer(pr, question) {
    if (!question.trim()) throw new Error('请输入问题。');
    const selected = pr.findings.find((f) => f.id === pr.view.finding);
    let response;
    if (/目的|摘要|做什么/.test(question)) response = `预设 PR 摘要：${definition(pr).description}`;
    else if (/验证|测试/.test(question) && selected) response = `预设验证建议：${selected.tests} 这里不会执行真实测试。`;
    else if (/为什么|解释|依据/.test(question) && selected) response = `当前发现的预设依据：${selected.summary} ${selected.counter}`;
    else response = '这是离线问答演示，未调用模型，不能分析任意问题。可尝试“变更目的”“解释当前问题”或“验证建议”；有发现时会引用其预设上下文。';
    pr.messages.push({ question: question.trim(), response, key: snapshotKey(pr) });
    return response;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { createState, getPR, definition, listPRs, current, beginReview, cancelReview, completeReview, snapshotKey, decide, applyPatch, validatePatches, undoPatch, updateSnapshot, setContext, codeFiles, publishGate, publish, reviewed, changeConnection, toggleRepo, answer };
    return;
  }

  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const paths = { check: 'm5 12 4 4L19 6', inbox: 'M3 4h18v16H3ZM3 13h5l2 3h4l2-3h5', code: 'm8 5-7 7 7 7m8-14 7 7-7 7', branch: 'M6 3v15a3 3 0 0 0 3 3h3M6 10h8a4 4 0 0 0 4-4V3', arrow: 'm14 5-7 7 7 7', history: 'M3 4v6h6M3 10a9 9 0 1 1 1 7M12 7v5l3 2', link: 'm9 15 6-6M8 16l-2 2a4 4 0 0 1-5-6l5-5a4 4 0 0 1 6 0M16 8l2-2a4 4 0 0 1 5 6l-5 5a4 4 0 0 1-6 0', close: 'm6 6 12 12M6 18 18 6', search: 'M15 15l6 6M16 9a7 7 0 1 1-14 0 7 7 0 0 1 14 0', sun: 'M12 1v3M12 20v3M1 12h3M20 12h3M4 4l2 2M18 18l2 2M4 20l2-2M18 6l2-2M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0', info: 'M12 10v7M12 6h.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0', play: 'm8 4 13 8-13 8V4', file: 'M14 2H5v20h14V7l-5-5ZM14 2v6h5M8 12h8M8 16h6', alert: 'm12 3 10 18H2L12 3ZM12 9v5M12 17h.01', message: 'M3 3h18v14H8l-5 4V3ZM7 8h10M7 12h7' };
  const icon = (name) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${paths[name] || paths.file}"/></svg>`;
  const badge = (text, tone = '') => `<span class="badge ${tone}">${esc(text)}</span>`;
  const app = document.getElementById('app'), dialog = document.getElementById('dialog'), toast = document.getElementById('toast');
  let state = createState(), timer, pendingPatch = null, pendingPublish = null, generation = 0;
  const runs = new Map(), stages = ['读取 PR 与变更意图', '追踪关联调用与保障', '核查发现与反例', '整理可操作的审查'];
  const active = () => getPR(state, state.active);
  function notify(text) { clearTimeout(timer); toast.textContent = text; toast.hidden = false; timer = setTimeout(() => { toast.hidden = true; }, 5000); }
  function modal(title, body, footer = '<button class="button" data-action="close">关闭</button>') {
    pendingPatch = null; pendingPublish = null;
    if (dialog.open) dialog.close();
    dialog.innerHTML = `<header class="modal-head"><h2 id="dialog-title">${title}</h2></header><div class="modal-body">${body}</div><footer class="modal-foot">${footer}</footer>`;
    dialog.showModal();
  }
  function phase(pr) { return ({ idle: '待 AI 审查', running: '正在审查', ready: '结果已就绪', limited: '覆盖受限', stale: '需要重新审查', cancelled: '审查已取消' })[pr.review.phase]; }
  function nav() {
    return `<aside class="nav"><a class="brand" href="#" data-action="route" data-route="inbox" aria-label="Review Studio 首页"><span>${icon('check')}</span><strong>Review Studio</strong></a><p class="workspace-label">NORTHSTAR · 示例工作区</p><nav aria-label="主要导航">${[['inbox', 'inbox', '审查收件箱'], ['history', 'history', '审查记录'], ['connections', 'link', '仓库连接']].map(([route, name, label]) => `<button class="nav-item ${(state.route === route || state.route === 'pr' && route === 'inbox') ? 'active' : ''}" data-action="route" data-route="${route}" title="${label}">${icon(name)}<span>${label}</span>${route === 'inbox' ? `<small>${state.pulls.filter((pr) => !reviewed(state, pr)).length}</small>` : ''}</button>`).join('')}</nav><div class="nav-bottom"><button class="nav-item" data-action="theme" aria-label="切换外观" title="切换外观">${icon('sun')}<span>切换${document.documentElement.dataset.theme === 'light' ? '深色' : '浅色'}外观</span></button><button class="nav-item" data-action="about" aria-label="原型与设计依据" title="原型与设计依据">${icon('info')}<span>原型与设计依据</span></button><div class="avatar-line"><span class="avatar">N</span><span>Northstar 团队<small>演示账号 · 非真实登录</small></span></div></div></aside>`;
  }
  function pageHeader(kicker, title, copy, action = '') {
    return `<header class="page-header"><div><p class="eyebrow">${kicker}</p><h1>${title}</h1><p>${copy}</p></div>${action}</header>`;
  }
  function inbox() {
    const pending = state.pulls.filter((p) => !reviewed(state, p)), rows = listPRs(state);
    return `<div class="page">${pageHeader('REVIEW INBOX', '把注意力放在值得审查的变更上', '先理解意图，再沿着代码与证据做判断。')}<div class="metrics"><div><span>等待你的审查</span><strong>${pending.length}<small>份 PR</small></strong></div><div><span>高风险变更</span><strong>${pending.filter((p) => definition(p).risk === 'high').length}<small>优先处理</small></strong></div><div><span>已记录的审查</span><strong>${state.records.length}<small>当前演示会话</small></strong></div></div><div class="queue-toolbar"><div class="segments" role="group" aria-label="PR 筛选">${[['pending', '待我审查'], ['all', '全部 PR'], ['high', '高风险']].map(([id, label]) => `<button class="${state.filter === id ? 'selected' : ''}" data-action="filter" data-id="${id}" aria-pressed="${state.filter === id}">${label}</button>`).join('')}</div><div class="search">${icon('search')}<input id="search" type="search" aria-label="搜索 PR" placeholder="搜索标题、仓库或 PR 编号" value="${esc(state.search)}"></div><select id="repo-filter" aria-label="筛选仓库"><option value="all">所有仓库</option>${[...new Set(specs.map((s) => s.repo))].map((repo) => `<option ${state.repo === repo ? 'selected' : ''}>${repo}</option>`).join('')}</select></div>${!state.connected ? '<div class="notice warning">连接已断开，当前只显示缓存示例；运行和发布需要恢复连接。</div>' : ''}<section class="pr-list" aria-label="待审查的 Pull Requests">${rows.map((pr) => {
      const spec = definition(pr), changed = spec.files.filter((f) => f.changed), additions = changed.reduce((n, f) => n + f.rows.filter((r) => r.kind === 'add').length, 0);
      return `<button class="pr-card" data-action="open-pr" data-id="${pr.id}"><span class="pr-symbol">${icon('branch')}</span><span class="pr-main"><span class="pr-meta">${spec.repo}<span>PR ${spec.number} · ${spec.age}</span></span><strong>${spec.title}</strong><span class="pr-sub"><span class="avatar tiny">${spec.author.at(-1).toUpperCase()}</span>${spec.author} · ${changed.length} 个变更文件 <span class="add-text">+${additions}</span><span class="muted">${spec.branch} → ${spec.base}</span></span></span><span class="pr-state">${badge(spec.risk === 'high' ? '高风险' : spec.risk === 'medium' ? '中风险' : '低风险', spec.risk)}${badge(reviewed(state, pr) ? '已记录审查' : phase(pr), pr.review.phase === 'ready' ? 'purple' : '')}</span><span class="chevron">›</span></button>`;
    }).join('') || '<div class="empty"><h2>没有匹配的 PR</h2><p>可以清空搜索，或切换到“全部 PR”。</p></div>'}</section><div class="queue-note">${icon('info')}所有仓库、PR 与时间均为虚构示例。初始有一份预设审查，其他 PR 可运行完整演示流程。</div></div>`;
  }
  function history() {
    return `<div class="page">${pageHeader('REVIEW HISTORY', '每一次判断，都有对应的快照', '记录保留审查摘要、采纳评论和当时的代码版本；新提交不会改写旧记录。')}<div class="record-list">${state.records.map((r) => {
      const pr = getPR(state, r.pr), spec = definition(pr);
      return `<button class="record-card" data-action="record" data-id="${r.id}">${icon('history')}<span><strong>${spec.title}</strong><small>${spec.repo} · PR ${spec.number} · ${esc(r.key)}<br>${r.comments.length} 条采纳评论 · ${new Date(r.at).toLocaleString('zh-CN')}</small></span>${badge(verdictLabel[r.verdict], r.verdict === 'approve' ? 'success' : r.verdict === 'changes' ? 'high' : 'purple')}</button>`;
    }).join('') || '<div class="empty"><h2>还没有审查记录</h2><p>从收件箱打开一份 PR，处理发现后完成审查。</p><button class="button primary" data-action="route" data-route="inbox">前往收件箱</button></div>'}</div></div>`;
  }
  function connections() {
    return `<div class="page">${pageHeader('CONNECTIONS', '连接仓库，而不是搬运代码', '示例连接仅管理本原型的访问状态，不读取账号、令牌或真实仓库。')}<section class="connection-card"><div class="connection-title"><span class="provider">${icon('branch')}</span><div><h2>GitHub · Northstar</h2><p>${state.connected ? '示例组织已连接 · 可运行审查和记录反馈' : '已断开 · 仍可浏览缓存的 PR'}</p></div>${badge(state.connected ? '演示连接正常' : '未连接', state.connected ? 'success' : 'medium')}</div><div class="connection-actions"><span>权限示意：读取 PR、代码与评论；发布审查。当前没有真实授权。</span><button class="button ${state.connected ? '' : 'primary'}" data-action="${state.connected ? 'disconnect' : 'connect'}">${state.connected ? '断开示例连接' : '连接 GitHub（演示）'}</button></div><h3>可审查的仓库</h3>${[...new Set(specs.map((s) => s.repo))].map((repo) => `<label class="repo-choice"><input type="checkbox" name="enabled-repo" value="${repo}" ${state.enabledRepos.includes(repo) ? 'checked' : ''} ${state.connected ? '' : 'disabled'}><span><strong>northstar/${repo}</strong><small>仅影响本原型的运行和发布权限，缓存记录不会删除。</small></span></label>`).join('')}</section></div>`;
  }
  function findingList(pr) {
    if (pr.review.phase === 'running') return `<div class="run-state"><div class="spinner"></div><h3>${stages[Math.min(pr.review.stage, 3)]}</h3><p>正在运行预设流程，不调用模型。</p><div class="progress"><span style="width:${(pr.review.stage + 1) * 25}%"></span></div></div>`;
    if (!['ready', 'limited'].includes(pr.review.phase) && !(pr.review.phase === 'stale' && pr.findings.length)) return `<div class="empty small"><span class="empty-icon">${icon('code')}</span><h3>${phase(pr)}</h3><p>运行当前快照的审查后，会在这里展示发现、证据与建议。</p></div>`;
    const selected = pr.findings.find((f) => f.id === pr.view.finding);
    return `${!current(pr) ? '<div class="notice warning">当前快照尚未复审。下方保留原始发现；请检查演示提交并复审，或重新运行审查。</div>' : pr.review.phase === 'limited' ? '<div class="notice warning">覆盖受限：新快照或自定义上下文没有真实分析。预设发现不代表自定义内容已验证，不能据此通过。</div>' : '<div class="review-ready">预设审查已完成<span>示例结果，不代表真实模型能力</span></div>'}<div class="finding-list">${pr.findings.map((f) => `<button class="finding-card ${f.id === pr.view.finding ? 'selected' : ''}" data-action="finding" data-id="${f.id}"><span class="severity-dot ${f.severity}"></span><span><strong>${f.title}</strong><small>${severityLabel[f.severity]} · ${statusLabel[f.status]}${pr.patches[f.id]?.validation === 'failed' ? ' · 检查失败' : ''}</small></span>${f.status === 'fixed' || f.status === 'dismissed' ? icon('check') : ''}</button>`).join('') || `<div class="empty small"><h3>${pr.review.phase === 'limited' ? '此快照没有可用分析' : '未发现可报告问题'}</h3><p>${pr.review.phase === 'limited' ? '没有对应的新快照分析，不能据此判断有无缺陷。' : '这是预设检查的结果，并非“代码没有缺陷”的保证。'}</p></div>`}</div>${selected ? findingDetail(pr, selected) : ''}`;
  }
  function findingDetail(pr, f) {
    const source = codeFiles(pr).find((item) => item.id === f.file), patched = pr.patches[f.id];
    return `<article class="finding-detail"><div class="detail-title">${badge(severityLabel[f.severity], f.severity)}<span>${f.id} · ${statusLabel[f.status]}</span></div><h3>${f.title}</h3>${f.status === 'fixed' ? '<div class="notice">演示提交已通过预设复审。下方保留原始发现，便于追溯。</div>' : ''}<p>${f.summary}</p><button class="source-link" data-action="evidence" data-file="${f.file}" data-line="${f.line}">${icon('file')}${source.path}:${f.line}</button><section><h4>触发条件与影响</h4><p>${f.trigger}</p><p>${f.impact}</p></section><section><h4>关联证据</h4>${f.evidence.map((e) => `<button class="evidence" data-action="evidence" data-file="${e.file}" data-line="${e.line}"><strong>${codeFiles(pr).find((x) => x.id === e.file).path}:${e.line}</strong><span>${e.text}</span></button>`).join('')}</section><section><h4>已核查的保障与反例</h4><p>${f.counter}</p></section>${f.reason ? `<div class="notice">不采纳依据：${esc(f.reason)}</div>` : ''}<div class="finding-actions">${patched ? `<button class="button primary" data-action="validate" data-id="${f.id}">检查当前演示提交并复审</button><button class="button" data-action="undo" data-id="${f.id}">撤销此修复</button>` : f.status === 'dismissed' ? `<button class="button" data-action="reopen-finding" data-id="${f.id}">重新核查</button>` : `<button class="button primary" data-action="patch" data-id="${f.id}">${icon('code')}预览修复建议</button>${f.status !== 'confirmed' ? `<button class="button" data-action="confirm" data-id="${f.id}">采纳为评论</button>` : badge('已加入审查草稿', 'purple')}<button class="text-button" data-action="dismiss" data-id="${f.id}">不采纳</button>`}</div></article>`;
  }
  function chat(pr) {
    return `<div class="chat"><div class="notice">${icon('info')}离线问答演示：只引用本 PR 的预设信息，不调用模型。</div><div class="chat-prompts">${['变更目的', '解释当前问题', '验证建议'].map((q) => `<button data-action="ask-preset" data-question="${q}">${q}</button>`).join('')}</div><div class="messages">${pr.messages.map((m) => `<div class="question">${esc(m.question)}</div><div class="response"><span class="ai-avatar">AI</span><div><small>${m.key === snapshotKey(pr) ? '当前上下文的预设回答' : '历史上下文回答 · 不适用于当前快照'}</small><p>${esc(m.response)}</p></div></div>`).join('') || '<p class="muted">提问时会保留当前 PR 与选中发现的上下文。</p>'}</div><form id="chat-form"><label class="sr-only" for="chat-input">询问当前 PR</label><textarea id="chat-input" required placeholder="询问变更意图、当前问题或验证建议…" rows="3">${esc(pr.chatDraft)}</textarea><button class="button primary" type="submit">发送</button></form></div>`;
  }
  function reviewPage() {
    const pr = active(), spec = definition(pr), files = codeFiles(pr), fileView = files.find((item) => item.id === pr.view.file);
    const rows = pr.view.code === 'source' || !fileView.changed ? fileView.rows.filter((r) => r.kind !== 'del') : fileView.rows;
    const visibleFiles = files.filter((f) => f.changed === (pr.view.files === 'changed'));
    const finding = pr.findings.find((f) => f.id === pr.view.finding);
    const run = pr.review.phase === 'running';
    const body = rows.map((r) => `<div class="code-row ${pr.view.code === 'diff' && fileView.changed ? r.kind : 'context'} ${finding && finding.file === fileView.id && finding.line === r.n && r.kind !== 'del' ? 'target' : ''}" data-line="${r.n}"><span>${r.kind === 'add' ? '' : r.n}</span><span>${r.kind === 'del' ? '' : r.n}</span><span>${pr.view.code === 'diff' && fileView.changed ? r.kind === 'add' ? '+' : r.kind === 'del' ? '−' : '' : ''}</span><code>${esc(r.text)}</code></div>`).join('');
    return `<div class="review-page"><header class="pr-header"><div class="pr-topline"><button class="back" data-action="route" data-route="inbox">${icon('arrow')}收件箱</button><span>northstar / ${spec.repo}</span>${badge('PR ' + spec.number, 'purple')}<span class="muted">示例快照 ${esc(pr.head)}</span></div><div class="pr-heading"><div><h1>${spec.title}</h1><p><span class="avatar tiny">${spec.author.at(-1).toUpperCase()}</span>${spec.author}<span class="branch">${spec.branch}</span> → <span class="branch">${spec.base}</span></p></div><div class="pr-actions"><button class="button" data-action="context">${icon('file')}审查上下文${pr.context ? ' · 已补充' : ''}</button><button id="run-review" class="button ${run ? '' : 'primary'}" data-action="${run ? 'cancel-run' : 'run'}" ${!run && (!state.connected || !state.enabledRepos.includes(spec.repo)) ? 'disabled title="先恢复仓库连接"' : ''}>${icon(run ? 'close' : 'play')}${run ? '取消审查' : pr.review.phase === 'idle' ? '运行 AI 审查' : '重新审查'}</button><button id="finish-review" class="button" data-action="publish" ${current(pr) ? '' : 'disabled'}>完成审查${pr.findings.some((f) => f.status === 'confirmed') ? ` · ${pr.findings.filter((f) => f.status === 'confirmed').length}` : ''}</button><details class="pr-more"><summary aria-label="更多 PR 操作">···</summary><button data-action="new-snapshot">模拟新提交</button></details></div></div><div class="intent">${icon('info')}<p>${spec.description}</p><span>${spec.files.filter((f) => f.changed).length} 个变更文件 · ${spec.files.filter((f) => !f.changed).length} 个关联上下文</span></div></header>${!state.connected ? '<div class="connection-banner">GitHub 已断开：仅浏览缓存，不能运行或发布。</div>' : ''}<div class="review-grid"><aside class="file-pane"><div class="pane-title"><strong>代码导航</strong></div><div class="segments file-tabs">${[['changed', '变更'], ['context', '上下文']].map(([id, title]) => `<button data-action="file-tab" data-id="${id}" class="${pr.view.files === id ? 'selected' : ''}">${title}</button>`).join('')}</div><div class="file-list">${visibleFiles.map((f) => `<button class="file-item ${f.id === fileView.id ? 'selected' : ''}" data-action="file" data-id="${f.id}" title="${f.path}">${icon('file')}<span><strong>${f.path.split('/').at(-1)}</strong><small>${f.path.split('/').slice(0, -1).join('/')}</small></span>${f.changed ? '<b>M</b>' : ''}</button>`).join('') || '<p class="muted file-empty">此 PR 没有额外上下文文件。</p>'}</div><div class="file-bottom">审查绑定当前快照。<br>上下文文件不会混入变更清单。</div></aside><section class="diff-pane" aria-label="Diff 与源码"><header class="diff-header"><strong title="${fileView.path}">${fileView.path}</strong>${!fileView.changed ? badge('关联上下文') : ''}<div class="segments">${[['diff', 'Diff'], ['source', '源码']].map(([id, title]) => `<button class="${pr.view.code === id ? 'selected' : ''}" data-action="code-mode" data-id="${id}">${title}</button>`).join('')}</div></header><div class="diff-caption"><span>${fileView.changed ? '变更片段 · 非完整仓库文件' : '只读上下文片段'}</span><span>${Object.keys(pr.patches).length ? '包含演示修复提交 · 未写入 GitHub' : '缓存示例代码'}</span></div><div class="code-scroll">${body}</div><footer class="diff-footer">${icon('branch')} ${esc(pr.head)}<span>示例代码 · 无真实文件写入</span></footer></section><aside class="review-pane"><header class="review-tabs"><button class="${pr.view.tab === 'findings' ? 'active' : ''}" data-action="right-tab" data-id="findings">${icon('alert')}审查发现 ${pr.findings.length}</button><button class="${pr.view.tab === 'chat' ? 'active' : ''}" data-action="right-tab" data-id="chat">${icon('message')}询问 AI</button></header><div class="review-scroll">${pr.view.tab === 'findings' ? findingList(pr) : chat(pr)}</div></aside></div></div>`;
  }
  function render() {
    const focused = document.activeElement, focusId = focused?.id;
    const selection = focused instanceof HTMLTextAreaElement || focused instanceof HTMLInputElement && ['search', 'text', 'url'].includes(focused.type) ? [focused.selectionStart, focused.selectionEnd] : null;
    const positions = Object.fromEntries(['.page', '.code-scroll', '.review-scroll', '.file-list'].map((key) => [key, document.querySelector(key)?.scrollTop || 0]));
    app.className = state.route === 'pr' ? 'focus-mode' : '';
    app.innerHTML = `${nav()}<div class="main-shell"><div class="demo-strip"><span><i></i>交互演示 · 虚构工作区，未连接模型或 GitHub</span><span>研究驱动产品探索</span></div><main id="main" tabindex="-1">${state.route === 'pr' ? reviewPage() : state.route === 'connections' ? connections() : state.route === 'history' ? history() : inbox()}</main></div>`;
    if (state.route === 'pr' && !current(active())) {
      document.querySelectorAll('.finding-actions [data-action="patch"],.finding-actions [data-action="confirm"],.finding-actions [data-action="dismiss"],.finding-actions [data-action="reopen-finding"]').forEach((button) => { button.disabled = true; });
    }
    if (state.route === 'pr' && !codeFiles(active()).find((f) => f.id === active().view.file).changed) {
      document.querySelector('[data-action="code-mode"][data-id="diff"]').disabled = true;
      document.querySelector('[data-action="code-mode"][data-id="diff"]').classList.remove('selected');
      document.querySelector('[data-action="code-mode"][data-id="source"]').classList.add('selected');
    }
    for (const [key, top] of Object.entries(positions)) { const el = document.querySelector(key); if (el) el.scrollTop = top; }
    if (focusId && document.getElementById(focusId)) {
      const el = document.getElementById(focusId); el.focus({ preventScroll: true });
      if (selection) el.setSelectionRange(...selection);
    }
  }
  function locate(line) {
    const pr = active(), finding = pr.findings.find((f) => f.id === pr.view.finding);
    const target = document.querySelector(`.code-row[data-line="${line ?? (finding?.file === pr.view.file ? finding.line : '')}"]:not(.del)`);
    const scroll = document.querySelector('.code-scroll');
    if (target && scroll) { scroll.querySelectorAll('.located').forEach((el) => el.classList.remove('located')); target.classList.add('located'); scroll.scrollTop += target.getBoundingClientRect().top - scroll.getBoundingClientRect().top - scroll.clientHeight / 3; }
    else if (scroll) scroll.scrollTop = 0;
  }
  async function runReview(id) {
    const pr = getPR(state, id);
    try { beginReview(state, id); } catch (error) { return notify(error.message); }
    const token = ++generation; runs.set(pr.id, token); render();
    for (let step = 0; step < 4; step++) {
      await new Promise((resolve) => setTimeout(resolve, 420));
      if (runs.get(pr.id) !== token) return;
      pr.review.stage = step;
      if (!dialog.open) render();
    }
    try { completeReview(pr); } catch (error) { pr.review.phase = 'stale'; runs.delete(pr.id); render(); return notify(error.message); }
    runs.delete(pr.id); render();
    notify(pr.review.phase === 'limited' ? '演示完成，但此快照或自定义上下文没有真实分析，覆盖受限。' : '预设审查完成；没有调用模型或执行真实测试。');
  }
  function patchDialog(pr, id) {
    const f = findingById(pr, id), source = codeFiles(pr).find((item) => item.id === f.file);
    if (!pr.patches[id]) requireCurrent(pr);
    const before = definition(pr).files.find((item) => item.id === f.file).rows.filter((r) => f.fix.some((e) => e.n === r.n) && r.kind !== 'del').map((r) => r.text).join('\n');
    modal('核对修复建议', `<p class="modal-intro">${definition(pr).repo} · PR ${definition(pr).number} · ${esc(pr.head)}</p><h3>${f.title}</h3><p>${source.path}</p><div class="patch-label">当前代码</div><pre class="patch before">${esc(before)}</pre><div class="patch-label">建议修改</div><pre class="patch after">${esc(f.fix.map((e) => e.text).join('\n'))}</pre><div class="notice"><strong>建议验证</strong><p>${f.tests}</p></div><p class="muted">继续只生成本原型中的演示提交，不访问 GitHub。提交后必须检查与复审，不能直接把建议当作正确修复。</p>`, `<button class="button" data-action="close">返回审查</button><button class="button primary" data-action="apply-patch" data-id="${id}" ${pr.patches[id] ? 'disabled' : ''}>${pr.patches[id] ? '此修复已提交到演示快照' : '生成演示提交'}</button>`);
    pendingPatch = { pr: pr.id, id, token: snapshotKey(pr) };
  }
  function publishDialog(pr) {
    const accepted = pr.findings.filter((f) => f.status === 'confirmed');
    const body = pr.notes ?? `审查 ${definition(pr).repo} PR ${definition(pr).number}（示例快照 ${pr.head}）。\n${accepted.length ? accepted.map((f) => `- ${f.title}：${f.summary}`).join('\n') : '当前没有采纳为评论的发现。'}\n\n边界：本次为离线预设审查，未执行真实模型分析或测试。`;
    modal('完成本次审查', `<form id="publish-form"><p class="modal-intro">${definition(pr).repo} · PR ${definition(pr).number} · 当前快照 ${esc(pr.head)}</p>${pr.notesKey && pr.notesKey !== snapshotKey(pr) ? '<div class="notice warning">以下草稿来自旧上下文，请核对后再记录。</div>' : ''}<label class="field-label" for="verdict">审查结论</label><select id="verdict"><option value="changes">要求修改</option><option value="comment">仅评论</option><option value="approve">通过</option></select><label class="field-label" for="review-body">审查摘要</label><textarea id="review-body" rows="8" required>${esc(body)}</textarea><div class="publish-comments"><strong>${accepted.length} 条采纳评论将随摘要记录</strong>${accepted.map((f) => `<p>${esc(f.title)} · ${codeFiles(pr).find((x) => x.id === f.file).path}:${f.line}</p>`).join('')}</div><p id="publish-reasons" class="notice warning" role="status" hidden></p><p class="muted">仅记录到当前页面的审查历史，不会发布到 GitHub，也不代表合并或远程批准。</p></form>`, '<button class="button" data-action="close">继续核对</button><button class="button primary" type="submit" form="publish-form">记录审查（演示）</button>');
    pendingPublish = snapshotKey(pr);
    refreshPublish();
  }
  function refreshPublish() {
    const reasons = publishGate(state, active(), document.getElementById('verdict').value, document.getElementById('review-body').value);
    const el = document.getElementById('publish-reasons'); el.textContent = reasons.join(' '); el.hidden = !reasons.length;
    document.querySelector('[form="publish-form"]').disabled = !!reasons.length;
  }
  function about() {
    modal('这套原型从哪里来', `<p class="modal-intro">唯一预设方向：AI 代码审查。Web 团队工作台是本轮调研后的设计选择，不继承旧原型的桌面形态、仓库首页或布局限制。</p><h3>采用的产品主线</h3><ol><li>PR 收件箱帮助确定先看什么。</li><li>在 Diff 内核查发现，并按需读取关联上下文。</li><li>把采纳、不采纳、建议修改和验证区分开。</li><li>审查记录绑定快照，新提交需要复审。</li></ol><h3>官方依据</h3><ul class="sources"><li><a href="https://docs.coderabbit.ai/overview/pull-request-review" target="_blank" rel="noreferrer">CodeRabbit：PR / 增量审查、上下文与建议</a></li><li><a href="https://docs.devin.ai/work-with-devin/devin-review" target="_blank" rel="noreferrer">Devin Review：Diff、发现、代码库问答与修复</a></li><li><a href="https://docs.github.com/en/copilot/how-tos/use-copilot-agents/use-code-review?tool=webui" target="_blank" rel="noreferrer">GitHub Copilot：请求审查、严重级别、建议与重新审查</a></li></ul><p class="muted">这些资料支持流程借鉴，不证明本原型的准确率。初始连接、PR、结果、问答、检查和发布均为虚构演示；内容仅保留在页面内存，刷新恢复初始示例。</p>`, '<button class="button" data-action="close">关闭</button><button class="button" data-action="reset-confirm">重置演示</button>');
  }
  document.addEventListener('click', (event) => {
    const button = event.target instanceof Element ? event.target.closest('[data-action]') : null;
    if (!button || button.disabled) return;
    if (button.tagName === 'A' && button.dataset.action) event.preventDefault();
    const { action, id } = button.dataset;
    try {
      if (action === 'close') { dialog.close(); pendingPatch = null; pendingPublish = null; return; }
      if (action === 'theme') { document.documentElement.dataset.theme = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light'; render(); return; }
      if (action === 'about') return about();
      if (action === 'route') { state.route = button.dataset.route; render(); return; }
      if (action === 'filter') { state.filter = id; render(); return; }
      if (action === 'open-pr') { getPR(state, id); state.active = id; state.route = 'pr'; render(); locate(); return; }
      if (action === 'record') {
        const record = state.records.find((r) => r.id === id);
        if (!record) throw new Error('这份审查记录已不存在。');
        return modal('历史审查 · ' + verdictLabel[record.verdict], `<p class="muted">快照 ${esc(record.key)} · ${new Date(record.at).toLocaleString('zh-CN')}</p><pre class="record-body">${esc(record.body)}</pre><p>${record.comments.length} 条采纳评论。历史记录不代表新快照已通过。</p>`);
      }
      if (action === 'connect') return modal('连接 GitHub · 演示授权', '<p>正式产品会通过 GitHub App 授权仓库访问。本原型不索取账号或令牌。</p><div class="notice">点击继续只恢复 Northstar 示例组织的连接。</div>', '<button class="button" data-action="close">取消</button><button class="button primary" data-action="connect-confirm">授权并连接示例组织</button>');
      if (action === 'connect-confirm') { changeConnection(state, true); dialog.close(); render(); notify('示例连接已恢复，没有发生真实授权。'); return; }
      if (action === 'disconnect') return modal('断开示例连接', '<p>缓存 PR、已填写的内容和审查记录会保留，但运行和发布将暂时不可用。</p>', '<button class="button" data-action="close">取消</button><button class="button" data-action="disconnect-confirm">确认断开</button>');
      if (action === 'disconnect-confirm') { changeConnection(state, false); dialog.close(); render(); return; }
      if (action === 'reset-confirm') return modal('重置当前演示', '<p>这会清除本页面内的输入、演示提交、聊天与记录，不影响真实仓库。</p>', '<button class="button" data-action="close">取消</button><button class="button primary" data-action="reset">确认重置</button>');
      if (action === 'reset') { runs.clear(); state = createState(); dialog.close(); render(); return; }
      const pr = active();
      if (action === 'run') return void runReview(pr.id);
      if (action === 'cancel-run') { cancelReview(pr); runs.delete(pr.id); render(); notify('已取消，未把中断流程标为成功。'); return; }
      if (action === 'context') return modal('审查上下文', `<form id="context-form"><h3>PR 原始意图</h3><p>${definition(pr).description}</p><ul>${definition(pr).checks.map((c) => `<li>${c}</li>`).join('')}</ul><label class="field-label" for="context-input">本次补充说明 · 可选</label><textarea id="context-input" rows="5" placeholder="说明业务约束、预期行为或需要核查的边界…">${esc(pr.context)}</textarea><p class="muted">自定义输入会使旧结果过期。本原型不能分析任意文本；带自定义上下文的演示会明确标记覆盖受限。</p></form>`, '<button class="button" data-action="close">取消</button><button class="button primary" type="submit" form="context-form">保存上下文</button>');
      if (action === 'file-tab') { pr.view.files = id; render(); return; }
      if (action === 'file') { if (!codeFiles(pr).some((f) => f.id === id)) throw new Error('当前快照没有此文件。'); pr.view.file = id; render(); locate(); return; }
      if (action === 'code-mode') { pr.view.code = id; render(); locate(); return; }
      if (action === 'right-tab') { pr.view.tab = id; render(); return; }
      if (action === 'finding') { const f = findingById(pr, id); pr.view.finding = id; pr.view.file = f.file; pr.view.files = 'changed'; render(); locate(f.line); return; }
      if (action === 'evidence') { const target = codeFiles(pr).find((f) => f.id === button.dataset.file); if (!target) throw new Error('关联文件不属于此快照。'); pr.view.file = target.id; pr.view.files = target.changed ? 'changed' : 'context'; render(); locate(Number(button.dataset.line)); return; }
      if (action === 'confirm' || action === 'reopen-finding') { decide(pr, id, action === 'confirm' ? 'confirmed' : 'open'); render(); return; }
      if (action === 'dismiss') return modal('记录不采纳的依据', `<form id="dismiss-form"><input type="hidden" name="finding" value="${id}"><label class="field-label" for="dismiss-reason">为什么这条发现不适用？</label><textarea id="dismiss-reason" required rows="5" placeholder="例如：上游已有哪个保障？适用范围在哪里？"></textarea><p class="muted">不采纳会保留原始发现与依据，不等同于代码已修复。</p></form>`, '<button class="button" data-action="close">取消</button><button class="button primary" type="submit" form="dismiss-form">记录不采纳</button>');
      if (action === 'patch') return patchDialog(pr, id);
      if (action === 'apply-patch') { connected(state, pr); if (!pendingPatch || pendingPatch.pr !== pr.id || pendingPatch.id !== id) throw new Error('修复预览已经失效。'); applyPatch(pr, id, pendingPatch.token); dialog.close(); pendingPatch = null; render(); locate(); notify('已生成演示提交，等待检查与复审；没有写入 GitHub。'); return; }
      if (action === 'validate') return modal('检查当前演示提交', `<form id="validate-form"><p>检查当前全部演示修复。下面的结果只驱动预设状态，不执行代码或 CI。</p><label class="field-label" for="validation-result">演示检查结果</label><select id="validation-result"><option value="passed">检查通过，随后复审</option><option value="failed">检查失败，保留问题与提交</option></select></form>`, '<button class="button" data-action="close">取消</button><button class="button primary" type="submit" form="validate-form">检查并复审（演示）</button>');
      if (action === 'undo') { undoPatch(pr, id); render(); notify('演示修复已撤销，当前快照需要重新审查。'); return; }
      if (action === 'new-snapshot') { updateSnapshot(pr); render(); notify('已更新演示快照，旧发现不可沿用；新快照没有预设分析。'); return; }
      if (action === 'publish') return publishDialog(pr);
      if (action === 'ask-preset') { answer(pr, button.dataset.question); render(); return; }
    } catch (error) { notify(error.message); }
  });
  document.addEventListener('input', (event) => {
    if (event.target.id === 'search') { state.search = event.target.value; render(); }
    if (event.target.id === 'chat-input') active().chatDraft = event.target.value;
    if (event.target.id === 'review-body') { active().notes = event.target.value; active().notesKey = snapshotKey(active()); refreshPublish(); }
  });
  document.addEventListener('change', (event) => {
    if (event.target.id === 'repo-filter') { state.repo = event.target.value; render(); }
    if (event.target.id === 'verdict') refreshPublish();
    if (event.target.name === 'enabled-repo') {
      try { toggleRepo(state, event.target.value, event.target.checked); } catch (error) { notify(error.message); }
      render();
    }
  });
  document.addEventListener('submit', (event) => {
    if (!(event.target instanceof HTMLFormElement)) return;
    event.preventDefault();
    const form = event.target;
    if (!form.reportValidity()) return;
    try {
      const pr = active();
      if (form.id === 'context-form') setContext(pr, document.getElementById('context-input').value);
      else if (form.id === 'dismiss-form') decide(pr, form.elements.namedItem('finding').value, 'dismissed', document.getElementById('dismiss-reason').value);
      else if (form.id === 'validate-form') { validatePatches(pr, document.getElementById('validation-result').value); dialog.close(); return void runReview(pr.id); }
      else if (form.id === 'publish-form') { publish(state, pr, document.getElementById('verdict').value, document.getElementById('review-body').value, pendingPublish); notify('审查已记录到本页历史，没有发布到 GitHub。'); }
      else if (form.id === 'chat-form') { answer(pr, document.getElementById('chat-input').value); pr.chatDraft = ''; render(); return; }
      else throw new Error('无法识别的表单，未保存。');
      dialog.close(); render();
    } catch (error) {
      let el = form.querySelector('.form-error');
      if (!el) { el = document.createElement('p'); el.className = 'form-error'; el.setAttribute('role', 'alert'); form.append(el); }
      el.textContent = error.message;
    }
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (dialog.open) { event.preventDefault(); dialog.close(); pendingPatch = null; pendingPublish = null; }
      else document.querySelectorAll('details[open]').forEach((el) => { el.open = false; });
    }
    if (event.key === 'j' && state.route === 'pr' && !dialog.open && event.target instanceof Element && !event.target.matches('input,textarea,select')) {
      const pr = active(), index = pr.findings.findIndex((f) => f.id === pr.view.finding), next = pr.findings[(index + 1) % pr.findings.length];
      if (next) { pr.view.finding = next.id; pr.view.file = next.file; pr.view.files = 'changed'; render(); locate(); }
    }
  });
  window.addEventListener('error', (event) => notify(`原型脚本错误：${event.message}`));
  window.addEventListener('unhandledrejection', (event) => notify(`操作失败：${String(event.reason)}`));
  render();
}());
