# Native Provider Plugin Implementation Plan

**Goal:** 在现有 New API 容器中安装 FC 原生插件，并用单一渠道批量发布所选模型别名。

**Architecture:** Provider API v1 负责请求发送与流解析；薄适配层复用现有正文和模型逻辑，产出单文件插件。类型61渠道回环固定raw分组的原模型。

**Tech Stack:** 宿主JavaScript、Node.js标准库构建与测试、Python标准库管理API脚本。

**Spec:** docs/PLUGIN_DESIGN.md

## Global Constraints

- 插件key newapi_fc_gateway、版本2.1.0，已核对NewAPI v1.0.0-rc.51。
- 不增加容器/监听服务/第三方依赖/SHA校验/自动重试/后台同步。
- 保留原网关，核心源码只维护一份；插件模型目录只发布别名。
- 不改宿主源码或通过安装器改全站计费及分组。

## 1. 插件适配与构建

文件：src/plugin.js、scripts/build-plugin.mjs、tests/plugin.test.mjs、tests/plugin-build.test.mjs、dist/newapi-fc.plugin.js。

接口：export meta、convertRequest(ctx,{body,model,stream})、convertResponse(ctx,{status,headers,body})、convertStreamEvent(ctx,input)。meta.relay 中chat与models均converter:plugin。

- [x] 写最小失败用例：模型列表输入alpha/beta只输出alpha-fc；state为null仍可取列表；chat alpha-fc变alpha且注入正文工具。
- [x] 运行 node --test tests/plugin.test.mjs，观察未实现行为失败。
- [x] 实现channelConfig及三个hooks；旁路只改模型名，非2xx保留宿主错误路径。
- [x] 验证逐事件JSON state往返、业务工具共存、截断与实际DONE。
- [x] 构建脚本读取aliases/content-json/transform/plugin，去除import和内部export，保留插件export；node scripts/build-plugin.mjs产出单文件。
- [x] VM测试直接执行产物，检查没有Node模块依赖，完成列表与生成回合。

## 2. 回环契约集成

文件：tests/plugin-loopback.test.mjs。调用真实本地HTTP服务器模拟宿主与原模型渠道，使用三个实际hooks；不模拟生产转换逻辑。

- [x] 先定义目录仅别名、外层用户Key/内层raw Key、真实模型名、一次生成和SSE增量的失败断言。
- [x] 验证原模型请求不会进入FC分支，raw权限拒绝时不产生供应商调用。
- [x] 与插件单元测试一起运行，记录模拟范围及结果。

## 3. 安装器与文档

文件：scripts/manage-plugin.py、tests/test_manage_plugin.py、docs/PLUGIN.md。

- [x] 复用旧安装器的stdlib结构，先测试插件key/产物路径与上传后active:false必须POST activate。
- [x] 实现install/update/remove；激活成功后再按显式参数启用总开关；失败不重试或回滚。
- [x] 写明后台上传、一次建渠道、容器内端口、raw分组/固定Key、获取并保存模型及FC价格。
- [x] 核对管理API与scope、更新版本的激活步骤；验证安装器测试和文档命令语法。

## 4. 合并、review与交付

- [x] README优先说明原生插件；独立网关文档移至docs/GATEWAY.md；更新package版本与构建/测试命令。
- [x] 第一轮独立接口与架构review。
- [x] 第二轮由非实现者交叉审查代码与安装说明，具体问题先复现再修复。
- [x] 第三轮修复后独立复验；更新docs/PLUGIN_REVIEW.md。
- [x] 测试完整项目与解压后的源码包，核对构建插件与源码一致。

## 外部交付

将已审查源码和产物提交Derstedt/newapi-fc-gateway，保留现有main内容；提供完整ZIP和可直接上传的插件JS。实际提交和文件地址在交付回复记录。

