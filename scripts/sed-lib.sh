#!/bin/bash
# sed-lib.sh — shared helpers for the build workflows' sed-based placeholder
# substitution steps. Source this, then call the functions below.
#
#   assert_sed <file> <needle>
#     Fails loudly if <needle> isn't present in <file> - guards against a
#     later `sed -i` substitution silently matching nothing (e.g. upstream
#     renamed the anchor text, or a patch script's insertion degraded).
#     Uses a fixed-string match (grep -F) since some needles (banner text)
#     contain regex metacharacters like parentheses.
#
#   sed_escape <value>
#     Escapes '\', '&' and '/' in <value> so it's safe to drop into the
#     replacement side of an `s/.../.../` sed expression regardless of what
#     characters it contains. Needed anywhere a GitHub Secret (whose value
#     isn't controlled by this repo) is substituted in via sed - a secret
#     containing '/' would otherwise break the delimiter, '&' would insert
#     the whole match instead of the literal character, and an unescaped
#     '\' can escape the following character.
#
#   portable_sed_i <sed-args...>
#     In-place sed that works on both GNU sed (Linux, and Windows via
#     git-bash) and BSD sed (macOS), which require different -i syntax.
#     $RUNNER_OS is set automatically by GitHub Actions to "Linux" /
#     "Windows" / "macOS". Usage is identical to `sed -i <args>` otherwise.

assert_sed() {
  local file="$1"
  local needle="$2"
  if ! grep -qF -- "$needle" "$file"; then
    echo "ERROR: expected text '$needle' not found in $file — the sed substitution that follows would silently do nothing." >&2
    exit 1
  fi
}

sed_escape() {
  printf '%s' "$1" | sed -e 's/[\&/]/\\&/g'
}

portable_sed_i() {
  if [ "$RUNNER_OS" = "macOS" ]; then
    sed -i '' "$@"
  else
    sed -i "$@"
  fi
}
