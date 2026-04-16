# Plugin Marketplace Spec

This document defines the first stable marketplace format for Cerebr plugins, plus the developer-mode contract for local script sideloading.

## Goals

- Keep marketplace installs reviewable and predictable.
- Support built-in plugins plus reviewed declarative and script packages.
- Allow registry-driven compatibility checks, updates, and remote disable.
- Keep unreviewed local script sideloading behind developer mode until a stronger sandbox exists.

## Package Types

- `builtin`: shipped inside the main Cerebr app.
- `declarative`: reviewed package with data-only behavior. Supported types are `prompt_fragment`, `request_policy`, and `page_extractor`.
- `script`: reviewed code package for `page`, `shell`, or `background` runtime behavior.

## `registry.json`

Registry payloads describe what the marketplace can show and install.

Required top-level fields:

- `schemaVersion`: currently `1`
- `registryId`: stable registry identifier
- `displayName`: human-readable registry name
- `generatedAt`: RFC 3339 timestamp
- `plugins`: array of registry entries

Registry entry fields:

- `id`: stable plugin id, for example `official.prompt.concise-reply`
- `kind`: `builtin` | `declarative` | `script`
- `scope`: `page` | `shell` | `prompt` | `background`
- `displayName`
- `description`
- `latestVersion`
- `permissions`: array of capability strings
- `requiresExtension`: optional boolean for plugins that only work in the browser extension host
- `compatibility.versionRange`: semver comparator string, for example `>=2.4.66 <3.0.0`
- `availability.status`: `active` | `disabled`
- `availability.reason`: optional human-readable disable reason
- `install.mode`: `builtin` | `package`
- `install.packageUrl`: required for installable declarative and script packages
- `publisher`, `homepage`: optional metadata

Behavior rules:

- `availability.status = disabled` keeps installed copies manageable via the Installed tab, but hides the plugin from the Marketplace tab until the registry re-enables it.
- Missing installed registry entries are treated as removed from the registry after a successful full registry sync.
- `latestVersion` is compared against the locally installed version to surface updates.

## `plugin.json`

Package manifests describe the locally installed plugin payload.

Required fields:

- `schemaVersion`: currently `1`
- `id`
- `version`
- `kind`
- `scope`
- `displayName`
- `description`

Optional shared fields:

- `publisher`
- `homepage`
- `permissions`
- `requiresExtension`
- `compatibility.versionRange`

Declarative package fields:

- `declarative.type`: `prompt_fragment` | `request_policy` | `page_extractor`
- `prompt_fragment`
  - `declarative.placement`: `system.prepend` | `system.append`
  - `declarative.content`: prompt text to inject
  - `declarative.priority`: optional ordering hint, higher runs earlier within the same placement
- `request_policy`
  - `declarative.applyTo.modes`: optional request modes such as `send` or `regenerate`
  - `declarative.applyTo.modelIncludes`: optional case-insensitive model-name substrings
  - `declarative.applyTo.urlIncludes`: optional case-insensitive request URL substrings
  - `declarative.promptFragments`: optional prompt fragment or fragment list
  - `declarative.requestPatch.url`: optional request URL override
  - `declarative.requestPatch.headers`: optional request header patch
  - `declarative.requestPatch.body`: optional shallow request body patch
  - `declarative.retry.onErrorCodes`: optional error codes that should trigger retry
  - `declarative.retry.maxAttempts`: optional retry ceiling, default `20`
  - `declarative.cancel.draftMatches` / `declarative.cancel.draftIncludes`: optional draft cancellation rules
- `page_extractor`
  - `declarative.matches`: optional URL wildcard patterns, default matches all pages
  - `declarative.includeSelectors`: optional selectors to prefer for text capture
  - `declarative.excludeSelectors`: optional selectors to strip before capture
  - `declarative.strategy`: `replace` | `prepend` | `append`
  - `declarative.priority`: optional ordering hint, higher runs earlier
  - `declarative.maxTextLength`: optional maximum extracted text length
  - `declarative.collapseWhitespace`: optional whitespace normalization toggle

Current declarative runtime behavior:

- `prompt_fragment` and `request_policy` packages are loaded into the shared shell plugin runtime and participate in the same hook pipeline as built-in and script plugins.
- `page_extractor` packages register extractor definitions into the page runtime and can replace, prepend, or append webpage text before Cerebr sends it to the model.
- Disabled or incompatible packages are ignored at runtime.
- Registry metadata controls installability and remote disable; package metadata controls local execution.

Cross-host runtime behavior:

- `page` and `shell` script plugins can call `bridge.send(target, command, payload)` to talk to other hosts.
- `background` script plugins can call `bridge.send()`, `bridge.sendToTab()`, and `bridge.broadcast()` to deliver messages into page or shell runtimes on specific tabs.
- `page`, `shell`, and `background` script plugins can implement `onBridgeMessage(message, ctx)` to receive routed bridge commands.

## Install Flow

1. Cerebr fetches `registry.json` with `cache: no-store`.
2. The Installed tab shows installed plugins only. Built-in plugins with `defaultInstalled: false` stay in the Marketplace tab until the user installs them. The Marketplace tab only shows active, compatible entries supported by the current runtime.
3. Install confirmation lists the plugin permissions.
4. Declarative and script packages download `plugin.json`, validate it, then persist it locally.
5. Local plugin state stores installed version, latest version, permissions, availability, compatibility, and source metadata.

## Script Plugin Policy

- Reviewed script plugins can be listed and installed from the Marketplace tab.
- Script manifests must include `install.packageUrl` in the registry and `script.entry` in `plugin.json`.
- Script packages support `scope = page`, `scope = shell`, or `scope = background`.
- `background` script packages must declare `requiresExtension = true`.
- Unreviewed local script plugins remain in the developer-mode sideload flow.

## Developer-Mode Local Script Sideload

Local script plugins are installed outside the reviewed marketplace flow.

Rules:

- Developer mode must be explicitly enabled before script plugins can be side-loaded or executed.
- The plugin page accepts a local `plugin.json` path, for example `/statics/dev-plugins/explain-selection/plugin.json`.
- The developer tab also supports dragging a local plugin folder directly into Cerebr for installation. Dragging the whole folder is recommended so relative `script.entry` files are available.
- `plugin.json` and `script.entry` must resolve to the current Cerebr origin only. Cross-origin script URLs are rejected.
- Script manifests must include `script.entry`; optional `script.exportName` defaults to `default`.
- Script plugins currently support `scope = page`, `scope = shell`, or `scope = background`.
- `background` script plugins only run in the browser extension host.
- Sideloaded script plugins store manifest metadata plus either the source URL or a dropped local file bundle, so they can be reloaded on the next launch.

Recommended folder layout:

```text
statics/dev-plugins/<plugin-id>/
  plugin.json
  page.js | shell.js | background.js
```

## Compatibility

- Compatibility is evaluated against the running Cerebr app version.
- Incompatible plugins remain manageable if already installed, but they are hidden from the Marketplace tab until they become compatible again.
- Registry updates may change compatibility or availability without changing the package payload.
