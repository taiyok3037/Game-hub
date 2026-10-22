# 仕様 01：遊び心地の改善（手番の分かりやすさ・全員準備・効果音・PCレイアウト）

対象：基盤（server.js / public/）＋ きゅうり。三目並べ・ババ抜きも基盤変更に追従させる。
前提：CLAUDE.md の「守ること」に従う。

## 背景（実際に遊んだ感想）
1. 自分の番になったのが分かりにくい
2. 7トリック後の「次の配りへ」を誰か1人が押すと進んでしまう。全員がそろってから進みたい
3. カードを出した・トリックを取った・自分の番が来た、などで音が欲しい
4. PCだと左右の余白がもったいない。ルールを表示したまま遊びたい

方針：1・3・4 は今後のゲームでも必要なので**基盤の機能**として作る。2 はきゅうり側で作るが、基盤からホスト情報と接続状況を渡せるようにする。

---

## A. 基盤の変更

### A-1. ゲームインターフェースの追加（後方互換）

`games/<id>/server.js` に次を追加できるようにする。どれも任意。

| 追加 | 内容 |
|---|---|
| `action(state, playerId, action, room)` | 第4引数 `room = { hostId, connectedIds: string[] }` を渡す。既存ゲームは無視してよい |
| `turnOf(state)` → `string[]` | いま操作を待っているプレイヤーIDの配列。いなければ `[]` |
| `onConnectionChange(state, room)` → `boolean` | 誰かが切断・再接続したときに呼ぶ。state を変えたら `true` を返し、基盤が全員に再送する |

`server.js` の変更点：
- `game:action` で `game.action(room.state, player.id, action, roomInfo(room))` を呼ぶ。`roomInfo` は `{ hostId, connectedIds }`
- `broadcast()` で各プレイヤーに次の2つを追加で送る
  - `turnIds`：`game.turnOf ? game.turnOf(state) : []`
  - `yourTurn`：`turnIds.includes(p.id) && phase === 'playing'`
- 切断（disconnect）と再接続（room:rejoin）の後、ゲーム中なら `game.onConnectionChange?.(state, roomInfo(room))` を呼ぶ。`true` が返ったら `isOver` を確認してから broadcast する
- 三目並べ・ババ抜き・きゅうりに `turnOf` を実装する（それぞれ現在の手番の人を1人返す。終了時は `[]`）

### A-2. クライアントに渡す ctx の追加（public/app.js）

`render(root, v, ctx)` の `ctx` に次を足す。

| 追加 | 内容 |
|---|---|
| `ctx.prev` | 同じルーム・同じゲームで**前回描画した view**。初回・再接続直後・ロビーから戻った直後は `null` |
| `ctx.yourTurn` | サーバーから来た `yourTurn` |
| `ctx.turnIds` | サーバーから来た `turnIds` |
| `ctx.isHost` | 自分がホストか |
| `ctx.sound(name)` | 効果音を鳴らす（A-4） |

`prev` は、`render` を呼んだ後に `lastView = r.view` として保存する。room.code か gameId が変わったら、またはロビーに戻ったら `null` に戻す。

### A-3. 手番の演出（基盤で共通に行う）

`yourTurn` が **false → true** に変わったとき：
1. 効果音 `turn` を鳴らす
2. 画面中央に「あなたの番です」バナーを 1.2 秒表示する。紙のメモ風で、`pointer-events: none`。表示はフェードイン＋少し拡大、消えるときはフェードアウト
3. `navigator.vibrate?.(60)` を呼ぶ（対応端末のみ）

`yourTurn` が true の間：
- `#screen-game` に `my-turn` クラスを付ける。CSS で `.felt` の枠を金色（`--gold`）にし、2 秒周期でゆっくり光らせる（box-shadow のパルス）。`prefers-reduced-motion` のときはパルスせず、金色の枠だけにする
- `document.title` を `● あなたの番｜ゲームハブ` にする。false に戻ったら元のタイトルに戻す（別タブを見ていても気づけるように）

### A-4. 効果音（public/lib/sound.js を新規作成）

音声ファイルは使わず、**Web Audio API で合成**する（著作権の心配がなく、ファイル追加も不要）。

```js
export function play(name)        // 鳴らす。ミュート中は何もしない
export function setMuted(bool)    // localStorage 'gamehub-sound' に 'off' / 'on' を保存
export function isMuted()
```

- AudioContext は最初の `pointerdown` か `keydown` で作成・resume する（ブラウザの自動再生制限への対策）
- 全体の音量はマスターゲイン 0.35
- 音の目安（短く・柔らかく、ゲームの邪魔をしない程度）

| name | 用途 | 作り方の目安 |
|---|---|---|
| `card` | カードを出した | ホワイトノイズ 70ms、bandpass 1800Hz、減衰の速いエンベロープ（「パサッ」） |
| `trick` | トリックが決まった | triangle波 660Hz→880Hz の2音、各110ms |
| `turn` | 自分の番 | sine波 523→659→784Hz の3音、各90ms、余韻200ms |
| `ready` | 誰かが準備OK | sine波 1046Hz、60ms（「ポン」） |
| `penalty` | 失点 | triangle波 392Hz→262Hz の2音、各160ms |
| `cucumber` | きゅうり獲得・脱落 | square波（音量控えめ）400Hz→140Hz へ 350ms でピッチスライド（「ボヨン」） |
| `win` | 勝敗決定 | sine波 523/659/784/1046Hz のアルペジオ、各100ms |

- ゲームバーの「退店」の左にミュート切替ボタンを置く。スピーカーアイコンはインラインSVG、`aria-label` は「効果音オン」「効果音オフ」で切り替え、`aria-pressed` も付ける
- `toast` でエラーを出すときは音を鳴らさない

### A-5. PCレイアウトとルール常時表示

ゲーム側の作法：
- `client.js` は `export const rules = '<ul>…</ul>'` でルールのHTMLを公開できる（任意）
- `render` の出力は次の形にそろえる（`.g-side` は任意）
  ```html
  <div class="g-layout">
    <div class="g-main"> 卓（.felt）と手札（.hand） </div>
    <div class="g-side"> 得点表や記録など </div>
  </div>
  ```

基盤側（index.html / app.js / style.css）：
- ゲーム画面を `<div class="game-layout"><div id="game-root"></div><aside id="game-rules" class="rules-panel"></aside></div>` にする
- `rules` があれば `#game-rules` に「ルール」見出し付きで描画する。なければ aside を隠す
- ブレークポイントごとの配置

| 画面幅 | 配置 |
|---|---|
| 1100px 以上 | 3列。左に `.g-side`（260px）、中央に `.g-main`（最大560px）、右にルール（300px）。全体は最大 1240px で中央寄せ。ゲームバーも同じ幅に合わせる |
| 768〜1099px | 2列。左に `.g-main` で、その下に `.g-side`。右にルール（280px） |
| 767px 以下 | 1列（今と同じ）。`.g-side` は手札の下。ルールは aside を隠し、ゲームバーに「ルール」ボタンを出して `<dialog>` のボトムシートで開く（閉じるボタンと背景タップで閉じる） |

- ルールパネルは紙のパネル風（`--paper`）で `position: sticky; top: 16px`。長い場合はパネル内でスクロールさせる
- ホーム・ロビーの幅は今のまま（最大560px）

---

## B. きゅうりの変更

### B-1. 手番を分かりやすくする
- 席（`.seat`）に状態バッジを付ける
  - このトリックで出し終えた人：「出した」（薄く表示）
  - 現在の番：「番」（金色。今の `turn` 表示）
  - 次の番：「次」（点線の枠）
- 自分の番でないときのメモは「べん さんの番（このトリックは あと2人）」と表示する
- 自分の番のときは、手札エリア（`.hand-head` と `.hand`）を金色の枠で囲み、見出しを「あなたの番です｜明るいカードを選んでください」にする。出せるカードは少し浮かせ（`translate: 0 -6px`）、出せないカードは今のまま暗くする

### B-2. 決まったトリックを少し見せる
今はトリックが決まった瞬間に場が空になり、最後の1枚が見えない。
- `ctx.prev.trickNo !== v.trickNo` で、かつ `v.lastTrick` があるとき、場には `v.lastTrick` を **1.5 秒**表示する。取った人のカードは金枠にし、ラベルに「○○さんが取った」と出す
- その後、自動で現在のトリック表示に切り替える。client.js のモジュール変数 `holdUntil` と `setTimeout` を使い、同じ `root` / `v` / `ctx` で再度 `render` する
- 表示中にサーバーから更新が来たら、その時点で保留をやめて最新を描く。最初のリードをすぐ出せるようにするため

### B-3. 全員の「準備OK」で次の配りへ
state に `ready: number[]`（準備OKを押した席番号）を追加する。

- 7トリック目が終わって `phase = 'result'` になったら `ready = []` にする
- 必要な人：`needIds` = 脱落しておらず、かつ `room.connectedIds` に含まれる人
- action
  - `{ type: 'ready', on: boolean }`：自分の準備OKを付け外しする。`result` 以外のときはエラーにする
  - `{ type: 'forceNext' }`：ホストのみ（`playerId === room.hostId`）。全員を待たずに次の配りへ進む
  - 既存の `{ type: 'next' }` は削除する
- `ready` に `needIds` が全員入ったら、その場で `deal(state)` する。`ready` 操作の直後と `onConnectionChange` の両方でこの判定を行う。後者があるので、最後の1人が切断しても止まらない
- 脱落した人も「準備OK」を押せてよい（数には入れない）
- view に追加：`readyIds`、`needIds`
- 画面（結果パネル内）
  - 必要な人の一覧に、✓（準備OK）か「待ち」を付ける。表示は「準備OK 2 / 4」
  - 自分のボタン：未押下なら「準備OK」（primary）、押下済みなら「取り消す」（通常ボタン）。自分が未押下の間は、ボタンを A-3 と同じ金色パルスで目立たせる
  - ホストには小さく「待たずに次へ」（ghost）を出す
- `turnOf` は `phase === 'play'` のときだけ手番の人を返し、`result` では `[]` を返す（バナーは出さない）

### B-4. 効果音（ctx.prev との差分で鳴らす）
`render` の冒頭で `prev` と `v` を比べ、1回の更新で鳴らす音は最大1つ、優先度の高いものを選ぶ。

| 優先 | 条件 | 音 |
|---|---|---|
| 1 | `phase` が `over` に変わった | `win` |
| 2 | `result` が新しく出て、`lifeLost` または `eliminated` | `cucumber` |
| 3 | `phase` が `result` に変わった | `penalty` |
| 4 | `lastTrick.no` が変わった（7トリック目以外） | `trick` |
| 5 | 場のカード枚数が増えた | `card` |
| 6 | `readyIds` が増えた | `ready` |

`turn` は基盤が鳴らす（A-3）。`prev` が `null` のときは何も鳴らさない。

### B-5. PCレイアウトへの対応
- ルールの `<details>` は削除し、`export const rules` に移す（文言は今のまま）
- `.g-side` に次を置く
  - **得点表**：名前、点数バー（21点まで）、点数、きゅうりの数、手札の枚数、親マーク。脱落者は薄く、点数の少ない順に並べる
  - **記録**：直近10件（今の `.log`）
- 卓の上の席（`.seats`）は手番表示のために残す。卓の中の `.log` は `.g-side` に移したので卓からは消す

### B-6. 三目並べ・ババ抜き
- `turnOf` を実装する
- `rules` を書く（それぞれ3〜5行）
- `.g-layout` / `.g-main` の形にそろえる。`.g-side` は、ババ抜きは記録（.log）を移す。三目並べは無しでよい
- 効果音：三目並べは石を置いたら `card`、決着したら `win`。ババ抜きは引いたら `card`、ペアを捨てたら `trick`、決着したら `win`

---

## C. 実装順（1項目ごとにコミット）
1. A-1, A-2：基盤のインターフェースと ctx（既存3ゲームの `turnOf` を含む）
2. A-4：sound.js とミュートボタン
3. A-3：手番の演出
4. A-5：レイアウトとルールパネル（3ゲームの `rules` と `.g-layout` 化を含む）
5. B-1〜B-5：きゅうり
6. B-6：三目並べ・ババ抜きの効果音

## D. 確認項目（完了条件）
- [ ] 4人できゅうりを遊び、自分の番になるとバナー・音・金枠・タブタイトルで分かる
- [ ] 別タブを見ている間に自分の番になると、タブタイトルが「● あなたの番」になる
- [ ] 7トリック目の後、全員が「準備OK」を押すまで次の配りに進まない。誰かが取り消すと待ちに戻る
- [ ] 結果画面で1人が切断すると、残り全員が準備OKなら進む。ホストは「待たずに次へ」で進められる
- [ ] トリックが決まると最後の4枚が1.5秒見え、「○○さんが取った」と出てから次のトリックになる
- [ ] 各効果音が鳴る。ミュートにすると鳴らず、リロードしてもミュートのまま
- [ ] 1280px 幅で3列、900px 幅で2列、390px 幅で1列＋ルールのボトムシートになる。どの幅でも横スクロールが出ない
- [ ] 三目並べ・ババ抜きが今までどおり最後まで遊べる
- [ ] きゅうりの乱数テスト（setup から isOver まで2〜7人×数千回）を、`ready` / `forceNext` / 切断の分岐を含めて更新し、通ること
