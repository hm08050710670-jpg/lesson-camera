/* GOLF GUTS CAMERA
 * 撮影データはすべてこの端末内（ブラウザ内）で処理し、外部サーバーへは送信しません。
 */
(function () {
  'use strict';

  var VERSION = '1.0.0';
  var CFG = window.GGC_CONFIG || {};
  CFG.logo = CFG.logo || {};
  CFG.video = CFG.video || {};
  CFG.audio = CFG.audio || {};
  CFG.photo = CFG.photo || {};

  var $ = function (id) { return document.getElementById(id); };
  var app = $('app'), video = $('cam'), canvas = $('comp');
  var ctx = canvas.getContext('2d', { alpha: false });

  var state = {
    screen: 'camera',        // 'camera' | 'review'
    mode: CFG.defaultMode === 'photo' ? 'photo' : 'video',
    facing: 'environment',   // 'environment'（アウト） | 'user'（イン）
    stream: null,
    hasAudio: false,
    camToken: 0,
    busy: false,
    logo: null,
    logoStatus: 'loading',   // 'loading' | 'ok' | 'missing'
    rawMode: false,          // 非常用：ロゴ合成なしで録画
    recording: false,
    stopping: false,
    sizeLocked: false,
    recorder: null,
    recMime: '',
    canvasStream: null,
    chunks: [],
    recStart: 0,
    recElapsed: 0,
    timer: null,
    pending: null,           // 確認画面に表示中のデータ
    sharing: false,
    wakeLock: null
  };

  /* ───────── 端末内の一時保管（IndexedDB） ─────────
   * 録画データを1秒ごとに書き込み、アプリが落ちても撮影済みの動画を復元できるようにする。
   * 保管するのは「未保存の1件」だけ。撮影に戻る／次の撮影を始める時に削除する。 */
  var DB = {
    _p: null,
    open: function () {
      if (!this._p) {
        this._p = new Promise(function (res, rej) {
          var r = indexedDB.open('ggc-db', 1);
          r.onupgradeneeded = function () {
            r.result.createObjectStore('meta');
            r.result.createObjectStore('chunks', { autoIncrement: true });
          };
          r.onsuccess = function () { res(r.result); };
          r.onerror = function () { rej(r.error); };
        });
      }
      return this._p;
    },
    run: function (stores, mode, fn) {
      return this.open().then(function (d) {
        return new Promise(function (res, rej) {
          var t = d.transaction(stores, mode), req;
          t.oncomplete = function () { res(req ? req.result : undefined); };
          t.onerror = t.onabort = function () { rej(t.error); };
          req = fn(t);
        });
      }).catch(function (e) { console.warn('[GGC] 一時保管エラー', e); return undefined; });
    },
    clear: function () {
      return this.run(['meta', 'chunks'], 'readwrite', function (t) {
        t.objectStore('meta').clear(); t.objectStore('chunks').clear();
      });
    },
    setMeta: function (m) {
      return this.run(['meta'], 'readwrite', function (t) { t.objectStore('meta').put(m, 'current'); });
    },
    getMeta: function () {
      return this.run(['meta'], 'readonly', function (t) { return t.objectStore('meta').get('current'); });
    },
    addChunk: function (b) {
      return this.run(['chunks'], 'readwrite', function (t) { t.objectStore('chunks').add(b); });
    },
    getChunks: function () {
      return this.run(['chunks'], 'readonly', function (t) { return t.objectStore('chunks').getAll(); })
        .then(function (a) { return a || []; });
    }
  };

  /* ───────── 画面部品 ───────── */
  var toastTimer = null;
  function toast(msg, ms) {
    var el = $('toast');
    el.textContent = msg; el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, ms || 3200);
  }
  function showProgress(msg) { $('progressText').textContent = msg; $('progress').hidden = false; }
  function hideProgress() { $('progress').hidden = true; }

  function ask(title, text, buttons) {
    return new Promise(function (resolve) {
      $('modalTitle').textContent = title;
      $('modalText').textContent = text;
      var box = $('modalBtns');
      box.textContent = '';
      buttons.forEach(function (b) {
        var el = document.createElement('button');
        el.type = 'button';
        el.textContent = b.label;
        if (b.cls) el.className = b.cls;
        el.addEventListener('click', function () { $('modal').hidden = true; resolve(b.value); });
        box.appendChild(el);
      });
      $('modal').hidden = false;
    });
  }
  function alertBox(title, text) { return ask(title, text, [{ label: 'OK', value: 'ok', cls: 'primary' }]); }

  function fmtTime(sec) {
    sec = Math.max(0, Math.floor(sec));
    var m = Math.floor(sec / 60), s = sec % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }
  function fmtSize(bytes) {
    if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + ' MB';
    return Math.max(1, Math.round(bytes / 1024)) + ' KB';
  }
  function baseMime(m) { return (m || '').split(';')[0].trim().toLowerCase(); }
  function extFor(mime) {
    if (mime === 'video/mp4') return 'mp4';
    if (mime === 'video/webm') return 'webm';
    if (mime === 'video/quicktime') return 'mov';
    if (mime === 'image/jpeg') return 'jpg';
    if (mime === 'image/png') return 'png';
    return 'bin';
  }
  function fileName(mime, when) {
    var d = new Date(when || Date.now());
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return 'GOLFGUTS_' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '_' +
      p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()) + '.' + extFor(mime);
  }

  /* ───────── ロゴ ───────── */
  function loadLogo() {
    var files = (CFG.logo.files && CFG.logo.files.length) ? CFG.logo.files.slice() : ['logo.png'];
    function tryNext() {
      if (!files.length) { state.logoStatus = 'missing'; state.logo = null; updateBadges(); return; }
      var img = new Image();
      img.onload = function () {
        if (img.naturalWidth > 0 && img.naturalHeight > 0) {
          state.logo = img; state.logoStatus = 'ok'; updateBadges();
        } else { tryNext(); }
      };
      img.onerror = tryNext;
      img.src = files.shift();
    }
    tryNext();
  }

  // ロゴの描画位置を計算する（縦横比は必ず維持し、画面の端からはみ出さない）
  function logoRect(w, h) {
    var img = state.logo;
    if (!img) return null;
    var L = CFG.logo, s = Math.min(w, h);
    var margin = Math.round(s * (L.marginRatio != null ? L.marginRatio : 0.035));
    var ar = img.naturalWidth / img.naturalHeight;
    var lw = s * (L.widthRatio || 0.3), lh = lw / ar;
    var maxH = Math.min(s * (L.maxHeightRatio || 0.2), h - margin * 2);
    if (lh > maxH) { lh = maxH; lw = lh * ar; }
    var maxW = w - margin * 2;
    if (lw > maxW) { lw = maxW; lh = lw / ar; }
    lw = Math.round(lw); lh = Math.round(lh);
    var pos = L.position || 'bottom-right';
    var x = pos.indexOf('left') >= 0 ? margin : w - margin - lw;
    var y = pos.indexOf('top') >= 0 ? margin : h - margin - lh;
    return { x: x, y: y, w: lw, h: lh };
  }
  function drawLogo(c, w, h) {
    var r = logoRect(w, h);
    if (!r) return;
    var op = CFG.logo.opacity;
    c.globalAlpha = (op != null && op >= 0 && op <= 1) ? op : 1;
    c.drawImage(state.logo, r.x, r.y, r.w, r.h);
    c.globalAlpha = 1;
  }

  function updateBadges() {
    $('logoNotice').hidden = !(state.logoStatus === 'missing' && !state.recording);
    $('micBadge').hidden = !(state.stream && !state.hasAudio);
    $('rawBadge').hidden = !state.rawMode;
  }

  /* ───────── カメラ ───────── */
  function stopStream() {
    if (state.stream) {
      state.stream.getTracks().forEach(function (t) { t.onended = null; try { t.stop(); } catch (e) {} });
      state.stream = null;
    }
    try { video.srcObject = null; } catch (e) {}
  }

  function cameraError(err) {
    var name = err && err.name, title, text;
    if (!window.isSecureContext) {
      title = '安全な接続（HTTPS）が必要です';
      text = 'カメラは https:// で始まるアドレスでのみ使えます。\nGitHub Pages の公開アドレス（https://〜.github.io/〜）から開いてください。';
    } else if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      title = 'このブラウザではカメラを使えません';
      text = 'iPhoneの Safari で開いてください。\nLINEなどアプリ内のブラウザで開いている場合は、右下や右上のメニューから「Safariで開く」を選んでください。';
    } else if (name === 'NotAllowedError' || name === 'SecurityError') {
      title = 'カメラが許可されていません';
      text = '① 下の「もう一度試す」を押し、確認が表示されたら「許可」を選んでください。\n\n② 確認が表示されない場合は、iPhoneの「設定」→（「アプリ」→）「Safari」→「カメラ」と「マイク」を「確認」または「許可」に変更し、このアプリを開き直してください。';
    } else if (name === 'NotFoundError' || name === 'OverconstrainedError') {
      title = 'カメラが見つかりません';
      text = '使用できるカメラが見つかりませんでした。\nほかのアプリを閉じてから「もう一度試す」を押してください。';
    } else if (name === 'NotReadableError' || name === 'AbortError') {
      title = 'カメラを起動できません';
      text = 'ほかのアプリや通話がカメラを使用中の可能性があります。\nそれらを終了してから「もう一度試す」を押してください。';
    } else {
      title = 'カメラを起動できません';
      text = 'アプリを開き直すか、iPhoneを再起動してからお試しください。\n（エラー: ' + (name || String(err)) + '）';
    }
    $('camMsgTitle').textContent = title;
    $('camMsgText').textContent = text;
    $('camMsg').hidden = false;
  }

  function startCamera() {
    var token = ++state.camToken;
    stopStream();
    $('camMsg').hidden = true;
    if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      cameraError(null);
      return Promise.resolve(false);
    }
    var V = CFG.video;
    var videoC = {
      facingMode: { ideal: state.facing },
      width: { ideal: V.width || 1920 },
      height: { ideal: V.height || 1080 },
      frameRate: { ideal: V.frameRate || 30 }
    };
    var audioC = CFG.audio.natural === false ? true :
      { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
    var gum = function (c) { return navigator.mediaDevices.getUserMedia(c); };

    // 1) 映像＋音声 → 2) 映像のみ（マイク拒否時） → 3) 条件をゆるめた映像のみ
    return gum({ video: videoC, audio: audioC })
      .catch(function () { return gum({ video: videoC, audio: false }); })
      .catch(function (e) {
        // 利用者が拒否した場合は、確認を何度も出さない
        if (e && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) throw e;
        return gum({ video: { facingMode: state.facing }, audio: false });
      })
      .then(function (stream) {
        if (token !== state.camToken || state.screen !== 'camera') {
          stream.getTracks().forEach(function (t) { t.stop(); });
          return false;
        }
        state.stream = stream;
        state.hasAudio = stream.getAudioTracks().length > 0;
        var vt = stream.getVideoTracks()[0];
        if (vt) {
          // 実際に選ばれたカメラの向きに合わせる
          var st = vt.getSettings ? vt.getSettings() : {};
          if (st.facingMode === 'user' || st.facingMode === 'environment') state.facing = st.facingMode;
          vt.onended = onTrackEnded;
        }
        app.classList.toggle('front', state.facing === 'user');
        video.srcObject = stream;
        var p = video.play();
        if (p && p.catch) p.catch(function () {});
        updateBadges();
        if (!state.hasAudio && !startCamera._micWarned) {
          startCamera._micWarned = true;
          toast('マイクが使えないため、動画は音声なしで録画されます', 4500);
        }
        startLoop();
        requestWakeLock();
        return true;
      })
      .catch(function (err) {
        if (token !== state.camToken) return false;
        console.warn('[GGC] カメラ起動エラー', err);
        cameraError(err);
        return false;
      });
  }

  function onTrackEnded() {
    if (state.recording) { stopRecording('ended'); return; }
    if (state.screen === 'camera' && !document.hidden) startCamera();
  }

  function requestWakeLock() {
    if (!navigator.wakeLock || state.wakeLock) return;
    navigator.wakeLock.request('screen').then(function (l) {
      state.wakeLock = l;
      l.addEventListener('release', function () { state.wakeLock = null; });
    }).catch(function () {});
  }

  /* ───────── 合成ループ（カメラ映像＋ロゴ → canvas） ───────── */
  var loopOn = false, loopGen = 0, lastDraw = 0, lastVfc = 0;

  function drawFrame() {
    var vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return;
    // 録画中は動画サイズを固定する（途中で本体を回しても動画が壊れないように）
    if (!state.sizeLocked && (canvas.width !== vw || canvas.height !== vh)) {
      canvas.width = vw; canvas.height = vh;
    }
    var cw = canvas.width, ch = canvas.height;
    if (vw === cw && vh === ch) {
      ctx.drawImage(video, 0, 0, cw, ch);
    } else {
      var sc = Math.min(cw / vw, ch / vh), dw = vw * sc, dh = vh * sc;
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, cw, ch);
      ctx.drawImage(video, (cw - dw) / 2, (ch - dh) / 2, dw, dh);
    }
    if (!state.rawMode) drawLogo(ctx, cw, ch);
    lastDraw = performance.now();
  }

  function startLoop() {
    if (loopOn) return;
    loopOn = true;
    var gen = ++loopGen;
    var fps = CFG.video.frameRate || 30;
    var minGap = 1000 / fps - 4;
    var useVfc = typeof video.requestVideoFrameCallback === 'function';
    lastVfc = performance.now();

    function onVfc() {
      if (!loopOn || gen !== loopGen) return;
      lastVfc = performance.now();
      if (state.mode === 'video') drawFrame();
      video.requestVideoFrameCallback(onVfc);
    }
    function onRaf() {
      if (!loopOn || gen !== loopGen) return;
      var now = performance.now();
      // 映像フレーム通知が使えない／止まっている場合は、画面更新に合わせて描画する
      if (state.mode === 'video' && (!useVfc || now - lastVfc > 400) && now - lastDraw >= minGap) drawFrame();
      requestAnimationFrame(onRaf);
    }
    if (useVfc) video.requestVideoFrameCallback(onVfc);
    requestAnimationFrame(onRaf);
  }
  function stopLoop() { loopOn = false; loopGen++; }

  /* ───────── モード・カメラ切り替え ───────── */
  function setMode(mode) {
    if (state.recording || state.busy) return;
    state.mode = mode;
    app.classList.toggle('mode-photo', mode === 'photo');
    app.classList.toggle('mode-video', mode === 'video');
    $('shutter').setAttribute('aria-label', mode === 'photo' ? '写真を撮る' : '録画開始');
    if (mode === 'video') drawFrame();
  }

  function flipCamera() {
    if (state.recording || state.busy) return;
    state.busy = true;
    state.facing = state.facing === 'user' ? 'environment' : 'user';
    startCamera().then(function () { state.busy = false; });
  }

  /* ───────── 写真 ───────── */
  function takePhoto() {
    if (state.busy || !state.stream) return;
    var vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) { toast('カメラの準備中です'); return; }
    state.busy = true;
    var f = $('flash');
    f.classList.remove('on'); void f.offsetWidth; f.classList.add('on');
    var c = document.createElement('canvas');
    c.width = vw; c.height = vh;
    var x = c.getContext('2d', { alpha: false });
    x.drawImage(video, 0, 0, vw, vh);
    if (CFG.photo.logo) drawLogo(x, vw, vh);
    var done = function (blob) {
      c.width = c.height = 0;
      if (!blob) {
        state.busy = false;
        alertBox('写真を作成できませんでした', 'もう一度撮影してください。\n繰り返す場合は、アプリを開き直してください。');
        return;
      }
      var item = { kind: 'photo', blob: blob, mime: 'image/jpeg', createdAt: Date.now(), w: vw, h: vh, complete: true };
      DB.clear().then(function () {
        return DB.setMeta({ kind: 'photo', mime: item.mime, createdAt: item.createdAt, w: vw, h: vh, complete: true });
      }).then(function () { return DB.addChunk(blob); });
      state.busy = false;
      openReview(item);
    };
    if (c.toBlob) c.toBlob(done, 'image/jpeg', CFG.photo.quality || 0.95);
    else done(null);
  }

  /* ───────── 動画 ───────── */
  function pickMime() {
    // iPhone(Safari) は MP4（H.264 + AAC）。写真アプリに保存できる MP4 を最優先にする。
    var list = ['video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
    if (!window.MediaRecorder || !MediaRecorder.isTypeSupported) return '';
    for (var i = 0; i < list.length; i++) {
      try { if (MediaRecorder.isTypeSupported(list[i])) return list[i]; } catch (e) {}
    }
    return '';
  }

  function startRecording() {
    if (state.busy || state.recording || !state.stream) return;
    if (!window.MediaRecorder) {
      alertBox('このiPhoneでは録画できません', 'お使いのiOSは動画の録画機能に対応していません。\niOSを最新版に更新してからお試しください。');
      return;
    }
    if (!video.videoWidth) { toast('カメラの準備中です'); return; }
    if (!state.rawMode && typeof canvas.captureStream !== 'function') {
      offerRawMode('このiPhoneではロゴの合成録画に対応していません。');
      return;
    }
    state.busy = true;

    var videoTrack;
    try {
      if (state.rawMode) {
        videoTrack = state.stream.getVideoTracks()[0];
      } else {
        drawFrame();
        state.sizeLocked = true;
        state.canvasStream = canvas.captureStream(CFG.video.frameRate || 30);
        videoTrack = state.canvasStream.getVideoTracks()[0];
      }
      var tracks = [videoTrack];
      state.stream.getAudioTracks().forEach(function (t) { if (t.readyState === 'live') tracks.push(t); });
      var recStream = new MediaStream(tracks);
      var mime = pickMime();
      var opts = {};
      if (mime) opts.mimeType = mime;
      if (CFG.video.bitsPerSecond) opts.videoBitsPerSecond = CFG.video.bitsPerSecond;
      if (CFG.audio.bitsPerSecond) opts.audioBitsPerSecond = CFG.audio.bitsPerSecond;
      var rec;
      try { rec = new MediaRecorder(recStream, opts); }
      catch (e1) { rec = new MediaRecorder(recStream); }
      state.recorder = rec;
      state.recMime = baseMime(rec.mimeType || mime) || 'video/mp4';
    } catch (e) {
      console.warn('[GGC] 録画開始エラー', e);
      cleanupRecording();
      state.busy = false;
      alertBox('録画を開始できませんでした', 'アプリを開き直してからもう一度お試しください。\n（エラー: ' + (e && e.name || e) + '）');
      return;
    }

    state.chunks = [];
    var meta = {
      kind: 'video', mime: state.recMime, createdAt: Date.now(),
      w: state.rawMode ? video.videoWidth : canvas.width,
      h: state.rawMode ? video.videoHeight : canvas.height,
      complete: false, duration: 0, logo: !state.rawMode && state.logoStatus === 'ok'
    };
    state.recMeta = meta;

    DB.clear().then(function () { return DB.setMeta(meta); }).then(function () {
      var rec = state.recorder;
      rec.ondataavailable = function (e) {
        if (e.data && e.data.size > 0) {
          state.chunks.push(e.data);
          DB.addChunk(e.data);   // 1秒ごとに端末内へ退避（異常終了時の復元用）
        }
      };
      rec.onerror = function (e) { console.warn('[GGC] 録画エラー', e); stopRecording('error'); };
      try { rec.start(1000); }
      catch (e) {
        cleanupRecording();
        state.busy = false;
        alertBox('録画を開始できませんでした', 'アプリを開き直してからもう一度お試しください。\n（エラー: ' + (e && e.name || e) + '）');
        return;
      }
      state.recording = true;
      state.stopping = false;
      state.busy = false;
      state.recStart = performance.now();
      app.classList.add('recording');
      $('recTime').textContent = '0:00';
      $('recBadge').hidden = false;
      $('shutter').setAttribute('aria-label', '録画停止');
      updateBadges();
      requestWakeLock();
      var maxSec = CFG.video.maxSeconds || 600;
      state.timer = setInterval(function () {
        var sec = (performance.now() - state.recStart) / 1000;
        $('recTime').textContent = fmtTime(sec);
        if (sec >= maxSec) stopRecording('max');
      }, 200);
    });
  }

  function cleanupRecording() {
    clearInterval(state.timer); state.timer = null;
    if (state.canvasStream) {
      state.canvasStream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) {} });
      state.canvasStream = null;
    }
    state.recorder = null;
    state.recording = false;
    state.stopping = false;
    state.sizeLocked = false;
    app.classList.remove('recording');
    $('recBadge').hidden = true;
    $('shutter').setAttribute('aria-label', state.mode === 'photo' ? '写真を撮る' : '録画開始');
    updateBadges();
  }

  function stopRecording(reason) {
    if (!state.recording || state.stopping) return;
    state.stopping = true;
    state.recElapsed = (performance.now() - state.recStart) / 1000;
    clearInterval(state.timer); state.timer = null;
    showProgress('動画を仕上げています…');
    var rec = state.recorder, done = false, to;
    var finish = function () {
      if (done) return;
      done = true;
      clearTimeout(to);
      finalizeRecording(reason);
    };
    rec.onstop = finish;
    to = setTimeout(finish, 6000);   // 停止通知が来ない場合の保険
    try { if (rec.state !== 'inactive') rec.stop(); else finish(); }
    catch (e) { finish(); }
  }

  function finalizeRecording(reason) {
    var type = state.recMime || 'video/mp4';
    var blob = new Blob(state.chunks, { type: type });
    var meta = state.recMeta || {};
    state.chunks = [];
    cleanupRecording();
    hideProgress();

    if (!blob.size) {
      DB.clear();
      if (state.rawMode) {
        alertBox('録画データを取得できませんでした', 'アプリを開き直してからもう一度お試しください。\n繰り返す場合は、iOSを最新版に更新してください。');
      } else {
        offerRawMode('録画データを取得できませんでした。');
      }
      return;
    }
    meta.complete = true;
    meta.duration = state.recElapsed;
    DB.setMeta(meta);
    var item = {
      kind: 'video', blob: blob, mime: type, createdAt: meta.createdAt, w: meta.w, h: meta.h,
      duration: meta.duration, complete: true, logo: meta.logo
    };
    var note = '';
    if (reason === 'max') note = '録画時間の上限に達したため、自動で停止しました。';
    else if (reason === 'hidden') note = 'アプリが画面から外れたため、録画を停止しました。';
    else if (reason === 'ended' || reason === 'error') note = 'カメラが中断されたため、録画を停止しました。';
    openReview(item, note);
  }

  function offerRawMode(lead) {
    ask('ロゴ入り録画ができませんでした',
      lead + '\n\nアプリを開き直しても直らない場合は、非常用として「ロゴなし」で録画できます。\n※ロゴなし録画の動画にはGOLF GUTSのロゴは入りません。',
      [{ label: '閉じる', value: 'close', cls: 'primary' },
       { label: 'ロゴなしで録画する（非常用）', value: 'raw' }]
    ).then(function (v) {
      if (v === 'raw') { state.rawMode = true; updateBadges(); toast('ロゴなし録画に切り替えました'); }
    });
  }

  /* ───────── 確認画面・保存 ───────── */
  function setStatus(t) { $('reviewStatus').textContent = t || ''; }

  function canShareFile(file) {
    try { return !!(navigator.share && navigator.canShare && navigator.canShare({ files: [file] })); }
    catch (e) { return false; }
  }

  function openReview(item, note) {
    state.screen = 'review';
    state.camToken++;
    stopLoop();
    stopStream();   // マイクを止めて、再生音が小さくなるのを防ぐ
    state.pending = item;
    item.shared = false;
    item.url = URL.createObjectURL(item.blob);
    item.file = null;
    try { item.file = new File([item.blob], fileName(item.mime, item.createdAt), { type: item.mime }); } catch (e) {}

    var box = $('reviewMedia');
    box.textContent = '';
    var el;
    if (item.kind === 'video') {
      el = document.createElement('video');
      el.controls = true;
      el.playsInline = true;
      el.setAttribute('playsinline', '');
      el.setAttribute('webkit-playsinline', '');
      el.preload = 'metadata';
      el.src = item.url;
    } else {
      el = document.createElement('img');
      el.alt = '撮影した写真';
      el.src = item.url;
    }
    el.id = 'reviewEl';
    box.appendChild(el);

    var info = [];
    if (item.kind === 'video' && item.duration) info.push(fmtTime(item.duration));
    if (item.w && item.h) info.push(item.w + '×' + item.h);
    info.push(fmtSize(item.blob.size));
    $('reviewInfo').textContent = info.join('・');

    var isVideo = item.kind === 'video';
    var link = $('fallbackLink');
    link.href = item.url;
    link.setAttribute('download', fileName(item.mime, item.createdAt));
    link.hidden = true;

    var notes = [];
    if (note) notes.push(note);
    if (isVideo && item.logo === false && state.logoStatus === 'missing') notes.push('ロゴ未登録のため、この動画にロゴは入っていません。');

    if (item.file && canShareFile(item.file)) {
      $('saveBtn').hidden = false;
      $('saveBtn').disabled = false;
      $('saveHint').textContent = '共有メニューで「' + (isVideo ? 'ビデオを保存' : '画像を保存') + '」を選んでください';
    } else {
      // 共有メニューでのファイル保存に非対応の環境 → 代替手段を表示
      $('saveBtn').hidden = true;
      link.hidden = false;
      notes.push('共有メニューでの保存に非対応のブラウザです。');
      $('saveHint').textContent = isVideo
        ? '「ファイルとして保存」で「ファイル」アプリに保存されます。「ファイル」アプリで動画を開き、共有ボタンから「ビデオを保存」を選ぶと写真アプリに入ります。'
        : '写真を長押しして「"写真"に保存」を選ぶか、「ファイルとして保存」を押してください。';
    }
    setStatus(notes.join('\n'));
    $('review').hidden = false;
  }

  function saveToPhotos() {
    var item = state.pending;
    if (!item || !item.file || state.sharing) return;
    state.sharing = true;
    var btn = $('saveBtn');
    btn.disabled = true;
    setTimeout(function () { btn.disabled = false; }, 1500);   // 二重タップ防止
    var isVideo = item.kind === 'video';
    var word = isVideo ? '動画' : '写真';
    setStatus('共有メニューを開いています…');
    var p;
    try { p = navigator.share({ files: [item.file] }); }
    catch (e) { p = Promise.reject(e); }
    p.then(function () {
      state.sharing = false;
      if (state.pending !== item) return;
      item.shared = true;
      // 実際に保存されたかどうかはアプリ側では確認できないため「保存完了」とは表示しない
      setStatus('共有メニューを閉じました。\n「' + (isVideo ? 'ビデオを保存' : '画像を保存') + '」を選んだ場合は、\n写真アプリに保存されています。');
    }).catch(function (e) {
      state.sharing = false;
      if (state.pending !== item) return;
      var name = e && e.name;
      if (name === 'AbortError') {
        setStatus('保存はキャンセルされました。' + word + 'は消えていません。');
      } else if (name === 'InvalidStateError') {
        setStatus('共有メニューを開いています…');
      } else {
        console.warn('[GGC] 共有エラー', e);
        setStatus('共有メニューを開けませんでした。' + word + 'は消えていません。\nもう一度押すか、下の代替ボタンをお試しください。（' + (name || 'エラー') + '）');
        $('fallbackLink').hidden = false;
      }
    });
  }

  function backToCamera() {
    var item = state.pending;
    if (!item) return;
    var go = function () {
      var el = $('reviewEl');
      if (el && el.pause) { try { el.pause(); } catch (e) {} }
      $('reviewMedia').textContent = '';
      try { URL.revokeObjectURL(item.url); } catch (e) {}
      state.pending = null;
      state.sharing = false;
      DB.clear();
      $('review').hidden = true;
      state.screen = 'camera';
      startCamera();
    };
    if (item.shared) { go(); return; }
    var word = item.kind === 'video' ? '動画' : '写真';
    ask('まだ保存していません',
      'この' + word + 'を破棄して撮影に戻りますか？\n破棄すると元に戻せません。',
      [{ label: '保存画面に戻る', value: 'stay', cls: 'primary' },
       { label: '破棄して撮影に戻る', value: 'discard', cls: 'danger' }]
    ).then(function (v) { if (v === 'discard') go(); });
  }

  // 前回の未保存データ（異常終了・再起動時）を復元する
  function restorePending() {
    return DB.getMeta().then(function (meta) {
      if (!meta) return false;
      return DB.getChunks().then(function (chunks) {
        var blob = new Blob(chunks, { type: meta.mime });
        if (!chunks.length || !blob.size) { DB.clear(); return false; }
        var item = {
          kind: meta.kind, blob: blob, mime: meta.mime, createdAt: meta.createdAt,
          w: meta.w, h: meta.h, duration: meta.duration, complete: meta.complete, logo: meta.logo
        };
        var word = meta.kind === 'video' ? '動画' : '写真';
        openReview(item, meta.complete
          ? '前回、保存せずに閉じた' + word + 'です。'
          : '録画中に中断された動画です。再生できるか確認してから保存してください。');
        return true;
      });
    }).catch(function () { return false; });
  }

  /* ───────── 案内・情報 ───────── */
  function showLogoHelp() {
    alertBox('ロゴが未登録です',
      'ロゴ画像が見つからないため、動画にロゴが入りません。\n\n【登録方法】\n① ロゴ画像のファイル名を「logo.png」にする（背景が透明なPNGを推奨）\n② GitHubのリポジトリを開き「Add file」→「Upload files」で logo.png をアップロードする\n③ 1〜2分待ってから、このアプリを開き直す\n\n詳しくは README.md をご覧ください。');
  }

  function showInfo() {
    if (state.recording) return;
    var vw = video.videoWidth, vh = video.videoHeight, fr = '';
    try {
      var s = state.stream && state.stream.getVideoTracks()[0].getSettings();
      if (s && s.frameRate) fr = '／' + Math.round(s.frameRate) + 'fps';
    } catch (e) {}
    var logo = state.logoStatus === 'ok'
      ? '登録済み（' + state.logo.naturalWidth + '×' + state.logo.naturalHeight + '）'
      : (state.logoStatus === 'missing' ? '未登録' : '読み込み中');
    var lines = [
      'バージョン: ' + VERSION,
      'カメラ映像: ' + (vw ? vw + '×' + vh + fr : '未起動'),
      '録画形式: ' + (pickMime() || '非対応'),
      '音声: ' + (state.stream ? (state.hasAudio ? 'あり' : 'なし（マイク未許可）') : '−'),
      'ロゴ: ' + logo,
      '保存方法: ' + (navigator.share && navigator.canShare ? '共有メニュー' : '代替（ファイル保存）'),
      '起動方法: ' + ((navigator.standalone || (window.matchMedia && matchMedia('(display-mode: standalone)').matches)) ? 'ホーム画面' : 'ブラウザ')
    ];
    alertBox('GOLF GUTS CAMERA', lines.join('\n'));
  }

  /* ───────── イベント ───────── */
  var lastShutter = -10000;
  $('shutter').addEventListener('click', function () {
    var now = performance.now();
    if (now - lastShutter < 350) return;   // 連打防止
    lastShutter = now;
    if (state.screen !== 'camera') return;
    if (state.mode === 'photo') { takePhoto(); return; }
    if (state.recording) {
      if (now - state.recStart < 1000) return;   // 押し間違いによる即停止を防ぐ
      stopRecording('user');
    } else {
      startRecording();
    }
  });
  $('flip').addEventListener('click', flipCamera);
  $('modeSwitch').addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('button[data-mode]') : null;
    if (b) setMode(b.getAttribute('data-mode'));
  });
  $('camRetry').addEventListener('click', function () { startCamera(); });
  $('logoNotice').addEventListener('click', showLogoHelp);
  $('titleBtn').addEventListener('click', showInfo);
  $('saveBtn').addEventListener('click', saveToPhotos);
  $('backBtn').addEventListener('click', backToCamera);

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      // 画面から外れると映像が止まるため、そこまでの録画を確定させる
      if (state.recording) stopRecording('hidden');
      return;
    }
    if (state.screen !== 'camera') return;
    var vt = state.stream && state.stream.getVideoTracks()[0];
    if (!vt || vt.readyState !== 'live') { if (!state.recording) startCamera(); }
    else {
      if (video.paused) { var p = video.play(); if (p && p.catch) p.catch(function () {}); }
      requestWakeLock();
    }
  });

  // ピンチ拡大・ダブルタップ拡大による画面のずれを防ぐ
  document.addEventListener('gesturestart', function (e) { e.preventDefault(); });
  document.addEventListener('dblclick', function (e) { e.preventDefault(); });

  /* ───────── 起動 ───────── */
  setMode(state.mode);
  loadLogo();

  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('sw.js').catch(function (e) { console.warn('[GGC] SW登録エラー', e); });
  }

  restorePending().then(function (restored) {
    if (!restored) startCamera();
  });
})();
