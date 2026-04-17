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
  "version": "1.8.0",
  "kind": "script",
  "scope": "shell",
  "displayName": "CTTF for Cerebr",
  "description": "Run Chat Template Text Folders inside the Cerebr shell through the official self-contained guest runtime.",
  "defaultEnabled": true,
  "requiresExtension": true,
  "permissions": ["shell:input", "shell:menu", "shell:page", "tabs:read", "chat:write"],
  "compatibility": {
    "versionRange": ">=2.4.84 <3.0.0"
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
- Plugin permissions are normalized by the host. Legacy aliases such as `tabs:active` and `storage:local` are expanded to the current canonical capability names automatically.
- Namespace wildcards such as `shell:*`, `page:*`, or `site:*` are supported, but fine-grained capabilities are still recommended for published plugins.

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
- `shell.mountInputAddon()` gives the plugin a stable full-width container in `shell.input.row.after`, directly under the composer row.
- `shell.setInputActions(actions)` lets the host render native buttons under the composer without the plugin mounting its own toolbar.
- `shell.clearInputActions()` removes those host-rendered buttons.
- `shell.onInputAction(callback)` receives host button clicks with `{ actionId, action, anchorRect }`, so the plugin can open its own popover or dialog from a native Cerebr button.
- `shell.setSlashCommands(commands, options)` lets the host own `/` command UI, keyboard handling, IME/composition safety, and draft replacement.
- `shell.clearSlashCommands()` removes those slash commands.
- `shell.onSlashCommandEvent(callback)` receives host slash events such as `{ type: 'select', command, trailingText }`.
- `shell.setMenuItems(items)` adds first-level menu entries to the Cerebr settings menu.
- `shell.clearMenuItems()` removes those host-rendered menu entries.
- `shell.onMenuAction(callback)` receives host menu clicks with `{ itemId, item, anchorRect }`.
- `shell.openPage(page)` opens a host-managed full page inside the Cerebr shell. Pass `page.view` to let Cerebr render the body from a serializable schema instead of reparenting plugin DOM.
- `shell.updatePage(page)` updates the current page metadata or `page.view` without reopening it.
- `shell.closePage(reason)` dismisses the host page and returns the plugin surface to its inline slot.
- `shell.onPageEvent(callback)` receives lifecycle plus interaction events such as `{ type: 'open' | 'close' | 'action' | 'change', page, ... }`.
- `shell.showModal(options)` moves the plugin's mounted shell surface into a host-managed modal panel inside the Cerebr chat area.
- `shell.updateModal(options)` updates that modal panel's size/alignment without closing it first.
- `shell.hideModal()` restores the plugin surface back to its inline shell slot.
- `shell.observeTheme(callback)` notifies plugins when the shell theme changes.
- `shell.requestLayoutSync()` asks Cerebr to recompute the input/chat spacing after the plugin UI changes height.
- `storage.get(...)`, `storage.set(...)`, and `storage.remove(...)` are available to `shell` plugins through the same capability model as `background` plugins.
- `i18n.getLocale()`, `i18n.getMessage(...)`, and `i18n.onLocaleChanged(...)` let local shell plugins stay in sync with the host locale without importing `/src/utils/i18n.js`.
- `chat.sendDraft()` can be used instead of synthesizing key events against the host editor DOM.
- `page` and `background` plugins keep using their existing APIs.

For settings, dashboards, or management flows, prefer `shell.setMenuItems()` + `shell.openPage({ view })` over plugin-owned modal dialogs. The host page chrome stays visually consistent with Cerebr, avoids guest iframe overlay issues, and lets the host own buttons, forms, and list layout.

Host-rendered pages now default to the same visual language as Cerebr's native settings pages. Plugin authors should describe structure instead of styles:

- Use page `title` and `subtitle` for the shell header, not a duplicated in-page hero headline.
- Use `card` sections for content groups and `columns` only when you truly need split management panes.
- Use content nodes like `text`, `note`, `stats`, `actions`, `form`, `list`, and `badges`.
- `checkbox`, `select`, `color`, `text`, and `textarea` fields are automatically rendered with host-native settings controls.
- For guest shell plugins, keep bundled data in local JS/JSON modules. Avoid `fetch(new URL('./file.json', import.meta.url))` for plugin-local resources.

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
- In the browser extension host, dropped local `shell` plugin folders run in a static guest runtime mounted into the row-level `shell.input.row.after` slot.
- Host-native input actions, first-level menu items, and shell pages are forwarded through the guest bridge, so local shell plugins can use the same `shell.*` navigation/layout APIs without reaching into host DOM.
- Guest shell plugins must be self-contained. Absolute `/src/...` imports, same-origin host internals, and direct host DOM access are rejected.
- On the web host, dropped local file bundles still use local bundle storage.

## Example

The migrated `cttf-cerebr-plugin` repository is now the reference example for a self-contained local `shell` plugin that runs through the guest runtime.
