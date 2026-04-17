# Local Script Plugin Development

This guide documents the current developer-mode sideload flow for Cerebr script plugins.

## Scope

- Local sideloaded script plugins only run when developer mode is enabled.
- `scope = page`, `scope = shell`, and `scope = background` are supported.
- `background` plugins only run in the browser extension host and must set `requiresExtension = true`.
- Reviewed marketplace script plugins can be installed normally; this guide is only about local sideloaded script plugins.
- Dropped local `shell` plugin folders in the browser extension host now run inside a static guest runtime. They must be self-contained and must not import `/src/...` host internals or reach into the host DOM directly.

## Recommended Layout

```text
my-plugin/
  plugin.json
  shell.js | page.js | background.js
  vendor/
```

Example:

```text
cttf-cerebr-plugin/
  plugin.json
  shell.js
  vendor/
```

## `plugin.json`

```json
{
  "schemaVersion": 1,
  "id": "local.cttf-shell",
  "version": "1.3.0",
  "kind": "script",
  "scope": "shell",
  "displayName": "CTTF for Cerebr",
  "description": "Run Chat Template Text Folders inside the Cerebr shell through the official self-contained guest runtime.",
  "defaultEnabled": true,
  "requiresExtension": true,
  "permissions": ["shell:input", "tabs:read", "chat:write"],
  "compatibility": {
    "versionRange": ">=2.4.76 <3.0.0"
  },
  "script": {
    "entry": "./shell.js"
  }
}
```

Notes:

- `script.entry` should be relative to `plugin.json` for dropped self-contained shell plugins.
- `script.exportName` is optional and defaults to `default`.
- The exported plugin object must expose `id` and `setup(api)`.
- Do not import `/src/...` files from the Cerebr repository. Bundle or copy the helpers you need into your plugin folder.

Minimal entry example:

```js
export default {
  id: 'local.cttf-shell',
  setup(api) {
    const mountRoot = api.shell.mountInputAddon();
    return () => mountRoot?.replaceChildren?.();
  }
};
```

## Capability APIs

- `shell` plugins can use `editor`, `chat`, `prompt`, `ui`, `bridge`, `browser`, and `shell`.
- `browser.getCurrentTab()` returns the active browser tab in the extension host.
- `shell.mountInputAddon()` gives the plugin a stable container inside the shell input area.
- `shell.observeTheme(callback)` notifies plugins when the shell theme changes.
- `shell.requestLayoutSync()` asks Cerebr to recompute the input/chat spacing after the plugin UI changes height.
- `chat.sendDraft()` can be used instead of synthesizing key events against the host editor DOM.
- `page` and `background` plugins keep using their existing APIs.

## Hook Lifecycle

- `shell` plugins can implement `onBeforeSend`, `onBuildPrompt`, `onRequest`, `onResponse`, `onRequestError`, `onStreamChunk`, `onResponseError`, and `onAfterResponse`.
- `page`, `shell`, and `background` plugins can implement `onBridgeMessage`.
- `background` plugins can implement `onBackgroundReady`, `onActionClicked`, `onCommand`, `onInstalled`, `onTabActivated`, `onTabUpdated`, and `onTabRemoved`.
- Local guest shell plugins are optimized for `setup(api)` UI integrations. If you need hooks, keep the plugin self-contained and stay within the official SDK surface.

## Install Flow

1. Enable `偏好设置 -> 开发者模式`.
2. Open `设置 -> 插件 -> 开发者`.
3. Drag a plugin folder that contains `plugin.json` into the drop area, or use `选择插件文件夹`.
4. Cerebr installs the package immediately. There is no `dev-plugins` directory authorization step anymore.

## Runtime Behavior

- Page, shell, and background runtimes subscribe to developer-mode changes.
- Turning developer mode off unloads all local script plugins.
- Refreshing a local plugin re-reads the stored source bundle and reloads the plugin.
- In the browser extension host, dropped local `shell` plugin folders run in a static guest runtime inside the shell input area.
- Guest shell plugins must be self-contained. Absolute `/src/...` imports, same-origin host internals, and direct host DOM access are rejected.
- On the web host, dropped local file bundles still use local bundle storage.

## Example

The migrated `cttf-cerebr-plugin` repository is now the reference example for a self-contained local `shell` plugin that runs through the guest runtime.
