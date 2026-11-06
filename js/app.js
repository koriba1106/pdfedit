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
      editMode: 'hybrid', // 'hybrid' (Smart Paragraph & Table Reconstruction) or 'exact' (Strict block-by-block overlay)
      zoom: 1.0,
      bgOpacity: 1.0,
      selectedElement: null,
      activePageIndex: 0
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
    // 1. SAMPLE BUSINESS PDF GENERATOR (Japanese Invoice / Proposal with Table & Decorations)
    //    Allows immediate testing of PDF layout preservation & table editing!
    // =========================================================================
    async function loadRealisticSampleDocument() {
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
        { text: '納期：ご発注後 約3週間　／　お支払条件：検収月末締め翌月末現金振込　／　有効期限：発行日より30日間', x: 60, y: 370, w: 660, h: 20, fontSize: 12, fontWeight: '400', color: '#475569' },

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
        { text: '1. 本サンプルはブラウザ上で直接編集可能です。文字をクリックして金額や宛名を書き換えてみてください。', x: 75, y: 835, w: 630, h: 20, fontSize: 13, fontWeight: '400', color: '#334155' },
        { text: '2. 上記の明細表は自動的にHTMLの表（<table>）として再構築されています。セル内の編集や行・列の追加が可能です。', x: 75, y: 862, w: 630, h: 20, fontSize: 13, fontWeight: '400', color: '#334155' },
        { text: '3. お手元のPDFファイルを画面にドラッグ＆ドロップすると、同様にレイアウトを保持して直接編集できます。', x: 75, y: 889, w: 630, h: 20, fontSize: 13, fontWeight: '400', color: '#334155' },
        { text: '4. 編集後は右上の「PDFとして保存」または「Word (.doc) 出力」からいつでもダウンロードできます。', x: 75, y: 916, w: 630, h: 20, fontSize: 13, fontWeight: '400', color: '#334155' }
      ];

      selectElement(null);
      appState.activePageIndex = 0;
      appState.pagesData = [{
        pageNumber: 1,
        width: pageWidth,
        height: pageHeight,
        bgDataUrl: bgDataUrl,
        rawItems: rawItems,
        hasSampleStamp: true
      }];

      renderAllPages();
      setStatus('サンプル御見積書を読み込みました — 任意の文字や表のセルをクリックして直接編集できます');
    }

    // =========================================================================
    // 2. REAL PDF FILE PARSER (PDF.js)
    //    Extracts page background image + text coordinates, font sizes & styles
    // =========================================================================
    async function handlePdfFileUpload(file) {
      if (!file) return;
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

              rawItems.push({
                text: item.str,
                x: Math.round(x),
                y: Math.round(y),
                w: Math.round(w),
                h: Math.round(h),
                fontSize: Math.max(9, Math.round(fontHeight * 0.92)),
                fontWeight: isBold ? '700' : '400',
                color: '#0f172a'
              });
            }

            nextPagesData.push({
              pageNumber: pageNum,
              width: Math.round(viewport.width),
              height: Math.round(viewport.height),
              bgDataUrl,
              rawItems,
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
        selectElement(null);
        renderAllPages();
        if (previousPdf) {
          try { await previousPdf.destroy(); } catch (error) { console.warn('Previous PDF cleanup:', error); }
        }
        setStatus(`「${file.name}」(${appState.pagesData.length}ページ) の再構築が完了しました。直接編集できます。`);
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
    // 3. SMART LAYOUT RECONSTRUCTION ENGINE (Table & Line Grouping Algorithm)
    // =========================================================================
    function analyzeAndReconstructLayout(rawItems) {
      if (appState.editMode === 'exact') {
        // Exact mode: keep every text fragment at its exact coordinate without merging into tables
        return {
          textBlocks: rawItems.map(item => ({ ...item })),
          tables: []
        };
      }

      // Hybrid Smart Mode:
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
          // Merge adjacent words on the same line if gap is small (< 14px) and not explicitly marked as table columns
          if (prev && !item.isTableCandidate && (item.x - (prev.x + prev.w)) < 14 && Math.abs(prev.fontSize - item.fontSize) <= 2) {
            prev.text += item.text;
            prev.w = Math.max(prev.w, (item.x + item.w) - prev.x);
          } else {
            mergedCells.push({ ...item });
          }
        }
        return { y: row.y, cells: mergedCells };
      });

      // Step 3: Detect consecutive multi-column rows that form a Table Grid
      const tables = [];
      const textBlocks = [];

      let currentTableRows = [];

      function flushCurrentTable() {
        if (currentTableRows.length >= 3) {
          // Build a structured table object
          const minX = Math.min(...currentTableRows.flatMap(r => r.cells.map(c => c.x)));
          const maxX = Math.max(...currentTableRows.flatMap(r => r.cells.map(c => c.x + c.w)));
          const minY = currentTableRows[0].y;
          const lastRow = currentTableRows[currentTableRows.length - 1];
          const maxH = Math.max(...lastRow.cells.map(c => c.h || 24));
          const maxY = lastRow.y + maxH;

          // Determine maximum column count
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
          // Not enough rows for a table; release back as normal editable text blocks
          for (const r of currentTableRows) {
            for (const c of r.cells) {
              textBlocks.push(c);
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
            for (const c of row.cells) {
              textBlocks.push(c);
            }
          }
        }
      }
      flushCurrentTable();

      return { textBlocks, tables };
    }

    // =========================================================================
    // 4. DOM RENDERER: Creates Interactive Pages, Masked Text Blocks & HTML Tables
    // =========================================================================
    function renderAllPages() {
      if (appState.selectedElement) selectElement(null);
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

        // 3. Reconstruct Layout (Text Blocks + Auto-Detected Tables)
        const { textBlocks, tables } = analyzeAndReconstructLayout(pageData.rawItems);

        // Render Editable Text Blocks
        textBlocks.forEach(block => {
          const textEl = createEditableTextElement(block);
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
        thumbItem.addEventListener('click', () => {
          appState.activePageIndex = pageIdx;
          pageEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
        thumbnailList.appendChild(thumbItem);
      });

      applyZoom();
      if (typeof lucide !== 'undefined') lucide.createIcons();
    }

    // Create a Word-like Editable Text Element
    function createEditableTextElement(block) {
      const wrapper = document.createElement('div');
      wrapper.className = 'editable-item masked-bg';
      wrapper.contentEditable = 'true';
      wrapper.spellcheck = false;
      wrapper.style.left = `${block.x}px`;
      wrapper.style.top = `${block.y}px`;
      wrapper.style.minWidth = `${Math.max(24, block.w)}px`;
      wrapper.style.fontSize = `${block.fontSize || 14}px`;
      wrapper.style.fontWeight = block.fontWeight || '400';
      wrapper.style.color = block.color || '#0f172a';
      if (block.align) wrapper.style.textAlign = block.align;

      // Text Span
      const textSpan = document.createElement('span');
      textSpan.textContent = block.text;
      wrapper.appendChild(textSpan);

      // Drag Handle (non-editable)
      const handle = document.createElement('div');
      handle.className = 'drag-handle';
      handle.contentEditable = 'false';
      handle.innerHTML = `<span>⋮⋮ 移動</span>`;
      wrapper.appendChild(handle);

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
      box.contentEditable = 'true';
      box.style.left = `${x}px`;
      box.style.top = `${y}px`;
      box.style.width = '260px';
      box.style.minHeight = '64px';
      box.style.padding = '10px 14px';
      box.style.border = '2px solid #1e40af';
      box.style.backgroundColor = '#ffffff';
      box.style.fontSize = '14px';

      const span = document.createElement('span');
      span.textContent = '装飾枠・白塗りマスク（文字入力やサイズ変更が可能です）';
      box.appendChild(span);

      const handle = document.createElement('div');
      handle.className = 'drag-handle';
      handle.contentEditable = 'false';
      handle.innerHTML = `<span>⋮⋮ 枠を移動</span>`;
      box.appendChild(handle);

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
      document.getElementById('fontSizeInput').value = fontSize;
      document.getElementById('propMaskBg').checked = el.classList.contains('masked-bg');
    }

    // Deselect when clicking empty workspace
    workspaceViewport.addEventListener('mousedown', (e) => {
      if (e.target === workspaceViewport || e.target === pagesContainer || e.target.classList.contains('pdf-page-container')) {
        selectElement(null);
      }
    });

    // =========================================================================
    // 6. TOOLBAR & INSPECTOR ACTIONS
    // =========================================================================

    // Mode Switching (Smart Reconstruction vs Exact Overlay)
    const modeHybridBtn = document.getElementById('modeHybridBtn');
    const modeExactBtn = document.getElementById('modeExactBtn');

    modeHybridBtn.addEventListener('click', () => {
      appState.editMode = 'hybrid';
      modeHybridBtn.className = 'flex items-center gap-1.5 px-2.5 py-1 rounded-md font-medium bg-white text-blue-700 shadow-sm transition';
      modeExactBtn.className = 'flex items-center gap-1.5 px-2.5 py-1 rounded-md font-medium text-slate-600 hover:text-slate-900 transition';
      modeStatusText.textContent = '| モード: スマート再構築 (表・段落の自動認識)';
      modeHybridBtn.setAttribute('aria-pressed', 'true');
      modeExactBtn.setAttribute('aria-pressed', 'false');
      renderAllPages();
    });

    modeExactBtn.addEventListener('click', () => {
      appState.editMode = 'exact';
      modeExactBtn.className = 'flex items-center gap-1.5 px-2.5 py-1 rounded-md font-medium bg-white text-blue-700 shadow-sm transition';
      modeHybridBtn.className = 'flex items-center gap-1.5 px-2.5 py-1 rounded-md font-medium text-slate-600 hover:text-slate-900 transition';
      modeStatusText.textContent = '| モード: 厳密レイアウト固定 (個別文字ブロック直接編集)';
      modeHybridBtn.setAttribute('aria-pressed', 'false');
      modeExactBtn.setAttribute('aria-pressed', 'true');
      renderAllPages();
    });

    // Typography Controls
    document.getElementById('fontFamilySelect').addEventListener('change', (e) => {
      if (appState.selectedElement) {
        appState.selectedElement.style.fontFamily = e.target.value;
      }
    });

    document.getElementById('fontSizeInput').addEventListener('input', (e) => {
      if (appState.selectedElement) {
        appState.selectedElement.style.fontSize = `${e.target.value}px`;
      }
    });

    document.getElementById('btnBold').addEventListener('click', () => {
      if (!appState.selectedElement) return;
      const cur = window.getComputedStyle(appState.selectedElement).fontWeight;
      appState.selectedElement.style.fontWeight = (cur === '700' || cur === 'bold') ? '400' : '700';
    });

    document.getElementById('btnItalic').addEventListener('click', () => {
      if (!appState.selectedElement) return;
      const cur = window.getComputedStyle(appState.selectedElement).fontStyle;
      appState.selectedElement.style.fontStyle = cur === 'italic' ? 'normal' : 'italic';
    });

    document.getElementById('btnUnderline').addEventListener('click', () => {
      if (!appState.selectedElement) return;
      const cur = window.getComputedStyle(appState.selectedElement).textDecorationLine;
      appState.selectedElement.style.textDecoration = cur.includes('underline') ? 'none' : 'underline';
    });

    document.getElementById('textColorPicker').addEventListener('input', (e) => {
      if (appState.selectedElement) {
        appState.selectedElement.style.color = e.target.value;
      }
    });

    document.getElementById('bgColorPicker').addEventListener('input', (e) => {
      if (appState.selectedElement) {
        appState.selectedElement.style.backgroundColor = e.target.value;
      }
    });

    document.querySelectorAll('.align-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        if (appState.selectedElement) {
          appState.selectedElement.style.textAlign = btn.dataset.align;
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
      newText.focus();
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
        td.textContent = '';
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
        td.textContent = rIdx === 0 ? '新規列' : '';
        if (rIdx === 0) {
          td.style.backgroundColor = '#f1f5f9';
          td.style.fontWeight = '700';
        }
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
      if (e.target.checked) {
        appState.selectedElement.classList.add('masked-bg');
        appState.selectedElement.style.backgroundColor = '#ffffff';
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
      bindElementSelection(clone, appState.selectedElement.dataset.typeLabel);
      appState.selectedElement.parentElement.appendChild(clone);
      selectElement(clone);
    });

    document.getElementById('btnBringFront').addEventListener('click', () => {
      if (appState.selectedElement) {
        appState.selectedElement.style.zIndex = '45';
      }
    });

    document.getElementById('btnDeleteSelected').addEventListener('click', () => {
      if (appState.selectedElement) {
        appState.selectedElement.remove();
        selectElement(null);
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
        // Adjust bottom margin so scaled pages don't overlap or leave huge gaps
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

    // Export as Word-compatible .doc file (Preserves tables and positioned paragraphs)
    document.getElementById('btnExportWord').addEventListener('click', () => {
      const pageElements = document.querySelectorAll('.pdf-page-container');
      if (!pageElements.length) return;

      setStatus('Microsoft Word互換ドキュメント (.doc) を生成中...', true);
      selectElement(null);

      let wordHtml = `
        <html xmlns:o='urn:schemas-microsoft-com:office:office' xmlns:w='urn:schemas-microsoft-com:office:word' xmlns='http://www.w3.org/TR/REC-html40'>
        <head><meta charset='utf-8'><title>Exported Document</title>
        <style>
          body { font-family: 'Meiryo', 'MS PGothic', sans-serif; }
          table { border-collapse: collapse; width: 100%; margin: 12pt 0; }
          td, th { border: 1pt solid #334155; padding: 6pt; font-size: 10.5pt; }
          p { margin: 4pt 0; }
        </style>
        </head><body>
      `;

      pageElements.forEach((pageEl, idx) => {
        if (idx > 0) wordHtml += `<br clear="all" style="page-break-before:always" />`;

        // Collect all editable items and tables sorted by vertical Y position
        const children = Array.from(pageEl.querySelectorAll('.editable-item, .editable-table-wrapper'));
        children.sort((a, b) => (parseFloat(a.style.top) || 0) - (parseFloat(b.style.top) || 0));

        children.forEach(el => {
          if (el.classList.contains('editable-table-wrapper')) {
            const tbl = el.querySelector('table');
            if (tbl) {
              const rows = Array.from(tbl.rows).map(row => {
                const cells = Array.from(row.cells).map(cell =>
                  `<td>${escapeHtml(cell.innerText || cell.textContent || '')}</td>`
                ).join('');
                return `<tr>${cells}</tr>`;
              }).join('');
              wordHtml += `<table>${rows}</table>`;
            }
          } else {
            const clone = el.cloneNode(true);
            const handle = clone.querySelector('.drag-handle');
            if (handle) handle.remove();
            const text = clone.innerText.trim();
            if (text) {
              const fontSize = el.style.fontSize || '14px';
              const fontWeight = el.style.fontWeight || '400';
              const color = el.style.color || '#000000';
              wordHtml += `<p style="font-size:${escapeHtml(fontSize)}; font-weight:${escapeHtml(fontWeight)}; color:${escapeHtml(color)};">${escapeHtml(text)}</p>`;
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

    // GitHub Pages Guide Modal
    const githubModal = document.getElementById('githubModal');
    document.getElementById('btnGithubGuide').addEventListener('click', () => {
      githubModal.classList.remove('hidden');
      githubModal.classList.add('flex');
    });
    const closeModal = () => {
      githubModal.classList.add('hidden');
      githubModal.classList.remove('flex');
    };
    document.getElementById('btnCloseModal').addEventListener('click', closeModal);
    document.getElementById('btnCloseModalBottom').addEventListener('click', closeModal);

    // Boot with realistic Japanese Sample Document immediately so the user can test right away
    window.addEventListener('DOMContentLoaded', () => {
      loadRealisticSampleDocument();
    });

