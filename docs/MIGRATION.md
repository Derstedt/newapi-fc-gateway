# 从 provider 插件方案迁移

本版把 Tool-based Final Answer 放在客户端与已有 New API 之间，作为独立 HTTP 网关运行。网关读取已有模型目录，按选择规则生成别名，使用原渠道完成调用。

| 项目 | 早期 provider 插件方案 | 本版统一网关 |
| --- | --- | --- |
| 部署位置 | New API provider 插件与插件渠道 | 独立 Docker 服务 |
| 模型来源 | 插件渠道中配置的模型 | 当前调用者在原 New API 中可见的模型 |
| 启用 FC | 配置插件渠道及其模型 | 选择模型名或通配规则，自动生成别名 |
| 客户端入口 | 原 New API 地址 | 网关地址 |
| 客户端 Key | New API Key | 同一个 New API Key |
| New API 更新 | 依赖 provider 插件接口 | 通过公开 HTTP API 连接 |

## 迁移步骤

1. 保留现有 New API 和原有模型供应商渠道。按照 [README](../README.md) 创建 `.env` 与 `config/config.json`，启动网关。
2. `NEW_API_URL` 填原 New API 的根地址，例如 `http://host.docker.internal:3000`；共享 Docker 网络时可使用 `http://new-api:3000`。
3. 运行选择工具，选择原渠道提供的真实模型。旧插件专门发布的包装模型无需再次选择；使用通配规则时，可通过 `exclude` 排除它们。
4. 客户端 Base URL 改为 `http://服务器地址:3001/v1`，继续使用原 New API Key，刷新模型列表后选择自动生成的 `-fc` 别名。
5. 用一轮普通聊天和一轮客户端业务工具调用检查使用效果。确认客户端已切换后，可在 New API 中停用不再使用的旧插件渠道，保留原有供应商渠道。

网关别名只存在于网关发布的模型列表中。New API 接收的是原模型名，因此无需复制别名价格、逐个添加渠道模型或重新设置用户 Key 的模型名称限制。

## 配置对应

正文转换仍由 `__tfa_final_answer` 完成，`with_tools` 支持 `required` 和 `auto`。模型选择集中到一个文件：

```json
{
  "models": ["model-a", "provider-*"],
  "exclude": [],
  "prefix": "",
  "suffix": "-fc",
  "with_tools": "required"
}
```

不复用旧插件安装脚本或插件构建产物。本版只有 README 中的一套网关部署流程；模型增删通过原 New API 以及此配置完成。

## 回退

将客户端 Base URL 改回原 New API 地址，模型名改回原名即可。若先前一直使用旧插件渠道，也可以在该渠道仍可用时恢复原配置。网关没有修改 New API 的源码、数据库或原渠道；停止网关使用 `docker compose down`。
