/*
 * GOLF GUTS CAMERA 設定ファイル
 * ロゴの位置・大きさ・透明度などは、このファイルの数字を書き換えるだけで変更できます。
 * （GitHubの画面でこのファイルを開き、鉛筆マークから編集 → Commit changes）
 */
window.GGC_CONFIG = {

  // ───── ロゴ ─────
  logo: {
    // ロゴ画像のファイル名（上から順に探します。背景が透明なPNGを推奨）
    files: ['logo.png', 'logo.webp', 'logo.jpg', 'logo.jpeg'],

    // 位置： 'bottom-right'（右下） / 'bottom-left'（左下） / 'top-right'（右上） / 'top-left'（左上）
    position: 'bottom-right',

    // 大きさ：動画の「短い辺」に対するロゴの横幅の割合（0.30 = 30%）
    widthRatio: 0.30,

    // ロゴの高さの上限：動画の「短い辺」に対する割合（縦長のロゴが大きくなりすぎないための上限）
    maxHeightRatio: 0.20,

    // 端からの余白：動画の「短い辺」に対する割合
    marginRatio: 0.035,

    // 透明度：1 = 透明なし、0.5 = 半透明
    opacity: 1
  },

  // ───── 動画 ─────
  video: {
    // 希望する解像度とフレームレート（iPhone側が対応する範囲で自動調整されます）
    // 録画がカクつく・本体が熱くなる場合は width:1280, height:720 に下げてください
    width: 1920,
    height: 1080,
    frameRate: 30,

    // 画質（ビットレート）。大きいほど高画質・大容量。10000000 = 10Mbps
    bitsPerSecond: 10000000,

    // 1回の録画の上限（秒）。メモリ不足を防ぐため、上限に達すると自動で録画を止めて保存画面に進みます
    maxSeconds: 600
  },

  // ───── 音声 ─────
  audio: {
    // true = 通話用の音声加工（ノイズ除去など）をできるだけオフにして、打球音を自然に録る
    natural: true,
    bitsPerSecond: 128000
  },

  // ───── 写真 ─────
  photo: {
    // JPEGの画質（0〜1）
    quality: 0.95,
    // 写真にもロゴを入れる場合は true
    logo: false
  },

  // 起動時のモード： 'video'（ビデオ） / 'photo'（写真）
  defaultMode: 'video'
};
