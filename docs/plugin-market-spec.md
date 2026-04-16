# Plugin Marketplace Spec

This document defines the first stable marketplace format for Cerebr plugins, plus the developer-mode contract for local script sideloading.

## Goals

- Keep marketplace installs reviewable and predictable.
- Support built-in plugins plus reviewed declarative and script packages.
- Allow registry-driven compatibility checks, updates, and remote disable.
- Keep unreviewed local script sideloading behind developer mode until a stronger sandbox exists.

## Package Types

- `builtin`: shipped inside the main Cerebr app.
- `declarative`: reviewed package with data-only behavior. The current supported type is `prompt_fragment`.
- `script`: reviewed code package for `page` or `shell` runtime behavior.

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
- `scope`: `page` | `shell` | `prompt`
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

- `declarative.type`: currently only `prompt_fragment`
- `declarative.placement`: `system.prepend` | `system.append`
- `declarative.content`: prompt text to inject

Current declarative runtime behavior:

- Prompt fragments are loaded from locally installed packages only.
- Disabled or incompatible packages are ignored at send time.
- Registry metadata controls installability and remote disable; package metadata controls local execution.

## Install Flow

1. Cerebr fetches `registry.json` with `cache: no-store`.
2. The Installed tab shows built-in entries plus installed registry entries. The Marketplace tab only shows active, compatible registry entries supported by the current runtime.
3. Install confirmation lists the plugin permissions.
4. Declarative and script packages download `plugin.json`, validate it, then persist it locally.
5. Local plugin state stores installed version, latest version, permissions, availability, compatibility, and source metadata.

## Script Plugin Policy

- Reviewed script plugins can be listed and installed from the Marketplace tab.
- Script manifests must include `install.packageUrl` in the registry and `script.entry` in `plugin.json`.
- Script packages are still limited to `scope = page` or `scope = shell`.
- Unreviewed local script plugins remain in the developer-mode sideload flow.

## Developer-Mode Local Script Sideload

Local script plugins are installed outside the reviewed marketplace flow.

Rules:

- Developer mode must be explicitly enabled before script plugins can be side-loaded or executed.
- The plugin page accepts a local `plugin.json` path, for example `/statics/dev-plugins/explain-selection/plugin.json`.
- The developer tab also supports dragging a local plugin folder directly into Cerebr for installation. Dragging the whole folder is recommended so relative `script.entry` files are available.
- `plugin.json` and `script.entry` must resolve to the current Cerebr origin only. Cross-origin script URLs are rejected.
- Script manifests must include `script.entry`; optional `script.exportName` defaults to `default`.
- Script plugins currently support `scope = page` or `scope = shell` only.
- Sideloaded script plugins store manifest metadata plus either the source URL or a dropped local file bundle, so they can be reloaded on the next launch.

Recommended folder layout:

```text
statics/dev-plugins/<plugin-id>/
  plugin.json
  page.js | shell.js
```

## Compatibility

- Compatibility is evaluated against the running Cerebr app version.
- Incompatible plugins remain manageable if already installed, but they are hidden from the Marketplace tab until they become compatible again.
- Registry updates may change compatibility or availability without changing the package payload.
