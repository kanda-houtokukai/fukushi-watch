  /* ══ 点検・減算・年間（build.py が app.js の差し込み口＝@TENKEN@ の位置に入れる。app.js と同じ中で動く） ══
     点検表のデータ: 国の確認項目（tenken/<サービス>.json を開いたときに読む）＋県の見出し・指摘（照合済みの要点）
     記録はこの端末のブラウザ（localStorage）に持つ。書き出し・取り込みで端末をまたぐ／本部でまとめる */
  const TK = D.tk;
  const SIX = Object.fromEntries(TK.index.map((s) => [s.id, s]));
  const GT = TK.groups;
  const GORDER = TK.gorder || ["kyotaku", "nicchu", "gh", "ji", "soudan"];
  const FLABEL = { shogai: "障がい", kourei: "高齢", hoiku: "保育" }[F.id] || "";
  const HAS_GS = TK.gensan.length > 0, HAS_NK = TK.nenkan.items.length > 0;   // 減算・年間のない分野（高齢）は出さない
  const SEC_T = { "質": "個別サービスの質に関する事項", "体制": "個別サービスの質を確保するための体制に関する事項" };
  const ST_T = { 1: "問題なし", 2: "要対応", 3: "該当なし" };
  const svcsOfGroup = (g) => TK.index.filter((s) => s.g === g);
  // 試作の確認画面（ファイルの保存・印刷ができない枠の中）では、書き出し・取り込み・印刷のボタンを出さない
  const PREVIEW = !!window.SYU_PREVIEW;
  const printBtn = () => (PREVIEW ? "" : '<button type="button" class="btn-o sm" data-act="print">印刷</button>');

  /* ── 記録（この端末） ── */
  const STORE = TK.store || "syudan-tenken-v1";   // 分野ごとに別の記録
  let DB = null, saveTimer = null;
  function db() {
    if (DB) return DB;
    try { DB = JSON.parse(localStorage.getItem(STORE) || "null"); } catch (e) { DB = null; }
    if (!DB || DB.v !== 1) DB = { v: 1, offices: [], st: {}, memo: {}, yr: {}, opt: {} };
    ["offices", "st", "memo", "yr", "opt"].forEach((k) => { if (!DB[k]) DB[k] = k === "offices" ? [] : {}; });
    return DB;
  }
  function saveNow() { clearTimeout(saveTimer); try { localStorage.setItem(STORE, JSON.stringify(db())); } catch (e) { /* 保存できない環境 */ } }
  const save = () => { clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 150); };
  window.addEventListener("pagehide", saveNow);
  const offices = () => db().offices;
  const officeOf = (id) => offices().find((o) => o.id === id);
  const newId = () => "o" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const svcName = (sid) => (SIX[sid] ? SIX[sid].t : sid);
  const officeName = (o) => o.name || o.svcs.map(svcName).join("・") || "事業所";
  function stOf(oid, sid) {
    const s = db().st;
    if (!s[oid]) s[oid] = {};
    if (!s[oid][sid]) s[oid][sid] = {};
    return s[oid][sid];
  }
  function memoOf(oid) { const m = db().memo; if (!m[oid]) m[oid] = {}; return m[oid]; }
  function prog(oid, sid) {
    const m = ((db().st[oid] || {})[sid]) || {};
    let ok = 0, ng = 0, na = 0;
    Object.values(m).forEach((v) => { if (!v[2]) return; if (v[0] === 1) ok++; else if (v[0] === 2) ng++; else if (v[0] === 3) na++; });
    const tot = SIX[sid] ? SIX[sid].n + SIX[sid].nk : 0;
    return { ok, ng, na, tot, left: Math.max(0, tot - ok - ng - na) };
  }
  function progOffice(o) {
    const p = { ok: 0, ng: 0, na: 0, tot: 0, left: 0 };
    o.svcs.forEach((sid) => { const x = prog(o.id, sid); Object.keys(p).forEach((k) => { p[k] += x[k]; }); });
    return p;
  }
  function bar(p, cls) {
    const w = (n) => (p.tot ? Math.min(100, n / p.tot * 100) : 0).toFixed(2) + "%";
    return `<span class="bar${cls ? " " + cls : ""}" role="img" aria-label="問題なし${p.ok}・要対応${p.ng}・該当なし${p.na}・未確認${p.left}">`
      + `<i class="b1" style="width:${w(p.ok)}"></i><i class="b2" style="width:${w(p.ng)}"></i><i class="b3" style="width:${w(p.na)}"></i></span>`;
  }
  const doneN = (p) => p.ok + p.ng + p.na;
  function pcount(p) {
    return `<span class="pc"><b>${doneN(p)}</b><span>/${p.tot}</span></span>` + (p.ng ? `<span class="pc-ng">要対応 ${p.ng}</span>` : "");
  }

  /* ── 日付（日本時間） ── */
  const DAY = 864e5, JST = 9 * 36e5;
  const todayMs = () => Math.floor((Date.now() + JST) / DAY) * DAY - JST;
  const dms = (ymd) => Date.parse(ymd + "T00:00:00+09:00");
  function ymdOf(ms) { const d = new Date(ms + JST); return [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()]; }
  function fyNow() { const [y, m] = ymdOf(todayMs()); return m >= 4 ? y : y - 1; }
  const WD = "日月火水木金土";
  function jdate(ymd, withYear) {
    const [y, m, d] = ymd.split("-").map(Number);
    const w = WD[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
    return (withYear ? `${y}年` : "") + `${m}月${d}日（${w}）`;
  }
  function leftText(ymd) {
    const left = Math.round((dms(ymd) - todayMs()) / DAY);
    if (left > 0) return `<span class="left">あと<b>${left}</b>日</span>`;
    if (left === 0) return `<span class="left is-today">本日が期限</span>`;
    return `<span class="left is-past">${-left}日前</span>`;
  }
  const nowStamp = () => { const [y, m, d] = ymdOf(todayMs()); return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`; };

  /* ── 点検表のデータ（サービスごとに読む） ── */
  const SVCDATA = {}, svcLoading = {};
  function loadSvc(sid) {
    if (SVCDATA[sid]) return Promise.resolve(SVCDATA[sid]);
    if (!svcLoading[sid]) {
      svcLoading[sid] = fetch(`tenken/${sid}.json`, { cache: "no-cache" })
        .then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.json(); })
        .then((j) => { SVCDATA[sid] = prepSvc(j); return SVCDATA[sid]; })
        .catch((e) => { delete svcLoading[sid]; throw e; });
    }
    return svcLoading[sid];
  }
  function prepSvc(j) {
    const secs = j.secs.map((s) => ({ t: SEC_T[s.t] || s.t, rows: s.rows }));
    if (j.ken.length) secs.push({ t: "県の資料から", ken: true, rows: j.ken.map((r) => Object.assign({ kenOnly: true }, r)) });
    secs.forEach((s) => s.rows.forEach((r) => {
      if (r.kenOnly) { r.items = [{ k: r.k, x: r.t, c: 1 }]; return; }
      r.items.forEach((it) => { it.c = j.src === "sogo" || j.src === "kaigo" || it.std ? 1 : 0; });
    }));
    j.sections = secs;
    return j;
  }
  const showAll = () => !!db().opt.all;
  const visibleItems = (sv, r) => r.items.filter((it) => it.c || showAll());

  /* ── 文の表示（国の通知の文。障害児支援は下線＝標準確認項目） ── */
  function richX(x, u) {
    let h = "";
    // 全体に下線がある項目（ほとんどの標準確認項目）は線を引かない。一部だけに下線がある項目だけ、その部分に線を引く
    const cov = (u || []).reduce((n, [a, b]) => n + x.slice(a, b).replace(/\s/g, "").length, 0);
    if (cov >= x.replace(/\s/g, "").length * 0.9) u = null;
    if (u && u.length) {
      let last = 0;
      u.forEach(([a, b]) => { h += esc(x.slice(last, a)) + '<span class="ul">' + esc(x.slice(a, b)) + "</span>"; last = b; });
      h += esc(x.slice(last));
    } else h = esc(x);
    return h.replace(/\n/g, "<br>");
  }
  function kenLink(r, label) {
    return `<a class="kenl" href="${chHref(r.d, r.c, r.h)}">${label ? `<span class="kk">${esc(label)}</span>` : ""}<span>${esc(r.t)}</span>${ARR}</a>`;
  }
  function seg(v) {
    return '<div class="seg" role="radiogroup" aria-label="確認の結果">'
      + [1, 2, 3].map((n) => `<button type="button" role="radio" data-v="${n}" aria-checked="${v === n}">${ST_T[n]}</button>`).join("")
      + "</div>";
  }

  /* 点検表の1まとまり（mode: tk＝記録する／kk＝見るだけ） */
  function rowHtml(mode, oid, sv, r, flt) {
    const st = mode === "tk" ? stOf(oid, sv.id) : {};
    let items = visibleItems(sv, r);
    if (mode === "tk" && flt === "left") items = items.filter((it) => !st[it.k]);
    if (mode === "tk" && flt === "ng") items = items.filter((it) => st[it.k] && st[it.k][0] === 2);
    if (!items.length) return "";
    let h = `<article class="tkr${r.kenOnly ? " is-ken" : ""}" id="r-${r.k}" data-k="${r.k}"><header class="tkr-h">`;
    if (r.kenOnly) {
      h += `<span class="src-k">県の資料</span><h2>${esc(r.t)}</h2>`;
    } else {
      h += `<h2>${esc(r.t)}</h2>` + (r.law ? `<span class="law">${esc(r.law)}</span>` : "");
    }
    h += "</header>";
    if (r.kenOnly) {
      if (r.g) h += `<p class="tkr-g">${esc(r.g)}</p>`;
      if (r.sh) h += `<div class="sh"><span class="sh-h">運営指導での主な指摘</span><ul>${r.sh.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>`;
      h += `<p class="tkr-src">${kenLink(r)}</p>`;
      if (mode === "tk") {
        const v = st[r.k] ? st[r.k][0] : 0;
        h += `<div class="tk-it solo" data-k="${r.k}" data-c="1" data-s="${v}">${seg(v)}</div>`;
      }
    } else {
      h += '<ol class="tki">';
      items.forEach((it) => {
        const v = mode === "tk" && st[it.k] ? st[it.k][0] : 0;
        h += `<li class="tk-it${it.c ? "" : " is-ext"}" data-k="${it.k}" data-c="${it.c}" data-s="${v}">`
          + (it.c ? "" : '<span class="q ext">標準確認項目以外</span>')
          + (it.q ? `<span class="q">${esc(it.q)}</span>` : "")
          + `<p class="x">${richX(it.x, it.u)}</p>`
          + (it.law || it.ken ? `<p class="it-m">${it.law ? `<span class="law">${esc(it.law)}</span>` : ""}${it.ken ? kenLink(it.ken, "県の資料") : ""}</p>` : "")
          + (mode === "tk" ? seg(v) : "")
          + "</li>";
      });
      h += "</ol>";
      const docs = r.docs || [...new Set(r.items.flatMap((it) => it.docs || []))];
      if (docs.length) h += `<div class="tk-docs"><span class="k">確認文書</span><ul>${docs.map((d) => `<li>${esc(d)}</li>`).join("")}</ul>${r.note && r.note.length ? `<span class="nt">${esc(r.note.join(" "))}</span>` : ""}</div>`;
      if (r.ken && r.ken.length) {
        h += '<div class="tk-ken">' + r.ken.map((k) => {
          const n = k.sh ? k.sh.length : 0;
          return `<div class="kr">${kenLink(k, "県の資料")}`
            + (n ? `<details class="kr-sh"><summary>県の指摘 ${n}件</summary><ul>${k.sh.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></details>` : "")
            + "</div>";
        }).join("") + "</div>";
      }
    }
    if (mode === "tk") {
      const m = memoOf(oid)[sv.id + ":" + r.k];
      const t = m ? m.t : "";
      h += `<details class="memo"${t ? " open" : ""}><summary>メモ${t ? "" : '<span class="ph">書類の置き場所・対応</span>'}</summary>`
        + `<textarea rows="2" data-mk="${sv.id}:${r.k}" aria-label="メモ（書類の置き場所・対応）" placeholder="書類の置き場所・対応">${esc(t)}</textarea></details>`;
    }
    return h + "</article>";
  }
  function secProg(oid, sv, sec) {
    const st = oid ? stOf(oid, sv.id) : {};
    const p = { ok: 0, ng: 0, na: 0, tot: 0, left: 0 };
    sec.rows.forEach((r) => r.items.forEach((it) => {
      if (!it.c) return;
      p.tot++;
      const v = st[it.k] ? st[it.k][0] : 0;
      if (v === 1) p.ok++; else if (v === 2) p.ng++; else if (v === 3) p.na++; else p.left++;
    }));
    return p;
  }
  const secShort = (t) => t.replace(/^第[０-９0-9]+\s*/, (m) => m.trim() + " ").replace(/^個別サービスの質を確保するための体制に関する事項$/, "体制に関する事項").replace(/^個別サービスの質に関する事項$/, "サービスの質に関する事項");

  /* ── 画面 ── */
  const body = () => $("tk-body");
  function crumbs(list) {
    return `<p class="crumbs">${list.map(([href, t]) => href ? `<a href="${href}">${esc(t)}</a>` : `<span>${esc(t)}</span>`).join('<span aria-hidden="true">›</span>')}</p>`;
  }
  function loadingInto(sid, then) {
    body().innerHTML = '<p class="tk-wait">点検表を読み込んでいます…</p>';
    loadSvc(sid).then(then).catch(() => { body().innerHTML = '<p class="tk-wait">点検表を読み込めませんでした。時間をおいて開き直してください。</p>'; });
  }

  // 点検のはじめ
  function viewTenken() {
    const os = offices();
    let h = `<h1 class="vh">点検</h1><p class="vsub">${TK.index.some((x) => x.nk) ? "運営指導で確認される国の確認項目に、県の指摘事例を添えた点検表です。" : "運営指導で確認される国の確認項目の点検表です。"}</p>`;
    h += '<section class="tk-sec"><div class="tk-sh2"><h2>事業所</h2><a class="btn-s" href="#office-new">事業所を登録する</a></div>';
    if (os.length) {
      h += '<div class="ofc-grid">' + os.map(officeCard).join("") + "</div>";
    } else {
      h += '<p class="tk-empty">事業所を登録すると、サービスごとの点検表に結果とメモを残せます。</p>';
    }
    h += "</section>";
    h += '<section class="tk-sec"><h2 class="tk-h2">確認項目を見る</h2><div class="kk-groups">'
      + GORDER.map((g) => `<div class="kk-g"><h3>${esc(GT[g])}</h3><ul>${svcsOfGroup(g).map((s) => `<li><a href="#kk-${s.id}"><span>${esc(s.t)}</span><span class="n">${s.n + s.nk}項目</span></a></li>`).join("")}</ul></div>`).join("")
      + "</div></section>";
    h += '<section class="tk-sec tk-io"><h2 class="tk-h2">記録の書き出し・取り込み</h2>'
      + '<p class="vsub">記録はこの端末のブラウザに保存されます。別の端末へ移すときや、各事業所の記録を本部でまとめるときに使います。</p>'
      + (PREVIEW ? '<p class="tk-empty">書き出し・取り込みは公開ページで使えます。</p>' : '<div class="io-b"><button type="button" class="btn-o" data-act="export"' + (os.length ? "" : " disabled") + '>記録を書き出す</button>'
      + '<label class="btn-o"><input type="file" accept="application/json,.json" data-act="import" hidden>記録を取り込む</label></div><p class="io-msg" id="io-msg" aria-live="polite"></p>') + '</section>';
    if (HAS_GS || HAS_NK) h += '<section class="tk-sec"><h2 class="tk-h2">あわせて見る</h2><ul class="rows">' + (HAS_GS ? '<li><a href="#gensan">減算になる場面</a><span class="note">' + TK.gensan.length + '種類。県の資料の見出しと国の確認項目から</span></li>' : "") + (HAS_NK ? '<li><a href="#nenkan">年間でやること</a><span class="note">委員会・研修・訓練・届出などの回数と期限</span></li>' : "") + '</ul></section>';
    body().innerHTML = h;
    document.title = "点検｜" + F.titleTail;
  }
  function officeCard(o) {
    const p = progOffice(o);
    return `<a class="ofc" href="#office-${o.id}"><b>${esc(officeName(o))}</b>`
      + `<span class="ofc-s">${esc(o.svcs.map(svcName).join("・"))}</span>`
      + bar(p) + `<span class="ofc-m">${pcount(p)}</span></a>`;
  }

  // 事業所の登録・編集
  function viewForm(o, preset) {
    const isNew = !o;
    const sel = new Set(o ? o.svcs : (preset ? [preset] : []));
    let h = crumbs([["#tenken", "点検"], [null, isNew ? "事業所を登録" : "事業所の設定"]])
      + `<h1 class="vh">${isNew ? "事業所を登録" : "事業所の設定"}</h1>`
      + `<form class="ofc-form" id="ofc-form" data-id="${o ? o.id : ""}">`
      + `<label class="fld"><span>事業所の名前</span><input type="text" name="name" value="${esc(o ? o.name : "")}" maxlength="60" autocomplete="off" placeholder="例：〇〇ホーム"></label>`
      + '<fieldset class="fld"><legend>サービス（多機能型は複数）</legend>'
      + GORDER.map((g) => `<div class="chips-g"><span class="cg">${esc(GT[g])}</span><div class="chips">${svcsOfGroup(g).map((s) => `<label class="chip"><input type="checkbox" name="svc" value="${s.id}"${sel.has(s.id) ? " checked" : ""}><span>${esc(s.t)}</span></label>`).join("")}</div></div>`).join("")
      + "</fieldset>"
      + `<label class="fld"><span>指定の有効期間の満了日</span><input type="date" name="exp" value="${esc(o && o.exp ? o.exp : "")}"></label>`
      + '<p class="fld-err" id="ofc-err" aria-live="polite"></p>'
      + `<div class="form-b"><button type="submit" class="btn-p">${isNew ? "登録する" : "保存する"}</button>`
      + (isNew ? "" : `<button type="button" class="btn-d" data-act="del" data-id="${o.id}">この事業所と記録を消す</button>`)
      + "</div></form>";
    body().innerHTML = h;
    document.title = (isNew ? "事業所を登録" : "事業所の設定") + "｜" + F.titleTail;
  }

  // 事業所のページ
  function viewOffice(o) {
    const p = progOffice(o);
    let h = crumbs([["#tenken", "点検"], [null, officeName(o)]])
      + `<div class="ofc-head"><h1 class="vh">${esc(officeName(o))}</h1><a class="btn-s" href="#office-${o.id}-edit">設定</a></div>`
      + `<div class="ofc-sum">${bar(p, "big")}<div class="ofc-sum-m">${pcount(p)}<span class="lg"><i class="b1"></i>問題なし ${p.ok}</span><span class="lg"><i class="b2"></i>要対応 ${p.ng}</span><span class="lg"><i class="b3"></i>該当なし ${p.na}</span></div></div>`;
    h += '<section class="tk-sec"><h2 class="tk-h2">点検表</h2><ul class="svl">' + o.svcs.map((sid) => {
      const q = prog(o.id, sid);
      return `<li><a href="#tk-${o.id}-${sid}"><span class="t">${esc(svcName(sid))}</span>${bar(q)}<span class="m">${pcount(q)}</span>${ARR}</a></li>`;
    }).join("") + "</ul></section>";
    h += `<section class="tk-sec"><h2 class="tk-h2">要対応</h2>` + (p.ng ? `<p><a class="btn-s" href="#todo-${o.id}">要対応の一覧（${p.ng}件）</a></p>` : '<p class="tk-empty">要対応にした項目はありません。</p>') + "</section>";
    // 年間（期限の近いもの）
    const due = nenkanFor(o).filter((x) => x.kind === "date" && x.dueYmd && dms(x.dueYmd) >= todayMs() && !yrDone(o.id, x.id, 0)).sort((a, b) => dms(a.dueYmd) - dms(b.dueYmd)).slice(0, 3);
    h += HAS_NK ? `<section class="tk-sec"><div class="tk-sh2"><h2>年間でやること</h2><a class="btn-s" href="#nenkan?o=${o.id}">年間を開く</a></div>` : `<section class="tk-sec">`;
    if (o.exp) h += `<p class="exp-line"><span class="k">指定の有効期間の満了日</span>${jdate(o.exp, true)}${leftText(o.exp)}</p>`;
    h += due.length ? `<ul class="due-mini">${due.map((x) => `<li><span class="d">${jdate(x.dueYmd)}</span><span class="t">${esc(x.t)}${x.cond ? `<span class="cond">${esc(x.cond)}</span>` : ""}</span>${leftText(x.dueYmd)}</li>`).join("")}</ul>` : "";
    h += "</section>";
    if (!PREVIEW) h += `<section class="tk-sec tk-io"><h2 class="tk-h2">書き出し</h2><div class="io-b"><button type="button" class="btn-o" data-act="csv" data-id="${o.id}">この事業所の点検結果をCSVで書き出す</button><button type="button" class="btn-o" data-act="export" data-id="${o.id}">この事業所の記録を書き出す</button></div><p class="io-msg" id="io-msg" aria-live="polite"></p></section>`;
    body().innerHTML = h;
    document.title = officeName(o) + "｜点検";
  }

  // サービスの点検表（区分の一覧）
  function viewSvc(mode, o, sid) {
    loadingInto(sid, (sv) => {
      const oid = o ? o.id : null;
      const base = mode === "tk" ? `#tk-${oid}-${sid}` : `#kk-${sid}`;
      let h = crumbs(mode === "tk" ? [["#tenken", "点検"], [`#office-${oid}`, officeName(o)], [null, sv.t]] : [["#tenken", "点検"], [null, "確認項目"], [null, sv.t]])
        + `<h1 class="vh">${esc(sv.t)}</h1>`;
      const s = SIX[sid];
      h += `<p class="ch-meta"><span>国の確認項目 ${s.n}</span>${s.nk ? `<span>県の資料から ${s.nk}</span>` : ""}${s.na > s.n ? `<span>標準確認項目以外 ${s.na - s.n}</span>` : ""}</p>`;
      if (mode === "tk") { const p = prog(oid, sid); h += `<div class="ofc-sum">${bar(p, "big")}<div class="ofc-sum-m">${pcount(p)}</div></div>`; }
      else h += kkCta(sid);
      h += '<ol class="secl">' + sv.sections.map((sec, i) => {
        const p = secProg(oid, sv, sec);
        return `<li><a href="${base}-${i + 1}"><span class="t">${esc(secShort(sec.t))}</span>`
          + (mode === "tk" ? bar(p) + `<span class="m">${pcount(p)}</span>` : `<span class="m"><span class="pc"><span>${p.tot}</span></span></span>`)
          + `${ARR}</a></li>`;
      }).join("") + "</ol>";
      h += srcNote(sv);
      body().innerHTML = h;
      document.title = sv.t + "｜点検";
    });
  }
  function kkCta(sid) {
    const has = offices().filter((o) => o.svcs.includes(sid));
    if (has.length) return `<div class="kk-cta"><span>点検する</span>${has.map((o) => `<a class="btn-s" href="#tk-${o.id}-${sid}">${esc(officeName(o))}</a>`).join("")}</div>`;
    return `<div class="kk-cta"><a class="btn-p" href="#office-new?s=${sid}">この確認項目で点検する</a></div>`;
  }
  function srcNote(sv) {
    const s = TK.src[sv.src];
    return `<p class="tk-src">出典：${esc(s.by)}「${esc(s.of)}」の${sv.src === "ji" ? "別紙「主眼事項及び着眼点等」" : (sv.src === "kaigo" ? "別添「確認項目及び確認文書」" : "「確認項目及び確認文書」")}（${A(s.u, (sv.src === "kaigo" ? "PDF" : "PDF・Excel") + EXT)}）。文は通知のまま載せています。${sv.src === "ji" ? "下線は通知の下線（標準確認項目）です。" : ""}</p>`;
  }

  // 区分のページ（点検表の本体）
  function viewSec(mode, o, sid, n, params) {
    loadingInto(sid, (sv) => {
      const sec = sv.sections[n - 1];
      if (!sec) { location.replace(mode === "tk" ? `#tk-${o.id}-${sid}` : `#kk-${sid}`); return; }
      const oid = o ? o.id : null;
      const base = mode === "tk" ? `#tk-${oid}-${sid}` : `#kk-${sid}`;
      const flt = mode === "tk" ? (db().opt.flt || "all") : "all";
      let h = crumbs(mode === "tk" ? [["#tenken", "点検"], [`#office-${oid}`, officeName(o)], [base, sv.t]] : [["#tenken", "点検"], [`#kk-${sid}`, sv.t]])
        + `<h1 class="vh sec-h">${esc(secShort(sec.t))}</h1>`;
      if (mode === "tk") {
        const p = secProg(oid, sv, sec);
        h += `<div class="ofc-sum" id="sec-sum">${bar(p, "big")}<div class="ofc-sum-m">${pcount(p)}</div></div>`;
        h += '<div class="tk-bar"><div class="flt" role="group" aria-label="表示する項目">'
          + [["all", "すべて"], ["left", "未確認"], ["ng", "要対応"]].map(([v, t]) => `<button type="button" data-flt="${v}" aria-pressed="${flt === v}">${t}</button>`).join("")
          + "</div>"
          + (sv.src === "ji" && !sec.ken ? `<label class="tgl"><input type="checkbox" data-act="all"${showAll() ? " checked" : ""}><span>標準確認項目以外も表示</span></label>` : "")
          + `<button type="button" class="btn-o sm" data-act="na-sec">この区分をすべて該当なしにする</button>`
          + printBtn()
          + "</div>";
      } else {
        h += kkCta(sid);
        if (sv.src === "ji" && !sec.ken) h += `<div class="tk-bar"><label class="tgl"><input type="checkbox" data-act="all"${showAll() ? " checked" : ""}><span>標準確認項目以外も表示</span></label></div>`;
      }
      const rows = sec.rows.map((r) => rowHtml(mode, oid, sv, r, flt)).join("");
      h += `<div class="tkrs" data-sid="${sid}" data-n="${n}">${rows || '<p class="tk-empty">この表示に当てはまる項目はありません。</p>'}</div>`;
      const prev = n > 1 ? sv.sections[n - 2] : null, next = n < sv.sections.length ? sv.sections[n] : null;
      if (prev || next) {
        h += `<nav class="pager two" aria-label="前後の区分">`
          + (prev ? `<a class="prev" href="${base}-${n - 1}">${ARL}<span class="pk">前へ</span><span class="pt">${esc(secShort(prev.t))}</span><span class="ps">前へ</span></a>` : "<span></span>")
          + (next ? `<a class="next" href="${base}-${n + 1}"><span class="pk">次へ</span><span class="pt">${esc(secShort(next.t))}</span>${ARR}</a>` : "")
          + "</nav>";
      }
      h += srcNote(sv);
      body().innerHTML = h;
      setSubnav(`<a class="sn-back" href="${base}">${ARL}<span>${esc(sv.t)}</span></a><ol>` + sv.sections.map((x, i) => {
        const p = secProg(oid, sv, x);
        return `<li><a href="${base}-${i + 1}"${i + 1 === n ? ' class="is-active" aria-current="page"' : ""}><span>${esc(secShort(x.t))}</span><span class="c">${mode === "tk" ? doneN(p) + "/" : ""}${p.tot}</span></a></li>`;
      }).join("") + "</ol>");
      document.title = secShort(sec.t) + "｜" + sv.t;
      const r = params.get("r");
      if (r) { const el = document.getElementById("r-" + r); if (el) { el.classList.add("is-hl"); requestAnimationFrame(() => el.scrollIntoView({ block: "start" })); } }
    });
  }
  function refreshSecSum() {
    const wrap = body().querySelector(".tkrs");
    const box = $("sec-sum");
    if (!wrap || !box) return;
    const m = location.hash.match(/^#tk-([a-z0-9]+)-([a-z0-9-]+)-(\d+)/);
    if (!m) return;
    const sv = SVCDATA[m[2]];
    if (!sv) return;
    const p = secProg(m[1], sv, sv.sections[Number(m[3]) - 1]);
    box.innerHTML = `${bar(p, "big")}<div class="ofc-sum-m">${pcount(p)}</div>`;
    const a = document.querySelector(`#subnav a[href="${location.hash.split("?")[0]}"] .c`);
    if (a) a.textContent = doneN(p) + "/" + p.tot;
  }

  // 要対応の一覧（事業所のサービスすべて）
  function viewTodo(o) {
    body().innerHTML = '<p class="tk-wait">要対応の項目を集めています…</p>';
    Promise.all(o.svcs.map(loadSvc)).then((svs) => {
      let h = crumbs([["#tenken", "点検"], [`#office-${o.id}`, officeName(o)], [null, "要対応"]])
        + `<h1 class="vh">要対応の一覧</h1>` + (PREVIEW ? "" : `<div class="tk-bar">${printBtn()}</div>`);
      let any = 0;
      svs.forEach((sv) => {
        let part = "";
        sv.sections.forEach((sec, i) => {
          const rows = sec.rows.map((r) => rowHtml("tk", o.id, sv, r, "ng")).join("");
          if (rows) part += `<h3 class="todo-sec"><a href="#tk-${o.id}-${sv.id}-${i + 1}">${esc(secShort(sec.t))}</a></h3><div class="tkrs" data-sid="${sv.id}">${rows}</div>`;
        });
        if (part) { any++; h += `<section class="todo-svc"><h2 class="tk-h2">${esc(sv.t)}</h2>${part}</section>`; }
      });
      if (!any) h += '<p class="tk-empty">要対応にした項目はありません。</p>';
      body().innerHTML = h;
      document.title = "要対応｜" + officeName(o);
    }).catch(() => { body().innerHTML = '<p class="tk-wait">点検表を読み込めませんでした。時間をおいて開き直してください。</p>'; });
  }

  /* ── 減算 ── */
  function gsvcText(e) {
    const gs = GORDER.filter((g) => svcsOfGroup(g).some((s) => e.svcs.includes(s.id)));
    return gs.map((g) => {
      const all = svcsOfGroup(g), on = all.filter((s) => e.svcs.includes(s.id));
      return on.length === all.length ? GT[g] : on.map((s) => s.t).join("・");
    }).join("／");
  }
  function viewGensan() {
    let h = `<h1 class="vh">減算になる場面</h1><p class="vsub">県の資料の見出しと、障害児支援の国の着眼点に出てくる減算です。</p><ul class="gl">`;
    h += TK.gensan.map((e) => {
      const nsh = e.docs.reduce((n, d) => n + (d.shiteki ? d.shiteki.length : 0), 0);
      return `<li><a href="#gensan-${e.id}"><span class="t">${esc(e.t)}</span><span class="s">${esc(gsvcText(e))}</span>`
        + `<span class="m">${e.docs.length ? `県の資料 ${e.docs.length}編` : ""}${e.nat.length ? `${e.docs.length ? "・" : ""}国の着眼点 ${e.nat.length}` : ""}${nsh ? `・指摘 ${nsh}` : ""}</span>${ARR}</a></li>`;
    }).join("") + "</ul>";
    body().innerHTML = h;
    document.title = "減算になる場面｜集団指導 特設ページ";
  }
  function viewGensanOne(e) {
    let h = crumbs([["#gensan", "減算になる場面"], [null, e.t]]) + `<h1 class="vh">${esc(e.t)}</h1><p class="svc-names">${esc(gsvcText(e))}</p>`;
    e.docs.forEach((d) => {
      h += `<section class="gs-doc"><h2><span class="gk">${esc(GT[d.d])}</span>${esc(d.t)}</h2>`
        + noteBody({ gist: d.gist, points: d.points, shiteki: d.shiteki })
        + `<p class="tkr-src">${kenLink(d, "県の資料")}</p></section>`;
    });
    if (e.nat.length) {
      h += `<section class="gs-nat"><h2>国の着眼点（障害児支援）</h2>` + e.nat.map((x) => `<div class="gs-n"><p class="gs-s"><a href="#kk-${x.s}?r=${x.r}" data-kk="${x.s}" data-r="${x.r}">${esc(svcName(x.s))}・${esc(x.rt)}</a></p><p class="x">${richX(x.x, x.u)}</p>${x.law ? `<p class="it-m"><span class="law">${esc(x.law)}</span></p>` : ""}</div>`).join("") + "</section>";
    }
    if (e.rel.length) {
      const by = {};
      e.rel.forEach(([sid, rk, rt]) => { (by[rt] = by[rt] || []).push([sid, rk]); });
      h += `<section class="gs-rel"><h2>関係する国の確認項目</h2>` + Object.entries(by).map(([rt, lst]) =>
        `<div class="gs-r"><span class="t">${esc(rt.replace(/^[０-９0-9]+(の[０-９0-9]+)?\s*/, ""))}</span><span class="chips">${lst.map(([sid, rk]) => `<a class="chip-a" href="#kk-${sid}?r=${rk}" data-kk="${sid}" data-r="${rk}">${esc(svcName(sid))}</a>`).join("")}</span></div>`).join("") + "</section>";
    }
    body().innerHTML = h;
    document.title = e.t + "｜減算になる場面";
  }

  /* ── 年間 ── */
  const PERIODS = {
    12: ["4月", "5月", "6月", "7月", "8月", "9月", "10月", "11月", "12月", "1月", "2月", "3月"],
    4: ["4〜6月", "7〜9月", "10〜12月", "1〜3月"],
    2: ["4〜9月", "10〜3月"],
    1: ["今年度"],
  };
  function periodIndex(per) {
    const [, m] = ymdOf(todayMs());
    const k = (m + 8) % 12;   // 4月＝0
    return per === 12 ? k : per === 4 ? Math.floor(k / 3) : per === 2 ? Math.floor(k / 6) : 0;
  }
  function yrArr(oid, id) {
    const y = db().yr, fy = String(fyNow());
    if (!y[oid]) y[oid] = {};
    if (!y[oid][fy]) y[oid][fy] = {};
    if (!y[oid][fy][id]) y[oid][fy][id] = [];
    return y[oid][fy][id];
  }
  const yrDone = (oid, id, i) => !!(((db().yr[oid] || {})[String(fyNow())] || {})[id] || [])[i];
  function nenkanFor(o) {
    const fy = fyNow();
    const its = TK.nenkan.items.filter((x) => !o || x.svcs.some((s) => o.svcs.includes(s)));
    return its.map((x) => {
      const y = Object.assign({}, x);
      if (x.kind === "date" && x.due) {
        if (/^\d{2}-\d{2}$/.test(x.due)) { const m = Number(x.due.slice(0, 2)); y.dueYmd = `${m >= 4 ? fy : fy + 1}-${x.due}`; }
        else y.dueYmd = x.due;
      }
      if (x.kind === "freq") {
        const sids = o ? x.svcs.filter((s) => o.svcs.includes(s)) : x.svcs;
        const perOf = (sid) => { const by = x.by || {}; return by[sid] ?? by[SIX[sid] ? SIX[sid].g : ""] ?? x.per; };
        y.n = Math.max(1, ...sids.map(perOf));
        const fqOf = (sid) => { const f = x.fq || {}; return f[sid] || f[SIX[sid] ? SIX[sid].g : ""] || f["*"] || ""; };
        const groups = {};
        sids.forEach((sid) => { const t = fqOf(sid); (groups[t] = groups[t] || []).push(sid); });
        const ent = Object.entries(groups).sort((a, b) => b[1].length - a[1].length);
        y.fqText = ent.length ? ent[0][0] + (ent.length > 1 ? "（" + ent.slice(1).map(([t, ss]) => (o ? ss.map(svcName).join("・") : groupLabelOf(ss)) + "は" + t).join("、") + "）" : "") : "";
        y.per0 = sids.every((sid) => perOf(sid) === 0);
      }
      if (x.kind === "user") {
        const sids = o ? x.svcs.filter((s) => o.svcs.includes(s)) : x.svcs;
        const bt = x.byText || {};
        const others = sids.filter((s) => bt[s]);
        y.fqText = x.every + (others.length && others.length < sids.length ? "（" + others.map((s) => svcName(s) + "は" + bt[s]).join("、") + "）" : (others.length ? "" : ""));
        if (others.length && others.length === sids.length) y.fqText = [...new Set(others.map((s) => bt[s]))].join("・");
      }
      return y;
    });
  }
  function groupLabelOf(sids) {
    const gs = GORDER.filter((g) => svcsOfGroup(g).every((s) => sids.includes(s.id)) && svcsOfGroup(g).length);
    const rest = sids.filter((s) => !gs.includes(SIX[s] ? SIX[s].g : ""));
    return gs.map((g) => GT[g]).concat(rest.map(svcName)).join("・");
  }
  function evHtml(x) {
    const need = x.needLabel ? `<li><p>対象のサービス：県の資料に定めがある区分（${esc((x.needGroups || []).join("・"))}）のうち、国の確認項目に「${esc(x.needLabel)}」の項目があるサービス</p></li>` : "";
    if (x.src && (!x.ev || !x.ev.length)) return `<details class="ev"><summary>根拠</summary><ul><li>${A(x.src.u, esc(x.src.t) + EXT)}</li></ul></details>`;
    if (!x.ev || !x.ev.length) return "";
    return `<details class="ev"><summary>根拠</summary><ul>${need}${x.ev.map((e) => `<li><p>${esc(e.x)}</p><a href="${chHref(e.d, e.c, e.h)}"><span class="gk">${esc(SHORT[e.d] || e.d)}</span>${esc(e.t)}</a></li>`).join("")}</ul></details>`;
  }
  function viewNenkan(params) {
    const os = offices();
    let oid = params.get("o") || db().opt.nko || (os[0] && os[0].id) || "";
    if (oid && !officeOf(oid)) oid = os[0] ? os[0].id : "";
    const o = oid ? officeOf(oid) : null;
    if (o) { db().opt.nko = o.id; save(); }
    const fy = fyNow();
    const reiwa = fy - 2018;
    let h = `<h1 class="vh">年間でやること</h1><p class="vsub">令和${reiwa}年度（${fy}年4月〜${fy + 1}年3月）。回数と期限は、県の資料の要点に書かれているものです。</p>`;
    if (os.length) {
      h += '<div class="ofc-pick" role="group" aria-label="事業所">' + os.map((x) => `<a href="#nenkan?o=${x.id}"${o && x.id === o.id ? ' aria-current="true" class="is-on"' : ""}>${esc(officeName(x))}</a>`).join("") + "</div>";
    } else {
      h += '<div class="kk-cta"><span>実施の記録は事業所ごとに付けます</span><a class="btn-p" href="#office-new">事業所を登録する</a></div>';
    }
    const list = nenkanFor(o);
    const t0 = todayMs();
    const dated = list.filter((x) => x.kind === "date" && x.dueYmd).sort((a, b) => {
      const pa = dms(a.dueYmd) < t0 ? 1 : 0, pb = dms(b.dueYmd) < t0 ? 1 : 0;
      return pa - pb || dms(a.dueYmd) - dms(b.dueYmd);
    });
    const freq = list.filter((x) => x.kind === "freq");
    const user = list.filter((x) => x.kind === "user");
    const long = list.filter((x) => x.kind === "long");
    h += '<section class="nk-sec"><h2 class="tk-h2">期限のあるもの</h2><ul class="nk-d">' + dated.map((x) => {
      const done = o && yrDone(o.id, x.id, 0);
      const past = dms(x.dueYmd) < t0;
      return `<li class="${done ? "is-done" : ""}${past ? " is-past" : ""}"><div class="nk-row"><span class="d">${x.dueLabel ? esc(x.dueLabel) + "<small>（" + jdate(x.dueYmd) + "まで）</small>" : jdate(x.dueYmd)}</span>`
        + `<span class="t">${esc(x.t)}${x.cond ? `<span class="cond">${esc(x.cond)}</span>` : ""}</span>`
        + `<span class="r">${done ? '<span class="left is-done">済</span>' : leftText(x.dueYmd)}${o ? `<button type="button" class="box" data-yr="${x.id}" data-i="0" aria-pressed="${!!done}" aria-label="${esc(x.t)}を済にする">済</button>` : ""}</span></div>`
        + (x.link ? `<p class="nk-l">${A(x.link, "受講登録のフォーム" + EXT)}</p>` : "")
        + evHtml(x) + "</li>";
    }).join("") + "</ul></section>";
    h += '<section class="nk-sec"><h2 class="tk-h2">回数の決まっているもの</h2><ul class="nk-f">' + freq.map((x) => {
      const per = x.per0 ? 1 : x.n;
      const labels = PERIODS[per] || PERIODS[1];
      const cur = periodIndex(per);
      const one = per === 1;
      const boxes = o && !one ? `<div class="boxes n${per}">` + labels.map((lb, i) => {
        const d = yrDone(o.id, x.id, i);
        const over = !d && i < cur;
        return `<button type="button" class="box${over ? " is-over" : ""}${i === cur ? " is-cur" : ""}" data-yr="${x.id}" data-i="${i}" aria-pressed="${d}">${lb}</button>`;
      }).join("") + "</div>" : "";
      const d1 = o && one && yrDone(o.id, x.id, 0);
      const inline = o && one ? `<button type="button" class="box" data-yr="${x.id}" data-i="0" aria-pressed="${!!d1}" aria-label="${esc(x.t)}（今年度）を済にする">${d1 ? "今年度 済" : "今年度"}</button>` : "";
      return `<li><div class="nk-row has-r"><span class="t">${esc(x.t)}${x.cond ? `<span class="cond">${esc(x.cond)}</span>` : ""}</span><span class="fq">${esc(x.fqText || "")}${x.note ? `<small>${esc(x.note)}</small>` : ""}</span>${inline ? `<span class="r">${inline}</span>` : ""}</div>${boxes}${evHtml(x)}</li>`;
    }).join("") + "</ul></section>";
    if (user.length) {
      h += '<section class="nk-sec"><h2 class="tk-h2">利用者ごと・そのつど</h2><ul class="nk-f">' + user.map((x) =>
        `<li><div class="nk-row"><span class="t">${esc(x.t)}</span><span class="fq">${esc(x.fqText || x.every)}${x.note ? `<small>${esc(x.note)}</small>` : ""}</span></div>${evHtml(x)}</li>`).join("") + "</ul></section>";
    }
    if (long.length) {
      h += '<section class="nk-sec"><h2 class="tk-h2">数年ごと</h2><ul class="nk-f">' + long.map((x) => {
        let r = "";
        if (x.useExp && o) {
          if (!o.exp) r = `<p class="exp-line"><a href="#office-${o.id}-edit">満了日を登録する</a></p>`;
          else if (x.expRule === "prevMonth15") {
            const [y, m] = o.exp.split("-").map(Number);
            const py = m === 1 ? y - 1 : y, pm = m === 1 ? 12 : m - 1;
            const due = `${py}-${String(pm).padStart(2, "0")}-15`;
            r = `<p class="exp-line"><span class="k">申請の期限</span>${jdate(due, true)}${leftText(due)}<span class="k">（満了日 ${jdate(o.exp, true)}）</span></p>`;
          } else r = `<p class="exp-line"><span class="k">満了日</span>${jdate(o.exp, true)}${leftText(o.exp)}</p>`;
        }
        return `<li><div class="nk-row"><span class="t">${esc(x.t)}${x.cond ? `<span class="cond">${esc(x.cond)}</span>` : ""}</span><span class="fq">${esc(x.every)}</span></div>${r}${evHtml(x)}</li>`;
      }).join("") + "</ul></section>";
    }
    body().innerHTML = h;
    document.title = "年間でやること｜集団指導 特設ページ";
  }

  /* ── 操作 ── */
  document.addEventListener("click", (e) => {
    const b = e.target.closest("#tk-body .seg button");
    if (b) {
      const it = b.closest(".tk-it"), v = Number(b.dataset.v);
      const m = location.hash.match(/^#(?:tk|todo)-([a-z0-9]+)/);
      const sid = b.closest("[data-sid]") ? b.closest("[data-sid]").dataset.sid : null;
      if (!m || !sid) return;
      const st = stOf(m[1], sid);
      const cur = st[it.dataset.k] ? st[it.dataset.k][0] : 0;
      if (cur === v) delete st[it.dataset.k];
      else st[it.dataset.k] = [v, nowStamp(), Number(it.dataset.c)];
      save();
      const nv = cur === v ? 0 : v;
      it.dataset.s = String(nv);
      it.querySelectorAll(".seg button").forEach((x) => x.setAttribute("aria-checked", String(Number(x.dataset.v) === nv)));
      refreshSecSum();
      return;
    }
    const f = e.target.closest("#tk-body [data-flt]");
    if (f) { db().opt.flt = f.dataset.flt; save(); route(); return; }
    const box = e.target.closest("#tk-body [data-yr]");
    if (box) {
      const o = officeOf(db().opt.nko);
      if (!o) return;
      const arr = yrArr(o.id, box.dataset.yr), i = Number(box.dataset.i);
      arr[i] = arr[i] ? 0 : nowStamp();
      save();
      const y = window.scrollY; route(); window.scrollTo(0, y);
      return;
    }
    const act = e.target.closest("#tk-body [data-act]");
    if (!act || act.tagName === "INPUT") return;
    const a = act.dataset.act;
    if (a === "print") { window.print(); return; }
    if (a === "export") { exportJson(act.dataset.id); return; }
    if (a === "csv") { exportCsv(act.dataset.id); return; }
    if (a === "del") {
      if (act.dataset.armed !== "1") { act.dataset.armed = "1"; act.textContent = "もう一度押すと消します"; setTimeout(() => { if (act.isConnected) { act.dataset.armed = ""; act.textContent = "この事業所と記録を消す"; } }, 4000); return; }
      const id = act.dataset.id, d = db();
      d.offices = d.offices.filter((o) => o.id !== id);
      delete d.st[id]; delete d.memo[id]; delete d.yr[id];
      if (d.opt.nko === id) delete d.opt.nko;
      saveNow(); go("#tenken"); return;
    }
    if (a === "na-sec") {
      const m = location.hash.match(/^#tk-([a-z0-9]+)-([a-z0-9-]+)-(\d+)/);
      if (!m) return;
      if (act.dataset.armed !== "1") { act.dataset.armed = "1"; act.textContent = "もう一度押すと、未確認の項目を該当なしにします"; setTimeout(() => { if (act.isConnected) { act.dataset.armed = ""; act.textContent = "この区分をすべて該当なしにする"; } }, 4000); return; }
      const sv = SVCDATA[m[2]], sec = sv.sections[Number(m[3]) - 1], st = stOf(m[1], m[2]);
      sec.rows.forEach((r) => visibleItems(sv, r).forEach((it) => { if (!st[it.k]) st[it.k] = [3, nowStamp(), it.c]; }));
      save(); const y = window.scrollY; route(); window.scrollTo(0, y); return;
    }
  });
  document.addEventListener("change", (e) => {
    const t = e.target;
    if (t.matches && t.matches('#tk-body input[data-act="all"]')) { db().opt.all = t.checked; save(); const y = window.scrollY; route(); window.scrollTo(0, y); return; }
    if (t.matches && t.matches('#tk-body input[data-act="import"]')) { importJson(t.files && t.files[0]); t.value = ""; }
  });
  document.addEventListener("input", (e) => {
    const t = e.target;
    if (!t.matches || !t.matches("#tk-body textarea[data-mk]")) return;
    const m = location.hash.match(/^#(?:tk|todo)-([a-z0-9]+)/);
    if (!m) return;
    const mm = memoOf(m[1]);
    if (t.value.trim()) mm[t.dataset.mk] = { t: t.value, at: nowStamp() }; else delete mm[t.dataset.mk];
    save();
  });
  document.addEventListener("submit", (e) => {
    const f = e.target.closest("#ofc-form");
    if (!f) return;
    e.preventDefault();
    const svcs = [...f.querySelectorAll('input[name="svc"]:checked')].map((x) => x.value);
    if (!svcs.length) { $("ofc-err").textContent = "サービスを1つ以上選んでください"; return; }
    const name = f.querySelector('input[name="name"]').value.trim();
    const exp = f.querySelector('input[name="exp"]').value || "";
    const d = db();
    let o = officeOf(f.dataset.id);
    if (o) Object.assign(o, { name, svcs, exp });
    else { o = { id: newId(), name, svcs, exp, at: nowStamp() }; d.offices.push(o); }
    saveNow();
    go(`#office-${o.id}`);
  }, true);

  /* ── 書き出し・取り込み ── */
  function download(name, text, type) {
    const blob = new Blob([text], { type });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  const fileStamp = () => nowStamp().replace(/-/g, "");
  function exportJson(oid) {
    const d = db();
    const os = oid ? d.offices.filter((o) => o.id === oid) : d.offices;
    const pick = (obj) => Object.fromEntries(os.map((o) => [o.id, obj[o.id] || {}]));
    const out = { app: "syudan-tenken", fld: F.id, v: 1, at: nowStamp(), offices: os, st: pick(d.st), memo: pick(d.memo), yr: pick(d.yr) };
    download(`集団指導_点検_${F.id === "shogai" ? "" : FLABEL + "_"}${oid ? officeName(os[0]) : "すべて"}_${fileStamp()}.json`, JSON.stringify(out), "application/json");
    const m = $("io-msg"); if (m) m.textContent = `${os.length}事業所の記録を書き出しました`;
  }
  function importJson(file) {
    const msg = $("io-msg");
    if (!file) return;
    file.text().then((t) => {
      const j = JSON.parse(t);
      if (j.app !== "syudan-tenken" || !Array.isArray(j.offices) || (j.fld || "shogai") !== F.id) throw new Error("形式");
      const d = db();
      let add = 0, upd = 0;
      j.offices.forEach((o) => {
        const cur = officeOf(o.id);
        if (cur) { Object.assign(cur, { name: o.name, svcs: o.svcs, exp: o.exp }); upd++; } else { d.offices.push(o); add++; }
        // 結果は新しい日付のほうを残す
        const st = j.st[o.id] || {};
        if (!d.st[o.id]) d.st[o.id] = {};
        Object.entries(st).forEach(([sid, m]) => {
          const to = d.st[o.id][sid] || (d.st[o.id][sid] = {});
          Object.entries(m).forEach(([k, v]) => { if (!to[k] || String(v[1]) >= String(to[k][1])) to[k] = v; });
        });
        const mm = j.memo[o.id] || {};
        if (!d.memo[o.id]) d.memo[o.id] = {};
        Object.entries(mm).forEach(([k, v]) => { const c = d.memo[o.id][k]; if (!c || String(v.at) >= String(c.at)) d.memo[o.id][k] = v; });
        const yr = j.yr[o.id] || {};
        if (!d.yr[o.id]) d.yr[o.id] = {};
        Object.entries(yr).forEach(([fy, m]) => {
          const to = d.yr[o.id][fy] || (d.yr[o.id][fy] = {});
          Object.entries(m).forEach(([id, arr]) => { const c = to[id] || []; to[id] = arr.map((v, i) => v || c[i] || 0); });
        });
      });
      saveNow();
      route();
      const m2 = $("io-msg"); if (m2) m2.textContent = `取り込みました（追加 ${add}・更新 ${upd}事業所）`;
    }).catch(() => { if (msg) msg.textContent = "このファイルは取り込めませんでした（このページで書き出したファイルを選んでください）"; });
  }
  function exportCsv(oid) {
    const o = officeOf(oid);
    if (!o) return;
    Promise.all(o.svcs.map(loadSvc)).then((svs) => {
      const q = (s) => '"' + String(s ?? "").replace(/"/g, '""') + '"';
      const lines = [["サービス", "区分", "まとまり", "確認項目", "結果", "記録日", "メモ", "確認文書"].map(q).join(",")];
      const mm = memoOf(o.id);
      svs.forEach((sv) => {
        const st = stOf(o.id, sv.id);
        sv.sections.forEach((sec) => sec.rows.forEach((r) => {
          const docs = (r.docs || [...new Set(r.items.flatMap((it) => it.docs || []))]).join("・");
          const memo = (mm[sv.id + ":" + r.k] || {}).t || "";
          visibleItems(sv, r).forEach((it) => {
            const v = st[it.k];
            lines.push([sv.t, secShort(sec.t), r.t, it.x.replace(/\n/g, " "), v ? ST_T[v[0]] : "未確認", v ? v[1] : "", memo, docs].map(q).join(","));
          });
        }));
      });
      download(`集団指導_点検_${F.id === "shogai" ? "" : FLABEL + "_"}${officeName(o)}_${fileStamp()}.csv`, "﻿" + lines.join("\r\n"), "text/csv");
      const m = $("io-msg"); if (m) m.textContent = "CSVを書き出しました";
    });
  }

  /* ── 画面の切り替え（app.js の route から呼ばれる） ── */
  EXT_ROUTES.push((name, params) => {
    let m;
    if (name === "tenken") { viewTenken(); return { view: "tkview", g: "tenken" }; }
    if (name === "office-new") { viewForm(null, params.get("s")); return { view: "tkview", g: "tenken" }; }
    if ((m = name.match(/^office-([a-z0-9]+)-edit$/)) && officeOf(m[1])) { viewForm(officeOf(m[1])); return { view: "tkview", g: "tenken" }; }
    if ((m = name.match(/^office-([a-z0-9]+)$/)) && officeOf(m[1])) { viewOffice(officeOf(m[1])); return { view: "tkview", g: "tenken" }; }
    if ((m = name.match(/^todo-([a-z0-9]+)$/)) && officeOf(m[1])) { viewTodo(officeOf(m[1])); return { view: "tkview", g: "tenken" }; }
    if ((m = name.match(/^tk-([a-z0-9]+)-([a-z0-9-]+?)(?:-(\d+))?$/)) && officeOf(m[1]) && SIX[m[2]] && officeOf(m[1]).svcs.includes(m[2])) {
      const r = params.get("r");
      if (!m[3] && r) {   // 確認項目の場所を指定して開く: その区分のページへ
        loadSvc(m[2]).then((sv) => {
          const i = sv.sections.findIndex((s) => s.rows.some((x) => x.k === r));
          location.replace(`#tk-${m[1]}-${m[2]}-${i >= 0 ? i + 1 : 1}?r=${r}`);
        }).catch(() => {});
        body().innerHTML = '<p class="tk-wait">点検表を読み込んでいます…</p>';
        return { view: "tkview", g: "tenken" };
      }
      if (m[3]) { viewSec("tk", officeOf(m[1]), m[2], Number(m[3]), params); return { view: "tkview", g: "tenken", sub: true }; }
      viewSvc("tk", officeOf(m[1]), m[2]); setSubnav(""); return { view: "tkview", g: "tenken" };
    }
    if ((m = name.match(/^kk-([a-z0-9-]+?)(?:-(\d+))?$/)) && SIX[m[1]]) {
      const r = params.get("r");
      if (!m[2] && r) {   // 確認項目の場所を指定して開く: その区分のページへ
        loadSvc(m[1]).then((sv) => {
          const i = sv.sections.findIndex((s) => s.rows.some((x) => x.k === r));
          location.replace(`#kk-${m[1]}-${i >= 0 ? i + 1 : 1}?r=${r}`);
        }).catch(() => {});
        body().innerHTML = '<p class="tk-wait">点検表を読み込んでいます…</p>';
        return { view: "tkview", g: "tenken" };
      }
      if (m[2]) { viewSec("kk", null, m[1], Number(m[2]), params); return { view: "tkview", g: "tenken", sub: true }; }
      viewSvc("kk", null, m[1]); return { view: "tkview", g: "tenken" };
    }
    if (name === "gensan" && HAS_GS) { viewGensan(); return { view: "tkview", g: "gensan" }; }
    if ((m = name.match(/^gensan-([a-z0-9]+)$/))) {
      const e = TK.gensan.find((x) => x.id === m[1]);
      if (e) { viewGensanOne(e); return { view: "tkview", g: "gensan" }; }
    }
    if (name === "nenkan" && HAS_NK) { viewNenkan(params); return { view: "tkview", g: "nenkan" }; }
    return null;
  });

  /* ── ホームの「運営指導に備える」・サービス別と章のページへの差し込み ── */
  function nextDue() {
    const list = nenkanFor(null).filter((x) => x.kind === "date" && x.dueYmd && dms(x.dueYmd) >= todayMs()).sort((a, b) => dms(a.dueYmd) - dms(b.dueYmd));
    return list[0];
  }
  ON_ROUTE.push((view) => {
    if (view !== "home") return;
    const el = $("tk-home");
    if (!el) return;
    const os = offices();
    const nItems = TK.index.reduce((n, s) => n + s.n, 0);
    const nd = nextDue();
    let h = "";
    if (os.length) h += '<div class="ofc-grid">' + os.slice(0, 6).map(officeCard).join("") + "</div>";
    h += '<div class="prep">'
      + `<a class="prep-a" href="#tenken"><b>点検</b><span>国の確認項目 ${nItems.toLocaleString()}・${TK.index.length}サービス</span></a>`
      + (HAS_GS ? `<a class="prep-a" href="#gensan"><b>減算になる場面</b><span>${TK.gensan.length}種類</span></a>` : "")
      + (HAS_NK ? `<a class="prep-a" href="#nenkan"><b>年間でやること</b><span>${nd ? `次の期限 ${jdate(nd.dueYmd)} ${esc(nd.t)}` : "委員会・研修・訓練・届出"}</span></a>` : "")
      + "</div>";
    el.innerHTML = h;
  });
  SVC_EXTRA.push((id) => {
    if (!GT[id]) return "";
    const ss = svcsOfGroup(id);
    return `<section class="also kk-also"><h2>国の確認項目で点検する</h2><ul class="rows">${ss.map((s) => `<li><a href="#kk-${s.id}">${esc(s.t)}</a><span class="note">確認項目 ${s.n}${s.nk ? `・県の資料から ${s.nk}` : ""}</span></li>`).join("")}</ul></section>`;
  });
  CH_EXTRA.push((docId, h) => {
    const lst = (TK.k2n[docId] || {})[String(h)];
    if (!lst || !lst.length) return "";
    const mine = new Set(offices().flatMap((o) => o.svcs));
    const sorted = lst.slice().sort((a, b) => (mine.has(b[0]) ? 1 : 0) - (mine.has(a[0]) ? 1 : 0));
    const show = sorted.slice(0, 8);
    // 登録した事業所のサービスなら、その事業所の点検表へ（事業所が1つのとき）。ほかは確認項目を見るページへ
    const href = (sid, rk) => { const os = offices().filter((o) => o.svcs.includes(sid)); return os.length === 1 ? `#tk-${os[0].id}-${sid}?r=${rk}` : `#kk-${sid}?r=${rk}`; };
    return `<div class="to-kk"><span class="k">国の確認項目</span>${show.map(([sid, rk]) => `<a class="chip-a${mine.has(sid) ? " is-mine" : ""}" href="${href(sid, rk)}">${esc(svcName(sid))}</a>`).join("")}${sorted.length > show.length ? `<span class="more-n">ほか${sorted.length - show.length}</span>` : ""}</div>`;
  });
