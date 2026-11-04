import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";

/** A signed-in person. `userId` is the identity provider's stable id (Entra ID `oid`), a UUID. */
export interface SignedInUser {
  userId: string;
  name: string;
}

export interface Authenticator {
  /** Verifies a bearer token and returns the user, or throws. */
  verify(token: string): Promise<SignedInUser>;
  /** Users who are made owners of the organization when they first sign in (bootstraps membership management). */
  ownerUserIds: string[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function userFromClaims(p: JWTPayload): SignedInUser {
  const id = String(p.oid ?? p.sub ?? "");
  if (!UUID.test(id)) throw new Error("The token's user id (oid / sub) is not a UUID");
  const name = String(p.preferred_username ?? p.email ?? p.name ?? id).slice(0, 120);
  return { userId: id.toLowerCase(), name };
}

/** Verifies JWTs against a key set (remote JWKS in production, a local one in tests). */
export function jwtAuthenticator(keys: JWTVerifyGetKey, opts: { issuer: string; audience: string; ownerUserIds?: string[] }): Authenticator {
  return {
    ownerUserIds: (opts.ownerUserIds ?? []).map((x) => x.toLowerCase()),
    async verify(token) {
      const { payload } = await jwtVerify(token, keys, { issuer: opts.issuer, audience: opts.audience });
      return userFromClaims(payload);
    },
  };
}

/**
 * OpenID Connect sign-in from the environment. For Microsoft Entra ID:
 *   OIDC_ISSUER=https://login.microsoftonline.com/<tenant-id>/v2.0
 *   OIDC_AUDIENCE=<the API's application (client) id>
 * Returns null when OIDC_ISSUER is not set (then the shared APP_PASSWORD, if any, protects the API).
 */
export async function authFromEnv(env: NodeJS.ProcessEnv, log: (m: string) => void = () => {}): Promise<Authenticator | null> {
  const issuer = env.OIDC_ISSUER?.trim();
  if (!issuer) return null;
  const audience = env.OIDC_AUDIENCE?.trim();
  if (!audience) throw new Error("OIDC_ISSUER is set but OIDC_AUDIENCE is not");
  const res = await fetch(`${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`);
  if (!res.ok) throw new Error(`OpenID configuration of ${issuer} returned ${res.status}`);
  const cfg = (await res.json()) as { jwks_uri?: string; issuer?: string };
  if (!cfg.jwks_uri) throw new Error(`OpenID configuration of ${issuer} has no jwks_uri`);
  log(`sign-in: OpenID Connect (${cfg.issuer ?? issuer})`);
  return jwtAuthenticator(createRemoteJWKSet(new URL(cfg.jwks_uri)), {
    issuer: cfg.issuer ?? issuer,
    audience,
    ownerUserIds: (env.AUTH_OWNER_USER_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  });
}
