# AI Coding Review

> 不信任驱动的代码审查：**每一行都必须被看过**。把 “Review = 不信任” 做成硬门禁——逐行通读 + 以每个文件为入口的仓库分析 + 逐条处置确认问题 + 跨文件全局分析，全部完成才允许给出审查结论。

[![VS Marketplace Version](https://img.shields.io/visual-studio-marketplace/v/changjian-wang.ai-coding-review?label=Marketplace&color=blue)](https://marketplace.visualstudio.com/items?itemName=changjian-wang.ai-coding-review)
[![Installs](https://img.shields.io/visual-studio-marketplace/i/changjian-wang.ai-coding-review)](https://marketplace.visualstudio.com/items?itemName=changjian-wang.ai-coding-review)
[![Rating](https://img.shields.io/visual-studio-marketplace/r/changjian-wang.ai-coding-review)](https://marketplace.visualstudio.com/items?itemName=changjian-wang.ai-coding-review)

VS Code 扩展 · 由 GitHub CLI 与 Copilot 模型驱动

[English](README.md) | 简体中文

<img src="https://raw.githubusercontent.com/changjian-wang/ai-coding-review/main/docs/images/workbench-zh.png" width="820" alt="代码审查工作台" />

## 核心理念

- **审查即不信任**：默认作者会犯错，门禁不通过就不允许下结论。
- **逐行覆盖是真实的**：基于 VS Code 真实编辑器 + 可见区域追踪（`visibleRanges`）判断「眼睛真的扫过」，不是假滚动；进度绑定 `headSha`——作者一旦 push 新 commit，旧覆盖立即失效。
- **AI 是副驾不是法官**：模型给出 findings 与修复方案，是否采纳由人逐条处置（修复 / 评论 / 忽略并写理由）。
- **原生优先**：状态栏、装饰、诊断用 VS Code 原生能力；审查工作台、文档查看、修复方案、全局报告这些富文本交互用 Webview。

## 功能特性

### 审查范围（workspace-first）

- 新准备页先选择本地 Repository，再选择 PR、分支变更/比较基线或分支全量快照；可选择已打开的仓库或明确打开另一个本地仓库。
- PR 和分支范围固定到实际提交；源码、Diff 和关联证据读取所选 Git 对象，不隐式 checkout、stash 或覆盖工作树。PR 对象本地缺失时按所选 GitHub PR 获取对象；失败会显式报错。
- 分支全量读取该提交的文件清单，不把未提交、未跟踪或其他分支的文件混进快照。二进制、非 UTF-8、链接及子模块不可作为普通文本读取，会明确报告，不伪装成功。
- 本地文件/文件夹审查仍通过树形选择器提供，范围锁定项目根并自动跳过 `node_modules / .git / dist / out / bin / obj / .vs` 等目录；该模式读取工作树及已打开的未保存内容。
- 不可变快照禁止直接对另一份工作树应用/撤销修复。需要编辑时明确切换到本地文件审查；修复交付到 PR head 的正式闭环将在后续阶段接入。
- 仓库状态按规范路径身份隔离，快照状态进一步按提交、基线及范围隔离。同名目录不共享审查；无法核实仓库身份的旧目录名历史独立保留，可通过提示查看归档，不自动继承旧批准或旧补丁。

开发状态：当前已接入 [Review vNext 开发计划](docs/REVIEW-VNEXT-IMPLEMENTATION-PLAN.zh-CN.md)的范围基础、M2 需求准备、M3 需求感知审查及 M4 审查中心，并非整个 vNext 已交付。Reviewer 反馈同步、Reply/Resolve 和真实模型语义评测仍待完成。快照证据使用有界检索，不调用另一分支的语言服务。

### 需求准备（M2）

- 新窗口入口直接显示准备页，不再额外打开一个“发现文件”的工作台标签等待用户选择。确认后沿用同一面板进入审查中心，取消不会激活新的审查范围。
- **选择其他本地仓库**用于选择电脑上已有的 Git 目录，不会克隆仓库或另开 VS Code 窗口。旁边的按钮按当前对象刷新 PR 列表或仓库/分支，只有加载失败后才显示**重试加载**，与 AI 需求理解的重试分开。
- 正式准备页保留三块：Repository 与 PR/分支、需求依据、AI 对本次需求的理解。支持粘贴 Markdown、本地 UTF-8 Markdown/TXT，以及明确提供的公开 HTTP/HTTPS 文本/HTML、GitHub Issue/PR 正文和 Markdown/TXT 文件链接。
- GitHub 读取沿用所选仓库账号；普通网页不发送浏览器 Cookie 或第三方凭据，不执行页面脚本。私网/本地地址、跨源跳转、不支持格式、权限和读取失败明确报错；PDF、Word、登录页或依赖客户端渲染的正文应转换或粘贴，不伪装成已读取需求。
- 选中材料会发送给所选 Copilot 模型，整理目标、明确要求、推导检查点和待核实前提；结构与原文版本、行号、逐字引用必须有效，否则不接受本次理解。原文及工作区内的历史快照与人工修订分开保存。
- 不要求逐条勾选或给整份材料分类，一次确认绑定当时的 Repository、head/base 和材料版本。材料/范围变化使旧确认失效；本地文件会在整理和确认前重新核对，链接按明确读取的快照保留，可手动重新读取。
- Markdown 编辑/预览与带出处原文可查看；HTML 不执行，图片不自动加载。源文件和链接的原文只读，需要修正理解时修改条目，需要更新原文时重新读取；手动粘贴内容可直接编辑。
- 模型失败、取消或无可用模型时保留材料，既不自动确认，也不从代码反推需求。需要继续时可明确选择“仅技术审查”；这不会清除既有代码问题，仍须满足技术门禁。
- 每份材料最多 512,000 字节，最多 12 份；模型输入还受 120,000 字符及实际模型 Token 上限约束。超限显式报告，不静默截断。

**确认只确立意图与范围，不代表需求正确或已经满足。** 确认后现已自动启动 M3；当前业务审查形成有效结论前，需求一致性仍未评审，旧逐文件/全局分析不能代替此流程。

### 需求感知业务审查（M3 开发切片）

- 一次确认或工作台的一键入口完成业务分组、完整源码分段、独立全局发现、契约/反证补充、候选复核与逐需求/前提评估，不依赖逐文件打开或滚动。
- 记录真实源码区间、旧/新侧、哈希和逐字引用；新增文件不虚构旧侧，删除/重命名按原路径读取基线。缺失事实保持未知，上游保障可以推翻局部疑点，错误需求前提单独归为需求缺陷。
- 旧关键问题跨重试、技术模式和需求标识变化保留；处置说明、模型一致、再次确认或重新上传相同规范文本都不能清除它，必须由独立的当前事实澄清。
- 取消、错误、输入变化与预算受限保留未完成结果；仅精确输入、捕获的输出语言、模型版本与提示词版本相同的已完成调用可复用。恢复时不把中断运行当完成，使用结论前重新检查分支/PR 端点、代码与本地需求文件。
- 批准要求源码覆盖和全局流程完整、没有流程限制/错误、没有证据成立的缺陷或决定性未决，并明确核对报告。非关键未知不自动阻断批准，但不能表述为已满足；有效部分结果仍可用于评论或要求修改。
- 报告支持查看引用快照与本地 Markdown 导出。结论草稿初始仅含有界的覆盖/状态摘要，明确操作后才追加具体发现，不自动附加私有原文与完整源码引文。发布发送已保存并实际展示预览的正文和行内评论，不重新生成摘要；迟到回执不能批准新版草稿或新一轮业务报告。
- 分析内核预算：80 个正式文件、24 个单元、每段 16,000 字符、单次输入 100,000 字符、24 次证据请求/关联文件、80 个候选、128 次模型调用及 180 秒；另受实际模型 Token 容量约束。启动/提交的新鲜度核对属于独立 I/O。超限明确说明，不代表已完成全仓审查。

以上是源码/契约推理，不执行测试或生产调用。受控模型样例验证的是编排与门禁，**不代表真实 Copilot 准确率**；独立语义评测仍属于 M0/M7。

### 审查中心（M4 开发切片）

- 准备 → 审查 → 结论三阶段。审查阶段在一个 Webview 中呈现业务/发现/PR 反馈/文件导航、复用的源码/Diff/Markdown 阅读器，以及判断/证据/处置侧栏。
- 阅读关联文件或证据原文保留当前问题，可直接返回审查概览；只读引文不增加正式审查覆盖。窄屏提供导航/判断抽屉，支持专注源码与 F8 切换问题。
- 编辑 Markdown 正文和结论，保存并预览实际正文及冻结的行内评论后，再发布 GitHub Review 或记录本地结论。保存不等于已经预览；正文应用上限为 60,000 字符，超限保留可编辑内容，不截断。
- 草稿和回执绑定范围、需求、分析及草稿修订。宿主阻止忙碌/过期输入、并发或重复发布；写入结果未知时，必须明确核对远端后才允许重试，这不代表系统已自动对账。
- 本地工作树业务修复在多个已审查文件中明确选择单文件目标，不把第一条证据当作必须修改的位置。应用补丁只使报告过期，不认定缺陷解决；已有缓存仍可查看/撤销，生成或应用新修复需要当前有效审查。
- 真实窗口重启后恢复导航、阅读来源及已保存草稿；隐藏的旧预览不继承发布确认。异步注释/评论绑定原快照和源码哈希，不写入后来切换的范围。
- PR 反馈明确显示既有 Reviewer 讨论尚未读取；同步与 Reply/Resolve 属于 M5/M6，不用“零条评论”冒充已读取。
- 可弹出到独立窗口（类似 “Open in Agents Window”）
- **Token 统计（估算）**：HUD 一行展示估算的 LLM token（↑输入 ↓输出），hover 看按操作分桶明细，随审查累计并持久化；由 `countTokens` 本地估算，非服务商计费 token

### 逐文件审查（旧技术工具）

- PR 等差异范围默认打开不折叠的完整文件行内 Diff，显示新旧双行号和新增/删除行；可随时切回干净的 HEAD 文件
- 逐行覆盖追踪与「跳到下一处未读行」
- **基于此文件分析**：在明确的递归深度、文件数、Token 和时间预算内，递归追踪相关实现、调用方、配置与测试
- 每个候选 Bug 都会基于同一份仓库上下文再由模型独立复核；只有确认 Bug 会显示，已推翻或证据不足的候选只进入完成统计
- 确认 Bug 可落在相关文件；若该文件不在当前范围，会自动加入审查并要求正常完成审查
- 每条可操作 finding 必须处置：**已修复 / 已评论 / 已忽略（需理由）**
- 修复方案：Copilot 生成互斥的「多处编辑 = 一个完整方案」候选，一键应用 + 一键撤销，应用快照持久化
- **修复前补充信息**：当模型对某条 finding 判断偏了，在修复面板里写一段补充说明；生成方案时它优先于原 finding，且按 finding 持久化
- 选区翻译 / 代码讲解标注

### 全局分析（旧技术工具）

- 跨文件逻辑分析，可限定到选定目录
- 独立的全局报告 Webview

### 门禁与结论

- 业务审查批准要求源码覆盖和全局流程完整且有效、没有确认缺陷或决定性未知，并明确核对报告。有效部分结果可用于有边界的评论或要求修改，不能完整批准。
- 结论：通过（Approve） / 要求修改（Request Changes） / 仅评论（Comment）
- 所有提交入口先打开结论编辑和实际预览；确认并检查新鲜度后，PR 通过 GitHub CLI 写回，其他范围本地记录。

## 门禁模型

```text
业务批准 = 当前源码覆盖与流程完整
           && 没有确认缺陷 / 决定性未知
           && 已核对报告
旧技术门禁 = 所有文件就绪 && 全局分析已确认
旧文件就绪 = 已分析 && 所有可操作 finding 已处置
```

旧技术门禁仅用于尚未采用业务审查结果的情况，不能证明需求已满足。逐行阅读进度只是辅助信号，不证明业务正确；处置说明、评论或未经验证的补丁不会消除业务缺陷。

## 语言（双语）

AI Coding Review 全面双语（English / 简体中文），**默认英文**。

- `codereview.language` 驱动**整体体验**——既包括扩展 UI（状态栏、提示、Webview 面板），也包括所有 LLM 输出（findings、修复方案、讲解、全局结论）。
  - `en`（默认）：全部英文
  - `zh-CN`：全部简体中文
  - `auto`：跟随 VS Code 显示语言
- 切换设置**实时生效**——状态栏与已打开的 Webview 面板立即重渲染，无需重载。
- 命令面板中的命令标题跟随 **VS Code 显示语言**（静态贡献点的平台限制），通过 `package.nls` 本地化。

## 命令与配置

### 命令

| 命令 | 说明 |
|------|------|
| `codereview.openOrStart` | 打开或开始审查（状态栏入口） |
| `codereview.openInNewWindow` | 在独立窗口打开审查工作台 |
| `codereview.startReview` | 选择范围并开始审查 |
| `codereview.openWorkbench` | 打开审查工作台 |
| `codereview.analyzeFile` | 以当前文件为入口分析相关仓库行为 |
| `codereview.globalAnalysis` | 运行全局分析 |
| `codereview.showGlobalReport` | 查看全局报告 |
| `codereview.submitConclusion` | 打开结论编辑和实际发布预览 |
| `codereview.jumpToNextUnseen` | 跳到下一处未读行 |
| `codereview.pickModel` | 选择分析模型 |
| `codereview.pickLanguage` | 切换体验语言（UI + LLM 输出） |

### 配置

| 配置项 | 默认 | 说明 |
|--------|------|------|
| `codereview.language` | `en` | 整体体验（UI + LLM 输出）的语言：`en` / `zh-CN` / `auto` |
| `codereview.focusedWorkbench` | `false` | 打开工作台时隐藏侧栏 / 活动栏占满主编辑区，关闭后恢复 |
| `codereview.repositoryAwareAnalysis` | `auto` | `auto` 递归构建相关仓库上下文并自行复核候选 Bug；`off` 保留旧单文件行为 |
| `codereview.repositoryContextTokenBudget` | `28000` | 仓库上下文最大估算输入 Token；超限时优先移除较低价值的相关片段 |

## 架构分层

```text
src/
  extension.ts          激活入口、命令注册、编排、门禁
  i18n/                 语言解析器 + 中英文消息 catalog
  gh/                   GitHub CLI 封装（auth / pr view / pr diff / 写回 review）
  scope/                审查范围：PR / 分支对比 / 工作树 / 文件选择 + 树形选择器 Webview
  review/               审查会话模型 + 持久化（ReviewStore 抽象）
  ai/                   模型选择 + 文件级 / 全局分析 + 修复方案 + 语言指令
  ui/                   工作台 / 文档 / 修复方案 / 全局报告 Webview + 状态栏 / toast / 进度
```

## 持久化

- `workspaceState`（本机），按 `repo + scopeId + headSha` 存。
- 已应用的修复快照持久化，重载后「撤销修复」与「定位」仍可用。
- 进度绑定 `headSha`：作者 push 新 commit 后旧覆盖失效。
- 注意：`workspaceState` **不跟随 GitHub 账号、不跨设备**；跨设备能力通过 `ReviewStore` 接口预留，将来由远端实现提供。

## 模型与语言

- 通过 VS Code Language Model API 列出当前 Copilot 授权的模型，支持 `Auto`，按工作区记住选择。
- `codereview.language` 控制整体体验（UI + 所有 LLM 输出）的语言；详见上文[语言](#语言双语)。

## 开发与打包

```bash
npm install
npm run compile            # 或 npm run watch；按 F5 启动扩展开发宿主
npm test                   # 运行单元测试（vitest）
npm run package            # 生产构建（esbuild --production）
npx @vscode/vsce package   # 生成 .vsix
```

PR 范围与写回 PR 需要本机已安装并登录 GitHub CLI：`gh auth login`。

## 路线图

- [ ] 跨设备 / 跟随账号的审查进度（远端 `ReviewStore` 实现）。
