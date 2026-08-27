/**
 * outline-ai.js — 開催の要点をAIに抽出させ、機械が原文と照合して幻覚を落とす（P48）
 *
 * ⚠️**この方式の生命線は verifyOutline() の6つの関門**であって、AIの賢さではない。
 *   AIがどれだけ尤もらしい値を返しても、原文に無ければ捨てる。
 *
 * なぜ規則でなくAIか（P47の実測）: 番号付きの開催要綱は、源の中ですら並びが一定でなく
 * （4番が「研修方法」だったり「会場」だったり）、原本に番号の誤植があり（7が欠番・8が重複）、
 * 値の位置も源で違う（研修センター＝次の行／介護福祉士会＝同じ行）。さらに日程表の時刻
 * （「9:309:50…」）や「5日目」を項目と誤検出する。規則で追うと源ごとに型を足す運用になり、
 * 自律型の方針に反する。
 *
 * ⚠️**方式は台帳に書かない。規則を先に試し、0件ならここに回す**（kenshu.js の分岐）。
 *   P46の規則方式は《 》を探すので、番号付きPDFでは必ず0件になる
 *   （実測: 番号付き9本すべてで0件・本文に「《」が1回も出てこない）。
 *
 * ⚠️PDF本文は保存しない。抽出した項目だけを持つ。
 */

import { norm, dateFromValue } from "./pdftext.js";
import { listCandidateModels, generate } from "./summarize.js";

/** 値の字数上限（関門③）。超えたら暴走とみなして捨てる */
export const MAX_VALUE = 220;

/** 近傍照合の窓（関門⑤）。値の直前この字数以内に項目名があること */
export const NEAR_SPAN = 50;

/** 1日のAI呼び出し上限（安全弁）。⚠️運用コストは完全ゼロを維持する（CLAUDE.md） */
export const DAILY_LIMIT = 60;

/** 呼び出し間隔（無料枠のRPM制限に配慮） */
export const CALL_INTERVAL_MS = 6000;

/**
 * 出さない項目（コード側の禁止リスト）。
 * 目的・趣旨＝説明の段落＝本文（本文は複製しない・報道源と同じ原則・P46）。
 * 日程・内容・カリキュラム・プログラム＝表組みでテキスト抽出が崩れて復元不能（P47で実測）。
 */
export const NEVER = ["目的", "趣旨", "日程", "内容", "カリキュラム", "プログラム"];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ===========================================================================
 * 関門
 * ======================================================================== */

/**
 * 関門④ 表組みの検知。⚠️照合を通っても、表の値は会員/一般の対応づけが保証できない
 * （実測: BCP・カスタマーハラスメントの受講料が区分表で、列が混ざって流れ出る）。
 * ⚠️AIの自己申告には頼らない——幻覚を落とす方式と矛盾するため、機械で判定する。
 */
export function looksTabular(value) {
  const t = norm(value);
  if (/(区分|備考|税込|人数)/.test(t) && /円/.test(t)) return "表の見出し語";
  const yen = (t.match(/[\d,]+円/g) ?? []).length;
  if (yen >= 3) return `金額が${yen}個`;
  if ((t.match(/\d+名(以上)?[\d,]+円/g) ?? []).length >= 2) return "人数×金額の並び";
  return null;
}

/**
 * 関門⑤ 近傍照合。値が原文に在るだけでは足りない——**その値が、それを示す見出しの
 * 直後にあること**まで見る。⚠️実測でこれが必要だと分かった: 「教材の送付日」を要求したら
 * AIが「研修会の数日前」と答え、原文の別の文脈（接続方法の説明）に同じ文字列が実在した
 * ため、原文照合だけでは通ってしまった。
 *
 * ⚠️照合する見出しは**台帳の項目名そのものではなく、AIが申告した見出し**にする——
 *   台帳の「日時」に対しPDFの見出しは「２．日程」、「参加費」に対し「９．受講料」の
 *   ように**源によって言い換えられている**（実測。台帳の名前で照合すると、正しい値まで
 *   落ちた）。AIの申告を信じるのではなく、**申告した見出しが原文に在り、かつ値の直前に
 *   あること**を機械が確かめる（申告自体を照合の対象にする）。台帳の項目名で一致する
 *   場合も当然通す。
 */
export function nearName(rawText, names, value, span = NEAR_SPAN) {
  const t = norm(rawText);
  const v = norm(value);
  const cands = (Array.isArray(names) ? names : [names]).map(norm).filter(Boolean);
  if (!v || !cands.length) return false;
  for (let i = t.indexOf(v); i !== -1; i = t.indexOf(v, i + 1)) {
    const before = t.slice(Math.max(0, i - span), i);
    if (cands.some((c) => before.includes(c))) return true;
  }
  return false;
}

/**
 * 関門⑥ 開催日との整合。⚠️1つのPDFに複数の回が載っていると、AIは**別の回の値**を
 * 返すことがある——原文には在るので①〜⑤は素通りしてしまう（実測: 実習指導者講習会の
 * 「2回目」に、同じPDFの「1回目」の日程が入った）。値に日付が含まれるなら、
 * **その研修の開催日のどれかと一致すること**を求める（P43の[DECISION]「題名＋開催日の
 * 2条件」と同じ思想）。日付を含まない値（会場・定員など）はこの関門を素通りする。
 */
export function dateConsistent(value, heldDates) {
  if (!heldDates?.length) return true;
  const t = norm(value);
  const found = [...t.matchAll(/(\d{1,2})月(\d{1,2})日/g)].map((m) => `${+m[1]}/${+m[2]}`);
  if (!found.length) return true;
  const held = new Set(heldDates.map((d) => `${+d.slice(5, 7)}/${+d.slice(8, 10)}`));
  return found.some((f) => held.has(f));
}

/**
 * 6つの関門。返り値 { kept, dropped }。通らなかったものは呼び側が「記載なし」に倒す。
 * ①原文照合（NFKC正規化＋空白除去の後・P43の共通前処理を再利用）②項目名の許可
 * ③字数上限 ④表組み ⑤近傍照合（見出しの申告も原文照合する）⑥開催日との整合。
 */
export function verifyOutline(aiJson, names, rawText, heldDates = []) {
  const hay = norm(rawText);
  const kept = [];
  const dropped = [];
  for (const name of names) {
    if (NEVER.includes(name)) { dropped.push({ name, why: "出さない項目" }); continue; }
    const cell = aiJson?.[name];
    const raw = cell && typeof cell === "object" ? cell.value : cell;
    const heading = cell && typeof cell === "object" ? String(cell.heading ?? "") : "";
    if (raw == null || String(raw).trim() === "") { dropped.push({ name, why: "AIがnull" }); continue; }
    const value = String(raw).trim();
    if (value.length > MAX_VALUE) { dropped.push({ name, why: `字数超過(${value.length})` }); continue; }
    if (!norm(value)) { dropped.push({ name, why: "空" }); continue; }
    if (!hay.includes(norm(value))) { dropped.push({ name, why: "原文に無い（幻覚）", value }); continue; }
    const tabular = looksTabular(value);
    if (tabular) { dropped.push({ name, why: `表組み(${tabular})` }); continue; }
    // ⚠️AIが申告した見出しも原文に在ることを確かめてから、近傍の照合に使う
    const cands = [name];
    if (heading && hay.includes(norm(heading))) cands.push(heading);
    if (!nearName(rawText, cands, value)) { dropped.push({ name, why: "近傍に見出しが無い", value }); continue; }
    if (!dateConsistent(value, heldDates)) { dropped.push({ name, why: "開催日と合わない（別の回）", value }); continue; }
    kept.push({ name, value });
  }
  return { kept, dropped };
}

/* ===========================================================================
 * AIへの問い合わせ
 * ======================================================================== */

/** ⚠️求めるのは「原文の文字をそのまま写すこと」だけ。要約・言い換え・補完はさせない */
export function buildPrompt(names, text, heldDates = []) {
  const held = heldDates.length
    ? `\n⚠️取り出すのは**開催日が ${heldDates.join("・")} の回**の情報だけです。\n同じ文書に別の回が載っていても、そちらの値を書いてはいけません。`
    : "";
  return `次は福祉の研修の「開催要綱」から抽出した文字列です。
指定された項目の値を、**原文の文字をそのまま写して**取り出してください。

項目: ${names.join("、")}${held}

規則:
- 値は原文に現れる文字列を**一字も変えずに**写すこと。要約・言い換え・補完をしてはいけません。
- 離れた場所の文字をつなぎ合わせないこと。連続した一続きの部分だけを写してください。
- 見出し（項目名）そのものは値に含めないこと。
- その項目が文書に無ければ null にすること。**推測で埋めてはいけません。**
- 値は${MAX_VALUE}字以内。長い説明が続く場合は、その項目の値にあたる部分だけを写すこと。
- あわせて、その値が**文書のどの見出しの下にあったか**を heading に、これも原文のまま写すこと
  （例: 見出しが「２．日程」なら "２．日程"）。見出しが無ければ heading は null。
- 出力は次の形のJSONだけ:
  {"項目名": {"value": "値またはnull", "heading": "見出しまたはnull"}, ...}

--- ここから文書 ---
${text}
--- ここまで ---`;
}

/**
 * 締切をAIに取らせる（P50）。⚠️項目名は**全源共通の1つ**（申込締切）だけをコードに持つ。
 *   源ごとの表記ゆれ（「12締切日」「13申込締切」「提出締切日」）は、関門⑤が
 *   **AIの申告した見出し**で照合するので吸収できる（台帳に列を足す必要はない）。
 * ⚠️関門⑥（開催日との整合）は**使わない**——締切は開催日と別の日なので、
 *   適用すると必ず落ちる。代わりに研修名をプロンプトへ渡し、どの回の締切かを示す。
 * 返り値 { iso, raw, model } ／ 取れなければ null。
 */
export async function deadlineByAi(text, title, ctx, today) {
  const NAME = "申込締切";
  if (!ctx?.apiKey) return null;
  if (ctx.budget.calls >= DAILY_LIMIT) {
    if (!ctx.exhausted) {
      ctx.exhausted = true;
      console.log(`  ⚠️AIの呼び出しが1日の上限（${DAILY_LIMIT}回）に達したため、以降は打ち切ります（翌朝に持ち越し）`);
    }
    return null;
  }
  try {
    ctx.models ??= await listCandidateModels(ctx.apiKey);
  } catch (e) {
    console.error(`  AIのモデル一覧を取得できません（締切は付けずに続行）: ${e.message}`);
    ctx.apiKey = null;
    return null;
  }
  const prompt = `次は福祉の研修の「開催要綱」から抽出した文字列です。
この研修「${title}」の**申込の締切日**を、原文の文字をそのまま写して取り出してください。

規則:
- 値は原文に現れる文字列を**一字も変えずに**写すこと（例「令和8年7月31日(金)」）。
- 開催日・研修日ではなく、**申し込みの締切**です。取り違えないこと。
- 同じ文書に複数の回が載っている場合、**「${title}」の回**の締切だけを写すこと。
- 締切の記載が無ければ null。**推測で埋めてはいけません。**
- あわせて、その値がどの見出しの下にあったかを heading に原文のまま写すこと。
- 出力は次の形のJSONだけ:
  {"${NAME}": {"value": "値またはnull", "heading": "見出しまたはnull"}}

--- ここから文書 ---
${text.slice(0, 12000)}
--- ここまで ---`;
  for (const model of ctx.models) {
    if (ctx.badModels.has(model)) continue;
    if (ctx.budget.calls >= DAILY_LIMIT) return null;
    const wait = CALL_INTERVAL_MS - (Date.now() - ctx.lastCallAt);
    if (wait > 0) await sleep(wait);
    ctx.lastCallAt = Date.now();
    ctx.budget.calls++;
    ctx.calls++;
    try {
      const res = await generate(ctx.apiKey, model, prompt);
      const json = JSON.parse(res.replace(/^```json\s*|\s*```$/g, ""));
      // ⚠️関門は要点と同じものを通す（heldDates は渡さない＝関門⑥は効かせない）
      const { kept } = verifyOutline(json, [NAME], text);
      if (!kept.length) return null;
      const d = dateFromValue(kept[0].value, today);
      return d ? { ...d, model } : null;
    } catch {
      ctx.fails++;
      ctx.badModels.add(model);
    }
  }
  return null;
}

/**
 * AI呼び出しの文脈（1回の巡回で使い回す）。⚠️鍵はここでは読まない——
 * 呼び側（kenshu.js）が受け取って渡す。鍵が無ければ AI 方式は丸ごと無効にする。
 */
export function createAiContext(apiKey, state) {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(new Date());
  const budget = state._aiBudget?.date === today ? state._aiBudget : { date: today, calls: 0 };
  state._aiBudget = budget;
  // ⚠️badModels: この実行で失敗したモデルは二度と試さない。無いと 503 を返し続ける
  //   モデルに毎回1回ずつ投げて予算を溶かす（実測: 28回のうち19回が同じモデルの失敗）
  return { apiKey, models: null, budget, lastCallAt: 0, exhausted: false, calls: 0, fails: 0,
    badModels: new Set() };
}

/**
 * 開催要綱のテキストから要点をAIで抽出し、6つの関門を通したものだけを返す。
 * 返り値 { rows, dropped } ／ 使えないときは null（鍵なし・上限到達・AI失敗）。
 * ⚠️**ここで throw しない**——AIが失敗しても巡回全体を止めない（締切なし・要点なしで続行）。
 */
export async function outlineByAi(text, names, ctx, heldDates = []) {
  if (!ctx?.apiKey || !names?.length) return null;
  const allowed = names.filter((n) => !NEVER.includes(n));
  if (!allowed.length) return null;
  if (ctx.budget.calls >= DAILY_LIMIT) {
    if (!ctx.exhausted) {
      ctx.exhausted = true;
      console.log(`  ⚠️AIの呼び出しが1日の上限（${DAILY_LIMIT}回）に達したため、以降は打ち切ります（翌朝に持ち越し）`);
    }
    return null;
  }
  try {
    // ★モデル名は固定しない（世代交代で突然404になる）。一覧から新しい順に試す
    ctx.models ??= await listCandidateModels(ctx.apiKey);
  } catch (e) {
    console.error(`  AIのモデル一覧を取得できません（要点は付けずに続行）: ${e.message}`);
    ctx.apiKey = null; // 以降は呼ばない
    return null;
  }
  const prompt = buildPrompt(allowed, text.slice(0, 12000), heldDates);
  for (const model of ctx.models) {
    if (ctx.badModels.has(model)) continue;
    if (ctx.budget.calls >= DAILY_LIMIT) return null;
    const wait = CALL_INTERVAL_MS - (Date.now() - ctx.lastCallAt);
    if (wait > 0) await sleep(wait);
    ctx.lastCallAt = Date.now();
    ctx.budget.calls++;
    ctx.calls++;
    try {
      const res = await generate(ctx.apiKey, model, prompt);
      const json = JSON.parse(res.replace(/^```json\s*|\s*```$/g, ""));
      return { ...verifyOutline(json, allowed, text, heldDates), model };
    } catch (e) {
      ctx.fails++;
      ctx.badModels.add(model); // このモデルはこの実行では使わない（無駄打ちを止める）
    }
  }
  return null; // 全モデルで失敗
}
