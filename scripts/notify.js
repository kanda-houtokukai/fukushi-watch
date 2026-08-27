#!/usr/bin/env node
/**
 * 福祉情報ウォッチ — メール送信（P3）
 *
 * data/report-latest.json を読み、scripts/mail-template.js でHTMLメールを組み立て、
 * Gmail SMTP（smtp.gmail.com:465・TLS・アプリパスワード）で送信する。
 *
 * - 依存ゼロ: node:tls で SMTP を直接話す（P1からの依存ゼロ方針・承認済み）
 * - 新規0件の日も「更新なし」の短いメールを送る（生存確認になる）
 * - 送信失敗は握りつぶさずエラー終了する（Actions側も失敗として扱われる）
 *
 * 使い方: node scripts/notify.js
 * 必要な環境変数: GMAIL_USER / GMAIL_APP_PASSWORD / MAIL_TO（カンマ区切りで複数可）
 * （.env またはシェル環境。値は絶対にコミットしない）
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { connect } from "node:tls";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildMail } from "./mail-template.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPORT_PATH = join(ROOT, "data", "report-latest.json");
const MAIL_SETTINGS_PATH = join(ROOT, "data", "mail-settings.json");
const STATE_PATH = join(ROOT, "data", "state.json");

const dryRun = process.argv.includes("--dry-run"); // 送信せず判断だけ見る（検証用）

/* ===========================================================================
 * 送信の記録（P49・スケジュール不発への対策）
 *
 * 保険として2本目の cron（JST 08:47）を足したが、そのままでは毎朝2通届く
 * （新着0件の日も「更新なし」を送る＝生存確認の設計のため）。そこで
 * **同じ日に送信済みなら2本目は黙る**。
 * ⚠️記録は必ず**送信の後**に行う——送信に失敗した日は記録されず、2本目が送る。
 * ⚠️`lastRunAt` は送信の有無に関わらず、notify が正常に終わるたびに更新する
 *   （＝「daily が動いた」印。不発の検知はこの間隔で測る）。
 * ======================================================================== */

const jstToday = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(new Date());

/** 状態は data/state.json を共有する（crawl.js・summarize.js と同じ作法） */
function loadState() {
  if (!existsSync(STATE_PATH)) return {};
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf8"));
  } catch {
    return {}; // 壊れていてもメールは止めない
  }
}

function saveState(state) {
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + "\n");
}

/**
 * 前回の実行からの経過時間（時間・整数）。しきい値未満なら null。
 * ⚠️36時間にしているのは、1日1回の巡回で「1回飛んだ」ことを検知するため
 *   （24時間だと通常の揺らぎで誤検知し、48時間だと2回飛ぶまで気づけない）。
 */
export function staleHoursSince(lastRunAt, now = new Date(), thresholdHours = 36) {
  if (!lastRunAt) return null; // 初回は警告しない
  const hours = (now.getTime() - new Date(lastRunAt).getTime()) / 3_600_000;
  if (!Number.isFinite(hours) || hours < thresholdHours) return null;
  return Math.round(hours);
}

const SMTP_HOST = "smtp.gmail.com";
const SMTP_PORT = 465;
const TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// 環境変数（.env があれば読む。Actions では Secrets から環境変数で渡る）
// ---------------------------------------------------------------------------

function loadEnv() {
  const envPath = join(ROOT, ".env");
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, "utf8").split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
    }
  }
  const need = ["GMAIL_USER", "GMAIL_APP_PASSWORD", "MAIL_TO"];
  const missing = need.filter((k) => !process.env[k]);
  if (missing.length) {
    throw new Error(`環境変数が不足しています: ${missing.join(", ")}`);
  }
  return {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD,
    to: process.env.MAIL_TO.split(",").map((s) => s.trim()).filter(Boolean),
  };
}

// ---------------------------------------------------------------------------
// MIMEメッセージの組み立て
// ---------------------------------------------------------------------------

/**
 * 日本語ヘッダ用の RFC 2047 エンコード。
 * encoded-word は1つ75文字以内の制約があるため、マルチバイトを壊さない位置で
 * 分割して複数ワードに折る。
 */
function encodeWord(str) {
  const chunks = [];
  let buf = "";
  for (const ch of str) {
    if (Buffer.byteLength(buf + ch, "utf8") > 33) {
      chunks.push(buf);
      buf = "";
    }
    buf += ch;
  }
  if (buf) chunks.push(buf);
  return chunks
    .map((c) => `=?UTF-8?B?${Buffer.from(c, "utf8").toString("base64")}?=`)
    .join("\r\n "); // 折り返しの継続行
}

function buildMessage({ from, to, subject, html }) {
  // 本文はbase64（76桁折り）。base64にはドットが無く、SMTPのドットスタッフィングも不要になる
  const body = Buffer.from(html, "utf8")
    .toString("base64")
    .replace(/(.{76})/g, "$1\r\n");
  return [
    `From: ${encodeWord("福祉情報ウォッチ")} <${from}>`,
    `To: ${to.join(", ")}`,
    `Subject: ${encodeWord(subject)}`,
    `Date: ${new Date().toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: <${randomBytes(12).toString("hex")}@fukushi-watch>`,
    "MIME-Version: 1.0",
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    body,
  ].join("\r\n");
}

// ---------------------------------------------------------------------------
// SMTP クライアント（SMTPS: 接続時からTLS）
// ---------------------------------------------------------------------------

function smtpSend({ user, pass, to, message }) {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: SMTP_HOST, port: SMTP_PORT, servername: SMTP_HOST });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`SMTPがタイムアウトしました（${TIMEOUT_MS / 1000}秒）`));
    }, TIMEOUT_MS);

    let buffer = "";
    let waiter = null; // { expect, resolve, reject }

    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      // 応答の完了 = 「NNN<空白>」で始まる行（「NNN-」は継続行）
      const lines = buffer.split("\r\n");
      for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(/^(\d{3}) /);
        if (m && waiter) {
          const consumed = lines.slice(0, i + 1).join("\r\n");
          buffer = lines.slice(i + 1).join("\r\n");
          const w = waiter;
          waiter = null;
          if (m[1] === String(w.expect)) w.resolve(consumed);
          else w.reject(new Error(`SMTP ${w.step}: 期待${w.expect}に対し応答「${lines[i]}」`));
          return;
        }
      }
    });
    socket.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });

    const expect = (step, code) =>
      new Promise((res, rej) => {
        waiter = { step, expect: code, resolve: res, reject: rej };
      });
    const send = (line) => socket.write(line + "\r\n");

    (async () => {
      await expect("接続", 220);
      send("EHLO fukushi-watch");
      await expect("EHLO", 250);
      send("AUTH LOGIN");
      await expect("AUTH", 334);
      send(Buffer.from(user, "utf8").toString("base64"));
      await expect("ユーザー名", 334);
      send(Buffer.from(pass, "utf8").toString("base64"));
      await expect("認証", 235);
      send(`MAIL FROM:<${user}>`);
      await expect("MAIL FROM", 250);
      for (const rcpt of to) {
        send(`RCPT TO:<${rcpt}>`);
        await expect(`RCPT TO(${rcpt})`, 250);
      }
      send("DATA");
      await expect("DATA", 354);
      socket.write(message + "\r\n.\r\n");
      await expect("本文送信", 250);
      send("QUIT");
      await expect("QUIT", 221);
      socket.end();
      clearTimeout(timer);
      resolve();
    })().catch((e) => {
      clearTimeout(timer);
      socket.destroy();
      reject(e);
    });
  });
}

// ---------------------------------------------------------------------------
// メイン
// ---------------------------------------------------------------------------

/**
 * 分野設定による重み付け（P6）。絞り込みではない:
 * 設定分野と交わらない「分野限定」の項目だけを、メール上で低に落として残す。
 * 「共通」タグと分野なし（空配列）の項目は降格しない。
 * ⚠️ ここで書き換えるのはメール用のメモリ上のコピーのみ。report-latest.json には
 *    書き戻さない（履歴には分野中立の判定をそのまま残す＝archive.js が後で読む）。
 */
function applyFieldWeighting(report) {
  let selected = [];
  try {
    if (existsSync(MAIL_SETTINGS_PATH)) {
      selected = JSON.parse(readFileSync(MAIL_SETTINGS_PATH, "utf8")).fields ?? [];
    }
  } catch {
    selected = []; // 設定が壊れていても全分野扱いで送る（メールを止めない）
  }
  if (selected.length === 0) return report; // 設定なし=全分野（降格しない）
  const items = (report.items ?? []).map((it) => {
    const fields = it.fields ?? []; // 旧データは分野なし扱い
    if (fields.length === 0 || fields.includes("共通")) return it;
    const hit = fields.some((f) => selected.includes(f));
    return hit ? it : { ...it, importance: "低" };
  });
  return { ...report, items };
}

async function main() {
  const { user, pass, to } = loadEnv();
  const state = loadState();
  const today = jstToday();
  const now = new Date();

  // 対策2（P49）: 同じ日に2度目が走ったら送らない。⚠️保険の2本目（JST 08:47）は
  // 「1本目が飛んだ日の回収」が目的なので、1本目が送れた日は巡回だけして黙る
  if (state.lastSentDate === today) {
    console.log(`本日（${today}）は送信済みのため送信を省略します（保険の実行）`);
    if (!dryRun) saveState({ ...state, lastRunAt: now.toISOString() });
    return;
  }

  const report = applyFieldWeighting(
    JSON.parse(readFileSync(REPORT_PATH, "utf8"))
  );
  // 対策3（P49）: 前回の自動実行から空きすぎていたら、本文の冒頭で知らせる
  const staleHours = staleHoursSince(state.lastRunAt, now);
  if (staleHours) console.log(`⚠️前回の自動実行から${staleHours}時間空いています（不発の可能性）`);
  const { subject, html } = buildMail(report, { staleHours });
  const message = buildMessage({ from: user, to, subject, html });

  console.log(`送信: 「${subject}」 → ${to.length}宛`);
  if (dryRun) {
    console.log("（下見のため送信しません）");
    return;
  }
  await smtpSend({ user, pass, to, message });
  console.log("送信完了");
  // ⚠️記録は**送信の後**。送信に失敗した日は記録されないので、保険の2本目が送る
  saveState({ ...state, lastSentDate: today, lastRunAt: now.toISOString() });
}

// ⚠️直接実行のときだけ送る。ここを守らないと、検証スクリプトが
//   staleHoursSince を import しただけで**本物のメールが飛ぶ**（kenshu.js と同じ作法）
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop());
if (isMain) {
  main().catch((e) => {
    // 送信失敗は握りつぶさない（Actions もこの終了コードで失敗になる）
    console.error(`エラー: ${e.message}`);
    process.exit(1);
  });
}
