# github-ai-fix-bot

GitHub上でIssueやDependabotアラートを調査し、日本語の修正方針をコメントするBotです。各利用者が自分のpublicリポジトリへ導入し、自分のAI認証情報を使用します。管理画面や外部のBotサーバーは不要です。AIへの送信とCLIの取得には外部サービスを利用します。

**調査モード**では修正方針をコメントし、**修正モード**では既存JavaScriptの限定的な変更を検証してPRで提案します。依存更新、アラートの却下、デフォルトブランチへの直接コミット、自動マージは行いません。AIの回答を根拠に変更を確定せず、人間が調査結果とPRをレビューしてください。

## 導入

対象のGitリポジトリ内で次のコマンドを実行します（git・curl・bashが必要）。

```sh
curl -fsSL https://raw.githubusercontent.com/hrmcngs/github-ai-fix-bot/main/install.sh | bash
```

導入先を指定する場合:

```sh
curl -fsSL https://raw.githubusercontent.com/hrmcngs/github-ai-fix-bot/main/install.sh | bash -s -- --directory /path/to/your-repo
```

インストーラーはmainを1つのコミットSHAに解決してから必要なファイルをすべてダウンロードし、競合を確認して配置します。既存の `config.json` は保持し、それ以外のファイルが異なる場合は上書きせず停止します。同じ内容での再実行は可能です。更新時の競合は、既存ファイルをレビューして退避してから再実行してください。`--ref` に完全な40桁のコミットSHAを渡すと、取得元を固定できます。

APIキーの入力、依存パッケージのインストール、コミット・push・Actions起動は行いません。配置後に以下の設定を進めてください。公開URLは `install.sh` とBot本体をGitHubのmainへpushした後に利用できます。

1. インストーラーで配置した次のファイルを確認し、レビューしたPRで対象publicリポジトリのデフォルトブランチに取り込みます。手動コピーでの導入も可能です。
   - `.github/ai-bot/` ディレクトリ全体（隠しファイルの `.dockerignore` も含む）
   - `.github/workflows/investigate.yml` と `.github/workflows/fix.yml`
2. GitHub Actionsを有効にします。Dependabotを調査する場合は、対象リポジトリのdependency graphとDependabot alertsも有効にしてください。
3. `.github/ai-bot/config.json` の `provider`、モデル、調査対象パスを設定します。APIキーは設定ファイルへ書きません。
4. **Settings → Secrets and variables → Actions → New repository secret** で、選択したAIのSecretを登録します。
5. Actionsの **AI investigation → Run workflow** で、デフォルトブランチを選び、`target` と `number` を指定します。

既存プロジェクトの `package.json` や `src/` を置き換える必要はありません。Botのコードは `.github/ai-bot/` 内で完結し、外部のnpm依存はありません。Node.jsはワークフローが用意します。CLI実行にはGitHub-hosted Ubuntu runner上のDockerを使用します。self-hosted runner、Windowsは対象外です。privateリポジトリは初期状態では停止します。管理者がAIへの送信を許可する場合に限り、Settings → Secrets and variables → Actions → VariablesにRepository Variable `AI_BOT_ALLOW_PRIVATE` を値 `true` で登録してください。Issue本文と許可パス内のソースの一部が選択したAIへ送信されます。公開範囲は変更しません。

このリポジトリ自体で試す場合も、同じ手順でSecretの登録が必要です。利用者のキーを他人が管理する共通リポジトリに集約しないでください。forkではActionsや定期実行の有効化を確認してください。

## AIを選ぶ

| `provider` | 実行方式 | Repository Secret |
| --- | --- | --- |
| `tokyo` | 東京都の文字生成API | `TOKYO_AI_API_KEY` |
| `claude` | 公式Claude Code CLIの非対話モード | `ANTHROPIC_API_KEY` |
| `codex` | 公式Codex CLIの `exec` | `OPENAI_API_KEY` |

選択したAIのキーだけが実行ステップへ渡されます。別のAIへの自動フォールバックは行いません。Claude CodeとCodexは、それぞれのAPIキーによる認証です。Claude/ChatGPTアプリへのログインやサブスクリプションの認証を再利用する実装ではありません。API料金・利用枠・モデルへのアクセス権は各サービスで確認してください。

`models.claude`、`models.codex` で利用可能なモデルを指定します。初期設定は `sonnet`、`gpt-5.4` です。アカウントで利用できないモデルは変更してください。東京都APIのモデル選択は、提供された仕様にないため実装していません。

### 東京都API

- エンドポイントは `https://ai-api.metro.tokyo.lg.jp/api/v1/public/message` に固定。
- `Authorization: Bearer <キー>` とJSON `{ "input": "...", "conversation_id": "" }` を送信。
- 成功時は `message` を使用。実行をまたぐ会話履歴や `conversation_id` は保存しない。
- 1対象につき1リクエスト。タイムアウトは90秒。自動再試行なし。
- キーは1〜8時間の一時キーで、利用回数上限もある。発行・更新は利用者が行う。

Repository Secretはワークフローのキュー投入時に読み込まれます。キー更新後は、古い実行の再開に頼らず、**Run workflowから新しい実行を開始**してください。キー登録から実行開始までの待機時間も有効期限に含まれます。Environment Secretを利用する構成への変更時は、その読み込み時点が異なることに注意してください。

HTTP 401/403は認証失敗、402/429は利用枠・レート制限として表示します。授業用APIの詳しいエラー仕様は提示されていないため、期限切れと不正キーの区別は行いません。HTTP 200で返る業務エラーも、識別仕様が確認できるまでは厳密に判別できません。

キーをIssue、コメント、PR、Actionsの通常入力、ログへ貼らないでください。使用後の削除・失効も利用者が行います。BotにSecretsの管理権限はありません。

## 手動・自動モード

初期設定は `"mode": "manual"` です。この状態ではラベルや定期実行からAIを呼び出しません。

`"mode": "automatic"` に変更してデフォルトブランチへ取り込むと、次の自動処理を有効にします。手動実行も引き続き使えます。

- **Issue**: write/maintain/admin権限を持つ利用者が `ai-investigate` ラベルを付けたとき。ラベル名は `issueLabel` で変更できます。ラベルはGitHubのIssues画面から作成してください。Issueの新規作成だけでは起動しません。
- **Dependabot**: 毎時23分（UTC）にopenアラートを古い順に確認。成功済みの調査を除き、初期値で1件だけ処理します。

定期実行には遅延があり、即時性は保証されません。publicリポジトリでは一定期間活動がないとGitHubが定期実行を無効にする場合があります。ワークフロー全体を直列化しますが、Actionsのconcurrencyによる待機中の実行の置き換えもあるため、イベントを確実に全件処理するキューではありません。取りこぼしたIssueは手動で実行してください。

自動モードでも一時キーは自動更新されません。授業中だけ自動モードを使う場合は、授業前にキーを更新し、終了後はmanualへ戻してください。無効なキーでの繰り返し実行を止めるにはmanualへ戻すか、ワークフローを無効にします。

`maxTargetsPerRun` は1〜3件です。Claude Codeには対象ごとに1ターン・1 USDのCLI予算上限、認証中継には最大8リクエスト、実行には時間制限を設定しています。これはプロバイダーの課金額を保証する厳密な予算管理ではありません。OpenAI/Anthropic側でも予算・利用枠を設定してください。

## 調査資料と結果

デフォルトブランチのコミットSHAを固定し、許可したパスからJavaScript、JSX、manifest、lockfileの一部を取得します。シンボリックリンク、隠しパス、node_modules、秘密情報を示すファイル名は除外します。ファイル数・ファイルサイズ・合計容量に上限があり、全体を読んだ調査ではありません。省略情報もAIへ渡します。Dependabotでは対象manifestを優先します。

`include` はディレクトリの前方一致（末尾 `/`）またはファイルの完全一致です。globは使いません。コードが `frontend/` にある場合などは追加してください。Issueコメント、README、外部URL、PRのコードは調査資料に含めません。スラッシュ起動では、実行許可を確認するためコマンドのコメントだけを再取得します。設定やMCP、フックとして調査対象の内容を読み込むこともありません。

APIキーらしい文字列は送信前にマスクしますが、**全種類の秘密を自動検出できる保証はありません**。publicの内容であっても、AIへの送信を許可したリポジトリでのみ使用してください。

結果には要約、ファイル上の根拠、修正方針、不確実な点、人間が行う検証を求めます。ファイルの引用や結論はAIの生成物であり、人間による照合が必要です。AIの回答は見出し・箇条書き・表を通常のMarkdownとして表示し、コード例だけをコードブロックにします。コード例以外のHTML、画像埋め込み、メンションを抑制し、図として動作する特殊なコードブロックはプレーンなコード表示にします。

- Issue: 対象Issueへのコメント。
- Dependabot: Botが作成する **Dependabot調査レポート** Issueへのコメント。アラート自身には通常のIssueコメント欄がありません。
- 両方: 投稿ジョブのJob Summary。

**publicリポジトリのコメント・Summary・成果物には公開情報として扱う内容だけを載せてください。** Dependabotの情報もレポートIssueへ公開します。調査資料とマスク済み結果のActions成果物は保持期間1日で作成します。

同じ対象内容・対象SHA・AI設定・パス設定で成功済みの調査は省略します。失敗コメントは成功扱いにせず、同じ調査の再試行では既存コメントを更新します。ソースが変わると新しい調査になります。重複確認は最大1000コメント／Issue一覧までで、上限に達した場合は安全のため停止します。

## 権限と隔離

| ジョブ | GitHub権限 | AIキー |
| --- | --- | --- |
| prepare | contents/read、issues/read、vulnerability-alerts/read | なし |
| analyze | contents/read（Botのcheckout用） | 選んだAIのキーのみ |
| publish | contents/read、issues/write | なし |

- workflow_dispatchはデフォルトブランチ限定。Issue起動時もラベルを付けた利用者の権限をAPIで再確認。
- forkのPRや `pull_request_target` からAI実行はしない。CIのPRチェックにはSecretを渡さない。
- ActionsはコミットSHA、コンテナ基盤はdigest、CLIはバージョンで固定。更新はレビューして行う。
- checkoutは認証情報を永続化しない。調査モードでは対象プロジェクトの依存インストール・npmスクリプト・ビルドを実行しない。修正モードの検証スクリプトはSecretなし・ネットワークなしの別コンテナ内だけで実行する。
- Claude Code/Codexには、作業ツリーをマウントせず、サイズ制限した調査資料を標準入力で渡す。
- CLIは非root・読み取り専用コンテナ内で実行。capabilityを削除し、メモリ・プロセス数・一時領域・時間に上限を設ける。
- CLIコンテナはinternalネットワークに置き、ホストのファイル・Dockerソケット・本物のAIキー・GitHubトークンを渡さない。外部DNSへの転送も抑制する。
- 認証中継コンテナだけが本物のキーを保持。転送先とAPIパスを固定し、HTTPリダイレクトを拒否。任意URLへのプロキシやGitHubへの接続には使えない。
- 中継がAIリクエストからtools宣言を取り除き、CLIにも最小権限を指定。Codexの読み取り専用設定だけを秘密保護の境界とは扱わない。
- AIやCLIの生ログ・APIのエラー本文は公開しない。投稿ジョブはAI出力をコマンドや投稿先指定として解釈しない。

Issueやコード内の指示を信用しない旨をプロンプトにも指定しますが、プロンプトだけで攻撃を防ぐ設計ではありません。リポジトリのwrite権限を持つ利用者はワークフロー自体を変更できるため、Secretsを使うリポジトリの共同管理者は信頼できる人に限定し、デフォルトブランチを保護してください。

修正機能は下記の「ラベルから修正PRを作成する」を参照してください。調査モードの処理・権限とは別のワークフローです。

## 失敗した場合

認証失敗、利用上限、通信失敗、無効な回答、隔離環境の実行失敗は定型文で報告します。AI呼び出しの失敗コメントを投稿した場合も、ワークフローは失敗扱いにします。権限不足・設定不備・イメージビルド失敗など、投稿まで進めない障害はActionsの失敗ステップを確認してください。APIが返す業務エラーの詳細は、各提供元の仕様確認が必要です。

キーはSecret画面で更新し、新しく手動実行してください。キー・HTTPヘッダー・生レスポンス・CLIの認証ファイルを共有して調査しないでください。

## 開発・検証

```sh
npm run check
npm test
```

ローカルテストには実キーや外部接続を使用しません。設定検証、権限制御、対象取得、マスク、重複判定、API失敗、認証中継、コンテナ起動引数、コメント投稿を模擬応答で検証します。`Bot checks` ワークフローには、認証情報なしのDockerビルドとCLI起動チェックも含めています。

ローカルにDockerがないため、Docker実行はGitHub Actionsのチェックで検証します。修正機能には正しい修正・失敗する修正・構文エラー・資格情報の不在・書き換え防止・ネットワーク遮断を確かめるDockerスモークテストがあります。東京都AIの文章調査はこのリポジトリで実接続・コメント投稿を確認済みです。修正案生成を含む各AIの実接続は、利用者のSecretで小さなIssueを指定して別途確認してください。実接続では提供元の利用枠を消費します。東京都APIのレスポンス仕様は、提示された授業用サンプルに基づきます。

## 公式資料

- [手動でActionsを実行する](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow)
- [Actions Secrets](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets)
- [Secretsの読み込み時点](https://docs.github.com/en/actions/reference/security/secrets)
- [Actionsの権限](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#permissions)
- [Claude CodeのGitHub Actions対応](https://code.claude.com/docs/en/github-actions)
- [Claude Code CLI](https://code.claude.com/docs/en/cli-reference)
- [Codex GitHub Actionと安全対策](https://developers.openai.com/codex/github-action)
- [Codexの非対話実行](https://developers.openai.com/codex/noninteractive)

## ラベルから修正PRを作成する

`ai-fix` ラベルをwrite/maintain/admin権限を持つ利用者がIssueに付けると、**AI fix** ワークフローが修正案を作成し、検証に成功した場合だけ専用ブランチからPRを作成します。PRには `Closes #番号` が入り、人間がレビューしてマージするとIssueが閉じます。自動マージやデフォルトブランチへの直接コミットは行いません。

1. この機能のファイルをデフォルトブランチへ取り込みます。インストーラーは `fix.yml` と修正用ランタイムも配置します。
2. Settings → Actions → Generalで **Allow GitHub Actions to create and approve pull requests** を有効にします。Bot自身はレビュー承認をしません。組織のポリシーで禁止されている場合は管理者による設定が必要です。
3. Issues → Labelsで `ai-fix` ラベルを作成します。
4. `.github/ai-bot/config.json` の `fix` を有効にし、そのプロジェクトで必要な検証をargv配列で指定します。
5. 再現手順、期待する挙動、関連ファイルをIssueに記載し、`ai-fix` ラベルを付けます。

```json
"fix": {
  "enabled": true,
  "label": "ai-fix",
  "commands": [
    ["npm", "run", "check"],
    ["npm", "test"]
  ]
}
```

`commands` は人間がレビューする設定です。AIやIssueから指定させません。必ずテストコマンド（`npm test` / `npm run test` / `node --test ...`）を1つ以上含めます。上の例はこのBotリポジトリ用です。`check` スクリプトのないプロジェクトでは、実在する検証コマンドへ変更してください。`fix` のない旧設定は無効として扱うため、インストーラーが保持した既存設定には手動で追記してください。

調査用の `mode: manual` とは独立した設定です。`fix.enabled: true` なら、明示的な `ai-fix` ラベル付与で起動します。Actions → **AI fix → Run workflow** にIssue番号を入力して手動実行することもできます。`ai-investigate` は文章調査、`ai-fix` は修正PR作成です。

### 初期対応範囲

- AIは取得済みの既存 `.js` / `.mjs` / `.cjs` のみを最大3ファイル修正できます。1ファイル12000バイト、合計24000バイトが上限です。
- 新規ファイル、削除、テスト、設定、依存関係、認証情報、ワークフロー、Bot本体の制御部分は変更できません。Botの表示処理だけは、下記の明示的な許可設定で対象にできます。JSXやTypeScriptもこの修正機能の対象外です。
- 取得資料だけで確信が持てない場合は変更なしで理由を報告します。マスク済みの秘密を含むファイルも編集できません。
- **初期の検証は外部依存のないNode.jsプロジェクトを対象**にします。dependencies/devDependencies/optionalDependenciesがある場合、依存を取得せずに停止し、理由をコメントします。npmインストールやネットワークが必要なプロジェクトの検証対応は今後の追加項目です。
- 元のテストが不十分だと、検証が成功しても不適切な修正を検出できない場合があります。PRの差分とテストの妥当性を必ず人間が確認してください。

### 処理と権限

`prepare → generate → validate → publish` の4ジョブです。AIキーはgenerateだけ、GitHubの書き込み権限はpublishだけに渡します。fixのprepareはIssue・ソース・既存PRを読み取り、未完了PRがある場合はそのリンクをIssueへ返信します。

validateでは、元コミットをアーカイブして別のDockerコンテナに渡します。信頼した検証プログラムだけが展開・修正適用を行い、その後ソースとテストをroot所有の読み取り専用にして実行権限を非rootへ落とします。対象コードからテストや検証プログラムを書き換えられないようにしています。ネットワーク・認証情報・ホストの作業ディレクトリ・Dockerソケットは渡しません。書き込みは容量制限した一時領域だけに限定します。

構文チェックと設定された全検証が成功した場合、検証した修正内容のハッシュをpublishで再確認し、GitHub APIで `ai-fix/issue-番号-…` ブランチとPRを作成します。生成コードやnpmスクリプトをpublishジョブで実行しません。Issueや元ブランチが変わった場合、またはラベルが外れた場合は公開を停止します。

同じIssueの未完了のBot PRがある場合は追加作成しません。検証失敗や確信不足なら、ブランチを公開せずIssueに調査内容と理由をコメントします。再試行はラベルを外して付け直すか、手動で新規実行してください。APIキーの期限切れ時は先にSecretを更新します。

Botが作ったPRのCIには、人間による実行承認が必要になる場合があります。必須レビューと必須チェックはリポジトリのブランチ保護／Rulesetsでも設定してください。

修正対象がない、またはAIが変更を見送った場合は、Issueに理由を報告して正常終了します。PRを作成したことは意味しません。実際の検証失敗・認証エラーなどは失敗扱いにします。

## Issueコメントのスラッシュコマンド

ラベルの代わりに、対象Issueへ次のいずれかを**単独のコメント**で投稿しても起動できます。

```text
/ai-investigate
```

日本語の調査結果をコメントします。`mode: manual` でも、明示的なコマンドとして実行できます。

```text
/ai-fix
```

修正案を生成し、検証成功時だけPRを作成します。`fix.enabled: true` が必要です。ラベルは不要ですが、修正対象パス・検証・確信度などの制限はラベル起動と同じです。

- write/maintain/admin権限を持つ人の、新しいIssueコメントだけを受け付けます。通常のコメント、引用、コードブロック内のコマンド、Botのコメント、PRコメント、編集したコメントでは起動しません。
- 引数や追加の依頼文は付けません。修正の要件・再現手順はIssue本文へ記載してください。コメント本文をシェルコマンドとして実行することはありません。
- 実行開始前と公開前に、GitHubからコメントを再取得して投稿者・対象Issue・本文を確認します。投稿後にコマンドを削除／別の内容へ編集した場合は、確認時点で停止します。既に実施したAI呼び出しを取り消す機能ではありません。
- 実行状況はActions、結果は対象Issueで確認できます。同一内容の成功済み調査や既存の未完了修正PRは重複作成しません。
- この対応もデフォルトブランチへ取り込んでから利用できます。Dependabotアラート単体へのスラッシュ操作は対象外です。


## Bot自身の表示処理を修正PRで提案する

このリポジトリでは、表示処理の `.github/ai-bot/src/markdown.js` を明示的に許可しています。Issue本文にそのファイルの不具合・期待する表示・再現例を書き、`/ai-fix` を新規コメントすると、既存テストと検証が通った場合だけ修正PRを作成します。人間がレビューしてからマージしてください。

```json
"fix": {
  "enabled": true,
  "label": "ai-fix",
  "commands": [["npm", "run", "check"], ["npm", "test"]],
  "botFiles": [".github/ai-bot/src/markdown.js"]
}
```

`botFiles` は読取り・修正を許可するファイル名の完全一致リストです。省略または空配列ならBot自身のコードは対象外になります。インストーラーが保持した既存設定にも、利用する場合は人間が追記します。

初期の対応ファイルは上記の `markdown.js` だけです。ワークフロー、APIクライアント、認証中継、権限判定、変更範囲判定、検証プログラム、PR公開処理、設定、テストは、リストに追加しても拒否します。`.github/` をディレクトリごと許可することもできません。対象を増やす場合は、人間が実装の保護リストをレビューして変更する必要があります。

この許可も将来の動作の安全性を保証するものではありません。PR内のimport追加・外部通信・環境変数へのアクセスなどを含め、人間が変更全体を確認してください。既存のAIキー分離とSecretなしのオフライン検証、自動マージ禁止は維持します。

Issue #2は「コードを変更せず調査する」依頼なので、その内容から変更を強制しません。表示処理の修正を依頼する場合は、新しいIssueに具体的な変更内容を書いてください。ActionsのPR作成許可の設定は、この機能とは別です。

`/ai-fix` の結果はコマンドごとに新しいコメントで返信します。同じコマンドのActions実行を再試行した場合だけ、そのコマンドへの返信を更新します。古い結果コメントまで戻って探す必要はありません。

## 調査結果のPR作成とIssue返信を一括実行する

対象Issueへ `/ai-report-pr` を単独の新規コメントとして投稿してください。調査 → Markdownの作成 → 専用ブランチとPR作成 → IssueへPRのURLを返信、まで一度の実行で行います。Actions画面からは **AI investigation** で `target: issue`、`result: report-pr` とIssue番号を指定しても実行できます。

調査結果の保存先は `reports/ai/issue-番号.md` に固定し、コードや依存関係は変更しません。Markdownの形式・容量・保存先・元SHA・Issue内容を検査します。コードのテストを実行したと偽らず、PRにも未実施と記載します。既存の人間が書いた文書やシンボリックリンクに競合する場合は停止します。調査PRは `Refs #番号` で関連付け、Issueを自動で閉じません。

| コマンド | 一括で行うこと |
| --- | --- |
| `/ai-investigate` | 調査してIssueへ結果コメント |
| `/ai-report-pr` | 調査結果をMarkdownのPRにし、IssueへPRリンクを返信 |
| `/ai-fix` | コード修正案を検証し、成功時だけ修正PRとIssueへのリンク返信 |

PR作成後にコメント投稿だけが失敗しても、作成済みPRは削除しません。コマンドをもう一度投稿すると、既存の未完了PRを検出してそのリンクを返信します。調査PRが既にある場合は、AIの再呼び出しも省略します。既存の修正PRを再案内するため、fixのprepareジョブにはIssue返信に必要なissues/writeを付与しています。AIキーを持つジョブや検証コンテナには書き込み権限を渡しません。

PRを作成するには、GitHubの **Allow GitHub Actions to create and approve pull requests** の許可が必要です。このスイッチはPR作成とレビュー承認の共通設定ですが、Botはレビュー承認や自動マージを行いません。リポジトリの設定変更は、このコードの導入とは別に管理者が明示的に許可してください。
