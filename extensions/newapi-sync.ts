/**
 * pi-newapi-sync — 自动同步 New API 网关的模型与限额到 pi
 *
 * 工作流程：
 * 1. 扫描用户 models.json，找出 baseUrl 指向 New API 网关（或手动指定）的供应商
 * 2. 拉取网关 /v1/models（模型清单）+ /api/pricing（context_length / max_output_tokens）
 * 3. 用网关数据覆写 models.json 供应商的模型列表（apiKey/baseUrl 仍由 models.json 提供），
 *    并可选写回 models.json（让 pi-web 供应商设置页显示真实参数）
 * 4. 注册 "newapi" 聚合 provider（完整模型目录，能力标注）
 *
 * 设计原则（来自实际踩坑）：
 * - 无硬编码密钥：认证完全来自用户自己的 models.json
 * - 断网降级：拉取失败用缓存，无缓存用保守默认值，绝不阻塞启动
 * - 永远给全 contextWindow/maxTokens：pi --list-models 遇 undefined 会崩
 * - 写回前做原子替换 + 备份：models.json 是用户的核心配置，损坏不可接受
 * - 所有初始化在使用之前完成（TDZ 会静默杀死扩展加载）
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync, writeFileSync, existsSync, renameSync, copyFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

// ---------- 配置 ----------

export interface PackageConfig {
  /** 需要覆写的供应商 id（支持通配符 *），默认 []（不覆写） */
  overwriteProviders?: string[];
  /** 把同步后的模型参数写回 models.json（让 pi-web 供应商页可见），默认 true */
  writeBackModelsJson?: boolean;
  /** 按模型 id 手工指定限额（优先级最高，用于网关未配 pricing 的模型） */
  modelOverrides?: Record<string, { contextWindow?: number; maxTokens?: number; reasoning?: boolean }>;
  /** 聚合 provider 的名称，默认 "newapi"；设为 "" 不注册聚合 provider */
  providerName?: string;
  /** 未实测模型的图片标注（仅当探测缓存无该模型结果时生效）。默认 false：
   *  不实测就不标注——"声明支持"应该是探测的结果，不是拍脑袋的默认值 */
  markImage?: boolean;
  /** 按命名启发式标注思考模型，默认 true */
  markReasoning?: boolean;
  /** 启动同步超时（毫秒），默认 15000 */
  timeoutMs?: number;
  /** 额外的网关地址（自动识别 models.json 之外的网关） */
  extraGateways?: string[];
  /** API 类型，默认 "anthropic-messages"（New API 同时暴露 anthropic/openai 两种端点） */
  api?: string;
}

const CONFIG_FILE = "newapi-sync.json";
const LOG_PREFIX = "[newapi-sync]";

// 兜底默认值（pi 内建一致）：仅在网关 pricing、手工覆写、探测缓存都没有时使用
const FALLBACK_CONTEXT = 128000;
const FALLBACK_MAX_TOKENS = 16384;

// 常见思考模型命名启发式（可按需扩充）
const REASONING_PATTERNS = [
  /deepseek/i, /qwen/i, /^o[1-9]/, /thinking/i, /reasoner/i, /r1/i,
];

const DEFAULTS = {
  providerName: "newapi",
  markImage: false,
  markReasoning: true,
  timeoutMs: 15000,
  api: "anthropic-messages",
};

// ---------- 工具 ----------

function homeDir(): string {
  return process.env.USERPROFILE || process.env.HOME || "";
}

function findConfigFile(cwd: string): string | undefined {
  // 查找顺序：项目 .pi/ → 用户 ~/.pi/agent/
  const candidates = [
    join(cwd, ".pi", CONFIG_FILE),
    join(homeDir(), ".pi", "agent", CONFIG_FILE),
  ];
  return candidates.find((p) => existsSync(p));
}

function readConfig(cwd: string): PackageConfig {
  const p = findConfigFile(cwd);
  if (!p) return {};
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as PackageConfig;
  } catch (e) {
    console.error(`${LOG_PREFIX} 配置文件 ${p} 解析失败，按默认配置运行：${e}`);
    return {};
  }
}

function modelsJsonPath(): string {
  return join(homeDir(), ".pi", "agent", "models.json");
}

function loadUserModelsJson(): { providers: Record<string, any> } {
  const p = modelsJsonPath();
  if (!existsSync(p)) return { providers: {} };
  try {
    const parsed = JSON.parse(readFileSync(p, "utf-8"));
    if (!parsed || typeof parsed !== "object") return { providers: {} };
    return { providers: parsed.providers ?? {} };
  } catch (e) {
    console.error(`${LOG_PREFIX} models.json 解析失败（不影响 pi 自身加载）：${e}`);
    return { providers: {} };
  }
}

function normalizeGatewayBase(rawUrl: string): string {
  return rawUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
}

/** 从 providers 里发现网关（去重）+ 各自第一个 apiKey */
function discoverGateways(providers: Record<string, any>, extra: string[] = []) {
  const gateways = new Map<string, { baseUrl: string; apiKey?: string }>();
  const add = (rawUrl: string, apiKey?: string) => {
    if (!rawUrl || typeof rawUrl !== "string" || !/^https?:\/\//.test(rawUrl)) return;
    const base = normalizeGatewayBase(rawUrl);
    if (base && !gateways.has(base)) gateways.set(base, { baseUrl: base, apiKey });
  };
  for (const cfg of Object.values(providers)) {
    if (cfg?.baseUrl) add(cfg.baseUrl, cfg.apiKey);
  }
  for (const u of extra) add(u);
  return gateways;
}

/** apiKey 值解析：支持 $ENV / ${ENV} / 字面量（不含 !command，避免执行任意命令） */
function resolveApiKey(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  if (value.startsWith("!")) return undefined; // 不执行命令
  const m = value.match(/^\$\{(\w+)\}$|^\$(\w+)$/);
  if (m) {
    const v = process.env[m[1] ?? m[2] ?? ""];
    return v || undefined;
  }
  return value;
}

function isReasoningModel(id: string, enabled: boolean): boolean {
  if (!enabled) return false;
  return REASONING_PATTERNS.some((re) => re.test(id));
}

/** 通配符匹配：* → 任意字符，其余按字面量 */
function wildcardMatch(pattern: string, id: string): boolean {
  const re = new RegExp(
    "^" + pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$",
  );
  return re.test(id);
}

/** 原子写回 models.json：临时文件 + 备份 + 替换，任何一步失败不影响原文件 */
function atomicWriteModelsJson(raw: any): void {
  const target = modelsJsonPath();
  const tmp = target + ".newapi-sync.tmp";
  const backup = target + ".newapi-sync.bak";
  writeFileSync(tmp, JSON.stringify(raw, null, 2));
  try {
    copyFileSync(target, backup);
  } catch {
    // 原文件不存在（首次）没有备份可做
  }
  try {
    unlinkSync(target);
  } catch {
    // Windows 上 rename 到已存在目标可能失败，先删
  }
  renameSync(tmp, target);
}

// ---------- 主流程 ----------

interface PricingEntry {
  model_name: string;
  context_length?: number;
  max_output_tokens?: number;
}

export interface SyncedModel {
  id: string;
  name: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
}

/** 探测缓存：/probe-models 实测的 max_tokens 上限（pricing 缺失时的补充来源） */
function loadProbeLimits(): Record<string, { maxTokens?: number }> {
  try {
    return JSON.parse(readFileSync(join(homeDir(), ".pi", "agent", "newapi-sync-probe.json"), "utf-8"));
  } catch {
    return {};
  }
}

export default async function (pi: ExtensionAPI) {
  const cwd = process.cwd();
  const cfg = { ...DEFAULTS, ...readConfig(cwd) };
  const { providers } = loadUserModelsJson();
  const gateways = discoverGateways(providers, cfg.extraGateways ?? []);

  if (gateways.size === 0) {
    // 完全静默：用户没用 New API 网关，不打扰
    return;
  }

  // ---- 缓存（断网降级用）----
  const cacheFile = join(homeDir(), ".pi", "agent", "newapi-sync-cache.json");
  const readCache = (): Record<string, { models: SyncedModel[]; at: number }> => {
    try {
      return JSON.parse(readFileSync(cacheFile, "utf-8"));
    } catch {
      return {};
    }
  };
  const writeCache = (data: Record<string, { models: SyncedModel[]; at: number }>) => {
    try {
      writeFileSync(cacheFile, JSON.stringify(data, null, 2));
    } catch {
      // 缓存写失败无所谓
    }
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);

  const cache = readCache();
  const probeLimits = loadProbeLimits();
  const aggregated: SyncedModel[] = []; // 聚合目录（跨网关按 id 去重）
  const byGateway: Record<string, SyncedModel[]> = {}; // 每个网关的模型列表（供覆写/写回）
  const seen = new Set<string>();
  const fetched = new Set<string>();

  try {
    for (const [base, gw] of gateways) {
      const headers: Record<string, string> = {};
      const key = resolveApiKey(gw.apiKey);
      if (key) headers.Authorization = `Bearer ${key}`;

      try {
        const res = await fetch(`${base}/v1/models`, { headers, signal: controller.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as { data?: Array<{ id: string }> };
        if (!Array.isArray(body.data)) throw new Error("响应缺少 data 数组");

        // pricing 是可选的（非 New API 部署可能没有）
        let pricing: Record<string, PricingEntry> = {};
        try {
          const pres = await fetch(`${base}/api/pricing`, { headers, signal: controller.signal });
          if (pres.ok) {
            const pbody = (await pres.json()) as { data?: PricingEntry[] };
            if (Array.isArray(pbody.data)) {
              pricing = Object.fromEntries(pbody.data.map((e) => [e.model_name, e]));
            }
          }
        } catch {
          // 没有 pricing 就走兜底
        }

        const models: SyncedModel[] = body.data
          .filter((m) => m && typeof m.id === "string")
          .map((m) => {
            const p = pricing[m.id];
            const manual = cfg.modelOverrides?.[m.id];
            const probe = probeLimits[m.id];
            // 图片支持：实测结果 > 全局标注配置（网关元数据无此字段，未实测时只能按配置标注）
            const imageInput = probe?.image === "yes"
              ? true
              : probe?.image === "no"
                ? false
                : cfg.markImage !== false;
            return {
              id: m.id,
              name: m.id,
              reasoning: manual?.reasoning ?? isReasoningModel(m.id, cfg.markReasoning !== false),
              input: (imageInput ? ["text", "image"] : ["text"]) as ("text" | "image")[],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              // 限额优先级：手工覆写 > 网关 pricing > 探测缓存 > pi 一致兜底
              // 必须始终给值：pi --list-models 对 undefined 会崩（formatTokenCount）
              contextWindow: manual?.contextWindow ?? p?.context_length ?? FALLBACK_CONTEXT,
              maxTokens: manual?.maxTokens ?? p?.max_output_tokens ?? probe?.maxTokens ?? FALLBACK_MAX_TOKENS,
            };
          });

        if (models.length === 0) throw new Error("模型列表为空");

        byGateway[base] = models;
        cache[base] = { models, at: Date.now() };
        fetched.add(base);

        for (const m of models) {
          if (!seen.has(m.id)) {
            seen.add(m.id);
            aggregated.push(m);
          }
        }
      } catch (e) {
        // 单个网关失败：尝试缓存
        if (cache[base]?.models?.length) {
          byGateway[base] = cache[base].models;
          for (const m of cache[base].models) {
            if (!seen.has(m.id)) {
              seen.add(m.id);
              aggregated.push(m);
            }
          }
          console.error(
            `${LOG_PREFIX} ${base} 拉取失败（${e instanceof Error ? e.message : e}），使用缓存（${new Date(cache[base].at).toLocaleString()}）`,
          );
        } else {
          console.error(`${LOG_PREFIX} ${base} 拉取失败且无缓存：${e instanceof Error ? e.message : e}`);
        }
      }
    }

    if (fetched.size > 0 || Object.keys(byGateway).length > 0) writeCache(cache);

    // ---- 零配置体验：没有配置文件时，自动生成 ----
    // 把发现的网关供应商全部写进 overwriteProviders，用户装完即用，不用手写任何配置。
    // 只有用户后来手写的 modelOverrides 等高级选项才需要再碰配置文件。
    const configPath = findConfigFile(cwd) ?? join(homeDir(), ".pi", "agent", CONFIG_FILE);
    if (!existsSync(configPath) && gateways.size > 0) {
      const autoProviders = [...Object.entries(providers)]
        .filter(([, pcfg]) => pcfg?.baseUrl && normalizeGatewayBase(pcfg.baseUrl) in byGateway)
        .map(([pid]) => pid);
      if (autoProviders.length > 0) {
        try {
          const autoCfg: PackageConfig = { overwriteProviders: autoProviders };
          writeFileSync(configPath, JSON.stringify(autoCfg, null, 2));
          console.error(
            `${LOG_PREFIX} 未找到配置，已自动生成 ${configPath}（覆写: ${autoProviders.join(", ")}）`,
          );
          cfg.overwriteProviders = autoProviders;
        } catch (e) {
          console.error(`${LOG_PREFIX} 自动生成配置失败：${e instanceof Error ? e.message : e}`);
        }
      }
    }

    const overwrite = cfg.overwriteProviders ?? [];

    // ---- 覆写 models.json 供应商（运行时注册）----
    const overwritten: string[] = [];
    if (overwrite.length > 0) {
      for (const [pid, pcfg] of Object.entries(providers)) {
        if (!pcfg?.baseUrl) continue;
        const base = normalizeGatewayBase(pcfg.baseUrl);
        const models = byGateway[base];
        if (!models) continue;
        if (!overwrite.some((pattern) => wildcardMatch(pattern, pid))) continue;
        pi.registerProvider(pid, {
          api: pcfg.api ?? cfg.api,
          models,
        });
        overwritten.push(pid);
      }
    }

    // ---- 写回 models.json（让 pi-web 供应商设置页显示真实参数）----
    if (cfg.writeBackModelsJson !== false && overwritten.length > 0) {
      try {
        const raw = loadUserModelsJson();
        let changed = false;
        for (const pid of overwritten) {
          const pcfg = raw.providers[pid];
          if (!pcfg?.baseUrl) continue;
          const base = normalizeGatewayBase(pcfg.baseUrl);
          const models = byGateway[base];
          if (!models) continue;
          if (JSON.stringify(pcfg.models ?? []) !== JSON.stringify(models)) {
            pcfg.models = JSON.parse(JSON.stringify(models));
            changed = true;
          }
        }
        if (changed) {
          atomicWriteModelsJson(raw);
          console.error(`${LOG_PREFIX} models.json 已写回同步参数（备份: models.json.newapi-sync.bak）`);
        }
      } catch (e) {
        console.error(`${LOG_PREFIX} models.json 写回失败（不影响运行时覆写）：${e instanceof Error ? e.message : e}`);
      }
    }

    // ---- 注册聚合 provider ----
    if (aggregated.length > 0 && cfg.providerName) {
      // 认证：任一网关的 key（多数部署单 key 全模型可用）
      const anyKey = [...gateways.values()].map((g) => resolveApiKey(g.apiKey)).find(Boolean);
      const first = [...gateways.keys()][0];
      pi.registerProvider(cfg.providerName, {
        name: "New API Gateway",
        baseUrl: first,
        apiKey: anyKey,
        api: cfg.api,
        models: aggregated,
      });
    }

    // ---- 汇总日志 ----
    const parts = [`${aggregated.length} 模型`];
    if (overwritten.length > 0) parts.push(`覆写: ${overwritten.join(", ")}`);
    else if (overwrite.length > 0) parts.push("覆写目标无匹配（检查 overwriteProviders 与 baseUrl）");
    console.error(`${LOG_PREFIX} 就绪: ${parts.join(", ")}`);
  } finally {
    clearTimeout(timer);
  }
}
