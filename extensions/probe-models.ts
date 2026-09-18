/**
 * /probe-models — 对网关模型做能力实测
 *
 * 用法：
 *   /probe-models                    # 探测当前网关全部模型
 *   /probe-models qwen glm           # 只探测 id 匹配这些前缀的模型
 *
 * 探测项：
 *   1. max_tokens 上限：发超大 max_tokens，从报错解析真实上限
 *   2. 图片输入：发 8x8 纯红 PNG，看是否接受（及能否答对颜色）
 *
 * 结果写入 ./probe-results.json 并在 UI 通知摘要。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// 16x16 纯红 PNG（qwen 系实测要求图片最小边长 > 10 像素，16x16 安全通过）
const RED_PNG_16X16 =
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAF0lEQVR4nGP4z8BAEiJN9aiGUQ1DSgMAkPn/Afnh+ngAAAAASUVORK5CYII=";

interface ProbeResult {
  model: string;
  maxTokensLimit?: number;
  maxTokensRaw?: string;
  image: "yes" | "no" | "error";
  imageAnswer?: string;
  errors?: string;
}

/** 从各种上游报错文案中解析 max_tokens 上限 */
function parseMaxTokensLimit(message: string): number | undefined {
  const patterns = [
    /max[_\s-]?tokens?[^\d]{0,20}(\d{3,9})/i,
    /(\d{3,9})[^\d]{0,20}max[_\s-]?tokens?/i,
    /larger than(?: the)?(?: maximum)?(?: allowed)?(?: value of)?[^\d]{0,30}(\d{3,9})/i,
    /less than(?: or equal to)?[^\d]{0,30}(\d{3,9})/i,
    /should be[^\d]{0,20}(\d{3,9})/i,
    /maximum(?:\s+is)?[^\d]{0,20}(\d{3,9})/i,
  ];
  for (const re of patterns) {
    const m = message.match(re);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n >= 256 && n <= 10_000_000) return n;
    }
  }
  return undefined;
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("probe-models", {
    description: "实测网关模型能力（max_tokens 上限 / 图片支持），写入 probe-results.json",
    handler: async (args, ctx) => {
      // 找网关和 key：读用户 models.json
      const home = process.env.USERPROFILE || process.env.HOME || "";
      let providers: Record<string, any> = {};
      try {
        providers = JSON.parse(
          readFileSync(join(home, ".pi", "agent", "models.json"), "utf-8"),
        ).providers ?? {};
      } catch {
        ctx.ui.notify("probe-models: 读不到 ~/.pi/agent/models.json", "error");
        return;
      }

      const base = Object.values(providers)
        .map((p) => p?.baseUrl)
        .find((u) => typeof u === "string" && u.includes("http"));
      if (!base) {
        ctx.ui.notify("probe-models: models.json 里没有可用 baseUrl", "error");
        return;
      }
      const gw = base.replace(/\/+$/, "").replace(/\/v1$/, "");
      const apiKey = Object.values(providers)
        .map((p) => p?.apiKey)
        .find((k) => typeof k === "string" && k.startsWith("sk-")) as string | undefined;

      // 模型列表：优先同步缓存的目录，否则现拉
      let modelIds: string[] = [];
      try {
        const cache = JSON.parse(
          readFileSync(join(home, ".pi", "agent", "newapi-sync-cache.json"), "utf-8"),
        );
        const first = Object.values(cache)[0] as any;
        modelIds = (first?.models ?? []).map((m: any) => m.id);
      } catch {
        /* fallthrough */
      }
      if (modelIds.length === 0) {
        try {
          const res = await fetch(`${gw}/v1/models`, {
            headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
          });
          const body = (await res.json()) as { data: Array<{ id: string }> };
          modelIds = body.data.map((m) => m.id);
        } catch (e) {
          ctx.ui.notify(`probe-models: 拉模型列表失败 ${e}`, "error");
          return;
        }
      }

      // 前缀过滤
      const filters = (args ?? "").split(/\s+/).filter(Boolean);
      if (filters.length > 0) {
        modelIds = modelIds.filter((id) => filters.some((f) => id.toLowerCase().includes(f.toLowerCase())));
      }
      if (modelIds.length === 0) {
        ctx.ui.notify("probe-models: 没有匹配的模型", "error");
        return;
      }

      const headers: Record<string, string> = {
        "x-api-key": apiKey ?? "",
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      };

      const results: ProbeResult[] = [];
      for (const id of modelIds) {
        ctx.ui.setStatus("probe", `${results.length + 1}/${modelIds.length} ${id}`);
        const r: ProbeResult = { model: id, image: "no" };

        // 1) max_tokens 探测（超 budget 请求，从报错解析真实上限；
        //    若网关直接接受超大值则说明上限宽松，不记录）
        try {
          const res = await fetch(`${gw}/v1/messages`, {
            method: "POST",
            headers,
            body: JSON.stringify({
              model: id,
              max_tokens: 2_000_000,
              messages: [{ role: "user", content: "hi" }],
            }),
          });
          const body = (await res.json()) as any;
          if (body.error) {
            const msg = String(body.error.message ?? "");
            r.maxTokensRaw = msg.slice(0, 200);
            r.maxTokensLimit = parseMaxTokensLimit(msg);
          } else {
            // 直接接受了超大 max_tokens（宽松网关）——记录为宽松
            r.maxTokensRaw = "accepted";
          }
        } catch (e) {
          r.errors = `max_tokens probe: ${e}`;
        }

        // 2) 图片探测
        try {
          const res = await fetch(`${gw}/v1/messages`, {
            method: "POST",
            headers,
            body: JSON.stringify({
              model: id,
              max_tokens: 300,
              messages: [{
                role: "user",
                content: [
                  { type: "image", source: { type: "base64", media_type: "image/png", data: RED_PNG_16X16 } },
                  { type: "text", text: "What is the dominant color of this image? One word." },
                ],
              }],
            }),
          });
          const body = (await res.json()) as any;
          if (body.error) {
            r.image = /image|picture|vision|media/i.test(String(body.error.message))
              ? "no"
              : "error";
            r.imageAnswer = String(body.error.message).slice(0, 120);
          } else {
            r.image = "yes";
            r.imageAnswer = (body.content ?? [])
              .filter((b: any) => b.type === "text")
              .map((b: any) => b.text)
              .join(" ")
              .slice(0, 80);
          }
        } catch (e) {
          r.image = "error";
          r.errors = [r.errors, `image probe: ${e}`].filter(Boolean).join("; ");
        }

        results.push(r);
      }

      ctx.ui.setStatus("probe", undefined);

      // 写结果文件（供人阅读）
      const out = join(ctx.cwd ?? process.cwd(), "probe-results.json");
      try {
        writeFileSync(out, JSON.stringify(results, null, 2));
      } catch {
        /* 输出失败不致命 */
      }

      // 回写探测缓存（供 newapi-sync 扩展使用）：
      // pricing 没配限额的模型，用实测 maxTokensLimit 补上
      try {
        const probeFile = join(home, ".pi", "agent", "newapi-sync-probe.json");
        let merged: Record<string, { maxTokens?: number; gateway?: string; at: number }> = {};
        try {
          merged = JSON.parse(readFileSync(probeFile, "utf-8"));
        } catch {
          /* 首次 */
        }
        for (const r of results) {
          merged[r.model] = {
            ...(r.maxTokensLimit ? { maxTokens: r.maxTokensLimit } : {}),
            gateway: gw,
            at: Date.now(),
          };
        }
        writeFileSync(probeFile, JSON.stringify(merged, null, 2));
      } catch {
        /* 回写失败不致命 */
      }

      const okImg = results.filter((r) => r.image === "yes").length;
      const parsed = results.filter((r) => r.maxTokensLimit).length;
      const lines = [
        `探测完成 ${results.length} 个模型 → ${out}`,
        `图片可用: ${okImg}/${results.length}`,
        `max_tokens 上限解析成功: ${parsed}/${results.length}`,
        "",
        ...results.map(
          (r) =>
            `${r.model}: img=${r.image} maxTokens=${r.maxTokensLimit ?? "?"}${r.maxTokensRaw === "accepted" ? "(gateway-accepted)" : ""}`,
        ),
      ];
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
