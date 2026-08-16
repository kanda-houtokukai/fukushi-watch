/* P7モック共通スクリプト: ヘッダ・レール・チップ・分野切替(0.2秒遷移) */
(function () {
  "use strict";
  const M = window.MOCK;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  window.mockEsc = esc;
  window.srcMark = (it) => {
    const cls = { 国: "kuni", 独法: "dokuho", 県: "ken" }[it.srcType] || "kuni";
    return `<span class="srcmark ${cls}">${esc(it.srcType)}</span>${esc(it.src)}`;
  };
  window.fieldTags = (it) =>
    it.fields.length ? `　<span class="fieldtags">［${it.fields.map(esc).join("・")}］</span>` : "";

  window.renderShell = function (variantLabel) {
    const c = { 高: 0, 中: 0, 低: 0 };
    M.items.forEach((i) => c[i.imp]++);
    document.getElementById("shell").innerHTML = `
  <div class="mocknote">デザイン比較用モック ${esc(variantLabel)} ─ データは実データに基づくサンプル（リンクは動きません）</div>
  <div class="wrap">
  <header><div class="brand"><h1>福祉情報ウォッチ</h1></div></header>
  <nav class="rail">
    <div class="dcell"><span class="bar"><i class="bl" style="height:8px"></i><i class="bm" style="height:6px"></i></span><span class="d">8/13</span></div>
    <div class="dcell"><span class="bar"><i class="bl" style="height:10px"></i><i class="bm" style="height:5px"></i><i class="bh" style="height:3px"></i></span><span class="d">8/14</span></div>
    <div class="dcell"><span class="bar"><i class="bl" style="height:4px"></i></span><span class="d">8/15</span></div>
    <div class="dcell sel"><span class="bar"><i class="bl" style="height:10px"></i><i class="bm" style="height:12px"></i><i class="bh" style="height:8px"></i></span><span class="d">8/16</span></div>
  </nav>
  <section class="day">
    <div class="day-row">
      <h2>${esc(M.day)}<small>${esc(M.weekday)}</small></h2>
      <div class="counts">新着${M.items.length}件 ─ <b>高${c["高"]}</b>・中${c["中"]}・低${c["低"]}</div>
    </div>
    <div class="ledger">直近7日間の記録 ${M.weekly.total}件（高${M.weekly.h}・中${M.weekly.m}・低${M.weekly.l}）</div>
  </section>
  <div class="chips" id="fieldChips">
    <button class="chip on" data-fd="all">全分野</button>
    <button class="chip" data-fd="保育">保育</button>
    <button class="chip" data-fd="障害">障害</button>
    <button class="chip" data-fd="高齢">高齢</button>
    <button class="chip" data-fd="児童">児童</button>
  </div>
  <main id="list"></main>
  <div class="footnote">要約と重要度はAIによる参考情報です。最終判断は必ず原本をご確認ください。<br>
  比較用: <a href="a.html">案A</a> ・ <a href="b.html">案B</a> ・ <a href="c.html">案C</a> ・ <a href="./">説明</a></div>
  </div>`;

    document.getElementById("fieldChips").addEventListener("click", (e) => {
      const b = e.target.closest(".chip");
      if (!b) return;
      document.querySelectorAll(".chip").forEach((x) => x.classList.toggle("on", x === b));
      const fd = b.dataset.fd;
      document.querySelectorAll(".it").forEach((el) => {
        const f = (el.dataset.fields || "").split(",").filter(Boolean);
        const show = fd === "all" || f.includes(fd) || f.includes("共通");
        el.classList.toggle("hide", !show);
      });
    });
  };
})();
