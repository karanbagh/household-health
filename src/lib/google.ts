import * as oidc from "openid-client";
import { z } from "zod";
import { config } from "../config.js";
export interface GoogleTransaction {state:string;nonce:string;verifier:string}
export interface GoogleIdentity {subject:string;email:string;name:string;authoritativeEmail:boolean}
export interface GoogleProvider {
  authorizationUrl(transaction:GoogleTransaction):Promise<string>;
  verifyCallback(url:URL,transaction:GoogleTransaction):Promise<GoogleIdentity>;
}
let discovery:Promise<oidc.Configuration>|undefined;
export async function googleConfiguration() {
  discovery ??= oidc.discovery(new URL("https://accounts.google.com"),config.google.clientId,config.google.clientSecret,undefined,{timeout:10,execute:[oidc.enableNonRepudiationChecks]}).catch(error=>{discovery=undefined;throw error;});
  return discovery;
}
export function verifiedGoogleClaims(claims:Record<string,unknown>):GoogleIdentity {
  const parsed=z.object({sub:z.string().min(1).max(255),email:z.email().max(254),email_verified:z.literal(true),name:z.string().max(200).optional(),hd:z.string().optional()}).parse(claims);
  const email=parsed.email.toLowerCase();
  return {subject:parsed.sub,email,name:parsed.name?.trim()||email,authoritativeEmail:email.endsWith("@gmail.com")||email.endsWith("@googlemail.com")||Boolean(parsed.hd && email.endsWith("@"+parsed.hd.toLowerCase()))};
}
export const googleProvider:GoogleProvider={
  async authorizationUrl(transaction) {
    return oidc.buildAuthorizationUrl(await googleConfiguration(),{redirect_uri:config.google.origin+"/api/auth/google/callback",scope:"openid email profile",state:transaction.state,nonce:transaction.nonce,code_challenge:await oidc.calculatePKCECodeChallenge(transaction.verifier),code_challenge_method:"S256",prompt:"select_account"}).href;
  },
  async verifyCallback(url,transaction) {
    const tokens=await oidc.authorizationCodeGrant(await googleConfiguration(),url,{pkceCodeVerifier:transaction.verifier,expectedState:transaction.state,expectedNonce:transaction.nonce,idTokenExpected:true});
    const claims=tokens.claims();if(!claims) throw new Error("Missing ID token");
    return verifiedGoogleClaims(claims);
  },
};
