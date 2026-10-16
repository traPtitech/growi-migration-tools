# GROWI Migration Tools

旧CrowiからGROWIへの移行用ツール集。

関連Issue: [traPtitech/growi#1](https://github.com/traPtitech/growi/issues/1)

## 旧Crowiの末尾スラッシュ補正

GROWI v8へのスキーマ移行・公開ページのツリー変換後に使う、MongoDB用の手動スクリプト。

`/teams/` の本文ページと、移行で生成された空の `/teams` が並ぶ場合に、本文ページのIDを残して空の階層を統合する。アプリ起動時の自動実行はなし。

### 実行環境

- Node.js 24以上
- MongoDBのレプリカセット
- GROWI本体のチェックアウトは不要

## 対象と処理

- 末尾の `/` のみを除去。先頭スラッシュ、大小文字、本文中のリンクは変更しない。
- 同じ正規化先に本文ページが1件なら、そのID・revision・作者・日時・アクセス設定を保持。すべて空の階層なら、既存の正規化済み階層を優先する。
- 削除対象の空階層を参照する親子関係、履歴、コメント、添付、ブックマーク、タグ関連、共有リンク、ページへの購読・通知を、残るIDへ付け替える。
- 旧パスからのリダイレクトを追加。既存リダイレクトの移動先と、旧形式の `revisions.path` も更新する。本文・添付オブジェクトキーは書き換えない。
- `descendantCount` を親子関係から再計算。空の階層自体は件数に含めず、ツリー外の旧形式ページは対象外。

次の場合は自動処理せず、レポートの `skipped` に記録する。

- 本文ページ同士の衝突
- アクセス範囲や親の違い
- 旧形式・非公開ツリー未変換
- 既存リダイレクトとの衝突
- revisionを持つ空階層

公開ページに残る旧 `grantedUsers` は閲覧制限ではないため、公開範囲の比較から除外する。元の設定値自体は保持する。

保留中の `pageoperations`、親の参照切れ・循環がある場合は計画の作成を中止する。完了済みの監査ログや出力スナップショットの内容は変更しない。

## ドライラン

リポジトリのルートで依存関係をインストールし、レポートの保存先を作成する。

```sh
pnpm install --frozen-lockfile
mkdir -p reports
```

接続先とDB名を指定して実行する。

```sh
export MONGO_URI='mongodb://127.0.0.1:27017/?directConnection=true'

pnpm normalize-trailing-slashes \
  --database growi \
  --report reports/slash-plan.json
```

`--apply` がなければDBへの変更はなし。生成された計画の `merges`・`pageUpdates`・`aliases`・`skipped` を確認する。

実データのパスやIDを含むレポートはgitに追加しないこと。

## 適用

最初は別名DBへ復元したコピーで試すこと。適用対象DBをバックアップし、そのDBに接続するGROWI・ワーカーを停止してから、ドライランで生成した計画を指定する。

```sh
pnpm normalize-trailing-slashes \
  --database growi \
  --apply \
  --plan reports/slash-plan.json \
  --report reports/slash-applied.json
```

適用時にはDB名とページ構造・アクセス設定・リダイレクトのfingerprintを照合し、計画後に変更があれば中止する。変更処理は1トランザクションで実行し、一意制約違反などがあれば参照の付け替えも含めてロールバックする。

`skipped` のグループはパス変更・統合の対象外。ただし、親階層の統合に伴うparent参照の付け替えと、ツリー全体の子孫数再計算は対象に含む。完了した変更を戻す場合は、事前バックアップから復元する。

再実行時は、ドライランで新しい計画を作成する。処理済みのグループは変更対象に入らず、適用済みの古い計画はfingerprint不一致として拒否される。

再起動後はページツリー・旧URL・履歴・権限を確認し、利用している検索インデックスやVault等の派生データを再構築する。このスクリプトからアプリの更新イベントは発行されない。

## 検証

```sh
pnpm lint
pnpm typecheck
pnpm build
pnpm test

# MongoDB replica set: creates and drops a randomly named test database.
TEST_MONGO_URI='mongodb://127.0.0.1:27017/?directConnection=true' pnpm test
```

通常の `pnpm test` は計画の単体テストのみ。

`TEST_MONGO_URI` を設定すると、指定サーバー内にランダム名の専用DBを作り、参照保持・再実行・古い計画の拒否・制約違反時のロールバックを確認して専用DBを削除する。既存DBの指定は不要。テスト用DBの作成・削除が可能なレプリカセットを使うこと。

## ライセンス

MIT。GROWI内で作成した補正スクリプトを、単独で実行できるようにしたもの。GROWI由来のライセンスは [LICENSE](LICENSE) に同梱。
