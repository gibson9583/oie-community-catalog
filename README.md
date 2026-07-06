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
| `code-template` | code template XML (or a raw `.js` file) | imported into a library you choose |
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
