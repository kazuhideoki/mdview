# mdview

Codex が 1 ターンの間に編集した Markdown を検出し、読みやすいダークテーマの HTML として用意するローカルビューアーです。Hook はブラウザを自動では開きません。生成 HTML、画像、状態ファイルはリポジトリ外に置きます。

## できること

- `Read` / `Changes` の切り替え
- ワークツリー内のMarkdown一覧、見出し目次、作業履歴ナビゲーション、本文幅と文字サイズの調整
- GFM、Shiki のコードハイライト、Mermaid、D2、相対画像
- `UserPromptSubmit` で基準状態を保存し、`Stop` で変更された Markdown だけ再描画
- Hook ではブラウザを開かず、必要なときだけ `mdview` などで手動表示
- `~/.codex/hooks.json` の既存設定を保った install / status / uninstall
- ワークツリーを先に固定し、その中のMarkdownだけを対象にする検索パレット
- Reader 上部でリポジトリ、ワークツリー、ブランチ、パスを、下部の履歴操作で該当 Codex セッションの最新タイトルを確認
- ターン単位のワークツリースナップショットと、その時点における複数Markdownの参照
- 相対 Markdown リンクを mdview 内で開き、リンク先を描画済み文書へ自動登録

## セットアップ

このリポジトリを clone し、リポジトリのルートで次を実行します。

```bash
npm install
mkdir -p "$HOME/.local/bin"
ln -s "$PWD/src/cli.mjs" "$HOME/.local/bin/mdview"
mdview hook install
```

`~/.local/bin` が `PATH` に含まれていることを確認してください。すでに同名のファイルがある場合、`ln` は上書きせずに終了します。既存ファイルを確認してから、必要に応じて削除または退避して再実行してください。

`src/cli.mjs` は package bin の `mdview` として定義した本番 CLI です。既定では本番用のキャッシュ、履歴、port 4320を使います。上記のシンボリックリンクにより、リポジトリの実装を `mdview` コマンドとして実行します。

リポジトリ内の `npm run dev`、`npm run preview`、`npm run demo`、`npm run render` は開発環境として、本番とは別のキャッシュ、履歴、port 4321を使います。`npm test` と `npm run test:sites` は実行ごとに一時環境を作り、終了時に破棄します。

インストール後、Codex の `/hooks` で `UserPromptSubmit` と `Stop` の 2 エントリを個別に trust します。Hook の正常終了時は stdout を一切出しません。

## 使い方

```bash
mdview
mdview list
mdview open 2
mdview open README.md
mdview render README.md
mdview demo
mdview hook status
mdview hook uninstall
```

引数なしの `mdview` は最後に描画した文書を開きます。Hook による再描画ではブラウザや配信サーバーを起動しないため、確認したいときに `mdview` または `mdview open <番号>` を実行します。`mdview list` の番号は常に新しい順で、`mdview open <番号>` と対応します。番号は新しい描画が加わると変わるため、開く直前の一覧を使います。まだ一度も文書を描画していない場合は、`mdview open <file.md>` で最初の文書を追加します。一覧は各文書の最新プレビューだけを表示し、過去リビジョンは Reader 内で参照します。

Reader はワークツリーを閲覧の単位にします。左サイドバーでワークツリーを固定してから、その時点に存在するMarkdownを選びます。`P` でワークツリー全体の古い作業時点へ戻り、`N` で新しい作業時点へ進みます。選択中のファイルが移動先にも存在する場合は、そのファイルを保ったまま内容を切り替えます。各作業時点の `Changes` は、そのターンの編集開始時点との差分です。

`R` / `C` で `Read` / `Changes` を直接切り替えられます。表示モードのボタンにフォーカスがある場合は `←` / `→` でも移動できます。入力欄や検索パレットの操作中は、これらの単キーショートカットは反応しません。`Cmd+Shift+O` では現在の文書の見出しをアウトラインパレットに表示し、検索して該当位置へ移動できます。`Cmd+Shift+K` でワークツリー選択パレットを開き、対象ワークツリーの最新作業時点へ切り替えます。`Cmd+K` または `/` では文書検索パレットを開き、選択中のワークツリーにあるMarkdownだけをタイトルとパスから検索できます。別ワークツリーの同名ファイルは検索結果に混在しません。本文中の相対的な `.md` / `.markdown` リンクも、選択中のワークツリーと作業時点を維持して移動します。絶対パスから新しい文書を取り込む場合は、CLIの `mdview open <file.md>` を使います。

描画キャッシュは `~/Library/Caches/mdview/v1`、履歴の正本は `~/Library/Application Support/mdview/history`、hook 状態は `~/Library/Application Support/mdview/hooks`、ログは `~/Library/Logs/mdview` に保存します。履歴には内容ハッシュで共有するMarkdownスナップショットに加え、作業時点ごとのワークツリー内ファイル構成を保存します。サイドバーから未描画のMarkdownを選んだときだけ、そのスナップショットを遅延描画します。このため、過去リビジョンの内容は固定したまま、Reader の機能とMarkdownの表示仕様には現在起動しているmdviewが反映されます。生成済みHTMLは互換用のfallbackを兼ねた削除可能なキャッシュであり、正本ではありません。

履歴はGitチェックアウトのルートごとに保存するため、main workspaceもlinked worktreeもそれぞれ独立した対象です。同じルートではCodexセッションをまたいで作業が積み上がります。各 `Stop` の後には同じrepositoryのprimary worktreeも確認し、未記録のコミット済みMarkdownとマージ元参照をmain側の履歴へ補完します。古いReader URLを開いた場合もworkspace APIがprimary worktreeの現在HEADをbest-effortで補完し、Gitを検証できないときは保存済み履歴をそのまま表示します。この補完はGit objectの内容を使います。同じHEADにhook履歴がある場合はそのsnapshotを維持するため、main checkoutの未コミット変更をcommitted snapshotで巻き戻しません。別worktreeの変更がmainなどへ取り込まれた場合は、記録済みsnapshotとそのcommitのMarkdown treeが一致することを必須にし、first-parent上のmerge commitが持つ非first-parent commitとの一致でマージ元を確認します。候補worktreeを一意に確認できない場合は推測して接続しません。Git ancestryが取得できない場合に限り、一意に特定できるMarkdown差分一致を推定マージ元として使います。マージ元の履歴はコピーせず、main側のマージ時点から参照します。Readerでは `P` でマージ元worktreeの各セッションへ入り、`N` でmain側のマージ結果へ戻れます。複数回同じworktreeを取り込んでも、すでに表示したリビジョンは重複しません。参照先が壊れている、消えている、または別repositoryと判定された場合は、その履歴だけを除外して未読込件数を表示します。

配信サーバーは `127.0.0.1:4320` のみで待ち受け、履歴APIはナビゲーション用メタデータだけを返します。Markdown スナップショット自体は配信しません。health 応答にはプロトコル版とruntime sourceから計算したbuild IDを含め、`mdview`起動時に現在のCLIと一致しないdaemonだけを安全に再起動します。

Hook から描画した版では、保存済みのセッションIDに完全一致する現在のセッション名だけを読み取ります。これは版の作成時点に固定した履歴ラベルではありません。Codex の `session_index.jsonl` にある最新の `thread_name` を優先し、見つからない場合だけローカル状態DBへフォールバックします。Readerを開くたびに再解決するため、後から変更した名前や、保存HTMLへfallbackした場合にも現在名を反映します。同じワークツリーの別セッションを推測して表示することはありません。手動描画ではセッション名を表示しません。detached HEAD の場合は、ブランチ欄に短縮コミットSHAを併記します。

## Hook の境界

`UserPromptSubmit` から正常な `Stop` までの内容差分を検出します。この間に Codex 以外のプロセスが行った編集も区別できません。また、interrupt / error で `Stop` が発火しなかったターンは自動表示されません。古い基準状態は 7 日で削除します。

個別の検証では `MDVIEW_CACHE_DIR`、`MDVIEW_RUNTIME_DIR`、`MDVIEW_STATE_DIR`、`MDVIEW_PORT`、`MDVIEW_BROWSER=none` を指定できます。`MDVIEW_BROWSER=none` ではブラウザと配信サーバーの自動起動を省略します。通常の開発とテストではnpm scriptsがこれらを分離するため、手動指定は不要です。
