<!-- ai-report:issue:2 -->
# Issue #2 のAI調査結果

対象: https://github.com/hrmcngs/github-ai-fix-bot/issues/2

AI: tokyo / 対象SHA: `f70a88ff16485376a3ec3b05b9cf9a35edce7d16`

AIによる静的調査です。コード修正・テストは行っていません。人間による確認が必要です。

## 要約

`package.json` から確認できる範囲では、`scripts.test` は **Node.js標準のテストランナー (`node --test`) を実行**し、`scripts.check` は **`install.sh` の Bash 構文チェック**と、列挙された JavaScript ファイル群に対する **Node.js の構文チェック (`node --check`)** を行います。  
したがって、少なくとも以下は確認対象です。

- `install.sh` の **Bash構文**
- 指定された `.js` ファイルの **JavaScript構文**

一方で、取得資料には **Bot本体の主要実装の中身**や **テストファイルそのもの**が十分に含まれておらず、`node --test` で実際にどのテストが存在し、どこまで網羅しているかは断定できません。  
また、`node --check` は基本的に **構文の正当性確認**であり、実行時挙動、外部API連携、認可、例外処理、仕様適合性まで保証するものではないと読むのが妥当です。

---

## 根拠（ファイルパスと該当箇所）

### 1. `scripts.test` の内容
**ファイル:** `package.json`  
**該当箇所:**
```json
"scripts": {
  "test": "node --test",
```

この記述から、`npm test` 相当では Node.js の test runner が起動されることが分かります。  
ただし、**どのテストファイルが存在するか**、**テスト対象が何か**、**ユニットテストなのか統合テストなのか**は、今回の取得資料には含まれていません。

---

### 2. `scripts.check` の内容
**ファイル:** `package.json`  
**該当箇所:**
```json
"check": "bash -n install.sh && node --check .github/ai-bot/src/main.js && node --check .github/ai-bot/src/providers.js && node --check .github/ai-bot/src/broker.js && node --check .github/ai-bot/src/core.js && node --check .github/ai-bot/src/github.js && node --check .github/ai-bot/src/cli.js && node --check .github/ai-bot/src/fix-core.js && node --check .github/ai-bot/src/fix.js && node --check .github/ai-bot/src/verify-container.js && node --check .github/ai-bot/src/commands.js && node --check .github/ai-bot/src/markdown.js && node --check .github/ai-bot/src/proposals.js && node --check .github/ai-bot/src/report-pr.js && node --check .github/ai-bot/src/auto-merge.js"
```

この記述から、`scripts.check` は次を実施すると読めます。

- `bash -n install.sh`
  - `install.sh` の **構文チェック**
- `node --check <各JSファイル>`
  - 指定された各 `.js` ファイルの **JavaScript構文チェック**

対象ファイルとして少なくとも以下が列挙されています。

- `.github/ai-bot/src/main.js`
- `.github/ai-bot/src/providers.js`
- `.github/ai-bot/src/broker.js`
- `.github/ai-bot/src/core.js`
- `.github/ai-bot/src/github.js`
- `.github/ai-bot/src/cli.js`
- `.github/ai-bot/src/fix-core.js`
- `.github/ai-bot/src/fix.js`
- `.github/ai-bot/src/verify-container.js`
- `.github/ai-bot/src/commands.js`
- `.github/ai-bot/src/markdown.js`
- `.github/ai-bot/src/proposals.js`
- `.github/ai-bot/src/report-pr.js`
- `.github/ai-bot/src/auto-merge.js`

---

### 3. 実装例として取得できているファイル
**ファイル:** `.github/ai-bot/src/markdown.js`  
**該当箇所:** ファイル全体

このファイルは取得されていますが、今回の質問は `scripts.check` と `scripts.test` の検証範囲整理なので、ここから分かるのは主に以下に留まります。

- `scripts.check` の対象に含まれるファイルが、実際に `.github/ai-bot/src/markdown.js` として存在していること
- 少なくともこのリポジトリには Markdown整形・安全化を担うような実装があること

ただし、**このファイル単体からテスト範囲全体や Bot の全機能の検証状況を判断することはできません。**

---

## 修正方針

今回の資料だけから不具合を断定することはできませんが、検証の「不足しうる点」を埋める方針としては、次の整理が考えられます。

### 1. `check` の目的を明確化する
現状の `check` は、確認できる限り **構文チェック中心**です。  
そのため、もし目的が「壊れたコードを早期に防ぐ」だけでなく「挙動の妥当性確認」まで含むのであれば、構文以外の検証手段を別途用意する方針が考えられます。

考えられる補完例:
- ユニットテスト
- CLI 入出力確認
- GitHub API 連携部のモックテスト
- Markdown整形やコマンド解釈などの仕様テスト

ただし、**現時点では未導入と断定はできません**。`node --test` で既に実施されている可能性はありますが、テストファイル未取得のため不明です。

---

### 2. `test` の対象範囲を可視化する
`node --test` という起動方法だけでは、リポジトリ利用者や保守者が「何を守れているのか」を把握しにくい可能性があります。  
そのため、方針としては次のような文書化が有効です。

- どのテストファイルが存在するか
- 何をユニットテストしているか
- 何が未テストか
- 外部依存をどうモックしているか

これはコード変更ではなく、**運用上の透明性を上げる方向**です。

---

### 3. 列挙型の `node --check` 対象の保守性を見直す
`check` では対象JSファイルが個別に列挙されています。  
この形式は明示的である一方、**新しいファイル追加時に `package.json` の更新漏れが起きうる**構成です。

改善方針の例:
- 対象追加漏れが起きない運用ルールを設ける
- スクリプト生成や自動検出の仕組みを検討する

ただし、今回の資料だけでは **実際に更新漏れが発生しているか** は不明です。

---

## 不確実な点

1. **テストファイルの有無・内容**
   - `scripts.test` は `node --test` ですが、取得資料にテストファイルがありません。
   - そのため、実際に
     - テストが存在しないのか
     - 一部だけ存在するのか
     - 十分に整備されているのか
     は判断できません。

2. **`node --test` の検出対象**
   - Node.js 標準のテストランナーは一定の規則でテストを発見しますが、このリポジトリでどの命名・配置が採用されているかは資料不足です。
   - よって、「どのファイルが実行対象か」は断定できません。

3. **`check` 対象外ファイルの存在**
   - 取得資料には一部ファイルしかありません。
   - `scripts.check` に列挙されていない JavaScript ファイルや設定ファイルが存在する可能性があります。

4. **実行時品質の担保状況**
   - `node --check` と `bash -n` は、少なくとも名前から読める限り構文確認です。
   - しかし、実行時エラー、API応答異常時の挙動、権限境界、GitHub連携の副作用などがテストされているかは不明です。

5. **Node.js バージョン依存**
   - `package.json` では `node >=22` とあります。
   - ただし、この前提の下で実運用環境が統一されているかは資料から分かりません。

---

## 人間が行う検証

静的な文章調査のみでは限界があるため、人手では次を確認するのが適切です。

1. **テストファイルの実在確認**
   - `test/` ディレクトリや `*.test.js` / `*.spec.js` 等の有無を確認
   - `node --test` で何件のテストが見つかる想定かを把握

2. **`scripts.test` の実際の対象範囲確認**
   - テスト一覧を確認し、
     - Markdown処理
     - GitHub API連携
     - CLI
     - 提案生成
     - 自動マージ関連
     など主要機能ごとのカバー状況を棚卸しする

3. **`scripts.check` の対象漏れ確認**
   - `.github/ai-bot/src/` 以下や他ディレクトリに、`node --check` 対象外のJSファイルがないか確認する
   - 新規ファイル追加時に `check` 更新が必要な運用になっていないか確認する

4. **構文チェックでは拾えない不具合の洗い出し**
   - 実行時例外
   - 非同期処理の失敗時挙動
   - 外部サービス障害時のハンドリング
   - 権限や入力値の境界条件
   - Markdown安全化ロジックの期待通りの出力

5. **Node.js 22 前提の整合性確認**
   - CI や本番実行環境が `engines.node >=22` と一致しているか確認する

---

以上より、今回確認できる範囲では、`scripts.check` は **主に構文チェック**、`scripts.test` は **Node標準テストランナー起動**です。  
ただし、**テストの実体が資料に含まれていないため、検証範囲の十分性は断定できません**。この制約を前提に、人間によるテストファイル確認と対象棚卸しが必要です。
