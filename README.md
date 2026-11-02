# kakizaki-agent-controller-publish

VS Code 拡張 Agent Controller（`jumpohashimoto.kakizaki-agent-controller`）を **Visual Studio Marketplace と Open VSX へ公開するためだけ**のリポジトリです。拡張のソース・Issue・Release は GitLab にあります: [kakizaki-agent-controller](https://gitlab.com/jumpohashimoto/kakizaki-agent-controller)。 <!-- secrets-scan:allow 公開リポジトリ自身の URL -->

Marketplace の Trusted Publishing は GitHub Actions と Azure Pipelines だけに、Open VSX（open-vsx.org の本番）の Trusted Publishing は GitHub Actions だけに対応し、どちらも GitLab CI には対応しません。そこで、GitLab の Release に置いた VSIX を、ここの GitHub Actions が取得し、`SHA256SUMS` と照合してから、Marketplace は `vsce publish --oidc`、Open VSX は `ovsx publish --trusted-publishing` で公開します。長期のトークン（PAT）は持ちません（GitHub が発行する OIDC のトークンを、Marketplace・Open VSX が短命の資格に交換します）。

## このリポジトリの内容

このリポジトリのファイルは、GitLab のリポジトリの `src/github-actions/`（と `.node-version`・`LICENSE`）が正本です。**ここを直接編集しません**。GitLab 側で変更し、`node src/scripts/release.mjs github-sync` で複写します（`release.mjs tag` は、ここが正本と一致していない、または正本に無いワークフローがあると、タグを付けずに止まります）。依存（`@vscode/vsce`・`ovsx`）の更新も GitLab 側の Renovate が行います。

| ファイル | 内容 |
|---|---|
| `.github/workflows/publish-marketplace.yml`・`publish-openvsx.yml` | 公開のワークフロー（配布先ごとに 1 本）。手動（`workflow_dispatch`）だけで動き、`release.mjs tag` が版を渡して起動する |
| `publish-release.mjs` | 2 本に共通の本体（`wait`・`verify`・実行の枠）。`node:` 組み込みだけを使う |
| `publish-marketplace.mjs`・`publish-openvsx.mjs` | 配布先ごとの公開（`publish`・`check`）。共通の本体を使う |
| `package.json`・`package-lock.json` | `@vscode/vsce`・`ovsx` の固定（`npm ci --ignore-scripts` で入れる） |
| `.github/dependabot.yml` | 版の更新の PR を作らない設定（更新は GitLab の Renovate が担う） |

## ワークフローの流れ

1. `wait`: GitLab の Release `v<version>` が現れるまで待つ（既定 30 分）。
2. `verify`: Release の `SHA256SUMS` を取得し、GitLab の Package Registry のファイル一覧（公開 API）で VSIX と `SHA256SUMS` が各 1 件だけ登録されていて VSIX の `file_sha256` が `SHA256SUMS` と一致することを確かめてから、VSIX を取得する。SHA-256 が一致し、VSIX の `package.json` の版・publisher・名前が入力と一致したときだけ進む（再ビルドしません）。
3. `publish`: 配布先に未公開なら公開する（公開済みなら何もしない）。Marketplace は `vsce publish --oidc --no-dependencies --packagePath <VSIX> --skip-duplicate`、Open VSX は `ovsx publish <VSIX> --trusted-publishing --skip-duplicate`。Open VSX は、環境に `OVSX_PAT` があるとトークンを優先して Trusted Publishing を使わないため、あれば失敗にする。
4. `check`: 配布先の公開 API に版が載ったことを確かめる（最大 20 分待つ。公開は成功したが反映を確認できないときは、警告を出して正常に終わる）。

## Trusted Publishing の登録

どちらも、このリポジトリ（`jumpohashimoto/kakizaki-agent-controller-publish`）を指す登録を 1 つずつ作ります。

### Marketplace

Marketplace の管理ページで、次の値のポリシーを 1 つ作ります（作成後、最初の公開に成功すると有効になります）。

| 項目 | 値 |
|---|---|
| Repository owner | `jumpohashimoto` |
| Repository | `kakizaki-agent-controller-publish` |
| Workflow | `publish-marketplace.yml` |
| Environment | `marketplace` |

### Open VSX

open-vsx.org の Settings → Trusted Publishers で、名前空間 `jumpohashimoto` に次の値を登録します（ワークフローのファイルを先にここへ置いてから登録します。トークンは作りません）。

| 項目 | 値 |
|---|---|
| Organization or User name | `jumpohashimoto` |
| Repository name | `kakizaki-agent-controller-publish` |
| Workflow filename | `publish-openvsx.yml` |
| Environment name | `openvsx` |

権限は `id-token: write`（OIDC のトークンの発行）と `contents: read` だけです。このリポジトリは公開（public）で、Actions の利用に上限はありません。
