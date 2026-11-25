# github-ai-fix-bot

Issue・DependabotアラートをAIで調査し、結果のコメントや修正PRを作るGitHub Botです。各リポジトリで自分のAIキーを使います。

## 導入

対象リポジトリ内で実行します。

```sh
curl -fsSL https://raw.githubusercontent.com/hrmcngs/github-ai-fix-bot/main/install.sh | bash
```

1. `.github/ai-bot/config.json` でAI・対象パス・修正時のテストコマンドを設定します。
2. **Settings → Secrets and variables → Actions** に、使うAIのSecretを登録します。
3. **Settings → Actions → General** の **Allow GitHub Actions to create and approve pull requests** を有効にします。
4. 配置されたBotファイルとワークフローを確認し、PRでデフォルトブランチに取り込みます。

| AI（`provider`） | Secret名 |
| --- | --- |
| 東京都AI（`tokyo`） | `TOKYO_AI_API_KEY` |
| Claude Code（`claude`） | `ANTHROPIC_API_KEY` |
| OpenAI Codex（`codex`） | `OPENAI_API_KEY` |

privateリポジトリでは、AIへの送信を許可したうえでActionsのRepository Variable **`AI_BOT_ALLOW_PRIVATE=true`** を追加します。Issue本文と許可したソースの一部をAIに送信します。

## 使い方

write権限以上の利用者がIssueへ新しいコメントを投稿します。

| コメント | 動作 |
| --- | --- |
| `/ai-investigate` | 調査結果をコメント |
| `/ai-report-pr` | 調査結果をMarkdownのPRにし、Issueへリンクを返信 |
| `/ai-fix` | コード修正を検証し、成功時にPRを作成してリンクを返信 |

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
