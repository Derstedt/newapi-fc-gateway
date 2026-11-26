# New API FC Gateway / Native Plugin

为选中的模型生成 `-fc` 别名，让模型通过 function call 写正文，再还原成普通聊天内容。原生插件与可选独立网关共用同一套正文转换和别名逻辑。

## 原生插件：在已有 New API 内运行

**无需增加 Docker 容器或监听服务。** 上传 [dist/newapi-fc.plugin.js](dist/newapi-fc.plugin.js)，在 New API 中创建一个 FC 插件渠道，回环调用本实例的原有模型。客户端继续使用原 New API 地址。

版本 **2.1.0**；插件标识 `newapi_fc_gateway`；已按 New API `v1.0.0-rc.51` 的 Provider Plugin API v1 核对接口。

### 快速接入

1. Root 后台“插件”页上传 `dist/newapi-fc.plugin.js`，启用插件和全局插件开关。
2. 在原供应商渠道加入 `raw` 分组，创建一枚固定使用 `raw` 分组的内部模型 Key。
3. 新建一个“New API FC 回环”插件渠道（类型61），Base URL 填 New API 容器内实际地址，通常为 `http://127.0.0.1:3000`，密钥填上述内部 Key。
4. FC 渠道加入对外分组（如 `default`），不加入 `raw`；模型映射留空。
5. 点击“获取模型”，批量选择需要的 `-fc` 别名并保存，配置这些别名的价格。
6. 客户端刷新原 New API 的模型列表，正常选择 `model-a-fc` 调用。

**容器内端口看 New API 的实际监听端口。** 例如 Docker 映射 `3001:3000`，回环仍填 `127.0.0.1:3000`；插件本身不创建 `3001` 端口。

完整的界面安装、管理 API 安装、分组与计费、更新和卸载步骤见 **[原生插件安装说明](docs/PLUGIN.md)**。

## 模型选择与调用

| 客户端模型 | 原模型 | 路由 |
| --- | --- | --- |
| `model-a` | `model-a` | 原有渠道 |
| `model-a-fc` | `model-a` | FC 插件渠道 → 内部 raw 分组 → 原有渠道 |
| `fc/model-a` | `model-a` | 自定义前缀配置下的 FC 别名 |

插件设置提供五项配置：

```json
{
  "models": ["*"],
  "exclude": [],
  "prefix": "",
  "suffix": "-fc",
  "with_tools": "required"
}
```

`models` 和 `exclude` 支持精确名和 `*` 通配规则；别名为 `prefix + 原模型名 + suffix`。默认展示全部候选别名，然后在 New API 自带的渠道模型列表中批量选择实际开放的模型。获取结果只含 FC 别名，真实名称冲突的别名不发布。

插件的模型列表属于宿主管理阶段：新增模型、修改规则或前后缀后，在同一渠道重新获取并保存模型，或者使用宿主已有的上游模型更新功能。插件不另建模型数据库或同步服务。

## 正文与业务工具

正文工具名为 `__tfa_final_answer`，参数是 `{"content":"完整正文"}`。客户端收到普通 `message.content` 或流式 `delta.content`；正文随参数增量解码，不等待完整回答。真实业务工具仍通过 `tool_calls` 返回，客户端照常执行、追加结果并继续请求相同别名。

没有业务工具时指定正文工具；有业务工具时默认要求选择工具，模型可先调用业务工具，再在后续轮次交付正文。`with_tools: "auto"` 允许模型自行选择，客户端明确的 `tool_choice: "required"` 仍保留。`none`、指定工具、旧版 function 接口、结构化或非文本输出按原约定旁路正文注入，响应中的模型别名仍会还原。

FC 转换用于 `/v1/chat/completions` 的 JSON/SSE，所选原模型及渠道需要支持此接口的 function tools。用量、推理字段、拒绝字段和截断原因保留；插件不自动重试或续写。

## 回环的请求与记账

回环经过两次 New API 鉴权、日志和额度结算，实际供应商生成一次：外层记在调用用户与 FC 别名，内层记在内部 Key 所属账号与原模型。若只希望外层收费，可将专用 `raw` 分组倍率设置为 `0`；原模型价格配置仍需保留，FC 别名也需配置价格。具体设置见 [安装说明](docs/PLUGIN.md)。

内部 Key 固定 `raw`，避免自动分组或跨组回退；FC 渠道不加入 `raw`。这样模型发现只看原渠道，真实模型调用也只走原渠道。

## 可选：保留独立网关部署

已有 v2 用户可以继续使用独立 Node/Docker 网关；说明移至 [独立网关部署](docs/GATEWAY.md)。

| 项目 | 原生插件 | 独立网关 |
| --- | --- | --- |
| 运行位置 | 已有 New API 内置 JS 沙盒 | 单独的 Node/Docker 服务 |
| 客户端地址 | 原 New API | 网关地址 |
| 别名发布 | FC 渠道获取并保存 | 实时列表追加 |
| 配置位置 | FC 渠道插件设置 | `config/config.json` |
| 选择默认值 | `["*"]`，再在渠道中勾选 | `[]`，用 CLI 或文件选择 |
| New API 请求流程 | 同实例回环时两层 | 前置部署时一层 |

## 开发与验证

直接安装使用 ZIP 内的构建产物，服务器无需 Node.js 或 Python。修改源码后才需要 Node.js 22+ 构建：

```bash
node scripts/build-plugin.mjs
node --test tests/*.test.mjs
python3 -m unittest discover -s tests -p test_manage_plugin.py
```

项目无第三方运行时或开发依赖。`src/plugin.js` 只适配宿主接口，共用 `src/aliases.js`、`src/transform.js`、`src/content-json.js`，构建脚本将它们合并为可独立上传的 JS。

测试覆盖独立 JS 沙箱、每事件 JSON 状态传递和真实本地 HTTP 回环模拟。宿主接口按官方文档与源码核查；模拟测试不代表已运行用户的 New API 容器。正文仍由 HTTP/SSE 传输，具体模型的正文质量与断流表现可用原名和 FC 别名对比。

- [插件设计](docs/PLUGIN_DESIGN.md)
- [插件实施计划](docs/PLUGIN_PLAN.md)
- [插件三轮 review 与验证](docs/PLUGIN_REVIEW.md)
- [独立网关 v2 的 review 记录](docs/REVIEW.md)
