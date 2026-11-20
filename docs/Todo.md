# 待办事项

目标是构建包含 Moli、FlareSolverr API 桥接和外部 Playwright CDP 入口的一体化镜像，并尽量复用上游代码以便更新。

- [x] 确定 MoviePilot 插件名称或源码及优先验证的目标站点，核对插件实际使用的 API 字段、命令和错误处理。详见 [兼容性调查](flaresolverr-bridge-investigation.md)。
- [x] 固定 TRAWL 上游版本，核验其会话接口实现与许可义务；通过原型评估复用其代码、适配 Moli CDP 的改动范围和后续同步方式，再确定桥接实现。已适配部分代码并记录 [来源和许可](UPSTREAMS.md)；各挑战的实站验证仍见下方待办。
- [x] 在本地 HTTP 目标上验证 FlareSolverr 会话契约：创建响应包含 `session`，列出、销毁和不存在的会话行为正确；会话内 Cookie 保留、会话之间隔离。
- [ ] 按目标插件的调用验证 GET、POST、请求体、Cookie、代理、超时、响应状态和错误处理。
- [x] 按用户决定采用单容器；Bridge 与 CDP 仍分别创建 Moli 进程，但共享网络、进程空间和资源限额，不再要求资源隔离验证。
- [ ] 在目标受保护站点实测挑战处理，确认实际可用性；验证外部 Playwright 的连接及基本操作。
- [ ] 用户报告 TorrentKitty 在新 Bridge 超时、旧服务返回 HTTP 200；本环境连接该站点被网络代理拒绝，尚未确定真实原因。已复现并修复一个可能耗尽请求预算的独立场景：页面主体就绪后图片请求一直不结束；仍需使用用户的实际请求和网络复测。
- [x] 构建并发布单容器镜像；AMD64 和 ARM64 均使用当前仓库构建的 Moli，按用户要求跳过 ARM64 运行验证。[发布任务](https://github.com/uJZk/moli-bridge/actions/runs/44500435344)已推送 `ghcr.io/ujzk/moli-bridge:latest`，镜像清单摘要为 `sha256:cb6f25635740535752bc4beb9f6b19784d0f82445690ac4440eb75067f78e9d2`；两个架构的镜像源码版本均为 `6102c0b13516b0824c1c88eab31e6595cca3ae25`。
- [x] 2026-11-19 拉取上述 `latest`：Bridge 单元测试 20 项通过，AMD64 单容器的 Bridge、CDP、RSSHub 风格连接和重启复测通过；ARM64 运行验证按用户要求跳过。

- [ ] 外部 Playwright CDP 入口兼容 URL 参数；网关原型已支持示例中的参数以及 Moli 原生可配置的设备、身份、位置、网络和媒体设置，详见[参数与默认值](../flaresolverr-bridge/README.md#experimental-cdp-query-gateway)。Moli 本身会忽略这些 URL 参数。

- [x] 支持 RSSHub 使用的 Browserless 风格 CDP `launch` 参数和直接 WebSocket；使用 RSSHub 固定版本的 Patchright 客户端检查浏览器上下文、代理、CDP Fetch 及断线清理。
- [ ] 在用户实际 RSSHub 部署中验证路由及上游目标；固定版本可选 [CDP 重试、Node 重试、UPS 路由和 Moli 专用认证代理补丁](../tools/rsshub/README.md)尚需按需在该部署的构建中应用。已在本地 TLS 夹具中验证完整 RSSHub 服务的 UPS 路由、Bilibili 412 后浏览器重试、认证代理和 Moli 网关，并检查认证失败；实站挑战通过情况不能由此推断。
- [ ] 排查并修复 Moli 1.1.26 中 DOM 变化后布局快照不刷新的问题，影响动态插入表格行、普通元素和已有元素的尺寸变化；[独立复现](../tools/rsshub/README.md)可用于验证更新后的构建，当前 UPS 路由补丁仅绕过该问题。
- [x] 基于 Jackett 使用的 FlareSolverrSharp 4.0.0 验证本地挑战后的 Cookie、UA 交接与重试，并覆盖缺少或无关 Cookie 的失败；[可选补丁](../tools/jackett/README.md)还通过完整 Jackett 使用 TorrentKitty 解析规则的本地 Torznab 搜索。真实 TorrentKitty 仍需实测。
- [x] 验证挑战 iframe 中的可访问复选框和开放 Shadow DOM，包括本地 TLS 跨源夹具、封闭 Shadow DOM 的命中检查、令牌交接和无关 iframe 不被自动点击；真实 Cloudflare 仍需实测。
- [x] 修复源码版 Moli 中 iframe 子文档的 Tab 焦点遍历和键盘事件投递；本地 AMD64 构建已通过[对照检查](../flaresolverr-bridge/README.md)和跨域夹具。上游 1.1.26 发布版仍有此问题。
- [x] 完成 Rust 工作区格式和 Clippy 检查，以及 Nextest 全套测试：23,714 项通过，20 项按测试配置跳过。本地单容器的两个入口及重启恢复也已通过冒烟测试。
- [ ] 在实际受保护站点验证已发布的源码版 Moli iframe 修复；也可通过 [Compose 覆盖配置](../flaresolverr-bridge/README.md#container-build-and-use)挂载源码构建。
