#!/usr/bin/env bash
# Install into the current Git repository. Safe to invoke through curl | bash.
set -euo pipefail

usage() {
  cat <<'HELP'
Usage: bash install.sh [--directory PATH] [--ref COMMIT_SHA] [--upgrade] [--skip-security-updates]

Installs .github/ai-bot/ and the investigation/fix workflows.
Default destination: root of the current Git repository.
Default source: hrmcngs/github-ai-fix-bot main, resolved once to a commit.
Existing config.json is always preserved. Differing files stop installation by default.
--upgrade backs up replaced Bot files inside Git metadata, then installs the selected version.
Enables Dependabot alerts/security update PRs using an authenticated GitHub CLI admin session.
--skip-security-updates leaves repository security settings unchanged.
No keys are requested, and no commits, pushes or Actions runs are performed.
HELP
}
fail() { printf 'Error: %s\n' "$*" >&2; exit 1; }

enable_security_updates() {
  local root=$1 origin='' repo=''
  origin=$(git -C "$root" remote get-url origin 2>/dev/null) || origin=''
  case "$origin" in
    https://github.com/*) repo=${origin#https://github.com/} ;;
    git@github.com:*) repo=${origin#git@github.com:} ;;
    ssh://git@github.com/*) repo=${origin#ssh://git@github.com/} ;;
  esac
  repo=${repo%.git}
  if [[ ! "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
    printf '\nDependabot: not configured (origin must identify a github.com repository).\n'
    return
  fi
  if command -v gh >/dev/null 2>&1 &&
    [[ $(gh api --hostname github.com "repos/$repo" --jq '.permissions.admin' 2>/dev/null) == true ]] &&
    gh api --hostname github.com --method PUT "repos/$repo/vulnerability-alerts" >/dev/null 2>&1 &&
    gh api --hostname github.com --method PUT "repos/$repo/automated-security-fixes" >/dev/null 2>&1; then
    printf '\nDependabot security update PRs enabled for %s.\n' "$repo"
    printf 'GitHub opens PRs when a supported vulnerable dependency has an available fix; review CI before merging.\n'
  else
    printf '\nDependabot setup incomplete: GitHub CLI login and repository admin access are required.\n'
    printf 'Enable Dependency graph, Dependabot alerts and Dependabot security updates here:\n'
    printf 'https://github.com/%s/settings/security_analysis\n' "$repo"
    printf 'Bot files were installed successfully; no auto-merge was enabled.\n'
  fi
}

main() {
  local destination='' commit='' remote_ref='' root='' relative='' parent='' upgrade=false security_updates=true backup='' git_dir='' pending='' replace_count=0
  local -a replaced=()
  local -a files=(
    .github/ai-bot/.dockerignore
    .github/ai-bot/Dockerfile
    .github/ai-bot/Dockerfile.verify
    .github/ai-bot/package.json
    .github/ai-bot/config.json
    .github/ai-bot/distribution.json
    .github/ai-bot/src/bulk.js
    .github/ai-bot/src/updates.js
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
    .github/workflows/fix-one.yml
    .github/workflows/investigate-one.yml
    .github/workflows/bot-updates.yml
    .github/workflows/proposal-updates.yml
    .github/workflows/auto-merge.yml
  )
  while (($#)); do
    case "$1" in
      --upgrade) upgrade=true; shift ;;
      --skip-security-updates) security_updates=false; shift ;;
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
  trap '[[ -z ${pending:-} ]] || rm -f -- "$pending"; rm -rf -- "$staging"' EXIT
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
  [[ ! -L "$root/.github/ai-bot/installation.json" ]] || fail 'Symlinked installation record'
  if [[ -e "$root/.github/ai-bot/installation.json" && ! -f "$root/.github/ai-bot/installation.json" ]]; then fail 'Invalid installation record'; fi
  {
    printf '{"version":1,"source":"hrmcngs/github-ai-fix-bot","commit":"%s","files":{' "$commit"
    local separator='' hash=''
    for relative in "${files[@]}"; do
      [[ "$relative" == '.github/ai-bot/config.json' ]] && continue
      hash=$(git hash-object --no-filters "$staging/$relative") || fail 'Could not hash source file'
      [[ "$hash" =~ ^[0-9a-f]{40}$ ]] || fail 'Installation requires Git SHA-1 object hashes'
      printf '%s"%s":"%s"' "$separator" "$relative" "$hash"
      separator=','
    done
    printf '}}\n'
  } > "$staging/installation.json"
  # Check every destination before creating or copying any project files.
  for relative in "${files[@]}"; do
    [[ ! -L "$root/$relative" ]] || fail "Symlinked destination: $relative"
    if [[ -e "$root/$relative" ]]; then
      [[ -f "$root/$relative" ]] || fail "Not a regular file: $relative"
      [[ "$relative" == '.github/ai-bot/config.json' ]] && continue
      if ! cmp -s "$staging/$relative" "$root/$relative"; then
        [[ "$upgrade" == true ]] || fail "Existing file differs: $relative. Re-run with --upgrade to back up and replace Bot files; config.json is preserved."
        replaced+=("$relative");replace_count=$((replace_count+1))
      fi
    fi
  done
  if [[ "$upgrade" == true ]]; then
    if [[ -f "$root/.github/ai-bot/installation.json" ]]; then replaced+=(.github/ai-bot/installation.json);replace_count=$((replace_count+1)); fi
    if ((replace_count>0)); then
      git_dir=$(git -C "$root" rev-parse --absolute-git-dir) || fail 'Could not locate Git metadata for the backup'
      [[ "$git_dir" == /* && -d "$git_dir" && ! -L "$git_dir" ]] || fail 'Invalid Git metadata directory'
      [[ ! -L "$git_dir/ai-bot-backups" ]] || fail 'Symlinked backup directory'
      if [[ -e "$git_dir/ai-bot-backups" && ! -d "$git_dir/ai-bot-backups" ]]; then fail 'Invalid backup directory'; fi
      mkdir -p "$git_dir/ai-bot-backups"
      backup=$(mktemp -d "$git_dir/ai-bot-backups/upgrade.XXXXXXXX")
      # Finish every backup before replacing any project file. Git metadata is never committed.
      for relative in "${replaced[@]}"; do
        mkdir -p "$backup/$(dirname "$relative")"
        cp -p "$root/$relative" "$backup/$relative" || fail "Could not back up: $relative"
        cmp -s "$root/$relative" "$backup/$relative" || fail "Backup verification failed: $relative"
      done
      printf 'Backup: %s\n' "$backup"
    fi
  fi
  for relative in "${files[@]}"; do
    if [[ -f "$root/$relative" ]]; then
      if [[ "$relative" == '.github/ai-bot/config.json' ]] || cmp -s "$staging/$relative" "$root/$relative"; then
        printf 'Kept: %s\n' "$relative"
        continue
      fi
      # Replace atomically instead of truncating an existing inode or following a leaf link.
      parent="$root/$(dirname "$relative")"
      pending=$(mktemp "$parent/.ai-bot-upgrade.XXXXXXXX")
      cp "$staging/$relative" "$pending" && chmod 644 "$pending" && mv -f "$pending" "$root/$relative" || fail "Could not upgrade: $relative. Backup: $backup"
      pending=''
      printf 'Updated: %s\n' "$relative"
      continue
    fi
    parent="$root/$(dirname "$relative")"
    mkdir -p "$parent"
    cp -n "$staging/$relative" "$root/$relative"
    cmp -s "$staging/$relative" "$root/$relative" || fail "Could not install: $relative"
    printf 'Installed: %s\n' "$relative"
  done
  if [[ "$upgrade" == true || ! -e "$root/.github/ai-bot/installation.json" ]]; then
    pending=$(mktemp "$root/.github/ai-bot/.installation.XXXXXXXX")
    cp "$staging/installation.json" "$pending" && chmod 644 "$pending" && mv -f "$pending" "$root/.github/ai-bot/installation.json" || fail "Could not write installation record. Backup: $backup"
    pending=''
  fi
  if [[ "$security_updates" == true ]]; then enable_security_updates "$root"; fi
  printf '\nInstalled in: %s\nSource commit: %s\n' "$root" "$commit"
  cat <<'NEXT'

Next steps:
  1. Review .github/ai-bot/config.json and select your AI and source paths.
  2. Review the diff and merge the files into your default branch via a PR.
  3. Register TOKYO_AI_API_KEY, ANTHROPIC_API_KEY or OPENAI_API_KEY in Actions Secrets.
     Never paste API keys into Issues, comments or workflow inputs.
  4. Actions > AI investigation or AI fix > Run workflow (blank number processes all).
  5. Bot update notices checks for updates daily and opens an update PR automatically.
     Optional update PRs require AI_BOT_UPDATE_TOKEN with Contents, Pull requests and Workflows write.

Docs: https://github.com/hrmcngs/github-ai-fix-bot#readme
NEXT
}
# Run only after the entire installer has been read successfully from the pipe.
(main "$@")
