# Botに組み込んだ指針

調査・修正案・PRレビューで、自作の日本語要約を共通で使います。追加設定は不要で、東京都AI・Claude・Codex・複数AIモードに適用します。

| 参考資料 | 採用した内容 |
| --- | --- |
| [Anthropic-Cybersecurity-Skills](https://github.com/mukul975/Anthropic-Cybersecurity-Skills/tree/54a798831d2266a3ca61ce68a7acb80b81160d57)（Apache-2.0） | GitHub Actions、間接プロンプト注入、依存関係の調査観点 |
| [andrej-karpathy-skills / CLAUDE.md](https://github.com/multica-ai/andrej-karpathy-skills/blob/2c606141936f1eeef17fa3043a72095b4765b9c2/CLAUDE.md) | 仮定の明示、単純な実装、最小の変更、検証できる成功条件 |
| [Cloudflare security-audit-skill](https://github.com/cloudflare/security-audit-skill/tree/c1c8a8c1471069fb0e188eeaff69b8e8db6564a8/skills/security-audit)（MIT） | 信頼境界と実害、既存防御の確認、確定・要検証・反証の区別、独立検証の扱い |
| [Caveman](https://github.com/JuliusBrussee/caveman/tree/e74a11ccdb38b98d15c9f9545787c907dd15f0ab/skills)（Apache-2.0） | 結論を先に、重複を省略、技術情報と必須の根拠を保持、箇所・問題・修正案が分かるレビュー |

Cloudflareからは静的調査向けの判断指針を採用しています。Botの実行は従来の調査・修正・レビューで、六段階の監査や独立エージェントによる再検証を実行したとは扱いません。

Cavemanは文章の指針だけを要約して採用しています。Issue・PRは自然な日本語を保ち、追加のCLI・プロキシ・クラウド連携やテレメトリーは導入しません。

参照先と版は `src/guidance.js` に固定しています。実行時に原文やスクリプトを取得・実行しません。原文の転載ではなく、関連する指針の要約です。外部スキャナー、SBOM生成、検出モデルを導入したものではありません。これらの指針は回答を補助するもので、既存のパス・権限・検証制限を緩和しません。最初の資料はコミュニティ製で、Anthropic公式ではありません。
