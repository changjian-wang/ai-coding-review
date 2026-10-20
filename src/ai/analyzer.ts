import * as vscode from 'vscode';
import {
  findingContentSignatures,
  globalFixSpotSignatures,
} from './types';
import type {
  Finding,
  FindingSeverity,
  CandidateEvidenceBundle,
  CandidateVerification,
  EvidenceQuery,
  EvidenceQueryKind,
  FileAnalysisResult,
  FileFindingCandidate,
  FindingEvidenceRef,
  RepositoryAnalysisContext,
  RootedFileAnalysisResult,
  RootedFindingCandidate,
  GlobalFixSpot,
  GlobalRecommendation,
  GlobalReport,
  GlobalVerdict,
  VerdictKind,
} from './types';
import { getOutputLanguage, languageDirective, type OutputLanguage } from './lang';
import { m } from '../i18n';

/** Raised when analysis cannot complete; message is user-facing. */
export class AnalysisError extends Error {}

/** The kind of LLM operation, used to bucket token usage by purpose. */
type LlmOp = 'analyze' | 'verify' | 'global' | 'fix' | 'diff' | 'translate' | 'explain';

/** A single LLM call's estimated token usage. Estimated locally via `countTokens`. */
export interface TokenUsage {
  op: LlmOp;
  /** Estimated input tokens (system + user). */
  input: number;
  /** Estimated output tokens. */
  output: number;
}

/**
 * Optional sink that receives an estimated token-usage record after each LLM
 * call. Wired by the host (extension.ts) so usage can be accumulated on the
 * review session. Estimation uses `model.countTokens`, so totals are an
 * approximation — they are NOT the provider's billed token counts.
 */
type TokenUsageSink = (usage: TokenUsage) => void;

let usageSink: TokenUsageSink | undefined;

/** Registers the token-usage sink. Pass `undefined` to detach. */
export function setTokenUsageSink(sink: TokenUsageSink | undefined): void {
  usageSink = sink;
}

/**
 * Best-effort token estimate for a string against the given model. Returns 0 on
 * any failure (countTokens can throw / be unavailable) so accounting never
 * breaks the primary analysis flow.
 */
async function estimateTokens(model: vscode.LanguageModelChat, text: string): Promise<number> {
  try {
    return await model.countTokens(text);
  } catch {
    return 0;
  }
}


const FILE_SYSTEM_PROMPT_ZH = `你是一名严格、证据优先的资深代码审查员。第一阶段只审查给定源码文件的逻辑、正确性、并发与安全问题。
只输出 JSON，不要任何解释文字或 markdown 代码围栏。
JSON 结构：{"findings":[{"line":<1基行号>,"endLine":<可选>,"anchor":"问题所在的原始代码片段（逐字、不含行号前缀，连续一到数行且在文件中能唯一定位）","severity":"bug"|"conditional"|"suggestion","title":"简短标题","detail":"问题与当前文件内证据","suggestion":"可选的修复建议","requiresRepoContext":true|false,"evidenceQueries":[{"kind":"definition"|"references"|"tests"|"configuration"|"contract","symbol":"要解析的准确标识符","question":"仓库证据必须回答的具体问题"}]}]}
severity 含义：bug=确定缺陷；conditional=特定条件下才出问题；suggestion=可选改进。
title 必填：一句话概括问题本身（≤8 字为佳），不得为空、不得用“问题”“缺陷”等笼统占位词。
anchor 必须逐字摘自源码（去掉「行号<TAB>」前缀），用于按内容定位，请尽量唯一；如确实无法给出就省略。
证据规则：
- 只有当前文件本身能证明的判断，requiresRepoContext 才能为 false，evidenceQueries 返回 []。
- 如果判断依赖外部方法的返回值、类型定义、调用方、配置 Schema/默认值、生命周期或测试契约，必须设置 requiresRepoContext=true，并给出至少一个精确查询。不得把“外部实现可能有问题”直接上报为已成立缺陷。
- conditional 也必须有当前文件内可见的具体触发路径；仅仅因为看不到外部契约，不得产生 conditional。
- 不要假设外部符号的行为；后续阶段会读取仓库证据并裁决。
没有问题就返回 {"findings":[]}。行号必须对应所给文件的真实行。`;

const FILE_SYSTEM_PROMPT_EN = `You are a strict, evidence-first senior code reviewer. This first pass reviews only the supplied source file for logic, correctness, concurrency, and security issues.
Output JSON only. Do not output explanations or markdown code fences.
JSON schema: {"findings":[{"line":<1-based line>,"endLine":<optional>,"anchor":"verbatim code snippet from the issue location (exact text, no line-number prefix, one or more contiguous lines, ideally uniquely locatable in file)","severity":"bug"|"conditional"|"suggestion","title":"short title","detail":"issue and evidence visible in this file","suggestion":"optional fix advice","requiresRepoContext":true|false,"evidenceQueries":[{"kind":"definition"|"references"|"tests"|"configuration"|"contract","symbol":"exact identifier to resolve","question":"specific contract question repository evidence must answer"}]}]}
Severity meaning: bug=definite defect; conditional=problem under specific conditions; suggestion=optional improvement.
title is required: one concise sentence about the issue itself; never empty and never generic placeholders.
anchor must be copied verbatim from source (without the "line<TAB>" prefix) for content-based locating; omit only if truly impossible.
Evidence rules:
- Set requiresRepoContext=false only when the current file itself proves the claim; then evidenceQueries must be [].
- If the claim depends on an external return value, type definition, caller, configuration schema/default, lifecycle, or test contract, set requiresRepoContext=true and provide at least one precise query. Never report "the external implementation might be wrong" as an established defect.
- A conditional finding still needs a concrete trigger visible in this file. Missing external context alone is not a conditional finding.
- Do not assume external symbol behavior; a later pass will collect repository evidence and adjudicate the candidate.
If there are no issues, return {"findings":[]}. Line numbers must match the real file lines.`;

const VERIFY_FINDINGS_SYSTEM_PROMPT_ZH = `你是代码审查的仓库证据裁决阶段。输入包含第一阶段候选问题，以及从本地仓库提取的、带稳定 evidenceId 的源码证据。
只能依据输入中提供的证据裁决，不得依赖常识猜测，不得产生新问题。
只输出 JSON，不要解释文字或 markdown 围栏：
{"results":[{"candidateId":"c0","status":"confirmed"|"dismissed"|"unresolved","rationale":"简明证据结论","evidenceIds":["c0-e0"]}]}
规则：
- confirmed：仓库证据直接支持候选问题成立。
- dismissed：仓库证据直接推翻候选问题。
- unresolved：证据缺失、冲突、截断，或无法确认真实契约。
- confirmed/dismissed 必须引用至少一个输入中存在的 evidenceId；否则必须 unresolved。
- 每个输入 candidateId 必须恰好返回一项。`;

const VERIFY_FINDINGS_SYSTEM_PROMPT_EN = `You adjudicate code-review candidates using repository evidence. The input contains first-pass candidates and local repository excerpts with stable evidenceId values.
Use only the supplied evidence. Do not rely on unsupported assumptions and do not invent new findings.
Output JSON only, with no explanation or markdown fence:
{"results":[{"candidateId":"c0","status":"confirmed"|"dismissed"|"unresolved","rationale":"concise evidence-based conclusion","evidenceIds":["c0-e0"]}]}
Rules:
- confirmed: repository evidence directly supports the candidate.
- dismissed: repository evidence directly disproves the candidate.
- unresolved: evidence is missing, conflicting, truncated, or insufficient to establish the contract.
- confirmed/dismissed must cite at least one supplied evidenceId; otherwise use unresolved.
- Return exactly one result for every input candidateId.`;

const ROOTED_ANALYSIS_SYSTEM_PROMPT_ZH = `你是一名证据优先的资深代码审查员。请以入口文件为根，结合提供的相关实现、调用方、配置和测试，分析这条功能链路的真实行为。
目标是精准找出真实 Bug，而不是列出防御性建议、代码风格问题或“外部实现可能有问题”的猜测。
只输出 JSON，不要解释文字或 markdown 围栏：
{"findings":[{"file":"证据中存在的仓库相对路径","line":<1基行号>,"endLine":<可选>,"anchor":"问题位置逐字源码片段","severity":"bug"|"conditional","title":"简短标题","detail":"具体失败机制、触发路径与影响","suggestion":"可选最小修复方向","evidenceIds":["ctx-0","ctx-1"]}]}
规则：
- 从入口文件出发追踪数据流、控制流、调用关系、返回契约、配置默认值、并发/异步边界和相关测试。
- finding 可落在任意提供的相关文件，但必须与入口文件可达的行为有关，不得顺手审查无关代码。
- 每个候选至少引用一个输入中存在的 evidenceId；file、line、anchor 必须与该证据一致。
- bug 表示证据直接证明会失败；conditional 表示证据直接证明在明确条件下会失败。证据不足时不要输出。
- 测试仅证明已覆盖的行为，不自动证明所有边界安全；同时也要用测试和实现推翻误报。
- 若上下文被预算截断，只根据可见证据判断，不得补全或猜测。
- 没有可证实候选时返回 {"findings":[]}。`;

const ROOTED_ANALYSIS_SYSTEM_PROMPT_EN = `You are an evidence-first senior code reviewer. Starting from the root file, use the supplied related implementations, callers, configuration, and tests to analyze the real end-to-end behavior.
Find precise, real bugs—not defensive suggestions, style issues, or guesses that an unseen implementation might be wrong.
Output JSON only, with no explanation or markdown fence:
{"findings":[{"file":"repository-relative path present in evidence","line":<1-based line>,"endLine":<optional>,"anchor":"verbatim source at the issue location","severity":"bug"|"conditional","title":"short title","detail":"concrete failure mechanism, trigger path, and impact","suggestion":"optional minimal fix direction","evidenceIds":["ctx-0","ctx-1"]}]}
Rules:
- Trace data flow, control flow, calls, return contracts, configuration defaults, async/concurrency boundaries, and relevant tests from the root file.
- A finding may land in any supplied related file, but it must affect behavior reachable from the root; do not review unrelated code opportunistically.
- Every candidate must cite at least one supplied evidenceId; file, line, and anchor must agree with that evidence.
- bug means the evidence directly proves failure; conditional means the evidence directly proves failure under an explicit condition. Do not output evidence-insufficient candidates.
- Tests prove only covered behavior; use implementation and tests both to confirm bugs and disprove false positives.
- If context was budget-truncated, reason only from visible evidence and never fill gaps by assumption.
- Return {"findings":[]} when there are no supportable candidates.`;

const ROOTED_VERIFY_SYSTEM_PROMPT_ZH = `你是独立的代码审查复核员。请对第一阶段的每个候选进行对抗式复核：优先寻找反证、已有保护、调用约束、配置保证和测试契约，只有无法被这些事实推翻且失败路径完整时才确认。
只能使用输入中提供的仓库证据，不得产生新问题。
只输出 JSON：
{"results":[{"candidateId":"c0","status":"confirmed"|"dismissed"|"unresolved","rationale":"复核结论","evidenceIds":["ctx-0"]}]}
规则：
- confirmed：证据证明入口文件可达的完整失败链路，必须引用至少一个有效 evidenceId。
- dismissed：实现、调用约束、配置或测试直接推翻候选，必须引用至少一个有效 evidenceId。
- unresolved：证据冲突、缺失、截断，或无法完成失败链路证明。
- 逐项核对 file/line/anchor 是否真实存在；位置或证据不一致不得 confirmed。
- 每个 candidateId 恰好返回一项。`;

const ROOTED_VERIFY_SYSTEM_PROMPT_EN = `You are an independent code-review verifier. Adversarially review every first-pass candidate: actively look for counter-evidence, existing guards, caller constraints, configuration guarantees, and tested contracts. Confirm only when a complete reachable failure path survives that challenge.
Use only the supplied repository evidence and do not invent new findings.
Output JSON only:
{"results":[{"candidateId":"c0","status":"confirmed"|"dismissed"|"unresolved","rationale":"verification conclusion","evidenceIds":["ctx-0"]}]}
Rules:
- confirmed: evidence proves a complete failure path reachable from the root file and cites at least one valid evidenceId.
- dismissed: implementation, caller constraints, configuration, or tests directly disprove the candidate and cite at least one valid evidenceId.
- unresolved: evidence is missing, conflicting, truncated, or cannot establish the full failure path.
- Verify that file/line/anchor actually match supplied evidence; mismatched locations cannot be confirmed.
- Return exactly one result per candidateId.`;

const GLOBAL_SYSTEM_PROMPT_ZH = `你是一名严格的资深代码审查员，负责跨文件的全局逻辑分析。
文件级审查只看单文件，会产生"如果/可能"级别的猜测。你的职责是用跨文件事实（DI 生命周期、调用图、架构层边界、PR 意图是否兑现）把这些猜测落地成"确证 / 推翻 / 新发现"。
只输出 JSON，不要任何解释文字或 markdown 代码围栏。
JSON 结构：
{
  "conclusion": "一句话整体风险表态：点明这批改动能否放心提交，以及最大的残余风险点",
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
      "line": <1基行号，可选>,
      "findingRef": "输入中给出的稳定 findingRef（flip/confirmed 必填）"
    }
  ],
  "fixSpots": [
    {"file":"相对路径","line":<1基行号>,"anchor":"问题位置逐字源码片段","severity":"bug"|"conditional"|"suggestion","title":"标题","detail":"说明","suggestion":"可选修复"}
  ]
}
verdict.kind 含义：flip=文件级判断被推翻（误报）；found=只有跨文件才看得到的真问题（文件级漏报）；confirmed=跨文件事实确证文件级判断成立。
flip/confirmed 必须原样返回对应文件级发现的 findingRef；不得使用位置型 id 或自行编造引用。
fixSpot.anchor 必须逐字摘自对应文件源码（不含行号），用于跨次分析稳定识别；确实无法提供时才省略。
所有 title 必填：verdict 与 fixSpot 的 title 都要一句话概括该项本身，不得为空、不得用笼统占位词。
recommendation 是 AI 对这批改动的整体表态：approve=可放心提交；request_changes=存在应先处理的问题；comment=有保留意见但不阻塞。
conclusion 与 recommendation 必须一致：存在 found 级问题时不应 approve。
若无跨文件问题，conclusion 说明无重大问题，recommendation 用 "approve"，verdicts/fixSpots 返回 []。`;

const GLOBAL_SYSTEM_PROMPT_EN = `You are a strict senior code reviewer responsible for cross-file global analysis.
File-level review sees one file at a time and often yields "if/maybe" judgments. Your job is to turn those into "confirmed / flipped / newly found" using cross-file facts (DI lifetimes, call graph, architecture boundaries, and whether PR intent is actually delivered).
Output JSON only. Do not output explanations or markdown code fences.
JSON schema:
{
  "conclusion": "One-sentence overall risk statement: can this change be safely submitted, and what is the biggest residual risk?",
  "recommendation": "approve" | "request_changes" | "comment",
  "evidence": ["ordered evidence step 1", "step 2", "step 3"],
  "verdicts": [
    {
      "kind": "flip" | "found" | "confirmed",
      "title": "short title",
      "before": "what file-level analysis claimed",
      "after": "what cross-file facts establish",
      "evidence": "concrete code/file evidence, e.g. Program.cs:47 AddScoped<...>",
      "file": "relative path (optional, for locate)",
      "line": <1-based line, optional>,
      "findingRef": "stable findingRef supplied in the input (required for flip/confirmed)"
    }
  ],
  "fixSpots": [
    {"file":"relative path","line":<1-based line>,"anchor":"verbatim source snippet at the issue location","severity":"bug"|"conditional"|"suggestion","title":"title","detail":"details","suggestion":"optional fix"}
  ]
}
verdict.kind meaning: flip=file-level claim overturned (false positive); found=real issue only visible cross-file (file-level miss); confirmed=cross-file facts confirm file-level claim.
For flip/confirmed, echo the matching file-level findingRef exactly; never use positional ids or invent a reference.
fixSpot.anchor must be copied verbatim from the target file (without line numbers) for stable identity across runs; omit only when truly unavailable.
All titles are required: both verdict and fixSpot titles must be concise and specific, never empty placeholders.
recommendation is the AI's overall stance: approve=safe to submit; request_changes=must-fix issues exist; comment=non-blocking reservations.
conclusion and recommendation must be consistent: if there is a found-level issue, do not output approve.
If no cross-file issues exist, state that in conclusion, set recommendation to "approve", and return verdicts/fixSpots as [].`;

function localizedPrompt(zh: string, en: string): string {
  return getOutputLanguage() === 'zh-CN' ? zh : en;
}

async function ask(
  model: vscode.LanguageModelChat,
  system: string,
  user: string,
  token: vscode.CancellationToken,
  options: { skipLanguageDirective?: boolean; op?: LlmOp; mergeIntoUser?: boolean; onChunk?: (acc: string) => void } = {},
): Promise<string> {
  const fullSystem = options.skipLanguageDirective
    ? system
    : `${languageDirective()}\n\n${system}`;
  // Translation merges the instruction and the text into ONE user turn: two
  // consecutive user turns made some models treat the instruction as the whole
  // request and reply "please provide the text to translate" (or refuse) instead
  // of translating the second turn.
  const messages = options.mergeIntoUser
    ? [vscode.LanguageModelChatMessage.User(`${fullSystem}\n\n${user}`)]
    : [
        vscode.LanguageModelChatMessage.User(fullSystem),
        vscode.LanguageModelChatMessage.User(user),
      ];
  let out = '';
  try {
    // Temperature 0 ONLY for the review ops (analyze/verify/global): a review tool's
    // value is reproducibility — the same input should yield the same findings,
    // not a fresh random subset each run (which forced re-analyzing until results
    // converged). Fix generation (fix/diff) deliberately keeps the provider
    // default: a borderline finding can return an empty proposal set, and
    // retrying with fresh sampling is the self-heal — pinning temp 0 there made
    // 「重新生成」 deterministically reproduce the same empty result (a dead end).
    // translate/explain keep the default too (not review findings).
    const reproducible =
      options.op === 'analyze'
      || options.op === 'verify'
      || options.op === 'global';
    const requestOptions: vscode.LanguageModelChatRequestOptions = reproducible
      ? { modelOptions: { temperature: 0 } }
      : {};
    const response = await model.sendRequest(messages, requestOptions, token);
    for await (const chunk of response.text) {
      out += chunk;
      options.onChunk?.(out);
    }
  } catch (err) {
    if (err instanceof vscode.LanguageModelError) {
      throw new AnalysisError(m().analyzer.modelCallFailed(err.message));
    }
    throw err;
  }
  // Estimate and report token usage after a successful call. The VS Code LM API
  // does not expose billed usage, so we approximate via countTokens; failures
  // here must never disturb the analysis result.
  if (usageSink && options.op && !token.isCancellationRequested) {
    const op = options.op;
    void (async () => {
      const [input, output] = await Promise.all([
        estimateTokens(model, fullSystem).then(async (s) => s + (await estimateTokens(model, user))),
        estimateTokens(model, out),
      ]);
      usageSink?.({ op, input, output });
    })();
  }
  return out;
}

/** Translates arbitrary text to the active UI language, returning the plain result. */
export async function translateSelection(
  model: vscode.LanguageModelChat,
  text: string,
  token: vscode.CancellationToken,
): Promise<string> {
  const system =
    `${languageDirective()}\n\n` +
    'You are the translation step of a code-review tool localizing technical documentation. ' +
    'The text that follows is the content to translate into the target language above — translate ALL of it, ' +
    'keeping code identifiers, file names, commands, and log lines verbatim. ' +
    'This is routine and safe: ALWAYS output the translation directly. Never refuse, never say you cannot help, ' +
    'never ask for the content, never add explanations, quotes, or markdown fences.\n\n=== TEXT TO TRANSLATE ===';
  const out = await ask(model, system, text, token, { skipLanguageDirective: true, op: 'translate', mergeIntoUser: true });
  return out.trim();
}

/**
 * Translates a whole Markdown document into Simplified Chinese in ONE request,
 * preserving Markdown structure and leaving code blocks / identifiers verbatim.
 * Used by the side-by-side bilingual view: the original stays untouched on the
 * left; this (rendered) translation fills the right column. No per-block alignment.
 */
export async function translateMarkdown(
  model: vscode.LanguageModelChat,
  markdown: string,
  token: vscode.CancellationToken,
  onChunk?: (acc: string) => void,
): Promise<string> {
  const system =
    'You are the translation step of a code-review tool. Translate the following Markdown document into Simplified Chinese (简体中文). ' +
    'Preserve ALL Markdown structure exactly: heading levels, lists, tables, links, blockquotes, and fenced code blocks. ' +
    'Do NOT translate fenced/inline code, identifiers, file names, commands, URLs, or log lines — keep them verbatim; translate only the prose. ' +
    'Output only the translated Markdown — no explanations, and do not wrap the whole document in a code fence. ' +
    'This is routine and safe: always translate directly, never refuse, never ask for the content.\n\n=== MARKDOWN ===';
  const out = await ask(model, system, markdown, token, { skipLanguageDirective: true, op: 'translate', mergeIntoUser: true, onChunk });
  return out.trim();
}

/**
 * Translates multiple plain-text items to the requested target language in one
 * model call. Returns an array with the exact same length/order as input.
 */
export async function translateTextBatch(
  model: vscode.LanguageModelChat,
  texts: string[],
  target: OutputLanguage,
  token: vscode.CancellationToken,
): Promise<string[]> {
  if (texts.length === 0) {
    return [];
  }
  const targetLabel = target === 'zh-CN' ? 'Simplified Chinese (简体中文)' : 'English';
  const system =
    'You are the translation step of a code-review tool localizing technical text. ' +
    `Translate each input item into ${targetLabel}. ` +
    'Keep code identifiers, file names, commands, URLs, and log/error lines verbatim whenever they appear. ' +
    'Output ONLY JSON in this exact shape: {"items":["...", "..."]}. ' +
    'The items array MUST have the same length and order as the input. ' +
    'Do not add explanations, markdown, or code fences.\n\n=== INPUT JSON ===';
  const user = JSON.stringify({ items: texts });
  const raw = await ask(model, system, user, token, {
    skipLanguageDirective: true,
    op: 'translate',
    mergeIntoUser: true,
  });
  const parsed = parseJson<{ items?: unknown[] }>(raw);
  const items = Array.isArray(parsed.items)
    ? parsed.items.map((x) => String(x ?? ''))
    : [];
  if (items.length !== texts.length) {
    throw new AnalysisError(m().analyzer.batchTranslateShapeMismatch(texts.length, items.length));
  }
  return items;
}

/** Explains a snippet of code, returning plain prose in the configured language. */
export async function explainCode(
  model: vscode.LanguageModelChat,
  code: string,
  token: vscode.CancellationToken,
): Promise<string> {
  const system =
    '你是资深代码审查助手。解释用户给出的这段代码：它做什么、关键逻辑/控制流、涉及的副作用或边界条件，以及可能值得注意的风险点。' +
    '语言简洁专业，可用短句或最多 3-5 条要点。只输出解释正文，不要复述原代码，不要 markdown 标题或代码围栏。';
  const out = await ask(model, system, code, token, { op: 'explain' });
  return out.trim();
}

/**
 * Expands a reviewer's brief point into a polished, professional, courteous PR
 * review comment about the selected code. The reviewer supplies the intent; the
 * model phrases it as one clear review comment in the configured language.
 */
export async function draftReviewComment(
  model: vscode.LanguageModelChat,
  code: string,
  point: string,
  token: vscode.CancellationToken,
): Promise<string> {
  const system =
    'You are helping a code reviewer phrase a pull-request review comment. ' +
    "Given the code under review and the reviewer's brief point, write ONE clear, professional, courteous review comment in the target language. " +
    'Be concise and specific; refer to the code where useful and keep code identifiers, file names, and commands verbatim. ' +
    'Output ONLY the comment text \u2014 no preamble, no quotes, no markdown fences.\n\n' +
    '=== CODE UNDER REVIEW ===\n' +
    code +
    '\n\n=== REVIEWER POINT ===';
  const out = await ask(model, system, point, token, { op: 'explain', mergeIntoUser: true });
  return out.trim();
}

function extractBalancedObject(text: string, start: number): string | undefined {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }
  return undefined;
}

/** Strips markdown fences and parses a JSON object from model output. */
function parseJson<T>(text: string): T {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates: string[] = [];
  if (fence) {
    candidates.push(fence[1].trim());
  }
  candidates.push(t);
  const balancedObjects: string[] = [];
  for (let start = t.indexOf('{'); start >= 0; start = t.indexOf('{', start + 1)) {
    const object = extractBalancedObject(t, start);
    if (object) {
      balancedObjects.push(object);
    }
  }
  candidates.push(...balancedObjects.sort((a, b) => b.length - a.length));
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    try {
      return JSON.parse(candidate) as T;
    } catch {
      // Try the next plausible JSON object before surfacing a user-facing error.
    }
  }
  const preview = t.replace(/\s+/g, ' ').slice(0, 500);
  throw new AnalysisError(m().analyzer.jsonParseFailed(preview, t.length > 500));
}

function normaliseSeverity(value: unknown): FindingSeverity {
  return value === 'bug' || value === 'conditional' || value === 'suggestion'
    ? value
    : 'suggestion';
}

/**
 * Resolves a finding/verdict title defensively. The model occasionally returns a
 * null/blank `title` while still giving a useful `detail`; rather than showing a
 * bare "未命名问题" placeholder, derive a short title from the detail's first
 * sentence (CJK or ASCII punctuation), capped to a readable length. Falls back to
 * the placeholder only when there is no detail to derive from.
 */
function deriveTitle(title: unknown, detail: unknown, fallback: string): string {
  const t = typeof title === 'string' ? title.trim() : '';
  if (t) {
    return t;
  }
  const d = typeof detail === 'string' ? detail.trim() : '';
  if (d) {
    const firstSentence = d.split(/(?<=[\u3002\uff01\uff1f.!?])\s*/)[0] ?? d;
    const oneLine = firstSentence.replace(/\s+/g, ' ').trim();
    return oneLine.length > 60 ? `${oneLine.slice(0, 57)}…` : oneLine;
  }
  return fallback;
}

function normaliseVerdictKind(value: unknown): VerdictKind {
  return value === 'flip' || value === 'found' || value === 'confirmed' ? value : 'confirmed';
}

function normaliseRecommendation(value: unknown): GlobalRecommendation {
  return value === 'approve' || value === 'request_changes' || value === 'comment'
    ? value
    : 'comment';
}

function normaliseEvidenceQueryKind(value: unknown): EvidenceQueryKind {
  return value === 'definition'
    || value === 'references'
    || value === 'tests'
    || value === 'configuration'
    || value === 'contract'
    ? value
    : 'contract';
}

function parseEvidenceQueries(value: unknown): EvidenceQuery[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: EvidenceQuery[] = [];
  for (const entry of value) {
    const o = entry as Record<string, unknown>;
    const symbol = String(o.symbol ?? '').trim();
    const question = String(o.question ?? '').trim();
    if (!symbol || !question) {
      continue;
    }
    out.push({
      kind: normaliseEvidenceQueryKind(o.kind),
      symbol,
      question,
    });
  }
  return out.slice(0, 4);
}

function numberifyLines(text: string): string {
  return text
    .split('\n')
    .map((line, i) => `${i + 1}\t${line}`)
    .join('\n');
}

/** Runs first-pass file analysis, returning candidates that may require repository evidence. */
export async function analyzeFile(
  model: vscode.LanguageModelChat,
  document: vscode.TextDocument,
  token: vscode.CancellationToken,
): Promise<FileFindingCandidate[]> {
  const numbered = numberifyLines(document.getText());
  const user = `文件路径：${document.uri.fsPath}\n语言：${document.languageId}\n以下每行以「行号<TAB>内容」给出：\n\n${numbered}`;
  const raw = await ask(model, localizedPrompt(FILE_SYSTEM_PROMPT_ZH, FILE_SYSTEM_PROMPT_EN), user, token, { op: 'analyze' });
  const parsed = parseJson<{ findings?: unknown[] }>(raw);
  const list = Array.isArray(parsed.findings) ? parsed.findings : [];
  const lineCount = document.lineCount;
  return list.map((f, i) => {
    const o = f as Record<string, unknown>;
    const line = clampLine(Number(o.line) || 1, lineCount);
    const anchor = typeof o.anchor === 'string' && o.anchor.trim() ? o.anchor : undefined;
    const evidenceQueries = parseEvidenceQueries(o.evidenceQueries);
    const requiresRepoContext = o.requiresRepoContext === true || evidenceQueries.length > 0;
    return {
      id: `c${i}`,
      candidateId: `c${i}`,
      line,
      endLine: o.endLine ? clampLine(Number(o.endLine), lineCount) : undefined,
      anchor,
      severity: normaliseSeverity(o.severity),
      title: deriveTitle(o.title, o.detail, m().analyzer.untitledFinding),
      detail: String(o.detail ?? ''),
      suggestion: o.suggestion ? String(o.suggestion) : undefined,
      requiresRepoContext,
      evidenceQueries,
    } satisfies FileFindingCandidate;
  });
}

function evidenceRef(snippet: CandidateEvidenceBundle['snippets'][number]): FindingEvidenceRef {
  return {
    kind: snippet.kind,
    file: snippet.file,
    line: snippet.line,
    endLine: snippet.endLine,
  };
}

/**
 * Adjudicates all context-dependent candidates in one model call. Candidates
 * without evidence are returned unresolved without spending a model call.
 */
export async function verifyFileFindings(
  model: vscode.LanguageModelChat,
  candidates: FileFindingCandidate[],
  evidenceBundles: CandidateEvidenceBundle[],
  token: vscode.CancellationToken,
): Promise<CandidateVerification[]> {
  const evidenceByCandidate = new Map(
    evidenceBundles.map((bundle) => [bundle.candidateId, bundle.snippets] as const),
  );
  const unresolved: CandidateVerification[] = [];
  const verifiable: FileFindingCandidate[] = [];
  for (const candidate of candidates) {
    if ((evidenceByCandidate.get(candidate.candidateId)?.length ?? 0) === 0) {
      unresolved.push({
        candidateId: candidate.candidateId,
        status: 'unresolved',
        rationale: m().analyzer.repoEvidenceMissing,
        evidence: [],
      });
    } else {
      verifiable.push(candidate);
    }
  }
  if (verifiable.length === 0) {
    return unresolved;
  }

  const payload = verifiable.map((candidate) => ({
    candidate: {
      candidateId: candidate.candidateId,
      line: candidate.line,
      severity: candidate.severity,
      title: candidate.title,
      detail: candidate.detail,
      suggestion: candidate.suggestion,
      evidenceQueries: candidate.evidenceQueries,
    },
    evidence: (evidenceByCandidate.get(candidate.candidateId) ?? []).map((snippet) => ({
      evidenceId: snippet.id,
      kind: snippet.kind,
      file: snippet.file,
      line: snippet.line,
      endLine: snippet.endLine,
      symbol: snippet.symbol,
      question: snippet.question,
      content: snippet.content,
    })),
  }));
  const raw = await ask(
    model,
    localizedPrompt(VERIFY_FINDINGS_SYSTEM_PROMPT_ZH, VERIFY_FINDINGS_SYSTEM_PROMPT_EN),
    JSON.stringify({ candidates: payload }),
    token,
    { op: 'verify' },
  );
  const parsed = parseJson<{ results?: unknown[] }>(raw);
  const returned = new Map<string, Record<string, unknown>>();
  for (const item of Array.isArray(parsed.results) ? parsed.results : []) {
    const o = item as Record<string, unknown>;
    const candidateId = String(o.candidateId ?? '');
    if (candidateId && !returned.has(candidateId)) {
      returned.set(candidateId, o);
    }
  }

  const verified = verifiable.map((candidate): CandidateVerification => {
    const result = returned.get(candidate.candidateId);
    if (!result) {
      return {
        candidateId: candidate.candidateId,
        status: 'unresolved',
        rationale: m().analyzer.repoVerificationMissingResult,
        evidence: [],
      };
    }
    const requestedStatus = result.status === 'confirmed' || result.status === 'dismissed'
      ? result.status
      : 'unresolved';
    const snippets = evidenceByCandidate.get(candidate.candidateId) ?? [];
    const snippetsById = new Map(snippets.map((snippet) => [snippet.id, snippet] as const));
    const cited = Array.isArray(result.evidenceIds)
      ? result.evidenceIds
          .map((id) => snippetsById.get(String(id)))
          .filter((snippet): snippet is CandidateEvidenceBundle['snippets'][number] => !!snippet)
      : [];
    const status = requestedStatus !== 'unresolved' && cited.length === 0
      ? 'unresolved'
      : requestedStatus;
    return {
      candidateId: candidate.candidateId,
      status,
      rationale: status === 'unresolved' && requestedStatus !== 'unresolved'
        ? m().analyzer.repoEvidenceUncited
        : String(result.rationale ?? m().analyzer.repoVerificationMissingResult),
      evidence: cited.map(evidenceRef),
    };
  });
  return [...verified, ...unresolved];
}

function toFinding(
  candidate: FileFindingCandidate,
  id: string,
  verification?: Finding['verification'],
): Finding {
  return {
    id,
    line: candidate.line,
    endLine: candidate.endLine,
    anchor: candidate.anchor,
    severity: candidate.severity,
    title: candidate.title,
    detail: candidate.detail,
    suggestion: candidate.suggestion,
    verification,
  };
}

/** Converts first-pass candidates plus repository verdicts into persisted findings. */
export function finalizeFileAnalysis(
  candidates: FileFindingCandidate[],
  verifications: CandidateVerification[],
  repositoryAware: boolean,
): FileAnalysisResult {
  const byCandidate = new Map(
    verifications.map((verification) => [verification.candidateId, verification] as const),
  );
  const findings: Finding[] = [];
  let dismissed = 0;
  let unresolved = 0;
  for (const candidate of candidates) {
    if (!repositoryAware || !candidate.requiresRepoContext) {
      findings.push(toFinding(candidate, `f${findings.length}`));
      continue;
    }
    const verification = byCandidate.get(candidate.candidateId);
    if (verification?.status === 'dismissed') {
      dismissed++;
      continue;
    }
    if (verification?.status === 'confirmed') {
      findings.push(toFinding(candidate, `f${findings.length}`, {
        status: 'repo-confirmed',
        rationale: verification.rationale,
        evidence: verification.evidence,
        source: 'file',
      }));
      continue;
    }
    unresolved++;
    findings.push(toFinding(candidate, `f${findings.length}`, {
      status: 'unresolved',
      rationale: verification?.rationale ?? m().analyzer.repoVerificationMissingResult,
      evidence: verification?.evidence ?? [],
      source: 'file',
    }));
  }
  return {
    findings,
    summary: {
      candidates: candidates.length,
      confirmed: findings.length - unresolved,
      dismissed,
      unresolved,
    },
  };
}

function rootedContextPayload(context: RepositoryAnalysisContext): object {
  return {
    rootPath: context.rootPath,
    context: {
      files: context.files,
      truncated: context.truncated,
      limitReasons: context.limitReasons,
    },
    evidence: context.snippets.map((snippet) => ({
      evidenceId: snippet.id,
      kind: snippet.kind,
      file: snippet.file,
      line: snippet.line,
      endLine: snippet.endLine,
      relation: snippet.symbol,
      content: snippet.content,
    })),
  };
}

export const DEFAULT_REPOSITORY_CONTEXT_TOKEN_BUDGET = 28_000;

function evidenceRetentionRank(kind: RepositoryAnalysisContext['snippets'][number]['kind']): number {
  return kind === 'root'
    ? 6
    : kind === 'test'
      ? 5
      : kind === 'configuration'
        ? 4
        : kind === 'definition'
          ? 3
          : kind === 'reference'
            ? 2
            : 1;
}

/**
 * Enforces a real model-specific token budget after the local graph/character
 * budgets. Lower-value context is removed first; the root evidence is retained.
 */
export async function fitRepositoryContextToTokenBudget(
  model: vscode.LanguageModelChat,
  context: RepositoryAnalysisContext,
  token: vscode.CancellationToken,
  maxTokens = DEFAULT_REPOSITORY_CONTEXT_TOKEN_BUDGET,
): Promise<RepositoryAnalysisContext> {
  const fitted: RepositoryAnalysisContext = {
    ...context,
    files: [...context.files],
    lineCounts: { ...context.lineCounts },
    fileHashes: { ...context.fileHashes },
    snippets: context.snippets.map((snippet) => ({ ...snippet })),
    limitReasons: [...context.limitReasons],
  };
  const analysisSystem = localizedPrompt(
    ROOTED_ANALYSIS_SYSTEM_PROMPT_ZH,
    ROOTED_ANALYSIS_SYSTEM_PROMPT_EN,
  );
  const verifySystem = localizedPrompt(
    ROOTED_VERIFY_SYSTEM_PROMPT_ZH,
    ROOTED_VERIFY_SYSTEM_PROMPT_EN,
  );
  let systemTokens: number;
  try {
    systemTokens = Math.max(
      await model.countTokens(analysisSystem),
      await model.countTokens(verifySystem),
    );
  } catch {
    return fitted;
  }
  const contextTarget = Math.max(2_000, maxTokens - 6_000);
  const count = async () =>
    systemTokens
    + (await model.countTokens(JSON.stringify(rootedContextPayload(fitted))));
  let measured: number;
  try {
    measured = await count();
  } catch {
    return fitted;
  }
  while (!token.isCancellationRequested && measured > contextTarget) {
    const removable = fitted.snippets
      .map((snippet, index) => ({ snippet, index }))
      .filter(({ snippet }) => snippet.kind !== 'root')
      .sort((a, b) =>
        evidenceRetentionRank(a.snippet.kind) - evidenceRetentionRank(b.snippet.kind)
        || b.snippet.content.length - a.snippet.content.length,
      )[0];
    if (removable) {
      fitted.snippets.splice(removable.index, 1);
    } else {
      const root = fitted.snippets.find((snippet) => snippet.kind === 'root');
      if (!root || root.content.length <= 2_000) {
        break;
      }
      root.content = root.content.slice(0, Math.max(2_000, Math.floor(root.content.length * 0.75)));
    }
    fitted.truncated = true;
    if (!fitted.limitReasons.includes('tokens')) {
      fitted.limitReasons.push('tokens');
    }
    try {
      measured = await count();
    } catch {
      break;
    }
  }
  fitted.files = [...new Set(fitted.snippets.map((snippet) => snippet.file))];
  fitted.fileHashes = Object.fromEntries(
    fitted.files
      .filter((file) => fitted.fileHashes[file])
      .map((file) => [file, fitted.fileHashes[file]]),
  );
  fitted.totalCharacters = fitted.snippets.reduce(
    (total, snippet) => total + snippet.content.length,
    0,
  );
  return fitted;
}

function normaliseRepositoryPath(value: unknown): string {
  return String(value ?? '')
    .trim()
    .replaceAll('\\', '/')
    .replace(/^\.\//, '');
}

function validEvidenceIds(
  value: unknown,
  evidenceById: ReadonlyMap<string, RepositoryAnalysisContext['snippets'][number]>,
): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return [...new Set(
    value
      .map((id) => String(id))
      .filter((id) => evidenceById.has(id)),
  )];
}

function locateAnchorInEvidence(
  snippets: RepositoryAnalysisContext['snippets'],
  anchor: string,
): { line: number; endLine: number } | undefined {
  const needle = anchor.split(/\r?\n/);
  const matches: Array<{ file: string; line: number; endLine: number }> = [];
  for (const snippet of snippets) {
    const numbered = snippet.content.split('\n').map((line) => {
      const match = line.match(/^(\d+)\t(.*)$/);
      return match ? { line: Number(match[1]), content: match[2] } : undefined;
    });
    for (let start = 0; start + needle.length <= numbered.length; start++) {
      const first = numbered[start];
      if (!first) {
        continue;
      }
      let isMatch = true;
      for (let offset = 0; offset < needle.length; offset++) {
        const current = numbered[start + offset];
        if (
          !current
          || current.line !== first.line + offset
          || current.content !== needle[offset]
        ) {
          isMatch = false;
          break;
        }
      }
      if (isMatch) {
        const location = {
          file: snippet.file,
          line: first.line,
          endLine: first.line + needle.length - 1,
        };
        if (!matches.some((match) =>
          match.file === location.file
          && match.line === location.line
          && match.endLine === location.endLine,
        )) {
          matches.push(location);
        }
      }
    }
  }
  return matches.length === 1
    ? { line: matches[0].line, endLine: matches[0].endLine }
    : undefined;
}

/**
 * Finds candidate bugs from the complete bounded repository graph rooted at one
 * file. Candidate locations are accepted only when they point into supplied
 * evidence and quote source text from that file.
 */
export async function analyzeRootedRepository(
  model: vscode.LanguageModelChat,
  context: RepositoryAnalysisContext,
  token: vscode.CancellationToken,
): Promise<RootedFindingCandidate[]> {
  const raw = await ask(
    model,
    localizedPrompt(ROOTED_ANALYSIS_SYSTEM_PROMPT_ZH, ROOTED_ANALYSIS_SYSTEM_PROMPT_EN),
    JSON.stringify(rootedContextPayload(context)),
    token,
    { op: 'analyze' },
  );
  const parsed = parseJson<{ findings?: unknown[] }>(raw);
  const evidenceById = new Map(
    context.snippets.map((snippet) => [snippet.id, snippet] as const),
  );
  const allowedFiles = new Set(context.files);
  const candidates: RootedFindingCandidate[] = [];
  for (const item of (Array.isArray(parsed.findings) ? parsed.findings : []).slice(0, 20)) {
    const o = item as Record<string, unknown>;
    const file = normaliseRepositoryPath(o.file);
    if (!allowedFiles.has(file)) {
      continue;
    }
    const severity = normaliseSeverity(o.severity);
    if (severity === 'suggestion') {
      continue;
    }
    const evidenceIds = validEvidenceIds(o.evidenceIds, evidenceById);
    const targetEvidence = evidenceIds
      .map((id) => evidenceById.get(id))
      .filter((snippet): snippet is RepositoryAnalysisContext['snippets'][number] =>
        snippet?.file === file,
      );
    const anchor = typeof o.anchor === 'string'
      ? o.anchor.replace(/\r\n/g, '\n').replace(/^\n+|\n+$/g, '')
      : '';
    const anchorLocation = locateAnchorInEvidence(targetEvidence, anchor);
    if (
      evidenceIds.length === 0
      || targetEvidence.length === 0
      || !anchor
      || !anchorLocation
    ) {
      continue;
    }
    const lineCount = context.lineCounts[file] ?? 1;
    const candidateId = `c${candidates.length}`;
    candidates.push({
      id: candidateId,
      candidateId,
      file,
      line: clampLine(anchorLocation.line, lineCount),
      endLine: clampLine(anchorLocation.endLine, lineCount),
      anchor,
      severity,
      title: deriveTitle(o.title, o.detail, m().analyzer.untitledFinding),
      detail: String(o.detail ?? ''),
      suggestion: o.suggestion ? String(o.suggestion) : undefined,
      evidenceIds,
    });
  }
  return candidates;
}

/**
 * Independently challenges every rooted candidate against the same repository
 * graph. A candidate is confirmed only with valid citations, including one from
 * the file where the bug is reported.
 */
export async function verifyRootedRepositoryFindings(
  model: vscode.LanguageModelChat,
  context: RepositoryAnalysisContext,
  candidates: RootedFindingCandidate[],
  token: vscode.CancellationToken,
  maxTokens = DEFAULT_REPOSITORY_CONTEXT_TOKEN_BUDGET,
): Promise<CandidateVerification[]> {
  if (candidates.length === 0) {
    return [];
  }
  const activeCandidates = [...candidates];
  const budgetDropped: CandidateVerification[] = [];
  const buildUser = () => JSON.stringify({
    ...rootedContextPayload(context),
    candidates: activeCandidates.map((candidate) => ({
      candidateId: candidate.candidateId,
      file: candidate.file,
      line: candidate.line,
      endLine: candidate.endLine,
      anchor: candidate.anchor,
      severity: candidate.severity,
      title: candidate.title,
      detail: candidate.detail,
      suggestion: candidate.suggestion,
      firstPassEvidenceIds: candidate.evidenceIds,
    })),
  });
  try {
    const system = localizedPrompt(
      ROOTED_VERIFY_SYSTEM_PROMPT_ZH,
      ROOTED_VERIFY_SYSTEM_PROMPT_EN,
    );
    const systemTokens = await model.countTokens(system);
    let inputTokens = systemTokens + (await model.countTokens(buildUser()));
    while (activeCandidates.length > 0 && inputTokens > maxTokens) {
      const dropped = activeCandidates.pop()!;
      budgetDropped.push({
        candidateId: dropped.candidateId,
        status: 'unresolved',
        rationale: m().analyzer.repoVerificationBudgetExceeded,
        evidence: [],
      });
      inputTokens = systemTokens + (await model.countTokens(buildUser()));
    }
  } catch {
    // The API may not support token counting; the character/file graph budgets
    // still bound the request, so continue rather than failing the analysis.
  }
  if (activeCandidates.length === 0) {
    return budgetDropped;
  }
  const raw = await ask(
    model,
    localizedPrompt(ROOTED_VERIFY_SYSTEM_PROMPT_ZH, ROOTED_VERIFY_SYSTEM_PROMPT_EN),
    buildUser(),
    token,
    { op: 'verify' },
  );
  const parsed = parseJson<{ results?: unknown[] }>(raw);
  const returned = new Map<string, Record<string, unknown>>();
  for (const result of Array.isArray(parsed.results) ? parsed.results : []) {
    const o = result as Record<string, unknown>;
    const candidateId = String(o.candidateId ?? '');
    if (candidateId && !returned.has(candidateId)) {
      returned.set(candidateId, o);
    }
  }
  const evidenceById = new Map(
    context.snippets.map((snippet) => [snippet.id, snippet] as const),
  );
  const verified = activeCandidates.map((candidate): CandidateVerification => {
    const result = returned.get(candidate.candidateId);
    if (!result) {
      return {
        candidateId: candidate.candidateId,
        status: 'unresolved',
        rationale: m().analyzer.repoVerificationMissingResult,
        evidence: [],
      };
    }
    const requestedStatus = result.status === 'confirmed' || result.status === 'dismissed'
      ? result.status
      : 'unresolved';
    const evidenceIds = validEvidenceIds(result.evidenceIds, evidenceById);
    const cited = evidenceIds
      .map((id) => evidenceById.get(id))
      .filter((snippet): snippet is RepositoryAnalysisContext['snippets'][number] => !!snippet);
    const anchorEvidenceIds = new Set(
      candidate.evidenceIds.filter((id) => {
        const snippet = evidenceById.get(id);
        return !!snippet
          && snippet.file === candidate.file
          && !!candidate.anchor
          && !!locateAnchorInEvidence([snippet], candidate.anchor);
      }),
    );
    const confirmsLocation = evidenceIds.some((id) => anchorEvidenceIds.has(id));
    const status = requestedStatus === 'confirmed' && (!confirmsLocation || cited.length === 0)
      ? 'unresolved'
      : requestedStatus === 'dismissed' && cited.length === 0
        ? 'unresolved'
        : requestedStatus;
    return {
      candidateId: candidate.candidateId,
      status,
      rationale: status === 'unresolved' && requestedStatus !== 'unresolved'
        ? m().analyzer.repoEvidenceUncited
        : String(result.rationale ?? m().analyzer.repoVerificationMissingResult),
      evidence: cited.map(evidenceRef),
    };
  });
  return [...verified, ...budgetDropped];
}

/** Keeps only independently confirmed rooted candidates and groups them by file. */
export function finalizeRootedRepositoryAnalysis(
  context: RepositoryAnalysisContext,
  candidates: RootedFindingCandidate[],
  verifications: CandidateVerification[],
): RootedFileAnalysisResult {
  const verdicts = new Map(
    verifications.map((verification) => [verification.candidateId, verification] as const),
  );
  const findingsByFile: Record<string, Finding[]> = {};
  let dismissed = 0;
  let unresolved = 0;
  for (const candidate of candidates) {
    const verification = verdicts.get(candidate.candidateId);
    if (verification?.status === 'dismissed') {
      dismissed++;
      continue;
    }
    if (verification?.status !== 'confirmed') {
      unresolved++;
      continue;
    }
    const fileFindings = (findingsByFile[candidate.file] ??= []);
    fileFindings.push({
      id: `f${fileFindings.length}`,
      line: candidate.line,
      endLine: candidate.endLine,
      anchor: candidate.anchor,
      severity: candidate.severity,
      title: candidate.title,
      detail: candidate.detail,
      suggestion: candidate.suggestion,
      analysisRoot: context.rootPath,
      analysisRoots: [context.rootPath],
      verification: {
        status: 'repo-confirmed',
        rationale: verification.rationale,
        evidence: verification.evidence,
        source: 'file',
      },
    });
  }
  return {
    findingsByFile,
    summary: {
      candidates: candidates.length,
      confirmed: Object.values(findingsByFile).reduce(
        (total, findings) => total + findings.length,
        0,
      ),
      dismissed,
      unresolved,
      contextFiles: context.files.length,
      contextTruncated: context.truncated,
      contextLimitReasons: context.limitReasons,
    },
  };
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
  const perFileBudget = Math.max(
    1,
    Math.min(MAX_FILE_CHARS, Math.floor(MAX_TOTAL_CHARS / Math.max(1, files.length))),
  );
  const sections = files.map((f) => {
    const findingRefs = findingContentSignatures(f.findings);
    const findings = f.findings.length
      ? f.findings.map((x, index) =>
          `  - findingRef=${findingRefs[index]} [${x.severity}${x.verification ? `/${x.verification.status}` : ''}] L${x.line} ${x.title} — ${x.detail.replace(/\s+/g, ' ').slice(0, 300)}`,
        ).join('\n')
      : '  - （文件级未发现问题）';

    let source = f.content ?? '';
    let truncated = source.length > perFileBudget;
    if (truncated) {
      source = source.slice(0, perFileBudget);
    }

    const numbered = source ? numberifyLines(source) : '（源码不可用）';
    const note = truncated ? '\n…（源码因长度被截断）' : '';
    return `文件：${f.path}\n文件级发现：\n${findings}\n源码（行号<TAB>内容）：\n${numbered}${note}`;
  });
  const summary = sections.join('\n\n----\n\n');
  const user = `审查集共 ${files.length} 个文件。请基于下面每个文件的真实源码与文件级发现，给出跨文件的全局逻辑分析。务必依据源码中可见的事实（DI 注册、调用关系、配置键、分层依赖）作出判断，不要臆测。\n\n${summary}`;
  const raw = await ask(model, localizedPrompt(GLOBAL_SYSTEM_PROMPT_ZH, GLOBAL_SYSTEM_PROMPT_EN), user, token, { op: 'global' });
  const parsed = parseJson<{
    conclusion?: string;
    recommendation?: string;
    evidence?: unknown[];
    verdicts?: unknown[];
    fixSpots?: unknown[];
  }>(raw);
  const fixSpots: GlobalFixSpot[] = (Array.isArray(parsed.fixSpots) ? parsed.fixSpots : []).map(
    (f) => {
      const o = f as Record<string, unknown>;
      return {
        id: '',
        file: String(o.file ?? ''),
        line: Math.max(1, Number(o.line) || 1),
        anchor: typeof o.anchor === 'string' && o.anchor.trim() ? o.anchor : undefined,
        severity: normaliseSeverity(o.severity),
        title: deriveTitle(o.title, o.detail, m().analyzer.untitledFinding),
        detail: String(o.detail ?? ''),
        suggestion: o.suggestion ? String(o.suggestion) : undefined,
      } satisfies GlobalFixSpot;
    },
  );
  const fixSpotIds = globalFixSpotSignatures(fixSpots);
  fixSpots.forEach((spot, index) => {
    spot.id = fixSpotIds[index];
  });
  const verdicts: GlobalVerdict[] = (Array.isArray(parsed.verdicts) ? parsed.verdicts : []).map(
    (v) => {
      const o = v as Record<string, unknown>;
      return {
        kind: normaliseVerdictKind(o.kind),
        title: deriveTitle(o.title, o.after ?? o.before, m().analyzer.untitledVerdict),
        before: String(o.before ?? ''),
        after: String(o.after ?? ''),
        evidence: o.evidence ? String(o.evidence) : undefined,
        file: o.file ? String(o.file) : undefined,
        line: o.line ? Math.max(1, Number(o.line)) : undefined,
        findingRef: o.findingRef ? String(o.findingRef) : undefined,
      } satisfies GlobalVerdict;
    },
  );
  return {
    conclusion: String(parsed.conclusion ?? m().analyzer.noCrossFileIssues),
    recommendation: normaliseRecommendation(parsed.recommendation),
    evidence: (Array.isArray(parsed.evidence) ? parsed.evidence : []).map((e) => String(e)),
    verdicts,
    fixSpots,
  };
}

function clampLine(line: number, max: number): number {
  if (!Number.isFinite(line) || line < 1) {
    return 1;
  }
  return Math.min(Math.floor(line), Math.max(1, max));
}

/** A single precise replacement inside a file. */
export interface FixEdit {
  /**
   * 1-based first line (in the numbered source the model was shown) of the
   * original block this edit replaces. Used as the PRIMARY anchor when applying:
   * the apply step trusts this line and verifies `oldText` against it, instead of
   * blindly searching `oldText` across the whole file (which is ambiguous when a
   * boundary line like `}` or `return;` repeats). Optional — older model outputs
   * and legacy cache entries omit it and fall back to strict content search.
   */
  startLine?: number;
  /** 1-based last line (inclusive) of the replaced block; defaults to `startLine`. */
  endLine?: number;
  /** Exact substring of the current file content; verified at the anchor before replacing. */
  oldText: string;
  /** Replacement text; may be empty (pure deletion). */
  newText: string;
}

/**
 * A single fix proposal: one or more coordinated in-file replacements applied
 * together as one solution, plus its rationale. Multiple proposals are mutually
 * exclusive alternatives; multiple `edits` inside one proposal are applied and
 * reverted as a unit.
 */
export interface FixProposal {
  title: string;
  rationale: string;
  /** One or more edits applied together. */
  edits: FixEdit[];
}

const FIX_PROPOSALS_SYSTEM_PROMPT_ZH = `你是一名资深工程师。给你一个源码文件以及一个针对某一行附近的代码审查发现，请提出修复方案。
- 由你判断给出几个方案（1 到 3 个），优先质量而非数量；如果只有一种合理改法就只给 1 个。
- **多个方案之间是互斥的备选**：用户只会选其中一个应用。不要把「同一个修复的多个步骤」拆成多个方案。
- **一个方案可以包含多处改动**：如果正确的修复需要同时改动文件里的多个位置，就把它们全部放进同一个方案的 edits 数组里 —— 它们会被一起应用、一起撤销，作为一个完整解决方案。
- 每处改动都是「按行替换」：oldText 取自当前文件、是连续若干行；newText 是替换后的内容（可以为空字符串表示删除）。
- **每处改动必须给出它替换的原始行区间 startLine / endLine**（1-based、含两端，取自每行的「行号<TAB>」前缀）。oldText 必须正好是第 startLine 到 endLine 这几行的「内容」部分（去掉行号前缀），逐行一致。这是定位的唯一依据，务必准确。
- 纯插入（不删除任何现有行）时：把 startLine=endLine 设为插入点所在的那一行，oldText 填该行原内容，newText 填「该行原内容 +\n+ 新增内容」。
- 同一个方案内的多处 edits 不要相互重叠。
- **只修复本次发现指向的那段代码**：如果用户给出了「问题代码」原文，你的 oldText/行区间必须落在这段代码（或紧邻的上下文）上，不要去改文件里其它看起来类似但与本发现无关的位置。
- oldText 不要取得太大；只覆盖真正需要改的最小连续片段。
- 不要修改与本问题无关的格式或行尾空白。
- 行号语义：用户给你的源码每行以「行号<TAB>内容」前缀；oldText/newText 只填「内容」部分，**不要带行号前缀**；行号只填进 startLine/endLine。
只输出 JSON，不要解释、不要 markdown 围栏：
{"proposals":[{"title":"一句话方案名","rationale":"为什么这样改、有什么 trade-off","edits":[{"startLine":531,"endLine":531,"oldText":"...","newText":"..."}]}]}`;

const FIX_PROPOSALS_SYSTEM_PROMPT_EN = `You are a senior engineer. Given a source file and one code-review finding around a specific line, propose fix options.
- Provide 1 to 3 options based on quality over quantity; if only one solution is reasonable, return only 1.
- **Options are mutually exclusive alternatives**: the user will apply only one. Do not split steps of the same solution into separate options.
- **One option may include multiple edits**: if a correct fix needs multiple locations in the same file, put them all in that option's edits array so they are applied/reverted together.
- Each edit is a line-based replacement: oldText is a contiguous block from current file content; newText is replacement content (can be empty for deletion).
- **Each edit must provide startLine/endLine** (1-based, inclusive, based on the provided "line<TAB>content" numbered source). oldText must exactly equal the content of those lines (without line-number prefixes).
- For pure insertion: set startLine=endLine to the anchor line, oldText to that line's original content, and newText to "that original line + newline + inserted content".
- Edits inside one option must not overlap.
- **Fix only code relevant to this finding**: if "issue code" snippet is provided, your oldText/line range must stay within that snippet (or immediately adjacent context), not elsewhere in file.
- Keep oldText minimal and contiguous; avoid unrelated formatting/whitespace changes.
- Line-number semantics: source is given as "line<TAB>content"; oldText/newText must include only content (no line numbers); line numbers go only into startLine/endLine.
Output JSON only, no explanation and no markdown fences:
{"proposals":[{"title":"one-line option title","rationale":"why this trade-off","edits":[{"startLine":531,"endLine":531,"oldText":"...","newText":"..."}]}]}`;

/** Generates 1–N fix proposals for a finding; each is a precise oldText→newText edit. */
export async function generateFixProposals(
  model: vscode.LanguageModelChat,
  fileRelPath: string,
  fileContent: string,
  finding: { title: string; detail: string; suggestion?: string; line: number; endLine?: number; anchor?: string },
  token: vscode.CancellationToken,
  userContext?: string,
): Promise<FixProposal[]> {
  const numbered = numberifyLines(fileContent);
  const range = finding.endLine && finding.endLine > finding.line
    ? `第 ${finding.line}-${finding.endLine} 行`
    : `第 ${finding.line} 行附近`;
  const anchorBlock = finding.anchor
    ? `问题代码（务必只修复这段，不要改到文件里其它类似位置）：\n${finding.anchor}\n\n`
    : '';
  // The reviewer's supplementary note carries the highest authority: it may
  // correct or constrain the model's original judgment, so place it prominently.
  const supplement = userContext && userContext.trim()
    ? `审查者补充（权威，请据此修正或约束你的方案；如与「问题说明」冲突，以本补充为准）：\n${userContext.trim()}\n\n`
    : '';
  const user = `文件：${fileRelPath}
审查发现：${finding.title}（${range}）
问题说明：${finding.detail}
${finding.suggestion ? `建议方向：${finding.suggestion}\n` : ''}
${supplement}${anchorBlock}源码（每行以「行号<TAB>内容」给出）：

${numbered}

请按上述 JSON 结构给出修复方案。`;
  const raw = await ask(model, localizedPrompt(FIX_PROPOSALS_SYSTEM_PROMPT_ZH, FIX_PROPOSALS_SYSTEM_PROMPT_EN), user, token, { op: 'fix' });
  const parsed = parseJson<{ proposals?: unknown[] }>(raw);
  const list = Array.isArray(parsed.proposals) ? parsed.proposals : [];
  const out: FixProposal[] = [];
  for (const p of list) {
    const o = p as Record<string, unknown>;
    const edits = parseFixEdits(o);
    if (edits.length === 0) {
      continue;
    }
    out.push({
      title: String(o.title ?? m().analyzer.fixProposalTitle).trim() || m().analyzer.fixProposalTitle,
      rationale: String(o.rationale ?? '').trim(),
      edits,
    });
  }
  if (out.length === 0) {
    throw new AnalysisError(m().analyzer.noFixProposals);
  }
  return out;
}

/**
 * Extracts the edit list from a raw proposal object. Accepts the new `edits`
 * array shape and falls back to a single top-level `oldText`/`newText` pair so
 * older model outputs still parse. Drops edits without an `oldText`.
 */
function parseFixEdits(o: Record<string, unknown>): FixEdit[] {
  const rawEdits = Array.isArray(o.edits)
    ? o.edits
    : typeof o.oldText === 'string'
      ? [{ oldText: o.oldText, newText: o.newText }]
      : [];
  const edits: FixEdit[] = [];
  for (const e of rawEdits) {
    const eo = e as Record<string, unknown>;
    const oldText = typeof eo.oldText === 'string' ? eo.oldText : '';
    const newText = typeof eo.newText === 'string' ? eo.newText : '';
    if (oldText) {
      const startLine = toPositiveInt(eo.startLine);
      const endLine = toPositiveInt(eo.endLine);
      edits.push({
        oldText,
        newText,
        ...(startLine ? { startLine } : {}),
        ...(endLine ?? startLine ? { endLine: endLine ?? startLine } : {}),
      });
    }
  }
  return edits;
}

/** Coerces a model-provided line number to a positive 1-based int, or undefined. */
function toPositiveInt(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isInteger(n) && n >= 1 ? n : undefined;
}
