# New API FC Gateway

给现有 New API 增加一个统一入口：保留原模型列表，为选中的模型自动增加 `-fc` 别名。调用别名时，模型把正文写进一个 function call，网关再将它还原为标准聊天正文；原有业务工具继续正常使用。

网关是独立 Docker 服务，通过 New API 的公开 HTTP 接口工作。客户端继续使用自己的 New API Key；模型权限、渠道调度、用量和计费继续由原 New API 处理。每次生成请求只进入原 New API 一次，无需修改 New API 源码，也无需为别名新增渠道或模型价格。

## 调用方式

假设原 New API 中有 `model-a` 和 `model-b`，配置只选择 `model-a`：

| 客户端使用的模型名 | 上游模型名 | 行为 |
| --- | --- | --- |
| `model-a` | `model-a` | 原样调用 |
| `model-b` | `model-b` | 原样调用 |
| `model-a-fc` | `model-a` | 启用 Tool-based Final Answer |

客户端从网关的 `/v1/models` 同时获取原名和别名。无需给每个模型单独添加 New API 渠道。

正文工具是内部输出通道，名称为 `__tfa_final_answer`，参数是 `{"content":"完整正文"}`。客户端收到普通 `message.content` 或流式 `delta.content`，并不需要实现这个工具；客户端自己的其他工具仍通过 `tool_calls` 返回，执行方式不变。响应中的 `model` 使用客户端请求的别名。

## Docker Compose 安装

以下命令在源码目录执行。需要 Docker 与 Docker Compose；宿主机无需安装 Node.js。

### 1. 准备配置

```bash
cp .env.example .env
cp config/config.example.json config/config.json
```

编辑 `.env`，指向**原 New API 的根地址**，不带 `/v1`：

```dotenv
NEW_API_URL=http://host.docker.internal:3000
TFA_PORT=3001
```

这个默认值适合原 New API 容器已经把 `3000` 端口映射到宿主机的情况。Compose 已配置 Linux 的 `host.docker.internal` 映射；若原服务映射到其他端口，修改 URL 中的端口。

网关的上游始终是原 New API 地址。客户端改用网关地址，New API 中原有渠道继续指向各自模型供应商。

### 2. 启动

```bash
docker compose up -d --build
docker compose logs -f fc-gateway
```

默认客户端入口为 `http://服务器地址:3001/v1`。

初始配置的 `models` 是空数组，因此此时原模型列表已经完整可用，尚未增加 FC 别名。

### 3. 从现有模型列表选择

在当前终端设置一个能够读取所需模型列表的 New API Key：

```bash
export NEW_API_TOKEN='你的 New API Key'
```

先查看模型列表：

```bash
docker compose run --rm --env NEW_API_TOKEN \
  fc-gateway node scripts/select-models.mjs --list
```

交互选择要启用 FC 的模型：

```bash
docker compose run --rm \
  --volume "$(pwd)/config:/app/config:rw" \
  --env NEW_API_TOKEN \
  fc-gateway node scripts/select-models.mjs
```

选择工具会显示编号。输入方式：

| 输入 | 写入的选择 |
| --- | --- |
| `1,3-5` | 对应编号的实际模型名 |
| `all` | `models: ["*"]`，包括今后新增的模型 |
| `none` | `models: []`，清空 FC 选择 |
| 直接回车 | 保留当前配置 |

选择后即生效，客户端刷新模型列表即可看到别名。选择工具保留前后缀、排除规则等其他设置。

`NEW_API_TOKEN` 只供选择工具读取列表使用，不写入配置文件，也不作为网关的共享上游密钥。网关转发每个客户端自己的鉴权信息，按各自权限生成可见的模型列表。

```bash
unset NEW_API_TOKEN
```

正常网关容器只读挂载配置目录；上面的选择命令只在临时 CLI 容器中把同一目录改为可写。挂载整个目录使配置文件替换后也能立即被网关读取。

### 4. 设置客户端

在支持 OpenAI Chat Completions 的客户端中设置：

| 设置 | 值 |
| --- | --- |
| API Base URL | `http://服务器地址:3001/v1` |
| API Key | 客户端原有的 New API Key |
| 模型 | 从列表选择所需的 `原模型名-fc` |

如果客户端要求填写不含 `/v1` 的服务器地址，使用 `http://服务器地址:3001`。已有域名和反向代理时，把相应 API 入口指向网关的 `3001` 端口即可。

手动验证示例（把模型名替换为实际存在的别名）：

```bash
curl http://127.0.0.1:3001/v1/models \
  -H 'Authorization: Bearer 你的 New API Key'

curl http://127.0.0.1:3001/v1/chat/completions \
  -H 'Authorization: Bearer 你的 New API Key' \
  -H 'Content-Type: application/json' \
  -d '{"model":"model-a-fc","messages":[{"role":"user","content":"你好"}],"stream":true}'
```

## 配置规则

`config/config.json` 可以直接编辑，模型列表和聊天请求会读取当前配置。修改后无需重启或重新构建镜像。

```json
{
  "models": ["model-a", "provider-*"],
  "exclude": ["provider-embedding-*"],
  "prefix": "",
  "suffix": "-fc",
  "with_tools": "required"
}
```

上例中的模型名仅用于说明；替换成你的 New API 返回的名称。

| 字段 | 默认值 | 作用 |
| --- | --- | --- |
| `models` | `[]` | 需要生成 FC 别名的原模型名；支持 `*` 通配符 |
| `exclude` | `[]` | 从选择结果中排除模型；同样支持 `*` |
| `prefix` | `""` | 别名前缀 |
| `suffix` | `"-fc"` | 别名后缀 |
| `with_tools` | `"required"` | 已有业务工具时，缺省或 `auto` 请求的工具选择策略；可为 `required` 或 `auto`。客户端明确的 `required` 继续保留 |

别名为 `prefix + 原模型名 + suffix`。例如将 `prefix` 设为 `"fc/"`、`suffix` 设为 `""`，会得到 `fc/model-a`；前后缀至少保留一个非空值。

`models: ["*"]` 选择所有当前及未来可见模型，也可用 `provider-*` 等规则只覆盖某组模型。网关每次从 New API 读取当前调用者的模型列表，没有需要维护的模型副本或后台同步任务。精确名称只选择指定模型，通配规则会自动覆盖后续新增名称。

如果别名与上游真实模型名重名，真实名称优先：该别名不会发布或覆盖原模型。例如上游已经有真实的 `model-a-fc`，选择 `model-a` 时不会占用这个名称。可换用另一组前后缀。

## 工具与接口行为

FC 别名用于 `/v1/chat/completions`，支持普通 JSON 响应和 SSE 流式响应。所选模型及其 New API 渠道需要支持 OpenAI 兼容的 function tools。

- **请求没有业务工具：** 指定调用正文工具，由网关提取 `content`。
- **请求已有业务工具：** 保留原工具并追加正文工具。默认 `with_tools: "required"` 要求本轮选择一个工具，模型可先调用业务工具，再在后续轮次通过正文工具回答。`auto` 允许模型自行决定是否调用工具；客户端明确设置 `tool_choice: "required"` 时继续保留该要求。
- **业务工具返回：** 网关保留真实 `tool_calls`，客户端照常执行工具、追加结果并继续请求同一 FC 别名。
- **显式请求约束：** `tool_choice: "none"`、指定某个工具、旧版 `functions/function_call`、非文本 `response_format`、非文本 `modalities` 会旁路正文工具注入。模型别名仍转换回原模型调用。
- **其他接口：** 使用原模型名的其他 `/v1/*` HTTP 请求直接代理；Responses、Messages、图像、音频等接口不启用 FC 别名转换。不代理 WebSocket。

这项转换改变模型组织正文的方式，网络传输仍使用普通 HTTP/SSE。实际的正文质量和流式表现取决于所选模型、渠道和网络；本项目不自动重试或续写。上游返回的用量、错误状态和截断原因按实际结果保留。

## 与 New API 共用 Docker 网络

如果希望直接使用 New API 容器名访问，在现有 `compose.yaml` 的 `fc-gateway` 服务中增加网络，并在文件末尾声明该外部网络：

```yaml
services:
  fc-gateway:
    # 保留文件中已有的 build、ports、environment、volumes 等字段。
    networks:
      - newapi-network

networks:
  newapi-network:
    external: true
    name: 你的现有Docker网络名
```

这里展示的是需要合并到原文件的字段。然后把 `.env` 中的上游改为实际容器 DNS 名与容器内端口，例如：

```dotenv
NEW_API_URL=http://new-api:3000
```

运行 `docker compose up -d` 应用变更。此方式和宿主机端口方式使用同一份镜像、配置和代码。

## 本机 Node.js 运行

项目只使用 Node.js 标准库，无需安装 npm 依赖。需要 Node.js 22 或更高版本；Docker 镜像使用 Node.js 24。

```bash
cp config/config.example.json config/config.json
export NEW_API_URL='http://127.0.0.1:3000'
node src/server.js
```

本机选择模型时，在另一个终端设置同样的 `NEW_API_URL` 和临时 `NEW_API_TOKEN`，然后运行：

```bash
node scripts/select-models.mjs --list
node scripts/select-models.mjs
```

本机命令不自动读取 `.env`；`.env` 在 Docker 部署中供 Compose 读取。

| 环境变量 | 使用者 | 默认值 / 含义 |
| --- | --- | --- |
| `NEW_API_URL` | 网关、选择工具 | 原 New API 根地址；需设置 |
| `PORT` | 网关 | `3001`，进程监听端口 |
| `TFA_CONFIG` | 网关、选择工具 | `config/config.json`；网关相对工作目录，选择工具相对项目目录 |
| `NEW_API_TOKEN` | 选择工具 | 读取模型列表的 New API Key，不保存 |
| `TFA_PORT` | Compose | `3001`，宿主机公开端口 |

## 更新、停用与验证

更新网关源码后执行：

```bash
docker compose up -d --build
```

已有 `.env` 和 `config/config.json` 继续保留；新版本部署时无需重新选择模型。New API 按原方式更新，网关通过 HTTP 接口与其连接，不需要在 New API 更新后重打补丁。

临时关闭 FC 别名，将配置中的 `models` 改为 `[]`，或在选择工具中输入 `none`。停用整个网关时，客户端 Base URL 改回原 New API 地址，然后执行：

```bash
docker compose down
```

从源码运行测试：

```bash
node --test tests/*.test.mjs
```

测试使用本地模拟 HTTP 上游，覆盖别名与权限、请求转换、普通透传、JSON/SSE 还原、配置更新以及连接结束等行为。实际 New API 容器部署和具体供应商模型需要在你的环境执行上面的调用验证。

设计与执行记录见 [设计说明](docs/DESIGN.md)、[实施计划](docs/PLAN.md) 和 [三轮 review 与验证记录](docs/REVIEW.md)。从早期 provider 插件方案切换，见 [迁移说明](docs/MIGRATION.md)。
