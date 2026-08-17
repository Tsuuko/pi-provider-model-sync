# pi-provider-model-sync

独自 URL を持つ Pi プロバイダの `/models` エンドポイントからモデル一覧を取り込み、Pi のモデルカタログ設定と結び付ける Pi package です。

## 設定

`.pi/agent/extensions/pi-provider-model-sync/` に設定を置きます。`~/.pi/agent/` は Pi のグローバル設定ディレクトリです（`PI_CODING_AGENT_DIR` で変更可能）。

```
~/.pi/agent/extensions/pi-provider-model-sync/
├── model-sources.json   # プロバイダごとのモデル一覧・config・override
└── cache/models.json    # pi.dev から取得した Pi モデルカタログ（自動管理）
```

### `models.json`（Pi 標準）

動的登録したい独自プロバイダは `models: []` で定義します。

```json
{
  "providers": {
    "test-provider1": {
      "baseUrl": "https://cf.llmhost.net/v1",
      "api": "openai-completions",
      "authHeader": true,
      "headers": { "content-type": "application/json" },
      "models": []
    }
  }
}
```

### `model-sources.json`

初回起動時に `models: []` のプロバイダから `/models` を取得し、モデル定義の雛形を書き込んだ後は自動更新しません。

```json
{
  "providers": {
    "test-provider1": {
      "models": [
        { "id": "gpt-5.6-sol", "config": "" },
        { "id": "gpt-5.6-terra", "config": "openai/gpt-5.6-sol" }
      ]
    }
  }
}
```

- `id`: 独自プロバイダの `/models` に返る ID（必須）
- `config`: `provider/model` で Pi カタログのモデル設定を参照。省略・`null`・`undefined` は未指定（プロバイダ config を継承）、空文字は Pi デフォルト（任意）
- `override`: 取得元設定の上書き（プロバイダ単位 / モデル単位、前者が弱く後者が強い）

プロバイダ単位でも `config` を指定できます。モデルの `config` が未指定の場合、そのプロバイダのモデルは `config/モデルID` を参照します（モデルの `config` が優先。空文字のモデル config はプロバイダ config を無視して Pi デフォルト）。

初回登録・`/reload-provider` の新規モデルは、プロバイダとモデルの両方に `config: null` を記録します。

## コマンド

```text
/reload-provider <provider>
```

独自プロバイダの `/models` と Pi の全モデルカタログを再取得します。新規モデルは `{ "id": "..." }` で追加され、既存モデルの `config` / `override` は変更されません。API に存在しなくなった ID は削除せず残します。

## 動作

- `baseUrl` / `api` は常に `models.json` の値を使い、Pi カタログ側の接続情報は引き継ぎません。
- Pi カタログは `pi.dev/api/models` から取得し、初回登録時と `/reload-provider` の実行時に更新します。それ以外の起動では `cache/models.json` を再利用します。
- モデル登録はセッション開始時に行われるため、対話モードで `/model` から利用できます。対話を開始していない `--list-models` では未登録の可能性があります。

## 開発

```bash
pnpm install
pnpm typecheck  # TypeScript 型チェック
pnpm lint       # oxlint (type-aware)
pnpm test       # node --test
```
