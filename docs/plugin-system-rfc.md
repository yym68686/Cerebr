# Cerebr Plugin System RFC

This document records the current plugin-system architecture after the runtime refactor.

## Why the refactor happened

The original plugin system already had useful pieces:

- host-specific runtime entry points
- plugin hooks in the chat pipeline
- page extractors
- shell slots and menu/page surfaces
- background bridge routing

The problem was that each new capability still required touching manifest parsing, loader logic, and host-specific runtime code separately. Declarative and script plugins also followed different execution paths even when they were targeting the same behavior class.

The refactor goal was to unify those layers without breaking existing packages.

## Current architecture

The new runtime is split into four layers:

```text
src/plugin/
  compiler/   # manifest/plugin entry normalization
  kernel/     # activation, status, diagnostics, lazy loading
  services/   # host service registry
  hosts/      # shell/page/background runtime adapters
```

### Compiler

`src/plugin/compiler/plugin-entry-compiler.js`

Responsibilities:

- normalize manifest-backed and plain runtime plugin entries
- infer implemented hooks
- resolve `activationEvents`
- derive contribution summary metadata

This is the first place where script and declarative entries become comparable.

### Kernel

`src/plugin/kernel/plugin-kernel.js`

Responsibilities:

- store resolved entries
- keep status snapshots
- lazily activate plugins when an activation event arrives
- expose diagnostics such as:
  - `state`
  - `active`
  - `failures`
  - `lastActivationEvent`
  - `lastError`

The kernel wraps the existing plugin manager, so most upper layers can still use the familiar manager-like API while gaining lazy activation and state tracking.

### Host service registry

`src/plugin/services/host-service-registry.js`

Responsibilities:

- assemble host APIs from service definitions instead of hard-coded runtime factories
- keep the host-specific API surface explicit
- build a consistent hook context from the same service map

Current hosts now expose services instead of each runtime hand-assembling a separate implicit API contract.

### Hosts

Current adapters:

- `src/plugin/shell/shell-plugin-runtime.js`
- `src/plugin/page/page-plugin-runtime.js`
- `src/plugin/background/background-plugin-runtime.js`

Each host now:

- registers host services
- starts the shared hosted runtime
- emits a sticky ready event:
  - `shell.ready`
  - `page.ready`
  - `background.ready`

## Unified setup context

Script plugin `setup(...)` now receives a single runtime context object instead of an implicit host API blob.

The runtime context includes:

- `api` / `capabilities` / `services`
- top-level service aliases for compatibility (`shell`, `chat`, `page`, `ui`, ...)
- `permissions`
- `plugin`
- `runtime`
- `env`
- `diagnostics`

Design intent:

- plugin setup follows the same contract in shell/page/background
- host-specific setup does not need fallback chains such as descriptor API, registry API, and ad-hoc global factories
- later capability additions should extend the runtime context rather than add more loader-time special cases

## Activation preflight

Before a plugin activates, the hosted runtime now performs a preflight check.

The preflight currently rejects or warns on:

- missing `plugin.id`
- missing `setup()`
- script plugins without `script.entry`
- host/scope mismatches
- extension-only plugins trying to start in the web host
- empty resolved host APIs
- unstable web bundle module strategies

Design intent:

- fail early during activation instead of letting plugins crash after a user action
- keep diagnostics close to the real root cause
- stop repeating the same guest/host/runtime mismatch bugs across new plugins

## Stable local bundle loading

Local bundled script plugins in the web host now default to `data:` module URLs instead of transient `blob:` module URLs.

Design intent:

- avoid refresh-time `blob:` lifetime failures
- keep local bundle loading deterministic across page reloads
- reduce one-off loader logic between extension and web hosts

## Manifest model

## Schema versions

Supported plugin manifest versions:

- `schemaVersion = 1`
- `schemaVersion = 2`

Registry schema remains:

- `schemaVersion = 1`

The compatibility rule is simple:

- manifest v1 continues to load
- new packages should move to v2
- the runtime normalizes both into the same internal model

## Declarative compatibility path

Legacy declarative plugins still work:

- `prompt_fragment`
- `request_policy`
- `page_extractor`

Schema v2 introduces contribution groups:

- `promptFragments`
- `requestPolicies`
- `pageExtractors`
- `selectionActions`
- `inputActions`
- `menuItems`
- `slashCommands`

The declarative runtime compiler now consumes either format and emits a single runtime plugin object.

## Activation model

Plugins no longer need to activate eagerly at startup.

Current activation classes:

- host lifecycle
  - `app.startup`
  - `shell.ready`
  - `page.ready`
  - `background.ready`
- hook activation
  - `hook:onBeforeSend`
  - `hook:onResponseError`
  - `hook:onCommand`
  - other implemented hook names
- wildcard activation
  - `hook:*`
  - `<namespace>.*`

Design intent:

- UI plugins activate when the host surface is ready
- request policies activate only when the relevant hook is about to run
- background command plugins activate only when a command/action hook is invoked

This removes a large amount of unnecessary startup work.

## Contribution model

The runtime now treats declarative packages as contribution providers instead of special-casing each manifest type in the loader.

### Page contributions

- `pageExtractors`
- `selectionActions`

### Shell / prompt contributions

- `promptFragments`
- `requestPolicies`
- `inputActions`
- `menuItems`
- `slashCommands`

### Execution support

Declarative shell actions currently support:

- `import_text`
- `insert_text`
- `set_draft`
- `show_toast`
- `open_page`

This gives declarative packages a larger coverage surface without crossing into arbitrary remote code.

## Bridge and permissions

### Bridge envelope

`src/plugin/bridge/plugin-bridge.js`

The bridge message envelope now carries:

- `schemaVersion`
- `messageId`
- `meta.timestamp`

The runtime still accepts older bridge messages for compatibility, but newly sent messages use the new envelope.

### Permissions

The runtime still accepts legacy aliases for compatibility, but the API surface and marketplace/template baseline now use resource-scoped permissions:

- page services
- shell services
- bridge services
- storage/browser services

Examples:

- `page:selection:read`
- `page:selection:clear`
- `shell:input:write`
- `prompt:fragments`
- `bridge:send:shell`

The plugin settings UI now also surfaces kernel diagnostics from the shell host directly and aggregates page/background diagnostics through the extension message bridge.

## What is implemented in this refactor

- shared compiler for manifest-backed plugin entries
- plugin kernel with activation and diagnostics
- host service registry
- shell/page/background runtimes migrated to the new registry + kernel path
- sticky host-ready events
- runtime diagnostics surfaced in plugin management UI
- resource-scoped runtime permission checks with legacy alias compatibility
- unified setup-time runtime context across hosts
- plugin activation preflight
- stable `data:`-first web loading for local bundled script plugins
- declarative compiler upgraded to v2 contributions
- manifest validator upgraded to schema v1/v2 compatibility
- bridge envelope upgraded to schema v2 metadata
- template and marketplace repositories synchronized to the new manifest/contribution model

## What remains intentionally out of scope

These are follow-up tracks, not blockers for the current refactor:

- site-level connector abstractions above raw selector automation
- explicit dependency graphs between plugins
- background tasks / workflow contributions beyond current hook and bridge behavior

## Migration rules

For plugin authors:

1. keep existing v1 packages working
2. prefer schema v2 for all new packages
3. add explicit `activationEvents`
4. move new declarative packages to `contributions`
5. prefer host-native shell surfaces over custom DOM injection

For Cerebr maintainers:

1. update the main repo schema/docs
2. update `/Users/yanyuming/Downloads/GitHub/cerebr-plugin-template`
3. update `/Users/yanyuming/Downloads/GitHub/cerebr-plugins`
4. sync bundled fallback from the marketplace repo

That keeps runtime behavior, plugin author guidance, and marketplace payloads on the same contract.
