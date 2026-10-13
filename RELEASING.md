# Releasing @uptimewarden/cli

Releases are published to npm by [`.github/workflows/release.yml`](./.github/workflows/release.yml)
when a `v*` tag is pushed. The workflow authenticates with **npm trusted
publishing** (OIDC). There is no `NPM_TOKEN` secret, and every release
published from the workflow carries a provenance attestation.

Requirements stated in the npm documentation (checked 2026-10-13):

- Publishing with trusted publishing: npm CLI 11.5.1 or later, Node 22.14.0
  or later. The workflow uses Node 24 and installs npm 11.
- `npm trust` (configuring the publisher from the command line): npm 11.15.0
  or later. The npmjs.com website does the same thing.
- **The package must already exist on npm** before a trusted publisher can
  be added. That is why the very first version is published by hand once.

The npm scope `@uptimewarden` already exists and has no packages.

## One-time setup (founder / npm org owner)

### 1. Publish the first version by hand

Use an npm account that is an owner of the `uptimewarden` npm organisation,
with 2FA enabled.

```bash
git clone https://github.com/UptimeWarden/cli.git
cd cli
npm ci
npm run typecheck && npm test && npm run build

npm login                      # once, in the browser
npm publish --access public --provenance=false
```

`--provenance=false` is needed because provenance can only be generated in
CI. This first version (0.1.0) therefore has no provenance; every later
version will.

### 2. Add the trusted publisher

On npmjs.com: **Packages → @uptimewarden/cli → Settings → Trusted
publishing → GitHub Actions**, and fill in:

| Field | Value |
|---|---|
| Organization or user | `UptimeWarden` |
| Repository | `cli` |
| Workflow filename | `release.yml` |
| Environment name | leave empty |
| Allowed actions | tick **npm publish** (configurations created after 3 Sep 2026 allow only `npm stage publish` unless you tick it) |

Or from a terminal with npm 11.15.0 or later:

```bash
npm install -g npm@^11.15.0
npm trust github @uptimewarden/cli --repo UptimeWarden/cli --file release.yml --allow-publish
npm trust list @uptimewarden/cli
```

(Run `npm trust github --help` first if the flag names differ in your npm
version.)

### 3. Lock down token publishing (recommended)

On the same Settings page, under **Publishing access**, choose
**Require two-factor authentication and disallow tokens**. Trusted
publishing keeps working; long-lived tokens can no longer publish.

### 4. Tag the bootstrap version

```bash
git tag v0.1.0
git push origin v0.1.0
```

The workflow runs the checks, sees that 0.1.0 is already on npm and skips the
publish step. This confirms that the workflow is green before the first real
OIDC release.

## Every later release

```bash
npm version patch --no-git-tag-version   # or minor / major
git commit -am "chore: release v$(node -p "require('./package.json').version")"
git tag "v$(node -p "require('./package.json').version")"
git push origin main --tags
```

The workflow fails if the tag and `package.json` disagree. After it finishes,
check the package page on npmjs.com: the version should show a
**Provenance** badge linking back to the workflow run.

## If the publish step fails

- `ENEEDAUTH` / `404 Not Found` on `PUT`: the trusted publisher fields do not
  match this repository and workflow file exactly (names are case-sensitive),
  or **npm publish** is not an allowed action.
- `npm ERR! provenance`: `package.json` `repository.url` must point at
  `https://github.com/UptimeWarden/cli`, and the repository must be public.
