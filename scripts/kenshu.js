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

/** 種別2値。⚠️「受けなければならないもの」を見分ける核（P34の[DECISION]） */
export const KIND_VOCAB = ["法定・資格系", "任意・スキル系"];

/**
 * 種別の判定: ①予定表の「資格取得研修」セクション配下（認知症介護・介護支援専門員・
 * 高齢者権利擁護を含む）は法定・資格系 ②セクションが取れない場合の保険として
 * 語彙でも判定する（指定研修・修了が要件になる研修の名称）。
 */
const LEGAL_KW =
  /認知症介護実践|認知症対応型|小規模多機能|介護支援専門員|喀痰吸引|計画作成担当者|権利擁護等推進研修|推進員養成研修/;
export function kindOf(title, section) {
  if (/資格取得/.test(section ?? "")) return "法定・資格系";
  if (LEGAL_KW.test(title)) return "法定・資格系";
  return "任意・スキル系";
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
  const parts = html.split(/<h[35][^>]*>/);
  let section = "";
  for (const part of parts) {
    const headEnd = part.indexOf("</h");
    let body = part;
    if (headEnd >= 0) {
      section = strip(part.slice(0, headEnd));
      body = part.slice(headEnd);
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
        url: yoko ?? baseUrl, // 原本=開催要綱。未公開の間は予定表そのもの
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

/** 本文の「期日/日程」の段落から開催日を集める（最終日=掲載を保つ期限に使う） */
function infoHeldDates(text, today) {
  const seg = text.match(/(?:期\s*日|日\s*程|開催日)[^▶]{0,160}/)?.[0] ?? "";
  const out = [];
  for (const m of seg.matchAll(/令和\s*(\d+)\s*年\s*(\d+)\s*月\s*(\d+)\s*日/g)) {
    out.push(iso(Number(m[1]) + 2018, Number(m[2]), Number(m[3])));
  }
  for (const m of seg.matchAll(/(?<!年)(?<!\d)(\d{1,2})月(\d{1,2})日/g)) {
    out.push(fiscalIso(Number(m[1]), Number(m[2]), today));
  }
  return out.sort();
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
    let item;
    if (dl) {
      item = { deadline: dl, deadlineType: "date", deadlineRaw: `申込締切 ${dl}` };
    } else if (held.length) {
      // 締切は要綱PDF内。開催日をラベル付きで示し、最終開催日を過ぎたら消す
      const first = held[0];
      item = {
        deadline: null, deadlineType: "unknown",
        deadlineRaw: `開催 ${Number(first.slice(5, 7))}月${Number(first.slice(8, 10))}日`,
        expireOn: held[held.length - 1],
      };
    } else {
      item = { deadline: null, deadlineType: "unknown", deadlineRaw: "締切の記載なし" };
    }
    const title = infoTitle(l.title);
    items.push({
      title,
      url: l.url,
      ...item,
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

const COLLECTORS = {
  "kenshu-schedule": async (src, today) => {
    const html = await fetchHtml(src.url);
    return parseKenshuSchedule(html, today, src.url);
  },
  "kenshu-info": async (src, today) => collectKenshuInfo(src, today),
  "kenshu-goryu": async () => collectKenshuGoryu(),
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
    if (rank(it) > rank(hit)) out[out.indexOf(hit)] = it;
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

  // 並び: 締切ありを近い順 → 不明（開催予定）。grants と同じ規則
  const rank = { date: 0, rolling: 1, unknown: 2 };
  store.items.sort(
    (a, b) =>
      (rank[a.deadlineType] ?? 3) - (rank[b.deadlineType] ?? 3) ||
      String(a.deadline ?? "").localeCompare(String(b.deadline ?? "")) ||
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
