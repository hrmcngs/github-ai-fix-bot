# 本体のpushから更新PRを届ける

**Bot本体のmainへpush → GitHub Appの導入先を検出 → 各導入先に更新PRを自動作成**します。定期実行や導入先でのRun workflowを待ちません。AI API・外部サーバーは不要です。GitHub Actionsの開始待ちやAPIの障害による遅延はあり得ます。

## 最初の設定（本体の管理者が1回）

1. [GitHub App作成画面](https://github.com/settings/apps/new)を開きます。
   - App名：自分で識別できる一意の名前。
   - Homepage URL：`https://github.com/hrmcngs/github-ai-fix-bot`
   - WebhookのActive：オフ。Webhookサーバーは使いません。
   - Repository permissions：**Contents / Pull requests / Workflows → Read and write**。Metadataは自動付与のreadです。アカウント権限やイベント購読は不要です。
   - 別アカウントでも導入する場合は、インストール先をAny accountにします。
2. Appを作成し、App IDを控えます。Private keysのGenerate a private keyで`.pem`を取得します。
3. **Bot本体のリポジトリ**の[Variables](https://github.com/hrmcngs/github-ai-fix-bot/settings/variables/actions)へ`AI_BOT_APP_ID`、[Secrets](https://github.com/hrmcngs/github-ai-fix-bot/settings/secrets/actions)へ`AI_BOT_APP_PRIVATE_KEY`を登録します。IDはVariable、`.pem`の中身はSecretです。
4. AppのInstall Appから、更新を届けたいリポジトリを選んでインストールします。必要な導入先だけを選択してください。
5. 次にBot本体のmainへ配布対象の変更をpushすると、**Deliver Bot updates**が更新PRを作成します。人間がレビュー・マージすると導入先が更新されます。

CLIから登録する場合も、秘密鍵はファイルから直接Secretへ渡します。

```sh
gh variable set AI_BOT_APP_ID --repo hrmcngs/github-ai-fix-bot --body "123456"
gh secret set AI_BOT_APP_PRIVATE_KEY --repo hrmcngs/github-ai-fix-bot < "/path/to/app.private-key.pem"
```

秘密鍵をIssue、コメント、PR、通常のActions入力欄、このチャットへ貼らないでください。秘密鍵は本体側だけが保持し、各導入先へのSecret登録は不要です。App IDが未設定なら配信ジョブはスキップします。IDだけ設定し秘密鍵が不足している場合は、設定方法をエラーに表示します。

## 導入先の準備

Botを導入し、`.github/ai-bot/installation.json`をデフォルトブランチへ取り込んでおきます。Appだけをインストールし、Botがまだないリポジトリは変更しません。

配信処理は本体側で実行するため、古い導入先でも導入記録があれば利用できます。導入先の更新Actionを手動で起動する必要はありません。AppがPRを作るため、導入先へ`AI_BOT_UPDATE_TOKEN`を登録する必要もありません。

管理対象ファイルに導入記録と異なる独自変更がある場合は停止します。必要なら`install.sh --upgrade`でバックアップ・差分を確認して導入記録を整えてから、次の本体更新を受け取ってください。設定の有効化やprivateのAI送信許可は、自動で変更しません。

## 配信範囲

既定は`full`で、配布一覧にあるBot本体とActions定義をPRにします。`config.json`とAPIキーは保持します。本体リポジトリのREADMEやテスト等は配布対象ではありません。

本体側のRepository Variable `AI_BOT_DELIVERY_SCOPE=runtime`を指定すると、Bot本体だけに限定できます。この場合、AppのContentsとPull requestsのRead and writeがあれば動作し、Workflows権限は不要です。Appから発行する一時トークンも選択範囲に合わせます。

| 方式 | 実行元 | 起動条件 | Actions定義 |
| --- | --- | --- | --- |
| App配信（full） | Bot本体 | 本体mainの配布対象へのpush | 更新PRに含む |
| App配信（runtime） | Bot本体 | 本体mainの配布対象へのpush | 保持 |
| 従来の定期確認 | 各導入先 | GitHubのschedule | 既定では保持 |

本体側のApp権限を変更する場合は、必要に応じて各インストール先で更新の承認を行ってください。Appの権限でworkflowファイルを扱えることは[GitHubの参照作成API仕様](https://docs.github.com/en/rest/git/refs#create-a-reference)に基づきます。

## 重複・失敗時

- 同じ版・範囲のPRが開いている場合は再利用します。閉じた版を自動で作り直しません。
- Appのfull配信PRは従来のruntime定期確認でも認識できる識別子を付け、同じ版のPRが二重に作られにくいようにします。
- 複数のpushが続いた場合、古いpushの配信は打ち切り、後続の新しいpushの処理へ任せます。異なる版のPRが複数できる場合は、マージ対象の版を確認してください。
- 導入先でのPR作成失敗は他の導入先の処理を妨げず、配信結果に失敗件数を残します。認証・インストール一覧の取得自体に失敗した場合は配信前に停止します。
- 対象数は最大1000リポジトリ、一覧取得も上限付きです。上限や不完全な一覧は正常完了と扱いません。
- 本体のActions Summaryは件数と安全なエラー分類だけを出し、導入先の名前やURL、トークン、APIの生のエラー本文を出しません。PRは各導入先のPull requestsで確認します。
- GitHub Appを導入対象から外すと、そのリポジトリへのApp配信を停止できます。従来の定期確認を使っている場合は別に無効化してください。

## 安全性

配信は固定の本体リポジトリのデフォルトブランチへのpushだけが起動します。PR・コメント・手動dispatchでは起動しません。Appが導入されたリポジトリだけを選び、書込み用トークンは1リポジトリに限定して発行し、利用後に失効させます。

配布一覧、導入記録、通常ファイル、元のGit blobハッシュを照合し、更新前に本体と導入先のブランチを再確認します。上流コードや導入先のスクリプトは実行しません。デフォルトブランチへの直接コミットや自動マージは行いません。

秘密鍵を持つ本体の管理者と、そのデフォルトブランチは信頼境界です。App権限のある導入先へ更新PRを提案できるため、本体のブランチ保護とレビューを運用してください。

## 配送テスト

本体の**Bot test update**でコメント1行のテスト更新PRを作り、人間がマージすると、そのpushを受けて配信します。App設定後は導入先の更新Actionを手動起動せずに確認できます。設定の登録だけではpushイベントは発生しません。
