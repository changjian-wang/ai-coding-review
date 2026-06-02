import * as vscode from 'vscode';
import type {
  ArchitectureCheck,
  CallGraphNode,
  Finding,
  FindingSeverity,
  GlobalFixSpot,
  GlobalRecommendation,
  GlobalReport,
  GlobalVerdict,
  VerdictKind,
} from './types';

/** Raised when analysis cannot complete; message is user-facing. */
export class AnalysisError extends Error {}

const FILE_SYSTEM_PROMPT = `你是一名严格的资深代码审查员。审查给定源码文件的逻辑、正确性、并发与安全问题。
只输出 JSON，不要任何解释文字或 markdown 代码围栏。
JSON 结构：{"findings":[{"line":<1基行号>,"endLine":<可选>,"severity":"bug"|"conditional"|"suggestion","title":"简短标题","detail":"问题与证据","suggestion":"可选的修复建议"}]}
severity 含义：bug=确定缺陷；conditional=特定条件下才出问题；suggestion=可选改进。
没有问题就返回 {"findings":[]}。行号必须对应所给文件的真实行。`;

const GLOBAL_SYSTEM_PROMPT = `你是一名严格的资深代码审查员，负责跨文件的全局逻辑分析。
文件级审查只看单文件，会产生"如果/可能"级别的猜测。你的职责是用跨文件事实（DI 生命周期、调用图、架构层边界、PR 意图是否兑现）把这些猜测落地成"确证 / 推翻 / 新发现"。
只输出 JSON，不要任何解释文字或 markdown 代码围栏。
JSON 结构：
{
  "conclusion": "一句话跨文件结论",
  "recommendation": "approve" | "request_changes" | "comment",
  "evidence": ["按顺序的证据链步骤1", "步骤2", "步骤3"],
  "verdicts": [
    {
      "kind": "flip" | "found" | "confirmed",
      "title": "简短标题",
      "before": "文件级当初怎么说（片面判断）",
      "after": "跨文件事实确立了什么",
      "evidence": "具体代码/文件证据，如 Program.cs:47 AddScoped<...>",
      "file": "相对路径（可选，用于定位）",
      "line": <1基行号，可选>
    }
  ],
  "fixSpots": [
    {"file":"相对路径","line":<1基行号>,"severity":"bug"|"conditional"|"suggestion","title":"标题","detail":"说明","suggestion":"可选修复"}
  ],
  "callGraph": [
    {"name":"调用方/被调用方名称","role":"角色，如 Authentication 层 · 唯一调用方","lifetime":"如 Scoped","changed":true|false}
  ],
  "architectureChecks": [
    {"status":"ok"|"warn"|"info","label":"如 分层合规 / 意图覆盖 / 配置一致","detail":"说明与证据"}
  ]
}
verdict.kind 含义：flip=文件级判断被推翻（误报）；found=只有跨文件才看得到的真问题（文件级漏报）；confirmed=跨文件事实确证文件级判断成立。
callGraph 按 调用方→被调用方 顺序排列，体现真实调用链与生命周期；本次变更的节点 changed=true。
architectureChecks 覆盖 DDD 分层是否越层/反向依赖、配置键名是否一致、PR 声称意图是否兑现、测试现状。
若无跨文件问题，conclusion 说明无重大问题，recommendation 用 "approve"，verdicts/fixSpots 返回 []，callGraph/architectureChecks 仍尽量给出。`;

async function ask(
  model: vscode.LanguageModelChat,
  system: string,
  user: string,
  token: vscode.CancellationToken,
): Promise<string> {
  const messages = [
    vscode.LanguageModelChatMessage.User(system),
    vscode.LanguageModelChatMessage.User(user),
  ];
  let out = '';
  try {
    const response = await model.sendRequest(messages, {}, token);
    for await (const chunk of response.text) {
      out += chunk;
    }
  } catch (err) {
    if (err instanceof vscode.LanguageModelError) {
      throw new AnalysisError(`模型调用失败：${err.message}`);
    }
    throw err;
  }
  return out;
}

/** Translates arbitrary text to Simplified Chinese, returning the plain result. */
export async function translateToChinese(
  model: vscode.LanguageModelChat,
  text: string,
  token: vscode.CancellationToken,
): Promise<string> {
  const system = '你是专业的技术翻译。把用户给出的内容翻译成简洁、准确的简体中文，保留代码标识符与术语。只输出译文，不要任何解释、引号或 markdown 围栏。';
  const out = await ask(model, system, text, token);
  return out.trim();
}

/** Explains a snippet of code in Simplified Chinese, returning plain prose. */
export async function explainCode(
  model: vscode.LanguageModelChat,
  code: string,
  token: vscode.CancellationToken,
): Promise<string> {
  const system =
    '你是资深代码审查助手。用简体中文解释用户给出的这段代码：它做什么、关键逻辑/控制流、涉及的副作用或边界条件，以及可能值得注意的风险点。' +
    '语言简洁专业，可用短句或最多 3-5 条要点。只输出解释正文，不要复述原代码，不要 markdown 标题或代码围栏。';
  const out = await ask(model, system, code, token);
  return out.trim();
}

/** Strips markdown fences and parses the first JSON object in the text. */
function parseJson<T>(text: string): T {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    t = fence[1].trim();
  }
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start >= 0 && end > start) {
    t = t.slice(start, end + 1);
  }
  try {
    return JSON.parse(t) as T;
  } catch {
    throw new AnalysisError('无法解析模型返回的 JSON。');
  }
}

function normaliseSeverity(value: unknown): FindingSeverity {
  return value === 'bug' || value === 'conditional' || value === 'suggestion'
    ? value
    : 'suggestion';
}

function normaliseVerdictKind(value: unknown): VerdictKind {
  return value === 'flip' || value === 'found' || value === 'confirmed' ? value : 'confirmed';
}

function normaliseRecommendation(value: unknown): GlobalRecommendation {
  return value === 'approve' || value === 'request_changes' || value === 'comment'
    ? value
    : 'comment';
}

function numberifyLines(text: string): string {
  return text
    .split('\n')
    .map((line, i) => `${i + 1}\t${line}`)
    .join('\n');
}

/** Runs file-level analysis on a document, returning normalised findings. */
export async function analyzeFile(
  model: vscode.LanguageModelChat,
  document: vscode.TextDocument,
  token: vscode.CancellationToken,
): Promise<Finding[]> {
  const numbered = numberifyLines(document.getText());
  const user = `文件路径：${document.uri.fsPath}\n语言：${document.languageId}\n以下每行以「行号<TAB>内容」给出：\n\n${numbered}`;
  const raw = await ask(model, FILE_SYSTEM_PROMPT, user, token);
  const parsed = parseJson<{ findings?: unknown[] }>(raw);
  const list = Array.isArray(parsed.findings) ? parsed.findings : [];
  const lineCount = document.lineCount;
  return list.map((f, i) => {
    const o = f as Record<string, unknown>;
    const line = clampLine(Number(o.line) || 1, lineCount);
    return {
      id: `f${i}`,
      line,
      endLine: o.endLine ? clampLine(Number(o.endLine), lineCount) : undefined,
      severity: normaliseSeverity(o.severity),
      title: String(o.title ?? '未命名问题'),
      detail: String(o.detail ?? ''),
      suggestion: o.suggestion ? String(o.suggestion) : undefined,
    } satisfies Finding;
  });
}

/** Context fed to global analysis: each file plus its file-level findings. */
export interface GlobalContextFile {
  path: string;
  findings: Finding[];
  /** Full source text of the file, so the model can resolve cross-file facts. */
  content: string;
}

/** Caps per-file source sent to the model so a few large files can't blow the context. */
const MAX_FILE_CHARS = 16_000;

/** Caps the total source budget across all files in one global request. */
const MAX_TOTAL_CHARS = 120_000;

/** Runs cross-file global analysis over the review set. */
export async function analyzeGlobal(
  model: vscode.LanguageModelChat,
  files: GlobalContextFile[],
  token: vscode.CancellationToken,
): Promise<GlobalReport> {
  let budget = MAX_TOTAL_CHARS;
  const sections = files.map((f) => {
    const findings = f.findings.length
      ? f.findings.map((x) => `  - [${x.severity}] L${x.line} ${x.title}`).join('\n')
      : '  - （文件级未发现问题）';

    let source = f.content ?? '';
    let truncated = source.length > MAX_FILE_CHARS;
    if (truncated) {
      source = source.slice(0, MAX_FILE_CHARS);
    }
    if (source.length > budget) {
      source = source.slice(0, Math.max(0, budget));
      truncated = true;
    }
    budget -= source.length;

    const numbered = source ? numberifyLines(source) : '（源码不可用）';
    const note = truncated ? '\n…（源码因长度被截断）' : '';
    return `文件：${f.path}\n文件级发现：\n${findings}\n源码（行号<TAB>内容）：\n${numbered}${note}`;
  });
  const summary = sections.join('\n\n----\n\n');
  const user = `审查集共 ${files.length} 个文件。请基于下面每个文件的真实源码与文件级发现，给出跨文件的全局逻辑分析。务必依据源码中可见的事实（DI 注册、调用关系、配置键、分层依赖）作出判断，不要臆测。\n\n${summary}`;
  const raw = await ask(model, GLOBAL_SYSTEM_PROMPT, user, token);
  const parsed = parseJson<{
    conclusion?: string;
    recommendation?: string;
    evidence?: unknown[];
    verdicts?: unknown[];
    fixSpots?: unknown[];
    callGraph?: unknown[];
    architectureChecks?: unknown[];
  }>(raw);
  const fixSpots: GlobalFixSpot[] = (Array.isArray(parsed.fixSpots) ? parsed.fixSpots : []).map(
    (f, i) => {
      const o = f as Record<string, unknown>;
      return {
        id: `g${i}`,
        file: String(o.file ?? ''),
        line: Math.max(1, Number(o.line) || 1),
        severity: normaliseSeverity(o.severity),
        title: String(o.title ?? '未命名问题'),
        detail: String(o.detail ?? ''),
        suggestion: o.suggestion ? String(o.suggestion) : undefined,
      } satisfies GlobalFixSpot;
    },
  );
  const verdicts: GlobalVerdict[] = (Array.isArray(parsed.verdicts) ? parsed.verdicts : []).map(
    (v) => {
      const o = v as Record<string, unknown>;
      return {
        kind: normaliseVerdictKind(o.kind),
        title: String(o.title ?? '未命名判断'),
        before: String(o.before ?? ''),
        after: String(o.after ?? ''),
        evidence: o.evidence ? String(o.evidence) : undefined,
        file: o.file ? String(o.file) : undefined,
        line: o.line ? Math.max(1, Number(o.line)) : undefined,
      } satisfies GlobalVerdict;
    },
  );
  return {
    conclusion: String(parsed.conclusion ?? '无重大跨文件问题。'),
    recommendation: normaliseRecommendation(parsed.recommendation),
    evidence: (Array.isArray(parsed.evidence) ? parsed.evidence : []).map((e) => String(e)),
    verdicts,
    fixSpots,
    callGraph: (Array.isArray(parsed.callGraph) ? parsed.callGraph : []).map((c) => {
      const o = c as Record<string, unknown>;
      return {
        name: String(o.name ?? '?'),
        role: o.role ? String(o.role) : undefined,
        lifetime: o.lifetime ? String(o.lifetime) : undefined,
        changed: o.changed === true,
      } satisfies CallGraphNode;
    }),
    architectureChecks: (Array.isArray(parsed.architectureChecks)
      ? parsed.architectureChecks
      : []
    ).map((a) => {
      const o = a as Record<string, unknown>;
      const status = o.status === 'ok' || o.status === 'warn' || o.status === 'info'
        ? o.status
        : 'info';
      return {
        status,
        label: String(o.label ?? '检查'),
        detail: String(o.detail ?? ''),
      } satisfies ArchitectureCheck;
    }),
  };
}

function clampLine(line: number, max: number): number {
  if (!Number.isFinite(line) || line < 1) {
    return 1;
  }
  return Math.min(Math.floor(line), Math.max(1, max));
}

const DIFF_SYSTEM_PROMPT = `你是一名资深工程师，为指定的修复落点生成一个可直接套用的统一 diff（unified diff）。
只输出 diff 文本，使用标准 \`---\`/\`+++\`/\`@@\` 头与 +/- 行，不要任何解释、不要 markdown 代码围栏。
保持改动最小、聚焦本问题，行号尽量贴合给定源码。`;

/** Generates a candidate unified diff for a fix spot, given the file content. */
export async function generateFixDiff(
  model: vscode.LanguageModelChat,
  fileRelPath: string,
  fileContent: string,
  fix: { title: string; detail: string; suggestion?: string; line: number },
  token: vscode.CancellationToken,
): Promise<string> {
  const user = `文件：${fileRelPath}
修复落点：${fix.title}（第 ${fix.line} 行附近）
问题说明：${fix.detail}
${fix.suggestion ? `建议方向：${fix.suggestion}\n` : ''}
完整源码如下：

${fileContent}

请生成针对该文件的统一 diff。`;
  const raw = await ask(model, DIFF_SYSTEM_PROMPT, user, token);
  let t = raw.trim();
  const fence = t.match(/```(?:diff|patch)?\s*([\s\S]*?)```/i);
  if (fence) {
    t = fence[1].trim();
  }
  return t;
}
