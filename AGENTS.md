# Cerebr 项目原则（给后续工程师）

本文件记录本仓库的关键架构约定与发布流程，避免在 iOS Safari、缓存与版本化资源上反复踩坑。

## 架构理解（Web + Extension 共用一套前端）

- **两种运行形态**
  - **浏览器扩展页**：直接加载未版本化的 `src/main.js` + `styles/main.css`。
  - **Web（GitHub Pages / Vercel）**：通过 `src/boot.js` 选择并加载 **版本化资源**（见下文 `v/`）。

- **Web 的启动链路（核心）**
  1. `index.html` 先加载默认的 `styles/main.css`（兜底）。
  2. `src/boot.js` 以 `cache: 'no-store'` 拉取 `manifest.json` / `manifest.firefox.json`，拿到 `version`。
  3. 若拿到 `version`：把样式切换到 `v/<version>/styles/main.css`，并 `import v/<version>/src/main.js`。
  4. 这么做的目的：**规避 iOS Safari 对 ESM/静态资源“顽固缓存”导致的旧代码不更新问题**。

- **滚动/输入栏布局（当前实现）**
  - 页面层面：`body` 为 `position: fixed; overflow: hidden;`（禁用页面滚动）。
  - 真正的滚动容器：`#chat-container`（内部滚动）。
  - 输入栏：`#input-container`（底部 `position: fixed`）。
  - 这意味着：Safari 的地址栏自动隐藏、下拉刷新等“页面级滚动行为”可能不会出现（因为页面本身不滚动）。

## `v/` 目录（版本化 Web 资源）

- **它是什么**
  - `v/<version>/src/**`：从根目录 `src/` 拷贝出来的版本化源码。
  - `v/<version>/styles/**`：从根目录 `styles/` 拷贝出来的版本化样式。
  - 注意：不要直接手改 `v/<version>/...`，应修改 `src/` / `styles/` 后重新生成。

- **如何生成**
  - 脚本：`scripts/gen_web_versioned_src.sh`
  - 逻辑：读取 `manifest.json` 的 `version`，生成 `v/<version>/src` 与 `v/<version>/styles`，并对少量跨目录引用做路径修正（例如 `htmd/latex.js`、`@import` 路径）。

## 发布/升级（建议流程）

1. 修改版本号：`manifest.json` 与 `manifest.firefox.json`
2. 生成版本化资源：运行 `bash scripts/gen_web_versioned_src.sh`
3. 检查 Web 启动链路：
   - `src/boot.js` 能否成功 import `v/<version>/src/main.js`
   - CSS 是否已指向 `v/<version>/styles/main.css`
4. 再提交/部署

## `v/` 只保留一个版本（仓库策略）

本仓库当前策略：**`v/` 目录只保留“最新版”的一个版本**，避免仓库膨胀与历史版本堆积。

- 操作建议（发布时）：
  - `rm -rf v/*`
  - `bash scripts/gen_web_versioned_src.sh`

注意：只保留一个版本的代价是——如果用户端极端情况下缓存了旧的 `boot.js` 或旧 `version`，可能会请求到不存在的 `v/<old>/...` 导致 404。此策略是“体积/维护成本优先”的取舍。

## 插件模板同步

- 独立插件模板仓库路径：`/Users/yanyuming/Downloads/GitHub/cerebr-plugin-template`
- 这个模板仓库的目标是：**让第三方开发者不需要阅读 Cerebr 主仓库源码，也能开发插件**。
- 因此，只要本仓库的插件系统发生变更，必须评估并同步更新 `cerebr-plugin-template`。不要只改主仓库而放着模板不管。

以下变更都默认需要同步检查模板：

- `plugin.json` / `registry` schema 变化
- 插件 runtime API 变化（`page` / `shell` / `background`）
- 权限模型变化
- hook 生命周期变化
- 插槽（slot）变化
- 本地侧载、开发者模式、市场安装流程变化
- 插件示例或推荐目录结构变化

同步时至少检查这些内容：

- 模板根目录示例插件是否还能正常工作
- `docs/` 里的 API、权限、发布文档是否仍然准确
- `examples/` 下的脚本式 / 声明式示例是否需要更新
- `schemas/` 下的 schema 副本是否需要同步
- `scripts/check-manifests.mjs` 的校验规则是否仍匹配当前宿主实现
