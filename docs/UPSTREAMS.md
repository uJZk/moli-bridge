# 上游来源与同步指南

本文记录桥接项目实际引用的主要上游，以及更新时应检查的位置。这里的版本是仓库当前固定值；更新后应同时修改本文和对应代码、锁文件或校验值。完成本地验证并检查发布影响后，再按项目正常流程提交和发布。

## 引用了什么

| 上游 | 当前来源 / 版本 | 在本项目中的用途 | 许可及记录位置 |
| --- | --- | --- | --- |
| [Moli](https://github.com/lexmount/moli) | 仓库内保留 Moli Rust 工作区；容器另行下载官方 `v1.1.26` 二进制，标签指向 `c80617869d971d23304a52d8b39f51ee677571b4` | 提供浏览器、CDP 和网络能力 | Apache-2.0 OR MIT；参见根目录的 `LICENSE-APACHE`、`LICENSE-MIT`、`license-metadata.json` 和 `licenses/`。镜像还保留所下载发行包内的许可与 NOTICE 文件 |
| [Playwright](https://github.com/microsoft/playwright) | npm `playwright-core` **1.58.0** | 桥接与 CDP 网关作为 CDP 客户端连接 Moli | Apache-2.0；见 npm 包的 LICENSE 和 `flaresolverr-bridge/package-lock.json` |
| [ws](https://github.com/websockets/ws) | npm `ws` **8.23.0** | CDP 网关 WebSocket 转发 | MIT；见 npm 包的 LICENSE 和 `flaresolverr-bridge/package-lock.json` |
| [FlareSolverr](https://github.com/FlareSolverr/FlareSolverr) | `cc2224b21e31c09a713eb25690a8e8dcdf50d8d8` 的 `src/flaresolverr_service.py` | 仅移植挑战／拒绝访问的标题和选择器到 `flaresolverr-bridge/upstream/challenges.mjs` | MIT；保留了 `flaresolverr-bridge/upstream/FlareSolverr-LICENSE`。本项目没有引入上游完整服务或挑战求解器 |
| [Node.js Docker 官方镜像](https://github.com/nodejs/docker-node) | `node:22-bookworm`、`node:22-bookworm-slim` | 作为构建阶段和运行基础镜像 | Node.js 和其中各软件包分别适用其许可；当前标签没有固定镜像摘要，重建时内容可能变化 |

镜像构建还从完整 Node/Debian 镜像复制 fontconfig、FreeType、Expat、libpng、Brotli、bzip2 运行库，以及字体和 CA 证书。它们的版本取决于构建时解析到的基础镜像；更新基础镜像时应检查实际软件包版本及其许可和通知文件。Moli Rust 工作区还有大量第三方 crate，**完整依赖不是上表的枚举范围**：以根目录 `Cargo.lock` 和各 crate 的 `Cargo.toml` 为准，并核对发行包的许可材料。可用 `cargo metadata --locked --format-version 1` 生成包含依赖版本、来源和许可字段的机器可读清单。

两个容易混淆的参考来源：

- [MoviePilot sehuatangsignin](https://github.com/Vivitoto/MoviePilot-Plugins/tree/7c7d1036423f3e7350f307c7ad87bd6d2044712a/plugins.v3/sehuatangsignin) 固定在 `7c7d1036423f3e7350f307c7ad87bd6d2044712a`，仅作为**必须兼容的目标插件及测试输入**；测试时下载其源码，未将其作为运行依赖打包。
- [TRAWL](https://github.com/germondai/trawl) 曾在 `38e4b21de1061ea531cf711fec5efa5ac46ef9ee` 被评估，**没有引入其代码或依赖**。其 AGPL-3.0 许可和复用障碍记录在[兼容性调查](flaresolverr-bridge-investigation.md)；若未来决定引入，须先重新检查版本、适配方式和许可义务。

## 更新 Moli：源码与容器分别处理

**更新源码仓库不会自动更新镜像里的 Moli。** 当前镜像使用 `scripts/prepare-bridge-container.sh` 下载并校验的官方发行包，Dockerfile 不编译工作区源码。反之，升级容器发行包也不会自动合并上游源码。

### 同步本仓库的 Moli 源码

在干净工作区的新分支操作，并先核对已有远程地址；不要覆盖或强推现有分支：

```sh
git remote -v
# 若不存在 upstream，再添加；若已存在，先确认它指向预期的上游。
git remote add upstream https://github.com/lexmount/moli.git
git fetch upstream --tags
git switch -c chore/sync-moli
git log --oneline --left-right HEAD...upstream/main
git merge upstream/main
```

如已有 `upstream`，跳过 `git remote add`。按冲突内容逐项合并桥接、容器和文档改动，复核 `Cargo.lock`、`rust-toolchain`、许可证及本仓库的 [AGENTS.md](../AGENTS.md)。涉及 Rust 源码或构建元数据时，提交前必须从仓库根目录运行：

```sh
cargo fmt --all
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo nextest run --no-fail-fast
```

同时按照 [moli-cdp-smoke/README.md](../moli-cdp-smoke/README.md) 构建所选 Moli 二进制并运行相关 Playwright／CDP 场景；需要核对的高价值协议契约还应放在对应 Rust 边界。最后执行下文的桥接与容器验证。不要仅依据版本号假定源码分支与官方发行二进制相同。

### 更新镜像中的 Moli 官方发行包

1. 选择并审查上游发行版和变更，分别取得 Linux AMD64、ARM64 官方归档；核对其来源、许可证和两个文件的 SHA-256。若上游提供可信的校验值，应与之比对；仅对下载文件自行计算哈希不能单独证明来源真实性。
2. 同步修改 `scripts/prepare-bridge-container.sh` 中的发行版本、缓存文件名和两个 SHA-256，以及 `flaresolverr-bridge/Dockerfile` 中两个对应的 SHA-256；同时更新 [桥接说明](../flaresolverr-bridge/README.md)和本文的版本记录。两个脚本都校验哈希，任一处漏改都会使构建失败。
3. 重新准备输入、构建并运行本机架构容器测试：

   ```sh
   ./scripts/prepare-bridge-container.sh
   docker build -f flaresolverr-bridge/Dockerfile -t moli-bridge:local .
   MOLI_BRIDGE_IMAGE=moli-bridge:local ./scripts/smoke-bridge-container.sh
   ```

4. 运行下文的插件与 CDP 契约检查。另需检查 AMD64 和 ARM64 的运行情况、完整许可材料与目标站点；本地只验证一种架构时不要推断另一种也通过。`.github/workflows/container.yml` 在发布 `latest` 前分别构建并测试两种架构，ARM64 测试使用 QEMU；检查实际 Actions 结果和已发布的镜像清单。

准备脚本使用被忽略的 `.container-assets/`，每次运行会重新生成该目录。可按[容器指南](../flaresolverr-bridge/README.md#container-build-and-use)设置 `MOLI_RELEASE_CACHE_DIR`，但缓存中的归档仍必须通过固定哈希校验。

## 更新 Playwright 和 ws

1. 查看上游发行说明、Node 版本要求与许可变化；在 `flaresolverr-bridge/` 使用 `npm install --save-exact playwright-core@<目标版本>` 或 `npm install --save-exact ws@<目标版本>`，一起提交 `package.json` 和 `package-lock.json`。不要手改锁文件中的完整性哈希。
2. 执行 `npm ci`、`npm test` 和 `npm audit --omit=dev`。桥接使用 Playwright 的 `connectOverCDP`；网关依赖扁平 CDP 会话、自动附加和 WebSocket 消息顺序，升级后必须实际运行下文的 CDP 与容器测试。
3. Python CDP 冒烟项目使用自己的 `moli-cdp-smoke/uv.lock`；它与桥接的 npm 锁文件是独立的。按需审查和更新各自版本，不能仅更新一边就宣称两个客户端都验证过。

## 同步 FlareSolverr 检测规则

比较固定版本与候选版本的上游 `src/flaresolverr_service.py` 和 LICENSE，审查标题、选择器、误报及上游行为变化；不要直接把整个 Selenium 服务替换进来。例如：

```sh
git clone https://github.com/FlareSolverr/FlareSolverr.git /tmp/moli-flaresolverr-upstream
git -C /tmp/moli-flaresolverr-upstream diff cc2224b21e31c09a713eb25690a8e8dcdf50d8d8 HEAD -- src/flaresolverr_service.py LICENSE
```

有选择地更新 `flaresolverr-bridge/upstream/challenges.mjs`，将文件头中的来源提交改为实际审查的提交，并保留或按上游变更更新 `FlareSolverr-LICENSE` 和许可说明。运行桥接契约中的挑战／拒绝访问测试，并对目标站点实测；规则匹配通过不意味着挑战已解决。

## 重新核对 MoviePilot 插件

比较固定提交与所选新版本的 `plugins.v3/sehuatangsignin/__init__.py`、`captcha_server.py`，重点检查实际请求命令、Cookie、请求头、代理、超时、错误响应及独立浏览器／POST 路径。更新[测试说明](../tools/flaresolverr-contract/README.md)中的固定提交与 `captcha_server.py` 的 SHA-256，再运行实际辅助函数测试；若源码结构变化，也要调整测试的函数提取方式，而不是跳过失败。

例如，确定并审查新提交后，将下面的 `<提交 SHA>` 替换为完整提交号，以该固定版本下载测试输入并计算校验值：

```sh
curl -fsSL 'https://raw.githubusercontent.com/Vivitoto/MoviePilot-Plugins/<提交 SHA>/plugins.v3/sehuatangsignin/captcha_server.py' -o /tmp/moli-moviepilot-captcha.py
sha256sum /tmp/moli-moviepilot-captcha.py
```

计算出的校验值用于固定后续测试输入；应另行核对该提交和下载内容的来源。

插件使用的独立浏览器及直接请求路径不由 `/v1` 代理。测试夹具通过只能证明接口契约，不能替代目标站点挑战和完整签到验证。

## 统一回归与发布检查

1. 启动**用于测试**的桥接与独立 CDP 网关。按[契约测试说明](../tools/flaresolverr-contract/README.md)运行实际 MoviePilot 辅助函数、会话、Cookie、GET/POST、错误、超时及代理检查；代理测试需显式启用 `--test-proxy` 并使用桥接能访问的地址，跳过不算通过。
2. 在 `flaresolverr-bridge/` 运行 `npm test`，再按契约测试说明对可丢弃的网关运行 `check-cdp-profile.mjs` 和 `check-cdp-gateway.mjs`；检查空值、多个并发客户端、页面与 Worker、导航和设置覆盖。必要时运行 `moli-cdp-smoke` 中受影响的场景。协议测试本身不能证明服务间资源隔离。
3. 构建镜像并运行 `scripts/smoke-bridge-container.sh`，检查两个角色的健康状态、实际请求与重启恢复。Compose 中进程、网络和资源限制必须在目标部署环境实测；还需并发、破坏性控制及资源耗尽／恢复测试。当前环境曾报告 `CgroupDriver=none`，不能将配置值当作资源限制已生效的证据。
4. 按正常发布流程更新文档与待办。推送影响镜像的变更到 `main` 会触发 `.github/workflows/container.yml`，在两架构冒烟测试通过后推送 `ghcr.io/ujzk/moli-bridge:latest` 和 `sha-<commit>`。检查实际运行状态与远程镜像清单，再报告发布结果；当前完整 MoviePilot 签到和受保护站点挑战仍需单独验证。

如果更新 GitHub Actions，本仓库的工作流使用固定提交 SHA；应核对官方仓库标签、变更和权限后同时更新 SHA 与版本注释。基础镜像当前是浮动标签，更新前后要审查解析到的摘要、架构和系统库，而不是假设标签内容不变。
