# ソース監査（2026-11-26）

対象は `ac7b2f0e57b98331dd66450ced444bbd86c41c71`。権限、APIキー、AIへの送信、修正・競合解消・レビュー、更新・導入、検証環境、Actions間の成果物を15単位で確認しました。

- **確定した脆弱性：0件**。安全性を保証する結果ではありません。
- **追加検証：1件**。Markdownのリンク先にバッククォートを含めると、Botのコード範囲判定とGitHubの表示解釈が食い違い、画像やメンションの抑止を回避する可能性があります。GitHub上の発生は未確認で、重要度は付けていません。
- 以前の「認可前の共有キュー」「検証側とテスト側の同一UID」の懸念は、現行コードでは前提が解消されていました。

追加検証の根拠は [markdown.js](https://github.com/hrmcngs/github-ai-fix-bot/blob/ac7b2f0e57b98331dd66450ced444bbd86c41c71/.github/ai-bot/src/markdown.js#L7) のインラインコード判定と、[core.js](https://github.com/hrmcngs/github-ai-fix-bot/blob/ac7b2f0e57b98331dd66450ced444bbd86c41c71/.github/ai-bot/src/core.js#L94) → [main.js](https://github.com/hrmcngs/github-ai-fix-bot/blob/ac7b2f0e57b98331dd66450ced444bbd86c41c71/.github/ai-bot/src/main.js#L177) のコメント公開経路です。通信・通知を止めた隔離環境で、互換レンダラーの解析結果を比較する必要があります。実Issueへの試験投稿は行っていません。

これはソース確認です。監査用の完全な隔離環境・互換レンダラーを利用できなかったため、実行による再現、実API、本番の権限設定、外部SDKやCVE全体の調査は対象にしていません。監査台帳・候補記録は形式検証済みで、網羅性確認と候補の独立レビューを実施しました。

改善候補として、複数AIの統合入力とCLIの上限統一、インストーラーの取得容量制限、CIのテスト時間制限を記録しました。確定した脆弱性とは区別しています。

同時に追加した [Botの固定指針](skill-sources.md) は別の変更です。調査・修正案・PRレビューへ共通適用し、既存の権限・検証制限を維持します。新しい指針の回帰テストは通常CIで確認しています。
