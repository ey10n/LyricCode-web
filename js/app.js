/* アプリ本体：メニュー・ツールバー・ファイルの読み書き・ショートカット・作業内容の自動保存
   （Lazarus 版 lyriccodeunit.pas に相当） */
(function (LC) {
  'use strict';

  const { Editor, Text, UI, PdfImport, Sheet, Cloud, Library } = LC;

  /** 画面に出す版の番号。公開し直すときは sw.js の CACHE と同じ番号に上げる */
  const APP_VERSION = 'v4';

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

  const library = new Library();
  const importInput = document.getElementById('importInput');
  let currentId = '';      // 開いている曲
  let fileHandle = null;   // 上書き保存に使うファイル（対応ブラウザのみ。開いている曲をファイルにも書くとき）

  function currentSong() {
    return library.get(currentId);
  }

  function songName() {
    const s = currentSong();
    return s ? s.name : '無題';
  }

  // ---- 表示の更新 ----

  function updateCaption() {
    const s = songName();
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
        mode: editor.mode, freeText: editor.freeText, fontSize: editor.fontSize, splitEnabled: editor.splitEnabled,
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
        if (st.splitEnabled === false) editor.splitEnabled = false;
      }
    } catch (e) { /* 無視 */ }
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
  }

  function newSong(name, text, style) {
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
          const ren = document.createElement('button');
          ren.type = 'button';
          ren.className = 'song-tool';
          ren.textContent = '名前';
          ren.title = '名前を変える';
          ren.addEventListener('click', () => finish({ rename: song.id }));
          const del = document.createElement('button');
          del.type = 'button';
          del.className = 'song-tool danger';
          del.textContent = '削除';
          del.addEventListener('click', () => finish({ remove: song.id }));
          li.append(open, ren, del);
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
      openSong(action.open);
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
    } else if (action.remove) {
      const song = library.get(action.remove);
      if (song && await UI.confirm('曲を削除', `「${song.name}」を削除しますか？\n（同期している他の端末からも消えます）`)) {
        library.remove(song.id);
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
    if (playlists) {
      library.playlists = playlists;
      library.save();
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
    await UI.message('取り込み', `${added} 曲を加え、${replaced} 曲を置き換えました。\n曲名をタップすると曲の一覧が開きます。`);
    editor.focusEditor();
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
        ['右クリック・長押し（コードの上）', '点滅させる・色を付ける（この行のコードすべてにもできます）'],
        ['Delete / BackSpace', '削除 / 末尾を 1 文字削除'],
        ['ドラッグ・Shift+矢印', 'コードを移動（矢印だけなら入力位置を移動）'],
        ['', '歌詞のない所や最終行より下にも入力できます（行は自動で追加）'],
        ['日本語入力', 'オンのままでもコードを入力できます'],
      ]) +
      '<h3>自由文字入力（Ctrl+Shift+F・ツールバーの「自由文字」）</h3>' +
      '<p>コード行に、打った文字（サビ、×2、rit. など）をそのまま置きます。空白で次の位置へ進みます。</p>' +
      '<h3>ショートカット</h3>' +
      t([
        ['Alt+L / Alt+N', '曲の一覧 / 新しい曲'],
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
      '<p>曲はすべてブラウザの中に自動で保存されます（保存の操作は要りません）。一覧から曲を開く・新しい曲を作る・名前を変える・削除するができます。' +
      'コードの点滅・色と歌詞の太字も曲と一緒に保存されます（.lct には入らないので、Windows 版やファイルに保存したときには付きません）。</p>' +
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
      { label: '新しい曲...', shortcut: 'Alt+N', cmd: 'new' },
      '-',
      { label: 'ファイルを開く...', shortcut: CTRL + 'O', cmd: 'open' },
      { label: 'ファイルに上書き保存', shortcut: CTRL + 'S', cmd: 'save' },
      { label: 'ファイルに保存...', shortcut: CTRL + 'Shift+S', cmd: 'saveAs' },
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
      { label: '歌詞の太字（カーソルの行）', shortcut: CTRL + 'B', cmd: 'bold' },
    ],
    mode: () => MODE_KEYS.map((m, i) => ({
      label: MODE_NAMES[m], shortcut: 'Alt+' + (i + 1), checked: editor.mode === m, onClick: () => setMode(m),
    })),
    view: () => [
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
