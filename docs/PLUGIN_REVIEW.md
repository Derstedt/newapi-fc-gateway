# 原生插件 review 与验证记录

版本：2.1.0  
日期：2026-11-27  
核对宿主：New API v1.0.0-rc.51，Provider Plugin API v1。

本次在 v2.0.0 网关项目中增加原生插件。别名、正文 JSON 解码和工具转换核心继续共用；网关仍是可选部署。以下记录区分接口核查、本地测试和实际容器运行。

## 第一轮：独立设计与宿主接口 review

三位审查者分别核查 Provider 契约、安装管理接口和流式状态设计，确定以下实现边界：

- 使用类型 61 的原生 Provider 渠道，直接上传单个 JS；不启动第二个服务或容器。
- 模型获取只有 `convertResponse`，没有请求钩子，且 `ctx.state` 可为 `null`。聊天根据宿主已保存的渠道模型清单及配置解析别名，不在每次聊天时额外读取目录。
- 转换钩子不提供 `utils.fetch` 或 `ctx.channel.key`。请求发送、Bearer 鉴权及 SSE 分帧均交给宿主；插件只处理正文与别名。
- 每个流事件显式回传 JSON 可序列化状态；旁路工具注入的请求仍经过响应钩子恢复模型别名，不使用 `nativeResponse` 跳过转换。
- 内部 Key 固定 `raw` 分组，FC 渠道不加入 `raw`。一次供应商生成对应两层 New API 请求与记账，安装说明写清价格配置。
- 上传新版本不必然激活，安装器按上传结果补充激活步骤。

接口依据是官方该版本的插件规范、schema、Provider 适配器、模型获取实现和插件管理接口；没有引入常驻目录同步或另一套转换引擎。

## 第二轮：非实现者交叉代码审查

独立核查分别覆盖插件与构建、HTTP 回环与状态、安装器与部署文档；审查者未把自己编写的模块当作独立结论。

- 适配器、构建产物与宿主签名一致；列表只发布别名，真实名称冲突沿用现有核心规则。
- 正文工具被还原为普通 content，真实业务工具继续返回；客户端执行工具并追加结果后，可继续请求同一 FC 别名。
- 非 2xx 走宿主原错误路径；转换错误通过宿主支持的错误对象返回。实际 `[DONE]` 与 `{done:true}` 分别处理，没有补造成功结束。
- 流参数在完整回答到齐前即被解码输出；逐事件 JSON 状态往返保留中文与 Unicode 代理对，保留用量、推理/拒绝字段及截断原因。
- 安装器上传、激活、显式开启总开关的顺序正确。管理 API 使用 Root 管理令牌与对应 scope，无需 `New-Api-User`。
- 容器内部端口、单 FC 渠道、内部模型 Key、分组、模型保存和价格设置在 README 与安装说明中一致。

本轮未发现需要修改生产代码的可复现缺陷，未增加预防性的兼容层、自动重试或配置开关。

## 第三轮：最终组合复核与修正后复验

两位独立审查者检查原生入口与旧网关文档的衔接，发现并关闭两处文档问题：

| 发现 | 修正 | 复验 |
| --- | --- | --- |
| 旧迁移页仍称 README 是唯一网关部署说明 | 明确链接 v2.0.0 的 GATEWAY.md 与 v2.1.0 的 PLUGIN.md | 原审查者确认文字与两个链接正确 |
| TFA_CONFIG 的相对路径说明没有区分默认值与显式值 | 默认路径按各入口解释；显式相对路径统一按进程工作目录解释 | 原审查者对照源码确认一致 |

同时确认：上传单个构建产物即可安装；服务器无需额外 Node.js 或 Python；构建、测试与可选网关入口一致；历史 v2 设计与 review 已标明所属版本。三轮 review 无遗留问题。

## 自动化验证

```bash
node scripts/build-plugin.mjs
node --test tests/*.test.mjs
python3 -m unittest discover -s tests -p test_manage_plugin.py
```

| 测试范围 | 用例数 | 主要证据 |
| --- | ---: | --- |
| v2 原有六个测试文件 | 87 | 别名、正文解析、HTTP 网关、选择工具及 SSE 原有行为保持 |
| plugin.test.mjs | 14 | 宿主元信息、空 state 模型获取、别名、旁路、错误、状态往返与流结束 |
| plugin-build.test.mjs | 4 | 实际单文件产物在无 Node 全局的独立 VM 中求值与转换 |
| plugin-loopback.test.mjs | 7 | 真实本地 HTTP、外内层 Key、原模型绕过 FC、raw 拒绝、一次供应商生成、增量正文与业务工具循环 |
| test_manage_plugin.py | 9 | 真实本地 HTTP 与 CLI 子进程，安装、激活、更新、总开关顺序、删除及错误处理 |
| **合计** | **121** | **112 项 JavaScript + 9 项 Python，全部通过** |

适配器与构建用例先在未实现状态观察失败；安装器先在旧实现上观察接口和激活行为失败，再修改。HTTP 回环测试另用内存中的恒等钩子作对照，确认转换相关断言会失败。

源码包共 38 个文件。在独立解压目录执行同一套测试，112 项 JavaScript 与 9 项 Python 再次全部通过。全部 Markdown 本地链接存在，20 段 Bash 命令通过语法检查；包内包含可直接上传的插件产物和完整部署文档。

## 维护规模与验证范围

- 新增运行时适配器 `src/plugin.js` 为 94 行；构建器 15 行；可选管理安装器 82 行，均含注释与空行。
- 单文件插件为 409 行，来自三份共享核心与一个适配器；产物与源文件构建结果一致。
- 无第三方运行时或开发依赖。运行时无 Node 导入、独立监听进程、数据库、后台同步任务或 SHA 校验流程。
- VM 使用 V8，HTTP 测试使用真实本地连接，但宿主路由、鉴权、记账和供应商响应为模拟。当前环境无 Docker 和 Go 语言工具链，未运行实际 New API 容器或实际付费模型。部署后的真实调用命令见 [PLUGIN.md](PLUGIN.md)。
- FC 正文仍由 HTTP/SSE 传输；具体模型的生成质量与断流表现由实际渠道对比确认。

## 官方核查来源

- [rc.51 插件接口规范](https://github.com/QuantumNous/new-api/blob/v1.0.0-rc.51/docs/plugin-api/v1.md)
- [Provider 钩子与状态契约](https://github.com/QuantumNous/new-api/blob/v1.0.0-rc.51/pkg/jsplugin/provider.go)
- [Provider 流处理](https://github.com/QuantumNous/new-api/blob/v1.0.0-rc.51/relay/channel/providerplugin/stream.go)
- [模型目录](https://github.com/QuantumNous/new-api/blob/v1.0.0-rc.51/controller/model.go)
- [插件上传与激活](https://github.com/QuantumNous/new-api/blob/v1.0.0-rc.51/controller/task_plugin.go)
- [管理令牌权限范围](https://github.com/QuantumNous/new-api/blob/v1.0.0-rc.51/middleware/access_token_routes.go)
