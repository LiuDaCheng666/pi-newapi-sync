/**
 * pi-newapi-sync — 自动同步 New API 网关的模型与限额到 pi
 *
 * 工作流程：
 * 1. 扫描用户 models.json，找出 baseUrl 指向 New API 网关（或手动指定）的供应商
 * 2. 拉取网关 /v1/models（模型清单）+ /api/pricing（context_length / max_output_tokens）
 * 3. 注册 "newapi" 聚合 provider（完整模型目录，能力标注）
 * 4. 用网关数据覆写 models.json 供应商的模型列表（apiKey/baseUrl 仍由 models.json 提供）
 *
 * 无硬编码密钥：所有认证来自用户自己的 models.json。
 * 断网降级：拉取失败时沿用缓存（~/.pi/agent/newapi-sync-cache.json），不阻塞启动。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// ---------- 配置 ----------

interface PackageConfig {
  /** 需要覆写的供应商 id（支持通配符 *），默认 [] */
  overwriteProviders?: string[];
  /** 聚合 provider 的名称，默认 "newapi" */
  providerName?: string;
  /** 标注图片输入能力，默认 true */
  markImage?: boolean;
  /** 按命名启发式标注思考模型，默认 true */
  markReasoning?: boolean;
  /** 启动同步超时（毫秒），默认 30000 */
  timeoutMs?: number;
  /** 额外的网关地址（自动识别 models.json 之外的网关） */
  extraGateways?: string[];
}

const CONFIG_FILE = "newapi-sync.json";

// 常见思考模型命名启发式（可按需扩充）
const REASONING_PATTERNS = [
  /deepseek/i, /qwen/i, /^o[1-9]/, /thinking/i, /reasoner/i, /r1/i,
];

const DEFAULTS = {
  providerName: "newapi",
  markImage: true,
  markReasoning: true,
  timeoutMs: 30000,
};

// ---------- 工具 ----------

function findConfigFile(cwd: string): string | undefined {
  // 查找顺序：项目 .pi/ → 用户 ~/.pi/agent/
  const candidates = [
    join(cwd, ".pi", CONFIG_FILE),
    join(process.env.USERPROFILE || process.env.HOME || "", ".pi", "agent", CONFIG_FILE),
  ];
  return candidates.find((p) => existsSync(p));
}

function readConfig(cwd: string): PackageConfig {
  const p = findConfigFile(cwd);
  if (!p) return {};
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as PackageConfig;
  } catch {
    return {};
  }
}

function loadUserModelsJson(): { providers: Record<string, any> } {
  const home = process.env.USERPROFILE || process.env.HOME || "";
  const p = join(home, ".pi", "agent", "models.json");
  if (!existsSync(p)) return { providers: {} };
  try {
    return JSON.parse(readFileSync(p, "utf-8"));
  } catch {
    return { providers: {} };
  }
}

/** 从 providers 里发现 New API 网关（去重）+ 其第一个 apiKey */
function discoverGateways(providers: Record<string, any>, extra: string[] = []) {
  const gateways = new Map<string, { baseUrl: string; apiKey?: string }>();
  const add = (rawUrl: string, apiKey?: string) => {
    if (!rawUrl) return;
    // 归一化：去掉尾部斜杠和 /v1 后缀，得到网关根
    const base = rawUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
    if (!gateways.has(base)) gateways.set(base, { baseUrl: base, apiKey });
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

// ---------- 主逻辑 ----------

interface PricingEntry {
  model_name: string;
  context_length?: number;
  max_output_tokens?: number;
  supported_endpoint_types?: string[];
}

export default async function (pi: ExtensionAPI) {
  const cwd = process.cwd();
  const cfg = { ...DEFAULTS, ...readConfig(cwd) };
  const { providers } = loadUserModelsJson();
  const gateways = discoverGateways(providers, cfg.extraGateways ?? []);

  if (gateways.size === 0) {
    console.error("[newapi-sync] models.json 中未发现任何网关，跳过");
    return;
  }

  // ---- 缓存（断网降级用）----
  const cacheFile = join(
    process.env.USERPROFILE || process.env.HOME || "",
    ".pi", "agent", "newapi-sync-cache.json",
  );

  const readCache = (): Record<string, { models: any[]; at: number }> => {
    try {
      return JSON.parse(readFileSync(cacheFile, "utf-8"));
    } catch {
      return {};
    }
  };
  const writeCache = (data: Record<string, { models: any[]; at: number }>) => {
    try {
      writeFileSync(cacheFile, JSON.stringify(data, null, 2));
    } catch {
      // 缓存写失败无所谓
    }
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);

  const cache = readCache();
  const aggregated: any[] = []; // 聚合目录（跨网关去重，按 id）
  const byGateway: Record<string, any[]> = {}; // 每个网关的模型列表（供覆写）
  const seen = new Set<string>();
  const fetched = new Set<string>(); // 成功拉取（含 pricing）的网关

  try {
    for (const [base, gw] of gateways) {
      const headers: Record<string, string> = { Authorization: "Bearer x" };
      const key = resolveApiKey(gw.apiKey);
      if (key) headers.Authorization = `Bearer ${key}`;

      try {
        const res = await fetch(`${base}/v1/models`, { headers, signal: controller.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as { data: Array<{ id: string }> };

        // pricing 是可选的（非 New API 部署可能没有）
        let pricing: Record<string, PricingEntry> = {};
        try {
          const pres = await fetch(`${base}/api/pricing`, { headers, signal: controller.signal });
          if (pres.ok) {
            const pbody = (await pres.json()) as { data: PricingEntry[] };
            pricing = Object.fromEntries(pbody.data.map((e) => [e.model_name, e]));
          }
        } catch {
          // 没有 pricing 就用默认值
        }

        const models = body.data.map((m) => {
          const p = pricing[m.id];
          // 限额优先级：网关 pricing > 本地探测缓存 > pi 默认值
          let probeMax: number | undefined;
          try {
            const probeFile = join(
              process.env.USERPROFILE || process.env.HOME || "",
              ".pi", "agent", "newapi-sync-probe.json",
            );
            const probe = JSON.parse(readFileSync(probeFile, "utf-8"));
            probeMax = probe?.[m.id]?.maxTokens;
          } catch {
            /* 无探测缓存 */
          }
          return {
            id: m.id,
            name: m.id,
            reasoning: isReasoningModel(m.id, cfg.markReasoning !== false),
            input: (cfg.markImage === false ? ["text"] : ["text", "image"]) as ("text" | "image")[],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            // 必须始终给值：pi 的 --list-models 对 undefined 会崩（formatTokenCount）
            contextWindow: p?.context_length ?? 128000,
            maxTokens: p?.max_output_tokens ?? probeMax ?? 16384,
          };
        });

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
          console.error(
            `[newapi-sync] ${base} 拉取失败（${e}），使用缓存（${new Date(cache[base].at).toLocaleString()}）`,
          );
          for (const m of cache[base].models) {
            if (!seen.has(m.id)) {
              seen.add(m.id);
              aggregated.push(m);
            }
          }
        } else {
          console.error(`[newapi-sync] ${base} 拉取失败且无缓存：${e}`);
        }
      }
    }

    if (fetched.size > 0) writeCache(cache);

    // ---- 注册聚合 provider ----
    if (aggregated.length > 0) {
      // 认证：优先用任一网关的 key（多数部署单 key 全模型可用）
      const anyKey = [...gateways.values()]
        .map((g) => resolveApiKey(g.apiKey))
        .find(Boolean);
      const first = [...gateways.keys()][0];
      pi.registerProvider(cfg.providerName, {
        name: "New API Gateway",
        baseUrl: first,
        apiKey: anyKey,
        api: "anthropic-messages",
        models: aggregated,
      });
    }

    // ---- 覆写 models.json 供应商 ----
    const overwrite = cfg.overwriteProviders ?? [];
    if (overwrite.length > 0) {
      // 按 baseUrl 匹配每个供应商应使用哪个网关的模型列表
      const overwritten: string[] = [];
      for (const [pid, pcfg] of Object.entries(providers)) {
        if (!pcfg?.baseUrl) continue;
        const base = pcfg.baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
        const models = byGateway[base];
        if (!models) continue;
        if (!overwrite.some((pattern) => wildcardMatch(pattern, pid))) continue;
        pi.registerProvider(pid, {
          api: pcfg.api ?? "anthropic-messages",
          models,
        });
        overwritten.push(pid);
      }
      console.error(`[newapi-sync] 就绪: ${aggregated.length} 模型, 覆写: ${overwritten.join(", ") || "无"}`);
    } else {
      console.error(`[newapi-sync] 就绪: ${aggregated.length} 模型（未启用覆写，见 README overwriteProviders）`);
    }
  } finally {
    clearTimeout(timer);
  }
}
