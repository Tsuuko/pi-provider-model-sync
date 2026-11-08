# pi-provider-model-sync

独自プロバイダーの `/models` からモデル一覧を取得し、UIで選択したモデルをPi標準の `models.json` に保存するPi packageです。

**起動時の自動取得・設定合成・`registerProvider()` 呼び出しはありません。** 保存済みのモデルはPi本体が直接読み込みます。

## インストール

```bash
pi install git:github.com/Tsuuko/pi-provider-model-sync
```

プロジェクト単位にインストールする場合は `-l` を付けてください。

## 使い方

### 1. 接続先を `models.json` に追加

`~/.pi/agent/models.json` にプロバイダーを定義します。`PI_CODING_AGENT_DIR` で設定ディレクトリを変更できます。

```json
{
  "providers": {
    "my-provider": {
      "baseUrl": "https://example.com/v1",
      "api": "openai-completions",
      "apiKey": "$MY_API_KEY",
      "authHeader": true,
      "models": []
    }
  }
}
```

`models: []` は「モデル未登録」を意味し、自動取得の指定ではありません。既に `models` があるプロバイダーも更新できます。

一覧取得先は通常 `<baseUrl>/models` です。別のURLを使う場合はプロバイダーに `modelsUrl` を指定します。レスポンスはOpenAI互換形式 `{ "data": [{ "id": "model-id" }] }` が必要です。空の `data` 配列も受け付けます。

一覧取得時の認証にはPiが解決した認証情報を使用します。ヘッダーは設定ファイル、Pi登録済みプロバイダー、認証情報の順に上書きします。`authHeader: true` の場合、既存のAuthorizationがなければ解決済みAPIキーをBearerとして付与します。

### 2. UIでモデルを選択

```text
/provider-models
```

最初に次の3項目を表示します。

```text
Apply model settings
Manage models
Open model-sources.json
```

`Apply model settings` はsourcesに記載したモデルの追加・設定更新、`Manage models` は採用モデルの選択です。`Open model-sources.json` は設定ファイルをOSの既定のアプリで開き、最初のメニューへ戻ります。ファイルの自動作成・設定の自動適用は行いません。編集・保存後に `Apply model settings` で反映してください。

1. 最初のメニューで `Manage models` を選び、`models.json` のプロバイダー一覧から選択します。
2. `/models` の取得結果・`models.json` の登録済みモデル・`model-sources.json` に記載されたモデルの和集合を表示します。
3. `models.json` に登録済みのモデルはチェックON、それ以外（sourcesにだけ残っているモデルも含む）はOFFです。**一覧を開いた時点でONのモデルを先頭にまとめます。** 操作中にチェックを切り替えても行の順序は変わりません。
4. API取得結果にないモデルは**黄色**と `Not listed by API` の表示で区別し、チェックON/OFFそれぞれの中で先頭にまとめます。各グループ内の順序は維持します。登録済みモデルはチェックを維持すれば削除されず、sourcesにだけあるモデルはチェックを入れて追加できます。

| キー               | 操作                                               |
| ------------------ | -------------------------------------------------- |
| ↑ / ↓              | 1項目ずつ移動（端に達すると1行ずつスクロール）     |
| ← / →              | 前後へ1画面分移動（カーソルの行位置を維持）        |
| Space / Enter      | チェックを切り替え                                 |
| Ctrl+S             | 保存してプロバイダー一覧へ戻る                     |
| Esc                | 保存せずプロバイダー一覧へ戻る                     |
| 文字入力           | モデルIDを部分一致検索（大文字小文字を区別しない） |
| Backspace / Ctrl+U | 検索文字の削除 / 検索をクリア                      |
| Ctrl+C             | どの画面・取得待ちでも操作全体を終了               |

移動操作は「Select a provider」のプロバイダー選択画面でも共通です（Enterで決定、Escでキャンセル）。左右移動の末尾でも表示件数を保つため、最後の表示範囲は前の範囲と一部重なります。すでに末尾の範囲で右を押すとリスト末尾、先頭の範囲で左を押すとリスト先頭へ移動します。

モデル一覧のEscはプロバイダー一覧へ、プロバイダー一覧のEscは最初のメニューへ戻ります。最初のメニューのEscで終了します。`/models` のタイムアウトや取得エラーも通知後にプロバイダー一覧へ戻るので、別のプロバイダーの選択や再試行ができます。同じコマンド実行中は、プロバイダーの選択とスクロール位置を保持します。Ctrl+Sで保存した後もプロバイダー一覧へ戻り、保存したプロバイダーにカーソルを合わせます。`Apply model settings` の成功時はコマンドを終了します。

モデル一覧では文字を入力すると、その文字列を含むIDに絞り込みます。検索文字はタイトル行に表示し、長い入力は入力位置が見えるよう横スクロールします。検索変更時は結果の先頭へ移動します。件数欄には検索一致数/全件数・非表示分を含む選択数・結果内のカーソル位置を表示します。検索で隠れたモデルのチェックは保持され、Ctrl+Sは非表示分も含めて保存します。Space/Enterは検索入力ではなく、従来どおりチェック切り替えです。

削除がある保存だけ、`Save model selection` で `Add` / `Remove` の件数とconfig・overrideの削除を確認します。削除数は両JSONから消えるIDの重複を除いた件数で、sourcesだけに残っているモデルも含みます。キャンセルすると保存せずプロバイダー一覧へ戻ります。追加のみなら確認せず保存します。

保存時の扱い:

- 登録済み＋ON: 既存のモデル定義を保持します。手編集やconfig変更を上書きしません。
- 未登録＋ON: config・overrideを解決して追加します。指定がなければ従来のデフォルト情報を使います。
- OFF: `models.json` と `model-sources.json` の両方から削除します。モデル単位のconfig・overrideも削除されます。全解除も可能です。sourcesにだけある初期OFFのモデルも、選択しないまま保存すると削除します。
- 接続先・認証・他のプロバイダー・その他の設定フィールドは保持します。
- 保存後はPiのモデルレジストリを再読み込みします。

### 3. config・overrideを編集

`~/.pi/agent/extensions/pi-provider-model-sync/model-sources.json` に参照・上書き設定を保持します。UI保存時に選択済みIDの雛形 `{ "id": "...", "config": null }` を補完し、選択中のモデルの既存設定は保持します。チェックOFFのモデルはメタデータごと削除します。

```json
{
  "providers": {
    "my-provider": {
      "config": "openai",
      "override": { "contextWindow": 131072 },
      "models": [
        { "id": "gpt-5.6-sol", "config": null },
        {
          "id": "custom-model",
          "config": "openai/gpt-5.6-sol",
          "override": { "maxTokens": 8192 }
        },
        { "id": "other-model", "config": "" }
      ]
    }
  }
}
```

| 指定                              | 意味                                           |
| --------------------------------- | ---------------------------------------------- |
| モデルのconfig未指定 / `null`     | プロバイダーのconfigを継承。なければデフォルト |
| モデルのconfig `""`               | プロバイダーのconfigを無視し、デフォルト       |
| モデルのconfig `"provider/model"` | 指定モデルの能力情報を参照                     |
| プロバイダーのconfig `"provider"` | そのプロバイダーの同一IDモデルを参照           |

モデル単位のconfigは `provider/model` 形式です。プロバイダー名だけの指定はプロバイダー単位で使います。

合成順は **デフォルト → 参照モデル → プロバイダーoverride → モデルoverride** です。オブジェクトは再帰マージ、配列は置換します。参照先の `id`・`api`・`baseUrl`・`provider` は引き継ぎません。overrideによる `api`・`baseUrl` の明示は可能ですが、`id`・`config` は上書きできません。

`model-sources.json` に記載するだけでは起動時に自動反映されません。`Apply model settings` を実行すると、記載したモデルを `models.json` に追加・更新します。

### 4. sourcesのモデルを追加・更新

`/provider-models` を実行し、最初のメニューで `Apply model settings` を選びます。`models.json` に接続設定があり、sourcesにモデルが記載された全プロバイダーが対象です。**記載されたモデルは未登録なら追加、登録済みなら設定を更新します。** `models: []` やmodels未指定でも追加できます。実際の保存先はPi標準の `models.json` です。確認をキャンセルすると最初のメニューへ戻ります。

sourcesに記載のない既存モデルは、プロバイダー単位のconfig・overrideがあっても変更・削除しません。接続先・認証設定も保持します。対象がある場合は確認後に適用します。

**再適用は対象モデルの定義を作り直すため、`models.json` のモデル単位の手編集は上書きされます。** 手編集を保持したい項目はsourcesのoverrideへ移してください。通常の `Manage models` 保存ではこの再適用は行いません。

Piカタログの参照が必要な場合だけ `https://pi.dev/api/models` を取得し、共通キャッシュに保存します。通信失敗時は既存キャッシュを使います。必要な参照先が見つからなければ `models.json` は保存しません。

## 旧方式からの移行

既存の `model-sources.json` とキャッシュはそのまま利用できます。

以前 `models: []` とsourcesだけで動的登録していた場合は、`/provider-models → Apply model settings` で既存のconfig・overrideを解決して `models.json` に書き出せます。`Manage models` で必要なモデルだけを選んで保存することもできます。以後はPi標準の読み込みだけで利用できます。

## 保存とエラー

- 取得失敗・不正レスポンス・Escでは `models.json` を変更しません。
- Ctrl+Cはメニュー・確認・一覧・通信待ち・認証待ちから操作全体を終了します。保存開始前の変更は破棄しますが、保存が始まった後の確定済み変更は取り消しません。
- 操作中に `models.json` の設定内容が変わった場合は上書きせず、コマンドのやり直しを案内します。
- 保存は一時ファイルからのrenameで行い、既存のファイル権限を維持します。
- **JSONは保存時に整形し直すため、コメントと元の書式は保持しません。** 初回の書き出し前に設定ファイルのバックアップを推奨します。
- 保存後のPi再読み込みが失敗した場合、ファイルは保存済みであることを通知します。
- コマンドは対話UIがある環境で実行してください。

## ファイル配置

```text
~/.pi/agent/
├── models.json                              # 接続設定・採用モデル・解決済み設定
└── extensions/pi-provider-model-sync/
    ├── model-sources.json                   # config・override（手動編集）
    └── cache/models.json                    # Piカタログ（必要時のみ更新）
```

## 開発

```bash
pnpm install
pnpm format
pnpm typecheck
pnpm lint       # oxlint type-aware
pnpm test
```

詳細は [SPEC.md](./SPEC.md) を参照してください。
