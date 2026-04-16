# Local Script Plugin Development

This guide documents the first developer-mode sideload flow for Cerebr script plugins.

## Scope

- Local sideloaded script plugins only run when developer mode is enabled.
- `scope = page`, `scope = shell`, and `scope = background` are supported.
- `background` plugins only run in the browser extension host and must set `requiresExtension = true`.
- Reviewed marketplace script plugins can be installed normally; this guide is only about local sideloaded script plugins.
- Dragged local plugin bundles are persisted locally and loaded through Cerebr's bundle loader.

## Recommended Layout

```text
statics/dev-plugins/<plugin-id>/
  plugin.json
  page.js | shell.js | background.js
```

Example:

```text
statics/dev-plugins/explain-selection/
  plugin.json
  page.js
```

## `plugin.json`

```json
{
  "schemaVersion": 1,
  "id": "local.explain-selection",
  "version": "1.0.0",
  "kind": "script",
  "scope": "page",
  "displayName": "Explain Selection",
  "description": "Show a local developer action next to selected text and send an explanation prompt into Cerebr.",
  "defaultEnabled": true,
  "requiresExtension": true,
  "permissions": ["page:selection", "shell:input", "ui:mount"],
  "compatibility": {
    "versionRange": ">=2.4.66 <3.0.0"
  },
  "script": {
    "entry": "./page.js"
  }
}
```

Notes:

- `script.entry` is resolved relative to `plugin.json`.
- `script.exportName` is optional and defaults to `default`.
- The exported plugin object must match `definePlugin({ id, setup(api) })`.

Minimal entry example:

```js
import { definePlugin } from '../../../src/plugin/shared/define-plugin.js';

export default definePlugin({
  id: 'local.explain-selection',
  setup(api) {
    return api.page.watchSelection((snapshot) => {
      // your plugin logic
    });
  }
});
```

## Capability APIs

- `page` plugins can use `page.getSnapshot()`, `page.watchSelection()`, `page.watchSelectors()`, `page.query()`, `page.queryAll()`, `page.registerExtractor()` and `page.listExtractors()`.
- `page` plugins can use `site.query()`, `site.fill()`, `site.click()` and `site.observe()` for site automation style workflows.
- `page` plugins can use `ui.showAnchoredAction()` and `ui.mountSlot()`, which require `ui:mount`.
- `page` plugins can bridge into Cerebr with `shell.focusInput()`, `shell.setDraft()`, `shell.insertText()` and `shell.importText()`.
- `shell` plugins can use `editor`, `chat`, `prompt` and `ui` APIs. `chat` hooks now run through the official request pipeline instead of intercepting `window.fetch`.
- `page` and `shell` plugins can use `bridge.send(target, command, payload)` for cross-host messages.
- `background` plugins can use `browser.getCurrentTab()`, `browser.getTab()`, `browser.queryTabs()`, `browser.reloadTab()`, `storage.get()/set()/remove()`, and `bridge.send()/sendToTab()/broadcast()`.

## Hook Lifecycle

- `shell` plugins can implement `onBeforeSend`, `onBuildPrompt`, `onRequest`, `onResponse`, `onRequestError`, `onStreamChunk`, `onResponseError` and `onAfterResponse`.
- `page`, `shell`, and `background` plugins can implement `onBridgeMessage`.
- `background` plugins can implement `onBackgroundReady`, `onActionClicked`, `onCommand`, `onInstalled`, `onTabActivated`, `onTabUpdated`, and `onTabRemoved`.
- Hook contexts are isolated per plugin and still enforce manifest permissions.
- `ctx.chat.retry()` / `ctx.chat.cancel()` only work for plugins that requested `chat:write`.
- `ctx.prompt.addFragment()` only works for plugins that requested `prompt:extend` or `prompt:write`.

## Install Flow

1. Enable `偏好设置 -> 开发者模式`.
2. Open `设置 -> 插件 -> 开发者`.
3. Drag a local plugin folder that contains `plugin.json` into the drop area in the same panel.
4. If your browser does not expose folder drag-and-drop reliably, use the `选择插件文件夹` button in the same panel.
5. Toggle, refresh, or uninstall the plugin from the same page.

## Runtime Behavior

- Page, shell, and background runtimes subscribe to developer-mode changes.
- Turning developer mode off unloads all local script plugins.
- Refreshing a local plugin re-fetches `plugin.json` and reloads `script.entry` with a cache-busting revision token.
- Plugins installed from dropped local files are persisted in local storage. To update them, drag the updated plugin folder into Cerebr again.

## Example

The repository ships with a sample local plugin:

- Folder: `statics/dev-plugins/explain-selection/`
- Files: `plugin.json` and `page.js`
- Folder: `statics/dev-plugins/focus-input-on-toggle/`
- Files: `plugin.json` and `background.js`
