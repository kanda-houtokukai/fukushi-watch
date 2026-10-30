# 高齢・保育の見出しと要点（syudan/_src/kourei|hoiku/toc.json・notes/）の作り方

毎朝のタスクの `extract_field.py --if-changed` が「見出しと要点の作り直しが要る資料」を出したとき、または翌年度の資料に切り替えたときに、この手順で作り直す。
2026-10-31 に高齢19編・保育2編をこの手順で作った（台帳 P68）。

## 決まり（障がいの notes_tools/HOWTO.md と同じ）
- 県の資料の文は写さない。自分の言葉でまとめる（名称・条番号・数値・期日はそのまま。国の通知の題名は引いてよい）。
- 載せるのは、照合係2人（A・B、互いの結果を見せない）がそれぞれ原文と照らして**2人とも合格**とした文だけ。
  不合格の文は照合係の直し（fix）に置き換え、別の2人（X・Y）が**2人とも合格**としたときだけ直した文を載せる。それ以外は落とす。
- 原文と根拠の抜き出しは作業用のフォルダ（リポジトリの外）だけに置き、リポジトリには入れない。

## 障がいと違うところ
- 見出しは、資料の目次の形がまちまちなため下書き係が県の資料の見出しを拾う（mode "free"）。共通資料（共通資料１〜６）だけは目次に合わせた固定の見出し（mode "fixed"・kourei_toc.py の COMMON）。
- 県のPDFの一部の頁（共通資料３・４〜６など）は poppler（pdftotext）で文字が取れない（CIDフォント）。pdfminer で取れる（thin_fix.py）。
  本当に画像だけの頁は pdftoppm で画像にし、下書き係・照合係が Read で読む（mk_chunks_k.py が img/<資料>/pN.png を作る）。

## 手順（作業用のフォルダ W を作り、このフォルダの tools/ と RULES_*.md を W にコピーして使う）
1. 資料の文字を W/txt/<添付の番号>.txt に取る（`python3 scripts/fetchtext.py PDFのURL -o W/txt/<番号>.txt`）。頁の区切りは \f。
2. `python3 W/tools/kourei_toc.py`（資料ごとの章の一覧）→ `python3 W/tools/mk_chunks_k.py`（章を5.5万字で分け、6万字ほどのかたまり chunks/<名前>.json に詰める。薄い頁は画像に）
3. かたまりごとに下書き係（Agent）へ RULES_draft_k.md を渡し、drafts/<名前>.json を作らせる（並行でよい。同時に20まで）
4. `python3 W/tools/check_k.py <名前>`（機械の確かめ。照合用の vchunks/・vdrafts/ を作る）
5. 照合係A・Bに RULES_verify_k.md で verify/<名前>-A・-B.json を作らせる
6. `python3 W/tools/r2_k.py <組> <かたまり…>`（直した文の組 r2/<組>.json。原文は6〜9万字ほどに収める）→ 照合係X・Yに RULES_verify2_k.md で r2/<組>-X・-Y.json
7. `python3 W/tools/final_k.py --write`（合格した文だけで toc.json と notes/ を書く。中の REPO を確かめる。`--draft` は照合前の下書きで画面を試すだけ。公開しない）
8. `python3 syudan/_src/extract_field.py kourei W/xw/k --texts=W/ftxt`（見出しの頁で検索の索引を区切り直す。保育は hoiku）→ `python3 syudan/_src/build.py`
- tools/next.py は待ち行列（queue_draft_todo.txt・queue_verify.txt）から次に立てる係を出す補助。
