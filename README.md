# OIE Community Catalog

The curated package catalog for the [Open Integration Engine](https://openintegrationengine.org)
[Community Store](https://github.com/gibson9583/oie-community-store). Modeled on
[winget-pkgs](https://github.com/microsoft/winget-pkgs): the catalog holds small JSON
**manifests**, CI compiles them into a single **`index.json`**, and the store reads that
one file per sync. Artifacts themselves live wherever the publisher hosts them —
GitHub Releases, GitLab, S3, or any HTTPS server — because every version manifest
carries an absolute `installerUrl` plus the artifact's `sha256`, which the engine
verifies before anything is installed.

```
manifests/
├── plugins/                     one folder per package type…
├── connectors/
├── datatypes/
├── channels/
├── code-templates/
└── code-template-libraries/
    └── <id>/
        ├── meta.json            …stable package metadata (name, type, publisher, …)
        └── <version>.json       one immutable manifest per published version
blocklist.json                   repositories the store refuses (propagates in one sync)
index.json                       compiled catalog — built by CI, do not edit by hand
```

A package lives in the folder matching its `meta.json` `type` — CI rejects mismatches.

## Supported package types

| `type` | Artifact | Installed via |
|---|---|---|
| `plugin` / `connector` / `datatype` | built extension `.zip` | engine extension installer (restart required) |
| `channel` | channel export XML | imported — takes effect immediately |
| `code-template` | code template XML | imported into a library you choose |
| `code-template-library` | library export XML | imported with all member templates |

Content packages (`channel`, `code-template`, `code-template-library`) must declare a
**`contentId`** in `meta.json` — the engine id (UUID) inside the artifact — which is how
the store detects that they are installed.

## Submitting a package

1. Publish your artifact anywhere reachable over HTTPS and compute its digest:
   `sha256sum my-extension-1.0.0.zip`
2. Fork this repository and add, under the folder for your package's type
   (`manifests/plugins/`, `manifests/channels/`, …):
   - `manifests/<type>/<id>/meta.json` — see any existing package for the shape. `<id>`
     is lowercase letters/digits/hyphens and, for extensions, **must equal the `path`
     attribute in your `plugin.xml`** (that is how installed-version tracking works).
   - `manifests/<type>/<id>/<version>.json` — `version`, `minEngineVersion`,
     `maxEngineVersion` (or `null`), `installerUrl`, `sha256`, `restartRequired`,
     and optionally `publishedAt`, `releaseNotesUrl`, and `docsUrl` (an absolute URL
     to a markdown page rendered in the store's detail view).
3. Open a pull request. CI validates every manifest and **downloads your installer to
   verify the sha256** before the PR can merge. You never touch `index.json` — CI
   recompiles and commits it automatically when your PR merges, and every connected
   store picks it up on its next sync. (Optional: run
   `node scripts/build-index.mjs --lint` locally for fast feedback before pushing.)

Publishing a new version is the same flow: add `<new-version>.json`, rebuild, PR.
Version manifests are immutable — never edit a published one; publish a new version
instead.

### Declaring UI surfaces (`ui`)

Extensions may declare which UI surfaces they ship by adding a `ui` array to their
`oie.json`: `["web","swing"]` = both, `["web"]` = web-only, `["swing"]` = Swing-only,
`[]` = a server-only extension with no UI. Your release workflow carries the value
from the tagged `oie.json` into the version manifest it publishes here, and the
compiled `index.json` passes it through verbatim. Stores filter their listings on it:
a web store hides Swing-only entries and vice-versa.

If you don't declare `ui`, the version manifest simply omits the key and the package
shows in **both** stores. Content packages (`channel` / `code-template` /
`code-template-library`) have no `ui` at all — they always show.

### Publishing automatically (reusable workflow)

If your artifact is a GitHub release asset, you can skip the manual fork-and-PR flow:
this repo hosts a reusable workflow
([`.github/workflows/publish-to-catalog.yml`](.github/workflows/publish-to-catalog.yml))
that files the catalog PR for you on every release. Setup, once per publisher repo:

1. Create a **fine-grained PAT** scoped to only `oie-community-catalog`, with
   repository permissions **Contents (read/write)** and **Pull requests (read/write)**.
2. Add it to your repo's Actions secrets as **`CATALOG_TOKEN`**.
3. Copy [`templates/publish-to-catalog-caller.yml`](templates/publish-to-catalog-caller.yml)
   into your repo's `.github/workflows/`.

The caller passes only the release tag:

```yaml
name: Catalog PR
on:
  release:
    types: [published]
  workflow_dispatch:
    inputs:
      tag: { description: "Release tag to file (e.g. v1.0.1) — for backfilling", required: true }
jobs:
  catalog:
    uses: gibson9583/oie-community-catalog/.github/workflows/publish-to-catalog.yml@main
    with:
      tag: ${{ github.event.release.tag_name || inputs.tag }}
    secrets:
      CATALOG_TOKEN: ${{ secrets.CATALOG_TOKEN }}
```

**Caveat:** `on: release` does not fire for releases created by a workflow using
`GITHUB_TOKEN` (e.g. `softprops/action-gh-release` in a tag-push build). If that's
your release process, call the reusable workflow from the release workflow itself,
as a job after the release step:

```yaml
  catalog:
    needs: release
    uses: gibson9583/oie-community-catalog/.github/workflows/publish-to-catalog.yml@main
    with:
      tag: ${{ github.ref_name }}
    secrets:
      CATALOG_TOKEN: ${{ secrets.CATALOG_TOKEN }}
```

Everything else is derived from the **`oie.json` at the repo root of the tagged
commit** (fetched publicly — the tag must carry it):

| Manifest field | From `oie.json` | Default / rule |
|---|---|---|
| `version` | `version` | must equal the tag minus its `v` prefix — the run fails on mismatch |
| `id` + type folder | `id`, `type` | `type` picks the `manifests/` folder (`plugin` → `plugins/`, …) |
| asset filename | `filename` | `{version}` is substituted; default `<id>-{version}.zip` |
| `sha256` / `installerUrl` | — | the workflow downloads `releases/download/<tag>/<filename>` and digests it |
| `minEngineVersion` | `minEngineVersion` | `"4.6.0"` |
| `maxEngineVersion` | `maxEngineVersion` | `null` |
| `ui` | `ui` | carried only when declared; `[]` preserved — see [Declaring UI surfaces](#declaring-ui-surfaces-ui) |
| `restartRequired` | `restartRequired` | `true` |
| `docsUrl` | `storeDocs` | raw URL to that path at the tag; default `docs/store.md`; omitted when `storeDocs` is `null` |
| `meta.json` | `name`, `description`, `authors`, `keywords`, `license`, `homepage`, `documentation`, `deprecated`, `contentId` | `publisher` = first author; `repository` is always your actual repo URL; `contentId` required for content packages |
| `releaseNotesUrl` / `publishedAt` | — | the release page at the tag; time of publishing |

The resulting PR contains exactly your package's `meta.json` (refreshed every release,
so name/description/keyword edits propagate) and the new immutable `<version>.json` —
the same files as a manual submission, on a branch named `<id>-<version>` (re-running
for the same tag updates the open PR rather than duplicating it). It then goes through
the normal gate: catalog CI re-downloads your installer and verifies the `sha256`
before the PR can merge.

## Removing / blocking a package

Open a PR that removes the package's manifest directory (it disappears from the index
on merge), or — for takedowns that must also stop the store's direct-repository
sources — add the repository to `blocklist.json`. Connected stores pick up blocklist
changes on their next catalog sync.

## Consuming this catalog

The Community Store ships with this catalog as its default source:

```
https://raw.githubusercontent.com/gibson9583/oie-community-catalog/main/index.json
```

Any store instance can also add it (or a fork, or a private index anywhere) under
**Settings → Sources** as a `catalog` source. The index is a static file — it can be
mirrored to S3, GitHub Pages, or an internal web server without changing the format.

## License

MPL-2.0, matching the engine and the store. Catalog metadata is factual package
information; artifacts remain under their publishers' licenses.
