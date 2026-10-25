/* アプリ本体：メニュー・ツールバー・ファイルの読み書き・ショートカット・作業内容の自動保存
   （Lazarus 版 lyriccodeunit.pas に相当） */
(function (LC) {
  'use strict';

  const { Editor, Text, UI, PdfImport, Sheet, Cloud, Library, ChordPalette } = LC;

  /** 画面に出す版の番号。公開し直すときは sw.js の CACHE と同じ番号に上げる */
  const APP_VERSION = 'v9';

  const MODE_NAMES = { lyric: '歌詞編集', chord: 'コード編集', both: '歌詞＋コード編集', view: '閲覧' };
  const MODE_KEYS = ['lyric', 'chord', 'both', 'view'];
  /** 曲の一覧を持つ前の版の、書きかけの 1 曲（初めて開いたときに曲の一覧へ移す） */
  const DRAFT_KEY = 'lyriccode.draft';
  const SETTINGS_KEY = 'lyriccode.settings';
  const FILE_TYPES = [{ description: 'LyricCode ファイル', accept: { 'text/plain': ['.lct', '.txt'] } }];
  /** iPad のアプリ版の「Web 版へ書き出す」で作るファイルの形式 */
  const BUNDLE_FORMAT = 'lyriccode-library';
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform) || /Mac OS/.test(navigator.userAgent);
  const CTRL = isMac ? '⌘' : 'Ctrl+';

  const editor = new Editor(document.getElementById('editorHost'));
  const statusEl = document.getElementById('status');
  const titleEl = document.getElementById('docTitle');
  const openInput = document.getElementById('openInput');
  const pdfInput = document.getElementById('pdfInput');
  const freeTextBtn = document.getElementById('freeTextBtn');
  const toastEl = document.getElementById('toast');

  // コードパレット（指で操作する端末では最初から使う。「表示」→「コードパレット」で切り替えられる）
  const palette = new ChordPalette(editor, document.getElementById('chordPalette'), document.getElementById('rangeBar'), {
    toast,
    editChord: () => editChordFromPalette(),
    changed: () => { updateToolbar(); saveSettings(); },
  });
  palette.enabled = matchMedia('(pointer: coarse)').matches;
  let appearance = 'light';

  const library = new Library();
  const importInput = document.getElementById('importInput');
  let currentId = '';      // 開いている曲
  let fileHandle = null;   // 上書き保存に使うファイル（対応ブラウザのみ。開いている曲をファイルにも書くとき）
  let playing = null;      // プレイリストを表示中なら { id, index, prevMode }

  function currentSong() {
    return library.get(currentId);
  }

  function songName() {
    const s = currentSong();
    return s ? s.name : '無題';
  }

  // ---- 表示の更新 ----

  function updateCaption() {
    // プレイリストを表示中は「曲名（2/10）」
    const s = playing ? playTitle() : songName();
    titleEl.textContent = s;
    document.title = s + ' - LyricCode';
  }

  function updateStatus() {
    statusEl.textContent = '【' + MODE_NAMES[editor.mode] + '】  ' + editor.statusText();
    palette.refresh();
  }

  function updateToolbar() {
    document.querySelectorAll('.toolbar .mode').forEach((b) => {
      b.setAttribute('aria-pressed', String(b.dataset.mode === editor.mode));
    });
    freeTextBtn.setAttribute('aria-pressed', String(editor.freeText));
    document.querySelectorAll('.font-size').forEach((s) => { s.textContent = String(editor.fontSize); });
    // 閲覧中はツールバーを詰めて 1 列にし、譜面を広く見せる
    document.body.classList.toggle('viewing', editor.mode === 'view');
    palette.refresh();
  }

  // 上に出るお知らせ（2.5 秒で消える。続けて出すときは前のものを置き換える）
  let toastTimer = 0;
  function toast(text) {
    toastEl.textContent = text;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.hidden = true; }, 2500);
  }

  // 画面の明るさ（ライト / ダーク。端末の設定には合わせない。iPad のアプリ版と同じく標準はライト）
  function applyAppearance(v) {
    appearance = v === 'dark' ? 'dark' : 'light';
    document.documentElement.dataset.theme = appearance;
    editor.theme = appearance;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = appearance === 'dark' ? '#1C1C1E' : '#FFFFFF';
    palette.refresh();
  }

  function setAppearance(v) {
    applyAppearance(v);
    saveSettings();
  }

  // コードパレットを使うときは、コード入力で画面のキーボードを出さない
  function setPaletteEnabled(v) {
    palette.enabled = !!v;
    editor.chordKeyboard = !palette.enabled;
    palette.refresh();
  }

  // ---- 作業内容の自動保存（ブラウザを閉じても続きから書ける） ----

  let draftTimer = 0;

  function saveDraftSoon() {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(saveDraft, 800);
  }

  // 開いている曲の中身を曲の一覧に書き戻す（中身が変わっていなければ何もしない）
  function saveDraft() {
    clearTimeout(draftTimer);
    if (!currentSong()) return;
    library.saveOk = true;
    library.update(currentId, { text: editor.getSheetText(true), style: editor.getStyle() });
    if (!library.saveOk) statusEl.textContent = 'ブラウザの保存領域がいっぱいで、保存できませんでした';
  }

  function saveSettings() {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({
        // プレイリストの表示中は閲覧になっているので、その前のモードを覚える
        mode: playing ? playing.prevMode : editor.mode,
        freeText: editor.freeText, fontPx: editor.fontSize, splitEnabled: editor.splitEnabled,
        appearance, palette: palette.enabled, autoAdvance: editor.autoAdvance,
      }));
    } catch (e) { /* 無視 */ }
  }

  function restore() {
    let st = null;
    try { st = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null'); } catch (e) { /* 無視 */ }
    if (st) {
      if (MODE_KEYS.includes(st.mode)) editor.mode = st.mode;
      editor.freeText = !!st.freeText;
      // 文字の大きさは px（v6 まではポイントで fontSize に持っていた）
      if (st.fontPx) editor.fontSize = st.fontPx;
      else if (st.fontSize && st.fontSize !== 14) editor.fontSize = Math.round(st.fontSize * 4 / 3); // 14 は前の標準
      if (st.splitEnabled === false) editor.splitEnabled = false;
      if (typeof st.palette === 'boolean') palette.enabled = st.palette;
      if (st.autoAdvance === false) editor.autoAdvance = false;
    }
    applyAppearance(st && st.appearance);
    setPaletteEnabled(palette.enabled);
    // 前の版の書きかけの 1 曲を、曲の一覧の最初の曲にする
    if (!library.list().length) {
      let d = null;
      try { d = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null'); } catch (e) { /* 無視 */ }
      if (d && typeof d.text === 'string' && Sheet.getSheetText(Sheet.parseSheetText(d.text), false).trim() !== '') {
        library.add(baseName(d.fileName || d.suggestName) || '無題', d.text, {});
      }
    }
    const first = library.get(library.currentId) || library.list()[0];
    if (first) openSong(first.id);
    else newSong('無題');
  }

  /** 曲を開く（今の曲は保存してから） */
  function openSong(id) {
    if (currentId && id !== currentId) saveDraft();
    const s = library.get(id);
    if (!s) return;
    currentId = id;
    library.currentId = id;
    fileHandle = null;
    editor.choosingSplit = false;
    editor.setSheetText(s.text, s.style);
    editor.splitStart = s.splitLine ?? null;
    updateSplitBar();
    // 開いただけで「変わった」ことにならないよう、読み直した形をそのまま覚えておく（更新日時は変えない）
    s.text = editor.getSheetText(true);
    s.style = editor.getStyle();
    library.save();
    editor.setModified(false);
    updateCaption();
    updateStatus();
    warnBroken(s);
  }

  function newSong(name, text, style) {
    leavePlaylist();
    const s = library.add(name, text || '', style || {});
    openSong(s.id);
    return s;
  }

  editor.onChange = () => {
    updateCaption();
    saveDraftSoon();
    if (cloud) cloud.schedule();
  };
  editor.onStatus = updateStatus;
  editor.onRangeChange = () => palette.refresh();
  editor.onZoom = () => { updateToolbar(); saveSettings(); };

  // 取り込んだときに文字コードを読み取れなかった曲（「�」がある）を開いたら知らせる（曲ごとに 1 回）
  const warnedBroken = new Set();
  function warnBroken(s) {
    if (!s || warnedBroken.has(s.id) || !s.text.includes('�')) return;
    warnedBroken.add(s.id);
    setTimeout(() => UI.message('読めなかった文字があります',
      'この曲は取り込んだときに文字コードを読み取れなかったため、一部の文字が「�」になっています（元の文字には戻せません）。' +
      '元のファイルから取り込み直してください。\n文字化け（縺ｯ繧九 など）なら「編集」→「文字化けを修復...」で直せることがあります。'), 0);
  }

  // ---- 左右 2 列の閲覧の分割位置（曲ごとに覚える。iPad のアプリ版と同じ） ----

  const splitBar = document.getElementById('splitBar');

  editor.onSplitChange = (k) => {
    library.update(currentId, { splitLine: k });
    if (cloud) cloud.schedule();
    updateSplitBar();
  };

  function updateSplitBar() {
    if (editor.choosingSplit && !editor.twoColumn) editor.choosingSplit = false;
    splitBar.hidden = !editor.choosingSplit;
    if (!splitBar.hidden) {
      splitBar.querySelector('.split-info').textContent =
        `右の列は ${editor.splitAt() + 1} 行目から${editor.splitStart == null ? '（自動）' : ''}。右の列の先頭にしたい行をタップしてください`;
    }
  }

  function chooseSplit() {
    if (!editor.twoColumn) {
      UI.message('分割位置を変える', '左右 2 列になるのは、閲覧モードで画面が横長のときです（iPad は横向きにしてください）。');
      return;
    }
    editor.choosingSplit = true;
    updateSplitBar();
  }

  splitBar.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const k = editor.splitAt();
    if (b.dataset.split === 'less') editor.setSplit(k - 1);
    else if (b.dataset.split === 'more') editor.setSplit(k + 1);
    else if (b.dataset.split === 'auto') editor.setSplit(null);
    else if (b.dataset.split === 'done') editor.choosingSplit = false;
    updateSplitBar();
  });
  window.addEventListener('resize', () => setTimeout(updateSplitBar, 100));

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

  // 同期する内容：曲の一覧の全曲（曲ごとに新しい方を残す）。
  // doc は曲の一覧を持たない前の版（v2）の端末向けに、開いている曲を入れておく
  function snapshot() {
    saveDraft();
    return { library: library.snapshot(), doc: { text: editor.getSheetText(true), fileName: songName() + '.lct' } };
  }

  /** 他の端末の曲の一覧を合わせる。開いている曲が他の端末で変わっていたら読み直す */
  function mergeRemote(remote) {
    if (!remote.library) return;
    saveDraft();
    const changed = library.mergeFrom(remote.library);
    if (changed.includes(currentId)) {
      const s = library.get(currentId);
      if (s) {
        editor.setSheetText(s.text, s.style);
        editor.splitStart = s.splitLine ?? null;
        editor.setModified(false);
        statusEl.textContent = '他の端末で変更された「' + s.name + '」を読み込みました';
      } else {
        const next = library.list()[0];
        currentId = '';
        if (next) openSong(next.id); else newSong('無題');
        statusEl.textContent = '開いていた曲は、他の端末で削除されました';
      }
    }
    // 他の端末でプレイリストが変わった（曲順・削除）ときは、表示中の帯を合わせる
    if (playing) updatePlayBar();
    updateCaption();
    if (songListRefresh) songListRefresh();
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
        '<p class="dlg-message">曲の一覧の全曲を GitHub の非公開の Gist に置いて、どの端末からでも続きを編集できるようにします。' +
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
      merge: mergeRemote,
      compareKey: (data) => JSON.stringify(data.library || null),
      status: setSyncStatus,
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

  function baseName(name) {
    return (name || '').replace(/\.[^.]*$/, '');
  }

  function isEmptyDoc() {
    return editor.lines.every((l) => l.text === '' && l.chords.length === 0);
  }

  /** ファイルを曲として曲の一覧に加えて開く（同じ名前の曲があれば、置き換えるか別の曲にするか尋ねる） */
  async function loadFile(file, handle) {
    leavePlaylist();
    try {
      const text = Text.decodeFile(await file.arrayBuffer());
      const name = baseName(file.name) || '無題';
      const same = library.findByName(name);
      if (same) {
        const r = await UI.choose('ファイルを開く', `「${name}」という曲がすでにあります。どうしますか？`, [
          { key: 'cancel', label: 'キャンセル' },
          { key: 'add', label: '別の曲として加える' },
          { key: 'replace', label: '今ある曲と置き換える', primary: true }]);
        if (r === 'cancel' || r === null) { editor.focusEditor(); return; }
        if (r === 'replace') {
          saveDraft();
          library.update(same.id, { text, style: {} });
          currentId = '';
          openSong(same.id);
          fileHandle = handle || null;
          editor.focusEditor();
          return;
        }
      }
      newSong(name, text, {});
      fileHandle = handle || null;
    } catch (e) {
      await UI.message('開けませんでした', String(e.message || e));
    }
    editor.focusEditor();
  }

  async function openFile() {
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

  // 開いている曲をファイルにも書く（曲そのものは曲の一覧に自動で保存されている）。
  // 保存形式は Windows 版と同じ（UTF-8・改行 CRLF・先頭行 #LyricCode 1）。点滅・色・太字は入らない
  async function save(saveAs) {
    saveDraft();
    const bytes = Text.encodeFile(editor.getSheetText(true));
    try {
      if (!saveAs && fileHandle && fileHandle.createWritable) {
        await writeHandle(fileHandle, bytes);
      } else if (window.showSaveFilePicker) {
        const h = await window.showSaveFilePicker({ suggestedName: songName() + '.lct', types: FILE_TYPES });
        await writeHandle(h, bytes);
        fileHandle = h;
      } else {
        // ファイルを直接書けないブラウザ（Safari など）はダウンロードとして保存する
        let name = await UI.prompt('ファイルに保存', 'ファイル名', songName());
        if (name === null) { editor.focusEditor(); return false; }
        name = name.trim() || '無題';
        if (!/\.(lct|txt)$/i.test(name)) name += '.lct';
        downloadBlob(new Blob([bytes], { type: 'text/plain' }), name);
      }
    } catch (e) {
      if (e.name !== 'AbortError') await UI.message('保存できませんでした', String(e.message || e));
      editor.focusEditor();
      return false;
    }
    statusEl.textContent = 'ファイルに保存しました';
    editor.focusEditor();
    return true;
  }

  function downloadBlob(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }

  async function newDocument() {
    const name = await UI.prompt('新しい曲', '曲名', '');
    if (name === null) { editor.focusEditor(); return; }
    newSong(name.trim() || '無題');
    editor.focusEditor();
  }

  async function importPdf() {
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
        // 取り込んだ内容は新しい曲として曲の一覧に加える
        newSong(baseName(f.name), Sheet.getSheetText(lines, true), {});
        statusEl.textContent = 'PDF を新しい曲として取り込みました';
      }
    } catch (e) {
      await UI.message('PDF を読み込めませんでした', String(e.message || e));
    }
    editor.focusEditor();
  });

  // ---- 曲の一覧 ----

  let songListRefresh = null;

  async function openSongList() {
    saveDraft();
    const action = await UI.custom('曲の一覧', (body, buttons, finish) => {
      body.innerHTML = '<input type="search" class="song-search" placeholder="曲名で探す" autocomplete="off">' +
        '<p class="song-count"></p><ul class="song-list" role="listbox"></ul>';
      const search = body.querySelector('.song-search');
      const ul = body.querySelector('.song-list');
      const count = body.querySelector('.song-count');
      const render = () => {
        const q = search.value.trim().normalize('NFC').toLowerCase();
        const all = library.list();
        const songs = q ? all.filter((x) => x.name.normalize('NFC').toLowerCase().includes(q)) : all;
        count.textContent = q ? `${songs.length} / ${all.length} 曲` : `${all.length} 曲`;
        ul.textContent = '';
        for (const song of songs) {
          const li = document.createElement('li');
          li.className = 'song' + (song.id === currentId ? ' current' : '');
          const open = document.createElement('button');
          open.type = 'button';
          open.className = 'song-open';
          open.textContent = song.name;
          open.addEventListener('click', () => finish({ open: song.id }));
          const pl = document.createElement('button');
          pl.type = 'button';
          pl.className = 'song-tool';
          pl.textContent = '＋';
          pl.title = 'プレイリストに追加';
          pl.addEventListener('click', () => finish({ addTo: song.id }));
          const ren = document.createElement('button');
          ren.type = 'button';
          ren.className = 'song-tool';
          ren.textContent = '名前';
          ren.title = '名前を変える';
          ren.addEventListener('click', () => finish({ rename: song.id }));
          const dup = makeButton('song-tool', '複製', '「曲名 のコピー」を作る', () => finish({ duplicate: song.id }));
          const send = makeButton('song-tool', '送る', 'ファイル（.lct）として送る・保存する', () => finish({ send: song.id }));
          const del = document.createElement('button');
          del.type = 'button';
          del.className = 'song-tool danger';
          del.textContent = '削除';
          del.addEventListener('click', () => finish({ remove: song.id }));
          li.append(open, pl, ren, dup, send, del);
          ul.appendChild(li);
        }
      };
      search.addEventListener('input', render);
      render();
      songListRefresh = render;
      const imp = UI.addButton(buttons, '取り込む...', false, () => finish({ import: true }));
      imp.classList.add('left');
      UI.addButton(buttons, '閉じる', false, () => finish(null));
      UI.addButton(buttons, '新しい曲', true, () => finish({ create: true }));
      const cur = ul.querySelector('.current');
      if (cur) setTimeout(() => cur.scrollIntoView({ block: 'center' }), 0);
    }, null, true);
    songListRefresh = null;
    if (!action) { editor.focusEditor(); return; }
    if (action.open) {
      leavePlaylist();
      openSong(action.open);
    } else if (action.addTo) {
      await addSongToPlaylist(action.addTo);
      return openSongList();
    } else if (action.create) {
      await newDocument();
      return;
    } else if (action.import) {
      importInput.value = '';
      importInput.click();
      return;
    } else if (action.rename) {
      const song = library.get(action.rename);
      const name = song && await UI.prompt('名前を変える', '曲名', song.name);
      if (name && name.trim()) {
        library.rename(song.id, name.trim());
        updateCaption();
      }
      return openSongList();
    } else if (action.duplicate) {
      // 点滅・色・太字は複製しない（iPad のアプリ版と同じ）
      saveDraft();
      const song = library.get(action.duplicate);
      if (song) {
        const s = library.add(song.name + ' のコピー', song.text, {});
        if (cloud) cloud.schedule();
        statusEl.textContent = `「${s.name}」を作りました`;
      }
      return openSongList();
    } else if (action.send) {
      await sendSong(action.send);
      return openSongList();
    } else if (action.remove) {
      const song = library.get(action.remove);
      if (song && await UI.confirm('曲を削除', `「${song.name}」を削除しますか？\nプレイリストからも外れます（同期している他の端末からも消えます）。`)) {
        library.remove(song.id);   // プレイリストからも外れる
        if (playing) updatePlayBar();
        if (song.id === currentId) {
          currentId = '';
          const next = library.list()[0];
          if (next) openSong(next.id); else newSong('無題');
        }
        if (cloud) cloud.schedule();
      }
      return openSongList();
    }
    editor.focusEditor();
  }

  /** 曲をファイル（.lct）として送る。共有できる端末（iPad など）は共有の画面（AirDrop など）、それ以外はダウンロード */
  async function sendSong(id) {
    saveDraft();
    const song = library.get(id);
    if (!song) return;
    const name = song.name.replace(/[\\/:*?"<>|]/g, '_') + '.lct';
    const file = new File([Text.encodeFile(song.text)], name, { type: 'text/plain' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: song.name });
        return;
      } catch (e) {
        if (e.name === 'AbortError') return;
      }
    }
    downloadBlob(file, name);
  }

  /** 全曲（点滅・色・太字・プレイリストも）を 1 つのファイルに書き出す（iPad のアプリ版の「Web 版へ書き出す」と同じ形） */
  function exportAll() {
    saveDraft();
    const songs = library.list().map((s) => {
      const x = { name: s.name, text: s.text };
      const st = s.style || {};
      x.blinking = st.blinking || [];
      x.chordColors = st.chordColors || [];
      x.boldLyrics = st.boldLyrics || [];
      if (Number.isInteger(s.splitLine)) x.splitLine = s.splitLine;
      return x;
    });
    const playlists = library.playlistList().map((p) => ({
      name: p.name,
      songs: p.songs.filter((e) => library.resolve(e)).map((e) => library.entryName(e)),
    }));
    const data = { format: BUNDLE_FORMAT, version: 1, exportedAt: new Date().toISOString(), source: 'LyricCode Web 版', songs, playlists };
    downloadBlob(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), 'LyricCode 全曲.json');
    statusEl.textContent = `${songs.length} 曲とプレイリスト ${playlists.length} 件を書き出しました`;
  }

  // 取り込み：アプリ版の「Web 版へ書き出す」のファイル（.json）と、.lct・.txt（いくつでも選べる）
  importInput.addEventListener('change', async () => {
    const files = [...importInput.files];
    if (!files.length) return;
    const entries = [];
    let playlists = null;
    try {
      for (const f of files) {
        if (/\.json$/i.test(f.name)) {
          const data = JSON.parse(await f.text());
          if (!data || data.format !== BUNDLE_FORMAT || !Array.isArray(data.songs)) {
            throw new Error(`「${f.name}」は LyricCode の書き出しのファイルではありません。`);
          }
          for (const x of data.songs) {
            if (x && typeof x.text === 'string') {
              entries.push({
                name: String(x.name || '無題').normalize('NFC'), text: x.text,
                splitLine: Number.isInteger(x.splitLine) ? x.splitLine : null,
                style: { blinking: x.blinking || [], chordColors: x.chordColors || [], boldLyrics: x.boldLyrics || [] },
              });
            }
          }
          if (Array.isArray(data.playlists)) playlists = data.playlists;
        } else {
          entries.push({ name: (baseName(f.name) || '無題').normalize('NFC'), text: Text.decodeFile(await f.arrayBuffer()), style: {} });
        }
      }
    } catch (e) {
      await UI.message('取り込めませんでした', String(e.message || e));
      editor.focusEditor();
      return;
    }
    if (!entries.length) {
      await UI.message('取り込み', '取り込める曲がありませんでした。');
      editor.focusEditor();
      return;
    }
    await importEntries(entries, playlists);
  });

  async function importEntries(entries, playlists) {
    leavePlaylist();
    saveDraft();
    const dup = entries.filter((e) => library.findByName(e.name));
    let how = 'add';
    if (dup.length) {
      const r = await UI.choose('取り込み',
        `取り込む ${entries.length} 曲のうち ${dup.length} 曲は、同じ名前の曲がすでにあります。どうしますか？`, [
          { key: 'cancel', label: 'キャンセル' },
          { key: 'skip', label: '同じ名前の曲は飛ばす' },
          { key: 'add', label: '別の曲として加える' },
          { key: 'replace', label: '今ある曲と置き換える', primary: true }]);
      if (r === 'cancel' || r === null) { editor.focusEditor(); return; }
      how = r;
    }
    let added = 0, replaced = 0, firstId = '';
    for (const e of entries) {
      // 飾りは一度読み込んで、行やコードの位置に合うものだけを残す（エディタで開いたときと同じ形にする）
      const lines = Sheet.parseSheetText(e.text);
      Sheet.applyStyle(lines, e.style);
      const text = Sheet.getSheetText(lines, true), style = Sheet.getStyle(lines);
      const same = library.findByName(e.name);
      if (same && how === 'skip') continue;
      const extra = e.splitLine != null ? { splitLine: e.splitLine } : {};
      if (same && how === 'replace') {
        library.update(same.id, { text, style, splitLine: e.splitLine ?? null });
        replaced++;
        firstId = firstId || same.id;
      } else {
        const s = library.add(e.name, text, style);
        if (e.splitLine != null) library.update(s.id, extra);
        added++;
        firstId = firstId || s.id;
      }
    }
    // アプリ版のプレイリスト（曲名の並び）を入れる。同じ名前のプレイリストは曲順を置き換える
    let playlistCount = 0;
    if (playlists && playlists.length) {
      library.importPlaylists(playlists);
      playlistCount = playlists.length;
    }
    // 初めに自動でできた空の「無題」は、取り込んだら消す
    const blank = currentSong();
    if (firstId && blank && blank.id !== firstId && /^無題( \d+)?$/.test(blank.name) && isEmptyDoc()) {
      library.remove(blank.id);
      currentId = '';
    }
    if (firstId) {
      if (firstId === currentId) currentId = '';
      openSong(firstId);
    }
    if (cloud) cloud.schedule();
    await UI.message('取り込み', `${added} 曲を加え、${replaced} 曲を置き換えました。` +
      (playlistCount ? `\nプレイリスト ${playlistCount} 件も取り込みました（「♫ プレイリスト」で開けます）。` : '') +
      '\n曲名をタップすると曲の一覧が開きます。');
    editor.focusEditor();
  }

  // ---- プレイリスト（iPad のアプリ版と同じ。演奏する順に曲を並べ、閲覧で 1 曲ずつ表示する） ----

  const playBar = document.getElementById('playBar');

  function scheduleSync() {
    if (cloud) cloud.schedule();
  }

  function makeButton(cls, text, title, onClick, disabled) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.textContent = text;
    if (title) b.title = title;
    if (disabled) b.disabled = true;
    b.addEventListener('click', onClick);
    return b;
  }

  /** 表示中の「曲名（2/10）」 */
  function playTitle() {
    const p = playing && library.getPlaylist(playing.id);
    if (!p || !p.songs.length) return songName();
    return `${library.entryName(p.songs[playing.index])}（${playing.index + 1}/${p.songs.length}）`;
  }

  function updatePlayBar() {
    playBar.hidden = !playing;
    document.body.classList.toggle('playing', !!playing);
    if (!playing) return;
    const p = library.getPlaylist(playing.id);
    if (!p || !p.songs.length) { stopPlaylist(false); return; }
    if (playing.index >= p.songs.length) playing.index = p.songs.length - 1;
    const missing = !library.resolve(p.songs[playing.index]);
    playBar.querySelector('.play-list').textContent = p.name;
    playBar.querySelector('.play-title').textContent = playTitle() + (missing ? '　見つかりません' : '');
    playBar.querySelector('[data-play="prev"]').disabled = playing.index === 0;
    playBar.querySelector('[data-play="next"]').disabled = playing.index + 1 >= p.songs.length;
    updateCaption();
  }

  /** プレイリストの index 曲目から、閲覧モードで表示する */
  function startPlaylist(id, index) {
    const p = library.getPlaylist(id);
    if (!p || !p.songs.length) return;
    if (!playing) playing = { prevMode: editor.mode };
    playing.id = id;
    if (editor.mode !== 'view') {
      editor.mode = 'view';
      updateSplitBar();
      updateToolbar();
    }
    showPlayIndex(index);
    editor.focusEditor();
  }

  function showPlayIndex(i) {
    const p = library.getPlaylist(playing.id);
    if (!p) return;
    i = Math.max(0, Math.min(p.songs.length - 1, i));
    playing.index = i;
    const s = library.resolve(p.songs[i]);
    if (s) {
      if (s.id !== currentId) openSong(s.id);
    } else {
      // 曲の一覧に無い曲（削除された・取り込んでいない）は空の譜面を出す（左右のスワイプで前後の曲へ移れる）
      saveDraft();
      currentId = '';
      editor.setSheetText('');
      editor.setModified(false);
    }
    updatePlayBar();
    updateStatus();
  }

  /** 前後の曲へ（d = -1 / +1） */
  function playStep(d) {
    if (!playing) return;
    const p = library.getPlaylist(playing.id);
    if (!p) return;
    const n = playing.index + d;
    if (n < 0 || n >= p.songs.length) return;
    showPlayIndex(n);
  }

  /** プレイリストの表示を終える。toList ならそのプレイリストの曲順に戻る */
  function stopPlaylist(toList) {
    if (!playing) return;
    const { id, prevMode } = playing;
    playing = null;
    playBar.hidden = true;
    document.body.classList.remove('playing');
    if (editor.mode !== prevMode) {
      editor.mode = prevMode;
      updateSplitBar();
      updateToolbar();
    }
    // 見つからない曲を表示していたときは、前に開いていた曲に戻る
    if (!currentSong()) {
      const s = library.get(library.currentId) || library.list()[0];
      if (s) openSong(s.id); else newSong('無題');
    }
    updateCaption();
    updateStatus();
    if (toList && library.getPlaylist(id)) openPlaylist(id);
    else editor.focusEditor();
  }

  /** 別の曲を開くときなど、プレイリストの表示をやめる（曲順には戻らない） */
  function leavePlaylist() {
    if (playing) stopPlaylist(false);
  }

  playBar.addEventListener('click', (e) => {
    // 曲名をタップすると、ライトとダークを切り替える（iPad のアプリ版と同じ）
    if (e.target.closest('.play-title')) { setAppearance(appearance === 'dark' ? 'light' : 'dark'); return; }
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.play === 'prev') playStep(-1);
    else if (b.dataset.play === 'next') playStep(1);
    else if (b.dataset.play === 'exit') stopPlaylist(true);
    else if (b.dataset.cmd) run(b.dataset.cmd);
  });
  // 帯のボタンを押しても、エディタの入力欄からフォーカスを外さない
  playBar.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) e.preventDefault();
  });

  // 閲覧中の左右のスワイプで前後の曲へ。1 曲目で左から右へスワイプするとプレイリストの曲順に戻る（アプリ版と同じ）
  (() => {
    const host = document.getElementById('editorHost');
    let sx = 0, sy = 0, single = false;
    host.addEventListener('touchstart', (e) => {
      single = e.touches.length === 1;
      if (single) { sx = e.touches[0].clientX; sy = e.touches[0].clientY; }
    }, { passive: true });
    host.addEventListener('touchend', (e) => {
      if (!single || !playing || editor.mode !== 'view' || UI.isMenuOpen()) return;
      single = false;
      const t = e.changedTouches[0];
      const dx = t.clientX - sx, dy = t.clientY - sy;
      if (Math.abs(dx) <= 100 || Math.abs(dx) <= Math.abs(dy) * 2) return;
      if (dx < 0) playStep(1);
      else if (playing.index > 0) playStep(-1);
      else stopPlaylist(true);
    }, { passive: true });
  })();

  /** プレイリストの一覧 */
  async function openPlaylists() {
    saveDraft();
    const action = await UI.custom('プレイリスト', (body, buttons, finish) => {
      const list = library.playlistList();
      if (!list.length) {
        body.innerHTML = '<p class="dlg-message">プレイリストがありません。「新しいプレイリスト」で作り、演奏する順に曲を並べます。</p>';
      } else {
        const ul = document.createElement('ul');
        ul.className = 'song-list';
        list.forEach((p, k) => {
          const li = document.createElement('li');
          li.className = 'song' + (playing && playing.id === p.id ? ' current' : '');
          const open = makeButton('song-open', p.name, '', () => finish({ open: p.id }));
          const count = document.createElement('span');
          count.className = 'song-sub';
          count.textContent = `${p.songs.length} 曲`;
          open.appendChild(count);
          li.append(open,
            makeButton('song-tool', '▲', '上へ', () => finish({ move: p.id, d: -1 }), k === 0),
            makeButton('song-tool', '▼', '下へ', () => finish({ move: p.id, d: 1 }), k === list.length - 1),
            makeButton('song-tool', '名前', '名前を変える', () => finish({ rename: p.id })),
            makeButton('song-tool danger', '削除', '', () => finish({ remove: p.id })));
          ul.appendChild(li);
        });
        body.appendChild(ul);
      }
      UI.addButton(buttons, '閉じる', false, () => finish(null));
      UI.addButton(buttons, '新しいプレイリスト', true, () => finish({ create: true }));
    }, null, true);
    if (!action) { editor.focusEditor(); return; }
    if (action.open) return openPlaylist(action.open);
    if (action.create) {
      const name = await UI.prompt('新しいプレイリスト', '名前（例: 10月のライブ）', '');
      if (name === null) return openPlaylists();
      const p = library.createPlaylist(name);
      scheduleSync();
      return openPlaylist(p.id);
    }
    if (action.move) {
      library.movePlaylist(action.move, action.d);
      scheduleSync();
    } else if (action.rename) {
      const p = library.getPlaylist(action.rename);
      const name = p && await UI.prompt('名前を変える', 'プレイリストの名前', p.name);
      if (name && name.trim()) {
        library.updatePlaylist(p.id, (q) => { q.name = name.trim(); });
        scheduleSync();
        if (playing) updatePlayBar();
      }
    } else if (action.remove) {
      const p = library.getPlaylist(action.remove);
      if (p && await UI.confirm('プレイリストを削除', `「${p.name}」を削除しますか？\n（曲そのものは消えません）`)) {
        if (playing && playing.id === p.id) stopPlaylist(false);
        library.deletePlaylist(p.id);
        scheduleSync();
      }
    }
    return openPlaylists();
  }

  /** プレイリストの曲順（曲をタップするとそこから表示、▲▼で並べ替え、「外す」でプレイリストから外す） */
  async function openPlaylist(id) {
    const p = library.getPlaylist(id);
    if (!p) return openPlaylists();
    saveDraft();
    const action = await UI.custom(p.name, (body, buttons, finish) => {
      if (p.songs.length) {
        body.appendChild(makeButton('pl-play', '▶ 最初から表示', '', () => finish({ play: 0 })));
        const ul = document.createElement('ul');
        ul.className = 'song-list';
        p.songs.forEach((entry, i) => {
          const li = document.createElement('li');
          li.className = 'song' + (playing && playing.id === id && playing.index === i ? ' current' : '');
          const num = document.createElement('span');
          num.className = 'song-num';
          num.textContent = String(i + 1);
          const open = makeButton('song-open', library.entryName(entry), '', () => finish({ play: i }));
          if (!library.resolve(entry)) {
            const miss = document.createElement('span');
            miss.className = 'song-missing';
            miss.textContent = '見つかりません';
            open.appendChild(miss);
          }
          li.append(num, open,
            makeButton('song-tool', '▲', '前へ', () => finish({ move: i, d: -1 }), i === 0),
            makeButton('song-tool', '▼', '後ろへ', () => finish({ move: i, d: 1 }), i === p.songs.length - 1),
            makeButton('song-tool danger', '外す', 'プレイリストから外す（曲そのものは消えません）', () => finish({ drop: i })));
          ul.appendChild(li);
        });
        body.appendChild(ul);
      } else {
        body.innerHTML = '<p class="dlg-message">曲がありません。「曲を追加」で、演奏する順に曲を選びます。</p>';
      }
      const back = UI.addButton(buttons, '‹ プレイリスト', false, () => finish({ back: true }));
      back.classList.add('left');
      UI.addButton(buttons, '閉じる', false, () => finish(null));
      UI.addButton(buttons, '曲を追加', true, () => finish({ add: true }));
    }, null, true);
    if (!action) { editor.focusEditor(); return; }
    if (action.back) return openPlaylists();
    if (action.play !== undefined) { startPlaylist(id, action.play); return; }
    if (action.move !== undefined) {
      library.updatePlaylist(id, (q) => {
        const i = action.move, j = i + action.d;
        if (j < 0 || j >= q.songs.length) return;
        [q.songs[i], q.songs[j]] = [q.songs[j], q.songs[i]];
      });
      scheduleSync();
    } else if (action.drop !== undefined) {
      library.updatePlaylist(id, (q) => { q.songs.splice(action.drop, 1); });
      scheduleSync();
    } else if (action.add) {
      const ids = await pickSongs();
      if (ids && ids.length) {
        library.updatePlaylist(id, (q) => { q.songs = q.songs.concat(ids); });
        scheduleSync();
      }
    }
    if (playing && playing.id === id) updatePlayBar();
    return openPlaylist(id);
  }

  /** プレイリストに足す曲を選ぶ。選んだ順に番号が付き、その順の曲の id を返す（キャンセルは null） */
  function pickSongs() {
    const picked = [];
    return UI.custom('曲を追加', (body, buttons, finish) => {
      body.innerHTML = '<input type="search" class="song-search" placeholder="曲名で探す" autocomplete="off">' +
        '<p class="song-count">選んだ順にプレイリストの最後へ足します。あとで並べ替えもできます。</p>' +
        '<ul class="song-list pick-list"></ul>';
      const search = body.querySelector('.song-search');
      const ul = body.querySelector('.song-list');
      let addBtn = null;
      const render = () => {
        const q = search.value.trim().normalize('NFC').toLowerCase();
        const all = library.list();
        const songs = q ? all.filter((x) => x.name.normalize('NFC').toLowerCase().includes(q)) : all;
        ul.textContent = '';
        for (const song of songs) {
          const li = document.createElement('li');
          const k = picked.indexOf(song.id);
          li.className = 'song' + (k >= 0 ? ' picked' : '');
          const b = makeButton('song-open', song.name, '', () => {
            const at = picked.indexOf(song.id);
            if (at >= 0) picked.splice(at, 1); else picked.push(song.id);
            render();
          });
          const badge = document.createElement('span');
          badge.className = 'pick-num';
          badge.textContent = k >= 0 ? String(k + 1) : '';
          b.appendChild(badge);
          li.appendChild(b);
          ul.appendChild(li);
        }
        if (addBtn) {
          addBtn.textContent = picked.length ? `追加（${picked.length}）` : '追加';
          addBtn.disabled = !picked.length;
        }
      };
      UI.addButton(buttons, 'キャンセル', false, () => finish(null));
      addBtn = UI.addButton(buttons, '追加', true, () => finish(picked.slice()));
      search.addEventListener('input', render);
      render();
    }, null, true);
  }

  /** 曲の一覧の「＋」：曲をプレイリストの最後に足す */
  async function addSongToPlaylist(songId) {
    const song = library.get(songId);
    if (!song) return;
    const r = await UI.custom('プレイリストに追加', (body, buttons, finish) => {
      const msg = document.createElement('p');
      msg.className = 'dlg-message';
      msg.textContent = `「${song.name}」を、どのプレイリストの最後に足しますか？`;
      body.appendChild(msg);
      const list = library.playlistList();
      if (list.length) {
        const ul = document.createElement('ul');
        ul.className = 'song-list';
        for (const p of list) {
          const li = document.createElement('li');
          li.className = 'song';
          const b = makeButton('song-open', p.name, '', () => finish({ to: p.id }));
          const count = document.createElement('span');
          count.className = 'song-sub';
          count.textContent = `${p.songs.length} 曲`;
          b.appendChild(count);
          li.appendChild(b);
          ul.appendChild(li);
        }
        body.appendChild(ul);
      }
      UI.addButton(buttons, 'キャンセル', false, () => finish(null));
      UI.addButton(buttons, '新しいプレイリストを作って追加', !list.length, () => finish({ create: true }));
    }, null);
    if (!r) return;
    let id = r.to;
    if (r.create) {
      const name = await UI.prompt('新しいプレイリスト', '名前（例: 10月のライブ）', '');
      if (name === null) return;
      id = library.createPlaylist(name).id;
    }
    library.updatePlaylist(id, (q) => { q.songs.push(songId); });
    scheduleSync();
    if (playing && playing.id === id) updatePlayBar();
    statusEl.textContent = `「${song.name}」を「${library.getPlaylist(id).name}」に追加しました`;
  }

  // ---- 編集 ----

  // 貼り付けた文字がコード譜か（LyricCode の保存形式、またはコードだけの行とその下の歌詞の行がある）。
  // iPad のアプリ版などで「全体をテキストとしてコピー」したものを、コードの位置ごと取り込むため
  function looksLikeChordSheet(text) {
    const lines = Sheet.splitLines(text || '');
    if (lines.length > 0 && lines[0].startsWith('#LyricCode')) return true;
    for (let i = 0; i + 1 < lines.length; i++) {
      if (LC.Chord.isChordLine(lines[i]) && lines[i + 1].trim() !== '' && !LC.Chord.isChordLine(lines[i + 1])) return true;
    }
    return false;
  }

  async function handlePaste(text) {
    if (!text) return;
    if ((editor.mode === 'lyric' || editor.mode === 'both' || editor.mode === 'chord') && looksLikeChordSheet(text)) {
      let load = isEmptyDoc();
      if (!load) {
        const r = await UI.choose('コード譜の貼り付け', '貼り付ける文字はコード譜のようです。どのように貼り付けますか？', [
          { key: 'cancel', label: 'キャンセル' },
          { key: 'lyric', label: '歌詞として挿入' },
          { key: 'new', label: '新しい曲として加える' },
          { key: 'sheet', label: '今の曲と置き換える', primary: true }]);
        if (r === 'cancel' || r === null) { editor.focusEditor(); return; }
        if (r === 'new') {
          const name = await UI.prompt('新しい曲', '曲名', '');
          if (name !== null) {
            newSong(name.trim() || '無題', text, {});
            statusEl.textContent = 'コード譜を新しい曲として加えました';
          }
          editor.focusEditor();
          return;
        }
        load = r === 'sheet';
      }
      if (load) {
        // 「元に戻す」で戻せるよう、今の曲の中身として読み込む
        editor.replaceAll(text);
        statusEl.textContent = 'コード譜を読み込みました';
        editor.focusEditor();
        return;
      }
    }
    editor.pasteText(text);
    editor.focusEditor();
  }

  editor.onPaste = handlePaste;

  async function paste() {
    let text;
    try {
      text = await navigator.clipboard.readText();
    } catch (e) {
      await UI.message('貼り付け', 'クリップボードを読めませんでした。\n' + CTRL + 'V で貼り付けてください。');
      editor.focusEditor();
      return;
    }
    await handlePaste(text);
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
    updateSplitBar();
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

  // 歌詞の太字（カーソルのある行をまるごと切り替える）
  function toggleBold() {
    if (editor.mode !== 'lyric' && editor.mode !== 'both') {
      statusEl.textContent = '太字は、歌詞編集か歌詞＋コード編集で、太字にしたい行にカーソルを置いてから押してください';
    } else if (!editor.toggleBoldLine()) {
      statusEl.textContent = '歌詞のない行は太字にできません';
    }
    editor.focusEditor();
  }

  function toggleSplit() {
    editor.splitEnabled = !editor.splitEnabled;
    saveSettings();
    updateSplitBar();
  }

  // 文字の大きさ：1 回で ±2（10～44。標準は 18。iPad のアプリ版と同じ）
  function zoom(d) {
    editor.fontSize = d === 0 ? LC.DEFAULT_FONT_SIZE : editor.fontSize + d * 2;
    updateToolbar();
    saveSettings();
  }

  // パレットの「直接入力」：コード名を入れる（空にするとコードを削除）
  async function editChordFromPalette() {
    const t = editor.targetChord();
    const s = await UI.prompt('コード名を入力', '例: C#m7/G#（空にするとコードを削除します）', t ? t.chord.name : '');
    if (s !== null) editor.paletteOp('rename', s);
    editor.focusEditor();
  }

  // テキストで編集：コードだけの行を歌詞の行の上に書いた形で、全体をまとめて直す（点滅・色・太字は消える）
  async function textEdit() {
    if (editor.mode === 'view') {
      await UI.message('テキストで編集', '閲覧モードでは使えません。編集のモードにしてから選んでください。');
      return;
    }
    const before = editor.getSheetText(false).replace(/\r\n/g, '\n');
    const text = await UI.custom('テキストで編集', (body, buttons, finish) => {
      body.innerHTML = '<p class="hint">コードだけの行を、対応する歌詞の行のすぐ上に書きます。' +
        'コードの位置は空白で合わせます（半角 1 文字＝1 桁、全角 1 文字＝2 桁）。点滅・コードの色・歌詞の太字は消えます。</p>' +
        '<textarea class="text-edit" spellcheck="false" autocapitalize="off" autocomplete="off" wrap="off"></textarea>';
      const ta = body.querySelector('textarea');
      ta.value = before;
      const pasteBtn = UI.addButton(buttons, 'クリップボードから貼り付け', false, async () => {
        try {
          const s = await navigator.clipboard.readText();
          if (s) ta.value = ta.value === '' ? s : ta.value.replace(/\n?$/, '\n') + s;
        } catch (e) {
          ta.focus();
        }
      });
      pasteBtn.classList.add('left');
      UI.addButton(buttons, 'キャンセル', false, () => finish(null));
      UI.addButton(buttons, '完了', true, () => finish(ta.value));
    }, null, true);
    if (text !== null && text !== before) editor.replaceAll(text);
    editor.focusEditor();
  }

  // ---- 画面を消さない（前面にいる間。iPad のアプリ版と同じ。明るさはブラウザからは変えられない） ----

  let wakeLock = null;
  async function keepAwake() {
    if (!('wakeLock' in navigator) || document.visibilityState !== 'visible' || wakeLock) return;
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch (e) {
      wakeLock = null;
    }
  }
  document.addEventListener('visibilitychange', keepAwake);
  // ブラウザによっては、画面を触ってからでないと頼めない
  document.addEventListener('pointerdown', keepAwake, { passive: true });

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
        ['右クリック・長押し（コードの上）', '点滅させる・色を付ける（この行のコードすべてにもできます）'],
        ['右クリック・長押し', '範囲コピー・貼り付け・範囲を選んで点滅／色（終わりの位置のコード行をタップして決める）'],
        ['Delete / BackSpace', '削除 / 末尾を 1 文字削除'],
        ['ドラッグ・Shift+矢印', 'コードを移動（矢印だけなら入力位置を移動）'],
        ['', '歌詞のない所や最終行より下にも入力できます（行は自動で追加）'],
        ['日本語入力', 'オンのままでもコードを入力できます'],
      ]) +
      '<h3>コードパレット（iPad など指で操作するとき。「表示」→「コードパレット」）</h3>' +
      '<p>コード行をタップすると、下にパレットが出ます（iPad のアプリ版と同じ）。C～B で基音、♯♭、種類（m・7・m7 など）、' +
      '音符・小節線・||:・:||・ベース音・直接入力・削除を選べます。「入力後に右へ」がオンなら、置いた後に入力位置が 1 桁空けて右へ進み、' +
      '続けて種類を押すと直前のコードに付きます（A → m → 7 で Am7）。' +
      '‹ › で入力位置、← → でコードを動かします（「右側も一緒に」で同じ行の右側のコードもまとめて動かす。ドラッグでも同じ）。⏮ ⏭ で前後のコードへ。' +
      '「範囲コピー」「点滅」「色」は、始まりが今の位置で、終わりの位置のコード行をタップして範囲を決めます（「行で選ぶ」で行ごと）。' +
      'パレットを使うときは、コード入力で画面のキーボードは出ません。</p>' +
      '<h3>自由文字入力（Ctrl+Shift+F・ツールバーの「自由文字」）</h3>' +
      '<p>コード行に、打った文字（サビ、×2、rit. など）をそのまま置きます。空白で次の位置へ進みます。</p>' +
      '<h3>歌詞の行・テキストで編集・文字の大きさ・画面</h3>' +
      '<p>「編集」→「上に行を挿入」「下に行を挿入」「行を削除」。「テキストで編集...」では、コード行と歌詞行をテキストのまま全体を直せます（点滅・色・太字は消えます）。' +
      '文字の大きさは A− / A＋ か 2 本指のピンチで変えます（全曲共通）。「表示」→「画面の明るさ」でライト / ダークを選べます' +
      '（プレイリストの表示中は、上の帯の曲名をタップしても切り替わります）。開いている間は画面を消さないようにします。</p>' +
      '<h3>ショートカット</h3>' +
      t([
        ['Alt+L / Alt+P / Alt+N', '曲の一覧 / プレイリスト / 新しい曲'],
        [CTRL + 'O / ' + CTRL + 'S', 'ファイルを開く / ファイルに上書き保存（' + CTRL + 'Shift+S で名前を付けて保存）'],
        [CTRL + 'B', '歌詞の太字（カーソルの行をまるごと切り替え）'],
        [CTRL + 'I', 'PDF のコード譜を読み込む'],
        [CTRL + 'Z / ' + CTRL + 'Y', '元に戻す / やり直し'],
        [CTRL + 'V', '歌詞を貼り付け'],
        [CTRL + 'Shift+E', 'コード譜をテキストとしてコピー'],
        [CTRL + 'Shift+↑↓', '全体を移調'],
        [CTRL + '+ / ' + CTRL + '- / ' + CTRL + '0', '拡大 / 縮小 / 標準サイズ（' + CTRL + 'ホイールでも拡大縮小）'],
      ]) +
      '<h3>曲の一覧（「☰ 曲の一覧」・右上の曲名）</h3>' +
      '<p>曲はすべてブラウザの中に自動で保存されます（保存の操作は要りません）。一覧から曲を開く・新しい曲を作る・名前を変える・複製する・' +
      'ファイルとして送る（iPad では AirDrop など）・削除するができます。「ファイル」→「全曲を書き出す」で全曲を 1 つのファイルに残せます（「取り込む...」で戻せます）。' +
      'コードの点滅・色と歌詞の太字も曲と一緒に保存されます（.lct には入らないので、Windows 版やファイルに保存したときには付きません）。</p>' +
      '<h3>プレイリスト（「♫ プレイリスト」・Alt+P）</h3>' +
      '<p>演奏する順に曲を並べておき、閲覧で 1 曲ずつ表示します（iPad のアプリ版と同じ）。' +
      '「新しいプレイリスト」で作り、「曲を追加」で曲を選んだ順に足します（曲の一覧の「＋」でも足せます）。▲▼で並べ替え、「外す」でプレイリストから外します（曲そのものは消えません）。' +
      '「▶ 最初から表示」か曲をタップすると、上の帯に「曲名（2/10）」が出て、◀▶・左右のスワイプ・←→ キーで前後の曲に移れます。' +
      '「‹ 曲順」（1 曲目で左から右へスワイプ・Esc）で曲順に戻ります。プレイリストも他の端末と同期します。</p>' +
      '<h3>iPad のアプリ版からの引っ越し</h3>' +
      '<p>アプリ版の「…」→「Web 版へ書き出す」で、全曲（点滅・色・太字も）が「ファイル」の「この iPad 内 › LyricCode › Web版へ」に書き出されます。' +
      'ここで「曲の一覧」→「取り込む...」を押してそのファイル（LyricCode 全曲.json）を選ぶと、全曲が曲の一覧に入ります。' +
      '.lct・.txt のファイルも、いくつでもまとめて選んで取り込めます。</p>' +
      '<h3>左右 2 列（閲覧・横長の画面）</h3>' +
      '<p>閲覧モードで画面が横長のとき（iPad を横向きにしたときなど）は、左の列から右の列へ続けて表示します。' +
      '「表示」→「分割位置を変える...」で、右の列の先頭にする行をタップして選べます（曲ごとに覚えます）。' +
      '「表示」→「左右 2 列」で、2 列にしないこともできます。</p>' +
      '<h3>ファイル</h3>' +
      '<p>保存形式（.lct）は Windows 版の LyricCode と同じです。「ファイルを開く」で開いたファイルは曲の一覧に加わります。' +
      '「ファイルに保存」は開いている曲を .lct として書き出します（Safari など、ファイルを直接上書きできないブラウザではダウンロードになります）。' +
      'コード譜の文字を貼り付けると、歌詞として入れるか、新しい曲にするか、今の曲と置き換えるかを選べます。</p>' +
      '<h3>他の端末との同期（右上の ☁）</h3>' +
      '<p>GitHub の非公開の Gist を使って、曲の一覧の全曲を端末どうしで同期します。PC で途中まで書いて、iPad で続きを書けます。' +
      '「gist」の権限だけの GitHub のトークンを、同期したい端末ごとに一度登録してください（Lyricker と同じトークンで構いません）。' +
      '編集すると数秒後に自動で送られ、画面を開いたとき・戻ったとき・1 分ごとに他の端末の変更を読み込みます。' +
      '曲ごとに、あとから編集した方が残ります（同じ曲を両方の端末で同時に編集すると、先に編集した方の変更は消えます）。</p>' +
      `<p class="version-line">LyricCode Web 版 ${APP_VERSION}</p>` +
      '</div>');
  }

  // ---- コマンド ----

  const commands = {
    new: newDocument,
    songs: openSongList,
    playlists: openPlaylists,
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
    bold: toggleBold,
    textEdit,
    exportAll,
    insertAbove: () => { editor.insertLine(false); editor.focusEditor(); },
    insertBelow: () => { editor.insertLine(true); editor.focusEditor(); },
    deleteLine: () => { editor.deleteLine(); editor.focusEditor(); },
    palette: () => { setPaletteEnabled(!palette.enabled); saveSettings(); editor.focusEditor(); },
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
      { label: '曲の一覧...', shortcut: 'Alt+L', cmd: 'songs' },
      { label: 'プレイリスト...', shortcut: 'Alt+P', cmd: 'playlists' },
      { label: '新しい曲...', shortcut: 'Alt+N', cmd: 'new' },
      '-',
      { label: 'ファイルを開く...', shortcut: CTRL + 'O', cmd: 'open' },
      { label: 'ファイルに上書き保存', shortcut: CTRL + 'S', cmd: 'save' },
      { label: 'ファイルに保存...', shortcut: CTRL + 'Shift+S', cmd: 'saveAs' },
      '-',
      { label: 'PDF を読み込む...', shortcut: CTRL + 'I', cmd: 'importPdf' },
      { label: '全曲を書き出す（バックアップ）', cmd: 'exportAll' },
      '-',
      { label: '他の端末との同期...', cmd: 'sync' },
    ],
    edit: () => [
      { label: '元に戻す', shortcut: CTRL + 'Z', cmd: 'undo', disabled: !editor.canUndo() },
      { label: 'やり直し', shortcut: CTRL + 'Y', cmd: 'redo', disabled: !editor.canRedo() },
      '-',
      { label: '歌詞を貼り付け', shortcut: CTRL + 'V', cmd: 'paste' },
      { label: '全体をテキストとしてコピー', shortcut: CTRL + 'Shift+E', cmd: 'copyAll' },
      { label: 'テキストで編集...', cmd: 'textEdit', disabled: editor.mode === 'view' },
      { label: '文字化けを修復...', cmd: 'repair' },
      '-',
      { label: '上に行を挿入', cmd: 'insertAbove', disabled: editor.mode === 'view' },
      { label: '下に行を挿入', cmd: 'insertBelow', disabled: editor.mode === 'view' },
      { label: '行を削除', cmd: 'deleteLine', disabled: editor.mode === 'view' },
      '-',
      { label: '移調 ＋半音', shortcut: CTRL + 'Shift+↑', cmd: 'transposeUp' },
      { label: '移調 －半音', shortcut: CTRL + 'Shift+↓', cmd: 'transposeDown' },
      '-',
      { label: '自由文字入力', shortcut: CTRL + 'Shift+F', cmd: 'freeText', checked: editor.freeText },
      { label: '歌詞の太字（カーソルの行）', shortcut: CTRL + 'B', cmd: 'bold' },
    ],
    mode: () => MODE_KEYS.map((m, i) => ({
      label: MODE_NAMES[m], shortcut: 'Alt+' + (i + 1), checked: editor.mode === m, onClick: () => setMode(m),
    })),
    view: () => [
      {
        label: '画面の明るさ',
        submenu: [
          { label: '☀ ライト', checked: appearance === 'light', onClick: () => setAppearance('light') },
          { label: '☾ ダーク', checked: appearance === 'dark', onClick: () => setAppearance('dark') },
        ],
      },
      { label: 'コードパレット（指で操作するとき）', checked: palette.enabled, cmd: 'palette' },
      '-',
      { label: '左右 2 列（横長の画面の閲覧）', checked: editor.splitEnabled, onClick: toggleSplit },
      { label: '分割位置を変える...', disabled: !editor.twoColumn, onClick: chooseSplit },
      '-',
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
  // 曲名をタップすると曲の一覧を開く
  titleEl.addEventListener('click', openSongList);
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
    // プレイリストの閲覧中：←→ で前後の曲、Esc で曲順に戻る
    if (playing && editor.mode === 'view' && !ctrl && !e.altKey && !e.shiftKey) {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if (e.key === 'Escape') stopPlaylist(true);
        else playStep(e.key === 'ArrowLeft' ? -1 : 1);
        return;
      }
    }
    let cmd = null;
    if (ctrl && !e.altKey) {
      if (k === 'o' && !e.shiftKey) cmd = 'open';
      else if (k === 's') cmd = e.shiftKey ? 'saveAs' : 'save';
      else if (k === 'i' && !e.shiftKey) cmd = 'importPdf';
      else if (k === 'z' && !e.shiftKey) cmd = 'undo';
      else if (k === 'y' || (k === 'z' && e.shiftKey)) cmd = 'redo';
      else if (k === 'e' && e.shiftKey) cmd = 'copyAll';
      else if (k === 'f' && e.shiftKey) cmd = 'freeText';
      else if (k === 'b' && !e.shiftKey) cmd = 'bold';
      else if (k === 'ArrowUp' && e.shiftKey) cmd = 'transposeUp';
      else if (k === 'ArrowDown' && e.shiftKey) cmd = 'transposeDown';
      else if (k === '=' || k === '+' || k === ';' || e.code === 'NumpadAdd') cmd = 'zoomIn';
      else if (k === '-' || e.code === 'NumpadSubtract') cmd = 'zoomOut';
      else if (k === '0') cmd = 'zoomReset';
    } else if (e.altKey && !ctrl) {
      const m = /^Digit([1-4])$/.exec(e.code);
      if (m) { setMode(MODE_KEYS[Number(m[1]) - 1]); e.preventDefault(); return; }
      if (e.code === 'KeyN') cmd = 'new';
      else if (e.code === 'KeyL') cmd = 'songs';
      else if (e.code === 'KeyP') cmd = 'playlists';
    } else if (e.key === 'F1') {
      cmd = 'help';
    }
    if (cmd) {
      e.preventDefault();
      e.stopPropagation();
      run(cmd);
    }
  }, true);

  // 曲は曲の一覧に自動で保存しているので、閉じるときに尋ねない
  window.addEventListener('beforeunload', saveDraft);

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
