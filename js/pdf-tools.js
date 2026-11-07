/*
 * DocuCraft PDF Studio — PDFツール拡張
 * 作成・結合 / ページ編集 / 墨消し / 直接編集（文字・画像）
 *
 * 依存: js/app.js（appState, setStatus, handlePdfFileUpload, renderAllPages, applyZoom, selectElement,
 *       pagesContainer, thumbnailList, workspaceViewport, modeStatusText）
 *       pdf-lib（PDFLib）, PDF.js（pdfjsLib）, html2canvas
 * すべてブラウザ内で処理し、PDFを外部へ送信しません。
 */
(function (root) {
  'use strict';

  const FLATTEN_DPI = 200;       // 墨消し・画像化保存時のラスタライズ解像度
  const CROP_DPI = 216;          // 画像の移動・拡大縮小時の切り出し解像度
  const MAX_MARKS = 2000;        // 墨消し指定の上限（メモリ・描画負荷の保護）
  const MAX_IMAGE_FILE_BYTES = 20 * 1024 * 1024;
  const MAX_IMAGE_EDGE = 4096;
  const A4 = [595.28, 841.89];
  const LETTER = [612, 792];

  const limits = () => ({
    bytes: typeof MAX_PDF_BYTES !== 'undefined' ? MAX_PDF_BYTES : 100 * 1024 * 1024,
    pages: typeof MAX_PDF_PAGES !== 'undefined' ? MAX_PDF_PAGES : 200,
    pagePixels: typeof MAX_PAGE_PIXELS !== 'undefined' ? MAX_PAGE_PIXELS : 24000000
  });

  const state = {
    busy: false,
    internalLoad: false,
    dirty: false,
    loadSeq: 0,
    renderToken: 0,
    selectedPages: new Set(),
    lastClicked: null,
    marks: new Map(),          // pageIndex -> [{x,y,w,h}]（ページ座標px）
    redactMode: false,
    deleted: new Map(),        // pageIndex -> Set(origIndex)（削除した元テキスト）
    imgEdits: new Map(),       // "page:idx" -> 画像編集
    selectedImage: null,       // {page, idx}
    mergeItems: [],
    mergeSeq: 0,
    sampler: null,
    samplerPage: -1,
    io: null,
    observer: null,
    refreshQueued: false
  };
  const itemBase = new WeakMap(); // 直接編集の要素 -> 編集前の状態
  const $ = (id) => document.getElementById(id);

  // ===========================================================================
  // 0. 共通ユーティリティ
  // ===========================================================================
  function status(text, loading) {
    if (typeof setStatus === 'function') setStatus(text, !!loading);
  }
  const hasPdfLib = () => typeof PDFLib !== 'undefined' && !!PDFLib.PDFDocument;
  const currentBytes = () => (appState.pdfBytes ? new Uint8Array(appState.pdfBytes) : null);
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  function friendlyError(e) {
    const msg = e && e.message ? String(e.message) : String(e);
    if (/encrypt/i.test(msg)) return 'パスワード保護（暗号化）されたPDFは処理できません。';
    return msg;
  }

  function baseName(name) {
    return String(name || 'document').replace(/\.pdf$/i, '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 80) || 'document';
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function toHex(r, g, b) {
    const h = (n) => clamp(Math.round(n), 0, 255).toString(16).padStart(2, '0');
    return `#${h(r)}${h(g)}${h(b)}`;
  }
  function hexToRgb01(hex) {
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex || ''));
    if (!m) return [1, 1, 1];
    return [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255];
  }

  // "1-3,5" → [0,1,2,4]（0始まり）。不正入力は例外
  function parsePageRange(text, max) {
    const s = String(text).normalize('NFKC').replace(/\s+/g, '');
    if (!s) throw new Error('ページ範囲が空です。');
    const out = new Set();
    for (const part of s.split(',')) {
      const m = /^(\d+)(?:[-~](\d+))?$/.exec(part);
      if (!m) throw new Error(`ページ範囲「${part}」を解釈できません。`);
      const a = parseInt(m[1], 10);
      const b = m[2] ? parseInt(m[2], 10) : a;
      if (a < 1 || b < a || b > max) throw new Error(`ページ範囲「${part}」が範囲外です（1〜${max}）。`);
      for (let i = a; i <= b; i++) out.add(i - 1);
    }
    return Array.from(out).sort((x, y) => x - y);
  }

  // 行列: [a,b,c,d,e,f]。applyMatrix(m,x,y) = (a*x+c*y+e, b*x+d*y+f)
  const applyMatrix = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  const compose = (a, b) => [
    a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]
  ];
  function invertMatrix(m) {
    const det = m[0] * m[3] - m[1] * m[2];
    if (!Number.isFinite(det) || Math.abs(det) < 1e-9) throw new Error('座標変換行列が不正です。');
    return [
      m[3] / det, -m[1] / det, -m[2] / det, m[0] / det,
      (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det
    ];
  }
  // ページ座標px（表示用viewport）の矩形 → PDFユーザー空間の矩形
  function pxRectToPdfRect(vt, r) {
    const inv = invertMatrix(vt);
    const pts = [[r.x, r.y], [r.x + r.w, r.y], [r.x, r.y + r.h], [r.x + r.w, r.y + r.h]]
      .map((p) => applyMatrix(inv, p[0], p[1]));
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
  }

  // 墨消し用の固定パターン（ユーザー入力の正規表現は受け付けない＝ReDoS対策）
  const PRESETS = {
    email: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    phone: /0\d{1,4}[-‐‑–−ー]?\d{1,4}[-‐‑–−ー]?\d{3,4}/g,
    digits12: /\d{4}\s?\d{4}\s?\d{4}/g
  };

  // テキスト項目（PDF.jsの1ラン）内の一致位置を文字数比で矩形化（等幅でない場合は近似）
  function findMatchBoxes(rawItems, query, presetKey) {
    const boxes = [];
    for (const it of rawItems || []) {
      if (!it || !it.text) continue;
      const text = String(it.text).normalize('NFKC');
      const len = text.length;
      if (!len) continue;
      const spans = [];
      if (presetKey && PRESETS[presetKey]) {
        const re = new RegExp(PRESETS[presetKey].source, 'g');
        let m;
        while ((m = re.exec(text)) && spans.length < 200) {
          if (m[0].length === 0) { re.lastIndex++; continue; }
          spans.push([m.index, m.index + m[0].length]);
        }
      }
      if (query) {
        const q = String(query).normalize('NFKC').toLowerCase();
        const hay = text.toLowerCase();
        let from = 0;
        while (q && spans.length < 200) {
          const i = hay.indexOf(q, from);
          if (i < 0) break;
          spans.push([i, i + q.length]);
          from = i + Math.max(1, q.length);
        }
      }
      for (const [s, e] of spans) {
        boxes.push({ x: it.x + it.w * (s / len) - 1, y: it.y - 1, w: it.w * ((e - s) / len) + 2, h: it.h + 2 });
      }
    }
    return boxes;
  }

  function countPageObjects(doc) {
    const { PDFDict, PDFName } = PDFLib;
    let n = 0;
    for (const [, obj] of doc.context.enumerateIndirectObjects()) {
      if (obj instanceof PDFDict && obj.get(PDFName.of('Type')) === PDFName.of('Page')) n++;
    }
    return n;
  }

  async function loadPdf(bytes, opts) {
    try {
      return await PDFLib.PDFDocument.load(bytes, opts || {});
    } catch (e) {
      throw new Error(friendlyError(e));
    }
  }

  // plan: [{type:'page', index, rotateDelta?} | {type:'blank', width, height} | {type:'image', width, height, bytes(PNG)}]
  async function assemblePlan(srcDoc, plan, opts = {}) {
    const { PDFDocument, degrees } = PDFLib;
    const out = await PDFDocument.create();
    const firstIdx = [];
    const seen = new Set();
    for (const p of plan) {
      if (p.type === 'page' && !seen.has(p.index)) { seen.add(p.index); firstIdx.push(p.index); }
    }
    const firstCopies = firstIdx.length ? await out.copyPages(srcDoc, firstIdx) : [];
    const firstMap = new Map(firstIdx.map((i, k) => [i, firstCopies[k]]));
    const used = new Set();
    for (const p of plan) {
      if (p.type === 'blank') {
        out.addPage([p.width, p.height]);
      } else if (p.type === 'image') {
        const img = await out.embedPng(p.bytes);
        const page = out.addPage([p.width, p.height]);
        page.drawImage(img, { x: 0, y: 0, width: p.width, height: p.height });
      } else {
        let page;
        if (!used.has(p.index)) { page = firstMap.get(p.index); used.add(p.index); }
        else { [page] = await out.copyPages(srcDoc, [p.index]); }
        if (p.rotateDelta) {
          const cur = page.getRotation().angle || 0;
          page.setRotation(degrees((((cur + p.rotateDelta) % 360) + 360) % 360));
        }
        out.addPage(page);
      }
    }
    if (!opts.stripMetadata) {
      try {
        const t = srcDoc.getTitle(); if (t) out.setTitle(t);
        const a = srcDoc.getAuthor(); if (a) out.setAuthor(a);
        const s = srcDoc.getSubject(); if (s) out.setSubject(s);
      } catch (e) { /* メタデータ取得失敗は無視 */ }
    }
    out.setProducer('DocuCraft PDF Studio');
    out.setCreator('DocuCraft PDF Studio');
    return out;
  }

  // pdf-libはリンク注釈の宛先ページ（削除・墨消し対象）まで一緒にコピーしてしまうため、
  // 出力後にページオブジェクト数を検証し、不一致なら注釈を除去して再生成する。
  async function assembleFromBytes(bytes, buildPlan, opts = {}) {
    const { PDFName } = PDFLib;
    let src = await loadPdf(bytes);
    const plan = buildPlan(src);
    let out = await assemblePlan(src, plan, opts);
    let stripped = false;
    // 元ページが一部でも除外される（削除・抽出・画像化置換）場合のみ厳格に検査する。
    // 全ページを残す場合の余剰ページオブジェクトは「残すページの重複」であり内容は流出しない。
    const kept = new Set(plan.filter((p) => p.type === 'page').map((p) => p.index));
    const dropsPages = kept.size < src.getPageCount();
    if (dropsPages && countPageObjects(out) !== out.getPageCount()) {
      src = await loadPdf(bytes);
      src.getPages().forEach((p) => p.node.delete(PDFName.of('Annots')));
      out = await assemblePlan(src, plan, opts);
      stripped = true;
      if (countPageObjects(out) !== out.getPageCount()) {
        throw new Error('削除対象ページの内容が出力に残る可能性があるため、処理を中止しました。');
      }
    }
    return { out, stripped, src };
  }

  async function withBusy(label, fn) {
    if (state.busy) { status('別の処理を実行中です。完了までお待ちください。'); return false; }
    state.busy = true;
    updateToolStates();
    status(`${label}を実行中...`, true);
    try {
      await fn();
      return true;
    } catch (e) {
      console.error(`${label}エラー:`, e);
      status(`${label}に失敗しました: ${friendlyError(e)}`);
      return false;
    } finally {
      state.busy = false;
      updateToolStates();
    }
  }

  async function openBytes(bytes, name) {
    const before = state.loadSeq;
    state.internalLoad = true;
    try {
      await handlePdfFileUpload(new File([bytes], name, { type: 'application/pdf' }));
    } finally {
      state.internalLoad = false;
    }
    return state.loadSeq !== before; // 失敗時はapp.js側が理由をステータスに表示済み
  }

  // ===========================================================================
  // 1. app.js から呼ばれるフック
  // ===========================================================================
  function hasUnsaved() { return state.dirty || marksCount() > 0; }

  function beforeDocumentReplace() {
    if (state.internalLoad || !hasUnsaved()) return true;
    return window.confirm('未保存の編集内容（オーバーレイ編集・墨消し指定・画像編集など）は破棄されます。続行しますか？');
  }

  function beforeModeSwitch() {
    if (state.dirty && !window.confirm('表示モードを切り替えると、ページ上の未保存の編集内容は破棄されます。続行しますか？')) return false;
    resetOverlayEdits();
    return true;
  }

  // ページ構成を変える処理（再読込を伴う）の前に、オーバーレイ上の未保存編集の破棄を確認する
  function confirmDiscardOverlay() {
    return !state.dirty || window.confirm('ページ上の未保存の編集内容は破棄されます。続行しますか？');
  }

  function resetOverlayEdits() {
    state.imgEdits.forEach((ed) => { if (ed.previewUrl) URL.revokeObjectURL(ed.previewUrl); });
    state.imgEdits.clear();
    state.deleted.clear();
    state.selectedImage = null;
    state.dirty = false;
  }

  function onDocumentLoaded() {
    state.loadSeq++;
    state.marks.clear();
    state.selectedPages.clear();
    state.lastClicked = null;
    releaseSampler();
    resetOverlayEdits();
  }

  function afterRender() {
    state.renderToken++;
    if (state.observer) state.observer.takeRecords(); // 描画自体のDOM変更を「編集」とみなさない
    decorateThumbs();
    ensureLayers();
    rebuildRedactLayers();
    setupImageObserver();
    updateToolStates();
    if (state.observer) state.observer.takeRecords();
  }

  function onThumbClick(idx, ev) {
    const multi = ev && (ev.ctrlKey || ev.metaKey);
    if (ev && ev.shiftKey && state.lastClicked !== null) {
      const [a, b] = [Math.min(state.lastClicked, idx), Math.max(state.lastClicked, idx)];
      for (let i = a; i <= b; i++) state.selectedPages.add(i);
    } else if (multi) {
      if (state.selectedPages.has(idx)) state.selectedPages.delete(idx); else state.selectedPages.add(idx);
    } else {
      state.selectedPages = new Set([idx]);
    }
    state.lastClicked = idx;
    decorateThumbs();
    updateToolStates();
    status(`${state.selectedPages.size} ページを選択中（Ctrl/Shiftで複数選択）`);
  }

  function decorateThumbs() {
    Array.from(thumbnailList.children).forEach((el) => {
      const idx = Number(el.dataset.pageIndex);
      el.classList.toggle('thumb-selected', state.selectedPages.has(idx));
      el.setAttribute('aria-selected', state.selectedPages.has(idx) ? 'true' : 'false');
    });
  }

  const targetPages = () => {
    const sel = Array.from(state.selectedPages).sort((a, b) => a - b);
    return sel.length ? sel : [appState.activePageIndex || 0];
  };

  // ===========================================================================
  // 2. ページ編集（回転・削除・複製・移動・空白挿入・抽出）
  // ===========================================================================
  function needBytes() {
    if (!hasPdfLib()) { status('PDF編集ライブラリ(pdf-lib)を読み込めません。ネットワーク接続を確認してください。'); return null; }
    const bytes = currentBytes();
    if (!bytes) { status('サンプル表示中は使えません。「PDFを開く」または「新規作成・結合」でPDFを用意してください。'); return null; }
    return bytes;
  }

  function lossNote(src) {
    const { PDFName } = PDFLib;
    const lost = [];
    if (src.catalog.has(PDFName.of('Outlines'))) lost.push('しおり');
    if (src.catalog.has(PDFName.of('AcroForm'))) lost.push('フォーム項目');
    return lost.length ? `（${lost.join('・')}は引き継がれません）` : '';
  }

  async function runPageOp(label, build) {
    const bytes = needBytes();
    if (!bytes || state.busy || !confirmDiscardOverlay()) return;
    const ok = await withBusy(label, async () => {
      let note = '';
      let select = [];
      const { out, stripped, src } = await assembleFromBytes(bytes, (s) => {
        const r = build(s.getPageCount(), s);
        select = r.select || [];
        return r.plan;
      });
      if (out.getPageCount() < 1) throw new Error('結果が0ページになるため中止しました。');
      note = lossNote(src) + (stripped ? '（削除対象ページを参照するリンク・注釈は除去しました）' : '');
      const outBytes = await out.save();
      if (!(await openBytes(outBytes, appState.pdfName || 'document.pdf'))) return;
      state.selectedPages = new Set(select.filter((i) => i >= 0 && i < appState.pagesData.length));
      decorateThumbs();
      updateToolStates();
      status(`${label}が完了しました。${note}`);
    });
    return ok;
  }

  async function rotateSelected(delta) {
    const bytes = needBytes();
    if (!bytes || state.busy || !confirmDiscardOverlay()) return;
    const targets = targetPages();
    await withBusy('ページの回転', async () => {
      const doc = await loadPdf(bytes, { updateMetadata: false });
      const { degrees } = PDFLib;
      targets.forEach((i) => {
        const p = doc.getPage(i);
        p.setRotation(degrees((((p.getRotation().angle + delta) % 360) + 360) % 360));
      });
      const outBytes = await doc.save(); // 回転のみ：元の構造（しおり・フォーム等）をそのまま保持
      if (!(await openBytes(outBytes, appState.pdfName || 'document.pdf'))) return;
      state.selectedPages = new Set(targets);
      decorateThumbs();
      updateToolStates();
      status(`${targets.length} ページを${delta > 0 ? '右' : '左'}に回転しました。`);
    });
  }

  function deleteSelected() {
    if (!needBytes() || state.busy) return;
    const targets = targetPages();
    if (targets.length >= appState.pagesData.length) { status('すべてのページは削除できません。'); return; }
    if (!window.confirm(`ページ ${targets.map((i) => i + 1).join(', ')} を削除しますか？（元のファイルは変更されません。保存して初めて反映されます）`)) return;
    runPageOp('ページの削除', (n) => {
      const set = new Set(targets);
      return { plan: Array.from({ length: n }, (_, i) => i).filter((i) => !set.has(i)).map((i) => ({ type: 'page', index: i })), select: [] };
    });
  }

  function duplicateSelected() {
    if (!needBytes() || state.busy) return;
    const targets = new Set(targetPages());
    runPageOp('ページの複製', (n) => {
      const plan = []; const select = [];
      for (let i = 0; i < n; i++) {
        plan.push({ type: 'page', index: i });
        if (targets.has(i)) { plan.push({ type: 'page', index: i }); select.push(plan.length - 1); }
      }
      return { plan, select };
    });
  }

  function moveSelected(dir) {
    if (!needBytes() || state.busy) return;
    const sel = new Set(targetPages());
    runPageOp(dir < 0 ? 'ページを前へ移動' : 'ページを後ろへ移動', (n) => {
      const order = Array.from({ length: n }, (_, i) => i);
      if (dir < 0) {
        for (let i = 1; i < n; i++) if (sel.has(order[i]) && !sel.has(order[i - 1])) [order[i - 1], order[i]] = [order[i], order[i - 1]];
      } else {
        for (let i = n - 2; i >= 0; i--) if (sel.has(order[i]) && !sel.has(order[i + 1])) [order[i + 1], order[i]] = [order[i], order[i + 1]];
      }
      const select = order.map((orig, pos) => (sel.has(orig) ? pos : -1)).filter((p) => p >= 0);
      return { plan: order.map((i) => ({ type: 'page', index: i })), select };
    });
  }

  function insertBlank() {
    if (!needBytes() || state.busy) return;
    const targets = targetPages();
    const after = targets[targets.length - 1];
    const pd = appState.pagesData[after];
    const base = (pd && pd.scale) || 1.35;
    const w = pd ? Math.round((pd.width / base) * 100) / 100 : A4[0];
    const h = pd ? Math.round((pd.height / base) * 100) / 100 : A4[1];
    runPageOp('空白ページの挿入', (n) => {
      const plan = [];
      for (let i = 0; i < n; i++) {
        plan.push({ type: 'page', index: i });
        if (i === after) plan.push({ type: 'blank', width: w, height: h });
      }
      return { plan, select: [after + 1] };
    });
  }

  async function extractSelected() {
    const bytes = needBytes();
    if (!bytes || state.busy) return;
    let indexes;
    try {
      if (state.selectedPages.size) {
        indexes = Array.from(state.selectedPages).sort((a, b) => a - b);
      } else {
        const text = window.prompt(`抽出するページ範囲を入力してください（例: 1-3,5）。全 ${appState.pagesData.length} ページ`, '1');
        if (text === null) return;
        indexes = parsePageRange(text, appState.pagesData.length);
      }
    } catch (e) { status(friendlyError(e)); return; }
    await withBusy('ページの抽出', async () => {
      const { out, stripped } = await assembleFromBytes(bytes, () => indexes.map((i) => ({ type: 'page', index: i })));
      const outBytes = await out.save();
      downloadBlob(new Blob([outBytes], { type: 'application/pdf' }), `${baseName(appState.pdfName)}_extract.pdf`);
      status(`${indexes.length} ページを抽出して保存しました。${stripped ? '（リンク・注釈の一部は除去しました）' : ''}`);
    });
  }

  // ===========================================================================
  // 3. 作成・結合（新規作成 / PDF・画像の結合）
  // ===========================================================================
  const isPng = (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
  const isJpg = (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;

  function openMergeModal() {
    const modal = $('mergeModal');
    if (!modal) return;
    renderMergeList();
    modal.classList.remove('hidden'); modal.classList.add('flex');
    const first = $('btnCloseMerge'); if (first) first.focus();
  }
  function closeMergeModal() {
    const modal = $('mergeModal');
    if (!modal) return;
    modal.classList.add('hidden'); modal.classList.remove('flex');
  }

  function formatSize(n) { return n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`; }

  function mergeTotalBytes() { return state.mergeItems.reduce((s, it) => s + it.file.size, 0) + (($('chkIncludeCurrent') && $('chkIncludeCurrent').checked && appState.pdfBytes) ? appState.pdfBytes.byteLength : 0); }

  function addMergeFiles(fileList) {
    const lim = limits();
    const msgs = [];
    for (const file of Array.from(fileList || [])) {
      const kind = /\.pdf$/i.test(file.name) || file.type === 'application/pdf' ? 'pdf'
        : (/\.(png|jpe?g)$/i.test(file.name) || /^image\/(png|jpeg)$/.test(file.type)) ? 'image' : null;
      if (!kind) { msgs.push(`「${file.name}」は未対応の形式です（PDF/PNG/JPEG）。`); continue; }
      if (file.size > lim.bytes) { msgs.push(`「${file.name}」はサイズ上限（${Math.round(lim.bytes / 1048576)} MB）を超えています。`); continue; }
      if (mergeTotalBytes() + file.size > lim.bytes) { msgs.push(`合計サイズが上限（${Math.round(lim.bytes / 1048576)} MB）を超えるため「${file.name}」は追加しませんでした。`); continue; }
      state.mergeItems.push({ id: ++state.mergeSeq, file, kind });
    }
    renderMergeList();
    if (msgs.length) setMergeMessage(msgs.join(' '));
  }

  function setMergeMessage(text) { const el = $('mergeMessage'); if (el) el.textContent = text || ''; }

  function renderMergeList() {
    const ul = $('mergeFileList'); if (!ul) return;
    ul.textContent = '';
    const include = $('chkIncludeCurrent');
    if (include) { include.disabled = !appState.pdfBytes; if (!appState.pdfBytes) include.checked = false; }
    if (!state.mergeItems.length) {
      const li = document.createElement('li');
      li.className = 'text-slate-400 py-2'; li.textContent = 'ファイルが追加されていません（PDF・PNG・JPEG）';
      ul.appendChild(li);
    }
    state.mergeItems.forEach((it, i) => {
      const li = document.createElement('li');
      li.className = 'flex items-center gap-2 py-1.5 border-b border-slate-100';
      const name = document.createElement('span'); name.className = 'flex-1 truncate'; name.textContent = `${i + 1}. ${it.file.name}`; name.title = it.file.name;
      const meta = document.createElement('span'); meta.className = 'text-slate-400 shrink-0'; meta.textContent = `${it.kind === 'pdf' ? 'PDF' : '画像'} / ${formatSize(it.file.size)}`;
      const mk = (label, aria, fn, disabled) => {
        const b = document.createElement('button'); b.type = 'button'; b.className = 'tool-btn'; b.textContent = label; b.setAttribute('aria-label', aria); b.disabled = !!disabled; b.addEventListener('click', fn); return b;
      };
      li.append(name, meta,
        mk('↑', `${it.file.name}を上へ`, () => { [state.mergeItems[i - 1], state.mergeItems[i]] = [state.mergeItems[i], state.mergeItems[i - 1]]; renderMergeList(); }, i === 0),
        mk('↓', `${it.file.name}を下へ`, () => { [state.mergeItems[i + 1], state.mergeItems[i]] = [state.mergeItems[i], state.mergeItems[i + 1]]; renderMergeList(); }, i === state.mergeItems.length - 1),
        mk('✕', `${it.file.name}を削除`, () => { state.mergeItems.splice(i, 1); renderMergeList(); }, false));
      ul.appendChild(li);
    });
  }

  async function runMerge() {
    if (!hasPdfLib()) { setMergeMessage('PDF編集ライブラリ(pdf-lib)を読み込めません。ネットワーク接続を確認してください。'); return; }
    const includeCurrent = $('chkIncludeCurrent') && $('chkIncludeCurrent').checked && appState.pdfBytes;
    const count = state.mergeItems.length + (includeCurrent ? 1 : 0);
    if (count < 2 && !(count === 1 && state.mergeItems.length === 1 && state.mergeItems[0].kind === 'image')) {
      setMergeMessage('結合するファイルを2つ以上追加してください（画像1枚のみの場合はPDF化できます）。'); return;
    }
    if (!beforeDocumentReplace()) return;
    setMergeMessage('');
    const lim = limits();
    const ok = await withBusy('PDFの結合', async () => {
      const { PDFDocument } = PDFLib;
      const out = await PDFDocument.create();
      let pages = 0;
      const sources = [];
      if (includeCurrent) sources.push({ name: appState.pdfName || '現在のPDF', kind: 'pdf', bytes: currentBytes() });
      for (const it of state.mergeItems) sources.push({ name: it.file.name, kind: it.kind, file: it.file });
      for (const s of sources) {
        const bytes = s.bytes || new Uint8Array(await s.file.arrayBuffer());
        if (s.kind === 'pdf') {
          if (!(bytes.length > 5 && String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3], bytes[4]) === '%PDF-')) throw new Error(`「${s.name}」はPDF形式として認識できません。`);
          let src;
          try { src = await loadPdf(bytes); } catch (e) { throw new Error(`「${s.name}」: ${friendlyError(e)}`); }
          const n = src.getPageCount();
          if (pages + n > lim.pages) throw new Error(`結合後のページ数が上限（${lim.pages}ページ）を超えます。`);
          const copied = await out.copyPages(src, src.getPageIndices());
          copied.forEach((p) => out.addPage(p));
          pages += n;
        } else {
          if (pages + 1 > lim.pages) throw new Error(`結合後のページ数が上限（${lim.pages}ページ）を超えます。`);
          let img;
          if (isPng(bytes)) img = await out.embedPng(bytes);
          else if (isJpg(bytes)) img = await out.embedJpg(bytes);
          else throw new Error(`「${s.name}」は有効なPNG/JPEG画像として認識できません。`);
          const landscape = img.width > img.height;
          const [pw, ph] = landscape ? [A4[1], A4[0]] : A4;
          const k = Math.min((pw - 36) / img.width, (ph - 36) / img.height);
          const w = img.width * k; const h = img.height * k;
          out.addPage([pw, ph]).drawImage(img, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h });
          pages += 1;
        }
      }
      out.setProducer('DocuCraft PDF Studio'); out.setCreator('DocuCraft PDF Studio');
      const outBytes = await out.save();
      if (!(await openBytes(outBytes, 'merged.pdf'))) return;
      state.mergeItems = [];
      closeMergeModal();
      status(`${sources.length} 個のファイルを結合しました（${pages} ページ）。「PDF保存（元PDF保持）」で保存できます。`);
    });
    if (!ok) setMergeMessage('結合に失敗しました。詳細は画面下部のステータスをご確認ください。');
  }

  async function runCreateBlank() {
    if (!hasPdfLib()) { setMergeMessage('PDF編集ライブラリ(pdf-lib)を読み込めません。'); return; }
    const size = $('newPaperSize').value === 'letter' ? LETTER : A4;
    const landscape = $('newOrientation').value === 'landscape';
    const n = clamp(parseInt($('newPageCount').value, 10) || 1, 1, 50);
    if (!beforeDocumentReplace()) return;
    await withBusy('新規PDFの作成', async () => {
      const out = await PDFLib.PDFDocument.create();
      for (let i = 0; i < n; i++) out.addPage(landscape ? [size[1], size[0]] : size);
      out.setProducer('DocuCraft PDF Studio'); out.setCreator('DocuCraft PDF Studio');
      if (!(await openBytes(await out.save(), 'new-document.pdf'))) return;
      closeMergeModal();
      status(`空白の新規PDF（${n} ページ）を作成しました。直接編集モードで「テキスト追加」「表を挿入」などが使えます。`);
    });
  }

  // ===========================================================================
  // 4. ラスタライズ共通処理（墨消し・画像化保存・画像切り出し）
  // ===========================================================================
  async function renderPageCanvas(pageNum, scale) {
    const page = await appState.pdfDoc.getPage(pageNum);
    try {
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const ctx = canvas.getContext('2d', { alpha: false });
      if (!ctx) throw new Error('Canvasを初期化できません。');
      ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport }).promise;
      return canvas;
    } finally { page.cleanup(); }
  }

  async function safeScale(pageNum, dpi) {
    const page = await appState.pdfDoc.getPage(pageNum);
    try {
      const vp = page.getViewport({ scale: 1 });
      const s = Math.min(dpi / 72, Math.sqrt(limits().pagePixels / (vp.width * vp.height)));
      return { s, width: vp.width, height: vp.height };
    } finally { page.cleanup(); }
  }

  const canvasToBlob = (canvas) => new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('画像の生成に失敗しました。'))), 'image/png'));

  // ops(ページ座標px): {kind:'rect',x,y,w,h,color} / {kind:'image',x,y,w,h,bytes(PNG)} を反映したPNGを返す
  async function flattenPageToPng(pageIdx, ops) {
    const pd = appState.pagesData[pageIdx];
    const base = (pd && pd.scale) || 1.35;
    const { s, width, height } = await safeScale(pageIdx + 1, FLATTEN_DPI);
    const canvas = await renderPageCanvas(pageIdx + 1, s);
    try {
      const ctx = canvas.getContext('2d');
      const f = s / base;
      for (const op of ops.filter((o) => o.kind === 'rect')) { ctx.fillStyle = op.color; ctx.fillRect(op.x * f, op.y * f, op.w * f, op.h * f); }
      for (const op of ops.filter((o) => o.kind === 'image')) {
        const bmp = await createImageBitmap(new Blob([op.bytes], { type: 'image/png' }));
        try { ctx.drawImage(bmp, op.x * f, op.y * f, op.w * f, op.h * f); } finally { if (bmp.close) bmp.close(); }
      }
      const blob = await canvasToBlob(canvas);
      return { bytes: new Uint8Array(await blob.arrayBuffer()), width, height };
    } finally { canvas.width = 0; canvas.height = 0; }
  }

  // ===========================================================================
  // 5. 墨消し（範囲指定・検索指定 → 該当ページを画像化して元の文字データを除去）
  // ===========================================================================
  const marksCount = () => { let n = 0; state.marks.forEach((a) => { n += a.length; }); return n; };

  function addMark(pageIdx, box) {
    const pd = appState.pagesData[pageIdx]; if (!pd) return false;
    const x = clamp(box.x, 0, pd.width); const y = clamp(box.y, 0, pd.height);
    const w = clamp(box.w, 0, pd.width - x); const h = clamp(box.h, 0, pd.height - y);
    if (w < 2 || h < 2 || marksCount() >= MAX_MARKS) return false;
    const list = state.marks.get(pageIdx) || [];
    if (list.some((m) => Math.abs(m.x - x) < 1 && Math.abs(m.y - y) < 1 && Math.abs(m.w - w) < 1 && Math.abs(m.h - h) < 1)) return false;
    list.push({ x, y, w, h });
    state.marks.set(pageIdx, list);
    return true;
  }

  function ensureLayers() {
    pagesContainer.querySelectorAll('.pdf-page-container').forEach((pageEl) => {
      if (!pageEl.querySelector('.redact-layer')) {
        const layer = document.createElement('div');
        layer.className = 'redact-layer';
        bindRedactLayer(layer, pageEl);
        pageEl.appendChild(layer);
      }
      if (appState.editMode === 'direct' && !pageEl.querySelector('.img-layer')) {
        const il = document.createElement('div');
        il.className = 'img-layer';
        pageEl.appendChild(il);
      }
    });
  }

  function bindRedactLayer(layer, pageEl) {
    layer.addEventListener('pointerdown', (e) => {
      if (!state.redactMode || e.button !== 0) return;
      const pageIdx = Number(pageEl.dataset.pageIndex);
      const point = (ev) => {
        const r = pageEl.getBoundingClientRect(); const k = r.width / pageEl.offsetWidth || 1;
        return { x: clamp((ev.clientX - r.left) / k, 0, pageEl.offsetWidth), y: clamp((ev.clientY - r.top) / k, 0, pageEl.offsetHeight) };
      };
      const start = point(e);
      const ghost = document.createElement('div'); ghost.className = 'redact-mark ghost'; layer.appendChild(ghost);
      const rectOf = (p) => ({ x: Math.min(start.x, p.x), y: Math.min(start.y, p.y), w: Math.abs(p.x - start.x), h: Math.abs(p.y - start.y) });
      const paint = (r) => { ghost.style.left = `${r.x}px`; ghost.style.top = `${r.y}px`; ghost.style.width = `${r.w}px`; ghost.style.height = `${r.h}px`; };
      const move = (ev) => { if (ev.pointerId === e.pointerId) paint(rectOf(point(ev))); };
      const finish = (ev) => {
        if (ev.pointerId !== e.pointerId) return;
        layer.removeEventListener('pointermove', move); layer.removeEventListener('pointerup', finish); layer.removeEventListener('pointercancel', finish);
        const r = rectOf(point(ev)); ghost.remove();
        try { layer.releasePointerCapture(e.pointerId); } catch (err) { /* 既に解放済み */ }
        if (ev.type === 'pointerup' && r.w >= 4 && r.h >= 4 && addMark(pageIdx, r)) { rebuildRedactLayers(); status(`墨消し範囲を追加しました（合計 ${marksCount()} 件）。「墨消しを適用」で確定します。`); }
      };
      layer.setPointerCapture(e.pointerId);
      layer.addEventListener('pointermove', move); layer.addEventListener('pointerup', finish); layer.addEventListener('pointercancel', finish);
      e.preventDefault();
    });
  }

  function rebuildRedactLayers() {
    pagesContainer.querySelectorAll('.pdf-page-container').forEach((pageEl) => {
      const layer = pageEl.querySelector('.redact-layer'); if (!layer) return;
      layer.textContent = '';
      const idx = Number(pageEl.dataset.pageIndex);
      (state.marks.get(idx) || []).forEach((m) => {
        const el = document.createElement('div'); el.className = 'redact-mark';
        el.style.left = `${m.x}px`; el.style.top = `${m.y}px`; el.style.width = `${m.w}px`; el.style.height = `${m.h}px`;
        const del = document.createElement('button'); del.type = 'button'; del.className = 'redact-del'; del.textContent = '×'; del.setAttribute('aria-label', '墨消し範囲を削除');
        del.addEventListener('click', (ev) => {
          ev.stopPropagation();
          const list = state.marks.get(idx) || []; const i = list.indexOf(m); if (i >= 0) list.splice(i, 1);
          if (!list.length) state.marks.delete(idx);
          rebuildRedactLayers(); updateToolStates();
        });
        el.appendChild(del); layer.appendChild(el);
      });
    });
    updateToolStates();
  }

  function addSearchMarks() {
    const query = ($('redactQuery').value || '').trim();
    const preset = $('redactPreset').value;
    if (!query && !preset) { status('検索語を入力するか、パターンを選択してください。'); return; }
    if (!appState.pagesData.some((pd) => pd.rawItems && pd.rawItems.length)) {
      status('テキスト情報が見つかりません（スキャン画像PDFの可能性）。「範囲指定」でドラッグして指定してください。'); return;
    }
    let added = 0;
    appState.pagesData.forEach((pd, i) => {
      for (const b of findMatchBoxes(pd.rawItems, query, '')) if (query && addMark(i, b)) added++;
      for (const b of findMatchBoxes(pd.rawItems, '', preset)) if (preset && addMark(i, b)) added++;
    });
    rebuildRedactLayers();
    status(added ? `${added} 箇所を墨消し範囲に追加しました（合計 ${marksCount()} 件）。位置を確認して「墨消しを適用」を押してください。` : '一致する箇所は見つかりませんでした（複数のテキスト片にまたがる文字列は検出できない場合があります）。');
  }

  async function applyRedactions() {
    const bytes = needBytes(); if (!bytes || state.busy) return;
    if (!appState.pdfDoc) { status('PDFが読み込まれていません。'); return; }
    if (!confirmDiscardOverlay()) return;
    const targets = Array.from(state.marks.entries()).filter(([, m]) => m.length).map(([i]) => i).sort((a, b) => a - b);
    if (!targets.length) { status('墨消し範囲が指定されていません。'); return; }
    const total = marksCount();
    if (!window.confirm(`${targets.length} ページ・${total} 箇所を墨消しします。\n\n・該当ページは画像化され、文字の検索・コピーはできなくなります（元の文字データは出力に含まれません）\n・しおり・フォーム・リンク等の一部は引き継がれない場合があります\n・元のファイルは変更されません。適用後に必ず保存してください。\n\n実行しますか？`)) return;
    await withBusy('墨消しの適用', async () => {
      const flat = new Map();
      for (const i of targets) {
        status(`ページ ${i + 1} を墨消し・画像化中...`, true);
        flat.set(i, await flattenPageToPng(i, state.marks.get(i).map((m) => ({ kind: 'rect', x: m.x, y: m.y, w: m.w, h: m.h, color: '#000000' }))));
      }
      const { out, stripped } = await assembleFromBytes(bytes, (src) => {
        const n = src.getPageCount();
        if (n !== appState.pagesData.length) throw new Error('ページ数が一致しないため中止しました。');
        return Array.from({ length: n }, (_, i) => (flat.has(i) ? { type: 'image', ...flat.get(i) } : { type: 'page', index: i }));
      }, { stripMetadata: true });
      await clearCatalogMetadata(out);
      const outBytes = await out.save();
      if (!(await openBytes(outBytes, `${baseName(appState.pdfName)}_redacted.pdf`))) return;
      status(`墨消しを適用しました（${targets.length} ページ・${total} 箇所）。該当ページは画像化済みです。${stripped ? '（リンク・注釈の一部を除去しました）' : ''}「PDF保存（元PDF保持）」で保存してください。`);
    });
  }

  async function clearCatalogMetadata(doc) {
    try { doc.catalog.delete(PDFLib.PDFName.of('Metadata')); } catch (e) { /* 無ければ何もしない */ }
  }

  // ===========================================================================
  // 6. 直接編集（PDF内の文字・画像をそのまま編集）
  // ===========================================================================
  function sigParts(el) {
    const c = el.querySelector('.editable-content'); const s = el.style;
    return {
      geo: [s.left, s.top, s.width].join('|'),
      font: [s.fontSize, s.fontWeight, s.fontFamily, s.textAlign, s.lineHeight, s.border, s.padding].join('|'),
      color: s.color,
      content: c ? c.innerHTML : ''
    };
  }
  const partsEqual = (a, b) => a.geo === b.geo && a.font === b.font && a.color === b.color && a.content === b.content;

  function setupDirectItem(el, block, pageIdx) {
    el.classList.remove('masked-bg');
    el.style.backgroundColor = 'transparent';
    if (block.fontFamily) el.style.fontFamily = block.fontFamily;
    el.dataset.directItem = '1';
    el.dataset.directIndex = String(block.origIndex);
    el.dataset.pageIndex = String(pageIdx);
    itemBase.set(el, sigParts(el));
  }

  function scheduleRefresh() {
    if (state.refreshQueued) return;
    state.refreshQueued = true;
    window.requestAnimationFrame(refreshDirectItems);
  }

  function refreshDirectItems() {
    state.refreshQueued = false;
    if (appState.editMode !== 'direct') return;
    pagesContainer.querySelectorAll('[data-direct-item="1"]').forEach((el) => {
      const base = itemBase.get(el); if (!base) return;
      const edited = !partsEqual(base, sigParts(el));
      if (edited && el.dataset.edited !== '1') { el.dataset.edited = '1'; onItemBecameEdited(el); }
      else if (!edited && el.dataset.edited === '1') { el.dataset.edited = ''; el.style.backgroundColor = 'transparent'; }
    });
  }

  function origRect(raw, pad) {
    return { x: raw.x - pad, y: raw.y - pad, w: raw.w + pad * 2, h: raw.h + pad * 2 };
  }

  function onItemBecameEdited(el) {
    el.__bg = '#ffffff';
    el.style.backgroundColor = '#ffffff'; // 元の文字を隠す（即時）
    const pageIdx = Number(el.dataset.pageIndex);
    const pd = appState.pagesData[pageIdx];
    const raw = pd && pd.rawItems[Number(el.dataset.directIndex)];
    if (!raw) return;
    getSampler(pageIdx).then((smp) => {
      if (!smp || !el.isConnected || el.dataset.edited !== '1') return;
      const rect = origRect(raw, 0);
      const bg = sampleBg(smp.ctx, rect, 3);
      el.__bg = bg; el.style.backgroundColor = bg;
      const base = itemBase.get(el);
      if (base && el.style.color === base.color) {
        const tc = sampleText(smp.ctx, rect, bg);
        if (tc) { el.style.color = tc; base.color = el.style.color; }
      }
    }).catch(() => { /* サンプリング失敗時は白背景・既定色のまま */ });
  }

  // --- ページ画像からの背景色・文字色サンプリング ---
  async function getSampler(pageIdx) {
    if (state.sampler && state.samplerPage === pageIdx) return state.sampler;
    const pd = appState.pagesData[pageIdx];
    if (!pd || !pd.bgDataUrl) return null;
    releaseSampler();
    state.samplerPage = pageIdx;
    state.sampler = (async () => {
      const img = new Image(); img.src = pd.bgDataUrl; await img.decode();
      const canvas = document.createElement('canvas'); canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) throw new Error('Canvasを初期化できません。');
      ctx.drawImage(img, 0, 0);
      return { canvas, ctx };
    })();
    return state.sampler;
  }
  function releaseSampler() {
    const p = state.sampler; state.sampler = null; state.samplerPage = -1;
    if (p) p.then((s) => { s.canvas.width = 0; s.canvas.height = 0; }).catch(() => {});
  }
  function readPixels(ctx, x, y, w, h) {
    const x0 = Math.max(0, Math.floor(x)); const y0 = Math.max(0, Math.floor(y));
    const x1 = Math.min(ctx.canvas.width, Math.ceil(x + w)); const y1 = Math.min(ctx.canvas.height, Math.ceil(y + h));
    if (x1 <= x0 || y1 <= y0) return null;
    return ctx.getImageData(x0, y0, x1 - x0, y1 - y0).data;
  }
  function sampleBg(ctx, r, ring) {
    try {
      const strips = [[r.x - ring, r.y - ring, r.w + ring * 2, ring], [r.x - ring, r.y + r.h, r.w + ring * 2, ring], [r.x - ring, r.y, ring, r.h], [r.x + r.w, r.y, ring, r.h]];
      const bins = new Map();
      for (const s of strips) {
        const d = readPixels(ctx, s[0], s[1], s[2], s[3]); if (!d) continue;
        for (let i = 0; i < d.length; i += 4) {
          const key = ((d[i] >> 4) << 8) | ((d[i + 1] >> 4) << 4) | (d[i + 2] >> 4);
          const b = bins.get(key) || { n: 0, r: 0, g: 0, b: 0 };
          b.n++; b.r += d[i]; b.g += d[i + 1]; b.b += d[i + 2]; bins.set(key, b);
        }
      }
      let best = null; bins.forEach((b) => { if (!best || b.n > best.n) best = b; });
      return best ? toHex(best.r / best.n, best.g / best.n, best.b / best.n) : '#ffffff';
    } catch (e) { return '#ffffff'; }
  }
  function sampleText(ctx, r, bgHex) {
    try {
      const d = readPixels(ctx, r.x, r.y, r.w, r.h); if (!d) return null;
      const [br, bgc, bb] = hexToRgb01(bgHex).map((v) => v * 255);
      let max = 0;
      const dist = (i) => (d[i] - br) ** 2 + (d[i + 1] - bgc) ** 2 + (d[i + 2] - bb) ** 2;
      for (let i = 0; i < d.length; i += 4) max = Math.max(max, dist(i));
      if (max < 3600) return null;
      let n = 0; let sr = 0; let sg = 0; let sb = 0;
      for (let i = 0; i < d.length; i += 4) if (dist(i) >= max * 0.7) { n++; sr += d[i]; sg += d[i + 1]; sb += d[i + 2]; }
      return n ? toHex(sr / n, sg / n, sb / n) : null;
    } catch (e) { return null; }
  }

  // --- 削除（元テキストの削除を記録し、白マスクで表示） ---
  function onDeleteSelectedCapture() {
    const el = appState.selectedElement;
    if (!el || el.dataset.directItem !== '1' || !itemBase.has(el)) return;
    const pageIdx = Number(el.dataset.pageIndex); const idx = Number(el.dataset.directIndex);
    const raw = appState.pagesData[pageIdx] && appState.pagesData[pageIdx].rawItems[idx]; if (!raw) return;
    if (!state.deleted.has(pageIdx)) state.deleted.set(pageIdx, new Set());
    state.deleted.get(pageIdx).add(idx);
    const r = origRect(raw, 1);
    const mask = document.createElement('div'); mask.className = 'pdf-text-mask';
    mask.style.left = `${r.x}px`; mask.style.top = `${r.y}px`; mask.style.width = `${r.w}px`; mask.style.height = `${r.h}px`;
    el.parentElement.appendChild(mask);
    state.dirty = true;
  }

  // --- 画像領域の検出（PDF.jsの演算子リストから） ---
  async function extractImageBoxes(page, viewport, OPS) {
    const ops = await page.getOperatorList();
    const ids = new Set([OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject, OPS.paintJpegXObject].filter((v) => v !== undefined));
    const boxes = []; const stack = []; let ctm = [1, 0, 0, 1, 0, 0];
    const vw = viewport.width; const vh = viewport.height;
    for (let i = 0; i < ops.fnArray.length && boxes.length < 200; i++) {
      const fn = ops.fnArray[i]; const args = ops.argsArray[i];
      if (fn === OPS.save) stack.push(ctm);
      else if (fn === OPS.restore) { if (stack.length) ctm = stack.pop(); }
      else if (fn === OPS.transform) ctm = compose(ctm, args);
      else if (fn === OPS.paintFormXObjectBegin) { stack.push(ctm); if (Array.isArray(args[0])) ctm = compose(ctm, args[0]); }
      else if (fn === OPS.paintFormXObjectEnd) { if (stack.length) ctm = stack.pop(); }
      else if (ids.has(fn)) {
        const m = compose(viewport.transform, ctm);
        const pts = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => applyMatrix(m, x, y));
        const xs = pts.map((p) => p[0]); const ys = pts.map((p) => p[1]);
        const x = Math.max(0, Math.min(...xs)); const y = Math.max(0, Math.min(...ys));
        const w = Math.min(vw, Math.max(...xs)) - x; const h = Math.min(vh, Math.max(...ys)) - y;
        if (!(w >= 8 && h >= 8)) continue;
        if (w >= vw * 0.95 && h >= vh * 0.95) continue; // ページ全面のスキャン画像等は対象外
        const box = { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
        if (!boxes.some((b) => b.x === box.x && b.y === box.y && b.w === box.w && b.h === box.h)) boxes.push(box);
      }
    }
    return boxes;
  }

  async function ensureImageBoxes(pageIdx) {
    const pd = appState.pagesData[pageIdx];
    if (!pd) return [];
    if (pd.imageBoxes) return pd.imageBoxes;
    const doc = appState.pdfDoc;
    if (!doc || typeof pdfjsLib === 'undefined') return [];
    const page = await doc.getPage(pageIdx + 1);
    try {
      const vp = page.getViewport({ scale: pd.scale || 1.35 });
      const boxes = await extractImageBoxes(page, vp, pdfjsLib.OPS);
      if (appState.pdfDoc === doc) { pd.imageBoxes = boxes; pd.vt = vp.transform; }
      return boxes;
    } catch (e) {
      console.warn('画像領域の検出に失敗:', e); return [];
    } finally { page.cleanup(); }
  }

  function setupImageObserver() {
    if (state.io) { state.io.disconnect(); state.io = null; }
    if (appState.editMode !== 'direct' || !appState.pdfDoc || typeof IntersectionObserver === 'undefined') return;
    const token = state.renderToken;
    state.io = new IntersectionObserver((entries) => {
      entries.forEach((en) => {
        if (!en.isIntersecting) return;
        state.io.unobserve(en.target);
        buildImageLayer(Number(en.target.dataset.pageIndex), token);
      });
    }, { root: workspaceViewport, rootMargin: '600px' });
    pagesContainer.querySelectorAll('.pdf-page-container').forEach((el) => state.io.observe(el));
  }

  async function buildImageLayer(pageIdx, token) {
    const boxes = await ensureImageBoxes(pageIdx);
    if (token !== state.renderToken) return; // 再描画で無効化済み
    const pageEl = pagesContainer.querySelector(`.pdf-page-container[data-page-index="${pageIdx}"]`);
    const layer = pageEl && pageEl.querySelector('.img-layer'); if (!layer) return;
    layer.textContent = '';
    boxes.forEach((b, idx) => {
      const el = document.createElement('div'); el.className = 'img-box'; el.dataset.key = `${pageIdx}:${idx}`;
      el.tabIndex = 0; el.setAttribute('role', 'button'); el.setAttribute('aria-label', `画像 ${idx + 1}（ページ ${pageIdx + 1}）`);
      const handle = document.createElement('div'); handle.className = 'img-handle'; el.appendChild(handle);
      placeBox(el, b);
      el.addEventListener('pointerdown', (e) => startImageDrag(e, pageEl, pageIdx, idx, el, e.target === handle ? 'resize' : 'move'));
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectImage(pageIdx, idx); } });
      layer.appendChild(el);
      const ed = state.imgEdits.get(`${pageIdx}:${idx}`); if (ed) paintImageEdit(ed, el);
    });
  }

  const placeBox = (el, r) => { el.style.left = `${r.x}px`; el.style.top = `${r.y}px`; el.style.width = `${r.w}px`; el.style.height = `${r.h}px`; };

  function selectImage(pageIdx, idx) {
    state.selectedImage = { page: pageIdx, idx };
    if (typeof selectElement === 'function') selectElement(null);
    pagesContainer.querySelectorAll('.img-box.selected').forEach((e) => e.classList.remove('selected'));
    const el = pagesContainer.querySelector(`.img-box[data-key="${pageIdx}:${idx}"]`); if (el) el.classList.add('selected');
    updateToolStates();
    status('画像を選択しました。ドラッグで移動、右下の■で拡大縮小、上部の「画像を差し替え／削除」も使えます。');
  }

  function getEdit(pageIdx, idx) {
    const key = `${pageIdx}:${idx}`;
    let ed = state.imgEdits.get(key);
    if (!ed) {
      const orig = appState.pagesData[pageIdx].imageBoxes[idx];
      ed = { key, page: pageIdx, idx, orig: { ...orig }, rect: { ...orig }, action: 'move', bytes: null, previewUrl: null };
      state.imgEdits.set(key, ed);
    }
    return ed;
  }

  function startImageDrag(e, pageEl, pageIdx, idx, el, mode) {
    if (e.button !== 0 || state.busy) return;
    selectImage(pageIdx, idx);
    const pd = appState.pagesData[pageIdx];
    const existing = state.imgEdits.get(`${pageIdx}:${idx}`);
    const startRect = { ...(existing ? existing.rect : pd.imageBoxes[idx]) };
    const r0 = pageEl.getBoundingClientRect(); const k = r0.width / pageEl.offsetWidth || 1;
    const sx = e.clientX; const sy = e.clientY;
    let moved = false;
    const move = (ev) => {
      if (ev.pointerId !== e.pointerId) return;
      const dx = (ev.clientX - sx) / k; const dy = (ev.clientY - sy) / k;
      if (Math.abs(dx) + Math.abs(dy) > 1) moved = true;
      const r = { ...startRect };
      if (mode === 'move') { r.x = startRect.x + dx; r.y = startRect.y + dy; }
      else { const scale = Math.max(0.1, Math.max((startRect.w + dx) / startRect.w, (startRect.h + dy) / startRect.h)); r.w = startRect.w * scale; r.h = startRect.h * scale; }
      placeBox(el, r); el.__rect = r;
    };
    const up = (ev) => {
      if (ev.pointerId !== e.pointerId) return;
      el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up);
      try { el.releasePointerCapture(e.pointerId); } catch (err) { /* 解放済み */ }
      if (moved && el.__rect && ev.type === 'pointerup') {
        const ed = getEdit(pageIdx, idx);
        if (ed.action === 'delete') ed.action = 'move';
        ed.rect = { x: Math.round(el.__rect.x), y: Math.round(el.__rect.y), w: Math.round(el.__rect.w), h: Math.round(el.__rect.h) };
        paintImageEdit(ed, el); state.dirty = true;
      } else if (existing) { placeBox(el, existing.rect); } else { placeBox(el, pd.imageBoxes[idx]); }
      el.__rect = null;
    };
    el.setPointerCapture(e.pointerId);
    el.addEventListener('pointermove', move); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
    e.preventDefault(); e.stopPropagation();
  }

  // 画像編集のプレビュー（元の位置を白マスク＋移動先に画像）
  async function paintImageEdit(ed, boxEl) {
    const pageEl = pagesContainer.querySelector(`.pdf-page-container[data-page-index="${ed.page}"]`); if (!pageEl) return;
    let mask = pageEl.querySelector(`.pdf-text-mask[data-key="${ed.key}"]`);
    if (!mask) { mask = document.createElement('div'); mask.className = 'pdf-text-mask'; mask.dataset.key = ed.key; pageEl.appendChild(mask); }
    placeBox(mask, ed.orig); mask.style.backgroundColor = '#ffffff';
    getSampler(ed.page).then((smp) => { if (smp && mask.isConnected) mask.style.backgroundColor = sampleBg(smp.ctx, ed.orig, 4); }).catch(() => {});
    boxEl.classList.toggle('img-box-deleted', ed.action === 'delete');
    boxEl.style.backgroundImage = 'none';
    if (ed.action === 'delete') { placeBox(boxEl, ed.orig); return; }
    placeBox(boxEl, ed.rect);
    boxEl.style.backgroundSize = '100% 100%';
    if (ed.action === 'replace' && ed.previewUrl) { boxEl.style.backgroundImage = `url("${ed.previewUrl}")`; return; }
    try { // 移動・拡大縮小: 元画像の切り出しをプレビュー表示
      const smp = await getSampler(ed.page); if (!smp) return;
      const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(ed.orig.w)); c.height = Math.max(1, Math.round(ed.orig.h));
      c.getContext('2d').drawImage(smp.canvas, ed.orig.x, ed.orig.y, ed.orig.w, ed.orig.h, 0, 0, c.width, c.height);
      boxEl.style.backgroundImage = `url("${c.toDataURL('image/png')}")`; c.width = 0; c.height = 0;
    } catch (e) { /* プレビューなしでも編集は有効 */ }
  }

  function currentImageBox() {
    const s = state.selectedImage; if (!s) return null;
    return pagesContainer.querySelector(`.img-box[data-key="${s.page}:${s.idx}"]`);
  }

  function deleteSelectedImage() {
    const s = state.selectedImage; if (!s) { status('先に画像（紫の枠）を選択してください。'); return; }
    const ed = getEdit(s.page, s.idx); ed.action = 'delete'; ed.bytes = null;
    if (ed.previewUrl) { URL.revokeObjectURL(ed.previewUrl); ed.previewUrl = null; }
    const el = currentImageBox(); if (el) paintImageEdit(ed, el);
    state.dirty = true; status('画像を削除対象にしました。保存時に元の位置が背景色で塗りつぶされます。');
  }

  function resetSelectedImage() {
    const s = state.selectedImage; if (!s) return;
    const ed = state.imgEdits.get(`${s.page}:${s.idx}`); if (!ed) return;
    if (ed.previewUrl) URL.revokeObjectURL(ed.previewUrl);
    state.imgEdits.delete(ed.key);
    const pageEl = pagesContainer.querySelector(`.pdf-page-container[data-page-index="${s.page}"]`);
    const mask = pageEl && pageEl.querySelector(`.pdf-text-mask[data-key="${ed.key}"]`); if (mask) mask.remove();
    const el = currentImageBox();
    if (el) { el.classList.remove('img-box-deleted'); el.style.backgroundImage = 'none'; placeBox(el, ed.orig); }
    status('画像の編集を元に戻しました。');
  }

  async function replaceSelectedImage(file) {
    const s = state.selectedImage; if (!s || !file) return;
    if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) { status('PNG/JPEG/WebP/GIFの画像を選択してください。'); return; }
    if (file.size > MAX_IMAGE_FILE_BYTES) { status(`画像サイズが上限（${MAX_IMAGE_FILE_BYTES / 1048576} MB）を超えています。`); return; }
    let bmp; let canvas;
    try {
      bmp = await createImageBitmap(file);
      const k = Math.min(1, MAX_IMAGE_EDGE / Math.max(bmp.width, bmp.height));
      canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(bmp.width * k)); canvas.height = Math.max(1, Math.round(bmp.height * k));
      canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
      const blob = await canvasToBlob(canvas);
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const ed = getEdit(s.page, s.idx);
      const area = ed.action === 'delete' ? ed.orig : ed.rect;
      const fit = Math.min(area.w / canvas.width, area.h / canvas.height);
      const w = canvas.width * fit; const h = canvas.height * fit;
      ed.rect = { x: Math.round(area.x + (area.w - w) / 2), y: Math.round(area.y + (area.h - h) / 2), w: Math.round(w), h: Math.round(h) };
      if (ed.previewUrl) URL.revokeObjectURL(ed.previewUrl);
      ed.action = 'replace'; ed.bytes = bytes; ed.previewUrl = URL.createObjectURL(blob);
      const el = currentImageBox(); if (el) await paintImageEdit(ed, el);
      state.dirty = true; status('画像を差し替えました（元の枠に収まるよう縮尺を調整）。ドラッグ・拡大縮小で位置を調整できます。');
    } catch (e) {
      console.error('画像差し替えエラー:', e); status('画像を読み込めませんでした。');
    } finally { if (bmp && bmp.close) bmp.close(); if (canvas) { canvas.width = 0; canvas.height = 0; } }
  }

  // --- 保存（元PDFを保持し、変更箇所のみ上書き） ---
  async function captureOp(el, pr, k) {
    const r = el.getBoundingClientRect();
    const canvas = await html2canvas(el, {
      scale: 3, backgroundColor: null, logging: false, useCORS: false,
      onclone: (doc, cloned) => {
        cloned.style.outline = 'none'; cloned.style.boxShadow = 'none';
        cloned.classList.remove('masked-bg', 'active-element');
        if (cloned.classList.contains('editable-item')) cloned.style.backgroundColor = 'transparent';
        cloned.querySelectorAll('.drag-handle').forEach((h) => h.remove());
      }
    });
    try {
      const blob = await canvasToBlob(canvas);
      return { kind: 'image', x: (r.left - pr.left) / k, y: (r.top - pr.top) / k, w: r.width / k, h: r.height / k, bytes: new Uint8Array(await blob.arrayBuffer()) };
    } finally { canvas.width = 0; canvas.height = 0; }
  }

  async function collectDirectOps() {
    const result = new Map();
    const pageEls = Array.from(pagesContainer.querySelectorAll('.pdf-page-container'));
    for (let i = 0; i < pageEls.length; i++) {
      const pageEl = pageEls[i]; const pd = appState.pagesData[i]; const ops = [];
      const pr = pageEl.getBoundingClientRect(); const k = pr.width / pageEl.offsetWidth || 1;
      let smp = null; try { smp = await getSampler(i); } catch (e) { smp = null; }
      const bgOf = (rect) => (smp ? sampleBg(smp.ctx, rect, 3) : '#ffffff');

      const del = state.deleted.get(i);
      if (del) del.forEach((idx) => { const raw = pd.rawItems[idx]; if (raw) ops.push({ kind: 'rect', ...origRect(raw, 1), color: bgOf(origRect(raw, 0)) }); });

      for (const el of pageEl.querySelectorAll('[data-direct-item="1"]')) {
        if (!itemBase.has(el) || el.dataset.edited !== '1') continue;
        const raw = pd.rawItems[Number(el.dataset.directIndex)]; if (!raw) continue;
        ops.push({ kind: 'rect', ...origRect(raw, 1), color: el.__bg || bgOf(origRect(raw, 0)) });
        if ((el.textContent || '').trim()) ops.push(await captureOp(el, pr, k));
      }
      for (const el of pageEl.querySelectorAll('.editable-item, .editable-table-wrapper, .floating-widget')) {
        if (itemBase.has(el)) continue; // 元テキスト由来（上で処理済み）
        ops.push(await captureOp(el, pr, k));
      }

      let hiRes = null;
      try {
        for (const ed of state.imgEdits.values()) {
          if (ed.page !== i) continue;
          ops.push({ kind: 'rect', ...ed.orig, color: bgOf({ x: ed.orig.x, y: ed.orig.y, w: ed.orig.w, h: ed.orig.h }) });
          if (ed.action === 'replace' && ed.bytes) ops.push({ kind: 'image', ...ed.rect, bytes: ed.bytes });
          else if (ed.action === 'move') {
            if (!hiRes) { const sc = await safeScale(i + 1, CROP_DPI); hiRes = { canvas: await renderPageCanvas(i + 1, sc.s), f: sc.s / (pd.scale || 1.35) }; }
            const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(ed.orig.w * hiRes.f)); c.height = Math.max(1, Math.round(ed.orig.h * hiRes.f));
            c.getContext('2d').drawImage(hiRes.canvas, ed.orig.x * hiRes.f, ed.orig.y * hiRes.f, ed.orig.w * hiRes.f, ed.orig.h * hiRes.f, 0, 0, c.width, c.height);
            const blob = await canvasToBlob(c); c.width = 0; c.height = 0;
            ops.push({ kind: 'image', ...ed.rect, bytes: new Uint8Array(await blob.arrayBuffer()) });
          }
        }
      } finally { if (hiRes) { hiRes.canvas.width = 0; hiRes.canvas.height = 0; } }
      if (ops.length) result.set(i, ops);
    }
    return result;
  }

  async function savePdfPreserving() {
    const bytes = needBytes(); if (!bytes || state.busy) return;
    const direct = appState.editMode === 'direct';
    if (!direct && state.dirty) {
      status('スマート再構築／厳密レイアウトでの編集は「PDFとして保存」（画像化）で保存してください。元PDF保持保存は「直接編集」モードの編集内容が対象です。'); return;
    }
    const imageize = !!($('chkImageizeEdited') && $('chkImageizeEdited').checked);
    await withBusy('PDFの保存', async () => {
      let opsMap = new Map();
      if (direct) {
        const prevZoom = appState.zoom;
        selectElement(null); appState.zoom = 1.0; applyZoom(); document.body.classList.add('exporting-clean');
        try { opsMap = await collectDirectOps(); }
        finally { document.body.classList.remove('exporting-clean'); appState.zoom = prevZoom; applyZoom(); }
      }
      let outBytes;
      if (!opsMap.size) {
        outBytes = bytes;
      } else if (imageize) {
        const flat = new Map();
        for (const [i, ops] of opsMap) { status(`ページ ${i + 1} を画像化中...`, true); flat.set(i, await flattenPageToPng(i, ops)); }
        const { out } = await assembleFromBytes(bytes, (src) => Array.from({ length: src.getPageCount() }, (_, i) => (flat.has(i) ? { type: 'image', ...flat.get(i) } : { type: 'page', index: i })));
        outBytes = await out.save();
      } else {
        const doc = await loadPdf(bytes, { updateMetadata: false });
        const { rgb } = PDFLib;
        for (const [i, ops] of opsMap) {
          const pd = appState.pagesData[i];
          if (pd.rotation) throw new Error(`ページ ${i + 1} は回転されているため、この方式では保存できません。「保存時に編集ページを画像化」をONにしてください。`);
          const page = await appState.pdfDoc.getPage(i + 1);
          let vt; try { vt = page.getViewport({ scale: pd.scale || 1.35 }).transform; } finally { page.cleanup(); }
          const target = doc.getPage(i);
          for (const op of ops.filter((o) => o.kind === 'rect')) {
            const r = pxRectToPdfRect(vt, op); const [cr, cg, cb] = hexToRgb01(op.color);
            target.drawRectangle({ x: r.x, y: r.y, width: r.width, height: r.height, color: rgb(cr, cg, cb), borderWidth: 0 });
          }
          for (const op of ops.filter((o) => o.kind === 'image')) {
            const r = pxRectToPdfRect(vt, op); const img = await doc.embedPng(op.bytes);
            target.drawImage(img, { x: r.x, y: r.y, width: r.width, height: r.height });
          }
        }
        outBytes = await doc.save();
      }
      downloadBlob(new Blob([outBytes], { type: 'application/pdf' }), `${baseName(appState.pdfName)}_edited.pdf`);
      state.dirty = false;
      status(opsMap.size
        ? `編集内容を反映したPDFを保存しました（${opsMap.size} ページ）。${imageize ? '編集ページは画像化されています。' : '編集した文字は画像として重ねており、元の文字データは背面に残ります。完全に消す場合は「保存時に編集ページを画像化」をONにしてください。'}`
        : '現在のPDFをそのまま保存しました。');
    });
  }

  // ===========================================================================
  // 7. 画面の初期化・状態更新
  // ===========================================================================
  const MODE_ON = 'flex items-center gap-1.5 px-2.5 py-1 rounded-md font-medium bg-white text-blue-700 shadow-sm transition';
  const MODE_OFF = 'flex items-center gap-1.5 px-2.5 py-1 rounded-md font-medium text-slate-600 hover:text-slate-900 transition';
  const MODE_TEXT = {
    hybrid: '| モード: スマート再構築 (全文1文書統合・表の自動認識)',
    exact: '| モード: 厳密レイアウト固定 (個別文字ブロック直接編集)',
    direct: '| モード: 直接編集 (PDF内の文字・画像をその場で編集)'
  };
  function syncModeButtons() {
    const map = { hybrid: 'modeHybridBtn', exact: 'modeExactBtn', direct: 'modeDirectBtn' };
    Object.keys(map).forEach((m) => {
      const b = $(map[m]); if (!b) return;
      b.className = appState.editMode === m ? MODE_ON : MODE_OFF;
      b.setAttribute('aria-pressed', appState.editMode === m ? 'true' : 'false');
    });
    if (modeStatusText) modeStatusText.textContent = MODE_TEXT[appState.editMode] || '';
  }

  function updateToolStates() {
    const hasDoc = !!appState.pdfBytes;
    const busy = state.busy;
    const set = (id, disabled, title) => {
      const b = $(id); if (!b) return;
      if (b.dataset.origTitle === undefined) b.dataset.origTitle = b.title || '';
      b.disabled = !!disabled;
      b.title = disabled && title ? title : b.dataset.origTitle;
    };
    const needDoc = hasDoc ? undefined : 'PDFを開くか新規作成すると使えます';
    ['btnPageRotL', 'btnPageRotR', 'btnPageDelete', 'btnPageDuplicate', 'btnPageUp', 'btnPageDown', 'btnPageInsertBlank', 'btnPageExtract', 'btnPageSelectAll',
      'btnRedactMode', 'btnRedactSearch', 'btnRedactApply', 'btnSavePdfDirect'].forEach((id) => set(id, busy || !hasDoc, needDoc));
    set('btnRedactClear', busy || marksCount() === 0);
    const imgOk = appState.editMode === 'direct' && !!state.selectedImage;
    ['btnImgReplace', 'btnImgDelete', 'btnImgReset'].forEach((id) => set(id, busy || !imgOk));
    ['btnOpenMerge', 'btnRunMerge', 'btnCreateBlank'].forEach((id) => set(id, busy));
    const count = $('redactCount'); if (count) count.textContent = `${marksCount()} 件`;
    const mode = $('btnRedactMode'); if (mode) mode.setAttribute('aria-pressed', state.redactMode ? 'true' : 'false');
    const hint = $('toolHint');
    if (hint) hint.textContent = hasDoc ? '' : 'サンプル表示中です。PDFを開く／新規作成すると、ページ編集・墨消し・保存が使えます。';
  }

  function bind(id, event, fn) { const el = $(id); if (el) el.addEventListener(event, fn); }

  function init() {
    // 変更検知（ページ上の編集をダーティ扱いにし、直接編集の差分を検出）
    if (typeof MutationObserver !== 'undefined') {
      state.observer = new MutationObserver((records) => {
        const relevant = records.some((r) => {
          const t = r.target.nodeType === 1 ? r.target : r.target.parentElement;
          return t && !(t.closest && t.closest('.redact-layer, .img-layer'));
        });
        if (!relevant) return;
        state.dirty = true; scheduleRefresh();
      });
      state.observer.observe(pagesContainer, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['style'] });
    }

    // 直接編集モード
    bind('modeDirectBtn', 'click', () => {
      if (!beforeModeSwitch()) return;
      appState.editMode = 'direct'; syncModeButtons(); renderAllPages();
    });
    bind('modeHybridBtn', 'click', syncModeButtons);
    bind('modeExactBtn', 'click', syncModeButtons);

    // 作成・結合
    bind('btnOpenMerge', 'click', openMergeModal);
    bind('btnCloseMerge', 'click', closeMergeModal);
    bind('btnCloseMergeBottom', 'click', closeMergeModal);
    bind('mergeFileInput', 'change', (e) => { addMergeFiles(e.target.files); e.target.value = ''; });
    bind('chkIncludeCurrent', 'change', renderMergeList);
    bind('btnRunMerge', 'click', runMerge);
    bind('btnCreateBlank', 'click', runCreateBlank);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMergeModal(); });

    // ページ編集
    bind('btnPageSelectAll', 'click', () => {
      const n = appState.pagesData.length;
      state.selectedPages = state.selectedPages.size === n ? new Set() : new Set(Array.from({ length: n }, (_, i) => i));
      decorateThumbs(); updateToolStates();
    });
    bind('btnPageRotL', 'click', () => rotateSelected(-90));
    bind('btnPageRotR', 'click', () => rotateSelected(90));
    bind('btnPageDelete', 'click', deleteSelected);
    bind('btnPageDuplicate', 'click', duplicateSelected);
    bind('btnPageUp', 'click', () => moveSelected(-1));
    bind('btnPageDown', 'click', () => moveSelected(1));
    bind('btnPageInsertBlank', 'click', insertBlank);
    bind('btnPageExtract', 'click', extractSelected);

    // 墨消し
    bind('btnRedactMode', 'click', () => {
      state.redactMode = !state.redactMode;
      workspaceViewport.classList.toggle('redact-mode', state.redactMode);
      updateToolStates();
      status(state.redactMode ? '墨消しモード: ページ上をドラッグして範囲を指定してください（×で個別削除）。' : '墨消しモードを終了しました。');
    });
    bind('btnRedactSearch', 'click', addSearchMarks);
    bind('redactQuery', 'keydown', (e) => { if (e.key === 'Enter') addSearchMarks(); });
    bind('btnRedactClear', 'click', () => { state.marks.clear(); rebuildRedactLayers(); status('墨消しの指定をすべて解除しました。'); });
    bind('btnRedactApply', 'click', applyRedactions);

    // 直接編集（画像）・保存
    bind('btnImgDelete', 'click', deleteSelectedImage);
    bind('btnImgReset', 'click', resetSelectedImage);
    bind('btnImgReplace', 'click', () => { if (state.selectedImage) { const i = $('imgReplaceInput'); if (i) i.click(); } });
    bind('imgReplaceInput', 'change', (e) => { const f = e.target.files && e.target.files[0]; e.target.value = ''; if (f) replaceSelectedImage(f); });
    bind('btnSavePdfDirect', 'click', savePdfPreserving);

    syncModeButtons();
    afterRender();
  }

  const api = {
    setupDirectItem, onBeforeDelete: onDeleteSelectedCapture, afterRender, onThumbClick, onDocumentLoaded, beforeDocumentReplace, beforeModeSwitch,
    _test: { parsePageRange, findMatchBoxes, pxRectToPdfRect, invertMatrix, compose, applyMatrix, extractImageBoxes, assemblePlan, assembleFromBytes, countPageObjects, hexToRgb01, toHex }
  };
  root.PdfTools = api;

  if (typeof document !== 'undefined' && document.addEventListener) {
    document.addEventListener('DOMContentLoaded', init);
  }
})(typeof window !== 'undefined' ? window : globalThis);
