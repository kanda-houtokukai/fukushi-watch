/**
 * 福祉情報ウォッチ — メール本文の組み立て（P3）
 *
 * report-latest.json のデータから件名とHTML本文を作る。
 * 送信（SMTP）は scripts/notify.js の仕事。ここは「見せ方」だけを担う。
 * P4のダッシュボードは同じ report データを別の見せ方で使う（出口が増えても材料は1つ）。
 *
 * ⚠️ GmailはHTMLメールで外部CSS・Flexbox・Gridが効かない。
 *    このテンプレートはテーブル組＋インラインCSSのみで書く。
 * 方向性は「自動送信の通知に見えない引き算」: 装飾は最小限、余白と字送りで読ませる。
 */

const REPO_URL = "https://github.com/kanda-houtokukai/fukushi-watch";

const FONT =
  "'Hiragino Sans','Hiragino Kaku Gothic ProN','Yu Gothic',Meiryo,sans-serif";
const INK = "#2b2926"; // 本文の濃い色
const SUB = "#8a8580"; // 補足のグレー
const FAINT = "#a5a09a"; // さらに薄いグレー
const LINK = "#1f4e79"; // リンク（落ち着いた紺）
const HIGH = "#a04a32"; // 「高」見出しにだけ使う1色
const RULE = "#e4e1dc"; // 罫線

/** JSTの日付表現を返す（Actions実行環境はUTCのため必ずタイムゾーン指定で計算する） */
export function jstDate(d = new Date()) {
  const parts = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    month: "numeric",
    day: "numeric",
    weekday: "short",
  }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t)?.value ?? "";
  return {
    short: `${get("month")}/${get("day")}`, // 8/16（件名用）
    long: `${get("month")}月${get("day")}日（${get("weekday")}）`, // 8月16日（土）（本文用）
  };
}

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function countBy(items) {
  const c = { 高: 0, 中: 0, 低: 0 };
  for (const it of items) c[it.importance] = (c[it.importance] ?? 0) + 1;
  return c;
}

/** 件名: 朝の受信箱で3秒で判断できるよう、件数と最高重要度を先頭に置く */
export function buildSubject(items, date = jstDate()) {
  const c = countBy(items);
  const brand = `福祉情報ウォッチ ${date.short}`;
  if (items.length === 0) return `更新なし｜${brand}`;
  if (c["高"] > 0) return `高${c["高"]}件を含む新着${items.length}件｜${brand}`;
  if (c["中"] > 0) return `新着${items.length}件（中まで）｜${brand}`;
  return `新着${items.length}件（低のみ）｜${brand}`;
}

function itemBlock(it) {
  return `
<div style="padding-top:18px;">
  <a href="${esc(it.url)}" style="font-family:${FONT};font-size:15px;font-weight:600;color:${LINK};text-decoration:none;line-height:1.55;">${esc(it.title)}</a>
  <div style="font-family:${FONT};font-size:12px;color:${SUB};padding-top:4px;">${esc(it.category)} ・ ${esc(it.date)} ・ ${esc(it.source)}</div>
  <div style="font-family:${FONT};font-size:13px;color:#4a463f;line-height:1.75;padding-top:7px;">${esc(it.summary)}</div>
  <div style="font-family:${FONT};font-size:13px;padding-top:5px;">
    <a href="${esc(it.url)}" style="color:${LINK};text-decoration:none;">原本を確認する →</a>
  </div>
</div>`;
}

/** 「低」はタイトル1行に畳み、高・中に画面の面積を割く */
function lowLine(it) {
  return `
<div style="font-family:${FONT};font-size:13px;color:#6b675f;line-height:1.9;padding-top:6px;">・
  <a href="${esc(it.url)}" style="color:#6b675f;text-decoration:underline;">${esc(it.title)}</a>
  <span style="color:${FAINT};">［${esc(it.category)}・${esc(it.source)}］</span>
</div>`;
}

function section(mark, label, note, color, inner) {
  return `
<div style="border-top:1px solid ${RULE};margin-top:30px;padding-top:20px;">
  <div style="font-family:${FONT};font-size:13px;font-weight:700;color:${color};letter-spacing:.08em;">${mark} ${label} <span style="font-weight:400;color:${SUB};letter-spacing:0;">── ${note}</span></div>
  ${inner}
</div>`;
}

/**
 * HTML本文を組み立てる。
 * @param {object} report data/report-latest.json の中身
 * @returns {{subject: string, html: string}}
 */
export function buildMail(report) {
  const items = report.items ?? [];
  const date = jstDate(new Date(report.generatedAt ?? Date.now()));
  const subject = buildSubject(items, date);
  const c = countBy(items);

  // 重要度の高い順に並べる（同重要度内は日付の新しい順）
  const order = { 高: 0, 中: 1, 低: 2 };
  const sorted = [...items].sort(
    (a, b) => order[a.importance] - order[b.importance] || (a.date < b.date ? 1 : -1)
  );
  const high = sorted.filter((i) => i.importance === "高");
  const mid = sorted.filter((i) => i.importance === "中");
  const low = sorted.filter((i) => i.importance === "低");

  const headline =
    items.length === 0
      ? `${date.long}の新着はありません`
      : `${date.long}の新着 ${items.length}件`;
  const countLine =
    items.length === 0
      ? "巡回は正常に動作しています"
      : `高 ${c["高"]} ・ 中 ${c["中"]} ・ 低 ${c["低"]}`;

  const body =
    items.length === 0
      ? `
<div style="font-family:${FONT};font-size:13px;color:#4a463f;line-height:1.8;margin-top:26px;border-top:1px solid ${RULE};padding-top:20px;">
  本日の監視対象に新しい掲載はありませんでした。
</div>`
      : [
          high.length
            ? section("◆", "高", "対応・確認を", HIGH, high.map(itemBlock).join(""))
            : "",
          mid.length
            ? section("◇", "中", "把握を", "#6b675f", mid.map(itemBlock).join(""))
            : "",
          low.length
            ? section("◊", "低", "参考", "#6b675f", low.map(lowLine).join(""))
            : "",
        ].join("");

  const html = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f6f5f2;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f5f2;">
<tr><td align="center" style="padding:28px 12px;">
<table role="presentation" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#ffffff;border:1px solid ${RULE};">
<tr><td style="padding:34px 36px 30px;">
  <div style="font-family:${FONT};font-size:12px;letter-spacing:.22em;color:${SUB};">福祉情報ウォッチ</div>
  <div style="font-family:${FONT};font-size:20px;font-weight:600;color:${INK};padding-top:12px;line-height:1.4;">${headline}</div>
  <div style="font-family:${FONT};font-size:13px;color:${SUB};padding-top:6px;">${countLine}</div>
  ${body}
  <div style="border-top:1px solid ${RULE};margin-top:34px;padding-top:16px;font-family:${FONT};font-size:11px;color:${FAINT};line-height:1.9;">
    要約と重要度はAIによる参考情報です。最終判断は必ず原本をご確認ください。<br>
    毎朝7時に自動巡回 ── <a href="${REPO_URL}" style="color:${FAINT};">監視対象と仕組み</a>
  </div>
</td></tr>
</table>
</td></tr>
</table>
</body></html>`;

  return { subject, html };
}
