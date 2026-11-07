// Configure optional external libraries. The PDF workflow is unavailable if PDF.js fails to load.
    const pdfLibraryAvailable = typeof pdfjsLib !== 'undefined';
    if (pdfLibraryAvailable) {
      pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    }
    if (typeof lucide !== 'undefined') lucide.createIcons();

    // Resource limits protect browser memory when opening untrusted or unusually large PDFs.
    const MAX_PDF_BYTES = 100 * 1024 * 1024;
    const MAX_PDF_PAGES = 200;
    const MAX_PAGE_PIXELS = 24_000_000;
    const MAX_TOTAL_PAGE_PIXELS = 180_000_000;
    let pdfLoadGeneration = 0;
    let dragState = null;

    // Application State
    const appState = {
      pdfDoc: null,
      pagesData: [], // Stores extracted raw items and background canvas data per page
      editMode: 'hybrid', // 'hybrid' (Unified Full-Document & Table Reconstruction) or 'exact' (Strict block-by-block overlay)
      zoom: 1.0,
      bgOpacity: 1.0,
      selectedElement: null,
      activeEditableTarget: null,
      savedRange: null, // Preserves text selection range when interacting with toolbar inputs/selects
      activePageIndex: 0,
      pdfBytes: null, // 元PDFのバイト列（ページ編集・墨消し・保存で使用）
      pdfName: ''
    };

    // DOM Elements
    const pagesContainer = document.getElementById('pagesContainer');
    const thumbnailList = document.getElementById('thumbnailList');
    const pageCountBadge = document.getElementById('pageCountBadge');
    const statusMessage = document.getElementById('statusMessage');
    const modeStatusText = document.getElementById('modeStatusText');
    const workspaceViewport = document.getElementById('workspaceViewport');
    const tableContextTools = document.getElementById('tableContextTools');
    const noSelectionMsg = document.getElementById('noSelectionMsg');
    const selectionControls = document.getElementById('selectionControls');

    // Helper to update status bar
    function setStatus(text, isLoading = false) {
      const indicator = statusMessage.querySelector('[data-status-indicator]');
      const label = statusMessage.querySelector('[data-status-text]');
      if (indicator) {
        indicator.className = `w-2 h-2 rounded-full ${isLoading ? 'bg-amber-400 animate-ping' : 'bg-emerald-400'}`;
      }
      if (label) label.textContent = String(text);
    }

    // =========================================================================
    // 0. RICH-TEXT SELECTION TRACKING & PARTIAL STYLING ENGINE
    //    Allows Word-like partial font family, partial font size, bold, italic,
    //    underline, color, and background changes on any selected substring!
    // =========================================================================
    function isNodeInsideEditable(node) {
      if (!node) return null;
      const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
      if (!el) return null;
      if (el.closest('.drag-handle')) return null;
      return el.closest('.editable-content, .editable-table td, .editable-table th, .hanko-stamp, .editable-item');
    }

    function saveCurrentSelectionRange() {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return;
      const range = sel.getRangeAt(0);
      const startContainerEl = isNodeInsideEditable(range.startContainer);
      const endContainerEl = isNodeInsideEditable(range.endContainer);
      if (startContainerEl && endContainerEl && startContainerEl === endContainerEl) {
        appState.savedRange = range.cloneRange();
        appState.activeEditableTarget = startContainerEl;
        const ownerItem = startContainerEl.closest('.editable-item, .editable-table-wrapper, .floating-widget');
        if (ownerItem && appState.selectedElement !== ownerItem) {
          selectElement(ownerItem);
        }
        syncToolbarWithSelection(range);
      }
    }

    document.addEventListener('selectionchange', () => {
      const activeEl = document.activeElement;
      // Do not overwrite savedRange while the user is interacting with toolbar inputs/selects
      if (activeEl && (activeEl.closest('.app-toolbar') || activeEl.closest('#propertyPanel'))) {
        return;
      }
      saveCurrentSelectionRange();
    });

    function rgbToHex(colorStr) {
      if (!colorStr) return '#0f172a';
      if (colorStr.startsWith('#')) {
        if (colorStr.length === 4) {
          return '#' + colorStr[1] + colorStr[1] + colorStr[2] + colorStr[2] + colorStr[3] + colorStr[3];
        }
        return colorStr.slice(0, 7);
      }
      const m = colorStr.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
      if (!m) return '#0f172a';
      const r = Math.min(255, parseInt(m[1], 10)).toString(16).padStart(2, '0');
      const g = Math.min(255, parseInt(m[2], 10)).toString(16).padStart(2, '0');
      const b = Math.min(255, parseInt(m[3], 10)).toString(16).padStart(2, '0');
      return `#${r}${g}${b}`;
    }

    function syncToolbarWithSelection(range) {
      if (!range) return;
      let targetNode = range.startContainer;
      if (targetNode.nodeType === Node.TEXT_NODE) {
        targetNode = targetNode.parentElement;
      }
      if (!targetNode || !(targetNode instanceof HTMLElement)) return;

      const computed = window.getComputedStyle(targetNode);
      const fontSizeInput = document.getElementById('fontSizeInput');
      if (fontSizeInput && document.activeElement !== fontSizeInput) {
        const px = Math.round(parseFloat(computed.fontSize) || 14);
        fontSizeInput.value = px;
      }

      const fontFamilySelect = document.getElementById('fontFamilySelect');
      if (fontFamilySelect && document.activeElement !== fontFamilySelect) {
        const fam = computed.fontFamily || '';
        for (const opt of fontFamilySelect.options) {
          const cleanOpt = opt.value.replace(/['"]/g, '').split(',')[0].trim().toLowerCase();
          if (cleanOpt && fam.toLowerCase().includes(cleanOpt)) {
            fontFamilySelect.value = opt.value;
            break;
          }
        }
      }

      const textColorPicker = document.getElementById('textColorPicker');
      if (textColorPicker && document.activeElement !== textColorPicker) {
        textColorPicker.value = rgbToHex(computed.color);
      }
    }

    function getActiveRangeForStyling() {
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0) {
        const liveRange = sel.getRangeAt(0);
        const container = isNodeInsideEditable(liveRange.startContainer);
        if (container && !liveRange.collapsed) {
          appState.savedRange = liveRange.cloneRange();
          appState.activeEditableTarget = container;
          return liveRange;
        }
      }
      if (appState.savedRange && !appState.savedRange.collapsed) {
        const container = isNodeInsideEditable(appState.savedRange.startContainer);
        if (container && document.body.contains(container)) {
          return appState.savedRange.cloneRange();
        }
      }
      return null;
    }

    function restoreSelectionRange(range) {
      if (!range) return;
      appState.savedRange = range.cloneRange();
      const sel = window.getSelection();
      if (sel) {
        sel.removeAllRanges();
        sel.addRange(range);
      }
    }

    // Collect text nodes intersecting the given range, splitting boundary text nodes cleanly
    function splitAndCollectTextNodesInRange(range) {
      if (range.collapsed) return [];

      // Split end boundary first so start offsets remain valid
      if (range.endContainer.nodeType === Node.TEXT_NODE) {
        const endText = range.endContainer;
        if (range.endOffset > 0 && range.endOffset < endText.nodeValue.length) {
          endText.splitText(range.endOffset);
        }
      }
      if (range.startContainer.nodeType === Node.TEXT_NODE) {
        const startText = range.startContainer;
        if (range.startOffset > 0 && range.startOffset < startText.nodeValue.length) {
          const afterNode = startText.splitText(range.startOffset);
          if (range.endContainer === startText) {
            range.setEnd(afterNode, range.endOffset - range.startOffset);
          }
          range.setStart(afterNode, 0);
        }
      }

      const root = range.commonAncestorContainer;
      if (root.nodeType === Node.TEXT_NODE) {
        return root.nodeValue.length > 0 ? [root] : [];
      }

      const textNodes = [];
      const walker = document.createTreeWalker(
        root,
        NodeFilter.SHOW_TEXT,
        {
          acceptNode(node) {
            if (!node.nodeValue || node.nodeValue.length === 0) return NodeFilter.FILTER_REJECT;
            if (node.parentElement && node.parentElement.closest('.drag-handle')) {
              return NodeFilter.FILTER_REJECT;
            }
            return range.intersectsNode(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
          }
        }
      );

      let current;
      while ((current = walker.nextNode())) {
        textNodes.push(current);
      }
      return textNodes;
    }

    function cleanupEmptyAndRedundantSpans(rootEl) {
      if (!rootEl) return;
      const spans = Array.from(rootEl.querySelectorAll('span.rt-styled'));
      for (const span of spans) {
        if (!span.textContent && span.children.length === 0) {
          span.remove();
          continue;
        }
        // If a styled span has only a single child which is also an rt-styled span with no sibling text, merge styles
        if (
          span.childNodes.length === 1 &&
          span.firstChild.nodeType === Node.ELEMENT_NODE &&
          span.firstChild.tagName === 'SPAN' &&
          span.firstChild.classList.contains('rt-styled')
        ) {
          const child = span.firstChild;
          const mergedCss = `${span.style.cssText}; ${child.style.cssText}`;
          span.style.cssText = mergedCss;
          while (child.firstChild) {
            span.insertBefore(child.firstChild, child);
          }
          child.remove();
        }
      }
    }

    // Apply CSS style property to ONLY the selected substring (or fallback to current line / active element)
    function applyStyleToSelectionOrElement(styleProp, styleValue, toggleCheckFn = null) {
      const range = getActiveRangeForStyling();
      if (range && !range.collapsed) {
        const container = isNodeInsideEditable(range.commonAncestorContainer) || appState.selectedElement;
        const textNodes = splitAndCollectTextNodesInRange(range);

        if (textNodes.length > 0) {
          let finalValue = styleValue;
          if (typeof toggleCheckFn === 'function') {
            const firstParent = textNodes[0].parentElement || container;
            const computed = window.getComputedStyle(firstParent);
            finalValue = toggleCheckFn(computed);
          }

          const wrappedNodes = [];
          for (const textNode of textNodes) {
            const parent = textNode.parentElement;
            if (
              parent &&
              parent.tagName === 'SPAN' &&
              parent.classList.contains('rt-styled') &&
              parent.childNodes.length === 1
            ) {
              parent.style[styleProp] = finalValue;
              // Clear conflicting descendant style on this property if any
              parent.querySelectorAll('span').forEach(s => { s.style[styleProp] = ''; });
              wrappedNodes.push(textNode);
            } else {
              const span = document.createElement('span');
              span.className = 'rt-styled';
              span.style[styleProp] = finalValue;
              textNode.parentNode.insertBefore(span, textNode);
              span.appendChild(textNode);
              wrappedNodes.push(textNode);
            }
          }

          if (container) cleanupEmptyAndRedundantSpans(container);

          // Re-select the exact styled text range so the user can continue changing size/font/color
          const newRange = document.createRange();
          newRange.setStart(wrappedNodes[0], 0);
          const lastText = wrappedNodes[wrappedNodes.length - 1];
          newRange.setEnd(lastText, lastText.nodeValue.length);
          appState.savedRange = newRange.cloneRange();

          const activeEl = document.activeElement;
          // Restore visual selection immediately if user is not typing inside a number/text input
          if (!activeEl || (activeEl.tagName !== 'INPUT' && activeEl.tagName !== 'SELECT')) {
            restoreSelectionRange(newRange);
          }
          return;
        }
      }

      // Fallback when no partial substring is selected:
      // If caret is inside a specific table cell or a specific .doc-line inside unified document, style that target;
      // otherwise style the selected element container.
      const sel = window.getSelection();
      let caretLineOrCell = null;
      if (sel && sel.rangeCount > 0 && sel.getRangeAt(0).collapsed) {
        const node = sel.getRangeAt(0).startContainer;
        const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
        if (el) {
          caretLineOrCell = el.closest('.editable-table td, .editable-table th, .doc-line');
        }
      }
      if (!caretLineOrCell && appState.savedRange && appState.savedRange.collapsed) {
        const node = appState.savedRange.startContainer;
        const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
        if (el && document.body.contains(el)) {
          caretLineOrCell = el.closest('.editable-table td, .editable-table th, .doc-line');
        }
      }

      const targetEl = caretLineOrCell || appState.selectedElement;
      if (!targetEl) return;

      let finalValue = styleValue;
      if (typeof toggleCheckFn === 'function') {
        const computed = window.getComputedStyle(targetEl);
        finalValue = toggleCheckFn(computed);
      }
      targetEl.style[styleProp] = finalValue;
    }

    // =========================================================================
    // 1. SAMPLE BUSINESS PDF GENERATOR (Japanese Invoice / Proposal with Table & Decorations)
    //    Allows immediate testing of PDF layout preservation & table editing!
    // =========================================================================
    async function loadRealisticSampleDocument() {
      if (window.PdfTools && !PdfTools.beforeDocumentReplace()) return;
      pdfLoadGeneration++;
      setStatus('サンプルのビジネス文書（御見積書・表・装飾枠）を生成しています...', true);
      if (appState.pdfDoc) {
        const previousPdf = appState.pdfDoc;
        appState.pdfDoc = null;
        try { await previousPdf.destroy(); } catch (error) { console.warn('PDF cleanup:', error); }
      }

      // Standard A4 @ 96 DPI approx: 794 x 1123 px
      const pageWidth = 794;
      const pageHeight = 1123;

      // Create offscreen canvas to draw realistic PDF vector graphics (decorative borders, header banner, seal box, lines)
      const bgCanvas = document.createElement('canvas');
      bgCanvas.width = pageWidth;
      bgCanvas.height = pageHeight;
      const ctx = bgCanvas.getContext('2d');

      // White paper background
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, pageWidth, pageHeight);

      // Decorative Top Accent Bar
      const grad = ctx.createLinearGradient(0, 0, pageWidth, 0);
      grad.addColorStop(0, '#1e3a8a');
      grad.addColorStop(1, '#2563eb');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, pageWidth, 14);

      // Outer Decorative Frame
      ctx.strokeStyle = '#cbd5e1';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(36, 36, pageWidth - 72, pageHeight - 72);

      // Title Box Background
      ctx.fillStyle = '#f8fafc';
      ctx.fillRect(60, 62, pageWidth - 120, 54);
      ctx.strokeStyle = '#1e40af';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(60, 116);
      ctx.lineTo(pageWidth - 60, 116);
      ctx.stroke();

      // Client Name Underline
      ctx.strokeStyle = '#0f172a';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(60, 195);
      ctx.lineTo(410, 195);
      ctx.stroke();

      // Summary Total Highlight Box (Grand Total Box)
      ctx.fillStyle = '#eff6ff';
      ctx.strokeStyle = '#2563eb';
      ctx.lineWidth = 2;
      ctx.fillRect(60, 275, 430, 52);
      ctx.strokeRect(60, 275, 430, 52);

      // Remarks Box (Bottom Decorative Container)
      ctx.fillStyle = '#f8fafc';
      ctx.strokeStyle = '#94a3b8';
      ctx.lineWidth = 1;
      ctx.fillRect(60, 790, pageWidth - 120, 190);
      ctx.strokeRect(60, 790, pageWidth - 120, 190);

      // Company Logo Emblem (Vector Graphic on Right)
      ctx.fillStyle = '#1d4ed8';
      ctx.beginPath();
      ctx.arc(545, 175, 18, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 16px sans-serif';
      ctx.fillText('DC', 533, 181);

      const bgDataUrl = bgCanvas.toDataURL('image/png');
      bgCanvas.width = 0;
      bgCanvas.height = 0;

      // Simulated extracted PDF text items with coordinates (x, y, width, height, fontSize, fontWeight, color, text)
      const rawItems = [
        // Document Title
        { text: '御 見 積 書 (QUOTATION)', x: 245, y: 74, w: 300, h: 32, fontSize: 24, fontWeight: '700', color: '#1e3a8a', align: 'center' },

        // Issue Date & Doc Number
        { text: '見積番号：EST-2026-0892', x: 540, y: 130, w: 190, h: 20, fontSize: 13, fontWeight: '400', color: '#334155' },
        { text: '発行日：2026年11月6日', x: 540, y: 150, w: 190, h: 20, fontSize: 13, fontWeight: '400', color: '#334155' },

        // Client Info
        { text: '株式会社 ネクストイノベーション 御中', x: 65, y: 162, w: 340, h: 28, fontSize: 19, fontWeight: '700', color: '#0f172a' },
        { text: '情報システム部門 導入推進グループ 様', x: 65, y: 204, w: 310, h: 20, fontSize: 13, fontWeight: '400', color: '#475569' },
        { text: '下記の通り御見積申し上げます。ご査収のほどよろしくお願い申し上げます。', x: 65, y: 236, w: 440, h: 20, fontSize: 13, fontWeight: '400', color: '#334155' },

        // Issuer Company Info
        { text: '株式会社 DocuCraft ソリューションズ', x: 572, y: 166, w: 240, h: 22, fontSize: 14, fontWeight: '700', color: '#0f172a' },
        { text: '〒100-0005 東京都千代田区丸の内1-9-1', x: 525, y: 196, w: 220, h: 18, fontSize: 12, fontWeight: '400', color: '#475569' },
        { text: 'TEL: 03-5555-0199 / 担当: 佐藤 健一', x: 525, y: 216, w: 220, h: 18, fontSize: 12, fontWeight: '400', color: '#475569' },
        { text: '登録番号: T1010001234567', x: 525, y: 236, w: 220, h: 18, fontSize: 12, fontWeight: '400', color: '#475569' },

        // Grand Total Box Text
        { text: '御見積合計金額 (税込)', x: 80, y: 290, w: 170, h: 26, fontSize: 15, fontWeight: '700', color: '#1e3a8a' },
        { text: '¥ 1,408,000 -', x: 270, y: 284, w: 200, h: 34, fontSize: 24, fontWeight: '700', color: '#1e3a8a', align: 'right' },

        // Meta Specs above table
        { text: '件名：WebベースPDF直接編集システム構築および導入支援', x: 60, y: 345, w: 450, h: 22, fontSize: 14, fontWeight: '700', color: '#0f172a' },
        { text: '納期：ご発注後 約3週間 ／ お支払条件：検収月末締め翌月末現金振込 ／ 有効期限：発行日より30日間', x: 60, y: 370, w: 660, h: 20, fontSize: 12, fontWeight: '400', color: '#475569' },

        // Table Grid Items (Automatically detected as a structured table in Smart Reconstruction Mode!)
        // Row 0 (Header)
        { text: 'No.', x: 60, y: 410, w: 50, h: 28, fontSize: 13, fontWeight: '700', color: '#1e293b', isTableCandidate: true },
        { text: '品名・作業項目 / 内容明細', x: 110, y: 410, w: 330, h: 28, fontSize: 13, fontWeight: '700', color: '#1e293b', isTableCandidate: true },
        { text: '数量', x: 440, y: 410, w: 70, h: 28, fontSize: 13, fontWeight: '700', color: '#1e293b', isTableCandidate: true },
        { text: '単位', x: 510, y: 410, w: 60, h: 28, fontSize: 13, fontWeight: '700', color: '#1e293b', isTableCandidate: true },
        { text: '単価 (円)', x: 570, y: 410, w: 80, h: 28, fontSize: 13, fontWeight: '700', color: '#1e293b', isTableCandidate: true },
        { text: '金額 (円)', x: 650, y: 410, w: 84, h: 28, fontSize: 13, fontWeight: '700', color: '#1e293b', isTableCandidate: true },

        // Row 1
        { text: '1', x: 60, y: 445, w: 50, h: 28, fontSize: 13, fontWeight: '400', color: '#0f172a', isTableCandidate: true },
        { text: 'PDFレイアウト解析・テキスト再構築エンジン実装', x: 110, y: 445, w: 330, h: 28, fontSize: 13, fontWeight: '400', color: '#0f172a', isTableCandidate: true },
        { text: '1', x: 440, y: 445, w: 70, h: 28, fontSize: 13, fontWeight: '400', color: '#0f172a', isTableCandidate: true },
        { text: '式', x: 510, y: 445, w: 60, h: 28, fontSize: 13, fontWeight: '400', color: '#0f172a', isTableCandidate: true },
        { text: '650,000', x: 570, y: 445, w: 80, h: 28, fontSize: 13, fontWeight: '400', color: '#0f172a', isTableCandidate: true },
        { text: '650,000', x: 650, y: 445, w: 84, h: 28, fontSize: 13, fontWeight: '400', color: '#0f172a', isTableCandidate: true },

        // Row 2
        { text: '2', x: 60, y: 480, w: 50, h: 28, fontSize: 13, fontWeight: '400', color: '#0f172a', isTableCandidate: true },
        { text: 'Wordライク直接編集UI・表組エディタ機能開発', x: 110, y: 480, w: 330, h: 28, fontSize: 13, fontWeight: '400', color: '#0f172a', isTableCandidate: true },
        { text: '1', x: 440, y: 480, w: 70, h: 28, fontSize: 13, fontWeight: '400', color: '#0f172a', isTableCandidate: true },
        { text: '式', x: 510, y: 480, w: 60, h: 28, fontSize: 13, fontWeight: '400', color: '#0f172a', isTableCandidate: true },
        { text: '450,000', x: 570, y: 480, w: 80, h: 28, fontSize: 13, fontWeight: '400', color: '#0f172a', isTableCandidate: true },
        { text: '450,000', x: 650, y: 480, w: 84, h: 28, fontSize: 13, fontWeight: '400', color: '#0f172a', isTableCandidate: true },

        // Row 3
        { text: '3', x: 60, y: 515, w: 50, h: 28, fontSize: 13, fontWeight: '400', color: '#0f172a', isTableCandidate: true },
        { text: 'GitHub Pages 静的ホスティング最適化・導入ドキュメント', x: 110, y: 515, w: 330, h: 28, fontSize: 13, fontWeight: '400', color: '#0f172a', isTableCandidate: true },
        { text: '2', x: 440, y: 515, w: 70, h: 28, fontSize: 13, fontWeight: '400', color: '#0f172a', isTableCandidate: true },
        { text: '人日', x: 510, y: 515, w: 60, h: 28, fontSize: 13, fontWeight: '400', color: '#0f172a', isTableCandidate: true },
        { text: '90,000', x: 570, y: 515, w: 80, h: 28, fontSize: 13, fontWeight: '400', color: '#0f172a', isTableCandidate: true },
        { text: '180,000', x: 650, y: 515, w: 84, h: 28, fontSize: 13, fontWeight: '400', color: '#0f172a', isTableCandidate: true },

        // Row 4 (Subtotal)
        { text: '-', x: 60, y: 550, w: 50, h: 28, fontSize: 13, fontWeight: '400', color: '#0f172a', isTableCandidate: true },
        { text: '小計 (税抜金額)', x: 110, y: 550, w: 330, h: 28, fontSize: 13, fontWeight: '700', color: '#0f172a', isTableCandidate: true },
        { text: '-', x: 440, y: 550, w: 70, h: 28, fontSize: 13, fontWeight: '400', color: '#0f172a', isTableCandidate: true },
        { text: '-', x: 510, y: 550, w: 60, h: 28, fontSize: 13, fontWeight: '400', color: '#0f172a', isTableCandidate: true },
        { text: '-', x: 570, y: 550, w: 80, h: 28, fontSize: 13, fontWeight: '400', color: '#0f172a', isTableCandidate: true },
        { text: '1,280,000', x: 650, y: 550, w: 84, h: 28, fontSize: 13, fontWeight: '700', color: '#0f172a', isTableCandidate: true },

        // Row 5 (Tax)
        { text: '-', x: 60, y: 585, w: 50, h: 28, fontSize: 13, fontWeight: '400', color: '#0f172a', isTableCandidate: true },
        { text: '消費税等 (10%)', x: 110, y: 585, w: 330, h: 28, fontSize: 13, fontWeight: '400', color: '#0f172a', isTableCandidate: true },
        { text: '-', x: 440, y: 585, w: 70, h: 28, fontSize: 13, fontWeight: '400', color: '#0f172a', isTableCandidate: true },
        { text: '-', x: 510, y: 585, w: 60, h: 28, fontSize: 13, fontWeight: '400', color: '#0f172a', isTableCandidate: true },
        { text: '-', x: 570, y: 585, w: 80, h: 28, fontSize: 13, fontWeight: '400', color: '#0f172a', isTableCandidate: true },
        { text: '128,000', x: 650, y: 585, w: 84, h: 28, fontSize: 13, fontWeight: '400', color: '#0f172a', isTableCandidate: true },

        // Notes / Remarks Section
        { text: '【備考・特記事項】', x: 75, y: 805, w: 240, h: 22, fontSize: 14, fontWeight: '700', color: '#1e293b' },
        { text: '1. 本サンプルは全体を1つの文章としてWordのように自由な改行や行結合、部分的なフォント・サイズ変更が可能です。', x: 75, y: 835, w: 630, h: 20, fontSize: 13, fontWeight: '400', color: '#334155' },
        { text: '2. 文字をドラッグで部分選択し、上部ツールバーからその部分だけのフォントやサイズ・色を変更してみてください。', x: 75, y: 862, w: 630, h: 20, fontSize: 13, fontWeight: '400', color: '#334155' },
        { text: '3. お手元のPDFファイルを画面にドラッグ＆ドロップすると、同様にレイアウトを保持して直接編集できます。', x: 75, y: 889, w: 630, h: 20, fontSize: 13, fontWeight: '400', color: '#334155' },
        { text: '4. 編集後は右上の「PDFとして保存」または「Word (.doc) 出力」からいつでもダウンロードできます。', x: 75, y: 916, w: 630, h: 20, fontSize: 13, fontWeight: '400', color: '#334155' }
      ];

      selectElement(null);
      appState.activePageIndex = 0;
      appState.pdfBytes = null;
      appState.pdfName = '';
      appState.pagesData = [{
        pageNumber: 1,
        width: pageWidth,
        height: pageHeight,
        bgDataUrl: bgDataUrl,
        rawItems: rawItems,
        needsRasterMask: false,
        hasSampleStamp: true
      }];

      if (window.PdfTools) PdfTools.onDocumentLoaded();
      renderAllPages();
      setStatus('サンプル御見積書を読み込みました — 全文を1つの文章として自由な改行や部分フォント・部分サイズ変更が可能です');
    }

    // =========================================================================
    // 2. REAL PDF FILE PARSER (PDF.js)
    //    Extracts page background image + text coordinates, font sizes & styles
    // =========================================================================
    async function handlePdfFileUpload(file) {
      if (!file) return;
      if (window.PdfTools && !PdfTools.beforeDocumentReplace()) return;
      if (!pdfLibraryAvailable) {
        setStatus('PDF解析ライブラリを読み込めません。ネットワーク接続を確認してください。');
        return;
      }
      const generation = ++pdfLoadGeneration;
      let candidatePdf = null;

      try {
        if (file.size > MAX_PDF_BYTES) {
          throw new Error(`ファイルサイズが上限（${Math.round(MAX_PDF_BYTES / 1024 / 1024)} MB）を超えています。`);
        }
        if (file.type && file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name)) {
          throw new Error('PDFファイルを選択してください。');
        }

        setStatus(`「${file.name}」のレイアウトとテキスト構造を解析中...`, true);
        const arrayBuffer = await file.arrayBuffer();
        if (generation !== pdfLoadGeneration) return;
        // PDF.jsはdataのバッファを転送（detach）するため、保存・ページ編集用に複製を保持する
        const bytesCopy = arrayBuffer.slice(0);
        const signature = new TextDecoder().decode(new Uint8Array(arrayBuffer, 0, Math.min(5, arrayBuffer.byteLength)));
        if (!signature.startsWith('%PDF-')) throw new Error('PDF形式として認識できません。');

        candidatePdf = await pdfjsLib.getDocument({ data: new Uint8Array(arrayBuffer) }).promise;
        if (generation !== pdfLoadGeneration) {
          await candidatePdf.destroy();
          candidatePdf = null;
          return;
        }
        if (candidatePdf.numPages > MAX_PDF_PAGES) {
          throw new Error(`ページ数が上限（${MAX_PDF_PAGES}ページ）を超えています。`);
        }

        const nextPagesData = [];
        const renderScale = 1.35;
        let totalPagePixels = 0;

        for (let pageNum = 1; pageNum <= candidatePdf.numPages; pageNum++) {
          if (generation !== pdfLoadGeneration) throw new Error('別のファイル読み込みに切り替わりました。');
          setStatus(`ページ ${pageNum} / ${candidatePdf.numPages} を解析・再構築中...`, true);
          const page = await candidatePdf.getPage(pageNum);
          let canvas;
          try {
            const viewport = page.getViewport({ scale: renderScale });
            const pixelCount = Math.ceil(viewport.width) * Math.ceil(viewport.height);
            if (!Number.isFinite(pixelCount) || pixelCount > MAX_PAGE_PIXELS) {
              throw new Error(`ページ ${pageNum} の画像サイズが大きすぎます。`);
            }
            totalPagePixels += pixelCount;
            if (totalPagePixels > MAX_TOTAL_PAGE_PIXELS) {
              throw new Error('文書全体の画像サイズが大きすぎます。ページ数や解像度を下げてください。');
            }

            canvas = document.createElement('canvas');
            canvas.width = Math.ceil(viewport.width);
            canvas.height = Math.ceil(viewport.height);
            const ctx = canvas.getContext('2d', { alpha: false });
            if (!ctx) throw new Error('Canvasを初期化できません。');

            await page.render({ canvasContext: ctx, viewport }).promise;
            const bgDataUrl = canvas.toDataURL('image/png');
            const textContent = await page.getTextContent();
            const rawItems = [];

            for (const item of textContent.items) {
              if (!item.str || item.str.trim() === '') continue;
              const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
              const fontHeight = Math.hypot(tx[2], tx[3]);
              const x = tx[4];
              const y = tx[5] - fontHeight * 0.88;
              const w = Math.max((item.width || 20) * renderScale, fontHeight);
              const h = fontHeight * 1.2;
              const isBold = item.fontName && /bold|black|heavy|w6|w7|w8/i.test(item.fontName);

              const fontStyle = textContent.styles && textContent.styles[item.fontName];
              const genericFamily = fontStyle && fontStyle.fontFamily ? String(fontStyle.fontFamily) : '';
              const isRotated = Math.abs(tx[1]) > fontHeight * 0.1 || Math.abs(tx[2]) > fontHeight * 0.5 || item.dir === 'ttb';

              rawItems.push({
                text: item.str,
                x: Math.round(x),
                y: Math.round(y),
                w: Math.round(w),
                h: Math.round(h),
                fontSize: Math.max(9, Math.round(fontHeight * 0.92)),
                fontWeight: isBold ? '700' : '400',
                color: '#0f172a',
                fontFamily: genericFamily === 'serif' ? "'Noto Serif JP', serif" : (genericFamily === 'monospace' ? 'monospace' : "'Noto Sans JP', sans-serif"),
                noEdit: isRotated
              });
            }

            nextPagesData.push({
              pageNumber: pageNum,
              width: Math.round(viewport.width),
              height: Math.round(viewport.height),
              bgDataUrl,
              rawItems,
              scale: renderScale,
              rotation: viewport.rotation || 0,
              needsRasterMask: true,
              hasSampleStamp: false
            });
          } finally {
            if (canvas) {
              canvas.width = 0;
              canvas.height = 0;
            }
            page.cleanup();
          }
        }

        if (generation !== pdfLoadGeneration) {
          await candidatePdf.destroy();
          candidatePdf = null;
          return;
        }

        const previousPdf = appState.pdfDoc;
        appState.pdfDoc = candidatePdf;
        candidatePdf = null;
        appState.pagesData = nextPagesData;
        appState.activePageIndex = 0;
        appState.pdfBytes = bytesCopy;
        appState.pdfName = file.name || 'document.pdf';
        selectElement(null);
        if (window.PdfTools) PdfTools.onDocumentLoaded();
        renderAllPages();
        if (previousPdf) {
          try { await previousPdf.destroy(); } catch (error) { console.warn('Previous PDF cleanup:', error); }
        }
        setStatus(`「${file.name}」(${appState.pagesData.length}ページ) の再構築が完了しました。全文を1つの文章として直接編集できます。`);
      } catch (err) {
        console.error('PDF Load Error:', err);
        setStatus(err && err.message ? err.message : 'PDFの読み込み中にエラーが発生しました。');
      } finally {
        if (candidatePdf) {
          try { await candidatePdf.destroy(); } catch (error) { console.warn('PDF cleanup:', error); }
        }
      }
    }

    // =========================================================================
    // 3. SMART LAYOUT RECONSTRUCTION ENGINE
    //    In 'hybrid' mode: Combines all non-table text into a single unified
    //    Word-like multi-line document block while preserving per-fragment
    //    font size, weight, color, and horizontal/vertical spacing!
    // =========================================================================
    function analyzeAndReconstructLayout(rawItems, pageWidth = 794) {
      if (appState.editMode === 'direct') {
        // Direct mode: PDF内の各テキストを元の位置のまま編集（編集するまで元の描画をそのまま表示）
        return {
          textBlocks: rawItems.map((item, i) => ({ ...item, origIndex: i, directEdit: true })),
          unifiedDocBlock: null,
          nonTableRawRects: [],
          tables: []
        };
      }
      if (appState.editMode === 'exact') {
        // Exact mode: keep every text fragment at its exact coordinate without merging
        return {
          textBlocks: rawItems.map(item => ({ ...item })),
          unifiedDocBlock: null,
          nonTableRawRects: [],
          tables: []
        };
      }

      // Step 1: Sort items top-to-bottom, then left-to-right
      const sorted = [...rawItems].sort((a, b) => {
        if (Math.abs(a.y - b.y) <= 6) return a.x - b.x;
        return a.y - b.y;
      });

      // Step 2: Group items into horizontal lines (rows) based on Y proximity
      const rows = [];
      for (const item of sorted) {
        let matchedRow = rows.find(r => Math.abs(r.y - item.y) <= Math.max(8, item.fontSize * 0.45));
        if (matchedRow) {
          matchedRow.items.push(item);
          matchedRow.y = Math.round((matchedRow.y + item.y) / 2);
        } else {
          rows.push({ y: item.y, items: [item] });
        }
      }

      // Sort items left-to-right within each row and merge very close inline fragments
      const processedRows = rows.map(row => {
        row.items.sort((a, b) => a.x - b.x);
        const mergedCells = [];
        for (const item of row.items) {
          const prev = mergedCells[mergedCells.length - 1];
          if (
            prev &&
            !item.isTableCandidate &&
            (item.x - (prev.x + prev.w)) < 14 &&
            Math.abs(prev.fontSize - item.fontSize) <= 2 &&
            prev.fontWeight === item.fontWeight &&
            prev.color === item.color
          ) {
            prev.text += item.text;
            prev.w = Math.max(prev.w, (item.x + item.w) - prev.x);
          } else {
            mergedCells.push({ ...item });
          }
        }
        return { y: row.y, cells: mergedCells, rawRowItems: row.items };
      });

      // Step 3: Detect consecutive multi-column rows that form a Table Grid
      const tables = [];
      const nonTableRows = [];
      const nonTableRawRects = [];
      let currentTableRows = [];

      function flushCurrentTable() {
        if (currentTableRows.length >= 3) {
          const minX = Math.min(...currentTableRows.flatMap(r => r.cells.map(c => c.x)));
          const maxX = Math.max(...currentTableRows.flatMap(r => r.cells.map(c => c.x + c.w)));
          const minY = currentTableRows[0].y;
          const lastRow = currentTableRows[currentTableRows.length - 1];
          const maxH = Math.max(...lastRow.cells.map(c => c.h || 24));
          const maxY = lastRow.y + maxH;
          const colCount = Math.max(...currentTableRows.map(r => r.cells.length));

          tables.push({
            x: minX,
            y: minY,
            w: maxX - minX,
            h: maxY - minY,
            colCount: colCount,
            rows: currentTableRows.map(r => r.cells)
          });
        } else {
          for (const r of currentTableRows) {
            nonTableRows.push(r);
            for (const raw of r.rawRowItems) {
              nonTableRawRects.push(raw);
            }
          }
        }
        currentTableRows = [];
      }

      for (let i = 0; i < processedRows.length; i++) {
        const row = processedRows[i];
        const isMultiCol = row.cells.length >= 3;
        const prevRow = currentTableRows[currentTableRows.length - 1];
        const verticalGapOk = !prevRow || (row.y - prevRow.y < 52);

        if (isMultiCol && verticalGapOk) {
          currentTableRows.push(row);
        } else {
          flushCurrentTable();
          if (isMultiCol) {
            currentTableRows.push(row);
          } else {
            nonTableRows.push(row);
            for (const raw of row.rawRowItems) {
              nonTableRawRects.push(raw);
            }
          }
        }
      }
      flushCurrentTable();

      // Step 4: Combine ALL non-table rows on the page into a SINGLE unified Word-like document block
      let unifiedDocBlock = null;
      if (nonTableRows.length > 0) {
        const allCells = nonTableRows.flatMap(r => r.cells);
        const baseLeft = Math.max(24, Math.min(...allCells.map(c => c.x)));
        const maxRight = Math.min(pageWidth - 24, Math.max(...allCells.map(c => c.x + c.w)));
        const baseTop = nonTableRows[0].y;
        const docWidth = Math.max(320, maxRight - baseLeft + 24);

        const lines = [];
        let prevBottom = baseTop;

        for (let i = 0; i < nonTableRows.length; i++) {
          const row = nonTableRows[i];
          const firstCell = row.cells[0];
          const maxFontSize = Math.max(...row.cells.map(c => c.fontSize || 14));
          const rowHeight = Math.max(...row.cells.map(c => c.h || Math.round(maxFontSize * 1.35)));
          const gapY = i === 0 ? 0 : Math.max(0, row.y - prevBottom);
          prevBottom = row.y + rowHeight;

          const indentPx = Math.max(0, Math.round(firstCell.x - baseLeft));
          const isSingleCentered = row.cells.length === 1 && firstCell.align === 'center';

          const segments = [];
          let prevEndX = firstCell.x;
          row.cells.forEach((cell, idx) => {
            const gapX = idx === 0 ? 0 : Math.max(8, Math.round(cell.x - prevEndX));
            prevEndX = cell.x + (cell.w || 40);
            segments.push({
              text: cell.text,
              fontSize: cell.fontSize || 14,
              fontWeight: cell.fontWeight || '400',
              color: cell.color || '#0f172a',
              gapX
            });
          });

          lines.push({
            y: row.y,
            marginTop: gapY,
            indentPx: isSingleCentered ? 0 : indentPx,
            align: isSingleCentered ? 'center' : (firstCell.align || 'left'),
            fontSize: maxFontSize,
            segments
          });
        }

        unifiedDocBlock = {
          x: baseLeft,
          y: baseTop,
          w: docWidth,
          lines
        };
      }

      return {
        textBlocks: [],
        unifiedDocBlock,
        nonTableRawRects,
        tables
      };
    }

    // =========================================================================
    // 4. DOM RENDERER: Creates Interactive Pages, Unified Document Block & Tables
    // =========================================================================
    function renderAllPages() {
      if (appState.selectedElement) selectElement(null);
      appState.savedRange = null;
      pagesContainer.innerHTML = '';
      thumbnailList.innerHTML = '';
      pageCountBadge.textContent = `${appState.pagesData.length} ページ`;

      appState.pagesData.forEach((pageData, pageIdx) => {
        // 1. Create Page Container
        const pageEl = document.createElement('div');
        pageEl.className = 'pdf-page-container';
        pageEl.style.width = `${pageData.width}px`;
        pageEl.style.height = `${pageData.height}px`;
        pageEl.dataset.pageIndex = pageIdx;

        // 2. Background Layer (Original PDF vector/raster image)
        const bgImg = document.createElement('img');
        bgImg.src = pageData.bgDataUrl;
        bgImg.className = 'page-bg-image absolute inset-0 w-full h-full pointer-events-none select-none';
        bgImg.style.opacity = appState.bgOpacity;
        pageEl.appendChild(bgImg);

        // 3. Reconstruct Layout (Unified Document Block or Exact Blocks + Auto-Detected Tables)
        const { textBlocks, unifiedDocBlock, nonTableRawRects, tables } = analyzeAndReconstructLayout(
          pageData.rawItems,
          pageData.width
        );

        // If uploaded PDF has rasterized text on its background image, mask exact original text coordinates
        // so decorative borders/lines remain visible while original glyphs are hidden.
        if (pageData.needsRasterMask && unifiedDocBlock && nonTableRawRects.length > 0) {
          nonTableRawRects.forEach(rect => {
            const mask = document.createElement('div');
            mask.className = 'pdf-text-mask';
            mask.style.left = `${Math.max(0, rect.x - 2)}px`;
            mask.style.top = `${Math.max(0, rect.y - 2)}px`;
            mask.style.width = `${rect.w + 4}px`;
            mask.style.height = `${rect.h + 4}px`;
            pageEl.appendChild(mask);
          });
        }

        // Render Unified Single-Article Document Block (Word-like full text editing)
        if (unifiedDocBlock) {
          const unifiedEl = createUnifiedDocumentElement(unifiedDocBlock);
          pageEl.appendChild(unifiedEl);
        }

        // Render Individual Editable Text Blocks (in Exact mode)
        textBlocks.forEach(block => {
          if (block.directEdit && block.noEdit) return; // 縦書き・回転文字は直接編集の対象外（元の描画のまま）
          const textEl = createEditableTextElement(block);
          if (block.directEdit && window.PdfTools) PdfTools.setupDirectItem(textEl, block, pageIdx);
          pageEl.appendChild(textEl);
        });

        // Render Reconstructed HTML Tables
        tables.forEach(tableObj => {
          const tableWrapper = createEditableTableElement(tableObj);
          pageEl.appendChild(tableWrapper);
        });

        // Add Sample Hanko Stamp if sample page
        if (pageData.hasSampleStamp) {
          const stamp = createHankoStampElement('承認済', '佐藤', 662, 160);
          pageEl.appendChild(stamp);
        }

        pagesContainer.appendChild(pageEl);

        // 4. Create Left Sidebar Thumbnail
        const thumbItem = document.createElement('div');
        thumbItem.className = `cursor-pointer group rounded-lg p-2 border transition ${pageIdx === 0 ? 'bg-white border-blue-500 shadow-sm' : 'bg-slate-50 border-slate-200 hover:border-blue-300'}`;
        thumbItem.innerHTML = `
          <div class="aspect-[1/1.414] bg-white border border-slate-200 rounded overflow-hidden mb-1.5 relative shadow-inner">
            <img src="${pageData.bgDataUrl}" class="w-full h-full object-contain">
          </div>
          <div class="text-center text-[11px] font-medium text-slate-700 group-hover:text-blue-600">ページ ${pageData.pageNumber}</div>
        `;
        thumbItem.dataset.pageIndex = String(pageIdx);
        thumbItem.addEventListener('click', (e) => {
          appState.activePageIndex = pageIdx;
          if (window.PdfTools) PdfTools.onThumbClick(pageIdx, e);
          pageEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
        thumbnailList.appendChild(thumbItem);
      });

      applyZoom();
      if (typeof lucide !== 'undefined') lucide.createIcons();
      if (window.PdfTools) PdfTools.afterRender();
    }

    // Create a Unified Word-like Document Element where ALL lines on the page are edited as a single article
    function createUnifiedDocumentElement(docBlock) {
      const wrapper = document.createElement('div');
      wrapper.className = 'editable-item unified-doc-block masked-bg';
      wrapper.style.left = `${docBlock.x}px`;
      wrapper.style.top = `${docBlock.y}px`;
      wrapper.style.width = `${docBlock.w}px`;
      wrapper.style.fontSize = '14px';
      wrapper.style.color = '#0f172a';

      // Drag Handle (kept outside editable-content so Ctrl+A / Backspace never deletes the handle)
      const handle = document.createElement('div');
      handle.className = 'drag-handle';
      handle.contentEditable = 'false';
      handle.innerHTML = `<span>⋮⋮ 全文テキスト領域を移動 (自由に改行・部分装飾可)</span>`;
      wrapper.appendChild(handle);

      // Single continuous contentEditable container for all lines
      const contentArea = document.createElement('div');
      contentArea.className = 'editable-content';
      contentArea.contentEditable = 'true';
      contentArea.spellcheck = false;

      docBlock.lines.forEach(line => {
        const lineDiv = document.createElement('div');
        lineDiv.className = 'doc-line';
        if (line.marginTop > 0) {
          lineDiv.style.marginTop = `${line.marginTop}px`;
        }
        if (line.indentPx > 0) {
          lineDiv.style.paddingLeft = `${line.indentPx}px`;
        }
        if (line.align && line.align !== 'left') {
          lineDiv.style.textAlign = line.align;
        }

        line.segments.forEach((seg, sIdx) => {
          const span = document.createElement('span');
          span.className = 'rt-styled doc-line-text';
          span.style.fontSize = `${seg.fontSize}px`;
          span.style.fontWeight = seg.fontWeight;
          span.style.color = seg.color;
          if (sIdx > 0 && seg.gapX > 0) {
            span.style.marginLeft = `${seg.gapX}px`;
          }
          span.textContent = seg.text;
          lineDiv.appendChild(span);
        });

        contentArea.appendChild(lineDiv);
      });

      // When pressing Enter inside a line with large marginTop (e.g. first line after a table),
      // prevent the newly created line from inheriting the large marginTop gap.
      contentArea.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          window.requestAnimationFrame(() => {
            const sel = window.getSelection();
            if (!sel || !sel.rangeCount) return;
            const node = sel.getRangeAt(0).startContainer;
            const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
            const curLine = el ? el.closest('.doc-line, div') : null;
            if (curLine && curLine.parentElement === contentArea && curLine.previousElementSibling) {
              const prev = curLine.previousElementSibling;
              if (prev.style && prev.style.marginTop && curLine.style.marginTop === prev.style.marginTop) {
                curLine.style.marginTop = '4px';
              }
            }
          });
        }
      });

      contentArea.addEventListener('mouseup', saveCurrentSelectionRange);
      contentArea.addEventListener('keyup', saveCurrentSelectionRange);

      wrapper.appendChild(contentArea);
      makeElementDraggable(wrapper, handle);
      bindElementSelection(wrapper, '全文統合テキスト (Wordライク編集)');

      return wrapper;
    }

    // Create an Individual Word-like Editable Text Element (used in Exact mode & "+ テキスト追加")
    function createEditableTextElement(block) {
      const wrapper = document.createElement('div');
      wrapper.className = 'editable-item masked-bg';
      wrapper.style.left = `${block.x}px`;
      wrapper.style.top = `${block.y}px`;
      wrapper.style.minWidth = `${Math.max(24, block.w)}px`;
      wrapper.style.fontSize = `${block.fontSize || 14}px`;
      wrapper.style.fontWeight = block.fontWeight || '400';
      wrapper.style.color = block.color || '#0f172a';
      if (block.align) wrapper.style.textAlign = block.align;

      // Drag Handle (non-editable sibling of editable-content)
      const handle = document.createElement('div');
      handle.className = 'drag-handle';
      handle.contentEditable = 'false';
      handle.innerHTML = `<span>⋮⋮ 移動</span>`;
      wrapper.appendChild(handle);

      // Editable Content Container
      const contentArea = document.createElement('div');
      contentArea.className = 'editable-content';
      contentArea.contentEditable = 'true';
      contentArea.spellcheck = false;

      const textSpan = document.createElement('span');
      textSpan.className = 'rt-styled';
      textSpan.textContent = block.text;
      contentArea.appendChild(textSpan);

      contentArea.addEventListener('mouseup', saveCurrentSelectionRange);
      contentArea.addEventListener('keyup', saveCurrentSelectionRange);

      wrapper.appendChild(contentArea);
      makeElementDraggable(wrapper, handle);
      bindElementSelection(wrapper, 'テキストブロック');

      return wrapper;
    }

    // Create an Interactive Word-like HTML Table Element
    function createEditableTableElement(tableObj) {
      const wrapper = document.createElement('div');
      wrapper.className = 'editable-table-wrapper';
      wrapper.style.left = `${tableObj.x}px`;
      wrapper.style.top = `${tableObj.y}px`;
      wrapper.style.width = `${Math.max(220, tableObj.w)}px`;

      // Drag handle for table
      const handle = document.createElement('div');
      handle.className = 'drag-handle';
      handle.contentEditable = 'false';
      handle.innerHTML = `<span>⋮⋮ 表を移動 (セル内直接編集可)</span>`;
      wrapper.appendChild(handle);

      const table = document.createElement('table');
      table.className = 'editable-table';

      // Estimate column widths from first row if available
      const firstRow = tableObj.rows[0] || [];
      const totalWidth = tableObj.w || 600;

      tableObj.rows.forEach((rowCells, rIdx) => {
        const tr = document.createElement('tr');
        for (let cIdx = 0; cIdx < tableObj.colCount; cIdx++) {
          const cellData = rowCells[cIdx] || { text: '' };
          const td = document.createElement('td');
          td.contentEditable = 'true';
          td.spellcheck = false;
          td.textContent = cellData.text || '';

          if (rIdx === 0) {
            td.style.backgroundColor = '#f1f5f9';
            td.style.fontWeight = '700';
            if (firstRow[cIdx] && firstRow[cIdx].w) {
              const pct = Math.max(7, Math.round((firstRow[cIdx].w / totalWidth) * 100));
              td.style.width = `${pct}%`;
            }
          }
          // Right-align numeric/currency cells automatically
          if (/^[0-9,¥-]+$/.test((cellData.text || '').trim()) && cIdx > 0) {
            td.style.textAlign = 'right';
          }

          td.addEventListener('mouseup', saveCurrentSelectionRange);
          td.addEventListener('keyup', saveCurrentSelectionRange);
          tr.appendChild(td);
        }
        table.appendChild(tr);
      });

      wrapper.appendChild(table);
      makeElementDraggable(wrapper, handle);
      bindElementSelection(wrapper, '編集可能な表 (Table)');

      return wrapper;
    }

    // Create Japanese Hanko / Stamp Widget
    function createHankoStampElement(topText, bottomText, x = 580, y = 160) {
      const widget = document.createElement('div');
      widget.className = 'floating-widget';
      widget.style.left = `${x}px`;
      widget.style.top = `${y}px`;

      const handle = document.createElement('div');
      handle.className = 'drag-handle';
      handle.innerHTML = `<span>⋮⋮ 印鑑移動</span>`;
      widget.appendChild(handle);

      const stamp = document.createElement('div');
      stamp.className = 'hanko-stamp';
      stamp.contentEditable = 'true';
      stamp.spellcheck = false;
      const topLabel = document.createElement('div');
      topLabel.className = 'text-[11px] border-b border-red-600 pb-0.5 px-1';
      topLabel.textContent = String(topText ?? '');
      const bottomLabel = document.createElement('div');
      bottomLabel.className = 'text-[14px] pt-0.5';
      bottomLabel.textContent = String(bottomText ?? '');
      stamp.append(topLabel, bottomLabel);
      widget.appendChild(stamp);

      makeElementDraggable(widget, handle);
      makeElementDraggable(widget, stamp);
      bindElementSelection(widget, '電子印鑑スタンプ');

      return widget;
    }

    // Create Decorative Box / Whiteout Mask Element
    function createDecorativeBoxElement(x = 120, y = 260) {
      const box = document.createElement('div');
      box.className = 'editable-item masked-bg';
      box.style.left = `${x}px`;
      box.style.top = `${y}px`;
      box.style.width = '260px';
      box.style.minHeight = '64px';
      box.style.padding = '10px 14px';
      box.style.border = '2px solid #1e40af';
      box.style.backgroundColor = '#ffffff';
      box.style.fontSize = '14px';

      const handle = document.createElement('div');
      handle.className = 'drag-handle';
      handle.contentEditable = 'false';
      handle.innerHTML = `<span>⋮⋮ 枠を移動</span>`;
      box.appendChild(handle);

      const contentArea = document.createElement('div');
      contentArea.className = 'editable-content';
      contentArea.contentEditable = 'true';
      contentArea.spellcheck = false;

      const span = document.createElement('span');
      span.className = 'rt-styled';
      span.textContent = '装飾枠・白塗りマスク（文字入力やサイズ変更が可能です）';
      contentArea.appendChild(span);

      contentArea.addEventListener('mouseup', saveCurrentSelectionRange);
      contentArea.addEventListener('keyup', saveCurrentSelectionRange);

      box.appendChild(contentArea);

      makeElementDraggable(box, handle);
      bindElementSelection(box, '装飾ボックス / 白消しマスク');
      return box;
    }

    // =========================================================================
    // 5. DRAG-AND-DROP & ELEMENT SELECTION / INSPECTOR BINDING
    // =========================================================================
    function makeElementDraggable(element, handleEl) {
      handleEl.style.touchAction = 'none';
      handleEl.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 || dragState) return;
        dragState = {
          element,
          pointerId: e.pointerId,
          startX: e.clientX,
          startY: e.clientY,
          origLeft: parseFloat(element.style.left) || 0,
          origTop: parseFloat(element.style.top) || 0
        };
        if (handleEl.setPointerCapture) handleEl.setPointerCapture(e.pointerId);
        selectElement(element);
        e.stopPropagation();
        e.preventDefault();
      });
    }

    window.addEventListener('pointermove', (e) => {
      if (!dragState || e.pointerId !== dragState.pointerId) return;
      const dx = (e.clientX - dragState.startX) / appState.zoom;
      const dy = (e.clientY - dragState.startY) / appState.zoom;
      dragState.element.style.left = `${Math.round(dragState.origLeft + dx)}px`;
      dragState.element.style.top = `${Math.round(dragState.origTop + dy)}px`;
      updateInspectorInputs(dragState.element);
    });

    function stopDragging(e) {
      if (dragState && (!e || e.pointerId === dragState.pointerId)) dragState = null;
    }
    window.addEventListener('pointerup', stopDragging);
    window.addEventListener('pointercancel', stopDragging);

    function bindElementSelection(element, typeLabel) {
      element.dataset.typeLabel = typeLabel;
      element.addEventListener('mousedown', (e) => {
        selectElement(element);
        e.stopPropagation();
      });
      element.addEventListener('focusin', () => {
        selectElement(element);
      });
    }

    function selectElement(element) {
      if (appState.selectedElement && appState.selectedElement !== element) {
        appState.selectedElement.classList.remove('active-element');
      }
      appState.selectedElement = element;
      if (!element) {
        noSelectionMsg.classList.remove('hidden');
        selectionControls.classList.add('hidden');
        tableContextTools.classList.add('hidden');
        tableContextTools.classList.remove('flex');
        return;
      }

      element.classList.add('active-element');
      noSelectionMsg.classList.add('hidden');
      selectionControls.classList.remove('hidden');

      document.getElementById('selectedTypeBadge').textContent = element.dataset.typeLabel || '編集要素';

      // Show or hide contextual table buttons
      if (element.classList.contains('editable-table-wrapper')) {
        tableContextTools.classList.remove('hidden');
        tableContextTools.classList.add('flex');
      } else {
        tableContextTools.classList.add('hidden');
        tableContextTools.classList.remove('flex');
      }

      updateInspectorInputs(element);
    }

    function updateInspectorInputs(el) {
      if (!el) return;
      document.getElementById('propX').value = Math.round(parseFloat(el.style.left) || 0);
      document.getElementById('propY').value = Math.round(parseFloat(el.style.top) || 0);
      document.getElementById('propW').value = Math.round(el.offsetWidth || 100);

      const computed = window.getComputedStyle(el);
      const fontSize = parseInt(computed.fontSize, 10) || 14;
      const fontSizeInput = document.getElementById('fontSizeInput');
      if (document.activeElement !== fontSizeInput) {
        fontSizeInput.value = fontSize;
      }
      document.getElementById('propMaskBg').checked = el.classList.contains('masked-bg');
    }

    // Deselect when clicking empty workspace
    workspaceViewport.addEventListener('mousedown', (e) => {
      if (e.target === workspaceViewport || e.target === pagesContainer || e.target.classList.contains('pdf-page-container')) {
        selectElement(null);
        appState.savedRange = null;
      }
    });

    // =========================================================================
    // 6. TOOLBAR & INSPECTOR ACTIONS (WITH PARTIAL SELECTION SUPPORT)
    // =========================================================================

    // Mode Switching (Smart Unified Reconstruction vs Exact Overlay)
    const modeHybridBtn = document.getElementById('modeHybridBtn');
    const modeExactBtn = document.getElementById('modeExactBtn');

    modeHybridBtn.addEventListener('click', () => {
      if (window.PdfTools && !PdfTools.beforeModeSwitch()) return;
      appState.editMode = 'hybrid';
      modeHybridBtn.className = 'flex items-center gap-1.5 px-2.5 py-1 rounded-md font-medium bg-white text-blue-700 shadow-sm transition';
      modeExactBtn.className = 'flex items-center gap-1.5 px-2.5 py-1 rounded-md font-medium text-slate-600 hover:text-slate-900 transition';
      modeStatusText.textContent = '| モード: スマート再構築 (全文1文書統合・表の自動認識)';
      modeHybridBtn.setAttribute('aria-pressed', 'true');
      modeExactBtn.setAttribute('aria-pressed', 'false');
      renderAllPages();
    });

    modeExactBtn.addEventListener('click', () => {
      if (window.PdfTools && !PdfTools.beforeModeSwitch()) return;
      appState.editMode = 'exact';
      modeExactBtn.className = 'flex items-center gap-1.5 px-2.5 py-1 rounded-md font-medium bg-white text-blue-700 shadow-sm transition';
      modeHybridBtn.className = 'flex items-center gap-1.5 px-2.5 py-1 rounded-md font-medium text-slate-600 hover:text-slate-900 transition';
      modeStatusText.textContent = '| モード: 厳密レイアウト固定 (個別文字ブロック直接編集)';
      modeHybridBtn.setAttribute('aria-pressed', 'false');
      modeExactBtn.setAttribute('aria-pressed', 'true');
      renderAllPages();
    });

    // Prevent toolbar buttons from stealing selection focus when clicked
    ['btnBold', 'btnItalic', 'btnUnderline'].forEach(id => {
      const btn = document.getElementById(id);
      if (btn) {
        btn.addEventListener('mousedown', (e) => {
          saveCurrentSelectionRange();
          e.preventDefault();
        });
      }
    });
    document.querySelectorAll('.align-btn').forEach(btn => {
      btn.addEventListener('mousedown', (e) => {
        saveCurrentSelectionRange();
        e.preventDefault();
      });
    });

    // Typography Controls: Partial Selection or Block Styling
    document.getElementById('fontFamilySelect').addEventListener('change', (e) => {
      applyStyleToSelectionOrElement('fontFamily', e.target.value);
      if (appState.savedRange) restoreSelectionRange(appState.savedRange);
    });

    document.getElementById('fontSizeInput').addEventListener('input', (e) => {
      const val = parseInt(e.target.value, 10);
      if (!Number.isFinite(val) || val < 4 || val > 240) return;
      applyStyleToSelectionOrElement('fontSize', `${val}px`);
    });

    document.getElementById('fontSizeInput').addEventListener('change', () => {
      if (appState.savedRange) restoreSelectionRange(appState.savedRange);
    });

    document.getElementById('btnBold').addEventListener('click', () => {
      applyStyleToSelectionOrElement('fontWeight', '700', (computed) => {
        const w = computed.fontWeight;
        return (w === '700' || w === 'bold' || parseInt(w, 10) >= 600) ? '400' : '700';
      });
    });

    document.getElementById('btnItalic').addEventListener('click', () => {
      applyStyleToSelectionOrElement('fontStyle', 'italic', (computed) => {
        return computed.fontStyle === 'italic' ? 'normal' : 'italic';
      });
    });

    document.getElementById('btnUnderline').addEventListener('click', () => {
      applyStyleToSelectionOrElement('textDecoration', 'underline', (computed) => {
        const dec = computed.textDecorationLine || computed.textDecoration || '';
        return dec.includes('underline') ? 'none' : 'underline';
      });
    });

    document.getElementById('textColorPicker').addEventListener('input', (e) => {
      applyStyleToSelectionOrElement('color', e.target.value);
    });

    document.getElementById('bgColorPicker').addEventListener('input', (e) => {
      applyStyleToSelectionOrElement('backgroundColor', e.target.value);
    });

    document.querySelectorAll('.align-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const alignVal = btn.dataset.align;
        const range = getActiveRangeForStyling() || appState.savedRange;
        if (range && appState.selectedElement && appState.selectedElement.classList.contains('unified-doc-block')) {
          const startNode = range.startContainer.nodeType === Node.ELEMENT_NODE
            ? range.startContainer
            : range.startContainer.parentElement;
          const lineEl = startNode ? startNode.closest('.doc-line') : null;
          if (lineEl) {
            lineEl.style.textAlign = alignVal;
            return;
          }
        }
        if (appState.selectedElement) {
          appState.selectedElement.style.textAlign = alignVal;
        }
      });
    });

    // Insert Elements onto Current Page
    function getActivePageContainer() {
      const pages = document.querySelectorAll('.pdf-page-container');
      return pages[appState.activePageIndex] || pages[0];
    }

    document.getElementById('btnAddText').addEventListener('click', () => {
      const pageEl = getActivePageContainer();
      if (!pageEl) return;
      const newText = createEditableTextElement({
        text: '新しいテキストを入力してください',
        x: 120,
        y: 220,
        w: 240,
        fontSize: 15,
        fontWeight: '500',
        color: '#0f172a'
      });
      pageEl.appendChild(newText);
      selectElement(newText);
      const editable = newText.querySelector('.editable-content') || newText;
      editable.focus();
    });

    document.getElementById('btnAddTable').addEventListener('click', () => {
      const pageEl = getActivePageContainer();
      if (!pageEl) return;
      const newTable = createEditableTableElement({
        x: 100,
        y: 320,
        w: 520,
        colCount: 4,
        rows: [
          [{ text: '項目名' }, { text: '内容・仕様' }, { text: '数量' }, { text: '金額' }],
          [{ text: '新規項目 1' }, { text: '詳細を入力' }, { text: '1 式' }, { text: '100,000' }],
          [{ text: '新規項目 2' }, { text: '詳細を入力' }, { text: '1 式' }, { text: '50,000' }]
        ]
      });
      pageEl.appendChild(newTable);
      selectElement(newTable);
    });

    document.getElementById('btnAddBox').addEventListener('click', () => {
      const pageEl = getActivePageContainer();
      if (!pageEl) return;
      const box = createDecorativeBoxElement(140, 260);
      pageEl.appendChild(box);
      selectElement(box);
    });

    document.getElementById('btnAddStamp').addEventListener('click', () => {
      const pageEl = getActivePageContainer();
      if (!pageEl) return;
      const topTxt = document.getElementById('stampTopText').value || '承認済';
      const botTxt = document.getElementById('stampBottomText').value || '佐藤';
      const stamp = createHankoStampElement(topTxt, botTxt, 560, 180);
      pageEl.appendChild(stamp);
      selectElement(stamp);
    });

    document.getElementById('btnCreateCustomStamp').addEventListener('click', () => {
      document.getElementById('btnAddStamp').click();
    });

    // Table Row / Column Manipulation
    document.getElementById('btnTableAddRow').addEventListener('click', () => {
      if (!appState.selectedElement) return;
      const table = appState.selectedElement.querySelector('table');
      if (!table) return;
      const colCount = table.rows[0] ? table.rows[0].cells.length : 3;
      const tr = table.insertRow(-1);
      for (let i = 0; i < colCount; i++) {
        const td = tr.insertCell(-1);
        td.contentEditable = 'true';
        td.spellcheck = false;
        td.textContent = '';
        td.addEventListener('mouseup', saveCurrentSelectionRange);
        td.addEventListener('keyup', saveCurrentSelectionRange);
      }
    });

    document.getElementById('btnTableDelRow').addEventListener('click', () => {
      if (!appState.selectedElement) return;
      const table = appState.selectedElement.querySelector('table');
      if (table && table.rows.length > 1) {
        table.deleteRow(-1);
      }
    });

    document.getElementById('btnTableAddCol').addEventListener('click', () => {
      if (!appState.selectedElement) return;
      const table = appState.selectedElement.querySelector('table');
      if (!table) return;
      Array.from(table.rows).forEach((tr, rIdx) => {
        const td = tr.insertCell(-1);
        td.contentEditable = 'true';
        td.spellcheck = false;
        td.textContent = rIdx === 0 ? '新規列' : '';
        if (rIdx === 0) {
          td.style.backgroundColor = '#f1f5f9';
          td.style.fontWeight = '700';
        }
        td.addEventListener('mouseup', saveCurrentSelectionRange);
        td.addEventListener('keyup', saveCurrentSelectionRange);
      });
    });

    document.getElementById('btnTableDelCol').addEventListener('click', () => {
      if (!appState.selectedElement) return;
      const table = appState.selectedElement.querySelector('table');
      if (!table || !table.rows[0] || table.rows[0].cells.length <= 1) return;
      Array.from(table.rows).forEach(tr => tr.deleteCell(-1));
    });

    // Inspector Property Bindings
    document.getElementById('propX').addEventListener('input', (e) => {
      if (appState.selectedElement) appState.selectedElement.style.left = `${e.target.value}px`;
    });
    document.getElementById('propY').addEventListener('input', (e) => {
      if (appState.selectedElement) appState.selectedElement.style.top = `${e.target.value}px`;
    });
    document.getElementById('propW').addEventListener('input', (e) => {
      if (appState.selectedElement) appState.selectedElement.style.width = `${e.target.value}px`;
    });
    document.getElementById('propLineHeight').addEventListener('input', (e) => {
      if (appState.selectedElement) appState.selectedElement.style.lineHeight = e.target.value;
    });
    document.getElementById('propMaskBg').addEventListener('change', (e) => {
      if (!appState.selectedElement) return;
      const isUnified = appState.selectedElement.classList.contains('unified-doc-block');
      if (e.target.checked) {
        appState.selectedElement.classList.add('masked-bg');
        if (!isUnified) appState.selectedElement.style.backgroundColor = '#ffffff';
      } else {
        appState.selectedElement.classList.remove('masked-bg');
        appState.selectedElement.style.backgroundColor = 'transparent';
      }
    });
    document.getElementById('propBorderStyle').addEventListener('change', (e) => {
      if (appState.selectedElement) appState.selectedElement.style.border = e.target.value;
    });
    document.getElementById('propPadding').addEventListener('input', (e) => {
      if (appState.selectedElement) appState.selectedElement.style.padding = `${e.target.value}px`;
    });

    // Duplicate & Bring to Front & Delete
    document.getElementById('btnDuplicateElem').addEventListener('click', () => {
      if (!appState.selectedElement) return;
      const clone = appState.selectedElement.cloneNode(true);
      clone.style.left = `${(parseFloat(appState.selectedElement.style.left) || 0) + 20}px`;
      clone.style.top = `${(parseFloat(appState.selectedElement.style.top) || 0) + 20}px`;
      const handle = clone.querySelector('.drag-handle');
      if (handle) makeElementDraggable(clone, handle);
      const contentArea = clone.querySelector('.editable-content');
      if (contentArea) {
        contentArea.addEventListener('mouseup', saveCurrentSelectionRange);
        contentArea.addEventListener('keyup', saveCurrentSelectionRange);
      }
      bindElementSelection(clone, appState.selectedElement.dataset.typeLabel);
      appState.selectedElement.parentElement.appendChild(clone);
      selectElement(clone);
    });

    document.getElementById('btnBringFront').addEventListener('click', () => {
      if (appState.selectedElement) {
        appState.selectedElement.style.zIndex = '50';
      }
    });

    document.getElementById('btnDeleteSelected').addEventListener('click', () => {
      if (appState.selectedElement) {
        if (window.PdfTools) PdfTools.onBeforeDelete();
        appState.selectedElement.remove();
        selectElement(null);
        appState.savedRange = null;
      }
    });

    // View Controls: Guides, Background Opacity, Zoom
    document.getElementById('toggleGuides').addEventListener('change', (e) => {
      workspaceViewport.classList.toggle('show-guides', e.target.checked);
    });

    document.getElementById('bgOpacitySlider').addEventListener('input', (e) => {
      appState.bgOpacity = e.target.value / 100;
      document.querySelectorAll('.page-bg-image').forEach(img => {
        img.style.opacity = appState.bgOpacity;
      });
    });

    function applyZoom() {
      document.getElementById('zoomLevelText').textContent = `${Math.round(appState.zoom * 100)}%`;
      document.querySelectorAll('.pdf-page-container').forEach(pageEl => {
        pageEl.style.transform = `scale(${appState.zoom})`;
        const baseH = parseFloat(pageEl.style.height) || 1123;
        const diff = baseH * (appState.zoom - 1);
        pageEl.style.marginBottom = `${32 + diff}px`;
      });
    }

    document.getElementById('btnZoomIn').addEventListener('click', () => {
      appState.zoom = Math.min(2.0, +(appState.zoom + 0.1).toFixed(2));
      applyZoom();
    });
    document.getElementById('btnZoomOut').addEventListener('click', () => {
      appState.zoom = Math.max(0.5, +(appState.zoom - 0.1).toFixed(2));
      applyZoom();
    });
    document.getElementById('btnZoomReset').addEventListener('click', () => {
      appState.zoom = 1.0;
      applyZoom();
    });

    // =========================================================================
    // 7. HIGH-FIDELITY CLIENT-SIDE PDF & WORD (.DOC) EXPORT
    // =========================================================================
    document.getElementById('btnExportPDF').addEventListener('click', async () => {
      const pageElements = document.querySelectorAll('.pdf-page-container');
      if (!pageElements.length) return;

      setStatus('編集内容を反映した高解像度PDFを生成中...', true);
      selectElement(null);

      // Temporarily reset zoom and hide UI handles for crisp capture
      const prevZoom = appState.zoom;
      appState.zoom = 1.0;
      applyZoom();
      document.body.classList.add('exporting-clean');

      try {
        if (typeof html2canvas !== 'function' || !window.jspdf || !window.jspdf.jsPDF) {
          throw new Error('PDF出力ライブラリを読み込めません。ネットワーク接続を確認してください。');
        }
        const { jsPDF } = window.jspdf;
        let pdf = null;

        for (let i = 0; i < pageElements.length; i++) {
          const pageEl = pageElements[i];
          const w = pageEl.offsetWidth;
          const h = pageEl.offsetHeight;
          const orientation = w > h ? 'l' : 'p';

          let canvas = null;
          try {
            canvas = await html2canvas(pageEl, {
              scale: 2,
              useCORS: true,
              backgroundColor: '#ffffff',
              logging: false
            });
            const imgData = canvas.toDataURL('image/jpeg', 0.95);

            if (i === 0) {
              pdf = new jsPDF({
                orientation,
                unit: 'px',
                format: [w, h]
              });
            } else {
              pdf.addPage([w, h], orientation);
            }
            pdf.addImage(imgData, 'JPEG', 0, 0, w, h);
          } finally {
            if (canvas) {
              canvas.width = 0;
              canvas.height = 0;
            }
          }
        }

        pdf.save('edited-document.pdf');
        setStatus('PDFファイルの保存処理を完了しました。');
      } catch (err) {
        console.error('PDF Export Error:', err);
        setStatus('PDF出力中にエラーが発生しました。');
      } finally {
        document.body.classList.remove('exporting-clean');
        appState.zoom = prevZoom;
        applyZoom();
      }
    });

    function escapeHtml(value) {
      return String(value).replace(/[&<>"']/g, char => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
      })[char]);
    }

    // Safely serialize rich-text nodes (preserving partial font-family, font-size, bold, italic, underline, color, and line breaks)
    function serializeRichNodeToSafeHtml(node) {
      if (!node) return '';
      if (node.nodeType === Node.TEXT_NODE) {
        return escapeHtml(node.nodeValue || '');
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return '';

      const el = node;
      if (el.classList.contains('drag-handle')) return '';

      const tag = el.tagName.toLowerCase();
      if (tag === 'br') return '<br/>';

      const allowedStyles = [];
      const st = el.style;
      if (st) {
        if (st.fontFamily) allowedStyles.push(`font-family:${escapeHtml(st.fontFamily)}`);
        if (st.fontSize) allowedStyles.push(`font-size:${escapeHtml(st.fontSize)}`);
        if (st.fontWeight) allowedStyles.push(`font-weight:${escapeHtml(st.fontWeight)}`);
        if (st.fontStyle) allowedStyles.push(`font-style:${escapeHtml(st.fontStyle)}`);
        if (st.textDecoration || st.textDecorationLine) {
          allowedStyles.push(`text-decoration:${escapeHtml(st.textDecoration || st.textDecorationLine)}`);
        }
        if (st.color) allowedStyles.push(`color:${escapeHtml(st.color)}`);
        if (st.backgroundColor && st.backgroundColor !== 'transparent') {
          allowedStyles.push(`background-color:${escapeHtml(st.backgroundColor)}`);
        }
        if (st.textAlign) allowedStyles.push(`text-align:${escapeHtml(st.textAlign)}`);
        if (st.paddingLeft) allowedStyles.push(`padding-left:${escapeHtml(st.paddingLeft)}`);
        if (st.marginLeft) allowedStyles.push(`margin-left:${escapeHtml(st.marginLeft)}`);
      }
      const styleAttr = allowedStyles.length ? ` style="${allowedStyles.join(';')}"` : '';

      let inner = '';
      for (const child of el.childNodes) {
        inner += serializeRichNodeToSafeHtml(child);
      }

      if (tag === 'div' || tag === 'p') {
        return `<p${styleAttr}>${inner || '<br/>'}</p>`;
      }
      if (tag === 'b' || tag === 'strong' || tag === 'i' || tag === 'em' || tag === 'u') {
        return `<${tag}${styleAttr}>${inner}</${tag}>`;
      }
      return styleAttr ? `<span${styleAttr}>${inner}</span>` : inner;
    }

    // Export as Word-compatible .doc file (Preserves tables, line breaks, and partial inline font/size formatting)
    document.getElementById('btnExportWord').addEventListener('click', () => {
      const pageElements = document.querySelectorAll('.pdf-page-container');
      if (!pageElements.length) return;

      setStatus('Microsoft Word互換ドキュメント (.doc) を生成中...', true);
      selectElement(null);

      let wordHtml = `
        <html xmlns:o='urn:schemas-microsoft-com:office:office' xmlns:w='urn:schemas-microsoft-com:office:word' xmlns='http://www.w3.org/TR/REC-html40'>
        <head><meta charset='utf-8'><title>Exported Document</title>
        <style>
          body { font-family: 'Noto Sans JP', 'Meiryo', 'MS PGothic', sans-serif; }
          table { border-collapse: collapse; width: 100%; margin: 12pt 0; }
          td, th { border: 1pt solid #334155; padding: 6pt; font-size: 10.5pt; }
          p { margin: 3pt 0; line-height: 1.35; }
        </style>
        </head><body>
      `;

      pageElements.forEach((pageEl, idx) => {
        if (idx > 0) wordHtml += `<br clear="all" style="page-break-before:always" />`;

        const children = Array.from(pageEl.querySelectorAll('.editable-item, .editable-table-wrapper'));
        children.sort((a, b) => (parseFloat(a.style.top) || 0) - (parseFloat(b.style.top) || 0));

        children.forEach(el => {
          if (el.classList.contains('editable-table-wrapper')) {
            const tbl = el.querySelector('table');
            if (tbl) {
              const rows = Array.from(tbl.rows).map(row => {
                const cells = Array.from(row.cells).map(cell =>
                  `<td>${serializeRichNodeToSafeHtml(cell)}</td>`
                ).join('');
                return `<tr>${cells}</tr>`;
              }).join('');
              wordHtml += `<table>${rows}</table>`;
            }
          } else {
            const contentRoot = el.querySelector('.editable-content') || el;
            const richHtml = serializeRichNodeToSafeHtml(contentRoot);
            if (richHtml.trim()) {
              wordHtml += `<div>${richHtml}</div>`;
            }
          }
        });
      });

      wordHtml += `</body></html>`;

      const blob = new Blob(['\ufeff', wordHtml], { type: 'application/msword' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'edited-document.doc';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);

      setStatus('Word形式 (.doc) のダウンロードを開始しました。');
    });

    // =========================================================================
    // 8. FILE UPLOAD, DRAG & DROP, AND MODAL EVENTS
    // =========================================================================
    document.getElementById('pdfUploadInput').addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      e.target.value = '';
      if (file) handlePdfFileUpload(file);
    });

    document.getElementById('btnLoadSample').addEventListener('click', () => {
      loadRealisticSampleDocument();
    });

    // Drag & Drop PDF anywhere on window
    const dropZoneOverlay = document.getElementById('dropZoneOverlay');
    window.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (e.dataTransfer.types.includes('Files')) {
        dropZoneOverlay.classList.remove('hidden');
        dropZoneOverlay.classList.add('flex');
      }
    });
    window.addEventListener('dragleave', (e) => {
      if (e.relatedTarget === null) {
        dropZoneOverlay.classList.add('hidden');
        dropZoneOverlay.classList.remove('flex');
      }
    });
    window.addEventListener('drop', (e) => {
      e.preventDefault();
      dropZoneOverlay.classList.add('hidden');
      dropZoneOverlay.classList.remove('flex');
      const file = e.dataTransfer.files && e.dataTransfer.files[0];
      if (file && (file.type === 'application/pdf' || /\.pdf$/i.test(file.name))) {
        handlePdfFileUpload(file);
      } else if (file) {
        setStatus('PDFファイルをドロップしてください。');
      }
    });

    // Boot with realistic Japanese Sample Document immediately so the user can test right away
    window.addEventListener('DOMContentLoaded', () => {
      loadRealisticSampleDocument();
    });
