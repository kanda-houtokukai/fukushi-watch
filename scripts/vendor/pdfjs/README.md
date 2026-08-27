# pdfjs-dist（直置き・P43）

PDFのテキスト抽出に使う Mozilla pdf.js の配布物。**npm install を使わず直置き**する
（daily.yml にセットアップ手順を増やさない＝毎朝の失敗経路を増やさないため。
dev-workflow §6「パッケージ管理を経由せず直置きを先に検討」の適用）。

- 出所: https://registry.npmjs.org/pdfjs-dist/-/pdfjs-dist-6.2.108.tgz の
  `package/legacy/build/` から `pdf.min.mjs` と `pdf.worker.min.mjs` の2ファイル。
- バージョン: **6.2.108**（2026-08-27 配置）。ライセンス: Apache-2.0（LICENSE 同梱）。
- 使い方は `scripts/pdftext.js` を経由する（直接 import しない）。
  - ⚠️ Node には DOMMatrix 等の描画用ブラウザAPIが無く、import 時に要求される。
    テキスト抽出では使われないため pdftext.js が最小スタブを立ててから import する。
  - ⚠️ `GlobalWorkerOptions.workerSrc` に `pdf.worker.min.mjs` を明示すること。
    未指定だと同ディレクトリの `pdf.worker.mjs`（非min・同梱していない）を探して落ちる。
- 更新するとき: 新しい版の tarball から同じ2ファイルを差し替え、この README の
  バージョンを更新し、`node scripts/pdftext-check.js` で機械確認してからコミットする。
