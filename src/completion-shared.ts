/**
 * Shared constants and shell script generators for tab-completion.
 *
 * This module MUST remain lightweight (no registry, no discovery imports).
 * Both completion.ts (full path) and completion-fast.ts (manifest path) import from here.
 */

/**
 * Built-in (non-dynamic) top-level commands.
 */
export const BUILTIN_COMMANDS = [
  'list',
  'validate',
  'verify',
  'auth',
  'browser',
  'tab',
  'doctor',
  'plugin',
  'external',
  'completion',
];

// ── Shell script generators ────────────────────────────────────────────────

export function bashCompletionScript(): string {
  return `# Bash completion for wtscli
# Add to ~/.bashrc:  eval "$(wtscli completion bash)"
_wtscli_completions() {
  local cur words cword
  _get_comp_words_by_ref -n : cur words cword

  local completions
  completions=$(wtscli --get-completions --cursor "$cword" "\${words[@]:1}" 2>/dev/null)

  COMPREPLY=( $(compgen -W "$completions" -- "$cur") )
  __ltrim_colon_completions "$cur"
}
complete -F _wtscli_completions wtscli
`;
}

export function zshCompletionScript(): string {
  return `# Zsh completion for wtscli
# Add to ~/.zshrc:  eval "$(wtscli completion zsh)"
_wtscli() {
  local -a completions
  local cword=$((CURRENT - 1))
  completions=(\${(f)"$(wtscli --get-completions --cursor "$cword" "\${words[@]:1}" 2>/dev/null)"})
  compadd -a completions
}
compdef _wtscli wtscli
`;
}

export function fishCompletionScript(): string {
  return `# Fish completion for wtscli
# Add to ~/.config/fish/config.fish:  wtscli completion fish | source
complete -c wtscli -f -a '(
  set -l tokens (commandline -cop)
  set -l cursor (count (commandline -cop))
  wtscli --get-completions --cursor $cursor $tokens[2..] 2>/dev/null
)'
`;
}
