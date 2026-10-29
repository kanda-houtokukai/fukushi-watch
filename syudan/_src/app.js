/* 集団指導 特設ページの画面。データは build.py が埋め込む #data（資料の一覧・見出し・見出しごとの要点）と、
   探すときに読む kw.json（見出しで区切った単位ごとの語の索引。文は持たない）。
   画面の切り替えは URL の # で行う:
     #home / #svc / #svc-<id> / #ch-<資料>-<章の番号>（?i=<見出しの番号> でその見出しを開く）/ #search?q=…&d=… / #sources
   要点（notes）は県の資料を自分の言葉でまとめたもの。原文は持たず、どの見出しにもPDFの該当ページへのリンクを付ける。 */
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const D = JSON.parse($("data").textContent);
  const DOCS = D.docs, TOC = D.toc, NOTES = D.notes || {};
  const BY = Object.fromEntries(TOC.map((d) => [d.id, d]));
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const EXT = '<svg class="ext" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3h7v7M13 3 6 10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const ARR = '<svg class="pa" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3l5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const ARL = '<svg class="pa" viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3 5 8l5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const pdf = (u, p) => u + (p ? "#page=" + p : "");
  const A = (u, inner, cls) => `<a${cls ? ` class="${cls}"` : ""} href="${esc(u)}" target="_blank" rel="noopener">${inner}</a>`;

  /* サービスの区分（県の資料の区分）。common＝全事業所共通編。docs＝見出しを持つ資料（toc の id） */
  const SVC = [{ id: "common", t: "全事業所共通", names: "すべての事業所", docs: ["common", "kaitei"] }]
    .concat(DOCS.services.map((s) => Object.assign({}, s, { docs: s.id === "ji" ? ["ji", "dbs"] : [s.id] })));
  const SV = Object.fromEntries(SVC.map((s) => [s.id, s]));
  const SVC_OF = {};
  SVC.forEach((s) => s.docs.forEach((d) => { SVC_OF[d] = s.id; }));
  /* 「探す」の絞り込みの短い呼び名 */
  const SHORT = { common: "全事業所共通編", kyotaku: "居宅訪問系", nicchu: "通所・入所系", gh: "共同生活援助", ji: "障がい児系", dbs: "こども性暴力防止法", soudan: "相談支援系", kaitei: "令和8年度報酬改定（国）" };
  const itemOf = (docId) => DOCS.items.find((i) => i.id === docId);
  /* 点検・減算・年間（tenken.js）が足す画面と部品の差し込み口 */
  const EXT_ROUTES = [], ON_ROUTE = [], CH_EXTRA = [], SVC_EXTRA = [];

  /* 章とその節を出てきた順に並べたもの（extract.py の index_segments と同じ並び）。
     f[h] = { t: 見出し, p: 頁, c: 章の番号（1から）, sec: 章の見出し（節のとき）} */
  const FLAT = Object.fromEntries(TOC.map((d) => {
    const f = [];
    d.secs.forEach((s, ci) => {
      f.push({ t: s.t, p: s.p, c: ci + 1, sec: null });
      s.sub.forEach((x) => f.push({ t: x.t, p: x.p, c: ci + 1, sec: s.t }));
    });
    return [d.id, f];
  }));
  const chapStart = (docId, c) => FLAT[docId].findIndex((x) => x.c === c && !x.sec);
  const note = (docId, h) => (NOTES[docId] || {})[h];
  const chHref = (docId, c, h) => `#ch-${docId}-${c}` + (h != null && h !== chapStart(docId, c) ? `?i=${h}` : "");

  function chapterRange(doc, i) {
    const s = doc.secs[i], nx = doc.secs[i + 1];
    const end = nx ? Math.max(s.p, nx.p - 1) : doc.pages;
    return s.p === end ? "p." + s.p : "p." + s.p + "–" + end;
  }

  /* 要点の中身（概要・要点・運営指導での主な指摘）。章のページの見出しの中と、見出しのない資料で使う */
  function noteBody(n, cls) {
    if (!n) return "";
    let h = n.gist ? `<p class="${cls || "gist"}">${esc(n.gist)}</p>` : "";
    if (n.points && n.points.length) h += `<ul class="pts">${n.points.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>`;
    if (n.shiteki && n.shiteki.length) h += `<div class="sh"><span class="sh-h">運営指導での主な指摘</span><ul>${n.shiteki.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>`;
    return h;
  }
  function itemRow(it) {
    const ty = it.kind && it.kind !== "HTML" ? it.kind : (it.kind === "HTML" ? "ページ" : "");
    const nt = [it.size, it.note ? "※" + it.note : ""].filter(Boolean).join("　");
    return `<li>${A(it.u, esc(it.t))}${ty ? `<span class="ty">${esc(ty)}</span>` : ""}${nt ? `<span class="note">${esc(nt)}</span>` : ""}</li>`;
  }
  function groupLabel(g) {
    const x = DOCS.groups.find((y) => y.g === g);
    return x ? x.label : g;
  }
  function setSubnav(html) {
    $("subnav").innerHTML = html;
    // スマホの横に流れる札は、選んでいる札が見えるところまで横にだけ寄せる（縦には動かさない）
    const ol = $("subnav").querySelector("ol"), on = $("subnav").querySelector("a.is-active");
    if (ol && on && ol.scrollWidth > ol.clientWidth) ol.scrollLeft = Math.max(0, on.parentElement.offsetLeft - 16);
  }

  /* ── ホーム・サービス ── */
  function svcCard(s) {
    const pages = s.docs.reduce((n, id) => n + (BY[id] ? BY[id].pages : 0), 0);
    const heads = s.docs.reduce((n, id) => n + (BY[id] ? FLAT[id].length : 0), 0);
    return `<a class="svc-card" href="#svc-${s.id}"><b>${esc(s.t)}</b><span>${esc(s.names)}</span><span class="m">${pages}ページ・見出し${heads}</span></a>`;
  }
  function renderHome() {
    $("svc-home").innerHTML = SVC.map(svcCard).join("");
    const c = BY.common;
    $("common-quick").innerHTML = c.secs.map((s, i) =>
      `<li><a href="#ch-common-${i + 1}"><span class="t">${esc(s.t)}</span><span class="pg">${chapterRange(c, i)}</span></a></li>`).join("");
    const links = [[DOCS.page, DOCS.pageTitle || "県の集団指導のページ"], [DOCS.schedule, "日程表"], [DOCS.register, "受講登録のフォーム"]].filter((x) => x[0]);
    $("pref-links").innerHTML = links.map((x) => `<li>${A(x[0], esc(x[1]) + EXT)}</li>`).join("")
      + `<li><a href="#sources">資料一覧（${DOCS.items.length}点）</a></li>`;
    if (DOCS.extractedAt) {
      const [y, m, d] = DOCS.extractedAt.split("-").map(Number);
      $("extracted").textContent = `資料の取得 ${y}年${m}月${d}日`;
    }
    $("year").textContent = DOCS.year || "";
    const dl = DOCS.registerDeadline;
    if (dl) {
      const [y, m, d] = dl.split("-").map(Number);
      $("reg-date").textContent = `${y}.${m}.${d}`;
      const DAY = 864e5, JST = 9 * 36e5;
      const today = Math.floor((Date.now() + JST) / DAY) * DAY - JST;
      const left = Math.round((Date.parse(dl + "T00:00:00+09:00") - today) / DAY);
      $("reg-left").innerHTML = left > 0 ? `${m}月${d}日まで あと<b>${left}</b>日` : (left === 0 ? `本日（${m}月${d}日）が期限` : `${m}月${d}日で期限を過ぎました`);
      $("reg-go").href = DOCS.register;
      if (left < 0) $("reg-go").hidden = true;
    } else {
      $("dateplate").hidden = true;
    }
    $("foot-page").href = DOCS.page;
  }
  function svcNav(active) {
    return "<ol>" + SVC.map((x) => {
      const pages = x.docs.reduce((n, d) => n + (BY[d] ? BY[d].pages : 0), 0);
      return `<li><a href="#svc-${x.id}"${x.id === active ? ' class="is-active" aria-current="page"' : ""}><span>${esc(x.t)}</span><span class="c">${pages}p</span></a></li>`;
    }).join("") + "</ol>";
  }
  function docBlock(doc) {
    const it = itemOf(doc.id) || {};
    const meta = [doc.pages + "ページ", it.size].filter(Boolean).join("・");
    let h = `<div class="doc"><div class="doc-h"><h2>${esc(doc.t)}</h2><span class="meta">${esc(meta)}</span>`
      + A(pdf(doc.u), "PDFを開く" + EXT, "open") + "</div>";
    if (it.note) h += `<p class="vsub doc-note">${esc("※" + it.note)}</p>`;
    if (!doc.secs.length) {   // 見出しのない短い資料は、要点をその場に出す
      return h + `<div class="doc-solo">${noteBody(note(doc.id, -1))}</div></div>`;
    }
    h += '<ol class="chl">';
    doc.secs.forEach((s, i) => {
      const n = note(doc.id, chapStart(doc.id, i + 1));
      h += `<li><a href="#ch-${doc.id}-${i + 1}"><span class="t">${esc(s.t)}</span>`
        + (n && n.gist ? `<span class="g">${esc(n.gist)}</span>` : "")
        + `<span class="n">${chapterRange(doc, i)}${s.sub.length ? "・" + s.sub.length + "項目" : ""}</span>${ARR}</a></li>`;
    });
    return h + "</ol></div>";
  }
  function renderSvcIndex() {
    $("svc-index").innerHTML = SVC.map(svcCard).join("");
  }
  function renderSvc(id) {
    const s = SV[id];
    let h = `<div class="svc-head"><h1 class="vh">${esc(s.t)}</h1>`;
    if (s.names !== s.t) h += `<p class="svc-names">${esc(s.names)}</p>`;
    h += findForm(s.docs.join(","), "q-svc", s.t + "の資料の中を探す", "この資料の中を探す") + "</div>";
    h += s.docs.filter((d) => BY[d]).map((d) => docBlock(BY[d])).join("");
    h += SVC_EXTRA.map((fn) => fn(id)).join("");
    const extra = DOCS.items.filter((it) => it.part === "説明資料" && !it.id && it.svc.includes(id) && it.kind !== "HTML");
    if (extra.length) h += `<section class="also"><h2>説明資料と一緒に掲載された資料</h2><ul class="rows">${extra.map(itemRow).join("")}</ul></section>`;
    if (id !== "common") {
      h += `<section class="also"><h2>あわせて見る</h2><ul class="rows"><li><a href="#svc-common">全事業所共通編の説明資料</a><span class="note">指導監督の方針・行政処分の事例・虐待防止・事故・処遇改善など</span></li>`
        + `<li><a href="#ch-kaitei-1">令和8年度報酬改定について</a><span class="note">国の資料（${BY.kaitei.pages}ページ）。処遇改善加算の拡充と、臨時応急的な見直し</span></li></ul></section>`;
    }
    const refs = DOCS.items.filter((it) => it.part === "参考資料" && !it.id && (id === "common" ? it.svc.includes("*") : it.svc.includes(id)));
    if (refs.length) {
      const groups = [...new Set(refs.map((r) => r.g))];
      h += `<section class="refs"><h2>参考資料</h2>` + groups.map((g) =>
        `<h3>${esc(groupLabel(g))}</h3><ul class="rows">${refs.filter((r) => r.g === g).map(itemRow).join("")}</ul>`).join("") + "</section>";
    }
    $("svc-body").innerHTML = h;
    setSubnav(svcNav(id));
    document.title = s.t + "｜集団指導 特設ページ";
  }
  function findForm(scope, id, label, ph) {
    return `<form class="find inline" data-scope="${scope}" role="search"><label class="sr" for="${id}">${esc(label)}</label>`
      + '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.5" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="m12.6 12.6 4.4 4.4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>'
      + `<input type="search" id="${id}" placeholder="${esc(ph)}" autocomplete="off" enterkeyhint="search"><button type="submit">探す</button></form>`;
  }

  /* ── 章のページ（見出しを押すと、その場で概要・要点・指摘が開く） ── */
  function renderChapter(docId, c, openH) {
    const doc = BY[docId], s = doc.secs[c - 1], svc = SV[SVC_OF[docId]];
    const h0 = chapStart(docId, c), cn = note(docId, h0);
    let h = `<p class="crumbs"><a href="#svc-${svc.id}">${esc(svc.t)}</a><span aria-hidden="true">›</span><span>${esc(doc.t)}</span></p>`
      + `<h1 class="vh">${esc(s.t)}</h1>`
      + `<div class="ch-meta"><span>${chapterRange(doc, c - 1)}</span>${s.sub.length ? `<span>${s.sub.length}項目</span>` : ""}`
      + A(pdf(doc.u, s.p), `PDFの${s.p}ページを開く` + EXT, "pdf-go") + "</div>";
    if (cn) {
      h += `<div class="ch-note">${noteBody(cn, "lead")}</div>`;
    }
    if (s.sub.length) {
      h += `<div class="it-bar"><button type="button" class="openall" aria-pressed="false">すべて開く</button></div><div class="its">`;
      s.sub.forEach((x, k) => {
        const hi = h0 + 1 + k, n = note(docId, hi);
        h += `<details class="it" data-h="${hi}"${hi === openH ? " open" : ""}><summary><span class="t">${esc(x.t)}</span><span class="pg">p.${x.p}</span></summary>`
          + `<div class="it-b">${noteBody(n)}`
          + CH_EXTRA.map((fn) => fn(docId, hi)).join("")
          + A(pdf(doc.u, x.p), `PDFの${x.p}ページを開く` + EXT, "pdf-go")
          + "</div></details>";
      });
      h += "</div>";
    }
    // 前後の章（同じ資料の中）
    const prev = c > 1 ? doc.secs[c - 2] : null, next = c < doc.secs.length ? doc.secs[c] : null;
    if (prev || next) {
      h += `<nav class="pager two" aria-label="前後の章">`
        + (prev ? `<a class="prev" href="#ch-${docId}-${c - 1}">${ARL}<span class="pk">前へ</span><span class="pt">${esc(prev.t)}</span><span class="ps">前へ</span></a>` : "<span></span>")
        + (next ? `<a class="next" href="#ch-${docId}-${c + 1}"><span class="pk">次へ</span><span class="pt">${esc(next.t)}</span>${ARR}</a>` : "")
        + "</nav>";
    }
    $("ch-body").innerHTML = h;
    // 左の列（PC）／横に流れる札（スマホ）は、この資料の章
    setSubnav(`<a class="sn-back" href="#svc-${svc.id}">${ARL}<span>${esc(svc.t)}</span></a><ol>` + doc.secs.map((x, i) =>
      `<li><a href="#ch-${docId}-${i + 1}"${i + 1 === c ? ' class="is-active" aria-current="page"' : ""}><span>${esc(x.t)}</span><span class="c">${x.sub.length || ""}</span></a></li>`).join("") + "</ol>");
    document.title = s.t + "｜" + doc.t;
  }
  $("ch-body").addEventListener("click", (e) => {
    const b = e.target.closest(".openall");
    if (!b) return;
    const open = b.getAttribute("aria-pressed") !== "true";
    document.querySelectorAll("#ch-body details.it").forEach((d) => { d.open = open; });
    b.setAttribute("aria-pressed", String(open));
    b.textContent = open ? "すべて閉じる" : "すべて開く";
  });

  /* ── 探す（語の索引と要点の文で、見出しを引く） ── */
  let KW = null, kwLoading = null;
  function loadKW() {
    if (KW) return Promise.resolve(KW);
    if (!kwLoading) {
      kwLoading = fetch("kw.json", { cache: "no-cache" }).then((r) => r.json()).then((j) => {
        // 索引のキーは「資料:頁:見出しの番号」。頁を見出しの位置で区切った単位ごとに語の集合を持つ
        const segs = {};
        j.docs.forEach((id) => { segs[id] = []; });
        Object.entries(j.pages).forEach(([k, v]) => {
          const [di, p, h] = k.split(":").map(Number);
          segs[j.docs[di]].push({ p, h, w: "|" + v + "|" });
        });
        KW = segs;
        return KW;
      }).catch((e) => { kwLoading = null; throw e; });
    }
    return kwLoading;
  }
  const RUN = /[一-龥々〆ヵヶ]+|[ァ-ヴー]+|[A-Za-z0-9]+/g;   // extract.py の WORD と同じ区切り
  const JOIN = /[A-Za-z0-9]+[一-龥々〆ヵヶ]/g;               // extract.py の JOIN と同じ
  function terms(q) {
    q = (q || "").normalize("NFKC").trim();
    // ひらがなだけの語はカタカナに直して探す（例: ひやりはっと → ヒヤリハット）
    const parts = q.split(/\s+/).filter(Boolean).map((w) => /^[ぁ-ゖー]+$/.test(w) ? w.replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60)) : w);
    const out = [];
    const add = (r) => { if (!out.includes(r)) out.push(r); };
    parts.forEach((w) => {
      // 「A型」「33条」のような英数字＋漢字1字は、つながりのまま探す（extract.py の JOIN）。残りは連なりごとに
      (w.match(JOIN) || []).forEach(add);
      (w.replace(JOIN, " ").match(RUN) || []).forEach(add);
    });
    return out;
  }
  // 要点の文（見出し＋概要＋要点＋指摘）を、探すために空白を除いた形で持つ
  const NOTE_TEXT = {};
  TOC.forEach((d) => {
    NOTE_TEXT[d.id] = {};
    const ids = FLAT[d.id].length ? FLAT[d.id].map((_, h) => h) : [-1];
    ids.forEach((h) => {
      const n = note(d.id, h) || {}, f = FLAT[d.id][h];
      NOTE_TEXT[d.id][h] = [f ? f.t : d.t, n.gist, ...(n.points || []), ...(n.shiteki || [])].join(" ").normalize("NFKC").replace(/\s+/g, "");
    });
  });
  function mark(text, ts) {
    let h = esc(text);
    ts.forEach((t) => { h = h.split(esc(t)).join("<mark>" + esc(t) + "</mark>"); });
    return h;
  }
  let scope = "";   // 絞り込む資料（toc の id を「,」で）。空ならすべて
  function renderScope() {
    const opts = [["", "すべて"]].concat(TOC.map((d) => [d.id, SHORT[d.id] || d.t]));
    const custom = scope && !opts.some((o) => o[0] === scope);
    if (custom) opts.splice(1, 0, [scope, scope.split(",").map((x) => SHORT[x] || x).join("＋")]);
    $("scope").innerHTML = opts.map(([v, t]) => `<button type="button" data-v="${v}" aria-pressed="${v === scope}">${esc(t)}</button>`).join("");
  }
  async function runSearch(q) {
    const ts = terms(q);
    $("q-main").value = q || "";
    renderScope();
    if (!ts.length) {
      $("s-sum").textContent = q ? "漢字・カタカナ・英数字を含む語で探してください" : "";
      $("s-res").innerHTML = "";
      return;
    }
    $("s-sum").textContent = "索引を読み込んでいます…";
    let kw;
    try { kw = await loadKW(); } catch (e) { $("s-sum").textContent = "索引を読み込めませんでした。時間をおいて開き直してください"; return; }
    const want = scope ? scope.split(",") : TOC.map((d) => d.id);
    let total = 0, ndoc = 0, h = "";
    TOC.filter((d) => want.includes(d.id)).forEach((doc) => {
      // 見出しごとに、見つかったPDFのページを集める（資料の本文の語の索引）＋要点の文に含むもの
      const byH = new Map();
      (kw[doc.id] || []).forEach((sg) => {
        if (!ts.every((t) => sg.w.includes(t))) return;
        if (!byH.has(sg.h)) byH.set(sg.h, new Set());
        byH.get(sg.h).add(sg.p);
      });
      Object.entries(NOTE_TEXT[doc.id]).forEach(([hh, txt]) => {
        const k = Number(hh);
        if (ts.every((t) => txt.includes(t)) && !byH.has(k)) byH.set(k, new Set());
      });
      if (!byH.size) return;
      const hs = [...byH.keys()].sort((a, b) => a - b);
      total += hs.length; ndoc++;
      const rows = hs.map((k) => {
        const f = FLAT[doc.id][k], n = note(doc.id, k);
        const pages = [...byH.get(k)].sort((a, b) => a - b);
        const p0 = pages[0] || (f ? f.p : 1);
        const head = f ? f.t : (doc.secs.length ? "表紙・目次" : doc.t);
        const href = f ? chHref(doc.id, f.c, k) : (doc.secs.length ? null : `#svc-${SVC_OF[doc.id]}`);
        const inner = `<span class="h">${mark(head, ts)}</span>`
          + (f && f.sec ? `<span class="c">${esc(f.sec)}</span>` : "")
          + (n && n.gist ? `<span class="g">${mark(n.gist, ts)}</span>` : "");
        const main = href ? `<a class="hit" href="${href}">${inner}</a>` : `<span class="hit">${inner}</span>`;
        const pl = pages.length ? pages.slice(0, 4).map((p) => "p." + p).join("・") + (pages.length > 4 ? "ほか" : "") : "p." + p0;
        return `<li>${main}${A(pdf(doc.u, p0), `<span>PDF</span><span>${pl}</span>`, "hit-pdf")}</li>`;
      });
      const LIM = 30;
      h += `<section class="s-doc"><h2>${esc(doc.t)}<small>${hs.length}件</small></h2><ul class="hits">${rows.slice(0, LIM).join("")}</ul>`
        + (rows.length > LIM ? `<ul class="hits" hidden>${rows.slice(LIM).join("")}</ul><button type="button" class="more">残り${rows.length - LIM}件を表示</button>` : "")
        + "</section>";
    });
    const tl = ts.map((t) => "「" + t + "」").join("");
    const long = ts.some((t) => t.length >= 4 && /^[一-龥々〆ヵヶ]+$/.test(t));
    $("s-sum").innerHTML = total ? `${esc(tl)}が出てくる見出し <b>${total}</b>（${ndoc}編）`
      : `${esc(tl)}が出てくる見出しは見つかりませんでした` + (long ? "。語を空白で区切ると見つかることがあります（例：虐待防止 委員会）" : "");
    $("s-res").innerHTML = h;
  }
  $("s-res").addEventListener("click", (e) => {
    const b = e.target.closest(".more");
    if (!b) return;
    b.previousElementSibling.hidden = false;
    b.remove();
  });
  $("scope").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    scope = b.dataset.v;
    go("#search?" + qs($("q-main").value, scope), true);
  });
  const qs = (q, s) => new URLSearchParams(Object.assign({ q: q || "" }, s ? { d: s } : {})).toString();
  document.addEventListener("submit", (e) => {
    const f = e.target.closest(".find");
    if (!f) return;
    e.preventDefault();
    const q = f.querySelector("input").value;
    if (f.dataset.scope !== undefined) scope = f.dataset.scope;
    else if (f.id === "find-home") scope = "";
    go("#search?" + qs(q, scope));
  });

  /* ── 画面の切り替え ── */
  function go(hash, replace) {
    clicked = true;
    if (replace) { history.replaceState(history.state, "", hash); route(); }
    else location.hash = hash;
  }
  try { history.scrollRestoration = "manual"; } catch (e) { /* 古いブラウザ */ }
  let lastKey = null;
  function route() {
    // 離れるページの位置を覚えておく（戻る操作で同じ位置に出すため）
    if (lastKey) {
      try {
        sessionStorage.setItem("y:" + lastKey, String(window.scrollY));
        // 章のページは、開いていた見出しも覚える（戻ったときに同じ見え方にするため）
        const open = [...document.querySelectorAll("#ch-body details.it[open]")].map((d) => d.dataset.h);
        sessionStorage.setItem("o:" + lastKey, open.join(","));
      } catch (e) { /* 保存できない環境 */ }
    }
    const raw = location.hash.slice(1) || "home";
    const [name, query] = raw.split("?");
    const params = new URLSearchParams(query || "");
    let view = "home", g = "home", openH = null;
    let m, ext = null;
    for (const fn of EXT_ROUTES) { ext = fn(name, params); if (ext) break; }
    if (ext) { view = ext.view; g = ext.g; }
    else if (name === "svc") { view = "svc"; g = "svc"; renderSvcIndex(); setSubnav(""); document.title = "サービス別｜集団指導 特設ページ"; }
    else if (name.startsWith("svc-") && SV[name.slice(4)]) { view = "svcview"; g = "svc"; renderSvc(name.slice(4)); }
    else if ((m = name.match(/^ch-([a-z]+)-(\d+)$/)) && BY[m[1]] && BY[m[1]].secs[Number(m[2]) - 1]) {
      view = "chview"; g = "svc";
      openH = params.has("i") ? Number(params.get("i")) : null;
      renderChapter(m[1], Number(m[2]), openH);
    } else if (name === "search") {
      view = "search"; g = "search";
      scope = params.get("d") || "";
      runSearch(params.get("q") || "");
      document.title = "資料の中を探す｜集団指導 特設ページ";
    } else if (name === "sources") { view = "sources"; g = "sources"; document.title = "資料一覧｜集団指導 特設ページ"; }
    else document.title = "令和8年度 福岡県 集団指導 特設ページ";
    document.querySelectorAll(".view").forEach((v) => v.classList.toggle("is-active", v.id === view));
    document.querySelectorAll("a[data-g]").forEach((a) => {
      const on = a.dataset.g === g;
      a.classList.toggle("is-active", on);
      if (on) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
    });
    const shell = $("shell");
    shell.classList.toggle("no-sub", view !== "svcview" && view !== "chview" && !(ext && ext.sub));
    shell.classList.toggle("is-home", view === "home");
    // 位置: 押して移ったときは先頭から（開く見出しの指定があればその見出し）、戻る・進むの操作では離れたときの位置
    lastKey = raw;
    let y = null;
    if (!clicked) {
      try {
        const v = sessionStorage.getItem("y:" + raw); if (v != null) y = Number(v);
        const o = sessionStorage.getItem("o:" + raw);
        if (o && view === "chview") o.split(",").forEach((h) => { const d = document.querySelector(`#ch-body details.it[data-h="${h}"]`); if (d) d.open = true; });
      } catch (e) { /* なし */ }
    }
    ON_ROUTE.forEach((fn) => fn(view, name, params));
    clicked = false;
    if (y != null) window.scrollTo(0, y);
    else if (openH != null) {
      const el = document.querySelector(`#ch-body details.it[data-h="${openH}"]`);
      if (el) { window.scrollTo(0, 0); el.scrollIntoView({ block: "start" }); } else window.scrollTo(0, 0);
    } else window.scrollTo(0, 0);
    if (view === "search" && !$("q-main").value && matchMedia("(hover: hover)").matches) $("q-main").focus();
  }
  // リンクを押して移ったか（先頭から）、戻る・進むの操作か（離れた位置）を、押したときの印で見分ける
  // （popstate は # のリンクを押したときにも起きるので当てにしない）
  let clicked = true;
  document.addEventListener("click", (e) => {
    const a = e.target.closest('a[href^="#"]');
    if (a && a.getAttribute("href") !== location.hash) clicked = true;
  }, true);
  /*@TENKEN@*/
  window.addEventListener("hashchange", route);
  renderHome();
  route();

  /* 資料一覧の絞り込み（scripts/linkbook.py の部品） */
  const lq = $("lk-q");
  if (lq) lq.addEventListener("input", () => {
    const ws = lq.value.normalize("NFKC").toLowerCase().split(/\s+/).filter(Boolean);
    let n = 0;
    document.querySelectorAll("#lk .lk-g").forEach((gr) => {
      let shown = 0;
      gr.querySelectorAll(".lk-i").forEach((li) => {
        const t = (li.dataset.q || "").normalize("NFKC").toLowerCase();
        const ok = ws.every((w) => t.includes(w));
        li.hidden = !ok;
        if (ok) shown++;
      });
      gr.hidden = !shown;
      n += shown;
    });
    document.querySelector("#lk .lk-none").hidden = n > 0;
  });
})();
