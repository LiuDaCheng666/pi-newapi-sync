/**
 * /newapi-setup — 首次使用交互式引导（零门槛接入）
 *
 * 场景：用户刚装好包，models.json 里还没有任何网关供应商。
 * 运行 /newapi-setup，依次询问：
 *   1. 网关地址（如 https://gw.example.com/ai）
 *   2. API Key
 *   3. 供应商名称（默认 new-gateway）
 * 然后自动：
 *   - 写入 models.json（含网关探活的模型清单）
 *   - 生成 newapi-sync.json（overwriteProviders 含该供应商）
 * 完成后提示重启 pi 生效。
 *
 * TUI / RPC 模式下有交互界面；print 模式下给出手动步骤提示。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const LOG_PREFIX = "[newapi-setup]";

function homeDir(): string {
  return process.env.USERPROFILE || process.env.HOME || "";
}

function normalizeGatewayBase(rawUrl: string): string {
  return rawUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("newapi-setup", {
    description: "接入 New API 网关（交互式：问地址和 key，自动写配置）",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify(
          `${LOG_PREFIX} 当前是 print/JSON 模式，无交互界面。\n` +
            `请在 TUI 里运行 /newapi-setup，或手动编辑 ~/.pi/agent/models.json`,
          "error",
        );
        return;
      }

      // 1. 网关地址
      const rawUrl = await ctx.ui.input({
        title: "New API 网关接入",
        message: "网关地址（例如 https://gw.example.com/ai 或 .../v1）：",
      });
      if (!rawUrl) return;
      const url = rawUrl.trim();
      if (!/^https?:\/\//.test(url)) {
        ctx.ui.notify("地址必须以 http:// 或 https:// 开头", "error");
        return;
      }
      const base = normalizeGatewayBase(url);

      // 2. API Key
      const key = await ctx.ui.input({
        title: "New API 网关接入",
        message: "API Key（sk-...）：",
      });
      if (!key?.trim()) return;

      // 3. 供应商名称
      const nameInput = await ctx.ui.input({
        title: "New API 网关接入",
        message: `供应商名称（回车默认 new-gateway）：`,
      });
      const providerId = (nameInput?.trim() || "new-gateway").replace(/\s+/g, "-");

      // 4. 探活 + 拉模型清单
      ctx.ui.setStatus("setup", "正在连接网关...");
      let modelIds: string[] = [];
      try {
        const res = await fetch(`${base}/v1/models`, {
          headers: { Authorization: `Bearer ${key.trim()}` },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as { data?: Array<{ id: string }> };
        modelIds = (body.data ?? []).map((m) => m.id);
        if (modelIds.length === 0) throw new Error("网关返回了空模型列表");
      } catch (e) {
        ctx.ui.setStatus("setup", undefined);
        ctx.ui.notify(
          `${LOG_PREFIX} 网关连接失败：${e instanceof Error ? e.message : e}\n` +
            `请检查地址和 key 后重试 /newapi-setup`,
          "error",
        );
        return;
      }

      // 5. 写 models.json（保留原有 providers，备份先行）
      try {
        const modelsJsonPath = join(homeDir(), ".pi", "agent", "models.json");
        let raw: any = { providers: {} };
        if (existsSync(modelsJsonPath)) {
          try {
            raw = JSON.parse(readFileSync(modelsJsonPath, "utf-8"));
            // 备份
            writeFileSync(modelsJsonPath + ".newapi-setup.bak", JSON.stringify(raw, null, 2));
          } catch {
            ctx.ui.setStatus("setup", undefined);
            ctx.ui.notify(`${LOG_PREFIX} models.json 格式错误，请先修复它再运行引导`, "error");
            return;
          }
        }
        raw.providers = raw.providers ?? {};
        raw.providers[providerId] = {
          baseUrl: base,
          apiKey: key.trim(),
          api: "anthropic-messages",
          models: modelIds.map((id) => ({ id })),
        };
        writeFileSync(modelsJsonPath, JSON.stringify(raw, null, 2));

        // 6. 写/更新 newapi-sync.json
        const cfgPath = join(homeDir(), ".pi", "agent", "newapi-sync.json");
        let cfg: any = {};
        if (existsSync(cfgPath)) {
          try {
            cfg = JSON.parse(readFileSync(cfgPath, "utf-8"));
          } catch {
            cfg = {};
          }
        }
        const list: string[] = cfg.overwriteProviders ?? [];
        if (!list.includes(providerId)) list.push(providerId);
        cfg.overwriteProviders = list;
        writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

        ctx.ui.setStatus("setup", undefined);
        ctx.ui.notify(
          `${LOG_PREFIX} 接入完成！\n` +
            `供应商 "${providerId}" → ${base}（${modelIds.length} 个模型）\n` +
            `models.json 已备份为 models.json.newapi-setup.bak\n\n` +
            `重启 pi / pi-web 后生效，模型限额将自动同步。`,
          "info",
        );
      } catch (e) {
        ctx.ui.setStatus("setup", undefined);
        ctx.ui.notify(`${LOG_PREFIX} 写入失败：${e instanceof Error ? e.message : e}`, "error");
      }
    },
  });
}
