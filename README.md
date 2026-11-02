# kakizaki-agent-controller-publish

VS Code 拡張 Agent Controller（`jumpohashimoto.kakizaki-agent-controller`）を **Visual Studio Marketplace へ公開するためだけ**のリポジトリです。拡張のソース・Issue・Release は GitLab にあります: [kakizaki-agent-controller](https://gitlab.com/jumpohashimoto/kakizaki-agent-controller)。 <!-- secrets-scan:allow 公開リポジトリ自身の URL -->

Marketplace の Trusted Publishing は GitHub Actions と Azure Pipelines だけに対応し、GitLab CI には対応しません。そこで、GitLab の Release に置いた VSIX を、ここの GitHub Actions が取得し、`SHA256SUMS` と照合してから `vsce publish --oidc` で公開します。長期のトークン（PAT）は持ちません（GitHub が発行する OIDC のトークンを、Marketplace が短命の資格に交換します）。

## このリポジトリの内容

このリポジトリのファイルは、GitLab のリポジトリの `src/github-actions/`（と `.node-version`・`LICENSE`）が正本です。**ここを直接編集しません**。GitLab 側で変更し、`node src/scripts/release.mjs github-sync` で複写します（`release.mjs tag` は、ここが正本と一致していないとタグを付けずに止まります）。依存（`@vscode/vsce`）の更新も GitLab 側の Renovate が行います。

| ファイル | 内容 |
|---|---|
| `.github/workflows/publish-marketplace.yml` | 公開のワークフロー。手動（`workflow_dispatch`）だけで動き、`release.mjs tag` が版を渡して起動する |
| `publish-marketplace.mjs` | 公開の本体（`wait`・`verify`・`publish`・`check`）。`node:` 組み込みだけを使う |
| `package.json`・`package-lock.json` | `@vscode/vsce` の固定（`npm ci --ignore-scripts` で入れる） |
| `.github/dependabot.yml` | 版の更新の PR を作らない設定（更新は GitLab の Renovate が担う） |

## ワークフローの流れ

1. `wait`: GitLab の Release `v<version>` が現れるまで待つ（既定 30 分）。
2. `verify`: Release の `SHA256SUMS` と VSIX を取得し、SHA-256 が一致し、VSIX の `package.json` の版・publisher・名前が入力と一致したときだけ進む（再ビルドしません）。
3. `publish`: Marketplace に未公開なら `vsce publish --oidc --no-dependencies --packagePath <VSIX> --skip-duplicate` で公開する（公開済みなら何もしない）。
4. `check`: Marketplace の公開 API に版が載ったことを確かめる。

## Marketplace の Trusted Publishing のポリシー

Marketplace の管理ページで、このリポジトリ（`jumpohashimoto/kakizaki-agent-controller-publish`）を指す次の値のポリシーを 1 つ作ります（作成後、最初の公開に成功すると有効になります）。

| 項目 | 値 |
|---|---|
| Repository owner | `jumpohashimoto` |
| Repository | `kakizaki-agent-controller-publish` |
| Workflow | `publish-marketplace.yml` |
| Environment | `marketplace` |

権限は `id-token: write`（OIDC のトークンの発行）と `contents: read` だけです。このリポジトリは公開（public）で、Actions の利用に上限はありません。
