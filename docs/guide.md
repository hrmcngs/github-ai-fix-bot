# 詳細ガイド

GitHub上でIssueやDependabotアラートを調査し、日本語の修正方針をコメントするBotです。各利用者が自分のリポジトリへ導入し、自分のAI認証情報を使用します。管理画面や外部のBotサーバーは不要です。AIへの送信とCLIの取得には外部サービスを利用します。

**調査モード**では修正方針をコメントし、**修正モード**では既存JavaScriptの限定的な変更を検証してPRで提案します。依存更新、アラートの却下、デフォルトブランチへの直接コミットは行いません。自動マージは、専用ラベルと保護ルールで明示的に許可した場合だけ実行します。AIの回答を根拠に変更を確定せず、人間が調査結果とPRをレビューしてください。

[READMEに戻る](../README.md)

## かんたん設定

`gh auth login` の後、インストールコマンドの末尾に `| bash -s -- --setup` を指定します。既存Botの更新と再設定は `--upgrade --setup` です。Node.js 22以上と対話できるターミナルが必要です。標準入力がcurlのパイプでも、質問と非表示のキー入力は `/dev/tty` を使います。

選択したAIと起動方法を設定し、APIキーをGitHub Secretsへ直接登録します。キーの空欄は既存Secretを保持します。Secret不足や権限不足は設定画面で確認してください。private送信は明示的な同意時のみ許可します。PR作成許可はGitHubではレビュー承認許可と共通のスイッチなので、別途確認します。Botはレビュー承認しません。

ルートのpackage.jsonのスクリプト名だけを読み、checkがあれば `npm run check`、testがあれば `npm test` を検証コマンドにします。スクリプトは設定時には実行しません。testがない・既定の「no test specified」の場合はコード修正を無効にします。検証内容の十分さは人間が確認してください。代表的なソースディレクトリを追加し、Bot自身の修正許可と自動マージは無効にします。カスタム検証やmonorepoは差分を確認して手動で調整してください。

本体更新にPATは不要です。任意の全体更新用PATの発行はGitHub画面で行います。表示されたリンクから導入先限定・Contents / Pull requests / Workflowsの書込み権限で発行し、非表示の入力欄に貼り付けます。空欄なら登録を省略します。Botファイルのコミット・push・マージは自動実行しません。

## 導入

対象のGitリポジトリ内で次のコマンドを実行します（git・curl・bashが必要）。

```sh
curl -fsSL https://raw.githubusercontent.com/hrmcngs/github-ai-fix-bot/main/install.sh | bash
```

導入先を指定する場合:

```sh
curl -fsSL https://raw.githubusercontent.com/hrmcngs/github-ai-fix-bot/main/install.sh | bash -s -- --directory /path/to/your-repo
```

インストーラーはmainを1つのコミットSHAに解決し、全ファイルをダウンロード・競合確認してから配置します。既存の `config.json` は保持します。初回導入と同内容の再実行には上のコマンドを使います。

旧版があり `Existing file differs` と表示された場合は、次の更新モードで移行してください。

```sh
curl -fsSL https://raw.githubusercontent.com/hrmcngs/github-ai-fix-bot/main/install.sh | bash -s -- --upgrade
```

`--upgrade` は設定を保持し、置き換えるBotファイル・Bot用ワークフロー・旧導入記録を、Git管理領域の `ai-bot-backups/upgrade.*` にバックアップしてから更新します。通常のcloneなら `.git/ai-bot-backups/` です。保存先は実行時に表示します。旧版に導入記録がなくても移行できます。プロジェクトのソースやルートの `package.json` は変更しません。更新後は `git diff` と表示されたバックアップを確認し、PRでデフォルトブランチへ取り込んでください。`--upgrade` なしでは差分のある既存ファイルを上書きしません。`--ref` で完全な40桁のコミットSHAに固定できます。

APIキーの入力、依存パッケージのインストール、コミット・push・Actions起動は行いません。配置後に以下の設定を進めてください。公開URLは `install.sh` とBot本体をGitHubのmainへpushした後に利用できます。

1. インストーラーで配置した次のファイルを確認し、レビューしたPRで導入先リポジトリのデフォルトブランチに取り込みます。手動コピーでの導入も可能です。
   - `.github/ai-bot/` ディレクトリ全体（隠しファイルの `.dockerignore` も含む）
   - インストーラーが配置した `.github/workflows/` 内のBot用ワークフロー（`*-one.yml` も必要）
2. GitHub Actionsを有効にします。Dependabotを調査する場合は、対象リポジトリのdependency graphとDependabot alertsも有効にしてください。
3. `.github/ai-bot/config.json` の `provider`、モデル、調査対象パスを設定します。APIキーは設定ファイルへ書きません。
4. **Settings → Secrets and variables → Actions → New repository secret** で、選択したAIのSecretを登録します。
5. Actionsの **AI investigation → Run workflow** で、デフォルトブランチを選び、`target` を選びます。`number` は空欄で全件、番号を入力すれば1件です。

既存プロジェクトの `package.json` や `src/` を置き換える必要はありません。Botのコードは `.github/ai-bot/` 内で完結し、外部のnpm依存はありません。Node.jsはワークフローが用意します。CLI実行にはGitHub-hosted Ubuntu runner上のDockerを使用します。self-hosted runner、Windowsは対象外です。privateリポジトリは初期状態では停止します。管理者がAIへの送信を許可する場合に限り、Settings → Secrets and variables → Actions → VariablesにRepository Variable `AI_BOT_ALLOW_PRIVATE` を値 `true` で登録してください。Issue本文と許可パス内のソースの一部が選択したAIへ送信されます。公開範囲は変更しません。

このリポジトリ自体で試す場合も、同じ手順でSecretの登録が必要です。利用者のキーを他人が管理する共通リポジトリに集約しないでください。forkではActionsや定期実行の有効化を確認してください。

## Dependabotによるセキュリティ修正PR

インストーラーはGitHub CLIのログイン情報を使い、originのgithub.comリポジトリで管理者権限を確認してからDependabot alertsとsecurity updatesを有効にします。追加のAIキーやActions用の管理者トークンは不要です。`--skip-security-updates` で設定変更を省略できます。

`gh`未導入・未ログイン・権限不足・組織ポリシーなどで設定できない場合もBotファイルの導入は完了し、設定画面のURLを表示します。Dependency graph、Dependabot alerts、Dependabot security updatesをその画面で確認してください。alertsだけ有効になり、security updatesの有効化に失敗する場合もあります。

PRはGitHubのDependabotが作成します。全依存関係の最新版への更新ではなく、対応エコシステムで修正版が利用可能な脆弱性が対象です。即時のPR作成や全アラートの修正を保証しません。既存のDependabot設定を上書きせず、自動マージやレビュー承認も有効にしません。

[GitHub公式：Dependabot security updatesの設定](https://docs.github.com/en/code-security/how-tos/secure-your-supply-chain/secure-your-dependencies/configure-security-updates)

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

この許可も将来の動作の安全性を保証するものではありません。PR内のimport追加・外部通信・環境変数へのアクセスなどを含め、人間が変更全体を確認してください。既存のAIキー分離とSecretなしのオフライン検証、人間のレビューを必須にする条件は維持します。自動マージは専用設定でのみ許可します。

Issue #2は「コードを変更せず調査する」依頼なので、その内容から変更を強制しません。表示処理の修正を依頼する場合は、新しいIssueに具体的な変更内容を書いてください。ActionsのPR作成許可の設定は、この機能とは別です。

`/ai-fix` の結果はコマンドごとに新しいコメントで返信します。同じコマンドのActions実行を再試行した場合だけ、そのコマンドへの返信を更新します。古い結果コメントまで戻って探す必要はありません。

同じIssue・PRの `/ai-fix` は1件ずつ実行し、最大100件を待機させます。`queue: max` により、後から来た依頼が古い待機依頼を置き換える動作を防ぎます。100件を超える依頼はGitHub側でキャンセルされます。待機順の詳細は[GitHubの仕様](https://docs.github.com/ja/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)を参照してください。既に現在の版の修正PRがある場合は、そのリンクを返信して重複作成を避けます。

待機中のAPIキーの期限切れ、利用上限、権限や元ブランチの変更、無効なAI回答、テスト失敗は安全な停止の対象です。「依頼を受け付けて処理すること」と「修正PRの作成成功」は別です。この待機設定は `.github/workflows/fix.yml` の更新が必要です。別の導入先ではインストーラーの `--upgrade` でワークフローも更新してください。

## 調査結果のPR作成とIssue返信を一括実行する

対象Issueへ `/ai-report-pr` を単独の新規コメントとして投稿してください。調査 → Markdownの作成 → 専用ブランチとPR作成 → IssueへPRのURLを返信、まで一度の実行で行います。Actions画面からは **AI investigation** で `target: issue`、`result: report-pr` とIssue番号を指定しても実行できます。

調査結果の保存先は `reports/ai/issue-番号.md` に固定し、コードや依存関係は変更しません。Markdownの形式・容量・保存先・元SHA・Issue内容を検査します。コードのテストを実行したと偽らず、PRにも未実施と記載します。既存の人間が書いた文書やシンボリックリンクに競合する場合は停止します。調査PRは `Refs #番号` で関連付け、Issueを自動で閉じません。

| コマンド | 一括で行うこと |
| --- | --- |
| `/ai-investigate` | 調査してIssueへ結果コメント |
| `/ai-report-pr` | 調査結果をMarkdownのPRにし、IssueへPRリンクを返信 |
| `/ai-fix` | コード修正案を検証し、成功時だけ修正PRとIssueへのリンク返信 |

PR作成後にコメント投稿だけが失敗しても、作成済みPRは削除しません。コマンドをもう一度投稿すると、既存の未完了PRを検出してそのリンクを返信します。調査PRが既にある場合は、AIの再呼び出しも省略します。既存の修正PRを再案内するため、fixのprepareジョブにはIssue返信に必要なissues/writeを付与しています。AIキーを持つジョブや検証コンテナには書き込み権限を渡しません。

PRを作成するには、GitHubの **Allow GitHub Actions to create and approve pull requests** の許可が必要です。このスイッチはPR作成とレビュー承認の共通設定ですが、Botはレビュー承認を行いません。自動マージは下記の専用ラベルと保護ルールを設定した場合だけ実行します。リポジトリの設定変更は、このコードの導入とは別に管理者が明示的に許可してください。

## 人間の承認後にBot PRを自動マージする

**Guarded Bot auto-merge** は、`ai-auto-merge` ラベルを付けた、このBotのPRだけを対象にします。AIの自己承認やレビュー省略は行いません。既定のマージ方法はsquashです。

1. GitHubのSettings → General → Pull Requestsで **Allow auto-merge** を有効にします。ActionsによるPR作成許可とは別の設定です。
2. デフォルトブランチにclassic branch protectionを設定します。1人以上のレビュー承認、古い承認の失効、必須チェック、最新baseへの追従、管理者を含むバイパス禁止を有効にしてください。
3. 必須チェックを `.github/ai-bot/config.json` の `autoMerge.requiredChecks` と一致させます。このリポジトリの初期値は `test`、`fix-validation`、3種類の `cli-smoke (...)` です。
4. Labels画面で `ai-auto-merge` を作成し、自動マージを許可するBot PRに付けます。
5. write/maintain/admin権限を持つ人が、最新コミットをApproveします。CIも成功すると、GitHubの保護ルールに従って自動マージを要求します。

この機能は `autoMerge.enabled: false` で停止できます。古い設定に `autoMerge` がない場合も無効です。ラベルなしのPR、人間が作ったPR、fork・draft・競合・レビュー不足・CI失敗・保護範囲外の変更はマージしません。Botのレビュー承認は人間の承認として数えません。追加コミットがあれば再レビューが必要です。

レビュー送信・取り消し、Bot checksの完了、約15分ごとの確認で判定します。Actionsの **Guarded Bot auto-merge → Run workflow** からPR番号を指定して確認することもできます。定期実行には遅延があり、即時性は保証しません。最大10件ずつ確認します。ラベルを外すと新たな要求はしませんが、GitHub上で既に有効になったauto-mergeはPR画面の **Disable auto-merge** で取り消してください。

信頼したデフォルトブランチのコードだけを実行し、PR内のコード・成果物・キャッシュ・依存パッケージは実行も取得もしません。チェック名だけで判断せず、GitHub Actionsが作成したチェック、実際のワークフローパス、実行元リポジトリ、最新SHA、成功状態まで確認します。マージ直前にもPRを再取得し、`--match-head-commit` で対象SHAを固定します。`--admin` や保護ルールを迂回するAPIは使用しません。

初期対応はclassic branch protectionです。rulesetsだけの場合や、保護ルールを読み取れない場合は停止します。既定CI以外へ導入する場合は、人間がCIのパスとチェック名を実装・設定の両方でレビューして調整してください。

**現在のprivateリポジトリでは、保護ルールAPIがプラン非対応を返しています。** GitHub公式のauto-mergeと保護ブランチは、privateではGitHub Pro/Team等の対応プランが必要です。この条件が満たせない場合は自動マージしません。公開範囲やプラン、リポジトリ設定をBotが変更することはありません。

公式仕様: [自動マージ](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/automatically-merging-a-pull-request)、[保護ブランチ](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)。

### 検証で失敗したコマンドを確認する

修正用コンテナは、構文チェックと設定されたコマンドを順番に実行し、コマンド名・終了コード・安全なエラー分類を検証結果に記録します。失敗時はIssueとpublishログに、たとえば `npm test` が失敗したことを表示します。テストの生ログや環境変数、例外本文は公開しません。

テストが一時ディレクトリへ作成する実行用ヘルパーにも対応するため、検証コンテナの `/tmp` 内ではファイル実行を許可します。対象コードの実行は、引き続きSecretなし・ネットワークなし・非root・資源制限付きのコンテナ内だけです。ソースとテスト、検証プログラムは読み取り専用を維持します。

CIでは小さなフィクスチャだけでなく、このリポジトリ全体にSQL表示の修正を適用し、旧noexec設定での失敗と新設定での `npm run check` / `npm test` 成功を比較します。

npmのユーザー設定と全体設定には別々の空ファイルを使用し、同じ/dev/nullを指定した場合に起きる設定の重複読み込みエラーを防ぎます。設定ファイルは検証用イメージ内で読み取り専用です。

### Issueを更新した場合

write以上の利用者がIssueのタイトル・本文を編集すると、`Retire outdated Bot proposals` が同じIssueの古いBot修正PR・調査PRを閉じます。削除はせず、ブランチ、コメント、履歴を保持します。版情報のない旧Bot PRも、次のIssue編集時には旧版として閉じます。人間のPRや別リポジトリのPRは対象外です。

更新だけではAIを呼び出しません。新しい `/ai-fix` または `/ai-report-pr` コメントで再実行してください。現在の版のPRがあればそのリンクを返信し、旧版しかなければ最新のIssue・デフォルトブランチから作り直します。参照ありの場合は、直近2件の旧PRから、許可パスの差分だけを秘密情報の除去・容量制限付きで参考資料に渡します。新しいPRには旧PRへのリンクが付きます。旧版の指示は引き継がず、コード修正は引き続き検証成功時だけPRにします。

自動マージもIssueの版を再確認し、旧版や版情報のないPRには要求しません。Issue編集とGitHub上のマージを原子的に同期するAPIはないため、最終的なレビューでも現在のIssueと差分を照合してください。

旧PRを参照するかは、実行ごとに選択できます。

| コマンド | 旧PRの参照 |
| --- | --- |
| `/ai-fix --reference` | 参照する |
| `/ai-fix --no-reference` | 参照しない |
| `/ai-report-pr --reference` | 参照する |
| `/ai-report-pr --no-reference` | 参照しない |
| `/ai-fix` / `/ai-report-pr` | 設定の既定値に従う |

`.github/ai-bot/config.json` の `"referencePreviousPRs": true` を `false` にすると、引数なし・ラベル起動の既定値を参照なしにできます。未設定の既定値は `true` です。Actionsの **Run workflow** では `reference_previous` を `on`（参照する）、`off`（参照しない）、`default`（設定に従う）から選びます。

参照なしの場合は旧PRの差分を取得せず、AIにも渡さず、旧PRへの参考リンクを新PRに追加しません。現在のデフォルトブランチに既にマージされた変更は通常のソースとして読みます。参照の選択が異なる既存PRは再利用しません。古いPRを閉じる動作はどちらの選択でも有効です。


## 番号なしでまとめて実行する

- 調査: **Actions → AI investigation → Run workflow**。`target=all`、`number` は空欄のまま実行すると、未完了のIssueと未対応のDependabotアラートをまとめて調査します。`target=issue` / `dependabot` で種類を絞れます。
- 修正PR: **Actions → AI fix → Run workflow**。`number` は空欄で未完了の全Issue、番号ありで1件です。各Issueを別々に調査・検証し、検証成功時だけ修正PRとIssueへの返信を作ります。Dependabotアラートは引き続き調査のみです。
- 調査結果をPRにする場合は、`target=issue`、`result=report-pr` を選びます。番号なしならIssueごとにMarkdownのPRを作ります。

対象はAPIのページをたどって取得します。PRとBot自身が作った通知・集約用Issueは一括処理から除外します。権限不足や一覧取得の失敗は明示的に停止します。`target=all` にはDependabot alertsの有効化と閲覧権限も必要です。利用できない場合は `target=issue` を選んでください。

1件ずつ処理し、1件の失敗で他の対象をキャンセルしません。Actionsの対象別ジョブとSummaryに結果が表示されます。同じ内容の調査済み対象はスキップし、同じ版・同じ参照設定の修正PRがあれば再利用します。定期調査は従来どおり `mode=automatic` と `maxTargetsPerRun` の制限に従います。

手動一括実行の上限は1回256件です。超えた場合は切り捨てず停止します。Issueとアラートを分けるか、対象を整理して実行してください。待機中に一時APIキーの有効期限・上限に達した場合は安全なエラーとなり、修正を確定しません。新しいキーをSecretに登録して再実行できます。実行時間とActions利用枠は対象数に応じて増えます。

調査の `target=all` でDependabot一覧へアクセスできない場合、取得済みのIssueだけを続行します。Actionsの警告とSummaryに「Dependabotは未調査」と表示し、アラートが0件だったとは扱いません。Issueが0件でも未調査の警告は残ります。`target=dependabot` の専用実行、Issue一覧自体の取得失敗、GitHub APIの一時障害はエラーとして報告します。Issueだけを使う場合は **AI investigation → Run workflow → target=issue** を選べます。

Dependabotも調査する場合は、導入先のDependabot alertsを有効にし、Bot用ワークフローの `vulnerability-alerts: read` を確認してください（[GitHubの権限仕様](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#permissions)）。古いActions定義が残っている導入先は、インストーラーの `--upgrade` で更新できます。

## Bot自体の更新PR

追加トークン不要の **runtime（本体のみ）** を既定とします。**Bot update notices** が5分ごと（毎時2・7・12…57分）に自動確認し、更新があれば専用ブランチからPRを作成します。GitHub APIと `GITHUB_TOKEN` だけを使い、AI APIの呼び出し・利用回数の消費・AIキーの登録は不要です。リポジトリのActionsによるPR作成許可が必要です。

手動で更新だけ確認する場合は、**AI investigation → Run workflow → operation=update-only**、または **Bot update notices → Run workflow → scope=runtime** を選びます。`update-only` は対象取得とAI調査を起動せず、AI設定ファイルが未設定・不正でも更新処理と切り離します。選択肢が出ない導入先では、インストーラーの `--upgrade` でActions定義も更新してください。

`operation=investigate` は従来どおりAI調査を実行します。この場合の「Bot本体の更新PRも確認する」（既定ON）は調査と更新の両方を起動する指定です。チェックを外しても5分ごとの更新確認は継続します。

runtimeでは `GITHUB_TOKEN` の contents/write・pull-requests/write をPR作成ジョブにだけ与えます。AIキーや追加PATを使用しません。`config.json`、アプリのソース、`.github/workflows/` は変更しません。既存ファイルのハッシュを照合し、独自変更や競合があれば停止します。上流コードは実行せず、人間のレビュー後にマージします。

Actions定義に差分がある場合は、手動更新が必要なファイルをPRに記載します。Actions定義に依存する新機能は手動更新まで利用できない場合があります。`install.sh --upgrade` でバックアップを作成して更新し、差分をPRで確認してください。導入記録ではスキップしたActions定義の元のハッシュを保持します。記録のコミットSHAは本体の配布元を表し、全ファイルが同時に更新された意味ではありません。Actions定義だけの変更では本体更新PRを繰り返し作成しません。

同じ版・同じ更新範囲のPRは再利用します。見送って閉じた版は自動で作り直しません。更新がない場合はActionsのSummaryに表示します。GitHubの定期実行は遅延する場合があります。

5分はGitHubが指定できる最短の定期実行間隔ですが、5分以内の起動を保証するものではありません。毎時0分を避けて配置します。確認回数は1時間間隔の12倍になるため、privateリポジトリではActions利用時間も確認してください。

`GITHUB_TOKEN` で作成したPRでは通常のpush/PRワークフローが自動起動しない制約があります。マージ前に差分をレビューし、必要な手動CIを実行してください。[GitHub公式：GITHUB_TOKEN](https://docs.github.com/en/actions/concepts/security/github_token)

### 全体更新を手動で起動する場合

Actions定義も含めた更新を自動でPRにする場合だけ、導入先限定のfine-grained PATに **Contents / Pull requests / Workflows: Read and write** を付け、Actions Secret `AI_BOT_UPDATE_TOKEN` に登録します。通常のActions入力欄やコメントにトークンを貼らないでください。

**Bot update notices → Run workflow → scope=full** を選びます。5分ごとの確認とAI investigationからの確認は本体のみです。全体更新でも設定・AIキーは保持し、自動マージしません。[GitHub公式：ワークフロー更新権限](https://docs.github.com/en/rest/repos/contents#create-or-update-file-contents)

### 処理の隔離・公開直前の再確認

検証対象のコードと、検証結果を発行するプロセスは別のOSユーザーで実行します。コンテナ内の信頼した検証プロセスは初期化に必要な権限だけを持ち、対象コマンドはUID/GID 1000・補助グループなしで実行します。ネットワーク禁止、読み取り専用ソース/ツール、資源制限、ログを返さない方針は維持します。

一括処理の同じ対象の待ち合わせは、コマンドと権限を確認した後のジョブに置きます。無関係なコメント・権限のない要求は、承認済み処理の待ち合わせに参加しません。通常の会話ではselectorジョブも省略し、コントローラーから直接呼ばれた場合もGitHub API取得前に終了します。

調査コメントでも、公開直前に権限、private送信の許可、現在のIssue/アラートと元SHAを再確認します。更新要求で導入記録が欠けている・破損している場合は、Issueに説明して失敗します。新規の更新先ファイルが既に存在し、導入時の管理対象ではなかった場合は、内容が同じでも取り込まず競合として停止します。


### 結果に表示するAI・モデル

調査コメント、修正PR、調査結果のMarkdownとPR、PR作成後のIssue返信に、実行時の設定からAI名と指定モデル名を付けます。生成AI自身の自己申告を来歴として使いません。

- Claude: `AI: Claude Code / 指定モデル: sonnet`（設定値の例）。
- Codex: `AI: OpenAI Codex / 指定モデル: gpt-5.4`（設定値の例）。
- 東京都: `AI: 東京都生成AI API / モデル: 未取得（API応答から取得していません）`。

`sonnet` などの別名から具体的なモデルバージョンを推測しません。表示は `.github/ai-bot/config.json` の `provider` と `models` に基づく指定値で、プロバイダーが実際に解決したモデルIDを保証するものではありません。取得していないモデル名は捏造しません。失敗コメントの「今回の設定」は、その実行で設定されたAIを示し、API呼び出しの成功を意味しません。既存PRを再利用しただけの実行では新しいAI生成を名乗りません。Botの更新PRはAIを使わないため「AI使用: なし」と記載します。

## PRの競合修正とラベル作成

PRに `/ai-fix` を新規コメントすると、作成者を問わず競合の統合案を作ります。write以上の権限とAIのSecretが必要です。共通祖先・PR側・最新のデフォルトブランチの内容を比較し、既存JavaScript・Markdownの変更3ファイルまでを対象にします。追加・削除・依存関係・設定・ワークフロー・テスト等の保護ファイルが含まれる場合は停止して案内します。

検証はSecretなし・ネットワークなしの隔離環境で行います。同一リポジトリなら両方の履歴を持つマージコミットを元PRに追加します。force pushはしません。forkなら統合案を別PRにし、元PRへリンクを返信します。失敗・低い確信・残存する競合マーカー・実行中のhead/base変更では反映しません。AIが両者の意図を正しく維持した保証はないため、差分のレビューが必要です。追加コミット後のCIも確認してください。

DependabotのPRも受付対象ですが、lockfileやmanifestの依存更新はこの機能の対象外です。Dependabot側での再作成等を利用してください。元PRの自動クローズや自動マージはしません。

インストーラーはログイン済みの `gh` を使い、調査・修正・自動マージ用のラベルを不足時に作成します。既存ラベルは変更しません。Node.jsが利用できる場合はconfig.jsonのラベル名を使い、それ以外は `ai-fix`・`ai-investigate`・`ai-auto-merge` を作成します。ラベルの付与や自動マージの有効化は別操作です。

## AIを実行ごとに選ぶ・複数AIの案をまとめる

Actionsの **AI investigation / AI fix → Run workflow → ai** で `default`（設定どおり）・`tokyo`・`claude`・`codex`・`all` を選びます。IssueやPRのコメントでも `/ai-fix --ai claude`、`/ai-investigate --ai all`、`/ai-report-pr --ai codex` のように指定できます。旧PRの参照オプションとも併用できます（例：`/ai-fix --ai all --no-reference`）。

`all` は、対応するSecretが登録済みのAIだけにそれぞれ同じ資料を渡し、回答を比較して最終案を生成します。統合担当はconfig.jsonのproviderを優先し、そのキーが未登録なら登録済みの順（東京都AI・Claude・Codex）で選びます。各AIの回答は統合担当のサービスにも送信します。選択式セットアップの「登録済みAIを全部使う」でも既定に設定できます。手動設定は `"aiMode": "all"` を追加します。

最大で各AIへの3回＋統合への1回、合計4回を対象ごとに使用します。キーが1つなら1回だけです。料金・利用枠・待機時間が増えます。登録済みでも期限切れ・利用上限のキーは省略せずエラーとし、部分的な回答で修正を確定しません。未登録のサービスは呼び出しません。

個別選択時は選んだキーだけ、allでは登録済みのキーだけを生成ステップで使用します。APIキーはプロンプトへ入れず、各呼び出しには対応するキーだけを渡します。検証・公開ジョブへAIキーは渡しません。AI名・指定モデル・統合担当を結果に記載します。実際のモデルIDが取得できないサービスでは推測しません。

複数AIの一致は正しさの証明ではありません。最終の修正案に従来の変更範囲・オフライン検証・人間のレビューを適用します。AI選択が異なる既存PRは流用しません。PRの競合修正でも同じ選択が使えます。

## PRのAIレビュー

PRに `/ai-review` を新規コメントします。`/ai-review --ai codex` や `--ai all` も使えます。Actionsの **AI PR review → Run workflow** でPR番号とAIを選んでも実行できます。起動にはwrite以上の権限が必要です。privateからのAI送信には既存の明示的な許可が必要です。

PRの差分だけから不具合・互換性・テスト不足などを静的にレビューし、GitHubのレビュー欄へCOMMENTとして投稿します。Approveや変更要求のステータス、コード変更、マージは行いません。AI名・モデル・head/base SHA・差分の取得範囲も記載します。実際のテストやリポジトリ全体の解析を行ったものではなく、人間のレビューの補助です。

差分は最大30ファイル、1ファイル12000バイト、合計64000バイトです。秘密情報を示すファイル名やバイナリ差分を省略し、省略・切り詰め件数を明示します。全種類の秘密の自動検出を保証するものではありません。取得範囲外の問題やAIの誤指摘に注意してください。

PRのコードは実行もcheckoutもしません。信頼したデフォルトブランチのBotだけを実行し、AIキーを持つ解析ジョブと投稿権限を持つ公開ジョブを分けます。投稿直前に起動者・コマンド・private許可・現在のhead/baseと本文を再確認します。解析中に対象が更新されたら投稿を止め、新しいコマンドでの再実行を案内します。同じ要求の再試行では同じheadへの成功済みレビューを重複投稿しません。

[GitHub公式：PRレビューAPI](https://docs.github.com/en/rest/pulls/reviews)

## 自動セキュリティ監査PR

`securityAudit.enabled: true`を設定すると、**AI security audit**が導入先のデフォルトブランチへのpushと毎日03:41 UTCに起動します。既定は無効です。かんたん設定でも選べます。AIキー・AI利用枠を使い、privateでは従来の明示的な送信許可が必要です。定期実行はGitHub側で遅延する場合があります。Bot更新の確認とは別機能です。

同梱したセキュリティ指針を使い、`include`と容量上限内の資料を静的に調査します。ワークフローなど許可範囲外の内容、全ソース、依存関係の最新の脆弱性情報を網羅的に監査する機能ではありません。フルスキルの外部取得や任意ツールの実行は行いません。取得資料・設定・指針が同じ監査は、開いている・閉じたPRを再利用してAI呼び出しとPRの重複を避けます。

既存JavaScriptの修正案は、`fix.enabled`と許可範囲・検証コマンドを使います。Secretなし・ネットワークなしの検証に成功した場合だけ修正コードをPRに含めます。修正なし・確信不足・テスト失敗では、`reports/ai/security-audit.md`だけを変更する監査レポートPRにします。既存の人間のファイルやsymlinkは上書きしません。生成そのものの認証失敗・利用上限・不正な出力は監査成功と扱わず、PRを作らずSummaryへ失敗を表示します。

レポートにはAIと指定モデル、対象SHA、取得範囲、生成された根拠と不確実性、実際の検証結果を記載します。テスト成功を脆弱性の再現・修正の完全性の証明とは扱いません。監査PRは`ai-security/`ブランチから作り、自動マージ対象にしません。GitHub標準のDependabot修正PRとは別です。

古い導入先は`install.sh --upgrade --setup`で新しい`security-audit.yml`も取り込んでください。runtime更新はworkflowも有効化設定も変更しません。機能を有効にした設定をマージすると、導入先自身のpushイベントから起動します。こちらからの手動起動は不要です。`GITHUB_TOKEN`で作成したPRの通常CIにはGitHubの制約があるため、マージ前に必要な確認を行ってください。
