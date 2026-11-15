import type { Response } from "express";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import { InvalidTargetError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { AH_SCOPE, isAhCode, isAhToken, type AhOAuthProvider } from "./ah/oauth.js";
import { SCOPE, type PicnicOAuthProvider } from "./oauth.js";

/**
 * One OAuth server for two connectors. A sign-in is for Albert Heijn when the app says so, by
 * naming the Albert Heijn MCP address as the resource it wants tokens for or by asking for the
 * Albert Heijn scope; every other sign-in is for Picnic, as before there were two. After that the
 * codes and tokens say by their prefix which half they belong to.
 */
export class StoreOAuthProvider implements OAuthServerProvider {
  constructor(
    private readonly picnic: PicnicOAuthProvider,
    private readonly ah: AhOAuthProvider,
    /** The Albert Heijn MCP address. */
    private readonly ahResource: URL,
  ) {}

  get clientsStore(): OAuthRegisteredClientsStore {
    return this.picnic.clientsStore;
  }

  private isAhResource(resource: URL): boolean {
    const path = (url: URL) => url.pathname.replace(/\/+$/, "");
    return resource.origin === this.ahResource.origin && path(resource) === path(this.ahResource);
  }

  private wantsAh(params: AuthorizationParams): boolean {
    if (params.resource) return this.isAhResource(params.resource);
    const scopes = params.scopes ?? [];
    return scopes.includes(AH_SCOPE) && !scopes.includes(SCOPE);
  }

  /** Refuses a token request that names the other connector than the one the code or token is for. */
  private checkResource(forAh: boolean, resource: URL | undefined): void {
    if (resource && this.isAhResource(resource) !== forAh) {
      throw new InvalidTargetError("This code or token is for the other connector on this server");
    }
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    if (this.wantsAh(params)) this.ah.onAuthorize(client, params, res);
    else await this.picnic.authorize(client, params, res);
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<string> {
    return isAhCode(code) ? this.ah.challengeForAuthorizationCode(client, code) : this.picnic.challengeForAuthorizationCode(client, code);
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    code: string,
    codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const forAh = isAhCode(code);
    this.checkResource(forAh, resource);
    return forAh ? this.ah.exchangeAuthorizationCode(client, code, redirectUri) : this.picnic.exchangeAuthorizationCode(client, code, codeVerifier, redirectUri);
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string, _scopes?: string[], resource?: URL): Promise<OAuthTokens> {
    const forAh = isAhToken(refreshToken);
    this.checkResource(forAh, resource);
    return forAh ? this.ah.exchangeRefreshToken(client, refreshToken) : this.picnic.exchangeRefreshToken(client, refreshToken);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    return isAhToken(token) ? this.ah.verifyAccessToken(token) : this.picnic.verifyAccessToken(token);
  }

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    return isAhToken(request.token) ? this.ah.revokeToken(client, request) : this.picnic.revokeToken(client, request);
  }
}
