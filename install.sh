#!/usr/bin/env bash
# Install into the current Git repository. Safe to invoke through curl | bash.
set -euo pipefail

usage() {
  cat <<'HELP'
Usage: bash install.sh [--directory PATH] [--ref COMMIT_SHA] [--upgrade] [--skip-security-updates] [--setup]
       bash install.sh --uninstall [--directory PATH]

Installs .github/ai-bot/ and the investigation/fix workflows.
Default destination: root of the current Git repository.
Default source: hrmcngs/github-ai-fix-bot main, resolved once to a commit.
Existing config.json is preserved unless --setup explicitly configures it. Differing Bot files stop installation by default.
--upgrade backs up replaced Bot files inside Git metadata, then installs the selected version.
--uninstall backs up and removes recorded Bot files and config locally (requires Node.js).
Secrets, labels, reports, PRs and Dependabot settings are kept. Review and commit the deletions.
Enables Dependabot alerts/security update PRs using an authenticated GitHub CLI admin session.
--skip-security-updates leaves repository security settings unchanged.
--setup opens a Japanese guided setup (requires Node.js 22+, gh and a terminal).
No keys are requested, and no commits, pushes or Actions runs are performed.
HELP
}
fail() { printf 'Error: %s\n' "$*" >&2; exit 1; }

uninstall_bot() {
  local root=$1 git_dir=''
  shift
  command -v node >/dev/null 2>&1 || fail 'アンインストールにはNode.jsが必要です。'
  git_dir=$(git -C "$root" rev-parse --absolute-git-dir) || fail 'Could not locate Git metadata'
  node - "$root" "$git_dir" "$@" <<'NODE'
const fs=require('node:fs'),path=require('node:path');
const [root,gitDir,...allowed]=process.argv.slice(2);
const statePath='.github/ai-bot/installation.json',configPath='.github/ai-bot/config.json';
const exists=p=>{try{return fs.lstatSync(p);}catch(e){if(e.code==='ENOENT')return null;throw e;}};
function directories(base,relative){
  let current=base;
  for(const part of relative.split('/').slice(0,-1)){
    current=path.join(current,part);const stat=exists(current);
    if(stat&&(!stat.isDirectory()||stat.isSymbolicLink()))throw new Error('Unsafe directory: '+relative);
  }
}
try{
  directories(root,statePath);
  const stateFile=exists(path.join(root,statePath));
  if(!stateFile){console.log('Botの導入記録がありません。ファイルは削除していません。');process.exit(0);}
  if(!stateFile.isFile()||stateFile.isSymbolicLink())throw new Error('Invalid installation record');
  if(stateFile.size>64000)throw new Error('Invalid installation record');
  const state=JSON.parse(fs.readFileSync(path.join(root,statePath),'utf8'));
  if(state.version!==1||state.source!=='hrmcngs/github-ai-fix-bot'||!state.files||typeof state.files!=='object'||Array.isArray(state.files)||Object.keys(state.files).length>60
    ||Object.entries(state.files).some(([p,h])=>!allowed.includes(p)||typeof h!=='string'||!/^[a-f0-9]{40}$/.test(h)))throw new Error('Invalid installation record; no files removed');
  const files=[...new Set([...Object.keys(state.files),configPath,statePath])].filter(relative=>{
    directories(root,relative);const stat=exists(path.join(root,relative));
    if(stat&&(!stat.isFile()||stat.isSymbolicLink()))throw new Error('Unsafe file: '+relative);
    return !!stat;
  });
  if(!path.isAbsolute(gitDir)||!fs.lstatSync(gitDir).isDirectory()||fs.lstatSync(gitDir).isSymbolicLink())throw new Error('Invalid Git metadata');
  const backups=path.join(gitDir,'ai-bot-backups'),existing=exists(backups);
  if(existing&&(!existing.isDirectory()||existing.isSymbolicLink()))throw new Error('Unsafe backup directory');
  fs.mkdirSync(backups,{recursive:true,mode:0o700});
  const backup=fs.mkdtempSync(path.join(backups,'uninstall.'));fs.chmodSync(backup,0o700);
  // Complete and verify every backup before deleting anything. No shell or repository code runs.
  for(const relative of files){
    const target=path.join(backup,relative);fs.mkdirSync(path.dirname(target),{recursive:true,mode:0o700});
    fs.copyFileSync(path.join(root,relative),target,fs.constants.COPYFILE_EXCL);fs.chmodSync(target,0o600);
    if(!fs.readFileSync(target).equals(fs.readFileSync(path.join(root,relative))))throw new Error('Backup verification failed');
  }
  console.log('Backup: '+backup);
  for(const relative of files){fs.unlinkSync(path.join(root,relative));console.log('Removed: '+relative);}
  for(const relative of ['.github/ai-bot/src','.github/ai-bot','.github/workflows','.github']){
    try{fs.rmdirSync(path.join(root,relative));}catch(e){if(!['ENOENT','ENOTEMPTY','EEXIST'].includes(e.code))throw e;}
  }
  console.log('Botファイルを削除しました。git diffで確認し、削除をコミットしてください。');
  console.log('Secrets・ラベル・調査レポート・PR・Dependabot設定は残しています。');
}catch(error){console.error('Error: '+error.message);process.exitCode=1;}
NODE
}

ensure_bot_labels() {
  local root=$1 origin='' repo='' label='' names='ai-fix ai-investigate ai-auto-merge'
  command -v gh >/dev/null 2>&1 || return 0
  origin=$(git -C "$root" remote get-url origin 2>/dev/null) || return 0
  case "$origin" in
    https://github.com/*) repo=${origin#https://github.com/} ;;
    git@github.com:*) repo=${origin#git@github.com:} ;;
    ssh://git@github.com/*) repo=${origin#ssh://git@github.com/} ;;
    *) return 0 ;;
  esac
  repo=${repo%.git}
  [[ "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || return 0
  if command -v node >/dev/null 2>&1; then
    names=$(node -e 'const fs=require("node:fs"),c=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));const names=[c.fix?.label||"ai-fix",c.issueLabel||"ai-investigate",c.autoMerge?.label||"ai-auto-merge"];if(names.some(n=>typeof n!=="string"||!/^[\w-]{1,50}$/.test(n)))process.exit(1);console.log([...new Set(names)].join(" "))' "$root/.github/ai-bot/config.json" 2>/dev/null) || names='ai-fix ai-investigate ai-auto-merge'
  fi
  for label in $names; do
    if ! gh api --hostname github.com "repos/$repo/labels/$label" >/dev/null 2>&1; then
      gh api --hostname github.com --method POST "repos/$repo/labels" -f "name=$label" -f color=2da44e >/dev/null 2>&1 || printf 'Could not create label: %s\n' "$label"
    fi
  done
}

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

setup_prompt() {
  printf '%s' "$1" >/dev/tty
  IFS= read -r REPLY </dev/tty || return 1
}
setup_secret() {
  set +x
  local repo=$1 name=$2 value=''
  printf '%s（空欄なら変更しません。入力は非表示）: ' "$name" >/dev/tty
  IFS= read -r -s value </dev/tty || return 1
  printf '\n' >/dev/tty
  if [[ -n "$value" ]]; then
    if ! printf '%s' "$value" | gh secret set "$name" --repo "$repo" >/dev/null 2>&1; then
      unset value
      printf 'Secretを登録できませんでした。GitHubの設定画面から登録してください。\n'
      return 1
    fi
    unset value
    printf '%s を登録しました。\n' "$name"
  fi
}
guided_setup() {
  local root=$1 repo='' provider='' mode='' secret='' visibility='' defaults='' secret_names='' full_updates=false auto_review=false audit=false
  repo=$(cd "$root" && gh repo view --json nameWithOwner --jq .nameWithOwner 2>/dev/null) || fail 'gh auth login を実行してから --setup を再実行してください。'
  [[ "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || fail '導入先を確認できませんでした。'
  printf '\nかんたん設定：%s\n' "$repo"
  setup_prompt 'このリポジトリに設定しますか？ [y/N]: ' || return 1
  [[ "$REPLY" == y || "$REPLY" == Y ]] || { printf '設定を中止しました。\n'; return 1; }
  while :; do
    setup_prompt '使うAI：1) 東京都AI  2) Claude  3) Codex  4) 登録済みAIを全部使う [1]: ' || return 1
    case "$REPLY" in ''|1) provider=tokyo;secret=TOKYO_AI_API_KEY;break ;; 2) provider=claude;secret=ANTHROPIC_API_KEY;break ;; 3) provider=codex;secret=OPENAI_API_KEY;break ;; 4) provider=all;secret=TOKYO_AI_API_KEY;break ;; esac
  done
  while :; do
    setup_prompt '調査の開始方法：1) コメント・手動のみ  2) ラベル・定期調査も有効 [1]: ' || return 1
    case "$REPLY" in ''|1) mode=manual;break ;; 2) mode=automatic;break ;; esac
  done
  setup_prompt 'PR作成・更新時にスキルの観点で自動レビューしますか？（AI利用枠を消費・提案コメントのみ）[y/N]: ' || return 1
  if [[ "$REPLY" == y || "$REPLY" == Y ]]; then auto_review=true; fi
  setup_prompt 'ソース更新時と毎日の自動セキュリティ監査PRを有効にしますか？（AI利用枠を消費・要レビュー）[y/N]: ' || return 1
  if [[ "$REPLY" == y || "$REPLY" == Y ]]; then audit=true; fi
  node "$root/.github/ai-bot/src/configure.js" "$root" "$provider" "$mode" "$auto_review" "$audit" || return 1
  setup_secret "$repo" "$secret" || true
  if [[ "$provider" == all ]]; then
    setup_secret "$repo" ANTHROPIC_API_KEY || true
    setup_secret "$repo" OPENAI_API_KEY || true
    printf '登録済みAIの回答を統合担当AIへ送信します。最大4回のAPI利用が発生します。\n'
  fi
  visibility=$(gh api --hostname github.com "repos/$repo" --jq .private 2>/dev/null) || visibility='unknown'
  if [[ "$visibility" == true ]]; then
    setup_prompt 'privateのIssueと許可したソースの一部を選んだAIへ送信してよいですか？ [y/N]: ' || return 1
    if [[ "$REPLY" == y || "$REPLY" == Y ]]; then
      gh variable set AI_BOT_ALLOW_PRIVATE --repo "$repo" --body true >/dev/null 2>&1 || printf 'private送信の許可を登録できませんでした。\n'
    else
      gh variable set AI_BOT_ALLOW_PRIVATE --repo "$repo" --body false >/dev/null 2>&1 || printf 'private送信の無効化を登録できませんでした。既存設定を確認してください。\n'
    fi
  fi
  setup_prompt 'ActionsによるPR作成を許可しますか？（GitHubではレビュー承認許可と共通の設定です）[y/N]: ' || return 1
  if [[ "$REPLY" == y || "$REPLY" == Y ]]; then
    defaults=$(gh api --hostname github.com "repos/$repo/actions/permissions/workflow" --jq .default_workflow_permissions 2>/dev/null) || defaults=''
    if [[ "$defaults" == read || "$defaults" == write ]]; then
      gh api --hostname github.com --method PUT "repos/$repo/actions/permissions/workflow" -f "default_workflow_permissions=$defaults" -F can_approve_pull_request_reviews=true >/dev/null 2>&1 || printf 'PR作成許可を変更できませんでした。リポジトリ管理者に確認してください。\n'
    else
      printf 'PR作成許可を取得できませんでした。設定画面で確認してください。\n'
    fi
  fi
  printf '\nBot本体の更新PRは追加トークンなしで受け取れます。Actions定義は手動更新です。\n'
  setup_prompt 'Actions定義も自動更新するためのトークンを登録しますか？ [y/N]: ' || return 1
  if [[ "$REPLY" == y || "$REPLY" == Y ]]; then
    full_updates=true
    printf '導入先限定のfine-grained PATに Contents / Pull requests / Workflows の Read and write が必要です。\n'
    printf '発行画面：https://github.com/settings/personal-access-tokens/new\n'
    setup_secret "$repo" AI_BOT_UPDATE_TOKEN || true
    printf '全体更新は Bot update notices の scope=full から実行します。5分ごとの自動更新は本体のみです。\n'
  fi
  secret_names=$(gh secret list --repo "$repo" --json name --jq '.[].name' 2>/dev/null) || secret_names=''
  if ! printf '%s\n' "$secret_names" | grep -Fxq "$secret"; then
    printf '未完了：%s の登録を確認できません。試運転前にSecrets画面で登録してください。\n' "$secret"
  fi
  if [[ "$full_updates" == true ]] && ! printf '%s\n' "$secret_names" | grep -Fxq AI_BOT_UPDATE_TOKEN; then
    printf 'Bot更新PR：トークンを確認できません。必要な場合は後から登録できます。\n'
  fi
  printf '\n設定ファイル：%s/.github/ai-bot/config.json\n' "$root"
  printf '残り：git diffを確認し、BotファイルをPRでデフォルトブランチへ取り込んでください。\n'
  printf '取り込み後、Issueに /ai-investigate とコメントすると試せます。\n'
  printf 'Secrets確認：https://github.com/%s/settings/secrets/actions\n' "$repo"
}

main() {
  local destination='' commit='' remote_ref='' root='' relative='' parent='' upgrade=false setup=false uninstall=false security_updates=true backup='' git_dir='' pending='' replace_count=0
  local -a replaced=()
  local -a files=(
    .github/ai-bot/.dockerignore
    .github/ai-bot/Dockerfile
    .github/ai-bot/Dockerfile.verify
    .github/ai-bot/package.json
    .github/ai-bot/config.json
    .github/ai-bot/distribution.json
    .github/ai-bot/src/review.js
    .github/ai-bot/src/ai-selection.js
    .github/ai-bot/src/conflicts.js
    .github/ai-bot/src/configure.js
    .github/ai-bot/src/bulk.js
    .github/ai-bot/src/updates.js
    .github/ai-bot/src/guidance.js
    .github/ai-bot/src/security.js
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
    .github/workflows/review.yml
    .github/workflows/investigate.yml
    .github/workflows/fix.yml
    .github/workflows/fix-one.yml
    .github/workflows/investigate-one.yml
    .github/workflows/bot-updates.yml
    .github/workflows/proposal-updates.yml
    .github/workflows/auto-merge.yml
    .github/workflows/security-audit.yml
  )
  while (($#)); do
    case "$1" in
      --upgrade) upgrade=true; shift ;;
      --uninstall) uninstall=true; shift ;;
      --setup) setup=true; shift ;;
      --skip-security-updates) security_updates=false; shift ;;
      --directory) (($# >= 2)) || fail '--directory requires a path'; destination=$2; shift 2 ;;
      --ref) (($# >= 2)) || fail '--ref requires a commit SHA'; commit=$2; shift 2 ;;
      -h|--help) usage; return ;;
      *) fail "Unknown argument: $1" ;;
    esac
  done
  command -v git >/dev/null 2>&1 || fail 'git is required'
  if [[ "$uninstall" == true ]]; then
    [[ "$upgrade" == false && "$setup" == false && -z "$commit" ]] || fail '--uninstall cannot be combined with --upgrade, --setup or --ref'
    root=$(git -C "${destination:-.}" rev-parse --show-toplevel 2>/dev/null) || fail 'Run inside a Git working tree, or specify --directory PATH'
    root=$(cd "$root" && pwd -P)
    uninstall_bot "$root" "${files[@]}"
    return
  fi
  command -v curl >/dev/null 2>&1 || fail 'curl is required'
  if [[ "$setup" == true ]]; then
    command -v gh >/dev/null 2>&1 || fail 'GitHub CLIが必要です。ghをインストールし、gh auth login を実行してください。'
    command -v node >/dev/null 2>&1 || fail 'かんたん設定にはNode.js 22以上が必要です。'
    [[ $(node -p 'Number(process.versions.node.split(".")[0]) >= 22') == true ]] || fail 'Node.js 22以上が必要です。'
    ( : </dev/tty ) 2>/dev/null || fail '--setup はターミナルから実行してください。'
  fi
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
  if [[ "$setup" == true ]]; then guided_setup "$root" || fail '設定が完了しませんでした。保存済みの設定はgit diffとSecretsで確認してください。'; fi
  ensure_bot_labels "$root"
  if [[ "$security_updates" == true ]]; then enable_security_updates "$root"; fi
  printf '\nInstalled in: %s\nSource commit: %s\n' "$root" "$commit"
  cat <<'NEXT'

Next steps:
  1. Review .github/ai-bot/config.json and select your AI and source paths.
  2. Review the diff and merge the files into your default branch via a PR.
  3. Register TOKYO_AI_API_KEY, ANTHROPIC_API_KEY or OPENAI_API_KEY in Actions Secrets.
     Never paste API keys into Issues, comments or workflow inputs.
  4. Actions > AI investigation or AI fix > Run workflow (blank number processes all).
  5. Bot update notices checks for updates every five minutes and opens an update PR automatically.
     Runtime update PRs use GITHUB_TOKEN; workflow definitions must be updated manually.
     AI investigation also checks runtime updates by default when run manually.
     Optional full updates require AI_BOT_UPDATE_TOKEN and scope=full.

Docs: https://github.com/hrmcngs/github-ai-fix-bot#readme
NEXT
}
# Run only after the entire installer has been read successfully from the pipe.
(main "$@")
