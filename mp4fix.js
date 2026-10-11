/* GOLF GUTS CAMERA - 動画ファイルの整形
 *
 * iPhoneのブラウザが録画する動画は「断片化MP4」という形式で、
 *   - 動画全体の長さがファイルに書かれていない
 *   - コマの時刻が音声の刻み（約21ms）に丸められていて、間隔が不ぞろい
 * という性質がある。このためLINEなどで送れなかったり、コマ送りができなかったり、
 * 再生がぎこちなく見えたりする。
 *
 * ここでは映像・音声のデータ本体には一切手を加えず（再圧縮しない）、
 * 目次にあたる部分だけを作り直して「標準的なMP4」にする。あわせて映像のコマの時刻を
 * 本来の等間隔（例: 1/30秒）に並べ直す。
 *
 * 失敗した場合は例外を投げる。呼び出し側は元の動画をそのまま使うこと。
 */
(function (root) {
  'use strict';

  /* ───────── 読み取り ───────── */
  function readBytes(blob, start, end) {
    var part = blob.slice(start, end);
    if (typeof part.arrayBuffer === 'function') return part.arrayBuffer().then(function (ab) { return new Uint8Array(ab); });
    return new Promise(function (resolve, reject) {          // 古いiOS向け
      var fr = new FileReader();
      fr.onload = function () { resolve(new Uint8Array(fr.result)); };
      fr.onerror = function () { reject(fr.error || new Error('読み込みに失敗しました')); };
      fr.readAsArrayBuffer(part);
    });
  }
  function dvOf(u8) { return new DataView(u8.buffer, u8.byteOffset, u8.byteLength); }
  function type4(u8, o) { return String.fromCharCode(u8[o], u8[o + 1], u8[o + 2], u8[o + 3]); }
  function u64(dv, o) { return dv.getUint32(o) * 4294967296 + dv.getUint32(o + 4); }

  // ファイル直下の箱（box）を順に調べる
  function scanTop(blob) {
    var out = [], size = blob.size;
    function step(pos) {
      if (pos + 8 > size) return Promise.resolve(out);
      return readBytes(blob, pos, Math.min(pos + 16, size)).then(function (h) {
        var dv = dvOf(h), sz = dv.getUint32(0), t = type4(h, 4), hs = 8;
        if (sz === 1) { if (h.length < 16) return out; sz = u64(dv, 8); hs = 16; }
        else if (sz === 0) sz = size - pos;
        if (sz < hs) return out;
        if (pos + sz > size) {
          if (t !== 'mdat') return out;   // 途中で切れている箱は無視（mdatだけは残りすべてとして扱う）
          sz = size - pos;
        }
        out.push({ type: t, start: pos, size: sz, hs: hs });
        return step(pos + sz);
      });
    }
    return step(0);
  }

  // バイト列の中の子の箱を列挙
  function kids(u8, start, end) {
    var out = [], dv = dvOf(u8), i = start;
    while (i + 8 <= end) {
      var sz = dv.getUint32(i), t = type4(u8, i + 4), hs = 8;
      if (sz === 1) { sz = u64(dv, i + 8); hs = 16; } else if (sz === 0) sz = end - i;
      if (sz < hs || i + sz > end) break;
      out.push({ type: t, start: i, size: sz, hs: hs, data: i + hs, end: i + sz });
      i += sz;
    }
    return out;
  }
  function find(list, type) { for (var i = 0; i < list.length; i++) if (list[i].type === type) return list[i]; return null; }

  /* ───────── 書き出し ───────── */
  function concat(parts) {
    var n = 0, i;
    for (i = 0; i < parts.length; i++) n += parts[i].length;
    var out = new Uint8Array(n), o = 0;
    for (i = 0; i < parts.length; i++) { out.set(parts[i], o); o += parts[i].length; }
    return out;
  }
  function box(type, parts) {
    var body = concat(parts), out = new Uint8Array(8 + body.length), dv = dvOf(out);
    dv.setUint32(0, out.length);
    for (var i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(body, 8);
    return out;
  }
  function u32s(arr) {
    var out = new Uint8Array(arr.length * 4), dv = dvOf(out);
    for (var i = 0; i < arr.length; i++) dv.setUint32(i * 4, arr[i] >>> 0);
    return out;
  }
  function setU64(dv, o, v) { dv.setUint32(o, Math.floor(v / 4294967296)); dv.setUint32(o + 4, v % 4294967296); }

  /* ───────── 映像のコマ時刻を等間隔に並べ直す ─────────
   * times: 各コマの時刻（単位はtimescale）。step: 本来のコマ間隔。
   * コマ落ちした所はそのぶん間隔が空く（2コマ分、3コマ分…）。
   * 当てはまりが悪い場合（本来の間隔が違う等）は null を返し、何もしない。 */
  // 格子（コマ間隔 step）への当てはまりの悪さ。0 = ぴったり、0.25 = でたらめ
  function gridCost(times, step) {
    var n = times.length, t0 = times[0], best = null;
    for (var phi = 0; phi < step; phi++) {        // 格子の位置（位相）を総当たりで合わせる
      var cost = 0;
      for (var i = 0; i < n; i++) {
        var x = times[i] - t0 + phi;
        cost += Math.abs(x - Math.round(x / step) * step);
      }
      if (!best || cost < best.cost) best = { phi: phi, cost: cost };
    }
    return { phi: best.phi, norm: best.cost / n / step };
  }

  function retime(times, step, timescale) {
    var n = times.length;
    if (n < 4 || !(step > 1) || Math.floor(step) !== step) return null;
    var t0 = times[0], fit = gridCost(times, step), i, k;
    if (fit.norm > 0.235) return null;              // 当てはまりが悪い（でたらめに近い）＝本来のコマ間隔が違う
    // 指定のコマ数より、別のコマ数（24・25・50・60など）の方が明らかによく合う場合は、指定が実態と違うのでやめる
    if (timescale) {
      var rates = [24, 25, 30, 50, 60];
      for (i = 0; i < rates.length; i++) {
        var st = timescale / rates[i];
        if (st === step || Math.floor(st) !== st || st < 2) continue;
        if (st < step && step % st === 0) continue;   // 細かい格子（例: 60）は粗い格子（30）を含むので比較しない
        if (gridCost(times, st).norm + 0.03 < fit.norm) return null;
      }
    }
    var slots = new Array(n), maxMove = 0;
    for (i = 0; i < n; i++) {
      k = Math.round((times[i] - t0 + fit.phi) / step);
      if (i > 0 && k <= slots[i - 1]) {
        // 同じ枠に2コマ重なった時：処理が詰まって遅れて届いたコマなので、直前のコマ（の並び）を1つ前の空き枠へ戻す。
        // 前に空きがなければ、このコマを次の枠へ送る
        var j = i - 1;
        while (j > 0 && slots[j - 1] === slots[j] - 1) j--;
        var free = (j === 0) ? false : (slots[j] - 1 > slots[j - 1]);
        if (free && k === slots[i - 1]) { for (var m = j; m < i; m++) slots[m]--; }
        else k = slots[i - 1] + 1;
      }
      slots[i] = k;
    }
    var base = slots[0], out = new Array(n);
    for (i = 0; i < n; i++) {
      out[i] = t0 + (slots[i] - base) * step;
      var mv = Math.abs(out[i] - times[i]);
      if (mv > maxMove) maxMove = mv;
    }
    if (maxMove > step * 2.5) return null;          // 大きく動かす必要がある場合は安全側に倒してやめる
    return { times: out, slots: slots[n - 1] - base + 1, maxMove: maxMove, norm: fit.norm };
  }

  /* ───────── 断片（moof）の読み取り ───────── */
  function parseMoof(u8, moofStart, tracks, trex, state) {
    var top = kids(u8, 8, u8.length), dv = dvOf(u8), prevTrafEnd = null, firstTraf = true;
    top.forEach(function (b) {
      if (b.type !== 'traf') return;
      var ch = kids(u8, b.data, b.end), tfhd = find(ch, 'tfhd');
      if (!tfhd) return;
      var p = tfhd.data, flags = (u8[p + 1] << 16) | (u8[p + 2] << 8) | u8[p + 3], tid = dv.getUint32(p + 4), o = p + 8;
      var tr = tracks[tid];
      if (!tr) return;
      var def = trex[tid] || { dur: 0, size: 0, flags: 0 };
      var base = null, dDur = def.dur, dSize = def.size, dFlags = def.flags;
      if (flags & 0x000001) { base = u64(dv, o); o += 8; }
      if (flags & 0x000002) { o += 4; }
      if (flags & 0x000008) { dDur = dv.getUint32(o); o += 4; }
      if (flags & 0x000010) { dSize = dv.getUint32(o); o += 4; }
      if (flags & 0x000020) { dFlags = dv.getUint32(o); o += 4; }
      if (base === null) {
        if ((flags & 0x020000) || firstTraf) base = moofStart;
        else base = prevTrafEnd !== null ? prevTrafEnd : moofStart;
      }
      firstTraf = false;
      var tfdt = find(ch, 'tfdt'), dts = tr.nextDts;
      if (tfdt) dts = u8[tfdt.data] === 1 ? u64(dv, tfdt.data + 4) : dv.getUint32(tfdt.data + 4);
      var cursor = base;
      ch.forEach(function (c) {
        if (c.type !== 'trun') return;
        var q = c.data, ver = u8[q], f = (u8[q + 1] << 16) | (u8[q + 2] << 8) | u8[q + 3], cnt = dv.getUint32(q + 4), r = q + 8;
        var firstFlags = null;
        if (f & 0x000001) { cursor = base + dv.getInt32(r); r += 4; }
        if (f & 0x000004) { firstFlags = dv.getUint32(r); r += 4; }
        if (cnt > 0) tr.chunks.push({ first: tr.samples.length, count: cnt, offset: cursor });
        for (var s = 0; s < cnt; s++) {
          var d = dDur, z = dSize, fl = (s === 0 && firstFlags !== null) ? firstFlags : dFlags, cto = 0;
          if (f & 0x000100) { d = dv.getUint32(r); r += 4; }
          if (f & 0x000200) { z = dv.getUint32(r); r += 4; }
          if (f & 0x000400) { fl = dv.getUint32(r); r += 4; }
          if (f & 0x000800) { cto = ver === 0 ? dv.getUint32(r) : dv.getInt32(r); r += 4; }
          tr.samples.push({ dts: dts, dur: d, size: z, offset: cursor, sync: !(fl & 0x00010000), cto: cto });
          dts += d; cursor += z;
        }
      });
      tr.nextDts = dts;
      prevTrafEnd = cursor;
      state.fragments++;
    });
  }

  /* ───────── 目次（moov）の作り直し ───────── */
  function patchDuration(u8, b, offV0, offV1, value) {
    // b: mvhd / tkhd / mdhd の箱。長さの欄だけを書き換えた写しを返す
    var copy = u8.slice(b.start, b.end), dv = dvOf(copy), ver = copy[b.hs];
    if (ver === 1) setU64(dv, b.hs + offV1, value);
    else dv.setUint32(b.hs + offV0, Math.min(value, 0xFFFFFFFF) >>> 0);
    return copy;
  }

  function runLength(values) {
    var out = [], i = 0;
    while (i < values.length) {
      var j = i;
      while (j + 1 < values.length && values[j + 1] === values[i]) j++;
      out.push(j - i + 1, values[i]);
      i = j + 1;
    }
    return out;
  }

  function buildStbl(u8, stblBox, tr, chunkOffsets, use64) {
    var keep = [], S = tr.samples;
    kids(u8, stblBox.data, stblBox.end).forEach(function (c) {
      if (['stts', 'ctts', 'stss', 'stsc', 'stsz', 'stz2', 'stco', 'co64', 'sdtp'].indexOf(c.type) < 0) keep.push(u8.slice(c.start, c.end));
    });
    var head = new Uint8Array(4);
    // stts: コマごとの表示時間
    var rl = runLength(S.map(function (s) { return s.outDur; }));
    var stts = box('stts', [head, u32s([rl.length / 2]), u32s(rl)]);
    // ctts: 表示順の補正（Bフレームがある場合のみ）
    var parts = [stts];
    if (S.some(function (s) { return s.cto !== 0; })) {
      var neg = S.some(function (s) { return s.cto < 0; });
      var cr = runLength(S.map(function (s) { return s.cto; }));
      var h2 = new Uint8Array(4); h2[0] = neg ? 1 : 0;
      parts.push(box('ctts', [h2, u32s([cr.length / 2]), u32s(cr)]));
    }
    // stss: キーフレームの番号（すべてキーフレームなら省略）
    var sync = [];
    S.forEach(function (s, i) { if (s.sync) sync.push(i + 1); });
    if (sync.length && sync.length < S.length) parts.push(box('stss', [head, u32s([sync.length]), u32s(sync)]));
    // stsc: かたまり（chunk）ごとのコマ数
    var sc = [], last = -1;
    tr.chunks.forEach(function (c, i) { if (c.count !== last) { sc.push(i + 1, c.count, 1); last = c.count; } });
    parts.push(box('stsc', [head, u32s([sc.length / 3]), u32s(sc)]));
    // stsz: コマごとのデータ量
    parts.push(box('stsz', [head, u32s([0, S.length]), u32s(S.map(function (s) { return s.size; }))]));
    // stco / co64: かたまりの位置
    if (use64) {
      var co = new Uint8Array(chunkOffsets.length * 8), dv = dvOf(co);
      chunkOffsets.forEach(function (v, i) { setU64(dv, i * 8, v); });
      parts.push(box('co64', [head, u32s([chunkOffsets.length]), co]));
    } else {
      parts.push(box('stco', [head, u32s([chunkOffsets.length]), u32s(chunkOffsets)]));
    }
    return box('stbl', keep.concat(parts));
  }

  function buildMoov(u8, moovBox, info, offsetsByTrack, use64) {
    var out = [];
    kids(u8, moovBox.data, moovBox.end).forEach(function (b) {
      if (b.type === 'mvex') return;                       // 断片化の宣言は取り除く
      if (b.type === 'mvhd') { out.push(patchDuration(u8, b, 16, 24, info.movieDuration)); return; }
      if (b.type !== 'trak') { out.push(u8.slice(b.start, b.end)); return; }
      var tk = kids(u8, b.data, b.end), tkhd = find(tk, 'tkhd');
      var ver = u8[tkhd.data], tid = dvOf(u8).getUint32(tkhd.data + (ver === 1 ? 20 : 12)), tr = info.tracks[tid];
      if (!tr || !tr.samples.length) return;               // データのないトラックは出力しない
      var parts = [];
      tk.forEach(function (c) {
        if (c.type === 'edts') return;
        if (c.type === 'tkhd') {
          parts.push(patchDuration(u8, c, 20, 28, tr.startMovie + tr.durMovie));
          // 開始位置のずれ（映像が音声より少し遅れて始まる等）を編集リストで表す
          var e = [];
          if (tr.startMovie > 0) e.push(tr.startMovie, 0xFFFFFFFF, 0x00010000);
          e.push(tr.durMovie, 0, 0x00010000);
          parts.push(box('edts', [box('elst', [new Uint8Array(4), u32s([e.length / 3]), u32s(e)])]));
          return;
        }
        if (c.type !== 'mdia') { parts.push(u8.slice(c.start, c.end)); return; }
        var md = [];
        kids(u8, c.data, c.end).forEach(function (m) {
          if (m.type === 'mdhd') { md.push(patchDuration(u8, m, 16, 24, tr.durMedia)); return; }
          if (m.type !== 'minf') { md.push(u8.slice(m.start, m.end)); return; }
          var mi = [];
          kids(u8, m.data, m.end).forEach(function (x) {
            if (x.type === 'stbl') mi.push(buildStbl(u8, x, tr, offsetsByTrack[tid], use64));
            else mi.push(u8.slice(x.start, x.end));
          });
          md.push(box('minf', mi));
        });
        parts.push(box('mdia', md));
      });
      out.push(box('trak', parts));
    });
    return box('moov', out);
  }

  /* ───────── 本体 ───────── */
  // opts.fps: カメラの本来のコマ数（例: 30）。指定があれば映像のコマ時刻を等間隔に並べ直す
  function fix(blob, opts) {
    opts = opts || {};
    var boxes, moovBox, moovU8;
    return scanTop(blob).then(function (top) {
      boxes = top;
      var moofs = top.filter(function (b) { return b.type === 'moof'; });
      moovBox = find(top, 'moov');
      if (!moovBox) throw new Error('moov がありません');
      if (!moofs.length) return null;                      // すでに標準形式（断片化されていない）
      if (moovBox.size > 8 * 1024 * 1024) throw new Error('moov が大きすぎます');
      return readBytes(blob, moovBox.start, moovBox.start + moovBox.size).then(function (m) {
        moovU8 = m;
        var readAll = moofs.map(function (b) {
          if (b.size > 64 * 1024 * 1024) throw new Error('moof が大きすぎます');
          return readBytes(blob, b.start, b.start + b.size);
        });
        return Promise.all(readAll).then(function (datas) { return build(moofs, datas); });
      });
    });

    function build(moofs, datas) {
      var mdv = dvOf(moovU8), mk = kids(moovU8, moovBox.hs, moovU8.length);
      var mvhd = find(mk, 'mvhd');
      if (!mvhd) throw new Error('mvhd がありません');
      var movieTs = mdv.getUint32(mvhd.data + (moovU8[mvhd.data] === 1 ? 20 : 12));
      var tracks = {}, trex = {}, order = [];
      mk.forEach(function (b) {
        if (b.type === 'mvex') {
          kids(moovU8, b.data, b.end).forEach(function (x) {
            if (x.type === 'trex') trex[mdv.getUint32(x.data + 4)] = { dur: mdv.getUint32(x.data + 12), size: mdv.getUint32(x.data + 16), flags: mdv.getUint32(x.data + 20) };
          });
        }
        if (b.type !== 'trak') return;
        var tk = kids(moovU8, b.data, b.end), tkhd = find(tk, 'tkhd'), mdia = find(tk, 'mdia');
        if (!tkhd || !mdia) return;
        var tid = mdv.getUint32(tkhd.data + (moovU8[tkhd.data] === 1 ? 20 : 12));
        var md = kids(moovU8, mdia.data, mdia.end), mdhd = find(md, 'mdhd'), hdlr = find(md, 'hdlr');
        if (!mdhd) return;
        var ts = mdv.getUint32(mdhd.data + (moovU8[mdhd.data] === 1 ? 20 : 12));
        tracks[tid] = { id: tid, ts: ts, kind: hdlr ? type4(moovU8, hdlr.data + 8) : '', samples: [], chunks: [], nextDts: 0 };
        order.push(tid);
      });
      if (!order.length) throw new Error('トラックがありません');

      var st = { fragments: 0 };
      moofs.forEach(function (b, i) { parseMoof(datas[i], b.start, tracks, trex, st); });

      var result = { fragments: moofs.length, tracks: [], retimed: false, slots: 0, frames: 0 };
      var movieDuration = 0, minStart = Infinity;
      order.forEach(function (tid) { var tr = tracks[tid]; if (tr.samples.length) minStart = Math.min(minStart, tr.samples[0].dts / tr.ts); });
      if (minStart === Infinity) throw new Error('コマがありません');

      order.forEach(function (tid) {
        var tr = tracks[tid], S = tr.samples, n = S.length, i;
        if (!n) return;
        var times = S.map(function (s) { return s.dts; });
        for (i = 1; i < n; i++) if (times[i] <= times[i - 1]) throw new Error('時刻が逆転しています');
        // 映像: コマの時刻を等間隔の格子に並べ直す
        if (tr.kind === 'vide' && opts.fps > 0 && opts.retime !== false) {
          var rt = retime(times, tr.ts / Math.round(opts.fps), tr.ts);
          if (rt) { times = rt.times; result.retimed = true; result.slots = rt.slots; result.maxMove = rt.maxMove / tr.ts; }
        }
        // 表示時間 = 次のコマまでの間隔。最後のコマは、宣言値が異常ならふつうの間隔にする
        var durs = [], sorted;
        for (i = 0; i < n - 1; i++) durs.push(times[i + 1] - times[i]);
        sorted = durs.slice().sort(function (a, b) { return a - b; });
        var typical = sorted.length ? sorted[Math.floor(sorted.length / 2)] : (S[0].dur || 1);
        var lastDur = S[n - 1].dur;
        if (tr.kind === 'vide' && result.retimed) lastDur = tr.ts / Math.round(opts.fps);
        else if (!(lastDur > 0) || lastDur > typical * 4) lastDur = typical;
        durs.push(lastDur);
        var total = 0;
        for (i = 0; i < n; i++) { S[i].outDur = durs[i]; total += durs[i]; }
        tr.durMedia = total;
        tr.startMovie = Math.round((times[0] / tr.ts - minStart) * movieTs);
        tr.durMovie = Math.round(total / tr.ts * movieTs);
        movieDuration = Math.max(movieDuration, tr.startMovie + tr.durMovie);
        if (tr.kind === 'vide') result.frames = n;
        result.tracks.push({ kind: tr.kind, samples: n, seconds: total / tr.ts });
      });

      // 出力の並び: ftyp → moov → 元の mdat をそのまま（データ本体は複写せず参照するだけ）
      var mdats = boxes.filter(function (b) { return b.type === 'mdat'; });
      if (!mdats.length) throw new Error('mdat がありません');
      var ftyp = box('ftyp', [new Uint8Array([0x69, 0x73, 0x6F, 0x6D, 0, 0, 2, 0]),            // isom
        new Uint8Array([0x69, 0x73, 0x6F, 0x6D, 0x69, 0x73, 0x6F, 0x32, 0x61, 0x76, 0x63, 0x31, 0x6D, 0x70, 0x34, 0x31])]);   // isom iso2 avc1 mp41
      var info = { tracks: tracks, movieDuration: movieDuration };

      function layout(use64) {
        var zero = {};
        order.forEach(function (tid) { zero[tid] = tracks[tid].chunks.map(function () { return 0; }); });
        var headLen = ftyp.length + buildMoov(moovU8, { data: moovBox.hs, end: moovU8.length }, info, zero, use64).length;
        var pos = headLen;
        mdats.forEach(function (m) { m.newStart = pos; pos += m.size; });
        var offs = {};
        order.forEach(function (tid) {
          offs[tid] = tracks[tid].chunks.map(function (c) {
            var bytes = 0, k;
            for (k = c.first; k < c.first + c.count; k++) bytes += tracks[tid].samples[k].size;
            for (k = 0; k < mdats.length; k++) {
              var m = mdats[k];
              if (c.offset >= m.start + m.hs && c.offset + bytes <= m.start + m.size) return m.newStart + (c.offset - m.start);
            }
            throw new Error('データの位置が範囲外です');
          });
        });
        return { moov: buildMoov(moovU8, { data: moovBox.hs, end: moovU8.length }, info, offs, use64), total: pos };
      }
      var L = layout(false);
      if (L.total > 0xFFFFFF00) L = layout(true);   // 4GBを超える場合だけ64ビットの位置表を使う
      var parts = [ftyp, L.moov];
      mdats.forEach(function (m) { parts.push(blob.slice(m.start, m.start + m.size)); });
      var out = new Blob(parts, { type: 'video/mp4' });
      if (out.size !== L.total) throw new Error('出力サイズが一致しません');
      result.blob = out;
      result.seconds = movieDuration / movieTs;
      return result;
    }
  }

  root.GGC_MP4 = { fix: fix, retime: retime };
})(typeof window !== 'undefined' ? window : globalThis);
