/**
 * `@qauth-labs/plugin-apple` — Sign in with Apple for QAuth, as a preset on
 * the server's own OpenID Connect client. EXPERIMENTAL, like the plugin API
 * it is written against.
 *
 * The operator installs the package with the deployment, lists it in
 * `AUTH_METHOD_PLUGINS` and turns on `PLUGIN_API_ENABLED`; each realm then
 * configures and enables it through the admin API. See the README.
 *
 * @packageDocumentation
 */
import { applePreset } from './apple.js';

export {
  APPLE_ATTRIBUTES,
  APPLE_CLIENT_SECRET_ALGORITHM,
  APPLE_DISPLAY_NAME,
  APPLE_ID,
  APPLE_ID_TOKEN_ALGORITHM,
  APPLE_ISSUER,
  APPLE_ORIGINS,
  APPLE_PRIVATE_RELAY_DOMAIN,
  APPLE_SCOPES,
  APPLE_TEAM_ID_PATTERN,
  APPLE_TYPE,
  APPLE_USER_MEMBER,
  type AppleConfig,
  appleIdentityClaims,
  appleRedirectUri,
  type AppleUserName,
  appleUserName,
  carriedUser,
  configSchema,
  isApplePrivateRelay,
  MAX_APPLE_NAME_LENGTH,
  MAX_APPLE_SERVICES_ID_LENGTH,
  upstreamConfig,
} from './apple.js';

/** The preset, as the server's plugin loader imports it (`UPSTREAM_OIDC_PRESET_EXPORT`). */
export const upstreamOidcPreset = applePreset;
