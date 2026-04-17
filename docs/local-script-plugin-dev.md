# Local Script Plugin Development

This guide documents the current developer-mode sideload flow after the plugin runtime refactor.

## Scope

- local sideloaded script plugins only run when developer mode is enabled
- `scope = page`, `scope = shell`, and `scope = background` are supported
- `background` plugins only run in the browser extension host and must set `requiresExtension = true`
- reviewed marketplace script plugins use the same runtime contract; this guide only focuses on local sideload
- dropped local `shell` plugins in the browser extension host still run inside the static guest runtime and must stay self-contained

## Recommended layout

```text
my-plugin/
  plugin.json
  shell.js | page.js | background.js
  vendor/
```

## `plugin.json`

New local script plugins should use schema v2 and explicit activation events:

```json
{
  "schemaVersion": 2,
  "id": "local.cttf-shell",
  "version": "2.0.0",
  "kind": "script",
  "scope": "shell",
  "displayName": "CTTF for Cerebr",
  "description": "Run Chat Template Text Folders inside the Cerebr shell through the self-contained guest runtime.",
  "defaultEnabled": true,
  "requiresExtension": true,
  "permissions": [
    "prompt:fragments",
    "shell:input:write",
    "shell:input:actions",
    "shell:input:slash-commands",
    "shell:menu:items",
    "shell:page:control"
  ],
  "activationEvents": ["shell.ready"],
  "compatibility": {
    "versionRange": ">=2.4.86 <3.0.0"
  },
  "script": {
    "entry": "./shell.js"
  }
}
```

Notes:

- `script.entry` should be relative to `plugin.json` for dropped self-contained plugins
- `script.exportName` is optional and defaults to `default`
- prefer manifest-level `activationEvents`; runtime-level `plugin.activationEvents` is still supported as a fallback
- the exported plugin object must expose `id` and `setup(api)`
- do not import `/src/...` files from the Cerebr repository in dropped local `shell` plugins
- plugin permissions are normalized by the host before runtime use
- legacy namespace-like permissions and aliases still resolve for compatibility, but new packages should declare resource-scoped permissions such as `page:selection:read`, `shell:input:write`, `prompt:fragments`, or `bridge:send:shell`
- namespace wildcards such as `shell:*`, `page:*`, or `site:*` still work, but fine-grained capabilities are preferred

## Activation events

The new kernel supports lazy activation. Do not default every plugin to eager startup.

Common activation events:

- `app.startup`
- `page.ready`
- `shell.ready`
- `background.ready`
- `hook:onBeforeSend`
- `hook:onResponseError`
- `hook:onCommand`
- `hook:onActionClicked`
- `hook:*`

Guidance:

- page UI helpers should usually use `page.ready`
- shell UI/setup plugins should usually use `shell.ready`
- request interception plugins should usually use the specific hook they intercept
- background command plugins should usually use `hook:onActionClicked`, `hook:onCommand`, or both

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

### Page plugins

- `page.*`
- `site.*`
- `ui.showAnchoredAction(...)`
- `ui.mountSlot(...)`
- `shell.*` composer helpers
- `bridge.send(...)`

### Shell plugins

- `browser.getCurrentTab()`
- `editor.*`
- `chat.*`
- `prompt.*`
- `storage.*`
- `i18n.*`
- `shell.*`
- `ui.showToast(...)`
- `bridge.send(...)`

### Background plugins

- `browser.*`
- `storage.*`
- `bridge.send(...)`
- `bridge.sendToTab(...)`
- `bridge.broadcast(...)`

## Preferred shell UI stack

For shell plugins, choose the first host surface that fits:

1. `shell.setInputActions()` for native buttons under the composer
2. `shell.setSlashCommands()` for native `/` command UX
3. `shell.setMenuItems()` for first-level settings/navigation entries
4. `shell.openPage({ view })` for settings and management pages
5. `shell.showModal()` only when the interaction is truly modal
6. `shell.mountInputAddon()` only when the host cannot render the surface natively

For settings, dashboards, or review flows, prefer `shell.openPage({ view })` over plugin-owned modal DOM.

## Hook lifecycle

Shell plugins can implement:

- `onBeforeSend`
- `onBuildPrompt`
- `onRequest`
- `onResponse`
- `onRequestError`
- `onStreamChunk`
- `onResponseError`
- `onAfterResponse`

Page, shell, and background plugins can implement:

- `onBridgeMessage`

Background plugins can implement:

- `onBackgroundReady`
- `onActionClicked`
- `onCommand`
- `onInstalled`
- `onTabActivated`
- `onTabUpdated`
- `onTabRemoved`

If a plugin only needs one hook, prefer activating on `hook:<that-hook>` instead of `app.startup`.

## Install flow

1. Enable `偏好设置 -> 开发者模式`.
2. Open `设置 -> 插件 -> 开发者`.
3. Drag a plugin folder that contains `plugin.json`, or use `选择插件文件夹`.
4. Cerebr installs the package immediately.

## Runtime behavior

- page, shell, and background runtimes all compile sideloaded manifests through the same validation path as marketplace packages
- the kernel keeps activation state and diagnostics per plugin
- turning developer mode off unloads all local script plugins
- refreshing a local plugin re-reads the stored source bundle and reloads the plugin
- in the browser extension host, dropped local `shell` plugin folders run in the static guest runtime
- host-native input actions, menu items, slash commands, and shell pages are forwarded through the guest bridge
- guest shell plugins must stay self-contained; absolute `/src/...` imports and direct host DOM access are rejected

## Example

The standalone `cerebr-plugin-template` repository is the current reference baseline for local page, shell, background, and declarative plugin development.
