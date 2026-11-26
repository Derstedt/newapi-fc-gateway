# Native Provider Plugin Design

版本：2.1.0

## 目标与接入

在已有 New API Docker 容器内安装一个 Provider Plugin，单个 FC 渠道发布选中的原模型对应的别名。客户端继续访问原 New API。插件没有独立监听端口或常驻服务；默认 Base URL 为 http://127.0.0.1:3000，按 New API 容器内实际监听端口修改。

已核对宿主：官方 v1.0.0-rc.51 的 Provider Plugin API v1。插件 key 为 newapi_fc_gateway，版本 2.1.0，类型61；不声明任务插件的 upstreams/channelTypes/auth/routes。

## 设计选择

使用宿主原生 provider hooks；保留现有独立网关作为可选部署。两者共用 src/aliases.js、src/transform.js 和 src/content-json.js，新增的 src/plugin.js 只适配宿主接口。单文件 dist/newapi-fc.plugin.js 可直接上传，构建脚本只拼接四个已知模块。

不通过 Node 子进程、额外 Docker、utils.fetch 或请求链读取目录。Provider convertRequest 没有 utils.fetch；管理端获取模型时宿主自行发 GET /v1/models，并单独调用 convertResponse，ctx.state 可以为 null。

## 模型与配置

插件 channelConfig 暴露 models、exclude、prefix、suffix、with_tools。models 默认 ["*"]，便于首次点击获取模型后在原生渠道表单批量选择；空数组表示不发布别名。其余默认值与网关版一致。

/v1/models 使用 converter:plugin，只返回命中的 FC 别名，不返回原名。复用 buildCatalog 的选择与真实名称冲突逻辑。新增模型、改前后缀或改选择规则后，在同一个渠道重新获取并保存列表，或使用宿主已有上游模型更新功能。

聊天由宿主的已保存渠道模型清单选择进入本插件。convertRequest 直接根据配置反解 request.model，送给上游真实名称；不重复请求模型目录。不符合规则的名称报错，插件渠道不承接原名称。

## 回环路由

原供应商渠道加入 raw 分组，FC 渠道只加入对外分组，例如 default。内部模型调用 Key 固定 raw 分组，禁用自动分组及跨分组重试。宿主把渠道 Key 作为 Bearer 发送，插件代码不读取或另存 Key。

外层按 FC 别名、调用用户记账；内层按原模型、内部 Key 归属账户记账。内部 Key 无限额度不等于免费；需要单层收费时可在宿主把 raw 分组倍率设0，同时保留原模型价格配置并设置外层 FC 别名价格。安装器不改全站价格、用户或渠道分组。

## 正文与流

convertRequest 复用 prepareBody，返回 {body,stream,state:{model,active,choices}}。明确 none/指定工具/结构化输出等仍旁路正文注入，但继续运行响应 hook 回写模型别名，不使用 nativeResponse。

convertResponse 对模型列表执行别名投影，对成功聊天还原最终工具为正文；非2xx交给宿主处理原状态和响应。convertStreamEvent 逐事件复用核心还原，状态通过 JSON 在 hook 间传递，保留真实工具、usage、reasoning、refusal 和截断原因。只转发实际收到的 DONE；done:true 仅校验，不补成功结束。

## 安装与更新

主要安装入口为 Root 后台上传 dist/newapi-fc.plugin.js，再绑定一个类型61渠道。附带 Python 标准库管理脚本支持 install/update/remove，上传后按宿主返回的 active 状态激活版本，--enable-runtime 显式开启全局开关。管理令牌和内部模型 Key 用途分别写清。

## 验证与 review

保留已有87项测试。新增插件元数据/配置、模型列表ctx.state:null、别名反解、旁路模型回写、JSON与分片stream状态、构建单文件在无Node全局的VM中执行；新增真实本地HTTP回环模拟，分别验证目录和生成，仅一次供应商调用以及未进入FC的raw请求。安装器测试覆盖上传、显式激活及失败无重试。

三轮独立review：接口/架构、实现交叉审查、修复后复验。当前环境无Docker或Go语言工具链，VM与HTTP模拟不冒充实际NewAPI容器运行。交付同一仓库更新、可直接上传的JS、含部署说明的完整源码ZIP。

