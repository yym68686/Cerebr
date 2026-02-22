# iOS Safari 键盘/输入框异常（Cerebr Web 2.4.48）

记录时间：2026-02-22
影响范围：移动设备网页版（Web）

## 测试环境

- 可复现：iOS Safari
- 不复现：iOS Chrome（同一台 iOS 设备上测试）
- Cerebr 版本：2.4.48
- 对应 commit：`e46c1e96d387124188db3e3edfe6a5b773448aa5`

> 说明：以下两个问题均为 **iOS Safari 实测**，在 **iOS Chrome** 上未观察到同样问题。

## Bug 1：滚动聊天后聚焦输入框，输入框先“跳太高”再回落

### 复现步骤

1. iOS Safari 打开网页版 Cerebr。
2. 在聊天区域（`#chat-container`）上下滚动一段距离（任意方向/任意幅度均可）。
3. 直接点击输入框（输入区域）使键盘弹出。

### 实际表现

- 输入框容器（`#input-container`）会先移动到 **远高于键盘顶部** 的位置（肉眼可见的“上跳/弹起”）。
- 随后又下降，最终回到“紧贴键盘正上方”的预期位置。
- 备注：该异常主要发生在“键盘弹出/聚焦输入框”阶段；**收起键盘时输入框下落行为通常是正常的**（与 Bug 2 的“收起键盘下落延迟”区分）。

### 期望表现

- 键盘弹出时，输入框应“一次到位”，直接停在紧贴键盘正上方，不应出现明显的上跳再回落。

### 规避方式（用户观察）

- 若先点击屏幕空白处（非聊天区域滚动/非输入框）再点击输入框，通常不会出现上跳，行为更符合预期。

## Bug 2：收起键盘时，输入框下落有明显延迟（点击消息气泡后可复现）

### 复现步骤（最小路径）

1. iOS Safari 打开网页版 Cerebr。
2. **点击一次聊天消息气泡**（用户消息或 AI 消息任意一条的气泡；不需要滚动）。
   - 注意：点击气泡背后的聊天背景（空白处）不会触发，后续输入框行为仍正常。
3. 点击输入框弹出键盘。
4. 通过以下任一方式收起键盘：
   - 点击聊天区域；
   - 点击键盘上的“完成 / Done”。

### 实际表现

- **键盘弹出时，输入框行为正常**——输入框能正确跟随键盘弹起，紧贴在键盘正上方，这一阶段没有异常。
- 键盘收起后，输入框不会立刻回到页面最底部（紧贴安全区底部），而是**留在原地停留**一段时间，过一会儿才下降到最下面。
- 如果等待输入框下降完成后，再次点击输入框、再点击”完成 / Done”，此时输入框又能”瞬间”跟随键盘收起回到底部；之后多次重复通常都正常。
- **如果用“点击聊天区域”来收起键盘**，下一次重复“点击输入框 → 收起键盘”仍然会复现“延迟下落”现象（似乎不会进入稳定状态）。
- **只有用键盘“完成 / Done”收起键盘后**，输入框行为才会稳定为预期：后续无论点击多少次输入框、再点“完成 / Done”，都能在键盘消失的瞬间回到底部。

### 期望表现

- 键盘收起时，输入框应同步、立即回到底部，不应出现明显的停顿与延迟。

## 已验证：2.4.49 尝试无效（无任何区别）

曾在 2.4.49（commit `441c0f9f2d4c73c51503ac6fb29a2ab499d12d24`）尝试通过更激进的 `visualViewport` 更新/收敛策略修复上述两个问题（例如更频繁刷新 viewport 相关 CSS 变量等）。

结论：在 **iOS Safari** 上测试后 **“没有任何区别”**，上述两个 bug 仍然按本文描述出现。

因此已删除该 commit，并将仓库回退到 2.4.48（commit `e46c1e96d387124188db3e3edfe6a5b773448aa5`）。

## 2.4.50 修复尝试（已验证失败）

本次仅针对本文的 **Bug 1 / Bug 2** 做修复尝试，核心改动在 `src/utils/viewport.js`（Web 端通过 `--vv-height` / `--vv-offset-top` 驱动 `body{ position: fixed; top: var(--vv-offset-top); height: var(--vv-height) }` 来对齐 iOS 键盘下的可视视口）。

### 主要判断（原因假设）

- **Bug 1（上跳再回落）**：iOS Safari 在“滚动了内层滚动容器（#chat-container）”之后，键盘弹出/聚焦阶段 `visualViewport.offsetTop` 可能出现 **瞬时负值** 或异常抖动；由于我们直接把 `offsetTop` 用作 `body` 的 `top`，会导致页面整体（含 `#input-container`）先被推到更高位置，再随着 `offsetTop` 回到 0 而回落，形成肉眼可见的“上跳 → 回落”。
- **Bug 2（下落延迟）**：键盘收起时，iOS Safari 的 `visualViewport` 指标变化并不总能稳定触发预期事件（`visualViewport.resize/scroll`、`window.resize`、甚至 blur 后的时序），尤其在“点击消息气泡 / 点击聊天区域”这类路径下更容易出现 **事件延迟或缺失**；导致 `--vv-height/--vv-offset-top` 更新滞后，于是输入栏看起来“停在高处一段时间”才下落。

### 2.4.50 的改动点（修复策略）

1. **对 `visualViewport.offsetTop` 做 clamp**：在读取 viewport 指标时将负值强制归零（`offsetTop < 0 => 0`），避免把瞬时异常值直接作用到 `body{ top: ... }`，以期消除/减轻 Bug 1 的“上跳”。
2. **用 rAF 方式做 viewport 指标“收敛/稳定”刷新**：替换原先 focus/blur 时使用固定 `setTimeout(320/700/180/480ms)` 的策略，改为 `settleViewport()`：
   - 在输入框 focus/blur 后的若干帧内，每帧采样 `visualViewport.height/offsetTop`；
   - 一旦发现指标变化就立即 `scheduleViewportUpdate()`；
   - 直到连续多帧稳定（或超时）再停止。
   - 目的：即使 iOS Safari 的相关事件触发不稳定，也能在键盘动画期间更及时地把 CSS 变量更新到最终值，以期消除/减轻 Bug 2 的“延迟下落”。

### 验证结果（失败）

- 用户已在 **iOS Safari 无痕模式** 测试，并确认加载的是 **最新版 2.4.50 代码**（非缓存）。
- 结论：**Bug 1 / Bug 2 均未修复**，表现与 2.4.48 描述一致；2.4.50 本次尝试宣告失败。

## 2.4.51 修复尝试

本次采用完全不同的思路：**不再修补 viewport 事件时序，而是从布局机制上根除问题**——将 `#input-container` 从 `position: fixed` 改为 body flex 布局的子元素。

### 根因重新分析

2.4.49 和 2.4.50 的失败说明问题**不在于”viewport 事件的采样频率或时机”**，而在于布局方式本身对 iOS Safari 内部状态的脆弱依赖：

- **Bug 1 的真正原因**：`body { top: var(--vv-offset-top) }` 把 `visualViewport.offsetTop` 直接映射到 body 的垂直位置。iOS Safari 在”滚动了 `-webkit-overflow-scrolling: touch` 的内层容器后”键盘弹出期间，`offsetTop` 会产生**瞬时正值尖峰**（不仅仅是负值），导致 body 整体上跳。2.4.50 只 clamp 了负值，没有拦住正值尖峰，所以无效。而且 `offsetTop` 的异常值是在 `visualViewport.scroll` 事件中被读取并立即写入 CSS 变量的，频率越高反而越”忠实地还原”了抖动。
- **Bug 2 的真正原因**：`#input-container { position: fixed; bottom: 0 }` 的定位依赖 body 的高度（`height: var(--vv-height)`）。键盘收起时 `--vv-height` 需要从”键盘弹出后的小值”恢复到”全屏高度”，而 iOS Safari 在某些交互路径下（如先点击了消息气泡）`visualViewport.resize` 事件**触发滞后或缺失**。无论用 `setTimeout` 轮询还是 rAF 逐帧采样，读到的 `visualViewport.height` 本身就还没更新，所以 2.4.49/2.4.50 的”更频繁更新”策略无效——不是读的不够快，而是 API 返回值本身还没变。

### 核心洞察

两个 bug 的共同根源是：**`#input-container` 使用 `position: fixed` 独立于 flex 布局之外，其位置完全依赖 CSS 变量 (`--vv-height`, `--vv-offset-top`) 的及时性和正确性**。在 iOS Safari 键盘动画期间，这些 CSS 变量无法保证与真实视口同步，导致输入框位置抖动或滞后。

而 body 已经有 `display: flex; flex-direction: column`——只要让 `#input-container` 成为 flex 子元素（而不是 fixed 定位的浮动层），输入框的位置就由 **flex 布局引擎在同一渲染帧内原子性计算**，完全不依赖事件时序。

### 2.4.51 的改动点

**布局架构变更**（`position: fixed` 输入框 → flex 子元素）：

1. **`styles/base/reset.css`（body）**：
   - `top: var(--vv-offset-top, 0px)` → `top: 0`（彻底移除 offsetTop 依赖）
   - 添加 `box-sizing: border-box`（确保 `height: var(--vv-height)` 包含 padding，flex 子元素不会溢出视口）
   - `padding` 移除 `env(safe-area-inset-bottom)`（底部安全区由 input-container 自身 padding 处理，避免 flex 布局中重复计算）

2. **`styles/components/input.css`（#input-container）**：
   - 移除 `position: fixed; bottom: 0; left: 0; right: 0`
   - 改为 `position: relative`（为内部 `#settings-menu { position: absolute; bottom: 100% }` 提供定位上下文）
   - 保留 `flex-shrink: 0`，作为 body flex column 的末尾子元素自然位于底部

3. **`styles/components/chat-container.css`（#chat-container）**：
   - `padding-bottom: calc(60px + env(safe-area-inset-bottom) + ...)` → `padding-bottom: 15px`（不再需要为 fixed 输入框预留遮挡补偿）
   - `min-height: 100%` → `min-height: 0`（flex 子元素需要 `min-height: 0` 才能正确配合 `overflow-y: scroll` 收缩）
   - 移除 `height: 100%`（与 `flex: 1` 冲突，在 flex column 中应由 flex-grow 控制高度）

4. **`src/utils/viewport.js`**：
   - 移除 `--vv-offset-top` CSS 变量的设置（不再使用）
   - 移除 `visualViewport.scroll` 事件监听（该事件仅在 offsetTop 变化时触发，已无用）
   - 简化 `getViewportMetrics()` 不再返回 `offsetTop`
   - 保留 `--vv-height` 更新、`visualViewport.resize` 监听、focus/blur settle 定时器

### 为什么这次应该有效

| 对比维度 | 2.4.48–2.4.50（旧方案） | 2.4.51（本次） |
|----------|------------------------|---------------|
| 输入框定位 | `position: fixed; bottom: 0`，依赖 body 高度和 offset 的 CSS 变量 | flex 子元素，位置由 flex 引擎在同一帧内计算 |
| body 垂直位置 | `top: var(--vv-offset-top)`，随 visualViewport.offsetTop 实时变化 | `top: 0`，永远固定，不受 offsetTop 抖动影响 |
| 对 Bug 1 的影响 | offsetTop 尖峰 → body 跳 → 输入框跳 | offsetTop 不参与布局，无论怎么抖动都不影响 |
| 对 Bug 2 的影响 | `--vv-height` 更新滞后 → body 高度未变 → fixed 输入框停在高处 | `--vv-height` 更新时，flex 布局原子性地重新分配空间，输入框立即到位 |
| 对 iOS Safari 事件时序的依赖 | 高度依赖（offsetTop + height 都需要及时准确） | 仅依赖 height（且 flex 布局对”最终值”敏感，不怕中间抖动） |

### 验证结果（失败，Bug 1 恶化）

- 用户已在 **iOS Safari** 上实测。
- **Bug 1：比 2.4.48 更严重**。输入框在键盘弹出时跳到键盘上方很远的位置，且**不会自动回落**（2.4.48 还会自动回落到正确位置）。必须用手指向下滑动才能将输入框手动归位。flex 布局方案未能解决 offsetTop 问题，反而因为移除了 `position: fixed; bottom: 0` 的"锚定"能力，输入框失去了自动回到底部的兜底机制。
- **Bug 2：未修复**。键盘收起时，输入框仍然停在较高位置，需要等待较长延迟才回到页面最底部。表现与 2.4.48 一致。
- 结论：**flex 布局方案宣告失败**。`--vv-height` 的更新滞后问题并未因布局方式改变而消失——flex 布局同样依赖 `--vv-height` CSS 变量驱动 body 高度，而该变量的更新时机仍受 iOS Safari `visualViewport` 事件时序制约。此外，移除 `position: fixed` 后，输入框丧失了"始终锚定在视口底部"的能力，导致 Bug 1 从"跳了会回来"恶化为"跳了不回来"。

## 2.4.52 修复尝试

本次从 CSS 规范层面重新审视问题，发现了一个被前三次尝试完全忽略的根因：**`backdrop-filter` 在 body 上创建了新的包含块（containing block），导致 `position: fixed` 子元素的定位参照物从视口（viewport）变成了 body 元素本身**。

### 根因重新分析

#### CSS 规范关键条款

根据 CSS Compositing and Blending Level 2 规范（以及 `filter` / `backdrop-filter` 的 containing block 规则）：

> 当一个元素设置了 `backdrop-filter`（值不为 `none`）时，该元素会为其所有 `position: fixed` 的后代元素**创建新的包含块**。

这意味着：`#input-container { position: fixed; bottom: 0 }` 的 `bottom: 0` 不再相对于浏览器视口（initial containing block），而是相对于 body 元素的边界。

#### body 上的 backdrop-filter

在 `styles/base/reset.css` 中，body 有如下声明：

```css
body {
    backdrop-filter: blur(var(--cerebr-blur-radius));
    -webkit-backdrop-filter: blur(var(--cerebr-blur-radius));
}
```

其中 `--cerebr-blur-radius: 12px`（定义在 `styles/base/variables.css`）。

#### 为什么 backdrop-filter 导致了两个 bug

- **Bug 1（上跳再回落）**：iOS Safari 键盘弹出期间，body 的几何信息（高度、位置）需要通过 `--vv-height` / `--vv-offset-top` CSS 变量更新来跟踪 `visualViewport`。由于 `backdrop-filter` 使得 `#input-container` 的 `position: fixed` 以 body 为参照，而 body 的 `top` 和 `height` 在键盘动画期间存在瞬时不一致（特别是滚动了 `#chat-container` 之后），输入框的位置就会出现"先跳到错误位置、再回落"的现象。
- **Bug 2（下落延迟）**：键盘收起时，`#input-container { bottom: 0 }` 的实际位置取决于 body 的高度（`height: var(--vv-height)`）何时恢复到全屏值。在某些交互路径下（如先点击了消息气泡），`visualViewport.resize` 事件触发滞后导致 `--vv-height` 更新不及时，body 高度还停留在键盘弹出时的较小值，于是 `bottom: 0` 对应的位置仍然偏高，直到 CSS 变量更新后才回到底部。

#### 关键发现：backdrop-filter 在此场景下无视觉效果

`--cerebr-bg-color` 在所有主题中均为**完全不透明**的颜色值：
- 亮色模式：`#f5f5f7`
- 暗色模式：`#262B33`

`backdrop-filter: blur()` 的效果是**模糊元素背后的内容**。当 body 背景完全不透明时，背后没有任何可见内容需要模糊——该属性的视觉效果为**零**。因此移除它不会造成任何外观变化。

#### 为什么移除 backdrop-filter 能修复两个 bug

移除 body 上的 `backdrop-filter` 后：

1. body 不再为 `position: fixed` 后代创建包含块
2. `#input-container { position: fixed; bottom: 0 }` 的定位参照物恢复为**浏览器视口**（initial containing block）
3. iOS Safari 15+ 原生支持 `position: fixed` 元素跟踪 visual viewport——键盘弹出/收起时，fixed 元素会自动跟随可视视口底部移动，**无需依赖任何 JavaScript 事件或 CSS 变量的及时更新**

这从根本上消除了两个 bug 的共同根源：输入框的位置不再依赖 `--vv-height` / `--vv-offset-top` 的更新时机，而是由浏览器原生的 fixed 定位机制保证。

### 2.4.52 的改动点

1. **`styles/base/reset.css`（body）**：
   - 移除 `backdrop-filter: blur(var(--cerebr-blur-radius))`
   - 移除 `-webkit-backdrop-filter: blur(var(--cerebr-blur-radius))`
   - `top: var(--vv-offset-top, 0px)` → `top: 0`（不再需要手动追踪 offsetTop）

2. **`src/utils/viewport.js`**：
   - 移除 `--vv-offset-top` CSS 变量的设置（不再使用）
   - 移除 `visualViewport.scroll` 事件监听（该事件仅在 offsetTop 变化时有意义，已无用）
   - 简化 `getViewportMetrics()` 不再返回 `offsetTop`
   - 保留 `--vv-height` 更新、`visualViewport.resize` 监听、focus/blur settle 定时器（仍需要更新 body 高度以确保聊天内容区域大小正确）

3. **`styles/components/input.css`（#input-container）**：
   - **未修改**——保留 `position: fixed; bottom: 0; left: 0; right: 0`（2.4.51 的教训：移除 fixed 定位会导致 Bug 1 恶化）

### 与前三次尝试的本质区别

| 版本 | 思路 | 失败原因 |
|------|------|----------|
| 2.4.49 | 更频繁采样 viewport 事件 | viewport API 返回值本身就有延迟/抖动，采样更快反而更忠实地还原了问题 |
| 2.4.50 | clamp 负值 + rAF 收敛 | 问题不仅来自负值；API 返回值本身的更新滞后无法通过客户端采样解决 |
| 2.4.51 | 移除 fixed 定位改用 flex | 丧失了 `position: fixed; bottom: 0` 的锚定能力，Bug 1 恶化；flex 布局仍依赖 `--vv-height` |
| **2.4.52** | **移除 backdrop-filter** | **不再试图修补 viewport 事件时序，而是让浏览器原生 fixed 定位机制直接生效** |

前三次都在"如何更好地追踪 viewport 变化"上做文章，而 2.4.52 的思路是：**让 `position: fixed` 回归其原始语义（相对于视口定位），从而完全不依赖 JavaScript 驱动的 CSS 变量更新**。

### 验证结果（失败，两个 bug 均恶化）

- 用户已在 **iOS Safari** 上实测。
- **Bug 1：恶化，出现新的"屏障"问题**。输入框本身确实可以瞬间紧贴到键盘正上方（这一点有改善），但输入框上方出现了一个**与聊天背景颜色相同的遮挡区域（"屏障"）**，输入框加上屏障的总高度约等于键盘高度，挡住了背后大量聊天内容。推测原因：移除 `backdrop-filter` 后 `#input-container` 的 `position: fixed` 确实改为相对视口定位了，但 body（`position: fixed; height: var(--vv-height)`）在键盘弹出期间因 `--vv-height` 更新，body 高度缩小后其背景色区域与视口之间产生了"空白带"，视觉上形成遮挡屏障。
- **Bug 2：恶化**。键盘弹出时，输入框不再跟随键盘移动到键盘正上方，而是**留在原地不动**。之后点击"完成"收起键盘，发现输入框上方同样出现与 Bug 1 一样的"屏障"（输入框加上屏障的总高度约等于键盘高度，遮挡聊天记录），延迟一段时间后屏障才消失。
- 结论：**移除 `backdrop-filter` 的方案宣告失败**。虽然该假设在 CSS 规范层面成立（`backdrop-filter` 确实会创建包含块），但实测表明：(1) body 本身也是 `position: fixed`，其高度由 `--vv-height` 驱动，移除 `backdrop-filter` 后 body 高度变化产生的视觉"空白带"形成了新的严重问题；(2) `#input-container` 改为相对视口定位后，与 body 的 `--vv-height` 驱动的高度变化不再协调，导致 Bug 2 中输入框完全不跟随键盘。核心矛盾在于：body 使用 `position: fixed` + JS 驱动的 `--vv-height` 来模拟视口大小，在这种架构下，子元素的 fixed 定位是相对于 body 还是相对于视口，会产生完全不同的行为，两者都各有问题。

## 2.4.53 修复尝试

本次从两个完全独立的角度分别修复两个 bug，不再试图用一个统一的架构变更同时解决两者。

### 从失败中提炼的关键约束

四次失败确立了以下不可违反的约束：

1. **`#input-container` 必须保留 `position: fixed; bottom: 0`**（2.4.51 教训：移除后失去锚定能力，Bug 1 恶化为"跳了不回来"）
2. **`backdrop-filter` 必须保留在 body 上**（2.4.52 教训：移除后 body 与 input 分属不同的定位上下文，产生"屏障"和不跟随问题）
3. **更频繁/更精细地采样 `visualViewport` 指标无效**（2.4.49/2.4.50 教训：API 返回值本身就有延迟/抖动，采样策略无法解决源头问题）

因此，本次修复的核心原则是：**保持现有布局架构完全不变（body fixed + backdrop-filter + input fixed），只修改 JS 中读取和应用 viewport 指标的逻辑**。

### Bug 1 修复：移除 `--vv-offset-top`，body 固定 `top: 0`

**根因**：`body { top: var(--vv-offset-top) }` 将 `visualViewport.offsetTop` 直接映射到 body 的垂直位置。当用户滚动了 `#chat-container`（`-webkit-overflow-scrolling: touch`）后点击输入框，iOS Safari 在键盘弹出期间会产生 `offsetTop` 的瞬时尖峰，导致 body 整体上跳，input（固定在 body 底部）随之上跳。

**修复策略**：由于 body 是 `position: fixed; overflow: hidden`，且页面设置了 `user-scalable=no`，页面不存在任何合法的页面级滚动或缩放。因此 `visualViewport.offsetTop` 在稳态下永远应为 0——非零值全部是 iOS Safari 的瞬时异常。

**改动**：
1. `styles/base/reset.css`：`top: var(--vv-offset-top, 0px)` → `top: 0`
2. `src/utils/viewport.js`：移除 `--vv-offset-top` CSS 变量设置，移除 `visualViewport.scroll` 事件监听

### Bug 2 修复：blur 后使用 `window.innerHeight` 作为即时高度

**根因**：`#input-container { position: fixed; bottom: 0 }` 的位置取决于 body 高度（`height: var(--vv-height)`）。键盘收起时 `--vv-height` 需要从"键盘弹出后的小值"恢复到"全屏高度"，但 iOS Safari 在某些交互路径下（如先点击了消息气泡）`visualViewport.resize` 事件延迟触发，导致 `--vv-height` 更新滞后。

**关键发现**：在 iOS Safari 上，`window.innerHeight` 始终反映**布局视口高度**（layout viewport height），不受虚拟键盘影响——键盘弹出时 `window.innerHeight` 不变，始终是"无键盘"的全屏高度。而 `visualViewport.height` 会在键盘弹出时缩小。

**修复策略**：在 `applyViewportCssVars()` 中，当输入框**未聚焦**时（即键盘正在关闭或已关闭），使用 `Math.max(visualViewport.height, window.innerHeight)` 作为 `--vv-height` 的值。这样即使 `visualViewport.height` 尚未从键盘弹出时的小值恢复，`window.innerHeight`（始终为全屏高度）也会立即提供正确的值。

**改动**：
```javascript
const input = document.getElementById('message-input');
const isFocused = input && document.activeElement === input;
const height = isFocused ? rawHeight : Math.max(rawHeight, window.innerHeight);
```

- 输入框聚焦时（键盘弹出）：使用 `visualViewport.height`（需要缩小到键盘上方的可视区域）
- 输入框未聚焦时（键盘关闭/正在关闭）：取 `visualViewport.height` 和 `window.innerHeight` 的较大值，确保立即获得全屏高度

### 与前四次尝试的本质区别

| 版本 | 思路 | 失败原因 |
|------|------|----------|
| 2.4.49 | 更频繁采样 viewport 事件 | API 值本身有延迟/抖动 |
| 2.4.50 | clamp 负值 + rAF 收敛 | API 值本身更新滞后 |
| 2.4.51 | 移除 fixed 定位改用 flex | 失去 `position: fixed` 锚定能力 |
| 2.4.52 | 移除 backdrop-filter | body/input 分属不同定位上下文，产生"屏障" |
| **2.4.53** | **保持架构不变；Bug 1 忽略 offsetTop；Bug 2 用 window.innerHeight 绕过 API 延迟** | — |

2.4.53 的核心思路是：**不改变布局架构，不试图修复 iOS Safari 的 viewport API 时序，而是用不依赖该 API 的可靠数据源（`top: 0` 常量、`window.innerHeight`）来替代有问题的数据源（`visualViewport.offsetTop`、延迟的 `visualViewport.height`）**。

### 验证结果

待用户在 iOS Safari 上实测。

## 备注

- Bug 1 与”滚动聊天记录”前置条件强相关。
- Bug 2 不需要滚动：仅”点击一次消息气泡（而非背景空白处）”即可触发；并且”点击聊天区域收起键盘”与”按 Done 收起键盘”的后续行为存在明显差异。
- “点击屏幕空白处”似乎会改变/重置某些状态，使输入框行为暂时恢复正常（但再次触发上述条件后又会复现）。
