# github-ai-fix-bot

Issue・DependabotアラートをAIで調査し、結果のコメントや修正PRを作るGitHub Botです。各リポジトリで自分のAIキーを使います。

## 導入

対象リポジトリ内で実行し、表示される日本語の質問に答えてください（git・curl・bash・Node.js 22以上・GitHub CLIが必要）。

```sh
gh auth login
curl -fsSL https://raw.githubusercontent.com/hrmcngs/github-ai-fix-bot/main/install.sh | bash -s -- --setup
```

AI選択・キーのSecret登録・開始方法・private送信許可・PR作成許可・更新トークンの登録を順に設定します。キーは非表示で入力し、Secretsへ直接登録します。既存設定も `--setup` では選択した内容に変更します。

最後に `git diff` を確認し、BotファイルをPRでデフォルトブランチへ取り込めば完了です。設定時にプロジェクトのコードやテストは実行しません。`npm test` がない場合は調査のみ有効にします。

既に導入済みなら `--upgrade --setup` を指定します。手動設定・必要なSecret名は[詳細ガイド](docs/guide.md#aiを選ぶ)を参照してください。

## セキュリティ修正PR

導入時、`gh` がログイン済みで導入先の管理者権限があれば、Dependabot alertsとsecurity updatesを有効にします。以後、修正可能な脆弱性が見つかるとDependabotがPRを自動作成します。AIキーは不要です。CIと差分を確認してマージしてください。

設定できなかった場合は導入ログの設定画面を開き、Dependency graph・Dependabot alerts・Dependabot security updatesを有効にします。設定を変更したくない場合はインストール時に `--skip-security-updates` を指定します。

## 使い方

write権限以上の利用者がIssueへ新しいコメントを投稿します。

| コメント | 動作 |
| --- | --- |
| `/ai-investigate` | 調査結果をコメント |
| `/ai-report-pr` | 調査結果をMarkdownのPRにし、Issueへリンクを返信 |
| `/ai-fix` | コード修正を検証し、成功時にPRを作成してリンクを返信 |

PRに `/ai-fix` とコメントすると、競合の統合案を作成・検証します。既存JavaScript・Markdownの変更3ファイルまでに対応します。同じリポジトリなら元PRへ追加、forkなら別PRで提案します。[対応範囲](docs/guide.md#prの競合修正とラベル作成)

必要なラベルは導入時に自動作成します（ログイン済みの `gh` と権限が必要）。自動マージの有効化は別の設定です。

`ai-fix` ラベルでも修正を開始できます（`fix.enabled: true` が必要）。調査ラベル・定期調査は `mode: automatic` で有効になります。

**全件実行：** Actionsの **AI investigation** または **AI fix → Run workflow** で、番号を空欄にします。Dependabotは調査のみ対応します。

Issue本文を更新すると古いBot PRを閉じます。再実行時に旧PRを参照したい場合は `--reference`、参照しない場合は `--no-reference` を `/ai-fix` または `/ai-report-pr` に付けます。

## Botの更新

手動で更新する場合：

```sh
curl -fsSL https://raw.githubusercontent.com/hrmcngs/github-ai-fix-bot/main/install.sh | bash -s -- --upgrade
```

設定を保持し、置き換えるBotファイルをバックアップします。差分を確認して取り込んでください。

**更新PRを自動で受け取る：** 導入先だけを対象にしたfine-grained PATを発行し、**Contents / Pull requests / Workflows: Read and write** を付け、Actions Secret **`AI_BOT_UPDATE_TOKEN`** に登録します。

毎日新版を確認し、更新があればPRを作ります。Issueやコメントは不要です。レビューしてマージするとBotが更新されます。[トークンの設定手順](docs/guide.md#初回の設定)

## 注意点

- APIキーはSecretsにだけ保存してください。東京都AIの一時キーは期限切れ時に更新し、新しい実行を開始します。
- コード修正は既存JavaScriptの限定的な変更が対象です。確信が低い場合や検証失敗時は修正PRを作りません。
- PRは人間がレビューします。自動マージには別途、専用ラベル・承認・保護ルールが必要です。
- 失敗理由はIssueへの返信またはActionsのSummaryで確認できます。

[詳細設定・権限・制約・トラブル対応](docs/guide.md)
