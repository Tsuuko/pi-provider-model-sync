# pi-provider-model-sync

独自 URL を持つ Pi プロバイダの `/models` エンドポイントからモデル一覧を取り込み、Pi のモデルカタログ設定と結び付ける Pi package です。

自前の API ゲートウェイや OpenAI 互換エンドポイントにあるモデルを、Pi 標準のモデル定義(コンテキストサイズ・料金など)を引き回して使えるようにします。モデル定義を 1 つずつ手書きする必要はありません。

## インストール

```bash
pi install git:github.com/Tsuuko/pi-provider-model-sync
```

または https 形式でもインストールできます。

```bash
pi install https://github.com/Tsuuko/pi-provider-model-sync
```

プロジェクト単位にインストールする場合は `-l` を付けてください。

## 使い方

### 1. `models.json` にプロバイダを追加する

`~/.pi/agent/models.json`(グローバル設定ディレクトリ配下。`PI_CODING_AGENT_DIR` で変更可能)は **Pi 標準の**プロバイダ定義ファイルです。ここに接続先を追加し、`models: []`(空配列)を付けるとこのパッケージがモデル一覧を自動取り込みます。

```json
{
  "providers": {
    "test-provider1": {
      "baseUrl": "https://example.com/v1",
      "api": "openai-completions",
      "authHeader": true,
      "headers": {},
      "models": []
    }
  }
}
```

| フィールド   | 必須 | 説明                                                                     |
| ------------ | ---- | ------------------------------------------------------------------------ |
| `baseUrl`    | ○    | 接続先ベース URL                                                         |
| `api`        | ○    | 使用する API 形式(後述)                                                  |
| `modelsUrl`  | -    | モデル一覧の取得先 URL。省略時は `<baseUrl>/models`                      |
| `authHeader` | -    | `true` で保存済みの apiKey を `Authorization: Bearer ...` ヘッダーに変換 |
| `headers`    | -    | 追加ヘッダー(`Authorization` を直接書いても構いません)                   |
| `models`     | -    | `[]` でこのパッケージの対象になる。省略時は対象外                        |

`api` には Pi が対応する次の値を使えます。

```text
openai-completions    openai-responses      azure-openai-responses
openai-codex-responses  anthropic-messages  google-generative-ai
google-vertex         mistral-conversations bedrock-converse-stream
pi-messages
```

認証は、Pi に保存済みの apiKey に `authHeader: true` を付けるか、`headers` に直接書きます。

> **モデル一覧取得のレスポンス形式**: `{ "data": [{ "id": "...", ... }] }` という **OpenAI 互換形式**である必要があります。catalog 形式など別形式を返すエンドポイントしかない場合は、OpenAI 互換の `/models` を持つホストを `baseUrl` / `modelsUrl` に指定してください。
>
> 例: Z.ai など catalog 形式と OpenAI 互換 API を別 URL で提供しているプロバイダ

```json
{
  "providers": {
    "test-provider1": {
      "baseUrl": "https://example.com/v1",
      "modelsUrl": "https://openai-compat.example.com/v1/models",
      "api": "openai-completions",
      "models": []
    }
  }
}
```

### 2. Pi を起動して初回取り込み

起動時(セッション開始時)に `models: []` のプロバイダへ `/models` を取り込み、次の `model-sources.json` に雛形を自動生成します。接続情報はすべて `models.json` の値が使われ、Pi カタログ側のものは引き継ぎません。

### 3. `model-sources.json` で参照先や上書きを調整する

`~/.pi/agent/extensions/pi-provider-model-sync/model-sources.json` は、プロバイダごとのモデル一覧と設定の参照を管理するファイルです。初回取り込み後は自動更新されません。

```json
{
  "providers": {
    "test-provider1": {
      "override": {
        "contextWindow": 131072,
        "compat": {
          "supportsReasoningEffort": false
        }
      },
      "models": [
        { "id": "gpt-5.6-sol", "config": "" },
        { "id": "gpt-5.6-terra", "config": "openai/gpt-5.6-sol" }
      ]
    }
  }
}
```

| 項目       | 必須 | 説明                                                                                              |
| ---------- | ---- | ------------------------------------------------------------------------------------------------- |
| `id`       | ○    | プロバイダの `/models` が返す ID                                                                  |
| `config`   | -    | Pi カタログのどのモデル設定を使うか(下表)                                                         |
| `override` | -    | 取得元設定の上書き。モデル単位(`models[].override`)とプロバイダ単位(全体)があり、モデル単位が優先 |

`config` の指定と意味:

| 書き方             | 意味                                                                         |
| ------------------ | ---------------------------------------------------------------------------- |
| 未指定 / `null`    | プロバイダの `config` を継承(未指定ならプロバイダ config も未指定として扱う) |
| `""`(空文字)       | Pi デフォルト設定(`/models` 単体で完結)                                      |
| `"provider/model"` | Pi カタログの該当モデル設定を参照(例: `openai/gpt-5.6-sol`)                  |
| `"provider"`       | Pi カタログ内でそのプロバイダの同 ID モデルを参照                            |

プロバイダ単位の `config` も指定できます。モデルの `config` が未指定の場合、プロバイダの `config` が使われます(モデルの指定が優先)。

`override` では `id` / `config` 以外のモデル定義フィールド(`contextWindow`、`maxTokens`、`compat` など)を上書きできます。Pi カタログのモデルがどんなフィールドを持つかは <https://pi.dev/api/models> で確認できます。

初回登録・`/reload-provider` での新規モデルは `config: null` で雛形化されます。必要に応じて `config` を書き換えてください。

### 4. モデルを使う

一度取り込んだモデルは、次回以降の起動で拡張ロード時に自動登録されます。`--list-models` や `/scoped-models` から選択できます。設定変更後は `/reload-provider` で反映します。

> 初回起動直後(キャッシュ未作成)はモデル確定がセッション開始時に行われるため、`--list-models` には表示されません。2 回目以降の起動から表示されます。

## コマンド

```text
/reload-provider <provider>
```

独自プロバイダの `/models` と Pi の全モデルカタログを再取得します。新規モデルは `{ "id": "..." }` で追加され、既存モデルの `config` / `override` は変更されません。API に存在しなくなった ID は削除せず残します。

## 動作

- Pi カタログは `pi.dev/api/models` から取得し、初回登録時と `/reload-provider` の実行時に更新します。`cache/models.json` が存在しない場合は起動時に取得し、それ以外の起動では再利用します。
- `baseUrl` / `api` は常に `models.json` の値を使います。
- 通常の起動では、既存の `model-sources.json` の内容(config / override 含む)を一切変更しません。`model-sources.json` が正です。

## ファイル配置

```text
~/.pi/agent/
├── models.json                                  # 自分で編集(Pi 標準)
└── extensions/pi-provider-model-sync/
    ├── model-sources.json                       # 自動生成後に自分で調整
    └── cache/models.json                        # 自動管理
```

## トラブルシューティング

- **`The /models response must contain a data array.`** — 取得先の `/models` が OpenAI 互換形式ではない(`{ "data": [...] }` でない)ときに出ます。OpenAI 互換 API の URL を `baseUrl` に指定するか、`modelsUrl` で `/models` 相当の URL を指してください。
- **`Provider xxx: baseUrl is required.` / `api is required.`** — `models.json` の該当プロバイダに `baseUrl` と `api` の両方が必要です。
- **初回取り込みで `model-sources.json` が作られない** — 対象は `models: []` のプロバイダだけです。接続先(`/models` の HTTP エラー)にも問題がないか確認してください。失敗時は通知が出ます。

## 開発

```bash
pnpm install
pnpm typecheck  # TypeScript 型チェック
pnpm lint       # oxlint (type-aware)
pnpm test       # node --test
```

詳細設計は [SPEC.md](./SPEC.md) を参照してください。
