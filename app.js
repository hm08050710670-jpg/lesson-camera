/* GOLF GUTS CAMERA
 * 撮影データはすべてこの端末内（ブラウザ内）で処理し、外部サーバーへは送信しません。
 */
(function () {
  'use strict';

  var VERSION = '1.4.1';
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
    wakeLock: null,
    sensor: 'unknown',       // 傾きセンサー: 'unknown' | 'pending' | 'granted' | 'denied' | 'unsupported'
    sensorInit: false,
    devAngle: 0,             // 本体の向き: 0=縦 / 90=左に倒す / -90=右に倒す / 180=逆さ
    manualRot: 0,            // 手動で選んだ向き: 0=縦 / 90=横（上側を左へ） / -90=横（上側を右へ）
    recRot: 0,               // 録画開始時に固定した回転
    shownRot: 0,
    lens: '1',               // 使用中のカメラ: '1'（標準） | '0.5'（超広角）
    zoomU: 1,                // 画面に表示するズーム倍率（0.5〜1）
    crop: 1,                 // 映像の中央を切り出して拡大する倍率（カメラ側でズームできない機種用）
    uwZoomCap: null,
    lensMethod: null,        // 超広角への切替方法: null（非対応） | 'zoom'（ズーム指定） | 'device'（カメラを切替）
    zoomCap: null,
    uwDeviceId: null,
    camLabels: []
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

  /* ───────── 本体の向き（傾きセンサー） ─────────
   * iPhoneの「画面縦向きのロック」がオンだと、本体を横にしても画面も映像も縦向きのまま届く。
   * そこで傾きセンサーで本体の向きを判定し、横に構えた時は映像を回転して「正しい横動画」として保存する。 */
  var sensorPromise = null, pendCand = 0, pendSince = 0;

  function normAngle(a) { a = ((a % 360) + 360) % 360; return a > 180 ? a - 360 : a; }

  function uiAngle() {
    var a = 0;
    try {
      if (screen.orientation && typeof screen.orientation.angle === 'number') a = screen.orientation.angle;
      else if (typeof window.orientation === 'number') a = window.orientation;
    } catch (e) {}
    return normAngle(a);
  }

  // いま映像に掛けるべき回転（度）
  var mqLandscape = null;
  try { mqLandscape = window.matchMedia ? window.matchMedia('(orientation: landscape)') : null; } catch (e) {}
  function uiRotated() {
    // 画面自体が回転している時（ロックがオフ）は、映像が最初から正しい向きで届くので回さない
    if (uiAngle() !== 0) return true;
    return !!(mqLandscape && mqLandscape.matches);
  }
  function effectiveRot() {
    if (state.rawMode || uiRotated()) return 0;
    if (CFG.autoRotate === true) return state.sensor === 'granted' ? state.devAngle : 0;   // 傾きセンサーで自動判定（設定で有効にした場合のみ）
    return state.manualRot;                                                                 // 通常は画面のボタンで選んだ向き
  }

  /* ───────── 向きの手動切替（縦／横） ─────────
   * 傾きセンサーを使うとiOSが起動のたびに許可を求めるため、通常は画面のボタンで向きを選ぶ。
   * 選んだ向きは次回の起動時も引き継ぐ。 */
  function loadManualRot() {
    try {
      var v = parseInt(window.localStorage.getItem('ggc-rot'), 10);
      if (v === 90 || v === -90) state.manualRot = v;
    } catch (e) {}
  }
  function updateRotUI() {
    var btn = $('rotBtn'), r = state.manualRot;
    btn.hidden = CFG.autoRotate === true;
    btn.classList.toggle('on', r !== 0);
    $('rotLabel').textContent = r === 0 ? '縦向き' : '横向き';
    // 本体を構えた人から見て絵と文字が正しい向きになるよう、ボタンごと回す（左上の角を基準に、左端に沿わせる）
    btn.style.transform = r === 90 ? 'rotate(90deg) translateY(-100%)'
      : r === -90 ? 'rotate(-90deg) translateX(-100%)' : '';
    btn.setAttribute('aria-label', '撮影の向き: ' + (r === 0 ? '縦' : r === 90 ? '横（本体の上側を左へ）' : '横（本体の上側を右へ）'));
  }
  function cycleManualRot() {
    if (state.recording || state.busy || CFG.autoRotate === true) return;
    state.manualRot = state.manualRot === 0 ? 90 : (state.manualRot === 90 ? -90 : 0);
    try { window.localStorage.setItem('ggc-rot', String(state.manualRot)); } catch (e) {}
    updateRotUI();
    if (state.mode === 'video') drawFrame();
    toast(state.manualRot === 0 ? '縦向きで撮影します'
      : state.manualRot === 90 ? '横向き：本体の上側を左に向けて構えます'
      : '横向き：本体の上側を右に向けて構えます', 2200);
  }
  function activeRot() { return state.sizeLocked ? state.recRot : effectiveRot(); }

  function onDeviceOrientation(e) {
    if (e.beta == null || e.gamma == null) return;
    var b = e.beta * Math.PI / 180, g = e.gamma * Math.PI / 180;
    // 画面の面内で「上（重力の反対）」がどちらを向いているか
    var ux = -Math.sin(g) * Math.cos(b), uy = Math.sin(b);
    if (CFG.autoRotateReverse) ux = -ux;
    if (ux * ux + uy * uy < 0.25) return;   // 水平に近い（机に置いた等）時は直前の向きを維持
    var ang = Math.atan2(ux, uy) * 180 / Math.PI;
    var cand = state.devAngle;
    if (!state.sensorInit || Math.abs(normAngle(ang - cand)) > 60) cand = normAngle(Math.round(ang / 90) * 90);
    var now = performance.now();
    if (!state.sensorInit) { state.sensorInit = true; state.devAngle = pendCand = cand; pendSince = now; return; }
    if (cand !== pendCand) { pendCand = cand; pendSince = now; return; }
    // 0.5秒続いたら向きが変わったと判断する（一瞬の傾きで切り替わらないように）
    if (cand !== state.devAngle && now - pendSince >= 500) state.devAngle = cand;
  }

  // センサーの利用開始。iPhoneでは利用者の操作（タップ）をきっかけに許可を求める必要がある
  function ensureSensor() {
    if (sensorPromise) return sensorPromise;
    var D = window.DeviceOrientationEvent;
    if (CFG.autoRotate !== true || typeof D === 'undefined') {
      state.sensor = 'unsupported';
      return (sensorPromise = Promise.resolve());
    }
    var listen = function () {
      state.sensor = 'granted';
      window.addEventListener('deviceorientation', onDeviceOrientation);
      return new Promise(function (res) {   // 最初の計測値が届くのを少しだけ待つ
        var t0 = performance.now();
        (function wait() {
          if (state.sensorInit || performance.now() - t0 > 400) res(); else setTimeout(wait, 30);
        })();
      });
    };
    if (typeof D.requestPermission === 'function') {
      state.sensor = 'pending';
      var p;
      try { p = D.requestPermission(); } catch (e) { p = Promise.reject(e); }
      sensorPromise = Promise.race([p, new Promise(function (r) { setTimeout(function () { r('timeout'); }, 30000); })])
        .then(function (r) {
          if (r === 'granted') return listen();
          state.sensor = 'denied';
          toast('傾きセンサーが許可されていないため、横向きの自動判定はオフです', 4500);
        })
        .catch(function (e) {
          console.warn('[GGC] 傾きセンサーの許可エラー', e);
          state.sensor = 'unknown';
          sensorPromise = null;   // 次のタップでもう一度試す
        });
    } else {
      sensorPromise = listen();
    }
    return sensorPromise;
  }
  function sensorSettled() {
    return state.sensor === 'granted' || state.sensor === 'denied' || state.sensor === 'unsupported';
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
    var wantUW = state.facing === 'environment' && state.lens === '0.5' &&
      state.lensMethod === 'device' && !!state.uwDeviceId;
    var videoC = {
      facingMode: { ideal: state.facing },
      width: { ideal: V.width || 1920 },
      height: { ideal: V.height || 1080 },
      frameRate: { ideal: V.frameRate || 30 }
    };
    var audioC = CFG.audio.natural === false ? true :
      { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
    if (wantUW) { delete videoC.facingMode; videoC.deviceId = { exact: state.uwDeviceId }; }
    else { state.crop = 1; applyCropView(); }
    var gum = function (c) { return navigator.mediaDevices.getUserMedia(c); };

    // 1) 映像＋音声 → 2) 映像のみ（マイク拒否時） → 3) 条件をゆるめた映像のみ
    return gum({ video: videoC, audio: audioC })
      .catch(function () { return gum({ video: videoC, audio: false }); })
      .catch(function (e) {
        // 利用者が拒否した場合は、確認を何度も出さない
        if (e && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) throw e;
        if (wantUW) { var uwErr = new Error('uw-failed'); uwErr.uwFailed = true; throw uwErr; }
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
        if (wantUW) {
          // 超広角カメラを開けなかった（別のカメラに切り替わった）場合は標準に戻す
          var got = vt && vt.getSettings ? vt.getSettings().deviceId : null;
          if (got && got !== state.uwDeviceId) {
            state.lens = '1'; state.zoomU = 1; state.crop = 1; applyCropView();
            toast('超広角カメラに切り替えできませんでした');
          } else {
            var uc = {};
            try { uc = vt.getCapabilities ? vt.getCapabilities() : {}; } catch (e3) {}
            state.uwZoomCap = (uc.zoom && typeof uc.zoom.min === 'number' && typeof uc.zoom.max === 'number')
              ? { min: uc.zoom.min, max: uc.zoom.max } : null;
            applyDigital();
          }
          updateLensUI();
        } else {
          detectLens(token);
        }
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
        if (err && err.uwFailed) {
          // 超広角カメラを開けなかった時は、標準カメラで開き直す
          state.lens = '1'; state.zoomU = 1; state.crop = 1;
          applyCropView();
          updateLensUI();
          toast('超広角カメラに切り替えできませんでした');
          return startCamera();
        }
        console.warn('[GGC] カメラ起動エラー', err);
        cameraError(err);
        return false;
      });
  }

  /* ───────── 超広角とズーム（0.5×〜1×） ─────────
   * iPhoneのブラウザが超広角を出す方法は機種・iOSで異なるため、使える方法を起動時に調べる。
   *   1) ズーム指定：1本のカメラで 0.5〜 のズーム値を指定できる場合（切替が速く、途中の倍率もなめらか）
   *   2) カメラ切替：カメラ一覧に「超広角」があれば、そのカメラを開き直す。
   *      0.5〜1 の途中の倍率は、超広角カメラの映像を拡大して作る
   * どちらも使えない機種では、切替ボタンを表示しない。 */
  function clampU(u) { return Math.min(1, Math.max(0.5, u)); }

  function updateLensUI() {
    var show = !!state.lensMethod && state.facing === 'environment';
    var box = $('lens');
    box.hidden = !show;
    var u = state.zoomU, wide = u >= 0.995;
    var bs = box.querySelectorAll('button');
    for (var i = 0; i < bs.length; i++) {
      var v = bs[i].getAttribute('data-lens');
      var on = (v === '1') === wide;
      bs[i].classList.toggle('on', on);
      if (v === '1') bs[i].textContent = on ? '1×' : '1';
      else bs[i].textContent = on ? ((Math.floor(u * 10 + 0.001) / 10).toFixed(1) + '×') : '.5';
    }
  }

  // 写真モードの画面（カメラ映像そのもの）にも、切り出し拡大を反映する
  function applyCropView() {
    video.style.transform = state.crop > 1.001 ? 'scale(' + state.crop + ')' : '';
  }

  // 超広角カメラを使っている時の、0.5〜1 の途中の倍率（カメラ側でズームできればそれを使い、できなければ映像を拡大する）
  function applyDigital() {
    var vt = state.stream && state.stream.getVideoTracks()[0];
    var d = Math.min(2, Math.max(1, state.zoomU / 0.5));
    var z = state.uwZoomCap;
    if (vt && z && z.min > 0 && z.max / z.min >= 1.9 && vt.applyConstraints) {
      state.crop = 1; applyCropView();
      return vt.applyConstraints({ advanced: [{ zoom: Math.min(z.max, z.min * d) }] }).catch(function () {
        state.uwZoomCap = null; state.crop = d; applyCropView();
      });
    }
    state.crop = d; applyCropView();
    return Promise.resolve();
  }

  function switchCamera() {
    state.busy = true;
    return startCamera().then(function () { state.busy = false; });
  }

  // 指定の倍率にする。final=true は指を離した時・ボタンを押した時
  function applyUserZoom(u, final) {
    u = clampU(u);
    if (!state.lensMethod || state.facing !== 'environment' || !state.stream || state.screen !== 'camera') return Promise.resolve();
    var vt = state.stream.getVideoTracks()[0];
    if (state.lensMethod === 'zoom') {
      var z = state.zoomCap;
      return vt.applyConstraints({ advanced: [{ zoom: Math.min(Math.max(u, z.min), z.max) }] })
        .then(function () { state.zoomU = u; state.lens = u < 0.995 ? '0.5' : '1'; updateLensUI(); });
    }
    // カメラ切替方式
    if (state.lens !== '0.5') {
      if (u >= 0.995 || state.recording) return Promise.resolve();   // 録画中はカメラを開き直さない
      if (!final && u > 0.92) return Promise.resolve();              // 少し指が動いただけでは切り替えない
      state.lens = '0.5'; state.zoomU = u; updateLensUI();
      return switchCamera();
    }
    if (final && u >= 0.97 && !state.recording) {
      state.lens = '1'; state.zoomU = 1; updateLensUI();
      return switchCamera();
    }
    state.zoomU = u; updateLensUI();
    return applyDigital();
  }

  // ピンチ操作中は次々に倍率が届くので、処理中は最新の1件だけを待たせる
  var zoomJob = null, zoomNext = null;
  function pumpZoom() {
    if (!zoomNext) { zoomJob = null; return; }
    var job = zoomNext; zoomNext = null;
    zoomJob = applyUserZoom(job.u, job.final)
      .catch(function (e) { console.warn('[GGC] ズームエラー', e); })
      .then(pumpZoom);
  }
  function requestZoom(u, final) {
    zoomNext = { u: u, final: !!final };
    if (!zoomJob) pumpZoom();
  }

  // 標準カメラで起動した直後に、超広角へ切り替える方法を調べる
  function detectLens(token) {
    if (state.facing !== 'environment' || !state.stream) { updateLensUI(); return; }
    var vt = state.stream.getVideoTracks()[0], cap = {};
    try { cap = (vt && vt.getCapabilities) ? vt.getCapabilities() : {}; } catch (e) {}
    var z = cap && cap.zoom;
    state.zoomCap = (z && typeof z.min === 'number' && typeof z.max === 'number') ? { min: z.min, max: z.max } : null;
    var byZoom = !!state.zoomCap && state.zoomCap.min <= 0.6 && state.zoomCap.max >= 1;

    var finish = function (method) {
      if (token !== state.camToken) return;
      state.lensMethod = method;
      if (!method) { state.lens = '1'; state.zoomU = 1; }
      // 撮影から戻った時など、カメラを開き直した後も前回の倍率を引き継ぐ
      if (method === 'zoom' && state.zoomU < 0.995) {
        requestZoom(state.zoomU, true);
      } else if (method === 'device' && state.lens === '0.5') {
        startCamera();
        return;
      }
      updateLensUI();
    };

    if (!navigator.mediaDevices.enumerateDevices) { finish(byZoom ? 'zoom' : null); return; }
    navigator.mediaDevices.enumerateDevices().then(function (list) {
      var cams = list.filter(function (d) { return d.kind === 'videoinput'; });
      state.camLabels = cams.map(function (d) { return d.label || '(名前なし)'; });
      var uw = null;
      cams.forEach(function (d) {
        var l = d.label || '';
        if (/ultra[\s-]*wide|超広角/i.test(l) && !/front|前面|フロント/i.test(l)) uw = uw || d;
      });
      state.uwDeviceId = uw ? uw.deviceId : null;
      finish(byZoom ? 'zoom' : (uw && uw.deviceId ? 'device' : null));
    }).catch(function () { finish(byZoom ? 'zoom' : null); });
  }

  function setLens(lens) {
    if (state.recording || state.busy || !state.lensMethod) return;
    requestZoom(lens === '0.5' ? 0.5 : 1, true);
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

  // カメラ映像を、指定の回転を掛けて描く（収まらない部分は黒帯）
  function drawVideo(c, cw, ch, rot) {
    var vw = video.videoWidth, vh = video.videoHeight;
    var crop = state.crop > 1.001 ? state.crop : 1;
    if (rot === 0 && crop === 1 && vw === cw && vh === ch) { c.drawImage(video, 0, 0, cw, ch); return; }
    var odd = (rot === 90 || rot === -90), rw = odd ? vh : vw, rh = odd ? vw : vh;
    var sc = Math.min(cw / rw, ch / rh) * crop;
    if (rw * sc < cw - 0.5 || rh * sc < ch - 0.5) { c.fillStyle = '#000'; c.fillRect(0, 0, cw, ch); }
    // インカメラは映像の左右が逆になるため、回転の方向も逆になる
    var dir = state.facing === 'user' ? 1 : -1;
    c.save();
    c.translate(cw / 2, ch / 2);
    c.rotate(dir * rot * Math.PI / 180);
    c.scale(sc, sc);
    c.drawImage(video, -vw / 2, -vh / 2, vw, vh);
    c.restore();
  }

  // 合成映像の画面上の置き方。本体を横に構えている時は、構えた人から見て正しい向きに見えるよう回して表示する
  function layoutCanvas(rot) {
    state.shownRot = rot;
    var st = canvas.style, stage = $('stage');
    if (rot === 90 || rot === -90) {
      st.left = '50%'; st.top = '50%'; st.right = 'auto'; st.bottom = 'auto';
      st.width = stage.clientHeight + 'px'; st.height = stage.clientWidth + 'px';
      st.transform = 'translate(-50%, -50%) rotate(' + rot + 'deg)';
    } else {
      st.left = st.top = st.right = st.bottom = st.width = st.height = '';
      st.transform = rot === 180 ? 'rotate(180deg)' : '';
    }
  }

  function drawFrame() {
    var vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return;
    var rot = activeRot(), odd = (rot === 90 || rot === -90);
    var rw = odd ? vh : vw, rh = odd ? vw : vh;
    // 録画中は動画サイズを固定する（途中で本体を回しても動画が壊れないように）
    if (!state.sizeLocked && (canvas.width !== rw || canvas.height !== rh)) {
      canvas.width = rw; canvas.height = rh;
    }
    var cw = canvas.width, ch = canvas.height;
    drawVideo(ctx, cw, ch, rot);
    if (!state.rawMode) drawLogo(ctx, cw, ch);
    if (rot !== state.shownRot) layoutCanvas(rot);
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
    state.lens = '1'; state.zoomU = 1; state.crop = 1;
    applyCropView();
    updateLensUI();
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
    var rot = effectiveRot(), odd = (rot === 90 || rot === -90);
    var pw = odd ? vh : vw, ph = odd ? vw : vh;
    var c = document.createElement('canvas');
    c.width = pw; c.height = ph;
    var x = c.getContext('2d', { alpha: false });
    drawVideo(x, pw, ph, rot);
    if (CFG.photo.logo) drawLogo(x, pw, ph);
    var done = function (blob) {
      c.width = c.height = 0;
      if (!blob) {
        state.busy = false;
        alertBox('写真を作成できませんでした', 'もう一度撮影してください。\n繰り返す場合は、アプリを開き直してください。');
        return;
      }
      var item = { kind: 'photo', blob: blob, mime: 'image/jpeg', createdAt: Date.now(), w: pw, h: ph, complete: true };
      DB.clear().then(function () {
        return DB.setMeta({ kind: 'photo', mime: item.mime, createdAt: item.createdAt, w: pw, h: ph, complete: true });
      }).then(function () { return DB.addChunk(blob); });
      state.busy = false;
      openReview(item, '', true);
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
        state.recRot = effectiveRot();   // 録画開始時の向きで固定
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
    openReview(item, note, reason === 'user');
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

  function openReview(item, note, autoShare) {
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
    item.baseStatus = notes.join('\n');
    setStatus(item.baseStatus);
    $('review').hidden = false;
    // 撮影直後は共有メニューを自動で開く（iOSが自動表示を認めない場合は、ボタンを押す通常の流れになる）
    if (autoShare && CFG.autoShare !== false && !$('saveBtn').hidden) saveToPhotos(true);
  }

  function saveToPhotos(auto) {
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
      } else if (auto === true) {
        setStatus(item.baseStatus);   // 自動表示できなかっただけなので、エラー扱いにしない
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
      '超広角: ' + (state.lensMethod === 'zoom' ? '対応（ズーム指定）' : state.lensMethod === 'device' ? '対応（カメラ切替）' : '非対応') +
        (state.zoomCap ? '／ズーム範囲 ' + state.zoomCap.min + '〜' + state.zoomCap.max : '／ズーム指定なし') +
        (state.lensMethod === 'device' ? (state.uwZoomCap ? '／超広角側ズーム ' + state.uwZoomCap.min + '〜' + state.uwZoomCap.max : '／途中の倍率は映像を拡大') : '') +
        (state.lensMethod ? '／現在 ' + state.zoomU.toFixed(2) + '×' : ''),
      'カメラ一覧: ' + (state.camLabels.length ? state.camLabels.join('、') : '取得なし'),
      CFG.autoRotate === true
        ? '撮影の向き: 自動判定（' + (state.sensor === 'granted'
          ? '有効／現在: ' + ({ '0': '縦', '90': '横・左倒し', '-90': '横・右倒し', '180': '逆さ' })[String(state.devAngle)]
          : state.sensor === 'denied' ? '無効・センサー未許可'
          : state.sensor === 'unsupported' ? '非対応' : '最初の撮影時に確認') + '）'
        : '撮影の向き: ボタンで選択（現在: ' + (state.manualRot === 0 ? '縦' : state.manualRot === 90 ? '横・上側を左へ' : '横・上側を右へ') + '）',
      '保存方法: ' + (navigator.share && navigator.canShare ? '共有メニュー' : '代替（ファイル保存）'),
      '起動方法: ' + ((navigator.standalone || (window.matchMedia && matchMedia('(display-mode: standalone)').matches)) ? 'ホーム画面' : 'ブラウザ')
    ];
    alertBox('GOLF GUTS CAMERA', lines.join('\n'));
  }

  /* ───────── イベント ───────── */
  var lastShutter = -10000, sensorWait = false;
  $('shutter').addEventListener('click', function () {
    var now = performance.now();
    if (now - lastShutter < 350) return;   // 連打防止
    lastShutter = now;
    if (state.screen !== 'camera') return;
    if (state.recording) {
      if (now - state.recStart < 1000) return;   // 押し間違いによる即停止を防ぐ
      stopRecording('user');
      return;
    }
    var act = function () {
      sensorWait = false;
      if (state.screen !== 'camera' || state.recording) return;
      if (state.mode === 'photo') takePhoto(); else startRecording();
    };
    if (sensorSettled()) { act(); return; }
    // 傾きセンサーの許可確認がまだの時は、その結果を待ってから撮影する（最初の1回だけ）
    if (sensorWait) return;
    sensorWait = true;
    ensureSensor().then(act, act);
  });
  $('flip').addEventListener('click', flipCamera);
  $('lens').addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('button[data-lens]') : null;
    if (b) setLens(b.getAttribute('data-lens'));
  });
  $('modeSwitch').addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('button[data-mode]') : null;
    if (b) setMode(b.getAttribute('data-mode'));
  });
  $('camRetry').addEventListener('click', function () { startCamera(); });
  $('logoNotice').addEventListener('click', showLogoHelp);
  $('titleBtn').addEventListener('click', showInfo);
  $('rotBtn').addEventListener('click', cycleManualRot);
  $('saveBtn').addEventListener('click', function () { saveToPhotos(false); });
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

  window.addEventListener('resize', function () { layoutCanvas(state.shownRot); });

  // 傾きセンサー：iPhoneでは許可の確認が必要なため、最初に撮影ボタンを押した時にだけ求める
  // （レンズ切替やモード切替のタップでは求めない）。許可が不要な端末はすぐ開始する
  // 自動判定は設定（autoRotate: true）で有効にした場合だけ使う。通常はセンサーを使わないので確認は出ない
  if (CFG.autoRotate !== true ||
      !(window.DeviceOrientationEvent && typeof window.DeviceOrientationEvent.requestPermission === 'function')) {
    ensureSensor();
  }
  loadManualRot();
  updateRotUI();

  // ピンチ操作（2本指）でズーム：0.5×〜1×
  var pinch = null;
  var touchDist = function (t) {
    var dx = t[0].clientX - t[1].clientX, dy = t[0].clientY - t[1].clientY;
    return Math.sqrt(dx * dx + dy * dy);
  };
  var stageEl = $('stage');
  stageEl.addEventListener('touchstart', function (e) {
    if (e.touches.length !== 2) return;
    if (!state.lensMethod || state.facing !== 'environment' || state.screen !== 'camera' || !state.stream) return;
    pinch = { d0: Math.max(1, touchDist(e.touches)), u0: state.zoomU, last: state.zoomU };
    e.preventDefault();
  }, { passive: false });
  stageEl.addEventListener('touchmove', function (e) {
    if (!pinch || e.touches.length < 2) return;
    e.preventDefault();
    pinch.last = clampU(pinch.u0 * touchDist(e.touches) / pinch.d0);
    requestZoom(pinch.last, false);
  }, { passive: false });
  var endPinch = function (e) {
    if (!pinch || e.touches.length >= 2) return;
    var u = pinch.last;
    pinch = null;
    if (u > 0.95) u = 1; else if (u < 0.55) u = 0.5;   // 端の近くは 0.5× / 1× にそろえる
    requestZoom(u, true);
  };
  stageEl.addEventListener('touchend', endPinch);
  stageEl.addEventListener('touchcancel', endPinch);

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
