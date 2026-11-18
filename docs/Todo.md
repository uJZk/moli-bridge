# 待办事项

目标是构建包含 Moli、FlareSolverr API 桥接和外部 Playwright CDP 入口的一体化镜像，并尽量复用上游代码以便更新。

- [x] 确定 MoviePilot 插件名称或源码及优先验证的目标站点，核对插件实际使用的 API 字段、命令和错误处理。详见 [兼容性调查](flaresolverr-bridge-investigation.md)。
- [ ] 固定 TRAWL 上游版本，核验其会话接口实现与许可义务；通过原型评估复用其代码、适配 Moli CDP 的改动范围和后续同步方式，再确定桥接实现。
- [x] 在本地 HTTP 目标上验证 FlareSolverr 会话契约：创建响应包含 `session`，列出、销毁和不存在的会话行为正确；会话内 Cookie 保留、会话之间隔离。
- [ ] 按目标插件的调用验证 GET、POST、请求体、Cookie、代理、超时、响应状态和错误处理。
- [ ] 验证外部 Playwright 使用独立的 Moli 实例和控制面，并具备足够的资源隔离，避免其干扰或控制桥接及桥接后端；使用并发客户端和破坏性控制操作测试隔离与恢复。
- [ ] 在目标受保护站点实测挑战处理，确认实际可用性；验证外部 Playwright 的连接及基本操作。
- [ ] 构建镜像并以独立容器运行两个角色。AMD64 本地已验证健康检查、接口调用及重启恢复；ARM64 仍需验证，镜像使用上游 Moli 1.1.26 官方二进制。
- [ ] 验证 GitHub Actions 镜像发布和多架构支持；工作流已配置为两个架构的容器冒烟测试通过后发布实验版。

- [ ] 外部 Playwright CDP 入口兼容 URL 参数；独立网关原型已支持示例中的参数以及 Moli 原生可配置的设备、身份、位置、网络和媒体设置，详见[参数与默认值](../flaresolverr-bridge/README.md#experimental-cdp-query-gateway)。仍需在部署隔离边界内进行完整验证；Moli 本身会忽略这些 URL 参数。
