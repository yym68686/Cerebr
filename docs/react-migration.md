# React + Vite 迁移验收记录

本次迁移直接替换 Cerebr 主仓库的界面层，保留现有 CSS 与产品布局。没有引入 Cordis、SSR 或 API 代理。

## 最终结构

- `src/main.jsx` / `src/app/App.jsx`：唯一应用入口与 React 页面树。
- `src/app/components/`：聊天消息、输入栏外壳、API 设置、历史列表、偏好设置、网页菜单、插件管理及插件宿主页面。
- `src/app/state/`：可订阅的界面、配置与偏好状态；聊天存储通过 `useSyncExternalStore` 接入。
- `src/app/session.js`：聊天会话、草稿、消息编辑、阅读位置、扩展消息和插件生命周期。
- `src/runtime/input/native-editor.js`：contentEditable 原生编辑边界，保留 IME、选区、撤销、粘贴、图片、光标和触摸处理。React 负责挂载和清理。
- `src/runtime/chat/`：不依赖消息 DOM 的发送、取消、重新生成、插件钩子和真实 HTTP/SSE 请求。
- `src/runtime/ui/`：插件 API 的描述符、状态与生命周期；宿主可见内容由 React 渲染。第三方插件自身的 DOM/iframe 节点通过专用挂载边界接入。

已删除旧 `src/main.js`、`src/boot.js`、原生 DOM 页面组件、旧消息渲染器及相应转发入口、源码复制脚本、仓库内生成的 `v/`。已有用户数据仍按原存储键读取；数据格式读取不等于保留第二套界面。

## 构建和部署

```bash
npm ci
npm run dev
npm run check
npm run preview
npm run package:extension
```

Web 和扩展共用 `dist/`：`index.html` → `boot.js` → 禁缓存获取 `web-manifest.json` → `v/<version>/*-<hash>.js/css`。资源使用相对路径，支持 GitHub Pages 项目子路径。

GitHub Pages 工作流改为构建并上传 `dist`；Cloudflare Pages 构建命令为 `npm run build`，输出目录为 `dist`；Vercel 配置已更新。Chrome / Firefox 安装包由编译产物生成在 `artifacts/`，不包含旧界面或源码入口。

## 已完成验证

### 视觉

以迁移前仓库的临时只读快照为基准，使用相同默认会话、配置、主题和视口，比较可见元素的边界框、文字颜色、背景颜色和字号。以下检查均一致：

| 页面 | 430 × 900 | 1280 × 900 |
| --- | --- | --- |
| 聊天及底部输入栏 | 浅色 / 深色 | 浅色 / 深色 |
| API 设置（含展开的高级设置） | 浅色 / 深色 | 浅色 / 深色 |
| 历史列表 | 浅色 / 深色 | 浅色 / 深色 |
| 偏好设置 | 深色，并人工查看浅色 | — |

截图保存在 `artifacts/visual/`，临时交互对照页在本次会话的 `http://127.0.0.1:5194/`。左侧快照仅位于 `/tmp`，不属于项目运行路径。

这是一组已检查页面的布局与样式对照，不是对所有状态的像素级完全等价保证。

### 行为与产物

- 44 项自动测试通过，覆盖真实本地 HTTP/SSE 传输、UTF-8 跨分块、尾帧、请求参数、插件发送拦截/重试、首 token 前取消、重新生成、保存调度、图片草稿、guest 快照序列化、插件菜单/表单/弹窗/斜杠命令，以及 1000 条消息的分批挂载和切换取消。消息菜单检查覆盖默认示例编辑/删除、编辑元数据与草稿恢复、删除持久化、并发操作目标、生成状态、快捷键，以及代码/图片/公式复制。
- 浏览器中实际填写独立测试配置并发送消息，验证流式回复、Markdown 代码块和数学公式；测试端点确认收到指定模型、Authorization、历史消息与 image_url 内容。
- 浏览器中验证消息编辑后刷新、历史全文搜索、新对话、文本草稿恢复、图片粘贴、图片草稿刷新恢复和发送。
- 默认示例气泡与原版一样提供复制、编辑和删除；未经修改的示例不提供重新生成。编辑后的示例移除语言绑定，删除全部示例后刷新不会重新插入。代码、图片、公式按右键目标提供对应复制项；停止更新只属于当前生成的回复，滚动或选择文字会关闭菜单。
- 纯静态构建在 `/cerebr/` 子路径启动成功；构建脚本自动验证清单、模块依赖、guest HTML、资源路径和扩展 content 导出。
- Chrome / Firefox ZIP 构建成功。
- 插件模板 9 个清单通过校验；市场仓库 28 个清单通过校验；bundled fallback 与市场真源同步检查通过。

插件模板的 API 文档已同步：guest 草稿图片使用可序列化记录，斜杠命令保留 trailingText，React 宿主的页面/弹窗仍保持同步返回与挂载节点恢复契约。没有变更插件 schema、权限集合或市场包内容。

## 验证边界

本机浏览器中的 Web 回归与构建检查已完成。未安装到用户的 Chrome / Firefox 配置中做扩展实机测试，也未在实体 iOS Safari 上验证软键盘与触摸。未使用用户的真实 API Key 调用外部模型，HTTP 集成测试使用独立本地测试服务。未发布到线上。

## 扩展资源路径修复

原来的根目录扩展安装不能直接加载未打包的 `src/host/content/content-script.js`：其依赖已不在编译产物权限清单中。根目录 manifest 现在将 background、content、sandbox 与公开资源统一定位到 `dist/`；独立产物 manifest 在构建时去掉该前缀。`appAssetUrl()` / `extensionAssetPath()` 从已安装 manifest 的 background 路径确定资源目录，覆盖侧栏 iframe、样式、语言包、插件 guest、市场 fallback 与 PDF 注入。

构建检查遍历全部 content 静态和动态模块依赖，验证两种安装位置下的权限。新增测试覆盖 Chrome/Firefox 的资源解析、漏报权限、缺失依赖、GitHub Pages 子路径，以及 content loader 初始化前消息队列。

现有根目录扩展安装保持原安装目录及扩展 ID 不变。应用修改需要在扩展管理页重新加载原扩展，并刷新宿主网页；不需要卸载。此次修复未通过浏览器 UI 完成扩展重新加载，不能据此宣称扩展实机验证完成。

Selection Actions uses the same React component for chat selections and the content-script overlay. The webpage overlay mounts in its own closed shadow root; it is not a second chat application or a legacy DOM page. Its `selectionActionsOnWebpages` sync preference defaults to enabled, independently of chat selections. The old built-in selection dot is superseded; third-party page selection contributions keep their existing API. Webpage commands enter the ready-aware sidebar queue with an instance token, so ordinary page `postMessage` calls cannot submit chat requests.

Drafts retain selected-text quotes alongside image parts and plain text. Sending produces normal API-compatible quoted text plus optional display metadata (`selectionQuotes` / `selectionQuestion`); edit, restore and export paths must retain that context. Direct selection questions preserve the existing composer draft.


New extension conversations initialize their current webpage source once, before
both composer rendering and first-request context collection. Explicit selections
remain stored per chat. Manual add/remove actions also persist a per-document URL
choice (`cerebr_webpage_auto_include_v1_*`): absence means include by default,
false means exclude, and explicitly selecting the page restores inclusion for
future chats. Existing conversations keep their own selection; tab refreshes do
not reapply defaults. Document identity includes query parameters and hash-router
paths, but ordinary in-page anchors share the same choice. This changes the host
source workflow only; plugin APIs, schemas and marketplace packages are unchanged.
