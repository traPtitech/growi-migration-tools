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

## 重複ユーザーの統合

`merge-duplicate-users` は、完全一致するユーザー名のレコードを同一人物として統合する手動ツール。各組の最古ObjectIdを残し、そのプロフィール・作成日時・資格情報を保持する。メール、status、管理者・読み取り専用フラグが組内で異なる場合や、統合元に別の外部ID・APIトークン・プロフィールがある場合は中止する。別ユーザー名間のメール重複も中止する。

推奨実行時点は、MongoDBのレプリカセットへ復元後、GROWIのスキーマ移行前。旧CrowiのMongoDB 3.6では実行しない。移行済みGROWIのDBにも利用できる。

### 計画と適用

最初は別名DBへ復元したコピーで検証する。バックアップを取得し、対象DBを利用するGROWI・ワーカーを停止してから実行する。接続先の指定は上記と同じ。

```sh
pnpm merge-duplicate-users \
  --database growi \
  --report reports/users-plan.json

pnpm merge-duplicate-users \
  --database growi \
  --apply --plan reports/users-plan.json \
  --report reports/users-applied.json
```

初回は読み取りだけ。`groups` の統合先・削除元、`changes` と `referenceUpdates` を確認する。計画にはユーザー名・メール・IDを含むため公開しない。レポートは新規ファイルだけに作成し、権限を0600にする。

適用時には入力DB全体のドキュメント・インデックスと仮名化対応表のfingerprintを再照合し、変更後の古い計画は拒否する。実行内容はDBから再計算するため、計画の `changes` を手で書き換えて適用内容を変更することはできない。ドキュメントの照合にはBSON表現を使い、型の違いも検出する。停止状態で計画から適用まで実行すること。

変更は1トランザクションで適用する。ページの作者・最終更新者・削除者・許可ユーザー・既読・いいね、履歴作者、コメント・添付作者、ブックマーク、グループ・外部アカウント等の参照を付け替える。配列は同一人物分を重複排除する。本文・ページID・revision ID・パス・日時・grant・添付キーは変更しない。本文中の旧IDも歴史的記録として保持する。

同一ページのブックマークが衝突する場合は、統合先ユーザーの既存レコードを優先し、なければ最小のブックマークIDを残す。フォルダ内のブックマーク参照も残るIDへ付け替えて重複排除する。UI設定・日別contributionなど、その他の一意制約の衝突は自動統合せず、DBエラーで全変更をロールバックする。

既知の参照を置換した後に、削除対象IDが未対応の構造化フィールドに残る場合は計画を作らず中止する。保留中の `pageoperations` や、削除対象IDを含むセッションも先に解消すること。構造化参照の対象一覧は `src/merge-duplicate-users/references.ts`。新しいモデルを持つDBへ適用する際は、この一覧と各モデルを照合する。

### リハーサル時の仮名からの復元

過去の検証で `rehearsal-...` へ変更したDBは、明示的な対応表を両方のコマンドに指定する。名前の形式からの推測は行わない。

```sh
pnpm merge-duplicate-users \
  --database growi \
  --aliases /private/path/user-aliases.json \
  --report reports/users-plan.json

pnpm merge-duplicate-users \
  --database growi \
  --aliases /private/path/user-aliases.json \
  --apply --plan reports/users-plan.json \
  --report reports/users-applied.json
```

対応表は `{ "id": "24文字のObjectId", "field": "usernameまたはemail", "original": "元の値", "replacement": "仮名" }` の配列。保存値が元の値・仮名のどちらでもなければ中止する。統合先が仮名化されている場合は、元の名前・メールを復元する。削除済みIDの対応表は再実行時に無視する。実データの対応表をgitに追加しない。

適用後は新しいレポートへ再ドライランし、変更0件を確認する。完了したトランザクションを戻す場合は事前バックアップから復元する。GROWIのユーザー削除APIはユーザーホーム・グループ・外部アカウントを変更するため、この統合の代用にはしない。

再起動後はtraQの認証先IDと、旧所有者限定ページ・履歴・ブックマークの利用を確認する。卒業者の利用停止、管理者の見直し、旧APIトークンの廃止はこの処理では行わない。検索やVault等を利用している場合は派生データも再構築する。
