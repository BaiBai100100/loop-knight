# ループ・ナイト v1.0 リリース計画

現状: `index.html` 単体（850行）、10秒ループ＋ゴースト共闘、PC/スマホ操作、GitHub Pages 公開済み。
目標: 「ストアに並べても恥ずかしくない」ブラウザゲーム。遊び続けたくなる深さ、気持ちいい手触り、音、インストール可能（PWA）、共有できる。

## ファイル所有（並列作業の衝突防止）
| ファイル | 担当 | 備考 |
|---|---|---|
| `index.html` | A（ゲーム本体） | 他の担当は編集禁止 |
| `audio.js` | B（サウンド） | 下記インターフェースを厳守 |
| `manifest.webmanifest`, `sw.js`, `icons/*`, `og.png`, `README.md`, `LICENSE`, `head-snippet.html` | C（リリース素材） | `index.html` には触らず、差し込み用スニペットを `head-snippet.html` に置く |

## サウンド API（B が実装、A が呼ぶ）
`audio.js` は classic script で `window.Sound` を定義する。index.html は `<script src="audio.js"></script>` で読み込む。
A は `audio.js` が無くても動くよう、`const Sound = window.Sound || stub`（全メソッド no-op）で受ける。

```
Sound.unlock()                 // 最初のユーザー操作で呼ぶ（iOS対策）。何度呼んでも安全
Sound.play(name, opts?)        // name: 'shoot' | 'ghostShoot' | 'hit' | 'enemyDie' | 'ghostKill' | 'split'
                               //   | 'chargerWarn' | 'enemyShot' | 'playerHurt' | 'rewind' | 'loopClear'
                               //   | 'upgradePick' | 'uiTap' | 'bossSpawn' | 'bossHit' | 'bossDie' | 'gameOver' | 'newBest'
                               // opts: { pan?: -1..1, intensity?: 0..1 }  未知の name は無視
Sound.music(mode)              // 'title' | 'play' | 'boss' | 'off'
Sound.setIntensity(x)          // 0..1 ループ進行で曲を厚くする
Sound.setVolume({ master?, sfx?, music? })  // 0..1。localStorage に保存（try/catch）
Sound.getVolume()              // { master, sfx, music }
Sound.pauseAll() / Sound.resumeAll()
```
- すべて WebAudio で手続き生成（音声ファイルなし）。同時発音数を制限（shoot は間引く）。
- ゴーストが多いと射撃音が鳴りすぎるので `ghostShoot` は控えめ・強い間引き。

## ゲームプレイ追加（A）
1. **アップグレード・ドラフト**: ループクリアごとに3枚のカードから1つ選ぶ（クリック/タップ/1-3キー）。
   肝: 能力は**過去の自分（ゴースト）にも適用される**（射撃フラグは記録済みなので連射・拡散などは自然にゴーストにも効く）。
   例: 連射+、3way拡散、貫通、弾サイズ+、移動速度+、最大HP+1、全回復、ゴースト上限+2、ゴーストの弾が着弾で小爆発、など8〜10種。レア度あり。
2. **ボス**: 5ループごと。ボスは**ループをまたいでHPが持ち越し**、巻き戻っても消えない。ゴーストの集中砲火で削る設計。撃破で大ボーナス。HPバー表示。
3. **新しい敵**: 射撃型（遅い弾を撃つ砲台）。避ける要素を追加。
4. **ゴーストの軌跡予告**: 各ゴーストの0.7秒先までの経路を薄く表示（設定でON/OFF）。
5. **初回チュートリアル**: 1ループ目「10秒後、今の動きがゴーストになる」、2ループ目「過去の自分が戦っている！」など。初回のみ（localStorage）。
6. **手触り**: ヒットストップ（撃破時 2〜3tick）、被弾時の赤フラッシュ＋スマホは `navigator.vibrate`、敵の被弾白フラッシュ、撃破パーティクル強化、高DPI でくっきり描画（DPR 最大2）、パーティクル上限。
7. **統計**: ゲームオーバーで到達ループ、撃破数、ゴースト撃破数、取得アップグレード一覧、ベスト更新表示。

## UX シェル（A、フェーズ2）
- 一時停止メニュー: 再開 / リスタート / タイトルへ / 設定。
- 設定: 音量（マスター・効果音・BGM）、画面揺れ ON/OFF、ゴースト軌跡 ON/OFF。`prefers-reduced-motion` なら揺れ・フラッシュ既定OFF。
- 共有ボタン: Web Share API、なければ X 投稿リンク＋クリップボードコピー。文面に到達ループとスコア、URL。
- 日本語/英語: `navigator.language` で自動、設定で切替。
- C の `head-snippet.html` を `<head>` に統合、Service Worker 登録。

## リリース素材（C）
- PWA: manifest（name, short_name, start_url `./`, display fullscreen, orientation landscape, theme/background color, icons）、`sw.js`（index.html は network-first、その他 cache-first、バージョン付きキャッシュ名、古いキャッシュ削除）。
- アイコン: 192/512/maskable 512/apple-touch 180/favicon（32 PNG）。ネオン系、ゲームの見た目に合わせる。PIL 利用可。
- OGP 画像 `og.png` 1200x630、`head-snippet.html` に OGP/Twitter Card/theme-color/apple-mobile-web-app 系 meta、manifest link、favicon。
- 公開URL: https://baibai100100.github.io/loop-knight/
- README.md（日本語＋英語、遊び方、操作、プレイURL、ライセンス）、LICENSE（MIT、著作者 BaiBai100100）。
