"use strict";
// Tes validasi gulir terkendali (scripts/probe/scroll-probe.js). Tanpa browser.
//
// Model virtualizer-nya meniru yang DIUKUR di LIVE 2026-10-20: 5 produk,
// scrollHeight 1209, clientHeight 604, ~151 px per baris, 4 baris ter-render
// pada scrollTop 0. Baris baru hanya muncul kalau scrollTop container yang
// BENAR yang berubah - itulah properti yang sedang diuji.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { scrollValidation, verifyScroller, fingerprintOf, bottomReached, DEFAULT_STEP } = require("../scripts/probe/scroll-probe");

const ROOT = path.resolve(__dirname, "..");
const ROW_H = 151;
const CLIENT_H = 604;
// Diturunkan dari pengukuran LIVE 2026-10-20: scrollHeight 1209 dengan 5 produk
// dan baris ~151 px, jadi 1209 - 5*151 = 454 px dipakai kotak pencarian, baris
// filter, dan strip ringkasan - semuanya memang berada DI DALAM container yang
// sama (lihat rantai leluhur di laporan probe pertama).
const HEADER_H = 454;
// Jumlah baris yang ter-render sekaligus, juga dari pengukuran: 4.
const WINDOW = 4;
const VIRT_CLASS = "index-module__virtualized-container--nn7XK";

// Virtualizer tiruan: jendela baris diturunkan dari scrollTop, dan scrollTop
// HANYA bisa berubah lewat scrollWave().
function rig({
  total = 5,
  // bereaksi terhadap gulir? false = meniru "container salah": scrollTop
  // berubah tapi virtualizer tidak pernah merender baris baru.
  virtualizerReacts = true,
  // container yang dipilih produksi memang container virtualisasi?
  pickedIsVirtualized = true,
  pickedScrollable = true,
  scrollEffective = true,
  scopeSeq = null,
  totalSeq = null,
  fingerprintSeq = null,
  initializedSeq = null,
  startScrollTop = 0,
} = {}) {
  const scrollHeight = HEADER_H + total * ROW_H;
  const maxScroll = Math.max(0, scrollHeight - CLIENT_H);
  const st = { scrollTop: startScrollTop, waves: 0, resets: 0, settles: 0 };
  const nth = (seq, def) => (Array.isArray(seq) ? (seq.length ? seq.shift() : def) : def);

  const terlihatSekarang = () => {
    const efektif = virtualizerReacts ? st.scrollTop : 0;
    const mulai = Math.max(0, Math.min(total - WINDOW, Math.floor(efektif / ROW_H)));
    const out = [];
    for (let i = mulai; i < Math.min(total, mulai + WINDOW); i += 1) out.push(i + 1);
    return out;
  };

  const ancestor = () => ({
    depth: 10,
    tag: "div",
    className: nth(fingerprintSeq, VIRT_CLASS),
    scrollTop: st.scrollTop,
    scrollHeight,
    clientHeight: CLIENT_H,
    overflowY: pickedScrollable ? "auto" : "visible",
    overflows: scrollHeight > CLIENT_H + 10,
    scrollable: pickedScrollable,
    atBottom: st.scrollTop + CLIENT_H >= scrollHeight - 2,
    isVirtualizedContainer: pickedIsVirtualized,
  });

  const deps = {
    readAncestors: async () => ({
      rowFound: true,
      ancestors: [ancestor()],
      wouldPickDepth: 0,
      realScrollerDepths: pickedScrollable ? [0] : [],
      heuristicPicksRealScroller: pickedScrollable,
    }),
    readRows: async () => {
      const n = terlihatSekarang();
      return { rowMarkers: n.length, numberInputs: n.length, pinButtons: n.length, numbers: n, uniqueNumbers: n.length, numbersUnreadable: 0, initialized: nth(initializedSeq, true), livePinControls: true, virtualizedContainer: { found: true, className: VIRT_CLASS } };
    },
    readStrip: async () => ({ present: true, state: "ok", thumbnails: Math.min(4, total), badgeValue: total > 4 ? total - 4 : null, badgePresent: total > 4, candidateTotal: nth(totalSeq, total) }),
    readScope: async () => nth(scopeSeq, "clean"),
    scrollWave: async () => {
      st.waves += 1;
      if (!scrollEffective) return { scrolled: false, reason: "no-scroll-container" };
      const before = st.scrollTop;
      st.scrollTop = Math.min(before + DEFAULT_STEP, maxScroll);
      return { scrolled: st.scrollTop !== before, scrollTop: st.scrollTop, scrollHeight };
    },
    resetScroll: async () => { st.resets += 1; st.scrollTop = 0; return { ok: true }; },
    settle: async () => { st.settles += 1; },
  };
  // depth yang dilaporkan harus cocok dengan indeks di array ancestors
  return { deps, st, scrollHeight };
}

// --- helper murni ---

test("bottomReached dihitung dari geometri, dengan toleransi 2px", () => {
  assert.equal(bottomReached({ scrollTop: 605, clientHeight: 604, scrollHeight: 1209 }), true);
  assert.equal(bottomReached({ scrollTop: 0, clientHeight: 604, scrollHeight: 1209 }), false);
  assert.equal(bottomReached({ scrollTop: 600, clientHeight: 604, scrollHeight: 1209 }), false);
  // 603 + 604 = 1207, dan 1209 - 2 = 1207 -> SUDAH di dasar. Toleransinya memang
  // membuat 603 masuk hitungan dasar.
  assert.equal(bottomReached({ scrollTop: 603, clientHeight: 604, scrollHeight: 1209 }), true);
});

test("verifyScroller: hanya container virtualisasi yang BISA digulir yang lolos", () => {
  const ok = { rowFound: true, wouldPickDepth: 0, ancestors: [{ depth: 0, tag: "div", className: VIRT_CLASS, isVirtualizedContainer: true, scrollable: true, scrollTop: 0, scrollHeight: 1209, clientHeight: 604 }] };
  assert.equal(verifyScroller(ok).ok, true);
  const bukanVirt = JSON.parse(JSON.stringify(ok)); bukanVirt.ancestors[0].isVirtualizedContainer = false;
  assert.equal(verifyScroller(bukanVirt).reason, "picked-not-virtualized");
  const takBisaGulir = JSON.parse(JSON.stringify(ok)); takBisaGulir.ancestors[0].scrollable = false;
  assert.equal(verifyScroller(takBisaGulir).reason, "picked-not-scrollable");
  assert.equal(verifyScroller({ rowFound: false }).reason, "no-rows");
  assert.equal(verifyScroller({ rowFound: true, wouldPickDepth: null, ancestors: [] }).reason, "no-scroll-container");
});

// --- jalur utama: 5 produk, baris ke-5 muncul sesudah digulir ---

test("5 produk: gulir memunculkan produk #5 dan berhenti dini saat total terpenuhi", async () => {
  const { deps, st } = rig({ total: 5 });
  const r = await scrollValidation(deps);
  assert.equal(r.ok, true);
  assert.equal(r.baseline.candidateTotal, 5);
  assert.deepEqual(r.baseline.numbers, [1, 2, 3, 4]);
  assert.deepEqual(r.uniquePositions, [1, 2, 3, 4, 5]);
  assert.equal(r.totalSatisfied, true);
  assert.equal(r.stopReason, "total-satisfied");
  assert.ok(r.waves.length <= 3, "tidak boleh lebih dari 3 gelombang");
  assert.equal(st.waves, r.waves.length);
  assert.equal(r.scrollerStable, true);
  assert.equal(r.candidateTotalStable, true);
  assert.equal(r.scopeStable, true);
  assert.equal(r.restored.ok, true);
  assert.equal(r.restored.scrollTop, 0);
});

test("5 produk: setiap gelombang mencatat scrollTop sebelum/sesudah dan akumulasi unik", async () => {
  const { deps } = rig({ total: 5 });
  const r = await scrollValidation(deps);
  const w = r.waves[0];
  assert.equal(w.wave, 1);
  assert.equal(w.beforeScrollTop, 0);
  assert.equal(w.after.scrollTop, DEFAULT_STEP);
  assert.equal(w.scrolled, true);
  assert.ok(w.uniqueAfter.length >= 5 || w.uniqueAfter.length > r.baseline.numbers.length);
});

test("container SALAH: scrollTop berubah tapi virtualizer tidak pernah merender baris baru", async () => {
  const { deps } = rig({ total: 5, virtualizerReacts: false });
  const r = await scrollValidation(deps);
  assert.equal(r.totalSatisfied, false, "produk #5 tidak boleh pernah terlihat");
  assert.deepEqual(r.uniquePositions, [1, 2, 3, 4]);
  // Ia berhenti karena dasar tercapai atau kuota gelombang habis - BUKAN karena
  // mengira katalognya lengkap.
  assert.ok(["bottom-reached", "max-waves"].includes(r.stopReason), r.stopReason);
  assert.equal(r.restored.ok, true);
});

test("gulir TIDAK BEREFEK: berhenti dengan scroll-ineffective, bukan mengaku lengkap", async () => {
  const { deps } = rig({ total: 5, scrollEffective: false });
  const r = await scrollValidation(deps);
  assert.equal(r.totalSatisfied, false);
  assert.equal(r.stopReason, "scroll-ineffective");
  assert.deepEqual(r.uniquePositions, [1, 2, 3, 4]);
});

test("kuota 3 gelombang dihormati pada katalog besar", async () => {
  const { deps, st } = rig({ total: 40 });
  const r = await scrollValidation(deps);
  assert.equal(r.waves.length, 3);
  assert.equal(st.waves, 3);
  assert.equal(r.stopReason, "max-waves");
  assert.equal(r.totalSatisfied, false);
  assert.equal(r.ok, false, "tidak lengkap dan tidak di dasar => bukan sukses");
  assert.equal(r.restored.ok, true);
});

// --- gerbang baseline: ragu berarti TIDAK menggulir ---

for (const [nama, opsi, alasan] of [
  ["scope tidak clean", { scopeSeq: ["dirty"] }, "scope-not-clean:dirty"],
  ["scope unknown", { scopeSeq: ["unknown"] }, "scope-not-clean:unknown"],
  ["container terpilih bukan virtualisasi", { pickedIsVirtualized: false }, "scroller-unverified:picked-not-virtualized"],
  ["container terpilih tidak bisa digulir", { pickedScrollable: false }, "scroller-unverified:picked-not-scrollable"],
  ["baris belum ter-inisialisasi", { initializedSeq: [false] }, "rows-not-initialized"],
  ["scrollTop awal bukan 0", { startScrollTop: 400 }, "baseline-scrolltop-not-zero"],
]) {
  test("gerbang baseline: " + nama + " => BERHENTI tanpa menggulir", async () => {
    const { deps, st } = rig(opsi);
    const r = await scrollValidation(deps);
    assert.equal(r.ok, false);
    assert.equal(r.stopReason, alasan);
    assert.equal(st.waves, 0, "tidak boleh ada gulir sama sekali");
    assert.equal(r.waves.length, 0);
  });
}

test("gerbang baseline: candidateTotal tidak terpakai => BERHENTI tanpa menggulir", async () => {
  const { deps, st } = rig({ totalSeq: [null] });
  const r = await scrollValidation(deps);
  assert.equal(r.stopReason, "candidate-total-unusable");
  assert.equal(st.waves, 0);
});

test("baseline sudah lengkap (2 produk) => tidak menggulir sama sekali", async () => {
  const { deps, st } = rig({ total: 2 });
  const r = await scrollValidation(deps);
  assert.equal(r.ok, true);
  assert.equal(r.totalSatisfied, true);
  assert.equal(r.stopReason, "total-satisfied-at-baseline");
  assert.deepEqual(r.uniquePositions, [1, 2]);
  assert.equal(st.waves, 0, "katalog yang sudah lengkap tidak perlu digulir");
});

// --- kondisi C: berubah di tengah jalan ---

test("scope berubah di tengah gelombang => BERHENTI dan dicatat tidak stabil", async () => {
  const { deps } = rig({ total: 40, scopeSeq: ["clean", "dirty"] });
  const r = await scrollValidation(deps);
  assert.equal(r.scopeStable, false);
  assert.match(r.stopReason, /^scope-changed:dirty$/);
  assert.equal(r.ok, false);
  assert.equal(r.restored.ok, true, "pemulihan tetap dijalankan");
});

test("candidateTotal berubah di tengah gelombang => BERHENTI", async () => {
  const { deps } = rig({ total: 40, totalSeq: [40, 12] });
  const r = await scrollValidation(deps);
  assert.equal(r.candidateTotalStable, false);
  assert.equal(r.stopReason, "candidate-total-changed");
  assert.equal(r.ok, false);
});

test("sidik jari scroller berubah di tengah gelombang => BERHENTI", async () => {
  const { deps } = rig({ total: 40, fingerprintSeq: [VIRT_CLASS, VIRT_CLASS, "kelas-lain-sama-sekali"] });
  const r = await scrollValidation(deps);
  assert.equal(r.scrollerStable, false);
  assert.equal(r.stopReason, "scroller-changed");
  assert.equal(r.ok, false);
});

test("pemulihan DICOBA walau validasi berhenti karena tidak konsisten", async () => {
  const { deps, st } = rig({ total: 40, scopeSeq: ["clean", "dirty"] });
  const r = await scrollValidation(deps);
  assert.equal(st.resets, 1);
  assert.equal(st.scrollTop, 0);
  assert.equal(r.restored.ok, true);
});

test("pemulihan yang GAGAL dilaporkan gagal, bukan disembunyikan", async () => {
  const { deps } = rig({ total: 5 });
  deps.resetScroll = async () => { throw new Error("reset ditolak"); };
  const r = await scrollValidation(deps);
  assert.equal(r.restored.ok, false);
  assert.match(r.restored.error, /reset ditolak/);
});

// --- larangan yang masih berlaku ---

test("alat gulir TIDAK memuat logika gulir sendiri: ia memakai fungsi PRODUKSI", () => {
  const runSrc = fs.readFileSync(path.join(ROOT, "scripts", "probe", "run-scroll-probe.js"), "utf8");
  const probeSrc = fs.readFileSync(path.join(ROOT, "scripts", "probe", "scroll-probe.js"), "utf8");
  const kodeSaja = (s) => s.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  // Penggulirnya diimpor dari produksi, tidak ditulis ulang.
  assert.match(runSrc, /scrollProductListInPage, resetScrollInPage \} = require\("\.\.\/\.\.\/autopin\/products"\)/);
  for (const src of [kodeSaja(runSrc), kodeSaja(probeSrc)]) {
    assert.ok(!/\.scrollTop\s*=/.test(src), "tidak boleh menulis scrollTop sendiri");
    assert.ok(!/scrollBy\s*\(|scrollTo\s*\(|scrollIntoView\s*\(|wheel|mousewheel/i.test(src), "tidak boleh simulasi roda / scrollTo");
    assert.ok(!/\.click\s*\(/.test(src), "tidak boleh mengklik");
    assert.ok(!/\.type\s*\(|keyboard\./.test(src), "tidak boleh mengetik");
    assert.ok(!/setAttribute|innerHTML|appendChild|\.remove\s*\(/.test(src), "tidak boleh memutasi DOM");
    assert.ok(!/document\.cookie|localStorage|sessionStorage/.test(src), "tidak boleh membaca penyimpanan");
    assert.ok(!/window\.scroll|document\.body\.scroll|documentElement\.scroll/.test(src), "tidak boleh menggulir halaman/body");
  }
});

test("alat gulir memakai gerbang keselamatan dan pembaca yang SAMA", () => {
  const src = fs.readFileSync(path.join(ROOT, "scripts", "probe", "run-scroll-probe.js"), "utf8");
  assert.match(src, /require\("\.\/probe-guards"\)/, "gerbang yang sama");
  assert.match(src, /require\("\.\/dom-probe-page"\)/, "pembaca bukti yang sama");
  assert.match(src, /require\("\.\/run-dom-probe"\)/, "fakta profil/lock/versi yang sama");
  assert.match(src, /evaluateSafety\(facts\)/);
});

test("alat gulir: bawaannya TIDAK execute, dan kuota gelombang dibatasi 3", () => {
  const runner = require("../scripts/probe/run-scroll-probe");
  const d = runner.parseArgs([]);
  assert.equal(d.execute, false);
  assert.equal(d.maxWaves, 3);
  assert.equal(runner.parseArgs(["--max-waves", "9"]).maxWaves, 3, "tidak boleh melebihi 3");
  assert.equal(runner.parseArgs(["--max-waves", "1"]).maxWaves, 1);
  assert.ok(d.waveSettleMs >= 350, "tunggu per gelombang harus >= settle produksi");
});

test("alat gulir mewarisi profil, lock, dan identitas dari probe read-only", () => {
  const runner = require("../scripts/probe/run-scroll-probe");
  const o = runner.parseArgs(["--profile-dir", "C:/p/browser-profile", "--expected-shop", "agen_mulia_abadi"]);
  assert.equal(path.basename(o.profileDir), "browser-profile");
  assert.equal(path.dirname(o.lockFile), path.resolve("C:/p"));
  assert.equal(o.expectedShop, "agen_mulia_abadi");
  assert.equal(o.navTimeoutMs, 45000);
  assert.equal(o.readyTimeoutMs, 30000);
});

test("alat gulir bisa di-require tanpa memuat Puppeteer", () => {
  const sebelum = Object.keys(require.cache).some((k) => k.includes("puppeteer"));
  require("../scripts/probe/run-scroll-probe");
  const sesudah = Object.keys(require.cache).some((k) => k.includes("puppeteer"));
  assert.equal(sesudah, sebelum);
});

test("alat gulir tidak terjangkau dari entry point produksi", () => {
  for (const d of ["autopin", "controller", "qa", "autocomment", "tiktok", "runtime", "desktop"]) {
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith(".js")) {
          assert.ok(!/scripts[\/\\]probe/.test(fs.readFileSync(p, "utf8")), p);
        }
      }
    };
    walk(path.join(ROOT, d));
  }
});
