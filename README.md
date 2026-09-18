# pi-newapi-sync

[中文](#中文) | [English](#english)

<a id="中文"></a>

## 这是什么

[pi](https://pi.dev) 编码智能体的插件：自动把 **New API / One API** 网关的模型清单和真实限额同步进 pi，不再手工维护 `models.json`，也不再受 pi 默认猜测值（128K 上下文 / 16K 输出）的困扰。

- ✅ 自动发现：扫描你的 `models.json` 找到 New API 网关，拉取 `/v1/models` + `/api/pricing`
- ✅ 真实限额：`contextWindow` / `maxTokens` 与网关配置实时同步（如 1M 上下文 / 32K 输出）
- ✅ 聚合供应商：注册 `newapi` provider，一处浏览网关全部模型
- ✅ 覆写已有供应商：models.json 里手工配置的供应商（如 `new-provider`）被网关真实数据覆写（apiKey/baseUrl 仍由你的 models.json 提供）
- ✅ `/probe-models`：实测每个模型的真实 max_tokens 上限和图片支持（网关元数据通常不含能力标记）
- ✅ 断网降级：拉取失败自动使用上次缓存，不阻塞启动

## 安装

```bash
pi install npm:pi-newapi-sync
# 或从 GitHub：
pi install git:github.com/<你的用户名>/pi-newapi-sync@v0.1.0
```

装完重启 pi 即生效。启动日志可见：

```
[newapi-sync] 就绪: 10 模型, 覆写: new-provider, new-provider-12
```

## 配置

默认零配置即可工作（自动发现网关 + 注册聚合 provider）。要启用覆写，在项目 `.pi/newapi-sync.json` 或用户 `~/.pi/agent/newapi-sync.json` 里写：

```jsonc
{
  // 要覆写的 models.json 供应商 id，支持通配符
  "overwriteProviders": ["new-provider", "new-provider-*"],

  // 可选：
  "providerName": "newapi",   // 聚合 provider 名称
  "markImage": true,          // 标注图片输入能力（New API 元数据不含此信息，按部署实际改）
  "markReasoning": true,      // 按命名启发式标注思考模型
  "timeoutMs": 8000,          // 启动同步超时
  "extraGateways": ["https://other-gateway.example.com"]  // models.json 之外的网关
}
```

> **安全说明**：本扩展不内置任何密钥，认证完全复用你 models.json 里已有的配置。

## /probe-models 用法

两种方式：

**方式 A：prompt 模板（推荐，模型协助解析）**

```
/probe-models              # 探测全部模型
/probe-models qwen glm     # 只探测 id 含 qwen 或 glm 的模型
```

模板会指示当前模型用 bash/python 对网关做实测，结果写入 `probe-results.json` 并给出汇总表。

> Git Bash / MSYS 终端会把 `/probe-models` 转义成路径（`C:/Program Files/Git/...`），需加 `MSYS_NO_PATHCONV=1` 前缀或改用 PowerShell/CMD。

**方式 B：扩展命令（TUI 内）**

在 pi TUI 里直接输入 `/probe-models`，由扩展代码执行探测并回写 `~/.pi/agent/newapi-sync-probe.json`，供主扩展在 pricing 未配额时作兑底。

实测提示：qwen 系列模型拒收小图片（要求最小边长 > 10 像素），探测用 16×16 图片规避。另外网关可能做模型路由（响应 `model` 字段与请求不一致），探测结果会标注。

## 工作原理

1. **发现网关**：读取 `~/.pi/agent/models.json`，把所有 baseUrl 归一化（去 `/v1` 尾缀）得到网关集合
2. **拉目录**：`GET /v1/models` 拿模型清单；`GET /api/pricing`（New API 特有）拿 `context_length` / `max_output_tokens`
3. **注册**：
   - `newapi` 聚合 provider（跨网关按 id 去重）
   - 覆写 `overwriteProviders` 匹配的供应商——用完整模型列表重新注册，pi 的合并语义保证 models.json 的 apiKey/baseUrl 仍然生效
4. **缓存**：结果写入 `~/.pi/agent/newapi-sync-cache.json`，断网时降级使用

## 已验证

以下场景在真实 New API 部署（wincode.winning.com.cn，10 个模型）上验证通过：

- 聚合 provider 注册，10 个模型限额与网关一致（1M/32.8K、198K/16K 等）
- 覆写 models.json 手工供应商后，`--list-models` 显示真实限额
- 覆写后实际对话请求正常（apiKey 继承验证）
- 全部 10 个模型接受 8×8 base64 图片输入并正确回答颜色
- oversized `max_tokens` 探测 + 报错解析

## License

MIT

---

<a id="english"></a>

## What is this

A [pi](https://pi.dev) coding agent extension that auto-syncs **New API / One API** gateway model catalogs and real limits into pi — no more hand-maintained `models.json`, no more pi's guessed defaults (128K context / 16K output).

- Auto-discovers New API gateways from your `models.json`, pulls `/v1/models` + `/api/pricing`
- Real limits: `contextWindow` / `maxTokens` stay in sync with gateway config
- Aggregated `newapi` provider for browsing all gateway models
- Overwrites manually-configured providers with gateway-accurate models (apiKey/baseUrl still come from your models.json)
- `/probe-models`: empirically tests real max_tokens limits and image support per model
- Offline fallback: uses last-known cache when the gateway is unreachable

## Install

```bash
pi install npm:pi-newapi-sync
# or from GitHub:
pi install git:github.com/<you>/pi-newapi-sync@v0.1.0
```

## Configuration

Zero-config by default. To enable overwriting, create `.pi/newapi-sync.json` (project) or `~/.pi/agent/newapi-sync.json` (user):

```jsonc
{
  "overwriteProviders": ["new-provider", "new-provider-*"],
  "providerName": "newapi",
  "markImage": true,
  "markReasoning": true,
  "timeoutMs": 8000,
  "extraGateways": []
}
```

No keys are bundled — auth is reused from your own models.json.

## License

MIT
