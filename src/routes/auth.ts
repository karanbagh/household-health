import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { z } from "zod";
import { pool } from "../db/client.js";
import { config } from "../config.js";
import { googleProvider, type GoogleProvider, type GoogleTransaction } from "../lib/google.js";
import { cookieOptions, cookieToken, OAUTH_COOKIE, randomToken, requireCsrf, SESSION_COOKIE, sessionIdentity, tokenHash } from "../lib/sessions.js";

export async function authRoutes(app:FastifyInstance, options:FastifyPluginOptions & {provider?:GoogleProvider}={}) {
  const provider=options.provider??googleProvider;
  app.addHook("onRequest",async(_req,reply)=>{reply.header("Cache-Control","no-store").header("Referrer-Policy","no-referrer");});
  app.get("/auth/status",async req=>{
    const session=config.authMode==="google"?await sessionIdentity(req):null;
    const memberships=session?await pool.query("select * from auth_memberships_by_user($1)",[session.user_id]):null;
    return {mode:config.authMode,loginUrl:config.google.origin+"/api/auth/google",configured:Boolean(config.google.clientId&&config.google.clientSecret),user:session?{email:session.email,name:session.display_name}:null,csrfToken:session?.csrf_token??null,needsHousehold:Boolean(session&&!memberships?.rows.length)};
  });
  app.get("/auth/google",async(_req,reply)=>{
    if(config.authMode!=="google") return reply.code(404).send({error:"Google sign-in is not enabled"});
    if(!config.google.clientId||!config.google.clientSecret) return reply.code(503).send({error:"Google sign-in has not been configured yet"});
    const transaction={state:randomToken(),nonce:randomToken(),verifier:randomToken()};const token=randomToken();
    const location=await provider.authorizationUrl(transaction);
    await pool.query("delete from oauth_transactions where expires_at<=now()");
    await pool.query("insert into oauth_transactions(token_hash,state,nonce,verifier,expires_at) values($1,$2,$3,$4,now()+interval '10 minutes')",[tokenHash(token),transaction.state,transaction.nonce,transaction.verifier]);
    return reply.setCookie(OAUTH_COOKIE,token,cookieOptions(600,"/api/auth")).redirect(location);
  });
  app.get("/auth/google/callback",async(req,reply)=>{
    if(config.authMode!=="google") return reply.code(404).send({error:"Google sign-in is not enabled"});
    reply.clearCookie(OAUTH_COOKIE,cookieOptions(0,"/api/auth"));
    try {
      const token=cookieToken(req,OAUTH_COOKIE);if(!token) throw new Error("Missing browser transaction");
      const consumed=await pool.query<GoogleTransaction>("delete from oauth_transactions where token_hash=$1 and expires_at>now() returning state,nonce,verifier",[tokenHash(token)]);
      const transaction=consumed.rows[0];if(!transaction) throw new Error("Expired or replayed transaction");
      const query=z.object({state:z.string(),code:z.string().min(1)}).parse(req.query);
      if(query.state!==transaction.state) throw new Error("Invalid OAuth state");
      const identity=await provider.verifyCallback(new URL(req.url,config.google.origin),transaction);
      const sessionToken=randomToken();const csrf=randomToken();
      await pool.query("select google_login($1,$2,$3,$4,$5,$6)",[identity.subject,identity.email,identity.name,identity.authoritativeEmail,tokenHash(sessionToken),csrf]);
      const old=cookieToken(req);if(old) await pool.query("select logout_session($1)",[tokenHash(old)]);
      return reply.setCookie(SESSION_COOKIE,sessionToken,cookieOptions(7*86400)).redirect("/");
    } catch(error) {
      req.log.warn({type:error instanceof Error?error.name:"AuthenticationError"},"Google sign-in failed");
      return reply.redirect("/?auth_error=1");
    }
  });
  app.post("/auth/logout",async(req,reply)=>{
    if(config.authMode==="google") {
      const session=await sessionIdentity(req);
      if(session&&!requireCsrf(req,reply,session)) return;
      const token=cookieToken(req);if(token) await pool.query("select logout_session($1)",[tokenHash(token)]);
    }
    return reply.clearCookie(SESSION_COOKIE,cookieOptions(0)).send({signedOut:true});
  });
}
