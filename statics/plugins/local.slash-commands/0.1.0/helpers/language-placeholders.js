// Pure helper: expand {{lang}} placeholders to a natural-language label.
// No side effects; imported by shell.js at draft-expansion time.

const LANG_TOKEN_REGEX = /\{\{\s*lang\s*\}\}/gi;

export function expandLanguagePlaceholders(text, localeLabel) {
    const input = String(text ?? '');
    const replacement = String(localeLabel ?? 'English');
    return input.replace(LANG_TOKEN_REGEX, replacement);
}
