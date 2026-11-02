// Marketplace への公開（GitHub Actions の Trusted Publishing）。GitLab Release の VSIX を取得・照合して vsce publish --oidc で出す。
// このファイルの正本は GitLab のリポジトリの src/github-actions/。公開専用の GitHub リポジトリへは `release.mjs github-sync` が複写する
// （docs/PUBLISHING.md §5.1）。共通の部分（wait・verify・実行の枠）は publish-release.mjs。
//   node publish-marketplace.mjs wait    --version <x.y.z> [--wait-minutes <分>]   GitLab Release が現れるまで待つ
//   node publish-marketplace.mjs verify  --version <x.y.z>                         SHA256SUMS・VSIX を取得し、照合して work/ へ置く
//   node publish-marketplace.mjs publish --version <x.y.z>                         未公開なら vsce publish --oidc（公開済みは何もしない）
//   node publish-marketplace.mjs check   --version <x.y.z>                         公開 API に版が載ったことを確かめる
// 秘密は持たない・出さない（OIDC のトークンは vsce が GitHub の ACTIONS_ID_TOKEN_REQUEST_* から直接取る）。
import {
  EXTENSION_NAME,
  fetchWithRetry,
  isHttpOk,
  PUBLISHER,
  requireGithubActions,
  runAsMain,
  verifiedVsixPath,
  waitUntilPublished,
} from './publish-release.mjs';

const MARKETPLACE_QUERY_URL =
  'https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery';
const MARKETPLACE_API_VERSION = '7.1-preview.1';
const MARKETPLACE_LABEL = 'Marketplace';
/** extensionquery の filterType: 拡張 ID（<publisher>.<name>）で絞る */
const FILTER_TYPE_EXTENSION_NAME = 7;
/** extensionquery の flags: IncludeVersions（1）+ IncludeVersionProperties（16）。全版を返す（最新 1 版だけにしない） */
const QUERY_FLAGS = 1 | 16;

/** @typedef {import('./publish-release.mjs').Deps} Deps */

/**
 * Marketplace の公開 API（extensionquery。認証なし）で、公開済みの版の一覧を得る。
 * @param {Deps} deps
 * @returns {Promise<string[]>}
 */
async function publishedVersions(deps) {
  const response = await fetchWithRetry(deps, MARKETPLACE_QUERY_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: `application/json;api-version=${MARKETPLACE_API_VERSION}`,
    },
    body: JSON.stringify({
      filters: [
        {
          criteria: [
            { filterType: FILTER_TYPE_EXTENSION_NAME, value: `${PUBLISHER}.${EXTENSION_NAME}` },
          ],
        },
      ],
      flags: QUERY_FLAGS,
    }),
  });
  if (!isHttpOk(response)) {
    throw new Error(`Marketplace の公開状況を確認できません（HTTP ${response.status}）`);
  }
  const body =
    /** @type {{results?: Array<{extensions?: Array<{versions?: Array<{version?: unknown}>}>}>}} */ (
      await response.json()
    );
  const extensions = body.results?.[0]?.extensions;
  if (!Array.isArray(extensions)) {
    throw new Error('Marketplace の応答を読めません（results[0].extensions がありません）');
  }
  return (extensions[0]?.versions ?? []).map((entry) => String(entry.version));
}

/**
 * 未公開なら vsce publish --oidc で出す（公開済みなら何もしない）。vsce は GitHub の OIDC トークンを Marketplace の資格に交換する。
 * @param {Deps} deps
 * @param {{version: string}} options
 * @returns {Promise<'published' | 'skipped'>}
 */
export async function publishVersion(deps, { version }) {
  if ((await publishedVersions(deps)).includes(version)) {
    deps.log(
      `${PUBLISHER}.${EXTENSION_NAME}@${version} は Marketplace に公開済みのため、何もしません`,
    );
    return 'skipped';
  }
  const vsixPath = verifiedVsixPath(deps, version);
  requireGithubActions(deps);
  const { status } = await deps.run(
    'npx',
    [
      '--no-install',
      'vsce',
      'publish',
      '--oidc',
      '--no-dependencies',
      '--packagePath',
      vsixPath,
      '--skip-duplicate',
    ],
    { inherit: true },
  );
  if (status !== 0) throw new Error(`vsce publish が失敗しました（終了コード ${status}）`);
  deps.log(`${PUBLISHER}.${EXTENSION_NAME}@${version} を公開しました`);
  return 'published';
}

/**
 * Marketplace の公開 API に版が載るまで待つ（上限・警告の扱いは waitUntilPublished）。
 * @param {Deps} deps
 * @param {{version: string}} options
 * @returns {Promise<void>}
 */
export function checkPublished(deps, { version }) {
  return waitUntilPublished(deps, {
    label: MARKETPLACE_LABEL,
    version,
    isPublished: async () => (await publishedVersions(deps)).includes(version),
  });
}

runAsMain(import.meta.url, { publish: publishVersion, check: checkPublished });
