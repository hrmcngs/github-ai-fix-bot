<!-- ai-report:issue:2 -->
# Issue #2 のAI調査結果

対象: https://github.com/hrmcngs/github-ai-fix-bot/issues/2

AI: tokyo / 対象SHA: `d1685e3aaef81dda2f8db7aab6a00a889e3dac8f`

AIによる静的調査です。コード修正・テストは行っていません。人間による確認が必要です。

以下は、提示された調査資料だけに基づく静的な確認結果です。コード実行、テスト実行、静的解析ツールの実行は行っていません。そのため、実際の挙動・網羅性・修正成功・安全性は保証できません。

## 要約

`package.json` の `scripts.test` は `node --test` で、Node.js標準のテストランナーによるテスト実行を意図しています。  
一方、`scripts.check` は `bash -n install.sh` と、複数の `.js` ファイルに対する `node --check` を並べた構成です。

確認できる範囲では、

- `test` は「テストファイルが存在し、Node標準テストランナーで拾われるもの」を実行する想定
- `check` は
  - `install.sh` の **Bash構文チェック**
  - 列挙された JavaScript ファイル群の **構文チェック**
  を行う

という理解です。

ただし、取得資料には Bot 本体の主要ソース全体やテストファイル群は含まれておらず、`node --test` が実際に何件のテストを実行できるか、また `check` 対象外のファイルがあるかは確認できません。  
そのため、**実装の品質・仕様適合・ランタイムエラー不在・機能網羅まで担保するものではない**点が不足しうる点です。

---

## 根拠（ファイルパスと該当箇所）

### 1. `scripts.test` の内容
**ファイル:** `package.json`  
**該当箇所:** `scripts.test`

```json
"test": "node --test"
```

この記述から、`npm test` 等で Node.js 標準テストランナーを起動する設定であると読めます。  
ただし、**どのテストファイルが存在するか**、**命名規則に一致するテストがあるか**、**失敗/成功するか** は資料に含まれていません。

---

### 2. `scripts.check` の内容
**ファイル:** `package.json`  
**該当箇所:** `scripts.check`

```json
"check": "bash -n install.sh && node --check .github/ai-bot/src/main.js && node --check .github/ai-bot/src/providers.js && node --check .github/ai-bot/src/broker.js && node --check .github/ai-bot/src/core.js && node --check .github/ai-bot/src/github.js && node --check .github/ai-bot/src/cli.js && node --check .github/ai-bot/src/fix-core.js && node --check .github/ai-bot/src/fix.js && node --check .github/ai-bot/src/verify-container.js && node --check .github/ai-bot/src/commands.js && node --check .github/ai-bot/src/markdown.js && node --check .github/ai-bot/src/proposals.js && node --check .github/ai-bot/src/report-pr.js && node --check .github/ai-bot/src/auto-merge.js"
```

この記述から、`check` は以下を実施すると判断できます。

- `install.sh` に対する Bash の構文確認
- 列挙済み JavaScript ファイルに対する Node.js の構文確認

`&&` で連結されているため、**途中で1つでも失敗すると後続は実行されない**構成です。

---

### 3. Node.js バージョン条件
**ファイル:** `package.json`  
**該当箇所:** `engines.node`

```json
"engines": {
  "node": ">=22"
}
```

このため、少なくとも想定実行環境は Node.js 22 以上です。  
`node --test` や `node --check` の利用前提として整合的です。

---

### 4. 取得資料に含まれる実ソースの例
**ファイル:** `.github/ai-bot/src/markdown.js`

このファイルの存在は、`check` 対象の1つが実在し、JavaScriptモジュールとして管理されていることの裏付けにはなります。  
ただし、資料に含まれるソースは限定的であり、`test` 対応のテストファイル群は見えていません。

---

## 修正方針

現時点では「不具合確定」ではなく、**検証範囲の明確化と不足の補完方針**として以下が考えられます。

1. **`check` の目的を明文化する**
   - 現状の `check` は主に「構文が壊れていないか」を見るスクリプトです。
   - そのため、README や開発者向け文書で
     - `check` = 構文確認
     - `test` = 振る舞い確認
     のように役割を明示すると誤解が減ります。

2. **`check` 対象の網羅性を見直す**
   - 現在は対象ファイルが手動列挙です。
   - 新規ファイル追加時に `check` へ追記漏れが起きる可能性があります。
   - ただし、資料だけでは「他に対象にすべき JS ファイルが存在するか」は断定できません。

3. **`test` で何を検証しているかを補足する**
   - `node --test` 自体は実行入口ですが、テストファイル不在や限定的なテスト内容であれば、実質的な検証範囲は狭くなります。
   - テスト対象（例: Markdown整形、GitHub連携、CLI、提案生成など）を整理して、人間が把握できる状態にするのが望ましいです。
   - ただし、実際にそのようなテストが未整備かどうかは、資料不足のため断定できません。

4. **構文チェックだけでは拾えない種類の不具合を別手段で補う**
   - `node --check` は構文エラー検知には有効ですが、
     - import/export の実行時整合性
     - 型不整合
     - 依存関係の破綻
     - ロジックバグ
     - 例外処理不足
     までは原則保証しません。
   - 必要であれば、別途テスト・リンタ・型検査などを検討する余地があります。
   - ただし、依存追加やツール導入をこの資料だけで必須とは断定しません。

---

## 不確実な点

1. **テストファイルの有無・件数・配置**
   - `scripts.test` は確認できましたが、実際のテストファイルは資料に含まれていません。
   - そのため、`node --test` が
     - 何件のテストを見つけるか
     - どのモジュールを対象にしているか
     - 実運用上重要な処理を網羅しているか
     は不明です。

2. **`install.sh` の中身**
   - `bash -n install.sh` は書かれていますが、`install.sh` 本体は資料にありません。
   - よって、構文チェック対象であることは分かっても、内容や重要性は判断できません。

3. **`check` に列挙されていないファイルの存在**
   - 取得資料は一部のみであり、`omittedFiles: 0` ではあるものの、注記に「一部だけを取得」とあります。
   - したがって、リポジトリ全体として他の JS/設定/テストファイルがないとは言えません。

4. **Bot本体の機能範囲**
   - issue本文では「Bot本体やテストのソースが含まれていない場合は制約を明示」とある通り、今回の資料では本体全体は見えていません。
   - そのため、`check` / `test` が業務上必要な振る舞いを十分検証しているかは断定できません。

5. **CI との接続状況**
   - これらの scripts が GitHub Actions などで実際に必須実行されているかは資料にありません。

---

## 人間が行う検証

以下は、今回の静的文章調査を補うために、人間が実リポジトリで確認するとよい点です。  
ただし、ここでは実行は行っていません。

1. **テストファイルの実在確認**
   - `node --test` が拾う命名・配置のテストファイルがあるか
   - 主要機能ごとにテストが存在するか
   - テストが0件で通ってしまわないか

2. **`check` 対象漏れの確認**
   - `.github/ai-bot/src/` 配下や他ディレクトリに、`node --check` 対象外の JavaScript ファイルがないか
   - 新規ファイル追加時に手動更新が必要な運用になっていないか

3. **`install.sh` の位置と内容確認**
   - ルートに `install.sh` が実在するか
   - Bash構文チェックだけで十分か
   - シェル特有の実行時エラーが別途検証されているか

4. **`test` の実行結果確認**
   - 実際に何件のテストが走るか
   - 失敗時のログが原因特定に十分か
   - Node.js 22 以上で安定実行できるか

5. **`check` の限界を補う検証の要否判断**
   - 構文確認だけでは不十分な領域
     - GitHub API 呼び出し
     - CLI引数処理
     - Markdown整形
     - 自動マージやPR報告周り
   - について、必要に応じて個別テストやレビューを追加するか検討する

---

## まとめ

資料から確実に言えるのは、`package.json` の `scripts.check` は **Bash/JavaScriptの構文チェック中心**、`scripts.test` は **Node標準テストランナー起動** ということです。  
不足しうる点としては、どちらも資料上は **実装の正しさや網羅性まで確認できない** こと、特に **テストファイルの実在と内容が見えないため `test` の実質的な検証範囲が不明** なことが挙げられます。

このため、現段階では「検証の入口はあるが、十分性は資料だけでは判断不能」という整理が妥当です。
