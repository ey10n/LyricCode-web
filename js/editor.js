/* 歌詞の行の上にコードを併記するエディタ（Lazarus 版 TLyricChordEditor から移植）
   各行は「コード行」と「歌詞行」の 2 段。コードの位置は半角 1・全角 2 のセル単位で持つ。
   描画は Canvas、文字入力（日本語入力を含む）は見えない入力欄で受ける */
(function (LC) {
  'use strict';

  const { Chord, Text, Sheet, UI } = LC;
  const { SheetLine } = Sheet;

  const TOP_MARGIN = 6;
  const LEFT_PAD = 8;
  // 最終行より下にコードを置ける行数の上限と、その分としてスクロールで見せる行数
  const MAX_VIRTUAL_LINES = 200;
  const EXTRA_LINES_BELOW = 3;
  const DEFAULT_FONT_SIZE = 14;
  const LONG_PRESS_MS = 600;

  const UK_NONE = 0, UK_TYPING = 1, UK_OTHER = 2, UK_DELETE = 3, UK_MOVE = 4;

  const COLOR = {
    paper: '#FFFFFF',
    lyric: '#000000',
    chord: '#1040B0',
    chordBand: '#ECF6FF',
    curLine: '#FFFCE6',
    targetFill: '#FFE4B8',
    targetFrame: '#FF7C00',
    freeTargetFill: '#C8F0C8',
    freeTargetFrame: '#309030',
    gutter: '#F2F2F2',
    gutterLine: '#D8D8D8',
    gutterText: '#808080',
    caret: '#000000',
  };

  const LYRIC_FONT = '"MS Gothic","ＭＳ ゴシック","Osaka-Mono","Hiragino Sans","Hiragino Kaku Gothic ProN",' +
    '"Noto Sans JP","Yu Gothic",monospace';
  const CHORD_FONT = 'Arial,Helvetica,"Hiragino Sans","Yu Gothic",sans-serif';
  const GUTTER_FONT = 'system-ui,-apple-system,"Segoe UI",sans-serif';

  // 日本語入力がオンのままコード入力したときに、押されたキーから文字を求める
  function charFromCode(code, shift) {
    let m = /^Key([A-Z])$/.exec(code);
    if (m) return shift ? m[1] : m[1].toLowerCase();
    m = /^(?:Digit|Numpad)([0-9])$/.exec(code);
    if (m) return shift && code.startsWith('Digit') ? (m[1] === '3' ? '#' : '') : m[1];
    switch (code) {
      case 'Slash': case 'NumpadDivide': return shift ? '' : '/';
      case 'IntlYen': case 'Backslash': return shift ? '|' : '';
      case 'Minus': case 'NumpadSubtract': return shift ? '' : '-';
      case 'Space': return ' ';
      default: return '';
    }
  }

  // 全角英数字を半角に
  function toHalfWidth(s) {
    let r = '';
    for (const ch of s) {
      const c = ch.codePointAt(0);
      if (c >= 0xFF01 && c <= 0xFF5E) r += String.fromCharCode(c - 0xFEE0);
      else if (c === 0x3000) r += ' ';
      else r += ch;
    }
    return r;
  }

  class Editor {
    constructor(host) {
      this.host = host;
      host.classList.add('lc-editor');
      this.canvas = document.createElement('canvas');
      this.canvas.className = 'lc-canvas';
      this.ctx = this.canvas.getContext('2d');
      this.scroller = document.createElement('div');
      this.scroller.className = 'lc-scroller';
      this.spacer = document.createElement('div');
      this.spacer.className = 'lc-spacer';
      this.scroller.appendChild(this.spacer);
      // 歌詞・自由文字の入力欄（日本語入力を使う）
      this.ta = document.createElement('textarea');
      this.ta.className = 'lc-input lc-ta';
      this.ta.setAttribute('aria-label', '歌詞の入力');
      // コード入力欄（キーを 1 つずつ受け取る）
      this.ck = document.createElement('input');
      this.ck.type = 'text';
      this.ck.className = 'lc-input lc-ck';
      this.ck.setAttribute('aria-label', 'コードの入力');
      for (const el of [this.ta, this.ck]) {
        el.setAttribute('autocapitalize', 'off');
        el.setAttribute('autocomplete', 'off');
        el.setAttribute('autocorrect', 'off');
        el.spellcheck = false;
      }
      this.ta.setAttribute('wrap', 'off');
      this.ta.rows = 1;
      host.append(this.canvas, this.ta, this.ck, this.scroller);

      this.lines = [new SheetLine()];
      this._mode = 'both';
      this._freeText = false;
      this._fontSize = DEFAULT_FONT_SIZE;
      this.cellW = 10; this.chordH = 18; this.lyricH = 24; this.lineH = 46; this.gutterW = 40;
      this.contentW = 0; this.contentH = 0;
      this.caretLine = 0; this.caretIdx = 0; this.caretOn = true;
      this.targetLine = 0; this.targetCol = 0;
      this.mouseInside = false; this.mouseOnChordRow = false;
      this.pendingBass = false; this.lastPart = 'none';
      this.dragging = false; this.dragMoved = false;
      this.dragLine = 0; this.dragIdx = 0; this.dragOffset = 0; this.dragStartX = 0; this.dragStartY = 0;
      this.pressX = 0; this.pressY = 0; this.longPressTimer = 0; this.longPressAt = 0;
      this.panCandidate = false; this.panning = false; this.panTop = 0; this.panLeft = 0;
      this.lastMouse = null;
      this.undoStack = []; this.redoStack = []; this.lastUndoKind = UK_NONE;
      this.modified = false;
      this.menuLine = 0; this.menuCol = 0;
      this.focused = false; this.composing = false; this.cancelComposition = false;
      this.suppressScrollHover = false;
      this.onChange = null; this.onStatus = null;

      this.updateMetrics();
      this.attachEvents();
      new ResizeObserver(() => this.resize()).observe(host);
      setInterval(() => {
        if (this.focused && this.lyricCaretActive()) { this.caretOn = !this.caretOn; this.invalidate(); }
      }, 530);
      this.resize();
    }

    // ---- プロパティ ----

    get mode() { return this._mode; }
    set mode(v) {
      if (this._mode === v) return;
      this._mode = v;
      this.dragging = false; this.pendingBass = false; this.lastPart = 'none';
      this.lastUndoKind = UK_NONE;
      if (v !== 'both') this.mouseOnChordRow = false;
      this.scroller.classList.toggle('view', v === 'view');
      this.applyFocus(false);
      this.updateImeAnchor();
      this.invalidate();
      this.doStatus();
    }

    get freeText() { return this._freeText; }
    set freeText(v) {
      if (this._freeText === v) return;
      this._freeText = v;
      this.pendingBass = false; this.lastPart = 'none'; this.lastUndoKind = UK_NONE;
      this.applyFocus(false);
      this.updateImeAnchor();
      this.invalidate();
      this.doStatus();
    }

    get fontSize() { return this._fontSize; }
    set fontSize(v) {
      v = Math.max(8, Math.min(48, Math.round(v)));
      if (v === this._fontSize) return;
      this._fontSize = v;
      this.updateMetrics();
      this.updateContentSize();
      this.updateImeAnchor();
      this.invalidate();
    }

    get topY() { return this.scroller.scrollTop; }
    get leftX() { return this.scroller.scrollLeft; }
    get viewW() { return this.scroller.clientWidth; }
    get viewH() { return this.scroller.clientHeight; }

    // ---- メトリクス・スクロール ----

    updateMetrics() {
      const pt = (p) => p * 4 / 3;
      const lyricPx = pt(this._fontSize);
      const chordPx = pt(Math.max(7, Math.round(this._fontSize * 0.8)));
      const gutterPx = pt(Math.max(7, Math.round(this._fontSize * 0.6)));
      this.lyricPx = lyricPx;
      this.chordPx = chordPx;
      this.lyricFont = `${lyricPx}px ${LYRIC_FONT}`;
      this.chordFont = `bold ${chordPx}px ${CHORD_FONT}`;
      this.gutterFont = `${gutterPx}px ${GUTTER_FONT}`;
      const ctx = this.ctx;
      ctx.font = this.lyricFont;
      // 1 セル＝全角文字の半分の幅（等幅でないフォントでも全角が 2 セルに収まる）
      this.cellW = Math.max(2, ctx.measureText('0').width, ctx.measureText('漢').width / 2);
      this.lyricH = Math.round(lyricPx * 1.3) + 6;
      this.chordH = Math.round(chordPx * 1.25) + 2;
      this.lineH = this.chordH + this.lyricH + 4;
      ctx.font = this.gutterFont;
      this.gutterW = Math.ceil(ctx.measureText('0000').width) + 14;
    }

    resize() {
      const w = this.host.clientWidth, h = this.host.clientHeight;
      const dpr = window.devicePixelRatio || 1;
      this.canvas.width = Math.max(1, Math.round(w * dpr));
      this.canvas.height = Math.max(1, Math.round(h * dpr));
      this.canvas.style.width = w + 'px';
      this.canvas.style.height = h + 'px';
      this.dpr = dpr;
      this.updateContentSize();
      this.updateImeAnchor();
      this.draw();
    }

    updateContentSize() {
      let maxC = 0;
      for (const sl of this.lines) {
        let c = Text.allCells(sl.text);
        for (const ch of sl.chords) c = Math.max(c, ch.col + this.chordCells(ch.name));
        maxC = Math.max(maxC, c);
      }
      this.contentW = this.gutterW + LEFT_PAD + (maxC + 16) * this.cellW;
      this.contentH = TOP_MARGIN * 2 + (this.lines.length + EXTRA_LINES_BELOW) * this.lineH;
      this.spacer.style.width = Math.ceil(this.contentW) + 'px';
      this.spacer.style.height = Math.ceil(this.contentH) + 'px';
    }

    // プログラムからのスクロール（マウス位置で入力位置を変えない）
    scrollTo(top, left) {
      const maxTop = Math.max(0, this.contentH - this.viewH);
      const maxLeft = Math.max(0, this.contentW - this.viewW);
      top = Math.max(0, Math.min(maxTop, top));
      left = Math.max(0, Math.min(maxLeft, left));
      if (Math.round(top) === Math.round(this.topY) && Math.round(left) === Math.round(this.leftX)) return;
      this.suppressScrollHover = true;
      this.scroller.scrollTop = top;
      this.scroller.scrollLeft = left;
    }

    ensureVisible(l, cell) {
      this.updateContentSize();
      const t = TOP_MARGIN + l * this.lineH;
      let top = this.topY;
      if (t < top) top = t - TOP_MARGIN;
      else if (t + this.lineH > top + this.viewH) top = t + this.lineH - this.viewH + TOP_MARGIN;
      const x = cell * this.cellW;
      const viewW = this.viewW - this.gutterW - LEFT_PAD;
      let left = this.leftX;
      if (x < left) left = Math.max(0, x - viewW / 4);
      else if (x > left + viewW - this.cellW * 3) left = x - viewW + this.cellW * 6;
      this.scrollTo(top, left);
    }

    // ---- 座標 ----

    xOrigin() { return this.gutterW + LEFT_PAD - this.leftX; }
    lineTop(l) { return TOP_MARGIN + l * this.lineH - this.topY; }

    // beyond = true のときは最終行より下の何もない所も行として返す（コード入力用）
    yToLine(y, beyond) {
      const yy = y + this.topY - TOP_MARGIN;
      let r = yy < 0 ? 0 : Math.floor(yy / this.lineH);
      const max = this.lines.length - 1 + (beyond ? MAX_VIRTUAL_LINES : 0);
      if (r > max) r = max;
      const rel = yy - r * this.lineH;
      // まだ行のない所は、行全体をコード行として扱う
      return { line: r, onChord: rel < this.chordH + 1 || r >= this.lines.length };
    }

    xToCol(x) {
      const c = x - this.xOrigin();
      return c < 0 ? 0 : Math.floor(c / this.cellW);
    }

    idxFromCellF(l, cellF) {
      const t = this.lines[l].text;
      let best = 0, bestD = Math.abs(cellF), acc = 0;
      for (let i = 1; i <= t.length; i++) {
        acc += Text.charCells(t.charCodeAt(i - 1));
        if (i < t.length && Text.isLowSur(t.charCodeAt(i))) continue;
        const d = Math.abs(acc - cellF);
        if (d < bestD) { bestD = d; best = i; }
      }
      return best;
    }

    chordTextWidth(s) {
      this.ctx.font = this.chordFont;
      return this.ctx.measureText(s).width;
    }

    chordCells(s) {
      return Math.max(1, Math.ceil(this.chordTextWidth(s) / this.cellW - 1e-6));
    }

    // 指定桁にあるコードの番号（コード名の表示範囲内も含む）
    chordHit(l, c) {
      if (l < 0 || l >= this.lines.length) return -1;
      const sl = this.lines[l];
      const exact = sl.findChordCol(c);
      if (exact >= 0) return exact;
      for (let i = sl.chords.length - 1; i >= 0; i--) {
        const ch = sl.chords[i];
        if (c >= ch.col && c < ch.col + this.chordCells(ch.name)) return i;
      }
      return -1;
    }

    // ---- 状態 ----

    chordKeyActive() {
      return this._mode === 'chord' || (this._mode === 'both' && this.mouseInside && this.mouseOnChordRow);
    }

    lyricCaretActive() {
      return (this._mode === 'lyric' || this._mode === 'both') && !this.chordKeyActive();
    }

    chordTargetShown() {
      return this.chordKeyActive() && (this.focused || this.mouseInside);
    }

    // キー入力を受ける要素（閲覧中はスクロール領域、歌詞・自由文字は日本語入力を使う入力欄）
    sinkElement() {
      if (this._mode === 'view') return this.scroller;
      if (this.lyricCaretActive() || (this._freeText && this.chordKeyActive())) return this.ta;
      return this.ck;
    }

    applyFocus(force) {
      if (this.composing) return;
      const want = this.sinkElement();
      this.scroller.tabIndex = this._mode === 'view' ? 0 : -1;
      if ((force || this.focused) && document.activeElement !== want) want.focus({ preventScroll: true });
    }

    focusEditor() { this.applyFocus(true); }

    clampPositions() {
      if (this.lines.length === 0) this.lines.push(new SheetLine());
      this.caretLine = Math.max(0, Math.min(this.lines.length - 1, this.caretLine));
      this.caretIdx = Math.max(0, Math.min(this.lines[this.caretLine].text.length, this.caretIdx));
      this.targetLine = Math.max(0, Math.min(this.lines.length - 1 + MAX_VIRTUAL_LINES, this.targetLine));
      if (this.targetCol < 0) this.targetCol = 0;
    }

    // 最終行より下にコードを置くとき、そこまで空行を追加する
    ensureLines(l) {
      while (this.lines.length <= l) this.lines.push(new SheetLine());
    }

    doStatus() { if (this.onStatus) this.onStatus(this); }

    changed() {
      this.modified = true;
      this.clampPositions();
      this.updateContentSize();
      this.updateImeAnchor();
      this.invalidate();
      if (this.onChange) this.onChange(this);
      this.doStatus();
    }

    setModified(v) {
      this.modified = v;
      if (this.onChange) this.onChange(this);
    }

    statusText() {
      if (this._mode === 'view') return '閲覧中（編集できません）';
      if (this.chordKeyActive()) {
        let r = `行 ${this.targetLine + 1}  位置 ${this.targetCol + 1}`;
        const idx = this.chordHit(this.targetLine, this.targetCol);
        if (idx >= 0) r += '  コード: ' + this.lines[this.targetLine].chords[idx].name;
        if (this._freeText) {
          r += '  [自由文字]   ｜ 打った文字をそのまま入力  空白:次の位置へ  BackSpace:1文字削除  ' +
            'Enter:直接入力  Del:削除  Ctrl+Shift+F:自由文字オフ';
        } else {
          if (this.pendingBass) r += '  [ベース音を入力]';
          r += '   ｜ C～B:基音  #/b:♯♭  /:オンコード  数字:入力  m:追記  |:小節線  ' +
            '右クリック・長押し:基音／種類  Enter:直接入力  Del:削除  Shift+矢印:移動  Ctrl+Shift+F:自由文字';
        }
        return r;
      }
      let r = `行 ${this.caretLine + 1}  文字 ${this.caretIdx + 1}`;
      if (this._mode === 'both') r += '   ｜ コード行（色付きの帯）を指すとコード入力になります';
      return r;
    }

    // ---- 元に戻す ----

    getState() {
      return JSON.stringify({
        cl: this.caretLine, ci: this.caretIdx,
        lines: this.lines.map((l) => [l.text, l.chords.map((c) => [c.col, c.name])]),
      });
    }

    setState(s) {
      const st = JSON.parse(s);
      this.lines = st.lines.map(([t, cs]) => new SheetLine(t, cs.map(([col, name]) => ({ col, name }))));
      this.caretLine = st.cl;
      this.caretIdx = st.ci;
      this.clampPositions();
    }

    beginChange(kind) {
      if ((kind === UK_TYPING || kind === UK_DELETE || kind === UK_MOVE) && this.lastUndoKind === kind) return;
      this.undoStack.push(this.getState());
      if (this.undoStack.length > 500) this.undoStack.shift();
      this.redoStack = [];
      this.lastUndoKind = kind;
    }

    undo() {
      if (!this.undoStack.length) return;
      this.redoStack.push(this.getState());
      this.setState(this.undoStack.pop());
      this.lastUndoKind = UK_NONE;
      this.changed();
      this.ensureVisible(this.caretLine, Text.textCells(this.lines[this.caretLine].text, this.caretIdx));
    }

    redo() {
      if (!this.redoStack.length) return;
      this.undoStack.push(this.getState());
      this.setState(this.redoStack.pop());
      this.lastUndoKind = UK_NONE;
      this.changed();
      this.ensureVisible(this.caretLine, Text.textCells(this.lines[this.caretLine].text, this.caretIdx));
    }

    canUndo() { return this.undoStack.length > 0; }
    canRedo() { return this.redoStack.length > 0; }

    // ---- 描画 ----

    invalidate() {
      if (this.raf) return;
      this.raf = requestAnimationFrame(() => { this.raf = 0; this.draw(); });
    }

    draw() {
      const ctx = this.ctx;
      const w = this.host.clientWidth, h = this.host.clientHeight;
      ctx.setTransform(this.dpr || 1, 0, 0, this.dpr || 1, 0, 0);
      ctx.textBaseline = 'top';
      ctx.fillStyle = COLOR.paper;
      ctx.fillRect(0, 0, w, h);
      const xo = this.xOrigin();
      const chordModes = this._mode === 'chord' || this._mode === 'both';
      const lyricModes = this._mode === 'lyric' || this._mode === 'both';
      const showTarget = this.chordTargetShown();
      const showCaret = this.focused && this.lyricCaretActive() && this.caretOn && !this.composing;
      const first = Math.max(0, Math.floor((this.topY - TOP_MARGIN) / this.lineH));
      const lastVirt = Math.floor((this.topY + this.viewH - TOP_MARGIN) / this.lineH) + 1;
      const last = Math.min(this.lines.length - 1, lastVirt);

      for (let i = first; i <= lastVirt; i++) {
        // 最終行より下は、コード入力用の帯と入力位置だけを描く
        let sl = null;
        if (i < this.lines.length) sl = this.lines[i];
        else if (!chordModes) break;
        const y = this.lineTop(i);
        if (chordModes) {
          ctx.fillStyle = COLOR.chordBand;
          ctx.fillRect(this.gutterW, y, w, this.chordH);
        }
        if (lyricModes && i === this.caretLine && this.focused) {
          ctx.fillStyle = COLOR.curLine;
          ctx.fillRect(this.gutterW, y + this.chordH, w, this.lyricH);
        }
        if (showTarget && i === this.targetLine) {
          const hit = this.chordHit(i, this.targetCol);
          let x, tw;
          if (hit >= 0) {
            x = xo + sl.chords[hit].col * this.cellW;
            tw = this.chordTextWidth(sl.chords[hit].name);
          } else {
            x = xo + this.targetCol * this.cellW;
            tw = this.cellW;
          }
          ctx.fillStyle = this._freeText ? COLOR.freeTargetFill : COLOR.targetFill;
          ctx.strokeStyle = this._freeText ? COLOR.freeTargetFrame : COLOR.targetFrame;
          ctx.lineWidth = 1;
          ctx.fillRect(x - 2, y, tw + 4, this.chordH);
          ctx.strokeRect(x - 1.5, y + 0.5, tw + 3, this.chordH - 1);
        }
        if (!sl) continue;

        ctx.font = this.chordFont;
        ctx.fillStyle = COLOR.chord;
        for (const c of sl.chords) ctx.fillText(c.name, xo + c.col * this.cellW, y + 1);

        ctx.font = this.lyricFont;
        ctx.fillStyle = COLOR.lyric;
        const t = sl.text;
        let x = xo;
        for (let j = 0; j < t.length;) {
          const cells = Text.charCells(t.charCodeAt(j));
          let s;
          if (j + 1 < t.length && Text.isLowSur(t.charCodeAt(j + 1))) { s = t.substr(j, 2); j += 2; } else { s = t[j]; j++; }
          if (s !== ' ' && x + cells * this.cellW > this.gutterW && x < w) ctx.fillText(s, x, y + this.chordH + 3);
          x += cells * this.cellW;
        }

        if (showCaret && i === this.caretLine) {
          ctx.fillStyle = COLOR.caret;
          const cx = xo + Text.textCells(t, this.caretIdx) * this.cellW;
          ctx.fillRect(cx - 1, y + this.chordH + 2, 2, this.lyricH - 3);
        }
      }

      // 行番号
      ctx.fillStyle = COLOR.gutter;
      ctx.fillRect(0, 0, this.gutterW, h);
      ctx.fillStyle = COLOR.gutterLine;
      ctx.fillRect(this.gutterW - 1, 0, 1, h);
      ctx.font = this.gutterFont;
      ctx.fillStyle = COLOR.gutterText;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      for (let i = first; i <= last; i++) {
        ctx.fillText(String(i + 1), this.gutterW - 6, this.lineTop(i) + this.chordH + this.lyricH / 2);
      }
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
    }

    // 入力欄を入力位置へ動かす（日本語入力の変換中の文字がそこに出る）
    updateImeAnchor() {
      let x, y, font, h, px;
      if (this.lyricCaretActive()) {
        x = this.xOrigin() + Text.textCells(this.lines[this.caretLine].text, this.caretIdx) * this.cellW;
        y = this.lineTop(this.caretLine) + this.chordH + 2;
        font = this.lyricFont;
        px = this.lyricPx;
        h = this.lyricH - 2;
      } else {
        const idx = this.chordHit(this.targetLine, this.targetCol);
        if (idx >= 0) {
          const c = this.lines[this.targetLine].chords[idx];
          x = this.xOrigin() + c.col * this.cellW + this.chordTextWidth(c.name);
        } else {
          x = this.xOrigin() + this.targetCol * this.cellW;
        }
        y = this.lineTop(this.targetLine) + 1;
        font = this.chordFont;
        px = this.chordPx;
        h = this.chordH - 2;
      }
      // 画面の外に出すと、iPad などでページ自体がスクロールしてしまう
      x = Math.max(this.gutterW, Math.min(this.viewW - 4, x));
      y = Math.max(0, Math.min(this.viewH - h, y));
      for (const el of [this.ta, this.ck]) {
        el.style.left = x + 'px';
        el.style.top = y + 'px';
        el.style.height = h + 'px';
        el.style.font = font;
        // iPad の Safari は 16px 未満の入力欄を選ぶと画面を拡大してしまう
        if (px < 16) el.style.fontSize = '16px';
      }
    }

    // ---- イベント ----

    pos(e) {
      const r = this.scroller.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    }

    attachEvents() {
      const sc = this.scroller;
      sc.addEventListener('pointerdown', (e) => this.onPointerDown(e));
      sc.addEventListener('pointermove', (e) => this.onPointerMove(e));
      sc.addEventListener('pointerup', (e) => this.onPointerUp(e));
      sc.addEventListener('pointercancel', (e) => this.onPointerUp(e, true));
      sc.addEventListener('pointerleave', (e) => this.onPointerLeave(e));
      sc.addEventListener('contextmenu', (e) => this.onContextMenu(e));
      sc.addEventListener('dblclick', (e) => this.onDblClick(e));
      sc.addEventListener('click', () => { if (!UI.isMenuOpen()) this.focusEditor(); });
      sc.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
      sc.addEventListener('scroll', () => this.onScroll());
      sc.addEventListener('touchstart', (e) => this.onTouchStart(e), { passive: false });

      sc.addEventListener('keydown', (e) => this.onKeyDown(e, sc));
      this.ta.addEventListener('keydown', (e) => this.onKeyDown(e, this.ta));
      this.ck.addEventListener('keydown', (e) => this.onKeyDown(e, this.ck));
      this.ta.addEventListener('input', (e) => this.onTaInput(e));
      this.ck.addEventListener('input', (e) => this.onCkInput(e));
      for (const el of [this.ta, this.ck]) {
        el.addEventListener('compositionstart', () => this.onCompositionStart(el));
        el.addEventListener('compositionupdate', () => this.onCompositionUpdate(el));
        el.addEventListener('compositionend', (e) => this.onCompositionEnd(el, e));
      }
      for (const el of [this.ta, this.ck, sc]) {
        el.addEventListener('paste', (e) => {
          e.preventDefault();
          this.pasteText(e.clipboardData ? e.clipboardData.getData('text/plain') : '');
        });
      }
      this.host.addEventListener('focusin', () => {
        if (!this.focused) {
          this.focused = true;
          this.caretOn = true;
          this.invalidate();
          this.doStatus();
        }
      });
      this.host.addEventListener('focusout', (e) => {
        if (e.relatedTarget && this.host.contains(e.relatedTarget)) return;
        this.focused = false;
        this.dragging = false;
        this.invalidate();
      });
    }

    onPointerDown(e) {
      if (e.button !== 0 && e.button !== 2) return;
      const { x, y } = this.pos(e);
      if (x > this.viewW || y > this.viewH) return; // スクロールバー
      e.preventDefault(); // 入力欄からフォーカスを奪わない
      this.pressX = x; this.pressY = y;
      this.panning = false; this.panCandidate = false;
      this.lastMouse = { x, y };
      if (e.button === 0) {
        this.panTop = this.topY; this.panLeft = this.leftX;
        if (this._mode === 'chord' || this._mode === 'both') {
          clearTimeout(this.longPressTimer);
          this.longPressTimer = setTimeout(() => this.onLongPress(), LONG_PRESS_MS);
        }
      }
      if (this._mode === 'view') {
        this.panCandidate = e.button === 0 && e.pointerType === 'mouse';
        this.focusEditor();
        return;
      }
      this.mouseInside = true;
      this.updateHover(x, y);
      this.focusEditor();
      const active = this.chordKeyActive();
      const L = this.yToLine(y, active).line;
      const C = this.xToCol(x);
      if (active) {
        this.lastUndoKind = UK_NONE;
        if (e.button === 0) {
          const idx = this.chordHit(L, C);
          if (idx >= 0) {
            this.dragging = true;
            this.dragMoved = false;
            this.dragLine = L;
            this.dragIdx = idx;
            this.dragOffset = C - this.lines[L].chords[idx].col;
            this.dragStartX = x;
            this.dragStartY = y;
            try { this.scroller.setPointerCapture(e.pointerId); } catch (err) { /* 無視 */ }
          }
        }
      } else if ((this._mode === 'lyric' || this._mode === 'both') && e.button === 0) {
        this.moveCaret(L, this.idxFromCellF(L, (x - this.xOrigin()) / this.cellW));
      }
    }

    onPointerMove(e) {
      const { x, y } = this.pos(e);
      this.lastMouse = { x, y };
      if (e.pointerType === 'mouse') this.mouseInside = true;
      if (this.longPressTimer && Math.abs(x - this.pressX) + Math.abs(y - this.pressY) > 8) {
        clearTimeout(this.longPressTimer);
        this.longPressTimer = 0;
      }
      if (this.panCandidate && (e.buttons & 1)) {
        if (!this.panning && Math.abs(x - this.pressX) + Math.abs(y - this.pressY) >= 6) this.panning = true;
        if (this.panning) {
          this.scrollTo(this.panTop - (y - this.pressY), this.panLeft - (x - this.pressX));
          return;
        }
      }
      if (this.dragging) {
        if (!this.dragMoved && Math.abs(x - this.dragStartX) + Math.abs(y - this.dragStartY) >= 4) {
          this.dragMoved = true;
          this.beginChange(UK_OTHER);
          this.lastUndoKind = UK_NONE;
        }
        if (this.dragMoved) {
          const L = this.yToLine(y, true).line;
          const C = Math.max(0, this.xToCol(x) - this.dragOffset);
          if (this.moveChordRaw(this.dragLine, this.dragIdx, L, C)) {
            this.dragLine = L;
            this.dragIdx = this.lines[L].findChordCol(C);
            this.targetLine = L;
            this.targetCol = C + this.dragOffset;
            this.changed();
          }
          this.updateCursor(x, y);
        }
        return;
      }
      if (e.pointerType === 'mouse' && e.buttons === 0) this.updateHover(x, y);
    }

    onPointerUp(e, cancelled) {
      clearTimeout(this.longPressTimer);
      this.longPressTimer = 0;
      this.panCandidate = false;
      if (this.panning) { this.panning = false; return; }
      if (this.dragging) {
        this.dragging = false;
        try { this.scroller.releasePointerCapture(e.pointerId); } catch (err) { /* 無視 */ }
        if (!cancelled) { const p = this.pos(e); this.updateCursor(p.x, p.y); }
      }
    }

    onPointerLeave(e) {
      if (e.pointerType !== 'mouse' || this.dragging) return; // タッチでは指を離しても入力位置を保つ
      this.mouseInside = false;
      if (this._mode === 'both') {
        this.mouseOnChordRow = false;
        this.applyFocus(false);
        this.updateImeAnchor();
        this.doStatus();
      }
      this.invalidate();
    }

    // 長押し：右クリックの代わりにコードメニューを開く（タッチ操作用）
    onLongPress() {
      this.longPressTimer = 0;
      if (!(this._mode === 'chord' || this._mode === 'both') || this.panning || (this.dragging && this.dragMoved)) return;
      this.dragging = false;
      this.panCandidate = false;
      const L = this.yToLine(this.pressY, true).line;
      this.mouseInside = true;
      if (this._mode === 'both') this.mouseOnChordRow = true;
      this.setTarget(L, this.xToCol(this.pressX));
      this.longPressAt = Date.now();
      this.showChordMenu(this.pressX, this.pressY);
    }

    onContextMenu(e) {
      e.preventDefault();
      if (Date.now() - this.longPressAt < 1500 || this._mode === 'view') return;
      const { x, y } = this.pos(e);
      this.mouseInside = true;
      this.updateHover(x, y);
      if (this.chordKeyActive()) this.showChordMenu(x, y);
    }

    onDblClick() {
      if (this.chordKeyActive()) {
        this.dragging = false;
        this.editChordDialog(this.targetLine, this.targetCol);
      }
    }

    onWheel(e) {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      this.fontSize = this._fontSize + (e.deltaY < 0 ? 1 : -1);
      if (this.onChange) this.onChange(this);
    }

    onScroll() {
      if (this.suppressScrollHover) {
        this.suppressScrollHover = false;
      } else if (this.mouseInside && !this.dragging && !this.panning && this.lastMouse) {
        this.updateHover(this.lastMouse.x, this.lastMouse.y);
      }
      this.updateImeAnchor();
      this.draw();
    }

    // コードの上から指でなぞったときは、画面のスクロールではなくコードの移動にする
    onTouchStart(e) {
      if (e.touches.length !== 1 || !(this._mode === 'chord' || this._mode === 'both')) return;
      const t = e.touches[0];
      const r = this.scroller.getBoundingClientRect();
      const x = t.clientX - r.left, y = t.clientY - r.top;
      const { line, onChord } = this.yToLine(y, true);
      if ((this._mode === 'chord' || onChord) && this.chordHit(line, this.xToCol(x)) >= 0) e.preventDefault();
    }

    updateCursor(x, y) {
      let c = 'text';
      if (this._mode === 'view') c = 'default';
      else if (this.dragging && this.dragMoved) c = 'move';
      else if (this.chordKeyActive()) {
        const L = this.yToLine(y, true).line;
        c = this.chordHit(L, this.xToCol(x)) >= 0 ? 'pointer' : 'crosshair';
      }
      this.scroller.style.cursor = c;
    }

    updateHover(x, y) {
      if (this._mode === 'view') return;
      const was = this.chordKeyActive();
      const { line, onChord } = this.yToLine(y, true);
      const c = this.xToCol(x);
      if (this._mode === 'both') this.mouseOnChordRow = onChord;
      if (this.chordKeyActive()) this.setTarget(line, c);
      if (was !== this.chordKeyActive()) {
        this.applyFocus(false);
        this.updateImeAnchor();
        this.invalidate();
        this.doStatus();
      }
      this.updateCursor(x, y);
    }

    // ---- キーボード ----

    onKeyDown(e, source) {
      if (UI.isMenuOpen()) return;
      // 日本語入力の変換中
      if (e.isComposing || e.keyCode === 229) {
        // コード入力中に日本語入力がオンだった：押されたキーから文字を求め、変換は取り消す
        if (source === this.ck && this.chordKeyActive() && !this._freeText && e.key === 'Process') {
          const ch = charFromCode(e.code, e.shiftKey);
          if (ch) {
            this.chordChar(ch);
            this.cancelComposition = true;
            setTimeout(() => {
              this.ck.blur();
              this.ck.value = '';
              this.ck.focus({ preventScroll: true });
              setTimeout(() => { this.cancelComposition = false; }, 50);
            }, 0);
          }
        }
        return;
      }
      const ctrl = e.ctrlKey || e.metaKey;
      if (e.altKey || (ctrl && e.key !== 'Home' && e.key !== 'End')) return;
      let handled;
      if (this._mode === 'view') handled = this.viewKeyDown(e);
      else if (this.chordKeyActive()) {
        if (!this._freeText && source === this.ck && e.key.length === 1) {
          this.chordChar(e.key);
          handled = true;
        } else {
          handled = this.chordKeyDown(e);
        }
      } else handled = this.lyricKeyDown(e);
      if (handled) e.preventDefault();
    }

    onTaInput(e) {
      if (this.composing || e.isComposing) return;
      const v = this.ta.value;
      this.ta.value = '';
      if (v) this.typeText(v);
    }

    onCkInput(e) {
      if (this.composing || e.isComposing) return;
      const v = this.ck.value;
      this.ck.value = '';
      if (!v || this.cancelComposition) return;
      // キー入力で処理できなかった文字（iPad の画面キーボードなど）
      this.typeText(v);
    }

    onCompositionStart(el) {
      this.composing = true;
      if (el === this.ta) {
        this.updateImeAnchor();
        el.classList.add('composing');
        this.invalidate();
      }
    }

    onCompositionUpdate(el) {
      if (el !== this.ta) return;
      this.ctx.font = el.style.font || this.lyricFont;
      el.style.width = Math.ceil(this.ctx.measureText(el.value).width + 8) + 'px';
    }

    onCompositionEnd(el, e) {
      this.composing = false;
      el.classList.remove('composing');
      el.style.width = '';
      const v = el.value || e.data || '';
      el.value = '';
      if (el === this.ck && this.cancelComposition) return;
      if (v) this.typeText(v);
      this.applyFocus(false);
      this.invalidate();
    }

    // 入力された文字列（歌詞なら挿入、自由文字なら 1 文字ずつ置く）
    typeText(v) {
      if (this._mode === 'view') return;
      if (this.chordKeyActive()) {
        if (this._freeText) for (const ch of v) this.freeTextInput(ch === '　' ? ' ' : ch);
        else for (const ch of toHalfWidth(v)) if (ch.length === 1) this.chordChar(ch);
      } else {
        this.insertLyricText(v, v.length === 1 ? UK_TYPING : UK_OTHER);
      }
    }

    // ---- 歌詞編集 ----

    setCaret(l, i) {
      this.caretLine = l;
      this.caretIdx = i;
      this.clampPositions();
      const t = this.lines[this.caretLine].text;
      if (this.caretIdx > 0 && this.caretIdx < t.length && Text.isLowSur(t.charCodeAt(this.caretIdx))) this.caretIdx--;
      this.caretOn = true;
      this.ensureVisible(this.caretLine, Text.textCells(t, this.caretIdx));
      this.updateImeAnchor();
      this.invalidate();
      this.doStatus();
    }

    moveCaret(l, i) {
      this.lastUndoKind = UK_NONE;
      this.setCaret(l, i);
    }

    insertLyric(u) {
      if (!u) return;
      const sl = this.lines[this.caretLine];
      const p = Text.textCells(sl.text, this.caretIdx);
      const w = Text.allCells(u);
      const oldLen = Text.allCells(sl.text);
      sl.text = sl.text.slice(0, this.caretIdx) + u + sl.text.slice(this.caretIdx);
      // 歌詞の上に乗っているコードは文字と一緒に動かす。行末より右に置いたコードは動かさない
      for (const c of sl.chords) if (c.col >= p && c.col < oldLen) c.col += w;
      sl.normalize();
      this.caretIdx += u.length;
    }

    deleteLyric(l, idx, count) {
      const sl = this.lines[l];
      const p = Text.textCells(sl.text, idx);
      const w = Text.allCells(sl.text.substr(idx, count));
      const oldLen = Text.allCells(sl.text);
      sl.text = sl.text.slice(0, idx) + sl.text.slice(idx + count);
      for (const c of sl.chords) {
        if (c.col >= p + w && c.col < oldLen) c.col -= w;
        else if (c.col >= p && c.col < p + w) c.col = p;
      }
      sl.normalize();
    }

    splitLine(l, idx) {
      const sl = this.lines[l];
      const p = Text.textCells(sl.text, idx);
      const oldLen = Text.allCells(sl.text);
      const nl = new SheetLine(sl.text.slice(idx));
      sl.text = sl.text.slice(0, idx);
      sl.chords = sl.chords.filter((c) => {
        if (c.col >= p && c.col < oldLen) { nl.appendChord(c.col - p, c.name); return false; }
        return true;
      });
      nl.normalize();
      this.lines.splice(l + 1, 0, nl);
    }

    joinLines(l) {
      if (l + 1 >= this.lines.length) return;
      const a = this.lines[l], b = this.lines[l + 1];
      const lenA = Text.allCells(a.text);
      a.text += b.text;
      for (const c of b.chords) a.appendChord(c.col + lenA, c.name);
      a.normalize();
      this.lines.splice(l + 1, 1);
    }

    insertLyricText(u, kind) {
      if (!(this._mode === 'lyric' || this._mode === 'both')) return;
      const s = Text.cleanText(u, true);
      if (!s) return;
      this.beginChange(kind);
      const parts = s.split('\n');
      parts.forEach((part, k) => {
        if (k > 0) {
          this.splitLine(this.caretLine, this.caretIdx);
          this.caretLine++;
          this.caretIdx = 0;
        }
        this.insertLyric(part);
      });
      this.changed();
      this.setCaret(this.caretLine, this.caretIdx);
    }

    lyricKeyDown(e) {
      const sl = this.lines[this.caretLine];
      const t = sl.text;
      const ctrl = e.ctrlKey || e.metaKey;
      let i, n;
      switch (e.key) {
        case 'ArrowLeft':
          if (this.caretIdx > 0) {
            i = this.caretIdx - 1;
            if (i > 0 && Text.isLowSur(t.charCodeAt(i))) i--;
            this.moveCaret(this.caretLine, i);
          } else if (this.caretLine > 0) {
            this.moveCaret(this.caretLine - 1, this.lines[this.caretLine - 1].text.length);
          }
          return true;
        case 'ArrowRight':
          if (this.caretIdx < t.length) {
            i = this.caretIdx + 1;
            if (i < t.length && Text.isLowSur(t.charCodeAt(i))) i++;
            this.moveCaret(this.caretLine, i);
          } else if (this.caretLine < this.lines.length - 1) {
            this.moveCaret(this.caretLine + 1, 0);
          }
          return true;
        case 'ArrowUp':
          if (this.caretLine > 0) {
            this.moveCaret(this.caretLine - 1,
              this.idxFromCellF(this.caretLine - 1, Text.textCells(t, this.caretIdx)));
          }
          return true;
        case 'ArrowDown':
          if (this.caretLine < this.lines.length - 1) {
            this.moveCaret(this.caretLine + 1,
              this.idxFromCellF(this.caretLine + 1, Text.textCells(t, this.caretIdx)));
          }
          return true;
        case 'PageUp':
        case 'PageDown':
          n = Math.max(1, Math.floor(this.viewH / this.lineH) - 1);
          if (e.key === 'PageUp') n = -n;
          i = Math.max(0, Math.min(this.lines.length - 1, this.caretLine + n));
          this.moveCaret(i, this.idxFromCellF(i, Text.textCells(t, this.caretIdx)));
          return true;
        case 'Home':
          if (ctrl) this.moveCaret(0, 0); else this.moveCaret(this.caretLine, 0);
          return true;
        case 'End':
          if (ctrl) this.moveCaret(this.lines.length - 1, this.lines[this.lines.length - 1].text.length);
          else this.moveCaret(this.caretLine, t.length);
          return true;
        case 'Backspace':
          if (this.caretIdx > 0) {
            this.beginChange(UK_DELETE);
            i = this.caretIdx - 1;
            if (i > 0 && Text.isLowSur(t.charCodeAt(i))) i--;
            this.deleteLyric(this.caretLine, i, this.caretIdx - i);
            this.caretIdx = i;
            this.changed();
            this.setCaret(this.caretLine, this.caretIdx);
          } else if (this.caretLine > 0) {
            this.beginChange(UK_OTHER);
            i = this.lines[this.caretLine - 1].text.length;
            this.joinLines(this.caretLine - 1);
            this.caretLine--;
            this.caretIdx = i;
            this.changed();
            this.setCaret(this.caretLine, this.caretIdx);
          }
          return true;
        case 'Delete':
          if (this.caretIdx < t.length) {
            this.beginChange(UK_DELETE);
            n = 1;
            if (this.caretIdx + 1 < t.length && Text.isLowSur(t.charCodeAt(this.caretIdx + 1))) n = 2;
            this.deleteLyric(this.caretLine, this.caretIdx, n);
            this.changed();
            this.setCaret(this.caretLine, this.caretIdx);
          } else if (this.caretLine < this.lines.length - 1) {
            this.beginChange(UK_OTHER);
            this.joinLines(this.caretLine);
            this.changed();
            this.setCaret(this.caretLine, this.caretIdx);
          }
          return true;
        case 'Enter':
          this.beginChange(UK_OTHER);
          this.splitLine(this.caretLine, this.caretIdx);
          this.caretLine++;
          this.caretIdx = 0;
          this.changed();
          this.setCaret(this.caretLine, this.caretIdx);
          return true;
        default:
          return false;
      }
    }

    viewKeyDown(e) {
      const page = Math.max(this.lineH, this.viewH - this.lineH);
      switch (e.key) {
        case 'ArrowUp': this.scrollTo(this.topY - this.lineH, this.leftX); return true;
        case 'ArrowDown': this.scrollTo(this.topY + this.lineH, this.leftX); return true;
        case 'ArrowLeft': this.scrollTo(this.topY, this.leftX - this.cellW * 2); return true;
        case 'ArrowRight': this.scrollTo(this.topY, this.leftX + this.cellW * 2); return true;
        case 'PageUp': this.scrollTo(this.topY - page, this.leftX); return true;
        case 'PageDown': case ' ': this.scrollTo(this.topY + page, this.leftX); return true;
        case 'Home': this.scrollTo(0, 0); return true;
        case 'End': this.scrollTo(this.contentH, 0); return true;
        default: return false;
      }
    }

    // ---- コード編集 ----

    setTarget(l, c) {
      l = Math.max(0, Math.min(this.lines.length - 1 + MAX_VIRTUAL_LINES, l));
      c = Math.max(0, c);
      if (l === this.targetLine && c === this.targetCol) return;
      const oldHit = this.chordHit(this.targetLine, this.targetCol);
      const newHit = this.chordHit(l, c);
      if (l !== this.targetLine || oldHit !== newHit || newHit < 0) {
        this.lastPart = 'none';
        this.pendingBass = false;
      }
      this.targetLine = l;
      this.targetCol = c;
      this.updateImeAnchor();
      this.invalidate();
      this.doStatus();
    }

    setChordName(l, idx, newName) {
      if (idx < 0 || l >= this.lines.length || idx >= this.lines[l].chords.length) return;
      if (this.lines[l].chords[idx].name === newName) return;
      this.beginChange(UK_OTHER);
      if (newName === '') this.lines[l].deleteChord(idx);
      else this.lines[l].chords[idx].name = newName;
      this.changed();
    }

    createChord(l, c, name) {
      if (!name || l < 0) return;
      if (l < this.lines.length && this.lines[l].findChordCol(c) >= 0) return;
      this.beginChange(UK_OTHER);
      this.ensureLines(l);
      this.lines[l].addChord(c, name);
      this.changed();
    }

    moveChordRaw(l, idx, nl, nc) {
      if (nl < 0 || nl >= this.lines.length + MAX_VIRTUAL_LINES || nc < 0) return false;
      if (idx < 0 || idx >= this.lines[l].chords.length) return false;
      const ch = this.lines[l].chords[idx];
      if (nl === l && nc === ch.col) return false;
      if (nl < this.lines.length) {
        const other = this.lines[nl].findChordCol(nc);
        if (other >= 0 && !(nl === l && other === idx)) return false;
      }
      this.ensureLines(nl);
      this.lines[l].deleteChord(idx);
      this.lines[nl].addChord(nc, ch.name);
      return true;
    }

    moveTargetChord(dLine, dCol) {
      const idx = this.chordHit(this.targetLine, this.targetCol);
      if (idx < 0) return;
      const nl = this.targetLine + dLine;
      const nc = this.lines[this.targetLine].chords[idx].col + dCol;
      if (nl < 0 || nl > this.lines.length || nc < 0) return;
      this.beginChange(UK_MOVE);
      if (this.moveChordRaw(this.targetLine, idx, nl, nc)) {
        this.targetLine = nl;
        this.targetCol = nc;
        this.changed();
        this.ensureVisible(this.targetLine, this.targetCol);
      }
    }

    // コード入力のキー 1 文字
    chordChar(ch) {
      let r = '', q = '', b = '', cname = '';
      const idx = this.chordHit(this.targetLine, this.targetCol);
      if (idx >= 0) {
        cname = this.lines[this.targetLine].chords[idx].name;
        const p = Chord.parseChord(cname);
        if (p.ok) { r = p.root; q = p.quality; b = p.bass; }
      }
      const L = this.targetLine;
      if (/^[A-Ga-g]$/.test(ch)) {
        // 基音（またはベース音）を入力した直後の小文字 b はフラット
        if (ch === 'b' && idx >= 0 && (this.lastPart === 'root' || this.lastPart === 'bass')) {
          if (this.lastPart === 'bass') b = Chord.toggleAccidental(b, 'b'); else r = Chord.toggleAccidental(r, 'b');
          this.setChordName(L, idx, Chord.buildChord(r, q, b));
          this.lastPart = 'none';
        } else if (this.pendingBass && idx >= 0 && r) {
          if (q.endsWith('/')) q = q.slice(0, -1);
          this.setChordName(L, idx, Chord.buildChord(r, q, ch.toUpperCase()));
          this.pendingBass = false;
          this.lastPart = 'bass';
        } else if (idx >= 0) {
          this.setChordName(L, idx, Chord.buildChord(ch.toUpperCase(), q, b));
          this.lastPart = 'root';
        } else {
          this.createChord(L, this.targetCol, ch.toUpperCase());
          this.lastPart = 'root';
        }
      } else if (ch === '#') {
        if (idx >= 0 && r) {
          if (this.lastPart === 'bass') b = Chord.toggleAccidental(b, '#'); else r = Chord.toggleAccidental(r, '#');
          this.setChordName(L, idx, Chord.buildChord(r, q, b));
        }
      } else if (ch === '/') {
        if (idx >= 0 && r) {
          if (b) {
            this.setChordName(L, idx, Chord.buildChord(r, q, ''));
            this.pendingBass = false;
          } else {
            this.pendingBass = !this.pendingBass;
          }
          this.lastPart = 'none';
        }
      } else if (ch === '|') {
        // 小節線は空いている位置にだけ置く（既存のコードの上では何もしない）
        if (idx < 0) this.createChord(L, this.targetCol, Chord.BAR_LINE);
        this.lastPart = 'none';
        this.pendingBass = false;
      } else if (ch === ' ') {
        this.lastPart = 'none';
        this.pendingBass = false;
      } else if (idx >= 0 && ch > ' ' && ch < '\x7F') {
        if (r) this.setChordName(L, idx, Chord.buildChord(r, q + ch, b));
        else this.setChordName(L, idx, cname + ch);
        this.lastPart = 'none';
        this.pendingBass = false;
      } else if (idx < 0 && /^[0-9]$/.test(ch)) {
        // 空いている位置では数字だけ直接入力できる（続けて打つと桁が続く）
        this.createChord(L, this.targetCol, ch);
        this.lastPart = 'none';
        this.pendingBass = false;
      }
      this.invalidate();
      this.doStatus();
    }

    // 自由文字入力：打った文字を入力位置にそのまま置く（入力位置の文字列があれば後ろに追記）。
    // 空白は文字列の区切りで、入力位置を今の文字列の後ろへ進める
    freeTextInput(s) {
      const idx = this.chordHit(this.targetLine, this.targetCol);
      if (s === ' ') {
        if (idx >= 0) {
          const c = this.lines[this.targetLine].chords[idx];
          this.setTarget(this.targetLine, c.col + this.chordCells(c.name) + 1);
        } else {
          this.setTarget(this.targetLine, this.targetCol + 1);
        }
        this.ensureVisible(this.targetLine, this.targetCol);
        return;
      }
      if (idx >= 0) this.setChordName(this.targetLine, idx, this.lines[this.targetLine].chords[idx].name + s);
      else this.createChord(this.targetLine, this.targetCol, s);
      this.updateImeAnchor();
      this.invalidate();
      this.doStatus();
    }

    // 自由文字を (l, c) に置く。入力位置の文字列は置き換え、空白で区切った語は順に後ろへ並べる
    placeFreeText(l, c, s) {
      if (l < 0) return;
      const words = Text.cleanText(s, false).split(' ');
      this.beginChange(UK_OTHER);
      const idx = this.chordHit(l, c);
      let col = c;
      if (idx >= 0) {
        col = this.lines[l].chords[idx].col;
        this.lines[l].deleteChord(idx);
      }
      for (const w of words) {
        if (w === '') { col++; continue; }
        this.ensureLines(l);
        this.lines[l].addChord(col, w);
        col += this.chordCells(w) + 1;
      }
      this.changed();
    }

    chordKeyDown(e) {
      let idx;
      switch (e.key) {
        case 'ArrowLeft':
          if (e.shiftKey) this.moveTargetChord(0, -1);
          else { this.setTarget(this.targetLine, this.targetCol - 1); this.ensureVisible(this.targetLine, this.targetCol); }
          break;
        case 'ArrowRight':
          if (e.shiftKey) this.moveTargetChord(0, 1);
          else { this.setTarget(this.targetLine, this.targetCol + 1); this.ensureVisible(this.targetLine, this.targetCol); }
          break;
        case 'ArrowUp':
          if (e.shiftKey) this.moveTargetChord(-1, 0);
          else { this.setTarget(this.targetLine - 1, this.targetCol); this.ensureVisible(this.targetLine, this.targetCol); }
          break;
        case 'ArrowDown':
          if (e.shiftKey) this.moveTargetChord(1, 0);
          else { this.setTarget(this.targetLine + 1, this.targetCol); this.ensureVisible(this.targetLine, this.targetCol); }
          break;
        case 'Home':
          this.setTarget(this.targetLine, 0);
          this.ensureVisible(this.targetLine, this.targetCol);
          break;
        case 'Delete':
          idx = this.chordHit(this.targetLine, this.targetCol);
          if (idx >= 0) this.setChordName(this.targetLine, idx, '');
          this.lastPart = 'none';
          this.pendingBass = false;
          break;
        case 'Backspace':
          idx = this.chordHit(this.targetLine, this.targetCol);
          if (idx >= 0) {
            // 自由文字では日本語や絵文字も入るため、1 文字単位で消す
            const chars = [...this.lines[this.targetLine].chords[idx].name];
            chars.pop();
            this.setChordName(this.targetLine, idx, chars.join(''));
          }
          this.lastPart = 'none';
          this.pendingBass = false;
          break;
        case 'Enter':
          this.editChordDialog(this.targetLine, this.targetCol);
          break;
        case 'Escape':
          this.lastPart = 'none';
          this.pendingBass = false;
          break;
        case 'ContextMenu':
          this.showChordMenu(this.xOrigin() + this.targetCol * this.cellW, this.lineTop(this.targetLine) + this.chordH);
          break;
        default:
          return false;
      }
      this.invalidate();
      this.doStatus();
      return true;
    }

    async editChordDialog(l, c) {
      if (l < 0) return;
      const idx = this.chordHit(l, c);
      let s = idx >= 0 ? this.lines[l].chords[idx].name : '';
      if (this._freeText) {
        s = await UI.prompt('自由文字入力', '文字（例: サビ, ×2, rit.）　空白で区切ると後ろに並べます', s);
        if (s !== null) this.placeFreeText(l, c, s);
        this.focusEditor();
        return;
      }
      s = await UI.prompt('コード入力', 'コード名（例: Cm7, F#m7-5, G/B）', s);
      if (s !== null) {
        s = Chord.normalizeChordName(s);
        const i2 = this.chordHit(l, c);
        if (i2 >= 0) this.setChordName(l, i2, s); else this.createChord(l, c, s);
        this.lastPart = 'none';
        this.pendingBass = false;
      }
      this.focusEditor();
    }

    showChordMenu(x, y) {
      this.menuLine = this.targetLine;
      this.menuCol = this.targetCol;
      const r = this.scroller.getBoundingClientRect();
      UI.showMenu(this.buildChordMenu(), r.left + x, r.top + y, () => this.focusEditor());
    }

    buildChordMenu() {
      const L = this.menuLine, C = this.menuCol;
      const idx = this.chordHit(L, C);
      const name = idx >= 0 ? this.lines[L].chords[idx].name : '';
      const items = [];
      const header = (label) => items.push({ label, disabled: true, header: true }, '-');
      if (idx >= 0 && name === Chord.BAR_LINE) {
        // 小節線の上
        header('小節線  ' + Chord.BAR_LINE);
        items.push({ label: '小節線を削除', onClick: () => this.menuDelete() });
      } else if (idx >= 0 && Chord.isNoteSymbol(name)) {
        // 音符の上：ほかの音符に変える
        header('音符  ' + name);
        items.push({
          label: '音符を変更',
          submenu: Chord.NOTE_SYMBOLS.map((n) => ({ label: n, checked: n === name, onClick: () => this.menuNote(n) })),
        }, '-', { label: '音符を削除', onClick: () => this.menuDelete() });
      } else if (idx >= 0) {
        const p = Chord.parseChord(name);
        const r = p.ok ? p.root : '', q = p.ok ? p.quality : '', b = p.ok ? p.bass : '';
        header('コード: ' + name);
        Chord.QUALITIES.slice(0, Chord.MAIN_QUALITY_COUNT).forEach((qq) => {
          items.push({
            label: (qq === '' ? 'メジャー' : qq) + '    (' + Chord.buildChord(r, qq, b) + ')',
            checked: !!r && q === qq, disabled: !r, onClick: () => this.menuQuality(qq),
          });
        });
        items.push({
          label: 'その他のコード', disabled: !r,
          submenu: Chord.QUALITIES.slice(Chord.MAIN_QUALITY_COUNT).map((qq) => ({
            label: qq + '    (' + Chord.buildChord(r, qq, b) + ')', checked: q === qq, onClick: () => this.menuQuality(qq),
          })),
        });
        items.push({ label: 'コード名を直接入力...', onClick: () => this.editChordDialog(L, C) }, '-');
        items.push({
          label: '基音',
          submenu: Chord.MENU_NOTES.map((n) => ({ label: n, checked: r === n, onClick: () => this.menuRoot(n) })),
        });
        items.push({
          label: 'ベース音（オンコード）', disabled: !r,
          submenu: [{ label: 'なし', checked: b === '', onClick: () => this.menuBass('') }, '-']
            .concat(Chord.MENU_NOTES.map((n) => ({ label: '/' + n, checked: b === n, onClick: () => this.menuBass(n) }))),
        });
        items.push('-', { label: 'コードを削除', onClick: () => this.menuDelete() });
      } else {
        // 何もない位置：基音を選ぶとその位置にコードが入る（種類は次の右クリックで選ぶ）
        header('基音を選択');
        Chord.MENU_NOTES.filter((n) => n.length === 1).forEach((n) => items.push({ label: n, onClick: () => this.menuRoot(n) }));
        items.push({
          label: '♯ / ♭',
          submenu: Chord.MENU_NOTES.filter((n) => n.length > 1).map((n) => ({ label: n, onClick: () => this.menuRoot(n) })),
        });
        items.push('-', { label: Chord.BAR_LINE + '  小節線', onClick: () => this.createChord(L, C, Chord.BAR_LINE) });
        items.push({
          label: '音符',
          submenu: Chord.NOTE_SYMBOLS.map((n) => ({ label: n, onClick: () => this.menuNote(n) })),
        }, '-');
        items.push({ label: this._freeText ? '文字を直接入力...' : 'コード名を直接入力...', onClick: () => this.editChordDialog(L, C) });
      }
      items.push('-', { label: '自由文字入力 (Ctrl+Shift+F)', checked: this._freeText, onClick: () => { this.freeText = !this._freeText; } });
      return items;
    }

    menuQuality(q) {
      const idx = this.chordHit(this.menuLine, this.menuCol);
      if (idx < 0) return;
      const p = Chord.parseChord(this.lines[this.menuLine].chords[idx].name);
      if (!p.ok) return;
      this.setChordName(this.menuLine, idx, Chord.buildChord(p.root, q, p.bass));
    }

    menuRoot(note) {
      const idx = this.chordHit(this.menuLine, this.menuCol);
      if (idx < 0) {
        this.createChord(this.menuLine, this.menuCol, note);
      } else {
        const p = Chord.parseChord(this.lines[this.menuLine].chords[idx].name);
        this.setChordName(this.menuLine, idx, Chord.buildChord(note, p.ok ? p.quality : '', p.bass));
      }
    }

    menuBass(note) {
      const idx = this.chordHit(this.menuLine, this.menuCol);
      if (idx < 0) return;
      const p = Chord.parseChord(this.lines[this.menuLine].chords[idx].name);
      if (!p.ok) return;
      this.setChordName(this.menuLine, idx, Chord.buildChord(p.root, p.quality, note));
    }

    // 何もない位置なら音符を置き、音符の上ならその音符を変える
    menuNote(n) {
      const idx = this.chordHit(this.menuLine, this.menuCol);
      if (idx >= 0) this.setChordName(this.menuLine, idx, n);
      else this.createChord(this.menuLine, this.menuCol, n);
    }

    menuDelete() {
      this.setChordName(this.menuLine, this.chordHit(this.menuLine, this.menuCol), '');
    }

    // ---- 文書 ----

    newDocument() {
      this.setSheetText('');
    }

    getSheetText(withHeader) {
      return Sheet.getSheetText(this.lines, withHeader);
    }

    setSheetText(s) {
      this.lines = Sheet.parseSheetText(s);
      this.resetAfterLoad();
    }

    assignLines(lines) {
      this.lines = lines.length ? lines : [new SheetLine()];
      for (const l of this.lines) l.normalize();
      this.resetAfterLoad();
    }

    resetAfterLoad() {
      this.caretLine = 0; this.caretIdx = 0; this.targetLine = 0; this.targetCol = 0;
      this.undoStack = []; this.redoStack = []; this.lastUndoKind = UK_NONE;
      this.pendingBass = false; this.lastPart = 'none';
      this.clampPositions();
      this.updateContentSize();
      this.scrollTo(0, 0);
      this.updateImeAnchor();
      this.invalidate();
      this.modified = false;
      if (this.onChange) this.onChange(this);
      this.doStatus();
    }

    pasteText(text) {
      if ((this._mode === 'lyric' || this._mode === 'both') && text) this.insertLyricText(text, UK_OTHER);
    }

    transposeAll(steps) {
      if (this._mode === 'view') return;
      this.beginChange(UK_OTHER);
      for (const l of this.lines) for (const c of l.chords) c.name = Chord.transposeChord(c.name, steps);
      this.changed();
    }

    // 文字化けした行（UTF-8 を Shift-JIS などとして読んだもの）を元の文字に戻す。
    // apply = false なら数えるだけ。count は修復できる行数、preview は修復後の先頭数行
    repairGarbledText(apply) {
      let count = 0, started = false;
      const preview = [];
      for (const l of this.lines) {
        let fixed = false;
        const r = Text.repairMojibake(Text.fixSurrogates(l.text));
        if (r !== null) {
          fixed = true;
          if (preview.length < 8) preview.push(r);
          if (apply) {
            if (!started) this.beginChange(UK_OTHER);
            started = true;
            l.text = Text.cleanText(r, false);
          }
        }
        // 自由文字など、コード行の文字列も同じように修復する
        for (const c of l.chords) {
          const rc = Text.repairMojibake(c.name);
          if (rc !== null) {
            fixed = true;
            if (apply) {
              if (!started) this.beginChange(UK_OTHER);
              started = true;
              c.name = rc;
            }
          }
        }
        if (fixed) count++;
      }
      if (started) this.changed();
      return { count, preview: preview.join('\n') };
    }
  }

  LC.Editor = Editor;
  LC.DEFAULT_FONT_SIZE = DEFAULT_FONT_SIZE;
})(window.LC = window.LC || {});
