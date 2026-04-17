# Plugin Marketplace Spec

This document defines the current Cerebr marketplace contract after the plugin-system refactor.

## Scope

The marketplace format now needs to cover three layers at the same time:

- package metadata for install/update/compatibility
- contribution metadata for declarative plugins
- runtime activation metadata so plugins are not eagerly loaded by default

The official reviewed marketplace source of truth remains:

- `/Users/yanyuming/Downloads/GitHub/cerebr-plugins`

The main Cerebr repository only carries a bundled fallback snapshot under:

- `statics/plugin-registry.json`
- `statics/plugins/**`
- `statics/runtime/**`

Do not hand-edit those bundled fallback files in the main app repo. Sync them from `cerebr-plugins` instead:

```bash
node scripts/sync_official_plugin_fallback.mjs
```

Or from the source-of-truth repo:

```bash
cd /Users/yanyuming/Downloads/GitHub/cerebr-plugins
npm run sync:cerebr
```

## Runtime model

Marketplace payloads target the refactored plugin runtime:

- `compiler`: normalizes manifest v1/v2 into a shared contribution shape
- `kernel`: keeps plugin state, activation, lazy loading, and diagnostics
- `services`: expose host capabilities through stable service groups
- `hosts`: `shell`, `page`, and `background` each register the services they provide

Internally, declarative and script plugins are both compiled into the same runtime entry model. The marketplace format therefore exposes both package metadata and activation metadata.

## Package kinds

- `builtin`: shipped with the main Cerebr app
- `declarative`: reviewed data-only package that compiles into runtime contributions
- `script`: reviewed executable package for `page`, `shell`, or `background`

## Supported manifest schema versions

- `schemaVersion = 1`
  - legacy format
  - declarative packages use `declarative.type`
- `schemaVersion = 2`
  - preferred format
  - declarative packages use `contributions`
  - script and declarative packages can declare `activationEvents`

Manifest v1 remains supported for backward compatibility. New marketplace packages should use schema v2 unless there is a compatibility reason not to.

## Activation events

Plugins are no longer required to activate eagerly at startup.

Supported activation patterns:

- `app.startup`
- `page.ready`
- `shell.ready`
- `background.ready`
- `hook:<hookName>` such as `hook:onBeforeSend`, `hook:onResponseError`, `hook:onCommand`
- wildcard forms such as `hook:*` and `page.*`

Guidance:

- UI setup plugins should usually activate on the host-ready event for their scope.
- request / retry plugins should usually activate on the hook they intercept.
- background command plugins should usually activate on `hook:onActionClicked`, `hook:onCommand`, or both.

## `registry.json`

Registry payloads describe what the marketplace can show and install.

Required top-level fields:

- `schemaVersion`: currently `1`
- `registryId`
- `displayName`
- `generatedAt`
- `plugins`

Registry entry fields:

- `id`
- `kind`: `builtin` | `declarative` | `script`
- `scope`: `page` | `shell` | `prompt` | `background`
- `displayName`
- `description`
- `latestVersion`
- `permissions`
- `requiresExtension`
- `compatibility.versionRange`
- `availability.status`: `active` | `disabled`
- `availability.reason`
- `install.mode`: `builtin` | `package`
- `install.packageUrl`
- `publisher`, `homepage`

Optional v2 metadata fields:

- `activationEvents`: activation hints shown to the host before install
- `contributionTypes`: summary of declarative contribution groups, for example:
  - `promptFragments`
  - `requestPolicies`
  - `pageExtractors`
  - `selectionActions`
  - `inputActions`
  - `menuItems`
  - `slashCommands`

Behavior rules:

- `availability.status = disabled` keeps installed copies manageable from Installed, but hides the marketplace card until the registry re-enables it.
- Missing registry entries are treated as removed after a successful full sync.
- `latestVersion` is compared against the local installed version to surface updates.
- `activationEvents` and `contributionTypes` are metadata only; the package manifest is still the execution source of truth.
- registry and package manifests should prefer resource-scoped permissions such as `page:selection:read`, `shell:input:write`, `prompt:fragments`, and `bridge:send:shell`; legacy namespace permissions still load for compatibility

## `plugin.json`

Required shared fields:

- `schemaVersion`
- `id`
- `version`
- `kind`
- `scope`
- `displayName`
- `description`

Optional shared fields:

- `defaultEnabled`
- `publisher`
- `homepage`
- `permissions`
- `requiresExtension`
- `activationEvents`
- `compatibility.versionRange`

### Script packages

Script packages must include:

- `script.entry`
- optional `script.exportName`

Script packages support:

- `scope = page`
- `scope = shell`
- `scope = background`

Background script packages must set:

```json
"requiresExtension": true
```

### Declarative packages

Declarative packages can use either of these formats:

#### Legacy v1 format

Use `declarative.type`:

- `prompt_fragment`
- `request_policy`
- `page_extractor`

#### Preferred v2 format

Use `contributions`:

- `promptFragments`
- `requestPolicies`
- `pageExtractors`
- `selectionActions`
- `inputActions`
- `menuItems`
- `slashCommands`

Scope rules:

- prompt contributions require `scope = prompt` or `scope = shell`
- request policies require `scope = shell`
- shell actions require `scope = shell`
- page extractors and selection actions require `scope = page`

### Contribution details

#### `promptFragments`

Adds persistent prompt fragments through the host prompt service.

Fields:

- `content` or `contentKey`
- `placement`: `system.prepend` | `system.append`
- `priority`

#### `requestPolicies`

Declares shell request interception without shipping runtime code.

Fields:

- `applyTo.modes`
- `applyTo.modelIncludes`
- `applyTo.urlIncludes`
- `promptFragments`
- `requestPatch.url`
- `requestPatch.headers`
- `requestPatch.body`
- `retry.onErrorCodes`
- `retry.maxAttempts`
- `retry.reason`
- `cancel.draftMatches`
- `cancel.draftIncludes`
- `cancel.reason`

#### `pageExtractors`

Registers extractor definitions in the page runtime.

Fields:

- `matches`
- `includeSelectors`
- `excludeSelectors`
- `strategy`: `replace` | `prepend` | `append`
- `priority`
- `maxTextLength`
- `collapseWhitespace`

#### `selectionActions`

Adds anchored actions beside the current page selection.

Fields:

- `label`
- `prompt` or `promptTemplate`
- `title`
- `icon`
- `focus`
- `separator`
- `minLength`
- `maxLength`
- `offsetX`
- `offsetY`

Selection prompts support template expansion such as:

- `{{selection.text}}`
- `{{page.url}}`
- `{{page.title}}`

#### `inputActions`

Adds native shell buttons under the composer.

Fields:

- `id`
- `label`
- `icon`
- `title`
- `variant`
- `disabled`
- `order`
- `execute`

#### `menuItems`

Adds first-level menu entries to the Cerebr settings shell.

Fields:

- `id`
- `label`
- `icon`
- `title`
- `order`
- `disclosure`
- `disabled`
- `execute`

#### `slashCommands`

Adds host-owned `/` commands in the shell composer.

Fields:

- `name`
- `label`
- `description`
- `aliases`
- `prompt`
- `separator`
- `disabled`
- `order`

#### Shared shell `execute` actions

Declarative shell actions currently support:

- `import_text`
- `insert_text`
- `set_draft`
- `show_toast`
- `open_page`

## Install flow

1. Cerebr fetches `registry.json` with `cache: no-store`.
2. The marketplace filters entries by host support, compatibility, and availability.
3. Install confirmation lists permissions.
4. For declarative and script packages, Cerebr downloads `plugin.json`, validates it, and stores the package metadata locally.
5. At runtime, the compiler normalizes the package into a resolved plugin entry, then the kernel activates it lazily according to `activationEvents`.

## Script plugin policy

- Reviewed script plugins can be listed and installed from the marketplace.
- Script packages must be self-contained.
- `script.entry` must stay on the same origin as the fetched `plugin.json`.
- Remote marketplace script packages must not import private files from the main Cerebr repository.
- `background` script packages must set `requiresExtension = true`.
- Unreviewed local script plugins remain in developer-mode sideloading.

## Developer-mode local script sideload

Local script plugins are installed outside the reviewed marketplace flow.

Rules:

- developer mode must be enabled
- local `script.entry` must resolve under the current Cerebr origin or dropped bundle
- dropped local `shell` plugins in the extension host run inside the static guest runtime
- local guest shell plugins must stay self-contained and must not import `/src/...` host internals

Recommended layout:

```text
<plugin-id>/
  plugin.json
  page.js | shell.js | background.js
```

## Compatibility

- Compatibility is evaluated against the running Cerebr app version.
- Incompatible plugins remain manageable if already installed.
- Registry metadata can change availability or compatibility without changing the package payload.
- Schema v2 packages should declare a compatibility floor that matches the host release which introduced the required contribution or activation behavior.
