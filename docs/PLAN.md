# New API FC Gateway Implementation Plan

**Goal:** 一次接入已有 New API，通过模型列表选择和别名启用 Tool-based Final Answer。

**Architecture:** 轻量前置 Node 网关，保留调用者凭据和原 New API 调度。原模型与 FC 别名同时发布；复用 v1 已 review 的正文转换核心。

**Tech Stack:** Node.js 22+ 标准库、Docker Compose、Node 内置测试。

**Spec:** `docs/DESIGN.md`

## 约束

- 不改 New API，不逐模型创建渠道或价格。
- 无运行时 npm 依赖、无 SHA 校验、无自动重试/续写。
- 模型发现和聊天使用相同客户端鉴权，无跨用户缓存。
- 多轮独立 review 后再推送和打包；仓库默认私有。

## 1. 模型目录与选择工具

- [x] `src/aliases.js` / `tests/aliases.test.mjs`：先定义精确名称、通配、排除、前后缀、碰撞和原名优先的行为测试，再实现。
- [x] 统一接口：`normalizeConfig(value)`；`candidateForAlias(id, config)` 返回可能的原名或 null；`buildCatalog(payload, config)` 返回 `{body, aliases: Map}`。
- [x] `scripts/select-models.mjs` / `tests/selector.test.mjs`：从 New API 获取模型，用编号选择写入 config，凭据只从环境读，不保存到文件。

## 2. HTTP 与流式接入

- [x] `src/sse.js` / `tests/sse.test.mjs`：先测试任意字节分片、多行 data、注释、结束标记，再接入核心转换。
- [x] `src/gateway.js` / `tests/gateway.test.mjs`：真实本地 HTTP 模拟服务，覆盖模型列表、不同 key、原名透传、FC 注入、错误、客户端取消及别名回写。
- [x] `src/server.js`：读取 `NEW_API_URL`、`PORT`、`TFA_CONFIG`，启动单个 HTTP 服务。

## 3. 部署与文档

- [x] Dockerfile、compose.yaml、.env.example 和 config.example.json，提供旧版迁移和已有 Docker 网络接入方法。
- [x] README 给出选模型、通配规则、前后缀、客户端配置、更新和停用步骤。

## 4. 多轮 review 与交付

- [x] 独立架构/需求 review。
- [x] 独立协议/网络 review，具体问题先做回归复现再修复。
- [x] 修复后的独立集成/部署/简洁性 review。
- [x] 运行必要完整测试，从 ZIP 解压后重新运行；87/87 通过。

## 外部交付

创建 GitHub 私有仓库并提交全部源码，核对最终分支内容；提供仓库链接、源码 ZIP、验证结果和实测范围。仓库地址及外部交付状态在交付回复中记录。
