# 蝶の森へ

正面カメラで顔を認識し、頭の周囲を蝶が舞うスマートフォン向けAR PWAです。カメラ映像と顔ランドマークは端末内だけで処理されます。

## 開発

```sh
npm install
npm run dev
```

PCでは `http://localhost:5173` で確認できます。スマートフォンのカメラを使う場合は、HTTPSで配信されたURLが必要です（`localhost`のみHTTPでも利用できます）。

## ビルド

```sh
npm run build
npm run preview
```

`dist/` をHTTPS対応の静的ホスティングへ配置してください。

## 実機確認

- Android Chrome / iOS Safariで正面カメラを許可できる
- カメラが鏡像表示され、蝶が額付近に追従する
- 顔の一時消失や画面回転後も表示が破綻しない
- 「終了」やバックグラウンド移行でカメラ利用が停止する
- ホーム画面に追加し、スタンドアロン表示で起動できる

## 主な構成

- Three.js: GLBモデルの表示と羽ばたきアニメーション
- MediaPipe Face Detector: 顔位置・幅・傾きの推定
- Vite PWA: Service Workerとオフラインキャッシュ

## ライセンス

MIT License
