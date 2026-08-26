#!/usr/bin/env node
/**
 * 福祉情報ウォッチ — 研修の収集（P34）
 *
 * 助成（grants.js）と同じ別系統。書き先は data/kenshu.json ただ1つで、
 * 「いま申し込める研修」だけを持ち、締切（無ければ開催時期）を過ぎたものは
 * 表示からも保存からも消す。紙面（history）には積まない。
 *
 * ⚠️**AIを一切使わない**（P34の[DECISION]）。判定材料が研修名だけなので、
 *    締切もタグ（分野・種別）もすべて機械抽出・機械写像にする。
 *    幻覚が原理的に起こらず、写像の全件が検証できる。
 *
 * 対象の源は docs/sources.md の **区分=研修** の行（状態が「巡回中」のものだけ）。
 * ⚠️年間予定表のURLは年度替わり（毎年4月）に変わる（/schedule-r8/ → /schedule-r9/）。
 *    URLは台帳（sources.md）で管理し、コードに埋め込まない。変え忘れは
 *    毎朝の取得エラー（404/0件）で気づける——失敗時は前日までの kenshu.json を温存する。
 *
 * 使い方: node scripts/kenshu.js [--dry-run]
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchHtml, readSources } from "./crawl.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const KENSHU_PATH = join(ROOT, "data", "kenshu.json");

const dryRun = process.argv.includes("--dry-run");
const jstToday = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(new Date());
const iso = (y, m, d) =>
  `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

/* ===========================================================================
 * タグの語彙と機械写像（P34。実データ＝令和8年度の予定表53行から起こした）
 * ======================================================================== */

/**
 * 種別4値（P34-2。実データ30件と予定表のセクション構成から起こした）。
 * ⚠️目的は「受けなければならないものを見分ける」こと。
 *   資格要件 = 受講が開設・配置・資格の**要件**（受けないとその事業・職に就けない）
 *   法令対応 = 法令・運営基準が施設に実施や対応を求める研修（義務研修の内容）
 *   階層別   = 職位・経験年数で受ける（新任・中堅・管理職員・キャリアパス課程）
 *   テーマ別 = それ以外の技能・実務研修（受け皿。テーマでの細分化はしない＝
 *              チップが増えて絞り込みが機能しなくなる／分野タグと軸が重なる）
 * ⚠️「更新」は立てていない——実データに更新研修が0件のため（ケアマネ更新は別ページ管理）。
 *   ケアマネ更新が入る段階で「資格要件に含める／更新を立てる」を改めて判断する。
 */
export const KIND_VOCAB = ["資格要件", "法令対応", "階層別", "テーマ別"];

/** 受講が要件になる研修の名称（汎用語の「養成研修」は入れない——県の人材育成事業まで
 *  資格要件に見えてしまう。実例: 高次脳機能障がい支援者養成研修＝テーマ別が正しい） */
const REQUIRE_KW =
  /認知症介護実践|認知症介護基礎|認知症対応型|小規模多機能|計画作成担当者|介護支援専門員|喀痰吸引|サービス管理責任者|児童発達支援管理責任者|相談支援従事者|主任介護支援専門員|権利擁護推進員養成|推進員養成研修|実務研修|実習指導者|認定介護福祉士/;
/** 法令・運営基準が求める研修（現データはBCP・感染症。虐待防止等は出れば正しく入る） */
const DUTY_KW = /ＢＣＰ|BCP|業務継続|感染症|虐待防止|身体拘束|権利擁護/;
/** 職位・経験年数で受ける研修 */
const RANK_KW = /新任職員|中堅職員|チームリーダー|管理職員|初任者コース|施設長・管理者|キャリアパス/;

export function kindOf(title, section) {
  // 「資格取得研修」セクションはサイトの分類がそのまま種別として使える（配下は全て要件系）。
  // ⚠️**「階層別研修」セクションは種別に使えない**——あれは新任→中堅→管理職の順に
  //   その階層向けのテーマ研修（コーチング・リスクマネジメント等）まで含めて並べた
  //   **並べ方**であって、個々の研修の性質ではない（実測で23行中の大半がテーマ研修だった）。
  //   階層別かどうかは**タイトルの職位語**だけで判定する。
  if (/資格取得/.test(section ?? "")) return "資格要件";
  if (REQUIRE_KW.test(title)) return "資格要件";
  if (DUTY_KW.test(title)) return "法令対応";
  if (RANK_KW.test(title)) return "階層別";
  return "テーマ別";
}

/**
 * 分野の写像（語彙はP6の5値）。研修名は定型的なので語彙写像が最も正確。
 * ⚠️どれにも該当しない＝分野を問わない職員研修なので「共通」（P6の「迷ったら共通」と同じ向き）。
 */
export function fieldsOf(title) {
  const f = [];
  if (/認知症|介護支援専門員|小規模多機能|高齢者|老人/.test(title)) f.push("高齢");
  if (/障がい|障害/.test(title)) f.push("障害");
  if (/保育/.test(title)) f.push("保育");
  if (/児童|こども|子ども/.test(title)) f.push("児童");
  return f.length ? f : ["共通"];
}

/* ===========================================================================
 * 年間予定表のパース
 * ======================================================================== */

/**
 * 年度内の「M月D日」をISOへ。年度は4月始まりで、**今日の属する年度**で解く
 * （予定表はその年度の研修だけを載せるため。P24-4の「年は掲載日基準」と同じ考え方）。
 */
export function fiscalIso(m, d, today) {
  const y = Number(today.slice(0, 4)) - (Number(today.slice(5, 7)) < 4 ? 1 : 0);
  return iso(m >= 4 ? y : y + 1, m, d);
}

const strip = (html) =>
  String(html ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .normalize("NFKC")
    .trim();

/**
 * kenshu-schedule: 年間予定表（h3セクション見出し＋ column-1〜5 のクラス付きの表）。
 *   column-1=研修名 / column-2=開催要綱PDF・申込フォーム（未公開なら「11月～1月開催予定」等の文）
 *   column-4=申込開始日 / column-5=申込終了日（複数日程あり: 「B日程4月24日 C･D日程5月22日」）
 * ⚠️**ハブ型**（中身が入れ替わる）。一覧に載っている＝今年度の研修、という読み方をする。
 * 返り値: { items, raw } — raw は読み取れた行数（0件ガードは raw にかける）。
 */
export function parseKenshuSchedule(html, today, baseUrl) {
  const items = [];
  let raw = 0;
  // セクション見出し（h3/h5）で分割しながら読む。見出しはタグを剥いで持ち回す
  // 見出しタグごと分割し、id（link1〜5）も拾う——個別ページが無い研修は
  // 一覧ページ＋セクションのアンカーへ飛ばすため（P34-2）
  const parts = html.split(/(?=<h[35][^>]*>)/);
  let section = "";
  let anchor = "";
  for (const part of parts) {
    const head = part.match(/^<h([35])([^>]*)>([\s\S]*?)<\/h\1>/);
    let body = part;
    if (head) {
      section = strip(head[3]);
      // h5（認知症介護研修など）は自前のidを持たないので、直近のh3のアンカーを保つ
      const id = head[2].match(/id="([^"]+)"/)?.[1];
      if (id) anchor = id;
      body = part.slice(head[0].length);
    }
    for (const [, rowHtml] of body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
      const cells = {};
      for (const [, n, cell] of rowHtml.matchAll(
        /<t[dh][^>]*class="column-(\d)"[^>]*>([\s\S]*?)<\/t[dh]>/g
      )) {
        cells[n] = cell;
      }
      // 「※1日目は…」のような行内注記はタイトルから落とす（詳細は要綱が担う）
      const title = strip(cells["1"]).replace(/\s*※.*$/, "");
      if (!title || title === "研修名") continue; // 見出し行
      raw++;
      // 「定員に達したため受付を終了しました」等は募集が閉じている＝載せない
      if (/受付(?:を|は)?終了|定員に達した|締め切りました/.test(strip(rowHtml))) continue;
      const yoko = cells["2"]?.match(/href="([^"]+\.pdf)"/)?.[1] ?? null;
      const openText = strip(cells["4"]);
      const endText = strip(cells["5"]);
      // 申込終了日: 複数日程は**今日以降でいちばん近い日**を採る（過ぎた日程は対象外）
      const ends = [...endText.matchAll(/(\d{1,2})月(\d{1,2})日/g)].map((m) =>
        fiscalIso(Number(m[1]), Number(m[2]), today)
      );
      const future = ends.filter((d) => d >= today).sort();
      let deadline = null, deadlineType, deadlineRaw;
      if (future.length) {
        deadline = future[0];
        deadlineType = "date";
        deadlineRaw = endText;
      } else if (ends.length) {
        continue; // 全日程の申込が終了
      } else {
        // 日付が無い＝要綱未公開の「◯月開催予定」など。存在を知ることに価値がある
        //（馬主財団と同じ理屈）ので「締切不明」の束に入れる。
        // ⚠️note に使えるのは時期の文だけ（col2のリンクテキスト「開催要綱」を
        //   締切の記載として出さない）
        const col2text = strip((cells["2"] ?? "").replace(/<a[\s\S]*?<\/a>/g, " "));
        const note =
          endText || (/月|予定/.test(col2text) ? col2text : "");
        if (!note && !yoko) continue; // 情報が何も無い行
        deadlineType = "unknown";
        deadlineRaw = note || "締切の記載なし";
      }
      const om = openText.match(/(\d{1,2})月(\d{1,2})日/);
      items.push({
        title,
        // 原本=開催要綱。未公開の間は予定表の**該当セクションのアンカー**へ
        //（一覧の先頭に飛ばすと目的の研修に辿り着けない・P34-2）
        url: yoko ?? (anchor ? `${baseUrl}#${anchor}` : baseUrl),
        deadline,
        deadlineType,
        deadlineRaw,
        openFrom: om ? fiscalIso(Number(om[1]), Number(om[2]), today) : null,
        fields: fieldsOf(title),
        kind: kindOf(title, section),
      });
    }
  }
  return { items, raw };
}

/* ===========================================================================
 * 新着記事（kenshu-info）: 「◯◯研修の開催について」型の記事。
 * 予定表に無い研修の告知と、記事本文にしか無い締切（例: 認知症介護実践リーダー研修の
 * 「申込締切 令和８年７月１５日」）を補完する。⚠️締切の有無は記事による——
 * 無ければ開催日を「開催 M月D日」のラベルで示し、開催日を過ぎたら消す（P34の設計）。
 * ======================================================================== */

const FETCH_INTERVAL_MS = 1500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 受講者向け・事務連絡の記事は載せない（募集の記事だけを拾う） */
const INFO_EXCLUDE = /^保護中|様式|資料|事前課題|定員に達し|受講料について|研修体系|事業計画/;

/** 記事タイトル→研修名（「の開催について」等の定型と【…】印を落とす） */
const infoTitle = (t) =>
  t.replace(/^【[^】]*】\s*/, "").replace(/（動画配信）|【動画配信研修】|（ＷＥＢ研修）/g, "")
    .replace(/の開催(?:案内)?について.*$|について.*$/, "").trim();

/** 本文から申込締切（和暦・年なしM/D対応）を取る。無ければ null */
function infoDeadline(text, today) {
  const seg = text.match(/(?:申込(?:み)?締切|申込期限|受付期限)[^。]{0,40}/)?.[0] ?? "";
  let m = seg.match(/令和\s*(\d+)\s*年\s*(\d+)\s*月\s*(\d+)\s*日/);
  if (m) return iso(Number(m[1]) + 2018, Number(m[2]), Number(m[3]));
  m = seg.match(/(\d{1,2})月(\d{1,2})日/);
  if (m) return fiscalIso(Number(m[1]), Number(m[2]), today);
  return null;
}

/**
 * 本文の「期日/日程」の段落から開催日を集める（最終日=掲載を保つ期限にも使う）。
 * ⚠️セグメントは**次の項目ラベルの手前で切る**——伸ばすと「申込期限」の日付や
 *   受講料の説明まで開催日・但し書きに混ざる（実測でコーチング研修が該当）。
 * ⚠️元HTMLのタグ由来で「令和8年1 0月23日」のように**数字の間に空白が入る**ため、
 *   数字間の空白だけを先に詰める。月日は範囲で検証し、壊れた値は捨てる（P34-3）。
 */
const heldSegment = (text) => {
  const m = text.match(/(?:期\s*日|日\s*程|受講日程|開催日)[\s\S]{0,220}/);
  if (!m) return "";
  const seg = m[0].replace(/(\d)\s+(?=\d)/g, "$1");
  const cut = seg.search(/申込期限|申込締切|受講申込|研修方法|受講料|会員|お申し?込み/);
  return cut > 10 ? seg.slice(0, cut) : seg;
};
const validMd = (mm, dd) => mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31;

/**
 * 日本語の日付列をISOの配列にする（共通ヘルパ・P35で新着とf-kaigoが共用）。
 * 「令和8年10月22日」「10月23日」「・26日」（直前の月を引き継ぐ）の3型。
 * ⚠️`日(?!目)` で「1日目：」「2日目：」を除く——これを日付として拾うと
 *   直前の月と合成されて実在しない開催日になる（実測: 2日目→10月2日）
 */
export function datesInText(seg, today) {
  const out = [];
  let lastMonth = null;
  for (const m of seg.matchAll(/(?:令和\s*(\d+)\s*年)?\s*(?:(\d{1,2})月)?(\d{1,2})日(?!目)/g)) {
    const mm = m[2] ? Number(m[2]) : lastMonth;
    const dd = Number(m[3]);
    if (!mm || !validMd(mm, dd)) continue;
    lastMonth = mm;
    out.push(m[1] ? iso(Number(m[1]) + 2018, mm, dd) : fiscalIso(mm, dd, today));
  }
  return [...new Set(out)].sort();
}

function infoHeldDates(text, today) {
  // ⚠️日付を拾うのは**但し書き（※）の手前まで**——「※2日間受講できる…」の「2日」を
  //   直前の月と合成して実在しない開催日にしてしまう（実測: 2日間→10月2日）
  return datesInText(heldSegment(text).split("※")[0], today);
}

/**
 * 期日の但し書き（P34-3）。「※2日間受講できる方に限ります」のような**受講判断に効く**
 * 一文だけを拾う。⚠️「※詳細は開催要綱をご確認ください」の類は情報がないので落とす。
 */
export function heldNote(text) {
  const seg = heldSegment(text);
  for (const m of seg.matchAll(/※\s*([^※。]{4,32})[。]?/g)) {
    const s = m[1].trim();
    if (/詳細|要綱|ご確認|お問い?合わせ|通知|ダウンロード/.test(s)) continue;
    // 受講判断に効く但し書きだけを拾う（受講料や会員資格の説明は期日の但し書きではない）
    if (!/受講|参加|日間|限り|オンライン|会場|欠席/.test(s)) continue;
    return s;
  }
  return null;
}

async function collectKenshuInfo(src, today) {
  const list = await fetchHtml(src.url);
  // 一覧1ページ目の記事リンク（月4〜5件なので毎朝の新着検知はここで足りる）
  const links = [];
  for (const m of list.matchAll(
    /<a href="(https:\/\/fuku-shakyo-kenshu\.jp\/info\/[^"]{30,}?)"[^>]*>([\s\S]{0,160}?)<\/a>/g
  )) {
    const title = strip(m[2]);
    if (!title || title === "この記事を読む") continue;
    if (links.some((l) => l.url === m[1])) continue;
    links.push({ url: m[1], title });
  }
  const items = [];
  for (const l of links) {
    if (INFO_EXCLUDE.test(l.title)) continue;
    if (!/研修|講習|養成/.test(l.title)) continue;
    await sleep(FETCH_INTERVAL_MS);
    const text = strip(await fetchHtml(l.url));
    const dl = infoDeadline(text, today);
    const held = infoHeldDates(text, today);
    // ★開催日は締切の有無に関わらず持つ（P34-3。2日間拘束されるか等は受講判断に直結する）。
    //   締切が取れない項目では最終開催日が掲載を保つ期限にもなる
    const held2 = { heldDates: held, heldNote: heldNote(text) };
    const item = dl
      ? { deadline: dl, deadlineType: "date", deadlineRaw: `申込締切 ${dl}` }
      : {
          deadline: null, deadlineType: "unknown", deadlineRaw: "締切の記載なし",
          ...(held.length ? { expireOn: held[held.length - 1] } : {}),
        };
    const title = infoTitle(l.title);
    items.push({
      title,
      url: l.url,
      ...item,
      ...(held.length ? { heldDates: held2.heldDates } : {}),
      ...(held2.heldNote ? { heldNote: held2.heldNote } : {}),
      openFrom: null,
      fields: fieldsOf(title),
      kind: kindOf(title, ""),
    });
  }
  return { items, raw: links.length };
}

/* ===========================================================================
 * 紙面からの合流（kenshu-goryu・P34承認済みの二段判定）:
 * 既存6源の新着のうち、①タイトルが研修語彙に該当し ②ノイズ語彙に該当せず
 * ③**P11の締切ウォッチで申込締切が実際に取れた項目だけ**を研修面にも載せる。
 * ③により「締切のない検討会の開催案内」型が構造的に落ちる（誤混入で面の信頼を
 * 落とさないことを最優先・ユーザー承認の設計）。
 * ⚠️取りこぼしは設計上ありうる（締切が本文になく要綱PDFにしかない研修は落ちる）。
 * ======================================================================== */

const GORYU_INCLUDE = /研修|講習|養成講座|セミナー/;
const GORYU_EXCLUDE =
  /検討会|審議会|分科会|部会|委員会|入札|落札|公示|公告|議事|報告書|プロポーザル|意見募集|パブリックコメント/;

function collectKenshuGoryu() {
  const path = join(ROOT, "data", "deadlines.json");
  if (!existsSync(path)) return { items: [], raw: 0, allowEmpty: true };
  const d = JSON.parse(readFileSync(path, "utf8"));
  const list = d.items ?? [];
  const items = [];
  for (const it of list) {
    if (!GORYU_INCLUDE.test(it.title)) continue;
    if (GORYU_EXCLUDE.test(it.title)) continue;
    if (/傍聴/.test(it.label ?? "")) continue; // 会議の傍聴申込は受講の締切ではない
    items.push({
      title: it.title,
      url: it.url,
      deadline: it.deadline,
      deadlineType: "date",
      deadlineRaw: `${it.label ?? "締切"} ${it.deadline}`,
      openFrom: null,
      fields: fieldsOf(it.title),
      kind: kindOf(it.title, ""),
      _source: it.source, // 出どころの行政名（印章は国/県が名前判定で付く）
    });
  }
  // ⚠️締切ウォッチが空の朝は0件が正常（構造変化ではない）
  return { items, raw: list.length, allowEmpty: true };
}

/* ===========================================================================
 * 福岡県介護福祉士会（kenshu-fkaigo・P35）: /training/index.php の一覧ハブ型。
 * div.kenshu 単位で 研修名（detail_NNN.php への個別リンク）・開催日・会場・費用が平文。
 * ⚠️締切の記載は無い（個別ページにも無い）＝開催日ベースで、最終開催日を過ぎたら消す。
 * ⚠️親睦系（納涼会・交流会等）と「【受付終了しました】」は載せない。
 * ======================================================================== */

const FKAIGO_EXCLUDE = /納涼会|懇親|交流会|忘年会|新年会|総会|フェスタ|調査員募集|委員募集/;

export function parseFkaigo(html, today, baseUrl) {
  const items = [];
  let raw = 0;
  for (const block of html.split(/<div class="kenshu">/).slice(1)) {
    const t = block.match(/<h3><a href="([^"]+)"[^>]*>([\s\S]*?)<\/a><\/h3>/);
    if (!t) continue;
    raw++;
    const title = strip(t[2]);
    if (!title) continue;
    if (/受付終了|受付を終了/.test(title)) continue;
    if (FKAIGO_EXCLUDE.test(title)) continue;
    const dateCell = strip(block.match(/class="date"[^>]*>([\s\S]*?)<\/td>/)?.[1] ?? "");
    const held = datesInText(dateCell, today);
    if (!held.length) continue;            // 開催日が読めない行は載せない（期限管理できない）
    if (held[held.length - 1] < today) continue; // 全日程終了
    items.push({
      title,
      url: new URL(t[1], baseUrl).href,    // detail_NNN.php（個別ページ・P34-2の原則）
      deadline: null,
      deadlineType: "unknown",
      deadlineRaw: "締切の記載なし",
      heldDates: held,
      expireOn: held[held.length - 1],
      openFrom: null,
      fields: fieldsOf(title),
      kind: kindOf(title, ""),
    });
  }
  return { items, raw };
}

const COLLECTORS = {
  "kenshu-schedule": async (src, today) => {
    const html = await fetchHtml(src.url);
    return parseKenshuSchedule(html, today, src.url);
  },
  "kenshu-info": async (src, today) => collectKenshuInfo(src, today),
  "kenshu-goryu": async () => collectKenshuGoryu(),
  "kenshu-fkaigo": async (src, today) => {
    const html = await fetchHtml(src.url);
    return parseFkaigo(html, today, src.url);
  },
};

/** 比較用に均す（記号・空白を落とす）。
 *  ⚠️回次（1回目/第2回）は落とさない——落とすと**別の回次の研修まで畳む**
 *  （実測: 認知症対応型の開設者1回目と2回目が統合され3件消えた。P24-4の教訓の再演） */
const flat = (s) =>
  String(s ?? "").normalize("NFKC").replace(/[\s【】\[\]（）()「」・、。,.／/―ー\-~〜]/g, "");

/**
 * 同じ研修が複数の源から入るので統合する（P34。助成の型の変形）。
 * ⚠️助成は「締切一致を必須」にしたが、研修は新着・合流側が締切を持たないことがあるため
 *   「名称が包含関係 かつ（締切が一致する or どちらかが締切を持たない）」で畳む。
 *   締切が両方あって異なるなら**別の回次**なので畳まない。
 * 残す方の優先順: 締切を持つ > 予定表 > 新着 > 合流（情報の確度の順）。
 */
export function dedupeKenshu(items) {
  const rank = (it) =>
    (it.deadlineType === "date" ? 4 : 0) +
    (it.via === "schedule" ? 2 : it.via === "info" ? 1 : 0);
  const out = [];
  for (const it of items) {
    const a = flat(it.title);
    const hit = out.find((o) => {
      const b = flat(o.title);
      if (!a || !b || !(a.includes(b) || b.includes(a))) return false;
      if (it.deadlineType === "date" && o.deadlineType === "date") {
        return it.deadline === o.deadline;
      }
      return true; // 片方が締切を持たない＝同じ研修の告知の別段階とみなす
    });
    if (!hit) { out.push(it); continue; }
    const win = rank(it) > rank(hit) ? it : hit;
    const lose = win === it ? hit : it;
    // ★入口は「読める個別ページ」を優先する（P34-2）。予定表側が勝っても、
    //   新着に同じ研修のHTML記事があればそのURLを引き継ぐ——要綱PDFや一覧の
    //   アンカーより、日程・締切・申込導線が1枚に揃った記事の方が親切
    if (!/\/info\//.test(win.url) && /\/info\//.test(lose.url ?? "")) {
      win.url = lose.url;
    }
    // 受付開始日は持っている方を残す（予定表にしか無い）
    if (!win.openFrom && lose.openFrom) win.openFrom = lose.openFrom;
    // 開催日・但し書きは新着記事にしか無いので、予定表側が勝っても引き継ぐ（P34-3）
    if (!win.heldDates?.length && lose.heldDates?.length) win.heldDates = lose.heldDates;
    if (!win.heldNote && lose.heldNote) win.heldNote = lose.heldNote;
    out[out.indexOf(hit)] = win;
  }
  if (out.length !== items.length) {
    console.log(`  同一の研修を統合: ${items.length}件 → ${out.length}件`);
  }
  return out;
}

/** 項目ハッシュ。タイトル＋URL（締切は延長されうるので入れない・grants と同じ） */
export function kenshuHash(it) {
  return createHash("sha256").update(`${it.title}\n${it.url}`).digest("hex").slice(0, 16);
}

/* ===========================================================================
 * メイン（構成は grants.js と同じ: ハブ型・期限切れ削除・失敗時は前日分を温存）
 * ======================================================================== */

function loadStore() {
  if (!existsSync(KENSHU_PATH)) return { updatedAt: null, items: [] };
  return JSON.parse(readFileSync(KENSHU_PATH, "utf8"));
}

async function main() {
  const today = jstToday();
  const sources = readSources().filter((s) => s.kind === "training" && s.status === "巡回中");
  if (sources.length === 0) {
    console.log("状態が「巡回中」の研修の源がありません（docs/sources.md の区分=研修）");
    return;
  }

  const store = loadStore();
  const before = store.items.length;
  store.items = store.items.filter(
    (it) =>
      (it.deadlineType !== "date" || !it.deadline || it.deadline >= today) &&
      (!it.expireOn || it.expireOn >= today) // 締切が取れない項目は最終開催日で消す（P34）
  );
  const pruned = before - store.items.length;

  const known = new Map(store.items.map((it) => [it.hash, it]));
  const seenThisRun = new Set();
  const fresh = [];
  const errors = [];

  for (const src of sources) {
    try {
      const collect = COLLECTORS[src.method];
      if (!collect) throw new Error(`巡回方法「${src.method}」に対応するコレクタがありません`);
      console.log(`取得: ${src.name} (${src.url})`);
      const { items: parsed, raw, allowEmpty } = await collect(src, today);
      // ★0件は構造変化・年度替わりのURL失効の疑いとして失敗扱い（サイレント0件の禁止）。
      //   ⚠️合流（締切ウォッチが空の朝）など、0件が正常な源は allowEmpty で除く
      if (raw === 0 && !allowEmpty) {
        throw new Error("1件も読み取れませんでした（構造変化か、年度替わりのURL未更新の疑い）");
      }
      console.log(`  掲載${raw}行 / 申込可能${parsed.length}件`);
      const via = src.method.replace(/^kenshu-/, "");
      for (const it of parsed) {
        const hash = kenshuHash(it);
        seenThisRun.add(hash);
        const prev = known.get(hash);
        if (prev) {
          // 既知: 締切・タグを更新する（日程の追加・要綱の公開で変わる）。
          // via も付け直す（付く前の旧データに残らないように＝統合の優先順が狂う）
          const { _source, ...rest } = it;
          Object.assign(prev, rest, { via });
          continue;
        }
        // 合流の項目は出どころの行政名を源として出す（印章は名前判定で国/県が付く）
        const { _source, ...rest } = it;
        fresh.push({
          hash,
          source: _source ?? src.name,
          sourceKind: _source ? "" : "org",
          via,
          ...rest,
        });
      }
    } catch (e) {
      console.error(`  失敗（続行）: ${src.name}: ${e.message}`);
      errors.push({ source: src.name, error: e.message });
    }
  }

  // ★ハブ型: 一覧から消えた＝終了。ただし取得に失敗した回は消さない（全消えの事故防止）
  if (errors.length === 0) {
    const dropped = store.items.filter((it) => !seenThisRun.has(it.hash));
    store.items = store.items.filter((it) => seenThisRun.has(it.hash));
    if (dropped.length) console.log(`  一覧から消えたため削除: ${dropped.length}件`);
  }

  store.items.push(...fresh);
  console.log(`新規${fresh.length}件 / 合計${store.items.length}件 / 期限切れ整理${pruned}件`);

  // 同じ研修が複数の源から入るので統合する（予定表×新着×合流・P34）
  store.items = dedupeKenshu(store.items);

  // 並び: 受付中（締切あり）→ 受付前 → 開催予定。
  // ⚠️受付前を締切順の上位に混ぜない——申し込めないものが先頭に並ぶ（P34-2）
  const rankOf = (it) =>
    it.deadlineType === "date" ? (it.openFrom && it.openFrom > today ? 1 : 0) : 2;
  // 締切が無いものは開催日で並べる（P35。時期の目安しか無いものは末尾）。
  // ⚠️開催日は**今日以降の最初の日**を使う——過去の回を含む項目（勉強会の第1回が
  //   終了済み等）が先頭に来てしまう（実測で発見）
  const sortKey = (it) =>
    it.deadline ?? (it.heldDates ?? []).filter((d) => d >= today)[0] ?? "9999-99-99";
  store.items.sort(
    (a, b) =>
      rankOf(a) - rankOf(b) ||
      sortKey(a).localeCompare(sortKey(b)) ||
      String(a.title).localeCompare(String(b.title))
  );
  store.updatedAt = new Date().toISOString();

  if (dryRun) {
    console.log("（下見のため書き込みません）");
    for (const it of store.items.slice(0, 12)) {
      console.log(
        `  ${it.deadline ?? it.deadlineType} [${it.kind}] ${it.fields.join("・")} ${it.title}`.slice(0, 110)
      );
    }
    return;
  }
  mkdirSync(dirname(KENSHU_PATH), { recursive: true });
  writeFileSync(KENSHU_PATH, JSON.stringify(store, null, 1) + "\n");
  const byType = store.items.reduce(
    (a, it) => ((a[it.deadlineType] = (a[it.deadlineType] ?? 0) + 1), a), {});
  console.log(
    `完了: ${store.items.length}件（締切あり${byType.date ?? 0}・締切不明${byType.unknown ?? 0}）→ data/kenshu.json`
  );
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop());
if (isMain) {
  main().catch((e) => {
    console.error(`エラー: ${e.message}`);
    process.exit(1);
  });
}
