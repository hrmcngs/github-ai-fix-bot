#!/usr/bin/env bash
# Install into the current Git repository. Safe to invoke through curl | bash.
set -euo pipefail

usage() {
  cat <<'HELP'
Usage: bash install.sh [--directory PATH] [--ref COMMIT_SHA]

Installs .github/ai-bot/ and the investigation/fix workflows.
Default destination: root of the current Git repository.
Default source: hrmcngs/github-ai-fix-bot main, resolved once to a commit.
Existing config.json is preserved. Other differing files cause installation to stop.
No keys are requested, and no commits, pushes or Actions runs are performed.
HELP
}
fail() { printf 'Error: %s\n' "$*" >&2; exit 1; }

main() {
  local destination='' commit='' remote_ref='' root='' relative='' parent=''
  local -a files=(
    .github/ai-bot/.dockerignore
    .github/ai-bot/Dockerfile
    .github/ai-bot/Dockerfile.verify
    .github/ai-bot/package.json
    .github/ai-bot/config.json
    .github/ai-bot/src/core.js
    .github/ai-bot/src/commands.js
    .github/ai-bot/src/auto-merge.js
    .github/ai-bot/src/markdown.js
    .github/ai-bot/src/proposal-state.js
    .github/ai-bot/src/proposals.js
    .github/ai-bot/src/report-pr.js
    .github/ai-bot/src/github.js
    .github/ai-bot/src/main.js
    .github/ai-bot/src/providers.js
    .github/ai-bot/src/broker.js
    .github/ai-bot/src/cli.js
    .github/ai-bot/src/fix-core.js
    .github/ai-bot/src/fix.js
    .github/ai-bot/src/verify-container.js
    .github/workflows/investigate.yml
    .github/workflows/fix.yml
    .github/workflows/proposal-updates.yml
    .github/workflows/auto-merge.yml
  )
  while (($#)); do
    case "$1" in
      --directory) (($# >= 2)) || fail '--directory requires a path'; destination=$2; shift 2 ;;
      --ref) (($# >= 2)) || fail '--ref requires a commit SHA'; commit=$2; shift 2 ;;
      -h|--help) usage; return ;;
      *) fail "Unknown argument: $1" ;;
    esac
  done
  command -v git >/dev/null 2>&1 || fail 'git is required'
  command -v curl >/dev/null 2>&1 || fail 'curl is required'
  destination=${destination:-.}
  root=$(git -C "$destination" rev-parse --show-toplevel 2>/dev/null) || fail 'Run inside a Git working tree, or specify --directory PATH'
  root=$(cd "$root" && pwd -P)
  # Reject symlinked installation directories, including dangling symlinks.
  for relative in .github .github/ai-bot .github/ai-bot/src .github/workflows; do
    [[ ! -L "$root/$relative" ]] || fail "Symlinked destination: $relative"
    if [[ -e "$root/$relative" && ! -d "$root/$relative" ]]; then fail "Not a directory: $relative"; fi
  done
  if [[ -z "$commit" ]]; then
    remote_ref=$(git ls-remote --exit-code https://github.com/hrmcngs/github-ai-fix-bot.git refs/heads/main) || fail 'Could not resolve the source commit'
    commit=${remote_ref%%[[:space:]]*}
  fi
  [[ "$commit" =~ ^[0-9a-f]{40}$ ]] || fail '--ref must be a full lowercase 40-character commit SHA'
  staging=$(mktemp -d "${TMPDIR:-/tmp}/github-ai-fix-bot-install.XXXXXXXX")
  # The script runs in a subshell, so this trap cannot affect its caller.
  trap 'rm -rf -- "$staging"' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  printf 'Downloading github-ai-fix-bot at %s...\n' "$commit"
  for relative in "${files[@]}"; do
    mkdir -p "$staging/$(dirname "$relative")"
    curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
      --connect-timeout 10 --max-time 60 --retry 2 \
      "https://raw.githubusercontent.com/hrmcngs/github-ai-fix-bot/$commit/$relative" \
      --output "$staging/$relative" || fail "Download failed: $relative (source files must be pushed first)"
    [[ -s "$staging/$relative" ]] || fail "Empty download: $relative"
  done
  # Check every destination before creating or copying any project files.
  for relative in "${files[@]}"; do
    [[ ! -L "$root/$relative" ]] || fail "Symlinked destination: $relative"
    if [[ -e "$root/$relative" ]]; then
      [[ -f "$root/$relative" ]] || fail "Not a regular file: $relative"
      [[ "$relative" == '.github/ai-bot/config.json' ]] && continue
      cmp -s "$staging/$relative" "$root/$relative" || fail "Existing file differs: $relative. Move it aside after reviewing before reinstalling."
    fi
  done
  for relative in "${files[@]}"; do
    if [[ -f "$root/$relative" ]]; then
      printf 'Kept: %s\n' "$relative"
      continue
    fi
    parent="$root/$(dirname "$relative")"
    mkdir -p "$parent"
    cp -n "$staging/$relative" "$root/$relative"
    cmp -s "$staging/$relative" "$root/$relative" || fail "Could not install: $relative"
    printf 'Installed: %s\n' "$relative"
  done
  printf '\nInstalled in: %s\nSource commit: %s\n' "$root" "$commit"
  cat <<'NEXT'

Next steps:
  1. Review .github/ai-bot/config.json and select your AI and source paths.
  2. Review the diff and merge the files into your default branch via a PR.
  3. Register TOKYO_AI_API_KEY, ANTHROPIC_API_KEY or OPENAI_API_KEY in Actions Secrets.
     Never paste API keys into Issues, comments or workflow inputs.
  4. Actions > AI investigation > Run workflow.

Docs: https://github.com/hrmcngs/github-ai-fix-bot#readme
NEXT
}
# Run only after the entire installer has been read successfully from the pipe.
(main "$@")
