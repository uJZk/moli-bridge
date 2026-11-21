# 待办事项

目标是构建包含 Moli、FlareSolverr API 桥接和外部 Playwright CDP 入口的一体化镜像，并尽量复用上游代码以便更新。

- [x] 确定 MoviePilot 插件名称或源码及优先验证的目标站点，核对插件实际使用的 API 字段、命令和错误处理。详见 [兼容性调查](flaresolverr-bridge-investigation.md)。
- [x] 固定 TRAWL 上游版本，核验其会话接口实现与许可义务；通过原型评估复用其代码、适配 Moli CDP 的改动范围和后续同步方式，再确定桥接实现。已适配部分代码并记录 [来源和许可](UPSTREAMS.md)；各挑战的实站验证仍见下方待办。
- [x] 在本地 HTTP 目标上验证 FlareSolverr 会话契约：创建响应包含 `session`，列出、销毁和不存在的会话行为正确；会话内 Cookie 保留、会话之间隔离。
- [ ] 按目标插件的调用验证 GET、POST、请求体、Cookie、代理、超时、响应状态和错误处理。
- [x] 按用户决定采用单容器；Bridge 与 CDP 仍分别创建 Moli 进程，但共享网络、进程空间和资源限额，不再要求资源隔离验证。
- [ ] 在目标受保护站点实测挑战处理，确认实际可用性；验证外部 Playwright 的连接及基本操作。
- [ ] 2026-11-20 用户在真实 `https://www.torrentkitty.cam/` 上测试镜像 `5668d9f00`：浏览器检测到新的非空 `cf_clearance`，CDP 报告后续主页面请求携带该 Cookie；一次 Bridge 恢复及后续导航仍返回 HTTP 403，55 秒后超时。未检测到可交互验证控件，Cloudflare 子请求也返回 401；这些现象不能单独证明具体检测原因，也不能确认 Cookie 的有效性。用户此前同一 URL 通过旧服务返回 200，但本次未做并行对照。本环境无法访问该站点；当前镜像的实站验证未通过，具体根因未确定。如果证实是 Moli 自身限制导致网站拒绝，按用户要求可放弃该方向。
- [x] 2026-11-20 增加默认关闭的 Bridge 脱敏诊断；本地模拟验证页检查了超时阶段、响应、脚本异常、验证尝试及日志脱敏。诊断开启时通过文档启动监听器补充同步脚本异常的上报；缺少异常事件仍不能证明脚本正常。
- [x] 2026-11-19 [发布任务](https://github.com/uJZk/moli-bridge/actions/runs/44500435344)构建并发布了单容器镜像；该次清单摘要为 `sha256:cb6f25635740535752bc4beb9f6b19784d0f82445690ac4440eb75067f78e9d2`，源码版本为 `6102c0b13516b0824c1c88eab31e6595cca3ae25`。
- [x] 2026-11-19 拉取上述 `latest`：Bridge 单元测试 20 项通过，AMD64 单容器的 Bridge、CDP、RSSHub 风格连接和重启复测通过；ARM64 运行验证按用户要求跳过。
- [x] 2026-11-20 [发布任务](https://github.com/uJZk/moli-bridge/actions/runs/44703322519)构建并发布 `ghcr.io/ujzk/moli-bridge:latest`；清单摘要为 `sha256:6b970ed54b3a324111a90eb9df70d0c56984b9565a1150586cb6147e429ca9b3`，AMD64 和 ARM64 的源码版本均为 `5668d9f008ce78fd199ad186a5670a7de4f4de77`。GitHub Actions 的 Bridge 测试和 AMD64 容器回归通过；按用户要求跳过 ARM64 运行验证。后续纯文档提交不会重新构建镜像。

- [ ] 外部 Playwright CDP 入口兼容 URL 参数；网关原型已支持示例中的参数以及 Moli 原生可配置的设备、身份、位置、网络和媒体设置，详见[参数与默认值](../flaresolverr-bridge/README.md#experimental-cdp-query-gateway)。Moli 本身会忽略这些 URL 参数。

- [x] 支持 RSSHub 使用的 Browserless 风格 CDP `launch` 参数和直接 WebSocket；使用 RSSHub 固定版本的 Patchright 客户端检查浏览器上下文、代理、CDP Fetch 及断线清理。
- [ ] 在用户实际 RSSHub 部署中验证路由及上游目标；固定版本可选 [CDP 重试、Node 重试、UPS 路由和 Moli 专用认证代理补丁](../tools/rsshub/README.md)尚需按需在该部署的构建中应用。已在本地 TLS 夹具中验证完整 RSSHub 服务的 UPS 路由、Bilibili 412 后浏览器重试、认证代理和 Moli 网关，并检查认证失败；实站挑战通过情况不能由此推断。
- [ ] 排查并修复 Moli 1.1.26 中 DOM 变化后布局快照不刷新的问题，影响动态插入表格行、普通元素和已有元素的尺寸变化；[独立复现](../tools/rsshub/README.md)可用于验证更新后的构建，当前 UPS 路由补丁仅绕过该问题。
- [x] 基于 Jackett 使用的 FlareSolverrSharp 4.0.0 验证本地挑战后的 Cookie、UA 交接与重试，并覆盖缺少或无关 Cookie 的失败；[可选补丁](../tools/jackett/README.md)还通过完整 Jackett 使用 TorrentKitty 解析规则的本地 Torznab 搜索。真实 TorrentKitty 仍需实测。
- [x] 验证挑战 iframe 中的可访问复选框和开放 Shadow DOM，包括本地 TLS 跨源夹具、封闭 Shadow DOM 的命中检查、令牌交接和无关 iframe 不被自动点击；真实 Cloudflare 仍需实测。
- [x] 修复源码版 Moli 中 iframe 子文档的 Tab 焦点遍历和键盘事件投递；本地 AMD64 构建已通过[对照检查](../flaresolverr-bridge/README.md)和跨域夹具。上游 1.1.26 发布版仍有此问题。
- [x] 此前一次 Rust 工作区验证完成格式、Clippy 和 Nextest 全套测试：23,714 项通过，20 项按测试配置跳过；该历史结果不代表后续提交的全量测试结果。本地单容器的两个入口及重启恢复也已通过冒烟测试。
- [ ] 核对[最新 GitHub CI](https://github.com/uJZk/moli-bridge/actions/workflows/ci.yml) 的全量 Nextest 结果：此前一轮在后续提交时被取消，截至 2026-11-21 文档整理时，后续一轮仍在等待自托管运行器，不能记为通过。
- [ ] 在实际受保护站点验证已发布的源码版 Moli iframe 修复；也可通过 [Compose 覆盖配置](../flaresolverr-bridge/README.md#container-build-and-use)挂载源码构建。
