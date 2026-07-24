# Tab Audio Recorder

Chrome拡張機能: タブの音声を録音し、WebMファイルとして保存する拡張機能

## 概要

ブラウザタブで流れている音声（動画、音楽、配信等）を直接録音し、WebMファイルとしてダウンロードできます。オフラインのWhisper等と組み合わせて文字起こしに活用できます。

## 機能

- **タブ音声キャプチャ**: `chrome.tabCapture` APIを使用してタブの音声を直接取得
- **リアルタイム録音**: MediaRecorder APIによる高品質なWebM/Opus録音
- **アイコンアニメーション**: 録音中に赤色の点滅アニメーションを表示
- **自動ダウンロード**: 録音停止時にWebMファイルを自動保存
- **消音なし**: 録音中もタブの音声を聞けたまま

## インストール

1. `chrome://extensions` を開く
2. 「デベロッパーモード」をON
3. 「パッケージ化されていない拡張機能を読み込む」をクリック
4. `caption-capture` フォルダを選択

## 使い方

1. 音声を録音したいタブを開く
2. 拡張機能アイコンをクリック
3. 「録音開始」をクリック
4. 録音が終わったら「録音停止」をクリック
5. WebMファイルがダウンロードされる

## 仕組み

```
[タブ音声] → chrome.tabCapture → MediaRecorder → [WebMファイル]
                ↓
        AudioContextでスピーカーに返す（消音防止）
```

## ファイル構成

| ファイル | 役割 |
|---------|------|
| `manifest.json` | 拡張機能の設定 (Manifest V3) |
| `background.js` | キャプチャ制御 + ダウンロード + アニメーション |
| `offscreen.js` | 音声録音 (MediaRecorder) + スピーカー出力 |
| `popup.html/js` | ポップアップUI |
| `icons/` | アイコン（通常 + アニメーションフレーム） |

## 技術的なポイント

- **Manifest V3**: 最新のChrome拡張機能形式
- **Offscreen Document**: Service WorkerではDOMが使えないため、音声処理はOffscreen Documentで実行
- **`chrome.tabCapture.getMediaStreamId`**: MV3で推奨されるタブ音声取得方法
- **Base64チャンク転送**: 大きな音声データを分割してService WorkerとOffscreen間で送信

## ライセンス

MIT
