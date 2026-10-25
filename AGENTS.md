# Cerebr 项目原则（给后续工程师）

本文件记录本仓库的关键架构约定与发布流程，避免在 iOS Safari、缓存与版本化资源上反复踩坑。

## 架构理解（React + Vite，Web 与 Extension 共用前端）

- 唯一界面入口是 `src/main.jsx`，React 组件在 `src/app/components/`。不再保留原生 DOM 页面实现或第二套启动路径。
- `src/domain/chat/chat-store.js` 提供可订阅的聊天存储；React 通过 `useSyncExternalStore` 读取状态。保留已有用户数据的存储键与导入导出能力。
- `src/runtime/chat/` 管理真实 API 请求、流式响应、取消与插件钩子，不操作消息 DOM。
- `src/runtime/input/native-editor.js` 是 contentEditable 的原生选区、撤销、IME、图片粘贴与触摸处理边界，由 React 会话负责订阅和清理。
- React 管理插件的菜单、操作按钮、声明式页面与弹窗；插件提供的 DOM/iframe 节点只在 SDK 的挂载边界内由插件管理。不要直接修改宿主 React 子树。
- 原有 CSS 继续是视觉规范。`#root { display: contents }` 保持原来的 body flex 布局。
- `body` 仍为 fixed / overflow hidden，`#chat-container` 内部滚动，`#input-container` 底部固定；保留 visualViewport 对 iOS 键盘的适配。

## 开发与构建

需要 Node.js 22.12+（CI 使用 24）及 htmd 子模块。

```bash
git submodule update --init --recursive
npm ci
npm run dev
npm run check
npm run preview
npm run package:extension
```

- Vite 开发入口直接加载 React；`npm run build` 生成唯一可发布目录 `dist/`。
- Web 与扩展都加载编译产物的 `index.html` → `boot.js` → `web-manifest.json` → `v/<version>/*-<hash>.js/css`。
- 仓库根目录的 `manifest.json` / `manifest.firefox.json` 将 background、content scripts、sandbox 和可公开访问资源指向 `dist/`。原有根目录扩展安装可在构建后直接重新加载，保留扩展 ID 与存储。
- Firefox / Zen 临时加载目录中的任意文件都会读取该目录的 `manifest.json`，选择 `manifest.firefox.json` 不会切换清单。根目录 `manifest.json` 必须同时保留 `background.service_worker` / `background.scripts`（同一个编译入口，Chrome / Firefox 121+），以及与 Firefox 专用清单一致的 Gecko ID；Firefox 安装包仍使用专用清单。
- `commands` 只作为顶层快捷键配置，不写入 `permissions`。`userScripts` 在两份清单中均放入 `optional_permissions`（Firefox 不接受必选声明）；在插件设置中由用户点击授权，后台监听权限授予/撤销重新同步网页脚本。Chrome 的「允许用户脚本」开关仍需开启。
- 构建脚本将上述 manifest 的运行时路径转换为产物根目录相对路径，写入 `dist/`，用于独立安装包。两种安装位置加载的是同一套编译产物，没有源码运行兜底。
- `boot.js` 以 `cache: 'no-store'` 读取清单，先加载 CSS，再导入应用。保持 Safari 缓存规避机制；没有未构建源码兜底。
- `base: './'` 支持 GitHub Pages 项目子路径、自定义域名及扩展 URL。页面切换是 React 状态，不需要服务端路由回退。
- 扩展 background、content 入口及 guest HTML 都由 Vite 编译；必须保留 content 入口的 `bootContentScript` 导出。`content.js` 只负责扩展模块加载与消息队列。
- `htmd/`、`lib/` 等独立运行时资源随构建复制；不要用打包后的 `import.meta.url` 推导公开资源路径，使用 `appAssetUrl()`。扩展资源根目录由已安装 manifest 的 background 入口目录确定；`chrome.scripting.executeScript({ files })` 使用 `extensionAssetPath()`。
- `scripts/verify-build.mjs` 必须检查 content 模块全部静态/动态依赖在两种安装位置均被 `web_accessible_resources` 覆盖，避免恢复对宿主源码路径的依赖。
- `dist/`、`artifacts/` 均为生成物，不提交。仓库不再提交根目录 `v/`，不手改生成文件。

## 发布与缓存

1. 推送 `main` 会自动递增发布版本并同步四个版本文件及 `package-lock.json`；主动指定新版本时，同步更新 `manifest.json`、`manifest.firefox.json`、`package.json` 和 `desktop/package.json`。
2. 运行 `npm run check`（测试 + 构建），验证 `npm run preview`。
3. GitHub Pages 使用 GitHub Actions，上传 `dist`。Cloudflare Pages / Vercel 的构建命令为 `npm run build`，输出目录为 `dist`。
4. 运行 `npm run package:extension`，安装包在 `artifacts/`，Chrome 加载 `artifacts/chrome/`，Firefox 使用对应包。

构建每次清空 `dist`，只保留当前版本。清单禁缓存，哈希资源可长期缓存；旧页面跨发布请求已删除旧资源仍可能 404，重新加载会读取最新清单。没有 SSR 或本地 API 代理，模型服务仍需允许浏览器跨域访问。

## 插件模板同步

- 独立插件模板仓库路径：`/Users/yanyuming/Downloads/GitHub/cerebr-plugin-template`
- 这个模板仓库的目标是：**让第三方开发者不需要阅读 Cerebr 主仓库源码，也能开发插件**。
- 因此，只要本仓库的插件系统发生变更，必须评估并同步更新 `cerebr-plugin-template`。不要只改主仓库而放着模板不管。
- **硬性要求**：任何插件系统 API 的升级/更新，都必须同步更新 `/Users/yanyuming/Downloads/GitHub/cerebr-plugin-template`。这包括新增 API、删除 API、补齐原先缺失的 API、修改 API 返回值/同步异步语义、调整事件或能力暴露方式；不要以“只是修 bug”或“只是宿主侧补齐”为由跳过模板同步。

以下变更都默认需要同步检查模板：

- `plugin.json` / `registry` schema 变化
- 插件 runtime API 变化（`page` / `shell` / `background`）
- 插件系统 API 的语义变化（例如同步/异步行为、返回值结构、guest/runtime 可见性、默认能力暴露）
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

## 插件市场仓库同步

- 独立插件市场仓库路径：`/Users/yanyuming/Downloads/GitHub/cerebr-plugins`
- 这个仓库承载 **审核后的 marketplace registry 和插件包**，供 Cerebr 插件市场远程读取。
- `cerebr-plugins` 是官方 marketplace 插件的**唯一真源（source of truth）**。
- 主仓库里的 `statics/plugin-registry.json`、`statics/plugins/**`、`statics/runtime/**` 只是 **bundled fallback 快照**，不应手工维护。
- 官方 marketplace 插件或 registry 发生变化后，必须运行：
  - 主仓：`node scripts/sync_official_plugin_fallback.mjs`
  - 或市场仓：`cd /Users/yanyuming/Downloads/GitHub/cerebr-plugins && npm run sync:cerebr`
- 因此，只要本仓库的插件市场机制或官方上架插件发生变化，必须评估并同步更新 `cerebr-plugins`，必要时也同步更新本仓库里的 bundled fallback（`statics/plugin-registry.json`、`statics/plugins/**`）。

以下变化都默认需要同步检查 `cerebr-plugins`：

- `plugin-registry.json` 格式变化
- marketplace 插件安装 / 更新 / 下架逻辑变化
- script 插件远程加载约束变化
- 官方推荐插件集合变化
- 插件包目录结构变化
- schema 变化

同步时至少检查这些内容：

- `cerebr-plugins/plugin-registry.json` 是否仍能被当前宿主读取
- `cerebr-plugins/plugins/**` 下的包结构是否仍匹配当前运行时
- 远程 script 插件是否仍然保持“自包含”，没有错误依赖主仓库私有路径
- GitHub Pages 或其它托管地址是否仍然能正确提供 `plugin.json` / `.js`
- 本仓库 bundled fallback 是否需要镜像更新

## 桌面宿主

- Electron/TypeScript 宿主位于 `desktop/` workspace，继续复用唯一 React 构建产物，不另建桌面前端。
- `npm run check --workspace cerebr-desktop` 校验类型并实际启动打包后的同步 worker；`npm run package:desktop` 生成本机安装包。
- 同步只监听本机，修改协议或存储必须覆盖离线、删除、冲突和完整性校验。详情见 `docs/desktop.md`。
- 发布版本也要同步更新 `desktop/package.json`。

- `.github/workflows/release.yml` 在 main 推送时通过 `scripts/prepare-release.mjs` 自动准备版本提交和标签，并在全部平台构建成功后发布；相关 PR 只构建，仍支持 `v*` 标签或手动 publish。`scripts/release-version.mjs` 校验四个版本来源；重跑复用同一版本，不覆盖已发布版本。版本回写 main 只允许快进，开发前先拉取自动版本提交。
