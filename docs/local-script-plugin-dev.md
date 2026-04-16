# Local Script Plugin Development

This guide documents the first developer-mode sideload flow for Cerebr script plugins.

## Scope

- Local sideloaded script plugins only run when developer mode is enabled.
- `scope = page` and `scope = shell` are supported.
- Reviewed marketplace script plugins can be installed normally; this guide is only about local sideloaded script plugins.
- `plugin.json` and `script.entry` must stay on the current Cerebr origin.

## Recommended Layout

```text
statics/dev-plugins/<plugin-id>/
  plugin.json
  page.js | shell.js
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
  "permissions": ["page:selection", "shell:input"],
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

## Install Flow

1. Enable `偏好设置 -> 开发者模式`.
2. Open `设置 -> 插件 -> 开发者`.
3. Choose one import mode:
   - Enter a same-origin manifest path such as `/statics/dev-plugins/explain-selection/plugin.json`, then click `导入本地插件`.
   - Drag a local plugin folder into the drop area in the same panel. Dragging the whole folder works best. If you only drag `plugin.json`, include the referenced script files too.
4. Toggle, refresh, or uninstall the plugin from the same page.

## Runtime Behavior

- Page and shell runtimes subscribe to developer-mode changes.
- Turning developer mode off unloads all local script plugins.
- Refreshing a local plugin re-fetches `plugin.json` and reloads `script.entry` with a cache-busting revision token.
- Plugins installed from dropped local files are persisted in local storage. To update them, drag the updated plugin folder into Cerebr again.

## Example

The repository ships with a sample local plugin:

- Manifest: `/statics/dev-plugins/explain-selection/plugin.json`
- Entry: `/statics/dev-plugins/explain-selection/page.js`
