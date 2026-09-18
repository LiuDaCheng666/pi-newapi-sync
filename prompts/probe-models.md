---
description: 实测网关模型能力（max_tokens 上限 / 图片支持），结果写入 probe-results.json
argument-hint: "[模型名过滤词，可多个]"
---
用当前工具（bash + python/curl，不要假设已有现成脚本）对网关模型做能力实测，网关地址和 key 从 `~/.pi/agent/models.json` 的 providers 里读取。

探测对象：`$ARGUMENTS`（为空则探测全部模型；多个词按子串过滤模型 id）。

对每个模型执行两项探测（走 Anthropic 兼容端点 `/v1/messages`，头部 `x-api-key` + `anthropic-version: 2023-06-01`）：

1. **max_tokens 上限**：POST `{"model":ID,"max_tokens":2000000,"messages":[{"role":"user","content":"hi"}]}`。
   - 若报错：从错误信息里解析真实上限数字（正则匹配 max tokens / maximum / less than 等文案），记为 `maxTokensLimit`
   - 若成功返回（网关宽松接受超大值）：记 `maxTokensRaw: "accepted"`
2. **图片支持**：用 python 生成 16x16 纯红 PNG（qwen 系要求最小边长 >10px；zlib+struct 手工构造，勿用 PIL），base64 后随文本"What is the dominant color? One word."发送。
   - 成功且答出 red/红色 → `image: "yes"`，附回答
   - 报错含 image/picture/vision/media → `image: "no"`
   - 其他错误 → `image: "error"`

注意：网关可能把请求路由到别的模型（响应 `model` 字段与请求不一致时，在结果里标注 `routedTo`）。

把完整结果数组写入当前目录 `probe-results.json`，最后给我一张汇总表（模型 | maxTokens | 图片 | 备注），并指出哪些模型与网关 `/api/pricing` 声明的限额不一致。
