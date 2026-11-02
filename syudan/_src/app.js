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
  /* 分野（障がい・高齢・保育）ごとの違いは build.py が D.field に入れる */
  const F = D.field;
  const BY = Object.fromEntries(TOC.map((d) => [d.id, d]));
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const EXT = '<svg class="ext" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3h7v7M13 3 6 10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const ARR = '<svg class="pa" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3l5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const ARL = '<svg class="pa" viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3 5 8l5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const pdf = (u, p) => u + (p ? "#page=" + p : "");
  const A = (u, inner, cls) => `<a${cls ? ` class="${cls}"` : ""} href="${esc(u)}" target="_blank" rel="noopener">${inner}</a>`;

  /* サービスの区分（県の資料の区分）。common＝全事業所共通編。docs＝見出しを持つ資料（toc の id） */
  const SVC = [F.common]
    .concat(DOCS.services.map((s) => Object.assign({}, s, { docs: s.docs || (F.svcDocs || {})[s.id] || [s.id] })));
  const SV = Object.fromEntries(SVC.map((s) => [s.id, s]));
  const SVC_OF = {};
  SVC.forEach((s) => s.docs.forEach((d) => { SVC_OF[d] = s.id; }));
  /* 「探す」の絞り込みの短い呼び名 */
  const SHORT = F.short || {};
  const itemOf = (docId) => DOCS.items.find((i) => i.id === docId);
  /* 点検・減算・年間（tenken.js）が足す画面と部品の差し込み口 */
  const EXT_ROUTES = [], ON_ROUTE = [], CH_EXTRA = [], SVC_EXTRA = [];
  /* テーマ（themes_build.py が見出しを振り分けたもの）。THEME_CHIPS・THEME_VIS・SVC_TOP は tenken.js が足す
     （障がいは、区分の中の国のサービスで絞る。高齢は、区分の中の資料で絞る） */
  const TH = D.themes || null;
  const TH_NAME = TH ? Object.fromEntries(TH.list.map((x) => [x.id, x.t])) : {};
  const THEME_CHIPS = [], THEME_VIS = [], SVC_TOP = [];

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
    if (SVC.length < 2) $("hb-svc").hidden = true;   // サービスの区分がない分野（保育）は、資料の章をそのまま並べる
    $("common-quick").innerHTML = F.commonQuick.filter((id) => BY[id]).map((id) => {
      const c = BY[id];
      if (!c.secs.length) return `<li><a href="#svc-${SVC_OF[id]}"><span class="t">${esc(c.t)}</span><span class="pg">${c.pages}p</span></a></li>`;
      return c.secs.map((s, i) => `<li><a href="#ch-${id}-${i + 1}"><span class="t">${esc(s.t)}</span><span class="pg">${chapterRange(c, i)}</span></a></li>`).join("");
    }).join("");
    const links = F.prefLinks.filter((x) => x[0]);
    $("pref-links").innerHTML = links.map((x) => `<li>${A(x[0], esc(x[1]) + EXT)}</li>`).join("")
      + `<li><a href="#sources">資料一覧（${DOCS.items.length}点）</a></li>`;
    const site = F.site || [];
    $("site-links").innerHTML = site.map((x) => `<li><a href="${esc(x[0])}">${esc(x[1])}</a><span class="note">${esc(x[2])}</span></li>`).join("");
    $("hb-site").hidden = !site.length;
    if (DOCS.extractedAt) {
      const [y, m, d] = DOCS.extractedAt.split("-").map(Number);
      $("extracted").textContent = `資料の取得 ${y}年${m}月${d}日`;
    }
    const pl = F.plate || {}, dl = pl.date;
    if (dl) {
      const [y, m, d] = dl.split("-").map(Number);
      $("reg-date").textContent = `${y}.${m}.${d}`;
      const DAY = 864e5, JST = 9 * 36e5;
      const today = Math.floor((Date.now() + JST) / DAY) * DAY - JST;
      const left = Math.round((Date.parse(dl + "T00:00:00+09:00") - today) / DAY);
      $("reg-left").innerHTML = left > 0 ? `${m}月${d}日まで あと<b>${left}</b>日` : (left === 0 ? `本日（${m}月${d}日）が期限` : `${m}月${d}日で期限を過ぎました`);
      $("plate-k").textContent = pl.k;
      if (pl.link && left >= 0) { $("reg-go").href = pl.link; $("reg-go-t").textContent = pl.linkLabel; } else $("reg-go").hidden = true;
    } else {
      $("dateplate").hidden = true;
    }
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
  function renderSvc(id, chip) {
    const s = SV[id];
    const withTh = TH && id !== "common";
    chip = withTh ? okChip(s, chip) : "";
    let h = `<div class="svc-head"><h1 class="vh">${esc(s.t)}</h1>`;
    if (s.names !== s.t) h += `<p class="svc-names">${esc(s.names)}</p>`;
    if (withTh) h += chipRow(s, chip, (v) => svcHref(id, v));
    h += findForm(s.docs.join(","), "q-svc", s.t + "の資料の中を探す", "この資料の中を探す") + "</div>";
    if (withTh) {
      h += SVC_TOP.map((fn) => fn(id, chip)).join("");
      h += themeList(s, chip);
      h += '<h2 class="sec-h2">県の資料の並びで読む</h2>';
    }
    h += s.docs.filter((d) => BY[d]).map((d) => docBlock(BY[d])).join("");
    h += SVC_EXTRA.map((fn) => fn(id)).join("");
    const extra = DOCS.items.filter((it) => it.part === "説明資料" && !it.id && it.svc.includes(id) && it.kind !== "HTML");
    if (extra.length) h += `<section class="also"><h2>説明資料と一緒に掲載された資料</h2><ul class="rows">${extra.map(itemRow).join("")}</ul></section>`;
    if (id !== "common" && F.also && F.also.length) {
      h += `<section class="also"><h2>あわせて見る</h2><ul class="rows">${F.also.map((x) => `<li><a href="${esc(x.href)}">${esc(x.t)}</a><span class="note">${esc(x.note)}</span></li>`).join("")}</ul></section>`;
    }
    (F.parts || [["参考資料", "参考資料"]]).forEach(([part, label]) => {
      const refs = DOCS.items.filter((it) => it.part === part && !it.id && (id === "common" ? it.svc.includes("*") : it.svc.includes(id)));
      if (!refs.length) return;
      const groups = [...new Set(refs.map((r) => r.g))];
      h += `<section class="refs"><h2>${esc(label)}</h2>` + groups.map((g) =>
        `<h3>${esc(groupLabel(g))}</h3><ul class="rows">${refs.filter((r) => r.g === g).map(itemRow).join("")}</ul>`).join("") + "</section>";
    });
    $("svc-body").innerHTML = h;
    setSubnav(svcNav(id));
    document.title = s.t + "｜" + F.titleTail;
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
        h += `<details class="it" data-h="${hi}"${hi === openH ? " open" : ""}><summary><span class="t">${esc(x.t)}</span><span class="pg">p.${x.p}</span>`
          + (n && n.gist ? `<span class="g">${esc(n.gist)}</span>` : "") + "</summary>"
          + `<div class="it-b">${noteBody(n)}`
          + CH_EXTRA.map((fn) => fn(docId, hi)).join("")
          + relRow(docId, hi)
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
  /* ── テーマ ── */
  const svcHref = (id, chip) => `#svc-${id}` + (chip ? "?s=" + chip : "");
  const thHref = (sid, tid, chip) => `#th-${sid}-${tid}` + (chip ? "?s=" + chip : "");
  const gsOf = (doc, h) => (((TH && TH.gs) || {})[doc] || {})[String(h)];
  const cmItems = (tid) => (((TH && TH.cm) || {}).items || {})[tid] || [];
  // 見出しを短くした形（番号・根拠条文・対象の印・「（届出が必要）」のような添え書きを除く）。表示とテーマの一覧に使う
  const LEAD = /^\s*(?:【[^】]*】|〔[^〕]*〕|\(\d+(?:-\d)?\)|\d+(?:-\d+)?[.．](?!\d)|\d+-\d+\s|第[0-9一二三四五六七八九十]+\s|[①-⑳]|[一二三四五六七八九十]+[、.]|\([ア-ン]\)|[ア-ン](?=\s)|[○〇◯●・]|\d+(?:\s|(?=[^\d.単円人回日月年分%])))\s*/;
  const LAWP = /[(〔](?=[^()〔〕]*(?:基準省令|施設省令|入所基準|施設サービス基準|省令|条例|告示|老企|老計|老振|通知|規則|第\d|条))[^()〔〕]*(?:\([^()]*\)[^()〔〕]*)?[)〕]/g;
  function shortT(t) {
    let s = String(t || "").normalize("NFKC").replace(/[<〈][^>〉]*[>〉]/g, "").replace(LAWP, "")
      .replace(/[(〔][^()〔〕]*(?:届出|単位|算定|準用|運輸局)[^()〔〕]*[)〕]/g, "");
    const base = s;
    for (let i = 0; i < 2; i++) s = s.replace(LEAD, "");
    s = s.trim() || base.replace(/[【】〔〕()]/g, "").trim();
    return s.replace(/\(/g, "（").replace(/\)/g, "）");
  }
  const numOf = (t) => { const m = String(t || "").normalize("NFKC").match(/^\s*\((\d+(?:-\d)?)\)/); return m ? "（" + m[1] + "）" : ""; };
  function chipsOf(s) {
    for (const fn of THEME_CHIPS) { const r = fn(s); if (r) return r; }
    const ds = s.docs.filter((d) => BY[d] && BY[d].secs.length);
    return ds.length > 1 ? ds.map((d) => ({ v: d, t: SHORT[d] || BY[d].t })) : [];
  }
  const okChip = (s, chip) => (chip && chipsOf(s).some((c) => c.v === chip) ? chip : "");
  function chipRow(s, chip, href) {
    const cs = chipsOf(s);
    if (!cs.length) return "";
    return '<nav class="svchips" aria-label="サービスで絞る">' + [{ v: "", t: "すべて" }].concat(cs).map((c) =>
      `<a href="${href(c.v)}"${c.v === (chip || "") ? ' class="is-on" aria-current="true"' : ""}>${esc(c.t)}</a>`).join("") + "</nav>";
  }
  function visible(s, chip, doc, h) {
    if (!chip) return true;
    if (s.docs.includes(chip)) return doc === chip;
    for (const fn of THEME_VIS) { const r = fn(doc, h, chip); if (r !== undefined) return r; }
    return true;
  }
  // サービス（と絞り込み）のテーマの見出し。減算は、同じテーマの中に出ている基準の見出しの下に付ける（出ていなければ単独）
  function themeItems(s, chip, tid) {
    const all = [];
    s.docs.forEach((doc) => {
      const arr = (TH.th || {})[doc];
      if (!arr || !BY[doc]) return;
      if (!FLAT[doc].length) { if (arr[0] === tid && (!s.docs.includes(chip) || chip === doc)) all.push({ doc, h: -1 }); return; }
      const xt = (TH.xt || {})[doc] || {};   // テーマが違う基準（例: 高齢の身体拘束は取扱方針）を、減算のテーマにも出す
      arr.forEach((t, h) => { if ((t === tid || (xt[String(h)] || []).includes(tid)) && visible(s, chip, doc, h)) all.push({ doc, h }); });
    });
    const at = new Map(all.map((x) => [x.doc + ":" + x.h, x]));
    let ng = 0;
    all.forEach((x) => {
      const bases = gsOf(x.doc, x.h);
      if (!bases) return;
      ng++;
      const b = bases.find((bb) => at.has(x.doc + ":" + bb));
      if (b != null) { const bx = at.get(x.doc + ":" + b); (bx.gs = bx.gs || []).push(x); x.under = true; }
    });
    return { items: all.filter((x) => !x.under), all, n: all.length, ng };
  }
  const titleOf = (x) => (x.h >= 0 ? FLAT[x.doc][x.h].t : BY[x.doc].t);
  function themeList(s, chip) {
    const rows = TH.list.map((t) => {
      const r = themeItems(s, chip, t.id), cms = cmItems(t.id);
      if (!r.n && !cms.length) return "";
      const names = [...new Set(r.all.map((x) => shortT(titleOf(x)).replace(/について$/, "")))];
      const meta = [r.n ? "見出し" + r.n : "", r.ng ? "うち減算" + r.ng : "", cms.length ? TH.cm.short + cms.length : ""].filter(Boolean).join("・");
      return `<li><a href="${thHref(s.id, t.id, chip)}"><span class="t">${esc(t.t)}</span>`
        + (names.length ? `<span class="g">${esc(names.slice(0, 4).join("・") + (names.length > 4 ? " ほか" : ""))}</span>` : "")
        + `<span class="n">${meta}</span>${ARR}</a></li>`;
    }).join("");
    return `<section class="thl-w"><h2 class="sec-h2">テーマから見る</h2><ol class="chl thl">${rows}</ol></section>`;
  }
  // 見出しの添え書き（番号・PDFの頁・資料の並びで見る）
  function tiLinks(x) {
    const doc = BY[x.doc];
    if (x.h < 0) return `<span class="ti-m">${A(pdf(doc.u), "PDF" + EXT)}</span>`;
    const f = FLAT[x.doc][x.h];
    return `<span class="ti-m">${numOf(f.t) ? `<span class="no">${numOf(f.t)}</span>` : ""}${A(pdf(doc.u, f.p), "p." + f.p + EXT)}<a href="${chHref(x.doc, f.c, x.h)}">資料の並びで見る</a></span>`;
  }
  function gsBox(g) {
    const f = FLAT[g.doc][g.h], n = note(g.doc, g.h) || {};
    return `<div class="gsb"><div class="gsb-h"><span class="gsb-k">関係する減算</span>${tiLinks(g)}</div>`
      + `<b class="gsb-t">${esc(shortT(f.t))}</b>${noteBody(n)}</div>`;
  }
  function tiBody(x) {
    return noteBody(x.h >= 0 ? note(x.doc, x.h) : note(x.doc, -1));
  }
  let curChip = "";   // テーマのページで絞り込んでいるサービス（国の確認項目の札をそのサービスだけにする）
  function tiSide(x) {
    return (x.gs || []).map(gsBox).join("") + (x.h >= 0 ? CH_EXTRA.map((fn) => fn(x.doc, x.h, curChip)).join("") : "");
  }
  function tiFull(x) {
    const isG = !!gsOf(x.doc, x.h), side = tiSide(x);
    return `<article class="ti${side ? " has-r" : ""}${isG ? " is-gs" : ""}"><div class="ti-l"><header class="ti-h"><h3>${isG ? '<span class="gs-k">減算</span>' : ""}${esc(shortT(titleOf(x)))}</h3>${tiLinks(x)}</header>`
      + tiBody(x) + `</div>${side ? `<div class="ti-r">${side}</div>` : ""}</article>`;
  }
  function tiCompact(x) {
    const isG = !!gsOf(x.doc, x.h), n = (x.h >= 0 ? note(x.doc, x.h) : note(x.doc, -1)) || {};
    const ng = (x.gs || []).length;
    return `<details class="it ti-c${isG ? " is-gs" : ""}"><summary><span class="t">${isG ? '<span class="gs-k">減算</span>' : ""}${esc(shortT(titleOf(x)))}${ng ? `<span class="gs-n">減算 ${ng}</span>` : ""}</span>`
      + `<span class="pg">${x.h >= 0 ? "p." + FLAT[x.doc][x.h].p : ""}</span>${n.gist ? `<span class="g">${esc(n.gist)}</span>` : ""}</summary>`
      + `<div class="it-b">${tiBody(x)}${tiSide(x)}<p class="ti-foot">${tiLinks(x)}</p></div></details>`;
  }
  function renderTheme(sid, tid, chip) {
    const s = SV[sid];
    chip = okChip(s, chip);
    const r = themeItems(s, chip, tid), cms = cmItems(tid);
    let h = `<p class="crumbs"><a href="${svcHref(sid, chip)}">${esc(s.t)}</a><span aria-hidden="true">›</span><span>テーマ</span></p>`
      + `<h1 class="vh">${esc(TH_NAME[tid])}</h1>`
      + `<div class="ch-meta"><span>見出し ${r.n}</span>${r.ng ? `<span>うち減算 ${r.ng}</span>` : ""}${cms.length ? `<span>${esc(TH.cm.short)} ${cms.length}</span>` : ""}</div>`
      + chipRow(s, chip, (v) => thHref(sid, tid, v));
    if (!r.items.length) h += `<p class="tk-empty">${chip ? "このサービスに当てはまる見出しはありません。" : "このテーマに当てはまる見出しはありません。"}</p>`;
    const compact = r.items.length > 12;
    // 資料ごとに、減算を添えた見出しを先に（同じ資料・同じ並びの中で）
    const docOrder = s.docs.filter((d) => BY[d]);
    const items = r.items.slice().sort((a, b) => (docOrder.indexOf(a.doc) - docOrder.indexOf(b.doc)) || ((b.gs ? 1 : 0) - (a.gs ? 1 : 0)) || (a.h - b.h));
    const multi = new Set(items.map((x) => x.doc)).size > 1;
    let lastDoc = null, lastCh = null;
    curChip = chip;
    h += `<div class="tis${compact ? " is-compact" : ""}">`;
    items.forEach((x) => {
      if (multi && x.doc !== lastDoc) { h += `<h2 class="ti-doc">${esc(BY[x.doc].t)}</h2>`; lastCh = null; }
      lastDoc = x.doc;
      const f = x.h >= 0 ? FLAT[x.doc][x.h] : null;
      const ch = f && f.sec ? f.sec : null;
      if (ch && ch !== lastCh) h += `<p class="ti-ch">${esc(ch)}</p>`;
      lastCh = ch;
      h += compact ? tiCompact(x) : tiFull(x);
    });
    h += "</div>";
    if (cms.length) {
      h += `<section class="cmb"><h2 class="sec-h2">${esc(TH.cm.label)}</h2><ul class="hits">` + cms.map(([d, hh]) => {
        const f = FLAT[d][hh], n = note(d, hh);
        return `<li><a class="hit" href="${chHref(d, f.c, hh)}"><span class="h">${esc(f.t)}</span><span class="c">${esc(SHORT[d] || BY[d].t)}</span>${n && n.gist ? `<span class="g">${esc(n.gist)}</span>` : ""}</a>${A(pdf(BY[d].u, f.p), `<span>PDF</span><span>p.${f.p}</span>`, "hit-pdf")}</li>`;
      }).join("") + "</ul></section>";
    }
    $("th-body").innerHTML = h;
    setSubnav(`<a class="sn-back" href="${svcHref(sid, chip)}">${ARL}<span>${esc(s.t)}</span></a><ol>` + TH.list.map((t) => {
      const n = themeItems(s, chip, t.id).n, c = cmItems(t.id).length;
      if (!n && !c) return "";
      return `<li><a href="${thHref(sid, t.id, chip)}"${t.id === tid ? ' class="is-active" aria-current="page"' : ""}><span>${esc(t.t)}</span><span class="c">${n || ""}</span></a></li>`;
    }).join("") + "</ol>");
    document.title = TH_NAME[tid] + "｜" + s.t;
  }
  // 章のページの見出しに添える「同じ話題」（テーマ・減算と基準）
  function relRow(docId, h) {
    if (!TH || !(TH.th || {})[docId]) return "";
    const sid = SVC_OF[docId], tid = TH.th[docId][h], parts = [];
    if (tid && sid && sid !== "common") parts.push(`<a class="chip-a" href="${thHref(sid, tid)}">テーマ　${esc(TH_NAME[tid])}</a>`);
    const gsm = (TH.gs || {})[docId] || {};
    const mine = gsm[String(h)];
    if (mine && mine.length) { const fb = FLAT[docId][mine[0]]; parts.push(`<a class="chip-a" href="${chHref(docId, fb.c, mine[0])}">基準　${esc(shortT(fb.t))}</a>`); }
    Object.entries(gsm).forEach(([gh, bases]) => {
      if (bases.includes(h)) { const fg = FLAT[docId][Number(gh)]; parts.push(`<a class="chip-a is-gs" href="${chHref(docId, fg.c, Number(gh))}">減算　${esc(shortT(fg.t))}</a>`); }
    });
    return parts.length ? `<div class="to-kk to-th"><span class="k">同じ話題</span>${parts.join("")}</div>` : "";
  }
  // 絞り込みは、戻る操作の行き先を増やさない（押す前のページに戻れるように）
  document.addEventListener("click", (e) => {
    const a = e.target.closest(".svchips a");
    if (!a) return;
    e.preventDefault();
    go(a.getAttribute("href"), true);
  });

  $("ch-body").addEventListener("click", (e) => {
    const b = e.target.closest(".openall");
    if (!b) return;
    const open = b.getAttribute("aria-pressed") !== "true";
    document.querySelectorAll("#ch-body details.it").forEach((d) => { d.open = open; });
    b.setAttribute("aria-pressed", String(open));
    b.textContent = open ? "すべて閉じる" : "すべて開く";
  });

  /* ── 探す（語の索引と要点の文で、見出しを引く） ── */
  const RUN = /[一-龥々〆ヵヶ]+|[ァ-ヴー]+|[A-Za-z0-9]+/g;   // extract.py の WORD と同じ区切り
  const JOIN = /[A-Za-z0-9]+[一-龥々〆ヵヶ]/g;               // extract.py の JOIN と同じ
  const runsOf = (s) => {
    const out = [];
    (s.match(JOIN) || []).concat(s.replace(JOIN, " ").match(RUN) || []).forEach((r) => { if (!out.includes(r)) out.push(r); });
    return out;
  };
  /* ── 探す語の扱い（P75。こども性暴力防止法ガイドの P71 と同じ考え方） ──
     表記のゆれをそろえ（FOLD）、疑問の言葉・「何回」「必要？」などを外し（STOP）、略称・俗称に資料の言い方を足す（SYN）。
     文で打たれたら、漢字・カタカナ・英数字の語を取り出して、それぞれを語とする。
     語ごとに「どれか1つが含まれればよい」候補の組を作り、組をすべて含む見出しを探す。
     すべてを含む見出しが無ければ、珍しい語を多く含む見出しを「一部の語を含むもの」として出す */
  const FOLD = [[/障がい|障碍/g, "障害"], [/子供|子ども/g, "こども"], [/放課後デイ/g, "放課後等デイ"],
    [/加算\(?([1-4])\)?(?![0-9])/g, (m, d) => "加算" + ["i", "ii", "iii", "iv"][d - 1]]];
  const fold = (s) => FOLD.reduce((t, [re, to]) => t.replace(re, to), String(s || "").normalize("NFKC").toLowerCase());
  const SYN_ALL = {
    "障害": ["障がい"], "障害者": ["障がい者", "障害者"], "障害児": ["障がい児", "障害児"],
    "実地指導": ["運営指導", "実地指導"], "監査": ["監査", "指導監査"], "指導監査": ["指導監査", "監査"],
    "ショート": ["短期入所", "短期"], "ショートステイ": ["短期入所", "短期"], "サ責": ["サービス提供責任者"], "ナース": ["看護職員", "看護師"], "看護師": ["看護職員", "看護師"],
    "bcp": ["業務継続計画", "bcp"], "業務継続": ["業務継続"], "ヒヤリハット": ["ヒヤリ", "ヒヤリハット"],
    "カスハラ": ["ハラスメント"], "セクハラ": ["ハラスメント"], "パワハラ": ["ハラスメント"],
    "スピーチロック": ["スピーチロック", "言葉による拘束", "身体拘束"], "不適切ケア": ["不適切なケア", "不適切"],
    "押印": ["押印", "署名"], "はんこ": ["押印"], "ハンコ": ["押印"], "電子": ["電磁的", "電子"], "オンライン": ["テレビ電話", "オンライン"],
    "持ち件数": ["担当件数", "取扱件数"], "何件": [], "給料": ["賃金", "処遇改善"], "給与": ["賃金", "処遇改善"],
    "返還": ["返還", "過誤"], "過誤": ["過誤", "返還"], "おやつ": ["おやつ", "日常生活費", "実費"], "おやつ代": ["おやつ", "日常生活費", "実費"],
    "シフト": ["勤務表", "勤務体制"], "シフト表": ["勤務表", "勤務体制"], "勤務表": ["勤務表", "勤務形態一覧表"],
    "通報": ["通報"], "家族": ["家族"], "預かり金": ["預り金", "金銭管理"], "お金": ["金銭", "預り金"], "金銭": ["金銭", "預り金"],
    "個人情報": ["個人情報", "秘密保持"], "守秘義務": ["秘密保持"], "サイン": ["署名", "確認"], "印鑑": ["押印", "署名"],
    "足りない": ["欠如", "不足"], "退職": ["退職"], "人手不足": ["人員基準", "欠如"], "欠員": ["欠如", "人員基準"],
    "検便": ["検便"], "時間区分": ["時間区分", "所要時間"], "所要時間": ["所要時間", "時間区分"], "定着率": ["定着率", "定着"], "たん吸引": ["喀痰吸引", "たん吸引"], "痰吸引": ["喀痰吸引"],
    "pt": ["理学療法士"], "ot": ["作業療法士"], "st": ["言語聴覚士"], "bi": ["barthel", "bi"]
  };
  const SYN_F = {
    shogai: {
      "gh": ["共同生活援助", "グループホーム"], "グルホ": ["共同生活援助", "グループホーム"], "グループホーム": ["共同生活援助", "グループホーム"],
      "放デイ": ["放課後等デイサービス"], "放課後等デイ": ["放課後等デイサービス"], "児発": ["児童発達支援"], "児発管": ["児童発達支援管理責任者"],
      "サビ管": ["サービス管理責任者"], "行援": ["行動援護"], "重訪": ["重度訪問介護"], "同行": ["同行援護"], "ヘルパー": ["居宅介護", "ヘルパー", "従業者"],
      "就b": ["就労継続支援b型", "b型"], "就労b": ["就労継続支援b型", "b型"], "b型": ["b型"], "就a": ["就労継続支援a型", "a型"], "就労a": ["就労継続支援a型", "a型"], "a型": ["a型"],
      "就移": ["就労移行支援"], "就労移行": ["就労移行支援", "就労移行"], "就労定着": ["就労定着支援"], "生活訓練": ["自立訓練", "生活訓練"], "機能訓練": ["自立訓練", "機能訓練"],
      "重心": ["重症心身障害"], "強行": ["強度行動障害"], "強度行動": ["強度行動障害"], "医ケア": ["医療的ケア"], "医ケア児": ["医療的ケア児", "医療的ケア"],
      "相談員": ["相談支援専門員"], "計画相談": ["計画相談支援"], "入所": ["施設入所支援", "入所"], "上限管理": ["上限額管理", "上限管理"],
      "家賃助成": ["家賃", "補足給付", "特定障害者特別給付費"], "家賃補助": ["家賃", "補足給付", "特定障害者特別給付費"]
    },
    kourei: {
      "gh": ["認知症対応型共同生活介護", "グループホーム"], "グルホ": ["認知症対応型共同生活介護"], "グループホーム": ["認知症対応型共同生活介護", "グループホーム"],
      "ケアマネ": ["介護支援専門員", "居宅介護支援"], "ケアマネジャー": ["介護支援専門員"], "ケアプラン": ["居宅サービス計画", "ケアプラン"],
      "デイ": ["通所介護"], "デイサービス": ["通所介護"], "地域密着デイ": ["地域密着型通所介護"], "通リハ": ["通所リハビリテーション"], "デイケア": ["通所リハビリテーション"],
      "訪看": ["訪問看護"], "訪問入浴": ["訪問入浴介護"], "ヘルパー": ["訪問介護員", "訪問介護"], "リハマネ": ["リハビリテーションマネジメント"],
      "特養": ["介護老人福祉施設", "特別養護老人ホーム"], "老健": ["介護老人保健施設"], "介護医療院": ["介護医療院"], "特定施設": ["特定施設"],
      "小多機": ["小規模多機能"], "看多機": ["看護小規模多機能"], "運推": ["運営推進会議"], "運営推進": ["運営推進会議"],
      "2時間ルール": ["2時間"], "生活援助": ["生活援助"], "身体介護": ["身体介護"], "特例入所": ["特例入所"]
    },
    hoiku: {
      "園バス": ["送迎用バス", "バス"], "送迎バス": ["送迎用バス", "バス"], "置き去り": ["置き去り", "所在確認"], "保育園": ["保育所"], "こども園": ["認定こども園", "こども園"],
      "お昼寝": ["午睡", "睡眠"], "昼寝": ["午睡", "睡眠"], "午睡チェック": ["午睡", "睡眠"], "誤嚥": ["誤嚥", "窒息"], "窒息": ["窒息", "誤嚥"],
      "アレルギー": ["アレルギー"], "除去食": ["除去食", "アレルギー"], "誤配": ["誤配", "誤食"], "誤食": ["誤食", "誤配"], "不適切保育": ["不適切な保育", "不適切"],
      "プール": ["プール", "水遊び"], "水遊び": ["水遊び", "プール"], "散歩": ["散歩", "園外活動"], "配置基準": ["配置基準", "職員配置", "最低基準"]
    }
  };
  const SYN = Object.assign({}, SYN_ALL, SYN_F[F.id] || {});
  // 外す語（疑問の言葉・「必要？」「何回」など。探す手がかりにならないもの）
  const STOP = ["何", "何回", "何人", "何件", "何分", "何か所", "何箇所", "何年", "何日", "何時間", "何%", "何割", "誰", "いつ", "いつから", "いつまで", "どこ", "どこまで",
    "どう", "どうなる", "どうする", "どうすれば", "必要", "全部", "ダメ", "だめ", "いい", "よい", "大丈夫", "注意点", "方法", "仕方", "しかた", "やり方", "作り方", "書き方",
    "について", "とは", "教えて", "知りたい", "よくある", "言われる", "多い", "来る", "できる", "できない", "場合", "とき", "ok", "本当", "毎回", "ある", "ない", "する", "いる", "要る",
    "の", "は", "が", "を", "に", "で", "と", "も", "や", "か", "?"];
  const SYNK = Object.keys(SYN).filter((k) => k.length >= 2).sort((a, b) => b.length - a.length);
  const kata = (w) => w.replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));
  const altOf = (s) => ({ s, runs: runsOf(s) });
  function groupOf(w) {
    const out = [w].concat(SYN[w] || []);
    if (/^[ぁ-ゖー]+$/.test(w)) out.push(kata(w));   // ひらがなだけの語はカタカナでも探す（例: ひやりはっと → ヒヤリハット）
    return { w, alts: [...new Set(out.map(fold))].map(altOf).filter((a) => a.runs.length || /[ぁ-ゖ]/.test(a.s)) };
  }
  // 打ち込まれた文字 → 語の組の並び
  function qgroups(raw) {
    const toks = fold(raw).replace(/[?？!！、。,，「」『』()（）・/／]/g, " ").split(/\s+/).filter(Boolean);
    const ws = [];
    const push = (w) => { if (!ws.includes(w)) ws.push(w); };
    toks.forEach((t) => {
      if (SYN[t]) return push(t);
      if (STOP.includes(t)) return;
      if (/^[ぁ-ゖー]+$/.test(t)) { if (t.length >= 3) push(t); return; }
      // 文のように打たれた語は、言い換えの語を切り出してから、漢字・カタカナ・英数字の語に分ける（1字の漢字は外す）
      let rest = t;
      SYNK.forEach((k) => { if (rest.includes(k) && k !== rest) { push(k); rest = rest.split(k).join(" "); } });
      if (SYN[rest]) return push(rest);
      const st = rest.replace(/[ぁ-ゖ]+$/, "");
      if (SYN[st] || (st && !/[ぁ-ゖ]/.test(st) && runsOf(st).length === 1 && st === runsOf(st)[0])) return push(st || rest);
      runsOf(rest).forEach((r) => { if (STOP.includes(r) || /^[一-龥々]$/.test(r)) return; push(r); });
    });
    const gs = ws.map(groupOf).filter((g) => g.alts.length);
    if (gs.length) return gs;
    return toks.map(groupOf).filter((g) => g.alts.length);   // 全部外れたら外さずに探す
  }
  const hitN = (t, a) => t.includes(a.s) || (a.runs.length > 0 && a.runs.every((r) => r.length >= 2 && t.includes(r)));
  let KW = null, kwLoading = null;
  function loadKW() {
    if (KW) return Promise.resolve(KW);
    if (!kwLoading) {
      kwLoading = fetch("kw.json", { cache: "no-cache" }).then((r) => r.json()).then((j) => {
        // 索引の区切りのキーは「資料:頁:見出しの番号」。区切りごとに語の表（vocab）の番号を持つ（英字は小文字にそろえる）。
        // 形式2（extract.py の write_kw）: 番号は小さい順の差を36進で「.」区切り。形式1: 語そのものを「|」でつないだ文字列
        let vocab, list;
        if (j.vocab != null) {
          vocab = j.vocab.split("|").map((w) => w.toLowerCase());
          list = Object.entries(j.segs).map(([k, v]) => { let prev = 0; return [k, v ? v.split(".").map((x) => (prev += parseInt(x, 36))) : []]; });
        } else {
          const idx = new Map(); vocab = [];
          list = Object.entries(j.pages).map(([k, v]) => [k, v.split("|").map((w) => {
            w = w.toLowerCase();
            if (!idx.has(w)) { idx.set(w, vocab.length); vocab.push(w); }
            return idx.get(w);
          })]);
        }
        const segs = {};
        j.docs.forEach((id) => { segs[id] = []; });
        list.forEach(([k, ids]) => { const [di, p, h] = k.split(":").map(Number); segs[j.docs[di]].push({ p, h, ids }); });
        KW = { vocab, segs };
        return KW;
      }).catch((e) => { kwLoading = null; throw e; });
    }
    return kwLoading;
  }
  // 語の組ごと・候補ごとに、語の表のどれが当たるか（1字の語は同じ語だけ、2字以上は語の一部でも当たる）
  function marksOf(vocab, gs) {
    const cache = new Map();
    const mk = (r) => {
      if (!cache.has(r)) {
        const m = new Uint8Array(vocab.length);
        for (let i = 0; i < vocab.length; i++) if (r.length === 1 ? vocab[i] === r : vocab[i].includes(r)) m[i] = 1;
        cache.set(r, m);
      }
      return cache.get(r);
    };
    return gs.map((g) => g.alts.filter((a) => a.runs.length).map((a) => a.runs.map(mk)));
  }
  const segHit = (ids, alts) => alts.some((runs) => runs.every((m) => ids.some((i) => m[i] === 1)));
  // 要点の文（見出し＋概要＋要点＋指摘）を、探すために空白を除いた形で持つ。見出しだけのものも別に持つ（並べ順に使う）
  const NOTE_TEXT = {}, HEAD_TEXT = {};
  TOC.forEach((d) => {
    NOTE_TEXT[d.id] = {}; HEAD_TEXT[d.id] = {};
    const ids = FLAT[d.id].length ? FLAT[d.id].map((_, h) => h) : [-1];
    ids.forEach((h) => {
      const n = note(d.id, h) || {}, f = FLAT[d.id][h];
      NOTE_TEXT[d.id][h] = fold([f ? f.t : d.t, n.gist, ...(n.points || []), ...(n.shiteki || [])].join(" ")).replace(/\s+/g, "");
      HEAD_TEXT[d.id][h] = fold(f ? f.t : d.t).replace(/\s+/g, "");
    });
  });
  function mark(text, gs) {
    let h = esc(text);
    const ws = [...new Set(gs.flatMap((g) => g.alts.flatMap((a) => [a.s].concat(a.runs.filter((r) => r.length >= 2)))))].sort((a, b) => b.length - a.length);
    if (!ws.length) return h;
    const re = new RegExp("(" + ws.map((w) => esc(w).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")", "gi");
    // NFKC でそろえた語で印を付ける（元の文の全角英数字には付かないことがある）
    return h.replace(re, "<mark>$1</mark>");
  }
  let scope = "";   // 絞り込む資料（toc の id を「,」で）。空ならすべて
  function renderScope() {
    const opts = [["", "すべて"]].concat(TOC.map((d) => [d.id, SHORT[d.id] || d.t]));
    const custom = scope && !opts.some((o) => o[0] === scope);
    if (custom) opts.splice(1, 0, [scope, scope.split(",").map((x) => SHORT[x] || x).join("＋")]);
    $("scope").innerHTML = opts.map(([v, t]) => `<button type="button" data-v="${v}" aria-pressed="${v === scope}">${esc(t)}</button>`).join("");
  }
  // サービスの名前（語にこれを含めば「サービス名の語」。一部の語で出すときも外さない）
  const SVCN = {
    shogai: ["居宅介護", "重度訪問介護", "同行援護", "行動援護", "生活介護", "短期入所", "施設入所", "自立訓練", "就労移行", "就労継続", "就労定着", "就労選択", "共同生活援助", "グループホーム",
      "自立生活援助", "児童発達支援", "放課後等デイ", "保育所等訪問", "計画相談", "障害児相談", "地域移行支援", "地域定着支援", "療養介護", "重度障害者等包括"],
    kourei: ["訪問介護", "訪問入浴", "訪問看護", "訪問リハ", "通所介護", "通所リハ", "短期入所", "特定施設", "介護老人福祉施設", "特別養護老人ホーム", "介護老人保健施設", "介護医療院",
      "認知症対応型", "グループホーム", "小規模多機能", "居宅介護支援", "介護支援専門員", "福祉用具", "定期巡回", "夜間対応", "居宅療養管理指導"],
    hoiku: []
  }[F.id] || [];
  const isSvc = (g) => g.alts.some((a) => SVCN.some((n) => a.s.includes(n)));
  // 見出しごとに、語の組それぞれが当たるか（PDFの頁の語・要点の文。要点の文には資料の題名も含める）を集める
  function unitsOf(kw, docs, gs) {
    const us = [], marks = marksOf(kw.vocab, gs);
    docs.forEach((doc) => {
      const by = new Map();
      const u = (h) => { if (!by.has(h)) by.set(h, { doc, h, segs: [], m: gs.map(() => false), nm: gs.map(() => false) }); return by.get(h); };
      (kw.segs[doc.id] || []).forEach((sg) => {
        const m = marks.map((alts) => segHit(sg.ids, alts));
        if (!m.some(Boolean)) return;
        const x = u(sg.h);
        m.forEach((v, i) => { if (v) x.m[i] = true; });
        x.segs.push({ p: sg.p, m });
      });
      const dt = fold(doc.t).replace(/\s+/g, "");
      Object.entries(NOTE_TEXT[doc.id]).forEach(([hh, txt]) => {
        const t2 = dt + txt;
        const m = gs.map((g) => g.alts.some((a) => hitN(t2, a)));
        if (!m.some(Boolean)) return;
        const x = u(Number(hh));
        m.forEach((v, i) => { if (v) { x.m[i] = true; x.nm[i] = true; } });
      });
      by.forEach((x) => us.push(x));
    });
    return us;
  }
  async function runSearch(q) {
    const gs = qgroups(q);
    $("q-main").value = q || "";
    renderScope();
    if (!gs.length) {
      $("s-sum").textContent = q ? "漢字・カタカナ・英数字を含む語で探してください" : "";
      $("s-res").innerHTML = "";
      return;
    }
    $("s-sum").textContent = "索引を読み込んでいます…";
    let kw;
    try { kw = await loadKW(); } catch (e) { $("s-sum").textContent = "索引を読み込めませんでした。時間をおいて開き直してください"; return; }
    const want = scope ? scope.split(",") : TOC.map((d) => d.id);
    const docs = TOC.filter((d) => want.includes(d.id));
    const us = unitsOf(kw, docs, gs);
    const N = docs.reduce((n, d) => n + Math.max(1, FLAT[d.id].length), 0);
    const df = gs.map((_, i) => us.filter((x) => x.m[i]).length);
    const miss = gs.filter((_, i) => !df[i]).map((g) => g.w);
    // 多くの見出しに出る語（「サービス」「利用者」など）は、ほかに語があれば、そろうことを求めない（並べ順にだけ使う）
    const weak = gs.map((g, i) => gs.length > 1 && !isSvc(g) && df[i] > N * 0.3);
    const req = gs.map((_, i) => !weak[i]);
    if (req.every((v) => !v)) req.fill(true);
    const allReq = (m) => m.every((v, i) => v || !req[i]);
    us.forEach((x) => {
      x.pages = new Set(x.segs.filter((sg) => allReq(sg.m)).map((sg) => sg.p));
      x.any = new Set(x.segs.map((sg) => sg.p));
      x.full = x.pages.size > 0 || allReq(x.nm);
    });
    let hits = us.filter((x) => x.full), part = false;
    // サービス名の語や、加算・減算の名前が資料に無いときは、一部の語では出さない（ほかのサービス・ほかの加算を出してしまうため）
    const svcMiss = gs.some((g, i) => !df[i] && (isSvc(g) || /(加算|減算)$/.test(g.w)));
    if (!hits.length && gs.length >= 2 && !svcMiss) {
      // 一部の語: 多くの見出しに出る語ほど軽く数える。サービス名の語は外さない
      const wt = df.map((d) => (d ? Math.log((N + 1) / d) : 0));
      const floor = Math.log((N + 1) / Math.max(2, N * 0.1));   // 見出しの1割より多くに出る語だけで当たるものは出さない
      const cand = us.filter((x) => gs.every((g, i) => !isSvc(g) || x.m[i]));
      // 数字・短い英字だけの語（例: 80%・1万円の「1」）は、それだけで当たったことにしない
      const light = gs.map((g) => isSvc(g) || /^[0-9a-z]{1,3}$/.test(g.w));
      cand.forEach((x) => { x.s = x.m.reduce((s, v, i) => s + (v && !light[i] ? wt[i] : 0), 0); });
      const max = Math.max(0, ...cand.map((x) => x.s));
      if (max >= floor) { hits = cand.filter((x) => x.s >= max * 0.6 && x.s >= floor); part = true; }
    }
    // 並べ順: 見出しに語が出る > 要点の文に出る > PDFの頁だけ。資料も、いちばんよく合う見出しの順に
    hits.forEach((x) => {
      const ht = HEAD_TEXT[x.doc.id][x.h] || "";
      x.rk = (part ? x.s * 10 : 0) + gs.reduce((s, g, i) => s + (g.alts.some((a) => hitN(ht, a)) ? 3 : (x.nm[i] ? 2 : (x.m[i] ? 1 : 0))), 0);
    });
    const byDoc = new Map();
    hits.forEach((x) => { if (!byDoc.has(x.doc.id)) byDoc.set(x.doc.id, []); byDoc.get(x.doc.id).push(x); });
    const order = [...byDoc.entries()].map(([id, xs]) => [id, xs.sort((a, b) => b.rk - a.rk || a.h - b.h)])
      .sort((a, b) => b[1][0].rk - a[1][0].rk || want.indexOf(a[0]) - want.indexOf(b[0]));
    let total = 0, h = "";
    order.forEach(([id, xs]) => {
      const doc = BY[id];
      total += xs.length;
      const rows = xs.map((x) => {
        const k = x.h, f = FLAT[doc.id][k], n = note(doc.id, k);
        const pages = [...(x.pages.size ? x.pages : x.any)].sort((a, b) => a - b);
        const p0 = pages[0] || (f ? f.p : 1);
        const head = f ? f.t : (doc.secs.length ? "表紙・目次" : doc.t);
        const href = f ? chHref(doc.id, f.c, k) : (doc.secs.length ? null : `#svc-${SVC_OF[doc.id]}`);
        const inner = `<span class="h">${mark(head, gs)}</span>`
          + (f && f.sec ? `<span class="c">${esc(f.sec)}</span>` : "")
          + (n && n.gist ? `<span class="g">${mark(n.gist, gs)}</span>` : "");
        const main = href ? `<a class="hit" href="${href}">${inner}</a>` : `<span class="hit">${inner}</span>`;
        const pl = pages.length ? pages.slice(0, 4).map((p) => "p." + p).join("・") + (pages.length > 4 ? "ほか" : "") : "p." + p0;
        return `<li>${main}${A(pdf(doc.u, p0), `<span>PDF</span><span>${pl}</span>`, "hit-pdf")}</li>`;
      });
      const LIM = 30;
      h += `<section class="s-doc"><h2>${esc(doc.t)}<small>${xs.length}件</small></h2><ul class="hits">${rows.slice(0, LIM).join("")}</ul>`
        + (rows.length > LIM ? `<ul class="hits" hidden>${rows.slice(LIM).join("")}</ul><button type="button" class="more">残り${rows.length - LIM}件を表示</button>` : "")
        + "</section>";
    });
    const qt = (ws) => ws.map((w) => "「" + w + "」").join("");
    const tl = qt(gs.map((g) => g.w));
    if (part) {
      $("s-sum").innerHTML = (miss.length ? `${esc(qt(miss))}は資料に出てきません。` : `${esc(tl)}がすべて出てくる見出しはありません。`)
        + `一部の語が出てくる見出し <b>${total}</b>（${byDoc.size}編）`;
    } else if (total) {
      $("s-sum").innerHTML = `${esc(tl)}が出てくる見出し <b>${total}</b>（${byDoc.size}編）`;
    } else {
      $("s-sum").innerHTML = miss.length ? `${esc(qt(miss))}は資料に出てきません` : `${esc(tl)}が出てくる見出しは見つかりませんでした`;
    }
    $("s-res").innerHTML = part ? `<div data-part="1">${h}</div>` : h;
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
    else if (name === "svc" && SVC.length < 2) { view = "svcview"; g = "svc"; renderSvc("common"); }
    else if (name === "svc") { view = "svc"; g = "svc"; renderSvcIndex(); setSubnav(""); document.title = F.svcLabel + "｜" + F.titleTail; }
    else if (name.startsWith("svc-") && SV[name.slice(4)]) { view = "svcview"; g = "svc"; renderSvc(name.slice(4), params.get("s") || ""); }
    else if ((m = name.match(/^th-([a-z]+)-([a-z]+)$/)) && TH && SV[m[1]] && m[1] !== "common" && TH_NAME[m[2]]) {
      view = "thview"; g = "svc";
      renderTheme(m[1], m[2], params.get("s") || "");
    }
    else if ((m = name.match(/^ch-([a-z]+)-(\d+)$/)) && BY[m[1]] && BY[m[1]].secs[Number(m[2]) - 1]) {
      view = "chview"; g = "svc";
      openH = params.has("i") ? Number(params.get("i")) : null;
      renderChapter(m[1], Number(m[2]), openH);
    } else if (name === "search") {
      view = "search"; g = "search";
      scope = params.get("d") || "";
      runSearch(params.get("q") || "");
      document.title = "資料の中を探す｜" + F.titleTail;
    } else if (name === "sources") { view = "sources"; g = "sources"; document.title = "資料一覧｜" + F.titleTail; }
    else document.title = F.title;
    document.querySelectorAll(".view").forEach((v) => v.classList.toggle("is-active", v.id === view));
    document.querySelectorAll("a[data-g]").forEach((a) => {
      const on = a.dataset.g === g;
      a.classList.toggle("is-active", on);
      if (on) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
    });
    const shell = $("shell");
    shell.classList.toggle("no-sub", view !== "svcview" && view !== "chview" && view !== "thview" && !(ext && ext.sub));
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
