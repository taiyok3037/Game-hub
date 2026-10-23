# Game Hub — Claude Code 向けメモ

友人とブラウザで遊ぶオンラインゲーム集。Node.js + Express + Socket.IO、フロントは素のHTML/JS（ビルドなし）。Render の無料Web Serviceで公開している。

## 構成
- `server.js` … 共通基盤。ルーム（4文字コード）・ロビー・再接続・退出処理・`games/` の自動読み込み。**ゲーム固有の処理は書かない**
- `public/` … 共通画面（ホーム→ロビー→ゲーム）。`style.css` に卓上カフェ風テーマと共通部品、`lib/cards.js` にトランプ描画関数、`lib/timer.js` に締め切りタイマー表示（`timerHTML`）、`chat.js` にルームチャット。クイックリアクションの定型文は `lib/reactions.js`（サーバー共通・`/lib/reactions.js` で配信）
- `games/<id>/server.js` … ルール。`setup(players, options) / action / view / isOver`（任意で `onLeave / turnOf / onConnectionChange / isOut / spectatorView / options / deadline / onTimeout`）を持つ
- `games/<id>/client.js` … `export function render(root, view, ctx)`。毎回まるごと描き直す
- `games/<id>/client.css` … そのゲームだけの見た目
- `templates/new-game/` … 新規ゲームのひな形

## 守ること
- ルール判定はすべてサーバー（`action`）で行う。クライアントは描画と `ctx.send(action)` だけ
- 隠し情報（他人の手札・山札など）は `view(state, playerId)` で必ず外す。他人の手札は枚数だけ送る
- 隠し情報があるゲームは `spectatorView(state, { seesAll, viewerId })` を必ず書く。`seesAll=false`（既定）では **プレイヤー全員に見えている情報だけ** を返す（誰か1人にでも隠れている情報は出さない）。脱落・上がり・退席した人は `isOut(state, playerId)` で true を返すと、観戦者と同じ見え方になる
- ルール違反は `{ error: '日本語メッセージ' }` を返す（例外を投げない）
- ユーザーが入力した文字列（名前・チャットなど）は必ずエスケープして表示する（`textContent` か `esc()`）。生の文字列を `innerHTML` に入れない。HTMLとして解釈させない
- 席を描くゲームは、席の要素に `data-member-id="<id>"` を付ける（基盤がその上にリアクションの吹き出しを重ねる）
- `games/<id>` のフォルダ名と `id` を一致させる
- 見た目は卓上カフェ風に統一：卓は `.felt`、案内は `.note`、席は `.seats/.seat/.seat-chip`、トランプは `cardHTML()/backHTML()`、手札は `.hand`、記録は `.log`。色は `style.css` の CSS変数を使う
- 紙色の面（パネルや結果パネルなど）には `.paper` を付ける（上に置くボタンの色が自動で紙向けに切り替わる。`.btn.ghost` は木目・フェルト用の明るい色なので、紙の上では `.paper` がないと見えにくい）
- 画面はスマホ幅（390px）で崩れないこと
- UIの文言は日本語

## 基盤の機能（任意で使う）
- **ゲーム設定（options）**：`options: [{ key, label, type, min/max or choices, default, showIf }]` を宣言すると、ロビーでホストが変更できる（`type` は `int` / `select` / `bool`、`choices` は関数でもよい、`showIf: { key, equals }` で出し分け）。現在値は `setup(players, options)` に渡る。サーバーが型と範囲を検証し、変更すると全員の準備OKが外れる。設定はロビーに戻っても維持される
- **タイマー（deadline / onTimeout）**：`deadline(state)` が締め切りの時刻（ms・サーバー時計）を返すと、基盤が締め切りで `onTimeout(state, room)` を呼ぶ。画面は `/lib/timer.js` の `timerHTML(deadline, ctx)` で残り時間を出せる（`ctx.clockOffset` で時計のずれを補正・残り5秒から `tick` 音）
- **broadcast の抑止**：`action` が `{ silent: true }` を返すと、その操作を全員に配信しない（本人だけで完結する下書き保存などに使う）

## 確認方法
- 開発中は `npm run dev` で起動する（保存で自動再起動。サーバーのコードやルートを変えたら再起動が要るため）
- `npm start` → http://localhost:3000 を通常ウィンドウとシークレットウィンドウで開いて2人で遊ぶ
- ルールを変えたら、`setup` から `isOver` まで乱数で何千回も回すスクリプトで不整合（終わらない・手番がおかしい・カード枚数が合わない）がないか確かめる

## 公開
- GitHub の main に push すると Render が自動で再デプロイする
- 再デプロイ・再起動でルームは消えるので、友人が遊んでいる最中は push しない

## Git
- 作業は機能ごとにブランチを切る（feature/xxx）
- main へのマージと push は、ユーザーが「マージして」と言ったときだけ行う
- push 前に npm test を実行し、失敗したら push しない
- `[skip render]` はドキュメントだけの push で使う。アプリの変更と同じ push に含めない（最新コミットに付くとアプリ側のデプロイもスキップされるため）