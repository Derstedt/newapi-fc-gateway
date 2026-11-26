# 原生 FC 插件：安装与容器内回环

本版插件直接运行在现有 New API 进程中。安装一个 JavaScript 文件，创建一个 FC 渠道，即可批量提供选中模型的 `-fc` 别名。客户端继续使用原 New API 地址。

| 项目 | 本版设置 |
| --- | --- |
| 插件 Key / 版本 | `newapi_fc_gateway` / `2.1.0` |
| 宿主接口 | Provider Plugin API v1，按官方 `v1.0.0-rc.51` 核对 |
| 直接上传的文件 | `dist/newapi-fc.plugin.js` |
| 渠道类型 | Task Plugin / 插件，类型 **61** |
| FC 入口 | `/v1/chat/completions`，JSON 与 SSE |
| 模型列表 | 从回环上游 `/v1/models` 获取，仅发布匹配的 FC 别名 |
| 运行环境 | New API 内置 JavaScript 沙盒 |

插件本身不监听端口。**渠道 Base URL 应填写 New API 在容器内实际监听的地址。** 例如 Docker 映射为 `3001:3000`，插件应填写 `http://127.0.0.1:3000`；只有 New API 进程自己监听 `3001` 时，才填写 `http://127.0.0.1:3001`。

## 1. 安装插件

解压源码包，进入项目目录：

```bash
unzip newapi-fc-gateway-v2.1.0.zip
cd newapi-fc-gateway
```

### 方式 A：在后台上传

1. 用 Root 账号进入 New API 的“管理员 → 插件”页面。
2. 开启全局“启用插件”开关。
3. 点击“上传插件”，选择 **`dist/newapi-fc.plugin.js`**。
4. 上传后确认该插件已启用，运行状态为“已注册”。已有同 Key 的激活版本时，点击“立即激活”启用这次上传的版本。
5. 按第 2 节配置回环分组，再创建一个 FC 渠道。

上传的是构建好的单个 `.js` 文件；源码 ZIP 用来保存整个项目。后台上传不需要服务器另装 Node.js 或 Python。

### 方式 B：使用管理 API

在能访问 New API 的机器上运行 Python 3.9+：

```bash
export NEW_API_URL='https://newapi.example.com'
export NEW_API_ADMIN_TOKEN='Root 管理访问令牌'

python3 scripts/manage-plugin.py install --enable-runtime

unset NEW_API_ADMIN_TOKEN
```

`NEW_API_URL` 是可以从运行脚本的机器访问的实例根地址，不带 `/v1`。`NEW_API_ADMIN_TOKEN` 是 Root 的管理访问令牌，需要 `plugin:write`；使用 `--enable-runtime` 还需要 `option:write`。这与下一节用于回环的普通模型 Key 分开使用。

如果已在后台开启全局插件开关，运行 `install` 即可，省略 `--enable-runtime`。脚本上传后检查该版本是否激活；未激活时调用激活接口，成功后再按参数开启总开关。凭据只从环境变量或命令参数读取，不写入项目文件。

| 操作 | HTTP 接口 | 请求内容 |
| --- | --- | --- |
| `install` | `POST /api/plugin/task` | `{"source":"完整JS源码","enabled":true}` |
| `update` | `PUT /api/plugin/task` | 同上 |
| 上传后待激活 | `POST /api/plugin/task/newapi_fc_gateway/activate` | 上传结果中的 `{"version":"2.1.0"}` |
| 显式启用总开关 | `PUT /api/option/` | `{"key":"TaskPluginEnabled","value":"true"}` |
| 删除指定版本 | `DELETE /api/plugin/task/newapi_fc_gateway/versions/2.1.0` | 无 |

当前管理接口使用 Bearer 管理令牌，不需要额外的 `New-Api-User` 请求头。上传、激活和总开关是依次执行的操作；若后续操作失败，已上传的插件版本仍保留，可在后台继续处理。

## 2. 设置回环分组与内部 Key

回环调用路径是：客户端请求 FC 别名，New API 选中 FC 插件渠道；插件把别名恢复为原名、注入正文工具，再通过本机 New API 的原供应商渠道调用模型。

用 `raw` 分组固定内部请求的路由：

1. 在 New API 中允许一个专门的 `raw` 分组。
2. 将需要使用的原供应商渠道加入 `raw`，保留它们原有的对外分组。可在渠道管理中批量调整。
3. 创建一枚普通模型调用 Key，将其分组固定为 `raw`，关闭自动分组与跨分组重试。Key 所属账号需要能使用该分组。
4. 将这枚 Key 填入 FC 渠道的“API 密钥”；FC 渠道只加入对外分组，不加入 `raw`。

| 配置对象 | 对外分组，例如 `default` | 内部分组 `raw` |
| --- | :---: | :---: |
| 原供应商渠道 | 按原使用方式保留 | 加入 |
| FC 插件渠道 | 加入 | 不加入 |
| 回环用的内部模型 Key | — | 固定使用 |

这样原模型请求始终由原渠道处理；模型列表也来自内部 Key 实际可见的原模型。插件使用宿主为渠道提供的 Bearer 鉴权，不自行读取或另存 Key。

### 两层记账与价格

回环有两次 New API 请求：外层按客户端用户和 FC 别名记账，内层按内部 Key 的账号、`raw` 分组和原模型记账。**内部 Key 的“无限额度”不等于免费**，它只影响这枚 Key 自身的额度限制。

如希望只在对外这一层收费，可以将 `raw` 分组倍率设为 `0`，同时保留原模型所需的价格配置；外层 FC 别名仍需配置自己的价格或倍率。是否采用这一设置由你的计费安排决定，安装脚本不修改价格、分组或用户。

## 3. 创建一个 FC 渠道

在“渠道 → 创建渠道”的“插件”分类中选择本插件：

| 字段 | 填写内容 |
| --- | --- |
| 渠道名称 | 例如 `FC Gateway` |
| 类型 / 插件 | 类型 61 / `newapi_fc_gateway` |
| API 地址 / Base URL | 容器内 New API 根地址，例如 `http://127.0.0.1:3000`，不带 `/v1` |
| API 密钥 | 第 2 节固定在 `raw` 分组的普通模型 Key |
| 插件设置 | 按下表填写模型选择和别名规则 |
| 模型 | 点击“获取模型”，批量选择需要提供的 FC 别名，然后保存 |
| 分组 | 对外调用分组，例如 `default` |
| 模型映射 / 重定向 | 留空，别名由插件直接解析 |

本方案使用类型 61 的 Provider 渠道，宿主负责普通 HTTP 转发。调用者继续请求原来的 New API，无需在客户端填写插件路径或新的服务端口。

### 插件设置

这些设置由 New API 的渠道表单保存；修改它们无需编辑源码或重新上传插件。

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `models` | `["*"]` | 要转换的原模型名称；支持精确名称和 `*` 通配符 |
| `exclude` | `[]` | 排除的原模型名称或通配规则 |
| `prefix` | `""` | 别名前缀 |
| `suffix` | `"-fc"` | 别名后缀 |
| `with_tools` | `"required"` | 已有业务工具时，缺省或 `auto` 请求的工具选择策略，可选 `required` 或 `auto` |

对应配置示例：

```json
{
  "models": ["model-a", "provider-*"],
  "exclude": ["provider-embedding-*"],
  "prefix": "",
  "suffix": "-fc",
  "with_tools": "required"
}
```

模型名称以你实际获取的列表为准。选择支持 Chat Completions function tools 的模型。默认 `models: ["*"]` 便于首次获取列表，再在渠道的模型选择框中批量挑选；`models: []` 表示不发布 FC 别名。

别名规则为 `prefix + 原模型名 + suffix`。例如 `prefix: "fc/"`、`suffix: ""` 会产生 `fc/model-a`。前后缀至少一个非空；生成的别名若已是上游真实模型名，该冲突别名不会发布。

插件的模型获取结果**只包含 FC 别名**，原名称继续由原渠道提供。新增模型、改变选择规则或前后缀后，在这个 FC 渠道重新“获取模型 → 选择 → 保存”。也可以使用宿主已有的上游模型更新功能。渠道模型清单由 New API 保存，不会仅因为插件返回了新名称就立即自动加入路由。

供管理 API 使用时，插件绑定位于 `setting.task_plugin_key`，插件配置位于 `settings.plugin_config`；这是 Channel 对象中两个不同的 JSON 字符串字段。后台表单负责保存这些字段，日常配置无需手写渠道 JSON。

## 4. 调用与检查

客户端仍使用原 New API 地址和原有的对外模型 Key，选择保存到 FC 渠道的别名：

```bash
export NEW_API_URL='https://newapi.example.com'
export NEW_API_TOKEN='可访问 FC 渠道的普通模型 Key'

curl --fail-with-body -sS -N "$NEW_API_URL/v1/chat/completions" \
  -H "Authorization: Bearer $NEW_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"model":"model-a-fc","messages":[{"role":"user","content":"用中文解释一下热传导"}],"stream":true,"stream_options":{"include_usage":true}}'

unset NEW_API_TOKEN
```

将 `model-a-fc` 替换为实际保存的名称。预期收到普通 `delta.content`，内部的 `__tfa_final_answer` 不显示为客户端待执行的工具。将 `stream` 改为 `false` 时，正文在 `message.content` 中。

在调用日志中，外层应命中 FC 渠道，内层应命中原供应商渠道；两层请求分别使用别名和原名。它们对应一次实际供应商模型生成。

已有业务工具继续使用 `tool_calls`。客户端照常执行工具、追加结果，再调用同一 FC 别名。显式 `tool_choice: "required"` 保留；`none`、指定工具、旧版函数接口、结构化输出或非文本输出按现有约定旁路正文工具注入，响应中的模型别名仍回写。

本插件提供 Chat Completions 的 FC 转换；其他协议继续使用原渠道与原模型名。具体模型的输出质量和工具参数流式表现，需要在实际供应商渠道中比较。

## 5. 更新、停用与迁移

### 更新 New API

继续使用原 New API Docker 服务、数据库和数据卷进行更新。插件源码及版本由 New API 管理，不依赖容器内手动复制文件。

### 更新插件

下载新的插件文件，在后台上传并激活新版本，或使用管理脚本：

```bash
export NEW_API_URL='https://newapi.example.com'
export NEW_API_ADMIN_TOKEN='Root 管理访问令牌'

python3 scripts/manage-plugin.py update

unset NEW_API_ADMIN_TOKEN
```

脚本成功时已确保上传版本处于激活状态。自行修改源码时，先更新插件版本，再运行 `node scripts/build-plugin.mjs`；上传新的 `dist/newapi-fc.plugin.js`。New API 不接受同一 Key、同一版本对应不同源码。

临时停用可直接停用 FC 渠道。回退插件时，在插件详情的版本历史中激活已保存的旧版本。

### 从独立网关版切换

把原网关的 `models`、`exclude`、`prefix`、`suffix`、`with_tools` 配置填到插件渠道设置，获取并保存所需别名。将客户端 Base URL 改回原 New API，验证一次普通聊天与一次业务工具循环后，即可停止旧网关容器。具体独立网关命令见 [网关部署说明](GATEWAY.md)。

### 删除插件版本

先停用或解除相关渠道绑定，再删除指定版本：

```bash
python3 scripts/manage-plugin.py remove --version 2.1.0
```

运行时仍需设置前述管理地址与 Root 管理令牌。脚本只删除指定版本；宿主在删除当前版本后可能激活另一个已保存版本，完整卸载可在后台删除其余版本。

## 6. 验证范围与官方依据

本项目使用本地 HTTP 服务和宿主 Hook 模拟验证安装、激活、别名、回环路由和正文转换。当前开发环境没有 Docker，未声称已经在你的 New API 容器或实际模型供应商上运行；第 4 节命令用于部署后的实际调用检查。

接口与操作依据：

- [官方插件管理：上传、启用、版本激活与创建渠道](https://docs.newapi.pro/zh/docs/guide/feature-guide/admin/task-plugins)
- [官方插件渠道配置](https://docs.newapi.pro/zh/docs/plugins/configuration)
- [管理 API 路由与 Root 权限](https://github.com/QuantumNous/new-api/blob/main/router/api-router.go)
- [管理访问令牌 scope](https://github.com/QuantumNous/new-api/blob/main/middleware/access_token_routes.go)
- [上传接口及激活接口](https://github.com/QuantumNous/new-api/blob/main/controller/task_plugin.go)
- [版本保存与激活规则](https://github.com/QuantumNous/new-api/blob/main/model/task_plugin.go)
- [渠道字段定义](https://github.com/QuantumNous/new-api/blob/main/model/channel.go)

部署形态与完整设计见 [PLUGIN_DESIGN.md](PLUGIN_DESIGN.md)，实施任务见 [PLUGIN_PLAN.md](PLUGIN_PLAN.md)。
