/**
 * The CLI version, taken from package.json at build time (tsup bundles the
 * JSON), so `uw --version` and the User-Agent always match the published
 * package.
 */
import pkg from "../package.json" with { type: "json" };

export const VERSION: string = pkg.version;
export const USER_AGENT = `uptimewarden-cli/${VERSION}`;
