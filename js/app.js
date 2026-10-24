/* アプリ本体：メニュー・ツールバー・ファイルの読み書き・ショートカット・作業内容の自動保存
   （Lazarus 版 lyriccodeunit.pas に相当） */
(function (LC) {
  'use strict';

  const { Editor, Text, UI, PdfImport, Sheet, Cloud } = LC;

  /** 画面に出す版の番号。公開し直すときは sw.js の CACHE と同じ番号に上げる */
  const APP_VERSION = 'v1';

  const MODE_NAMES = { lyric: '歌詞編集', chord: 'コード編集', both: '歌詞＋コード編集', view: '閲覧' };
  const MODE_KEYS = ['lyric', 'chord', 'both', 'view'];
  const DRAFT_KEY = 'lyriccode.draft';
  const SETTINGS_KEY = 'lyriccode.settings';
  const FILE_TYPES = [{ description: 'LyricCode ファイル', accept: { 'text/plain': ['.lct', '.txt'] } }];
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform) || /Mac OS/.test(navigator.userAgent);
  const CTRL = isMac ? '⌘' : 'Ctrl+';

  const editor = new Editor(document.getElementById('editorHost'));
  const statusEl = document.getElementById('status');
  const titleEl = document.getElementById('docTitle');
  const openInput = document.getElementById('openInput');
  const pdfInput = document.getElementById('pdfInput');
  const freeTextBtn = document.getElementById('freeTextBtn');

  let fileName = '';       // 表示用のファイル名（未保存なら空）
  let fileHandle = null;   // 上書き保存に使うファイル（対応ブラウザのみ）
  let suggestName = '';    // 保存時のファイル名の候補（PDF から取り込んだときなど）

  // ---- 表示の更新 ----

  function updateCaption() {
    let s = fileName || '無題';
    if (editor.modified) s += ' *';
    titleEl.textContent = s;
    document.title = s + ' - LyricCode';
  }

  function updateStatus() {
    statusEl.textContent = '【' + MODE_NAMES[editor.mode] + '】  ' + editor.statusText();
  }

  function updateToolbar() {
    document.querySelectorAll('.toolbar .mode').forEach((b) => {
      b.setAttribute('aria-pressed', String(b.dataset.mode === editor.mode));
    });
    freeTextBtn.setAttribute('aria-pressed', String(editor.freeText));
  }

  // ---- 作業内容の自動保存（ブラウザを閉じても続きから書ける） ----

  let draftTimer = 0;

  function saveDraftSoon() {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(saveDraft, 800);
  }

  function saveDraft() {
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify({
        text: editor.getSheetText(true), fileName, suggestName, modified: editor.modified,
      }));
    } catch (e) { /* 保存できなくても動作は続ける */ }
  }

  function saveSettings() {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({
        mode: editor.mode, freeText: editor.freeText, fontSize: editor.fontSize,
      }));
    } catch (e) { /* 無視 */ }
  }

  function restore() {
    try {
      const st = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
      if (st) {
        if (MODE_KEYS.includes(st.mode)) editor.mode = st.mode;
        editor.freeText = !!st.freeText;
        if (st.fontSize) editor.fontSize = st.fontSize;
      }
      const d = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null');
      if (d && typeof d.text === 'string') {
        editor.setSheetText(d.text);
        fileName = d.fileName || '';
        suggestName = d.suggestName || '';
        editor.setModified(!!d.modified);
      }
    } catch (e) { /* 無視 */ }
  }

  editor.onChange = () => {
    updateCaption();
    saveDraftSoon();
    if (cloud) cloud.schedule();
  };
  editor.onStatus = updateStatus;

  // ---- 他の端末との同期（GitHub の非公開の Gist。Lyricker と同じ方式） ----

  let cloud = null;
  let lastSyncError = '';
  const syncBtn = document.getElementById('syncBtn');
  const syncText = document.getElementById('syncText');

  function setSyncStatus(kind, text, detail) {
    syncBtn.dataset.kind = kind;
    syncText.textContent = text;
    syncBtn.title = detail ? `${text}\n${detail}` : `他の端末との同期（${text}）`;
    // 同期できなくても、ほかの機能はそのまま使える。
    // 1 分ごとに同期を試すので、同じエラーが続く間は最初の 1 回だけ知らせる
    if (kind === 'error') {
      if (detail !== lastSyncError) statusEl.textContent = text + ': ' + String(detail || '').split('\n')[0];
      lastSyncError = detail;
    } else if (kind === 'ok' || kind === 'off') {
      lastSyncError = '';
    }
  }

  // 同期する内容：作業中のコード譜（保存形式のテキスト）と、表示用のファイル名
  function snapshot() {
    return { doc: { text: editor.getSheetText(true), fileName, suggestName } };
  }

  function applyRemote(remote) {
    const d = remote.doc || {};
    editor.setSheetText(d.text || '');
    fileName = d.fileName || '';
    suggestName = d.suggestName || '';
    fileHandle = null;
    // この端末にはまだ保存していない内容なので、変更ありとして扱う
    editor.setModified(Sheet.getSheetText(editor.lines, false).trim() !== '');
    updateCaption();
    saveDraft();
  }

  function isEmptyDoc() {
    return editor.lines.every((l) => l.text === '' && l.chords.length === 0);
  }

  function previewOf(doc) {
    if (!doc || !doc.text) return '（空）';
    const lines = Sheet.getSheetText(Sheet.parseSheetText(doc.text), false, '\n').split('\n');
    const head = lines.slice(0, 12).join('\n').trimEnd();
    return (doc.fileName ? '［' + doc.fileName + '］\n' : '') + (head || '（空）') + (lines.length > 13 ? '\n…' : '');
  }

  /** 競合したとき、どちらを残すかを選んでもらう */
  function resolveConflict(remote, local) {
    const when = remote.updatedAt ? new Date(remote.updatedAt).toLocaleString('ja-JP') : '';
    return UI.custom('他の端末でも編集されています', (body, buttons, finish) => {
      body.innerHTML = '<p class="dlg-message">この端末と他の端末の両方で、前回の同期のあとに編集されました。' +
        'どちらの内容を残しますか？</p><div class="conflict"><div><b>他の端末</b> <span class="info"></span>' +
        '<pre class="remote"></pre></div><div><b>この端末</b><pre class="local"></pre></div></div>';
      body.querySelector('.info').textContent = `（${remote.device || '不明'}・${when}）`;
      body.querySelector('.remote').textContent = previewOf(remote.doc);
      body.querySelector('.local').textContent = previewOf(local.doc);
      UI.addButton(buttons, 'あとで', false, () => finish(null));
      UI.addButton(buttons, 'この端末の内容を残す', false, () => finish('local'));
      UI.addButton(buttons, '他の端末の内容を読み込む', true, () => finish('remote'));
    }, null, true);
  }

  async function startSync(token) {
    saveDraft();
    setSyncStatus('busy', '同期の準備中…');
    try {
      await cloud.setup(token);
    } catch (e) {
      setSyncStatus('error', '同期エラー', e.message);
      await UI.message('同期エラー', e.message);
    }
  }

  async function openSyncDialog() {
    const sharedToken = cloud.enabled ? '' : Cloud.lyrickerToken();
    const action = await UI.custom('他の端末との同期', (body, buttons, finish) => {
      body.innerHTML =
        '<p class="dlg-message">作業中のコード譜を GitHub の非公開の Gist に置いて、どの端末からでも続きを編集できるようにします。' +
        'PC で途中まで書いて、iPad で続きを書く、といった使い方ができます。</p>' +
        '<p class="sync-state"></p>' +
        '<div class="token-area">' +
        '<p class="shared" hidden>この端末の Lyricker で登録済みのトークンが見つかりました。そのまま使えます。</p>' +
        '<ol class="steps">' +
        '<li><a href="https://github.com/settings/tokens/new?scopes=gist&amp;description=LyricCode" target="_blank" rel="noopener">GitHub のトークン作成画面</a>を開く（GitHub にログイン）</li>' +
        '<li>「gist」だけにチェックが入っていることを確かめ、有効期限を選んで「Generate token」</li>' +
        '<li>表示された「ghp_…」で始まる文字列をコピーして、下に貼り付ける</li></ol>' +
        '<label>GitHub のトークン（Gist の権限だけのもの。Lyricker と同じトークンで構いません）' +
        '<input type="password" class="token" autocomplete="off" spellcheck="false" placeholder="ghp_..."></label>' +
        '<p class="note">トークンはこの端末のブラウザの中に保存されます。同期したい端末ごとに一度だけ登録してください（同じトークンで構いません）。</p>' +
        '</div>';
      const state = body.querySelector('.sync-state');
      const area = body.querySelector('.token-area');
      const input = body.querySelector('.token');
      state.textContent = cloud.enabled
        ? `同期しています（${syncText.textContent}・同期先 Gist ${cloud.meta.gistId.slice(0, 7)}）。トークンは登録済みなので、入れ直す必要はありません。`
        : 'まだ同期していません。';
      if (sharedToken) body.querySelector('.shared').hidden = false;
      const stop = UI.addButton(buttons, '同期を止める', false, () => finish('stop'));
      stop.disabled = !cloud.enabled;
      stop.classList.add('left');
      UI.addButton(buttons, '閉じる', false, () => finish(null));
      const change = UI.addButton(buttons, 'トークンを変更', false, () => show(true));
      const now = UI.addButton(buttons, '今すぐ同期', true, () => finish('now'));
      const useShared = UI.addButton(buttons, 'Lyricker と同じトークンで同期', true, () => finish({ token: sharedToken }));
      const ok = UI.addButton(buttons, '保存して同期', true, () => {
        const token = input.value.trim();
        if (!token) { input.focus(); input.placeholder = 'トークンを貼り付けてください'; return; }
        finish({ token });
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); ok.click(); }
      });
      // トークンの入力欄は、同期していないときと「トークンを変更」のときだけ出す
      const show = (v) => {
        area.hidden = !v;
        ok.hidden = !v;
        useShared.hidden = !(v && sharedToken);
        if (useShared.hidden === false) ok.classList.remove('primary');
        now.hidden = v;
        change.hidden = v;
        if (v) input.focus();
      };
      show(!cloud.enabled);
    }, null);
    if (action === 'now') cloud.syncNow();
    else if (action === 'stop') {
      if (await UI.confirm('同期を止める', 'この端末の同期を止めます。よろしいですか？\n（この端末の内容と、GitHub の Gist はそのまま残ります）')) cloud.stop();
    } else if (action && action.token) {
      await startSync(action.token);
    }
    editor.focusEditor();
  }

  function initCloud() {
    cloud = new Cloud.GistSync({
      snapshot,
      apply: applyRemote,
      isEmpty: isEmptyDoc,
      status: setSyncStatus,
      resolve: resolveConflict,
    });
    syncBtn.addEventListener('click', openSyncDialog);
    document.addEventListener('visibilitychange', () => {
      // 戻ってきたら他の端末の更新を見に行き、離れるときはこの端末の変更を送る
      if (document.visibilityState === 'visible') cloud.pullSoon();
      else cloud.syncNow();
    });
    if (cloud.enabled) cloud.syncNow();
    else setSyncStatus('off', '同期: オフ');
  }

  // ---- ファイル ----

  async function confirmSave() {
    if (!editor.modified) return true;
    const r = await UI.choose('LyricCode', '変更内容を保存しますか？', [
      { key: 'cancel', label: 'キャンセル' },
      { key: 'no', label: '保存しない' },
      { key: 'yes', label: '保存する', primary: true }]);
    if (r === 'yes') return save(false);
    return r === 'no';
  }

  function baseName(name) {
    return (name || '').replace(/\.[^.]*$/, '');
  }

  async function loadFile(file, handle) {
    try {
      const text = Text.decodeFile(await file.arrayBuffer());
      editor.setSheetText(text);
      fileName = file.name;
      fileHandle = handle || null;
      suggestName = '';
      updateCaption();
      saveDraft();
    } catch (e) {
      await UI.message('開けませんでした', String(e.message || e));
    }
    editor.focusEditor();
  }

  async function openFile() {
    if (!(await confirmSave())) return;
    if (window.showOpenFilePicker) {
      try {
        const [h] = await window.showOpenFilePicker({ types: FILE_TYPES, multiple: false });
        await loadFile(await h.getFile(), h);
      } catch (e) {
        if (e.name !== 'AbortError') await UI.message('開けませんでした', String(e.message || e));
      }
      return;
    }
    openInput.value = '';
    openInput.click();
  }

  openInput.addEventListener('change', () => {
    if (openInput.files[0]) loadFile(openInput.files[0], null);
  });

  async function writeHandle(h, bytes) {
    const w = await h.createWritable();
    await w.write(bytes);
    await w.close();
  }

  // 保存形式は Windows 版と同じ（UTF-8・改行 CRLF・先頭行 #LyricCode 1）
  async function save(saveAs) {
    const bytes = Text.encodeFile(editor.getSheetText(true));
    try {
      if (!saveAs && fileHandle && fileHandle.createWritable) {
        await writeHandle(fileHandle, bytes);
      } else if (window.showSaveFilePicker) {
        const h = await window.showSaveFilePicker({
          suggestedName: (baseName(fileName || suggestName) || '無題') + '.lct', types: FILE_TYPES,
        });
        await writeHandle(h, bytes);
        fileHandle = h;
        fileName = h.name;
      } else {
        // ファイルを直接書けないブラウザ（Safari など）はダウンロードとして保存する
        let name = await UI.prompt('名前を付けて保存', 'ファイル名', baseName(fileName || suggestName) || '無題');
        if (name === null) { editor.focusEditor(); return false; }
        name = name.trim() || '無題';
        if (!/\.(lct|txt)$/i.test(name)) name += '.lct';
        const blob = new Blob([bytes], { type: 'text/plain' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 10000);
        fileName = name;
      }
    } catch (e) {
      if (e.name !== 'AbortError') await UI.message('保存できませんでした', String(e.message || e));
      editor.focusEditor();
      return false;
    }
    suggestName = '';
    editor.setModified(false);
    updateCaption();
    saveDraft();
    editor.focusEditor();
    return true;
  }

  async function newDocument() {
    if (!(await confirmSave())) return;
    editor.newDocument();
    fileName = '';
    fileHandle = null;
    suggestName = '';
    updateCaption();
    saveDraft();
    editor.focusEditor();
  }

  async function importPdf() {
    if (!(await confirmSave())) return;
    pdfInput.value = '';
    pdfInput.click();
  }

  pdfInput.addEventListener('change', async () => {
    const f = pdfInput.files[0];
    if (!f) return;
    statusEl.textContent = 'PDF を読み込んでいます...';
    try {
      const lines = await PdfImport.importPdf(await f.arrayBuffer());
      if (!lines.length) {
        await UI.message('PDF の読み込み', 'PDF から文字を取り出せませんでした。\nスキャンした画像の PDF には文字の情報が含まれていません。');
      } else {
        editor.assignLines(lines);
        // 取り込んだ内容は未保存の新しい文書として扱う
        fileName = '';
        fileHandle = null;
        suggestName = baseName(f.name) + '.lct';
        editor.setModified(true);
        updateCaption();
        saveDraft();
      }
    } catch (e) {
      await UI.message('PDF を読み込めませんでした', String(e.message || e));
    }
    updateStatus();
    editor.focusEditor();
  });

  // ---- 編集 ----

  async function paste() {
    try {
      editor.pasteText(await navigator.clipboard.readText());
    } catch (e) {
      await UI.message('貼り付け', 'クリップボードを読めませんでした。\n' + CTRL + 'V で貼り付けてください。');
    }
    editor.focusEditor();
  }

  async function copyAll() {
    try {
      await navigator.clipboard.writeText(editor.getSheetText(false));
      statusEl.textContent = 'コード譜をテキストとしてコピーしました';
    } catch (e) {
      await UI.message('コピー', 'クリップボードに書き込めませんでした。');
    }
    editor.focusEditor();
  }

  // 読み込み済みの文字化けした文字列（UTF-8 を Shift-JIS などとして読んだもの）を元に戻す
  async function repair() {
    const r = editor.repairGarbledText(false);
    if (r.count === 0) {
      await UI.message('文字化けを修復',
        '修復できる文字化けは見つかりませんでした。\n\n' +
        'UTF-8 の文字を Shift-JIS・Windows-1252・ISO-8859-1・MacRoman として読んだときの文字化け' +
        '（例: 縺ｯ繧九・、ã¯ã‚‹）を元に戻せます。');
      editor.focusEditor();
      return;
    }
    const ok = await UI.confirm('文字化けを修復',
      `${r.count} 行を修復できます。修復後の内容（先頭の数行）:\n\n${r.preview}\n\n` +
      '修復しますか？（「元に戻す」で取り消せます）\n※ 一部の文字は復元できず「�」になることがあります。');
    if (ok) editor.repairGarbledText(true);
    editor.focusEditor();
  }

  function setMode(m) {
    editor.mode = m;
    updateToolbar();
    updateStatus();
    saveSettings();
    editor.focusEditor();
  }

  function toggleFreeText() {
    editor.freeText = !editor.freeText;
    updateToolbar();
    saveSettings();
    editor.focusEditor();
  }

  function zoom(d) {
    editor.fontSize = d === 0 ? LC.DEFAULT_FONT_SIZE : editor.fontSize + d * 2;
    saveSettings();
  }

  function help() {
    const t = (rows) => '<table>' + rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('') + '</table>';
    return UI.showHtml('操作方法', '<div class="help">' +
      '<h3>モード（Alt+1～4）</h3>' +
      '<p>歌詞編集 / コード編集 / 歌詞＋コード編集 / 閲覧。歌詞＋コード編集では、コード行（色付きの帯）を指すとコード入力、歌詞行を指すと歌詞入力になります。</p>' +
      '<h3>コード入力（入力したい位置を指してキーを押す）</h3>' +
      t([
        ['C D E F G A B', '基音（既存のコードの上なら基音を変更）'],
        ['基音の直後の b', 'フラット（例: e → b で Eb）'],
        ['#', 'シャープの付け外し'],
        ['/ に続けて基音', 'オンコード（例: C / e → C/E）'],
        ['m・数字など', 'コード名の末尾に追記（例: c m 7 → Cm7）'],
        ['数字（空いた位置）', '数字をそのまま入力（例: 2 → 4 で 24）'],
        ['|', '小節線（空いている位置に入力）'],
        ['右クリック・長押し', '空いた位置では基音・小節線・音符を選択、コードの上では種類（m, 7, m7, maj7, dim など）を選択'],
        ['Enter・ダブルクリック', 'コード名を直接入力'],
        ['Delete / BackSpace', '削除 / 末尾を 1 文字削除'],
        ['ドラッグ・Shift+矢印', 'コードを移動（矢印だけなら入力位置を移動）'],
        ['', '歌詞のない所や最終行より下にも入力できます（行は自動で追加）'],
        ['日本語入力', 'オンのままでもコードを入力できます'],
      ]) +
      '<h3>自由文字入力（Ctrl+Shift+F・ツールバーの「自由文字」）</h3>' +
      '<p>コード行に、打った文字（サビ、×2、rit. など）をそのまま置きます。空白で次の位置へ進みます。</p>' +
      '<h3>ショートカット</h3>' +
      t([
        [CTRL + 'O / ' + CTRL + 'S', '開く / 上書き保存（' + CTRL + 'Shift+S で名前を付けて保存）'],
        ['Alt+N', '新規'],
        [CTRL + 'I', 'PDF のコード譜を読み込む'],
        [CTRL + 'Z / ' + CTRL + 'Y', '元に戻す / やり直し'],
        [CTRL + 'V', '歌詞を貼り付け'],
        [CTRL + 'Shift+E', 'コード譜をテキストとしてコピー'],
        [CTRL + 'Shift+↑↓', '全体を移調'],
        [CTRL + '+ / ' + CTRL + '- / ' + CTRL + '0', '拡大 / 縮小 / 標準サイズ（' + CTRL + 'ホイールでも拡大縮小）'],
      ]) +
      '<h3>ファイル</h3>' +
      '<p>保存形式（.lct）は Windows 版の LyricCode と同じです。Safari など、ファイルを直接上書きできないブラウザでは、保存するとダウンロードになります。' +
      '書きかけの内容はブラウザに自動で保存され、次に開いたときに続きから書けます。</p>' +
      '<h3>他の端末との同期（右上の ☁）</h3>' +
      '<p>GitHub の非公開の Gist を使って、作業中のコード譜を端末どうしで同期します。PC で途中まで書いて、iPad で続きを書けます。' +
      '「gist」の権限だけの GitHub のトークンを、同期したい端末ごとに一度登録してください（Lyricker と同じトークンで構いません）。' +
      '編集すると数秒後に自動で送られ、画面を開いたとき・戻ったとき・1 分ごとに他の端末の変更を読み込みます。' +
      '両方の端末で同時に編集した場合は、どちらを残すか選ぶ画面が出ます。</p>' +
      `<p class="version-line">LyricCode Web 版 ${APP_VERSION}</p>` +
      '</div>');
  }

  // ---- コマンド ----

  const commands = {
    new: newDocument,
    open: openFile,
    save: () => save(false),
    saveAs: () => save(true),
    importPdf,
    sync: () => openSyncDialog(),
    undo: () => { editor.undo(); editor.focusEditor(); },
    redo: () => { editor.redo(); editor.focusEditor(); },
    paste,
    copyAll,
    repair,
    transposeUp: () => { editor.transposeAll(1); editor.focusEditor(); },
    transposeDown: () => { editor.transposeAll(-1); editor.focusEditor(); },
    freeText: toggleFreeText,
    zoomIn: () => zoom(1),
    zoomOut: () => zoom(-1),
    zoomReset: () => zoom(0),
    help: async () => { await help(); editor.focusEditor(); },
  };

  function run(cmd) {
    const f = commands[cmd];
    if (f) f();
  }

  const MENUS = {
    file: () => [
      { label: '新規', shortcut: 'Alt+N', cmd: 'new' },
      { label: '開く...', shortcut: CTRL + 'O', cmd: 'open' },
      { label: '上書き保存', shortcut: CTRL + 'S', cmd: 'save' },
      { label: '名前を付けて保存...', shortcut: CTRL + 'Shift+S', cmd: 'saveAs' },
      '-',
      { label: 'PDF を読み込む...', shortcut: CTRL + 'I', cmd: 'importPdf' },
      '-',
      { label: '他の端末との同期...', cmd: 'sync' },
    ],
    edit: () => [
      { label: '元に戻す', shortcut: CTRL + 'Z', cmd: 'undo', disabled: !editor.canUndo() },
      { label: 'やり直し', shortcut: CTRL + 'Y', cmd: 'redo', disabled: !editor.canRedo() },
      '-',
      { label: '歌詞を貼り付け', shortcut: CTRL + 'V', cmd: 'paste' },
      { label: '全体をテキストとしてコピー', shortcut: CTRL + 'Shift+E', cmd: 'copyAll' },
      { label: '文字化けを修復...', cmd: 'repair' },
      '-',
      { label: '移調 ＋半音', shortcut: CTRL + 'Shift+↑', cmd: 'transposeUp' },
      { label: '移調 －半音', shortcut: CTRL + 'Shift+↓', cmd: 'transposeDown' },
      '-',
      { label: '自由文字入力', shortcut: CTRL + 'Shift+F', cmd: 'freeText', checked: editor.freeText },
    ],
    mode: () => MODE_KEYS.map((m, i) => ({
      label: MODE_NAMES[m], shortcut: 'Alt+' + (i + 1), checked: editor.mode === m, onClick: () => setMode(m),
    })),
    view: () => [
      { label: '拡大', shortcut: CTRL + '+', cmd: 'zoomIn' },
      { label: '縮小', shortcut: CTRL + '-', cmd: 'zoomOut' },
      { label: '標準サイズ', shortcut: CTRL + '0', cmd: 'zoomReset' },
    ],
    help: () => [{ label: '操作方法', shortcut: 'F1', cmd: 'help' }],
  };

  document.querySelectorAll('.menubar button').forEach((btn) => {
    btn.addEventListener('click', () => {
      const items = MENUS[btn.dataset.menu]().map((it) => (it === '-' ? it : {
        ...it,
        onClick: it.onClick || (() => run(it.cmd)),
      }));
      const r = btn.getBoundingClientRect();
      btn.classList.add('open');
      UI.showMenu(items, r.left, r.bottom + 2, () => btn.classList.remove('open'));
    });
  });

  document.querySelectorAll('.toolbar [data-cmd]').forEach((b) => b.addEventListener('click', () => run(b.dataset.cmd)));
  document.querySelectorAll('.toolbar .mode').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
  freeTextBtn.addEventListener('click', toggleFreeText);
  // ツールバーのボタンを押しても、エディタの入力欄からフォーカスを外さない
  document.querySelector('.toolbar').addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) e.preventDefault();
  });

  // ---- ショートカット ----

  window.addEventListener('keydown', (e) => {
    if (document.querySelector('dialog[open]') || UI.isMenuOpen()) return;
    if (e.isComposing || e.keyCode === 229) return;
    const ctrl = e.ctrlKey || e.metaKey;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    let cmd = null;
    if (ctrl && !e.altKey) {
      if (k === 'o' && !e.shiftKey) cmd = 'open';
      else if (k === 's') cmd = e.shiftKey ? 'saveAs' : 'save';
      else if (k === 'i' && !e.shiftKey) cmd = 'importPdf';
      else if (k === 'z' && !e.shiftKey) cmd = 'undo';
      else if (k === 'y' || (k === 'z' && e.shiftKey)) cmd = 'redo';
      else if (k === 'e' && e.shiftKey) cmd = 'copyAll';
      else if (k === 'f' && e.shiftKey) cmd = 'freeText';
      else if (k === 'ArrowUp' && e.shiftKey) cmd = 'transposeUp';
      else if (k === 'ArrowDown' && e.shiftKey) cmd = 'transposeDown';
      else if (k === '=' || k === '+' || k === ';' || e.code === 'NumpadAdd') cmd = 'zoomIn';
      else if (k === '-' || e.code === 'NumpadSubtract') cmd = 'zoomOut';
      else if (k === '0') cmd = 'zoomReset';
    } else if (e.altKey && !ctrl) {
      const m = /^Digit([1-4])$/.exec(e.code);
      if (m) { setMode(MODE_KEYS[Number(m[1]) - 1]); e.preventDefault(); return; }
      if (e.code === 'KeyN') cmd = 'new';
    } else if (e.key === 'F1') {
      cmd = 'help';
    }
    if (cmd) {
      e.preventDefault();
      e.stopPropagation();
      run(cmd);
    }
  }, true);

  window.addEventListener('beforeunload', (e) => {
    saveDraft();
    if (editor.modified) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  // ---- 起動 ----

  restore();
  updateToolbar();
  updateCaption();
  updateStatus();
  document.getElementById('appVersion').textContent = APP_VERSION;
  initCloud();
  editor.focusEditor();

  // 閉じる直前に、待っている保存を済ませる
  addEventListener('pagehide', saveDraft);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') saveDraft();
  });

  // ホーム画面に追加したときにオフラインでも起動できるようにする（https か localhost のときだけ使える）
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register('sw.js').catch(() => { /* 無視 */ });
    // 新しい版が届いたら、作業内容を保存してから読み込み直す（初めて開いたときは除く）
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController) return;
      saveDraft();
      location.reload();
    });
    // ホーム画面のアプリは閉じても裏で残っていて、開き直しても読み込み直されない。
    // 画面に戻ってきたときに新しい版が出ていないか確かめる
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        navigator.serviceWorker.getRegistration().then((r) => r && r.update()).catch(() => { /* 無視 */ });
      }
    });
  }

  LC.app = { editor, run, cloud };
})(window.LC = window.LC || {});
