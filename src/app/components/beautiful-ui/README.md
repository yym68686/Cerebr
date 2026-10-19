# Beautiful UI Selection Actions

This is vendored source, not a visual recreation. Upstream is MIT licensed by
Shane Levine; retain `LICENSE` when distributing these files.

- Component and registry: https://www.beautifului.dev/r/selection-actions.json
- Foundation: https://www.beautifului.dev/r/foundation.json
- Repository: https://github.com/slev12397/beautiful-ui
- Retrieved 2026-10-20; repository HEAD `44a274e598395ab61e7c96c26fda2758780253b7`.
- `upstream/` holds the unmodified registry/repository files for comparison.

The working component retains the upstream pill markup, Button atom, Iconoir
icons, dimensions, theme tokens, shadows, and input/expansion animations.
Integration changes are limited to local imports, an external-selection mode
that omits the example passage and simulated rewrite, real action/prompt
callbacks, localised labels, IME handling, pending/keyboard accessibility, and
viewport constraints. Cerebr's custom-prompt editor is separate from the pill.

`SelectionSurface.jsx` compiles the original Tailwind foundation inside a shadow
root. It maps the existing theme, registers a locally bundled Inter font, and
initialises Tailwind's own custom-property defaults because browsers do not
register `@property` inside a shadow root. The spacing token is fixed to 4px so a
host page's root font size cannot resize the original 36px pill.

`foundation.css` changes the registry's `:root` to `:host` and narrows Tailwind
source scanning to these components. It also removes a malformed orphaned
`.records-footer-hint` block/closing brace left by the upstream foundation
registry's SidebarNav extraction; this unrelated rule is not used here.

The selection watcher waits for a completed pointer gesture and a 160ms stable
range before mounting the original bar. The host stays hidden until measured
placement is ready, avoiding a first-frame reposition. Build output includes
`selection-actions-NOTICES.txt` for the vendored source and its dependencies.
