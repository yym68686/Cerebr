# Cerebr 插件系统 RFC

## 背景

Cerebr 当前已经具备三个很强的“可扩展潜力点”，但它们都还停留在内聚代码里，没有被抽成稳定接口：

1. 宿主页接入能力
   - 扩展形态下，`content-script` 会把侧边栏 iframe 注入任意页面，并负责页面内容提取、拖拽图片、PDF 解析、YouTube 字幕抓取、与 background 通信。
2. 聊天流水线能力
   - `chat-controller` 已经在做发送前组包、流式更新、错误恢复、Gemini 异常自动重试。
3. UI 组装能力
   - `app-shell`、`message-input`、`message-renderer`、`webpage-menu` 都在直接拼 DOM，实际上已经隐含了很多“可插槽位置”。

如果要做开发者生态，不能继续让插件直接碰这些实现细节。要先把内核改成“宿主能力 + 插件运行时 + 插件分发”的三层结构。

## 当前架构观察

### 1. 当前是“双宿主”

- Web 版直接跑页面，且为了绕开 Safari 缓存，`src/boot.js` 会根据 `manifest` 版本动态 import `v/<version>/src/main.js`。
- 扩展版则是 `content-script` 把 `index.html` 作为 iframe 注入宿主页。

这意味着插件系统如果只设计给 iframe 内部，会失去宿主页能力；如果只设计给 content script，又会失去 Web 版复用。插件 runtime 必须天然支持：

- `shell` 运行域：Cerebr 自己的 iframe/Web UI
- `page` 运行域：宿主页 DOM
- `background` 运行域：浏览器能力和跨 tab 协调

### 2. 当前能力边界还没有抽出来

现在很多功能都是“具体模块直接调用具体模块”：

- `app-shell` 直接把 `getEnabledTabsContent()` 塞给 `chat-controller`
- `chat-controller` 直接内置 Gemini retry 策略
- `message-input` 直接绑定输入框、粘贴、历史问题、window message
- `content-script` 直接决定如何提取网页文本、如何更新 placeholder、如何控制 iframe

这套结构做功能很快，但不适合插件生态，因为：

- 插件没有稳定 API，只能依赖内部 DOM 和函数名
- Web / Extension 差异会泄漏到插件实现
- 一旦改 UI 结构，插件就会碎

### 3. 目前已有的“半成品扩展点”

仓库里已经存在几种可复用模式，可以升级成正式插件接口：

- DOM 事件总线：`cerebr:chatSwitched`、`cerebr:chatContentChunk`、`cerebr:chatContentLoaded`
- 浏览器能力适配层：`browserAdapter`
- 存储适配层：`storageAdapter` / `syncStorageAdapter`
- iframe 消息桥：`FOCUS_INPUT`、`DROP_IMAGE`、`UPDATE_PLACEHOLDER`、`NEW_CHAT`

这说明项目不需要“推倒重做”，而是要把这些零散能力正式化。

## 设计目标

### 必须支持

1. 插件可拦截聊天发送前后流程
2. 插件可扩展网页文本提取
3. 插件可往 UI 指定位置挂组件
4. 插件可扩展系统提示词与输入预处理
5. 插件可按站点提供“连接器”能力，读写特定网页元素
6. Web / Extension 共用同一套插件 API

### 必须限制

1. 插件不能直接依赖内部 DOM 结构
2. 插件不能默认拥有任意宿主页写权限
3. 插件不能阻塞输入、流式渲染或页面启动
4. Chrome/Firefox 商店版不能依赖远程执行任意 JS

## 核心判断

### 判断一：需要“两层插件体系”

如果一开始就把插件定义成“用户随便塞一段 JS”，商店版很快会撞上 MV3 和远程代码限制，也会把稳定性搞坏。

更合理的是两层：

1. 声明式插件
   - JSON manifest + 配置 + 规则 + 选择器 + prompt 片段 + retry 策略
   - 覆盖 60% 到 80% 的用户需求
   - 适合商店版、社区分发、站点连接器
2. 脚本式插件
   - ES module，拿到受限 host API
   - 仅用于自托管 Web、开发者模式扩展、或未来本地安装模式
   - 适合高级自动化和复杂 UI

先把声明式插件打通，再开放脚本式插件，风险最低。

### 判断二：网页文本 API 不应该只有一个 `getPageText()`

用户提到“element filter”“动态检测聊天内容变化”“控制原始网站输入输出”，这些本质上不是一个 API，而是三层能力：

1. 原始页面快照
   - 页面标题、URL、DOM 文本、iframe 文本、媒体元信息
2. 提取策略
   - 某个站点优先读哪些选择器，如何过滤导航/广告/侧边栏
3. 动态观察
   - 页面聊天列表变化、输入框变化、发送按钮可用状态变化

所以应该抽成 `Page Context API + Extractor API + Site Connector API`，而不是单一文本接口。

### 判断三：UI API 必须是“插槽”，不能让插件随便拿 DOM 到处插

用户想要：

- 对话框四周添加组件
- 移动端悬浮按钮
- 提示词插件、猜你想问、预检查

这意味着 UI API 至少要支持：

- shell 内部插槽
- 宿主页 overlay 插槽
- 设置页插槽
- 输入框附近插槽

但不应该开放 `document.querySelector('#settings-menu')` 这种级别的内部结构。否则一改 HTML 插件全挂。

## 目标架构

### 1. 新增 Plugin Runtime

建议新增目录：

```text
src/plugin/
  core/
    plugin-manager.js
    plugin-registry.js
    plugin-runtime.js
    plugin-errors.js
    plugin-permissions.js
  api/
    host-api.js
    shell-api.js
    page-api.js
    chat-api.js
    prompt-api.js
    storage-api.js
    ui-api.js
    site-api.js
  bridge/
    plugin-bridge.js
    plugin-message-types.js
  builtins/
    gemini-retry/
    mobile-fab/
    prompt-fragments/
```

其中：

- `plugin-manager` 负责加载、启停、超时控制、错误隔离
- `plugin-registry` 负责 manifest、版本、能力声明
- `plugin-runtime` 负责生命周期和 hook 调度
- `plugin-bridge` 负责 `shell/page/background` 三域通信

### 2. 统一插件生命周期

建议最小生命周期：

```js
export default definePlugin({
  id: 'plugin.example',
  version: '0.1.0',
  scopes: ['shell', 'page'],
  permissions: ['chat:read', 'chat:write', 'page:read'],

  setup(ctx) {},
  dispose(ctx) {},
});
```

再提供 hook：

- `onAppReady`
- `onChatChanged`
- `onBeforeSend`
- `onBuildPrompt`
- `onRequest`
- `onStreamChunk`
- `onResponseError`
- `onAfterResponse`
- `onPageSnapshot`
- `onInputChanged`
- `onRenderSlot`

其中最关键的是五个：

- `onBeforeSend`
- `onBuildPrompt`
- `onResponseError`
- `onPageSnapshot`
- `onRenderSlot`

### 3. Host API 分层

#### `chat` API

负责对话上下文和请求生命周期。

```js
ctx.chat.getCurrentChat()
ctx.chat.getMessages()
ctx.chat.retry(reason)
ctx.chat.abort()
ctx.chat.appendSystemMessage(fragment)
ctx.chat.appendUserDraft(text)
ctx.chat.showToast(message, options)
```

适合：

- Gemini 自动重试
- 输入预检查
- 回答完成后自动做事

#### `prompt` API

不要让插件直接改原始 system prompt 字符串，而是做“片段组合”。

```js
ctx.prompt.addFragment({
  id: 'site-rules',
  priority: 40,
  position: 'append',
  content: '...'
})
```

最终 prompt 组合顺序建议是：

1. API 配置里的基础 system prompt
2. 当前站点/页面上下文片段
3. 插件 prompt 片段
4. 临时会话级 prompt 片段

这样不会把一个插件变成“提示词覆盖一切”的怪物。

#### `page` API

面向网页文本提取。

```js
ctx.page.getSnapshot()
ctx.page.getSelection()
ctx.page.registerExtractor(extractor)
ctx.page.watchSelection(callback)
ctx.page.watchSelectors(selectors, callback)
ctx.page.getSelectedText()
```

`extractor` 建议支持：

- `matches(url)`
- `priority`
- `extract(snapshot, tools)`
- `label`

这样“element filter 插件”本质上就是一个 extractor。

其中 `getSelection()` 建议返回：

```js
{
  text: 'selected text',
  collapsed: false,
  rect: { x, y, width, height },
  rangeCount: 1,
  insideEditable: false
}
```

`watchSelection(callback)` 则用于做“用户选中文本后，鼠标旁边弹出一个操作点”这类交互。

#### `site` API

面向宿主页自动化，不默认开放。

```js
ctx.site.query(selector)
ctx.site.queryAll(selector)
ctx.site.fill(selector, value)
ctx.site.click(selector)
ctx.site.observe(selector, callback)
```

但这类 API 必须配权限：

- `site:read`
- `site:write`
- `site:click`
- `site:observe`

并且要支持按站点授权，而不是全局一把梭。

#### `ui` API

用插槽，不用内部 DOM 选择器。

建议插槽：

- `shell.header.leading`
- `shell.header.trailing`
- `shell.chat.before`
- `shell.chat.after`
- `shell.input.before`
- `shell.input.after`
- `shell.settings.section`
- `page.floating`
- `page.inline`
- `page.selection-bubble`

这样：

- 移动端悬浮按钮用 `page.floating`
- 选区旁边的小点或小气泡用 `page.selection-bubble`
- 猜你想问、预检查结果用 `shell.input.after`
- Prompt 调试器、网页提取策略切换器用 `shell.settings.section`

如果只靠插槽还不够，建议再给插件一个锚点浮层 API：

```js
ctx.ui.showAnchoredAction({
  slot: 'page.selection-bubble',
  rect,
  icon: 'dot',
  onClick() {}
})
```

## 代码改造建议

### 阶段 0：先收口内核边界

这是必须做的第一步，不然插件层会直接依赖现在的实现细节。

#### 0.1 抽出 Chat Pipeline

把现在 `chat-controller` 里的流程拆成：

- `draft -> beforeSend hooks`
- `request build`
- `request lifecycle`
- `error policy`
- `stream dispatch`
- `afterResponse hooks`

目标是让 Gemini 重试从硬编码逻辑变成内建插件。

#### 0.2 抽出 Page Content Service

把下面两处逻辑统一到一个 service：

- `content-script` 的 `extractPageContent`
- `webpage-menu` 的 `getEnabledTabsContent`

建议新增：

```text
src/host/page/page-content-service.js
src/host/page/page-extractor-registry.js
src/host/page/site-connector-service.js
```

其中：

- `page-content-service` 只负责拿快照
- `extractor-registry` 负责过滤和文本策略
- `site-connector-service` 负责动态元素观察、输入输出控制

#### 0.3 抽出 Editor API

当前 `message-input` 负责：

- 输入读取
- 粘贴/拖放图片
- Enter/Shift+Enter
- 历史问题
- placeholder
- iframe message

应该拆出：

```text
src/runtime/input/editor-controller.js
src/runtime/input/editor-bridge.js
src/runtime/input/editor-state.js
```

插件只拿 `editor-controller` 提供的 API，不直接碰 contenteditable。

#### 0.4 抽出 UI Slot Registry

把 `index.html` + `app-shell` 里的固定节点，包装成可注册插槽的 host。

建议：

```text
src/runtime/ui/slot-registry.js
src/runtime/ui/slot-mount.js
src/runtime/ui/overlay-manager.js
```

### 阶段 1：先做“内建插件”

第一阶段不要急着做社区安装。先把现有内核功能迁成插件，验证 API 是否够用。

建议先迁 5 个内建插件：

1. `builtin.gemini-retry`
   - 处理 `misfiled think silently`
2. `builtin.mobile-fab`
   - 内容页悬浮按钮打开侧边栏/弹窗
3. `builtin.page-extractor-default`
   - 当前的通用页面文本抽取
4. `builtin.prompt-fragment`
   - 当前 API 配置中的 system prompt 片段化
5. `builtin.input-history`
   - 当前上下键问题历史

如果这 5 个迁不动，说明插件 API 设计不对。

### 阶段 2：声明式插件

引入插件 manifest：

```json
{
  "id": "community.youtube-transcript-filter",
  "name": "YouTube Transcript Filter",
  "version": "0.1.0",
  "type": "declarative",
  "scopes": ["page", "shell"],
  "permissions": ["page:read"],
  "extractors": [
    {
      "id": "yt-chat-filter",
      "matches": ["https://www.youtube.com/*"],
      "priority": 80,
      "selectors": {
        "include": ["#description", "#content-text"],
        "exclude": ["#comments", "#secondary"]
      }
    }
  ],
  "promptFragments": [
    {
      "id": "yt-qa",
      "position": "append",
      "content": "优先基于视频字幕和描述回答。"
    }
  ]
}
```

这类插件足够支撑：

- 文本 filter
- 站点 prompt
- 输入预检查规则
- 简单按钮/菜单项
- retry 策略

### 阶段 3：脚本式插件

只在这两个场景开放：

1. 自托管 Web
2. 开发者模式扩展

不要直接承诺“Chrome 商店版可任意安装第三方 JS 插件”，这件事在浏览器策略和安全上都不稳。

脚本式插件可以长这样：

```js
export default definePlugin({
  id: 'dev.site-chat-bridge',
  scopes: ['page', 'shell'],
  permissions: ['page:read', 'site:observe', 'site:write', 'ui:mount'],

  setup(ctx) {
    ctx.page.watchSelectors(
      ['[data-message-role]', 'textarea', 'button[type=submit]'],
      () => {
        // ...
      }
    );
  },

  onBeforeSend(payload, ctx) {
    // ...
    return payload;
  },

  renderSlot(slot, ctx) {
    if (slot.id !== 'page.floating') return null;
    return ctx.ui.button({
      label: '助手',
      onClick: () => ctx.shell.toggle(),
    });
  }
});
```

## 你提到的需求，分别该怎么落

### 1. Gemini 报错自动重试

合理，而且最适合作为第一批内建插件。

落点：

- `chat.onResponseError`
- `chat.retry()`

现在它写死在 `chat-controller`，应该搬出去。

### 2. 移动端悬浮按钮触发弹窗

合理，但这是 `page` 域 UI，不是 `shell` 域 UI。

落点：

- `ui` 插槽：`page.floating`
- `shell.toggle()`

这类按钮由 content script 渲染最自然。

### 3. 网页文本 API 化 / element filter 插件

非常合理，而且是最有生态价值的一类插件。

落点：

- `page.getSnapshot()`
- `page.registerExtractor()`
- `page.watchSelectors()`

建议把“默认通用抽取”作为 fallback extractor，社区插件通过更高优先级覆盖。

### 4. 界面 API 化，在对话框四周加组件

合理，但必须走插槽，不允许插件直接抓内部 DOM。

落点：

- `shell.input.after`
- `shell.chat.before`
- `shell.settings.section`
- `page.floating`

### 5. 提示词 API 化

合理，而且应该做成 prompt fragment，而不是字符串替换。

落点：

- `prompt.addFragment()`
- `prompt.removeFragment()`

### 6. 用户输入预检查 / 猜你想问

合理。

落点：

- `input.onDraftChanged`
- `chat.onBeforeSend`
- `ui slot: shell.input.after`

### 7. 控制原始网站输入输出，做其他网站自动聊天助手

有条件合理，但不能以“全网站全自动万能助手”的方式设计。

推荐设计成 `site connector`：

- 每个站点一份 selector + observer + action 能力
- 用户按站点授权
- 默认只开放读；写和点击需要额外权限

### 8. 聊天内容 Element Filter + 动态检测 + 自动回复

可以做，但要明确这是“连接器插件”，不是普通 prompt 插件。

这类插件至少需要：

- 聊天列表选择器
- 单条消息选择器
- 输入框选择器
- 发送按钮选择器
- MutationObserver 策略
- 去重策略
- 节流策略

换句话说，这已经不是“小插件”，而是“站点适配器”。

### 9. 选中文本后，在鼠标旁边出现一个点，点击后打开 Cerebr 并把文本放进输入框

合理，而且很适合作为一个示范级插件。

落点：

- `page.watchSelection()`
- `page.getSelection()`
- `ui.showAnchoredAction()` 或 `page.selection-bubble`
- `shell.open()`
- `editor.setDraft(text)` / `editor.insertText(text)`
- `editor.focus()`

推荐交互流程：

1. 插件监听选区变化
2. 当用户在非可编辑区域选中文本，且文本长度超过阈值时，显示一个 anchored bubble
3. 用户点击 bubble
4. 插件调用 `shell.open()`
5. 插件把选中文本写入 Cerebr 输入框
6. 插件调用 `editor.focus()`，把光标放到末尾

注意约束：

1. 这类插件主要属于扩展版 / 开发者模式，因为它需要在宿主页里渲染浮层
2. 纯 Web 版不能跨站注入，所以无法“在任意网站选中文字后直接弹 Cerebr”
3. 需要避开 `input`、`textarea`、`contenteditable` 和代码块，否则会很打扰
4. 要加节流和最短文本长度，避免用户每次划词都被打断

## 分发与生态策略

### 商店版

建议只支持：

- 内建插件
- 声明式插件
- 受控站点连接器

### 自托管 Web

可以支持：

- 本地插件目录
- 版本化插件清单
- 同源 ES module 插件

注意：由于 Web 版依赖 `v/<version>/...` 解决缓存问题，插件资源也必须版本化。否则主应用更新了，插件还在旧缓存里，会重新踩 Safari 的坑。

建议把脚本扩展到：

```text
scripts/gen_web_versioned_src.sh
```

让它顺带复制：

```text
plugins/
plugin-manifest.json
```

到：

```text
v/<version>/plugins/
v/<version>/plugin-manifest.json
```

## 权限模型

最小权限集建议：

- `chat:read`
- `chat:write`
- `prompt:read`
- `prompt:write`
- `page:read`
- `page:observe`
- `site:read`
- `site:write`
- `site:click`
- `ui:mount`
- `storage:plugin`

规则：

1. 默认不给 `site:write` / `site:click`
2. 插件报错要自动熔断
3. 所有 hook 都必须带超时
4. 所有跨域通信都走 runtime bridge，不直接把 `chrome` 暴露给插件

## 性能要求

插件系统最容易把以下几个地方拖慢：

- 输入框打字
- 首次打开侧边栏
- 流式输出
- 页面文本提取

所以建议：

1. `onInputChanged` 必须节流
2. `onStreamChunk` 默认只读，不允许重型 DOM 操作
3. `page extractor` 分为同步快照和异步增强
4. UI slot 渲染失败不能影响主 UI
5. 每个插件独立错误边界

## 最小可行实施顺序

### Milestone 1

- 抽 `chat pipeline`
- 抽 `page content service`
- 抽 `editor controller`
- 抽 `ui slot registry`

### Milestone 2

- 上 `plugin-manager`
- 上 `plugin lifecycle`
- 把 Gemini retry 改成内建插件
- 把默认网页抽取改成内建 extractor

### Milestone 3

- 上声明式 plugin manifest
- 上插件设置页
- 上站点 extractor 切换器

### Milestone 4

- 自托管 Web 支持脚本式插件
- 开发者模式扩展支持脚本式插件

## 不建议现在就做的事

1. 不要先做“插件市场 UI”
   - 现在内核没有稳定 API，市场只会把不稳定实现公开化。
2. 不要先支持“任意远程 JS 插件”
   - 商店审核、安全、兼容性都会炸。
3. 不要把所有能力都做成一个超级 `cerebr` 全局对象
   - 最后一定会耦合和失控。

## 结论

这件事值得做，而且 Cerebr 现在的架构已经有足够多的可重用骨架，不需要重写。

但正确顺序不是“马上开放插件”，而是：

1. 先把当前硬编码能力抽成 runtime service
2. 用 3 到 5 个内建插件验证 API
3. 再开放声明式插件
4. 最后再考虑脚本式生态

如果只想尽快落地，我建议第一批就做这 4 个：

1. `Gemini Retry Plugin`
2. `Mobile Floating Action Plugin`
3. `Page Extractor Plugin`
4. `Prompt Fragment Plugin`

这 4 个做完，Cerebr 就已经开始从“功能集合”变成“平台内核”了。
