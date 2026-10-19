import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import pg from "pg";
import { config } from "../src/config.js";
import { pool } from "../src/db/client.js";
import { authRoutes } from "../src/routes/auth.js";
import { apiRoutes } from "../src/routes/api.js";
import { onboardingRoutes } from "../src/routes/onboarding.js";
import { tokenHash } from "../src/lib/sessions.js";
import { verifiedGoogleClaims, type GoogleIdentity, type GoogleProvider, type GoogleTransaction } from "../src/lib/google.js";
const app=Fastify();
const admin=new pg.Client({connectionString:process.env.DATABASE_ADMIN_URL});
const tag=randomUUID();const email=`google-${tag}@gmail.com`;
let householdId="",userId="",sessionCookie="",csrf="",providerCalls=0;
let identity:GoogleIdentity={subject:`google-${tag}`,email,name:"Google Test User",authoritativeEmail:true};
let lastTransaction:GoogleTransaction;
const provider:GoogleProvider={
  async authorizationUrl(transaction) {lastTransaction=transaction;return `https://accounts.google.com/o/oauth2/v2/auth?state=${transaction.state}`;},
  async verifyCallback(_url,transaction) {providerCalls++;assert.equal(transaction.nonce,lastTransaction.nonce);assert.equal(transaction.verifier,lastTransaction.verifier);return identity;},
};
const savedConfig={mode:config.authMode,id:config.google.clientId,secret:config.google.clientSecret};
before(async()=>{
  config.authMode="google";config.google.clientId="synthetic-client";config.google.clientSecret="synthetic-secret";
  await admin.connect();
  householdId=(await admin.query<{id:string}>("select create_household($1,'Existing Test User','Google auth test household','America/New_York','us') as id",[email])).rows[0]!.id;
  userId=(await admin.query<{id:string}>("select id from users where email=$1",[email])).rows[0]!.id;
  app.register(cookie);app.register(authRoutes,{prefix:"/api",provider});app.register(apiRoutes,{prefix:"/api"});app.register(onboardingRoutes,{prefix:"/api"});await app.ready();
});
after(async()=>{config.authMode=savedConfig.mode;config.google.clientId=savedConfig.id;config.google.clientSecret=savedConfig.secret;await app.close();await admin.end();await pool.end();});
async function start() {
  const res=await app.inject({url:"/api/auth/google"});assert.equal(res.statusCode,302,res.body);
  const cookie=res.cookies.find(value=>value.name==="hh_oauth")!;assert.ok(cookie.httpOnly);assert.equal(cookie.sameSite,"Lax");
  return {cookie:`hh_oauth=${cookie.value}`,state:lastTransaction.state};
}
async function login() {
  const attempt=await start();const res=await app.inject({url:`/api/auth/google/callback?code=synthetic&state=${attempt.state}`,headers:{cookie:attempt.cookie}});
  const session=res.cookies.find(value=>value.name==="hh_session");assert.ok(session,res.body);assert.ok(session.httpOnly);assert.equal(session.sameSite,"Lax");
  assert.equal(res.headers.location,"/");return `hh_session=${session.value}`;
}
test("Google claims require a verified email and do not trust third-party addresses for automatic linking",()=>{
  assert.throws(()=>verifiedGoogleClaims({sub:"x",email:"user@gmail.com",email_verified:false}));
  assert.equal(verifiedGoogleClaims({sub:"x",email:"user@gmail.com",email_verified:true}).authoritativeEmail,true);
  assert.equal(verifiedGoogleClaims({sub:"x",email:"user@example.org",email_verified:true}).authoritativeEmail,false);
  assert.equal(verifiedGoogleClaims({sub:"x",email:"user@example.org",email_verified:true,hd:"example.org"}).authoritativeEmail,true);
});
test("Google mode rejects arbitrary dev headers and unsigned sessions",async()=>{
  for(const headers of [{"x-dev-user":email},{cookie:"hh_session=forged"}]) assert.equal((await app.inject({url:"/api/me",headers})).statusCode,401);
  assert.equal((await app.inject({method:"POST",url:"/api/households",payload:{email,displayName:"Claim",name:"Claim"}})).statusCode,401);
});
test("missing, incorrect, expired and replayed OAuth state cannot establish a session",async()=>{
  const invalid=await start();const beforeCalls=providerCalls;
  assert.equal((await app.inject({url:`/api/auth/google/callback?code=fake&state=wrong`,headers:{cookie:invalid.cookie}})).headers.location,"/?auth_error=1");
  assert.equal((await app.inject({url:`/api/auth/google/callback?code=fake&state=${invalid.state}`,headers:{cookie:invalid.cookie}})).headers.location,"/?auth_error=1");
  assert.equal((await app.inject({url:`/api/auth/google/callback?code=fake&state=${invalid.state}`})).headers.location,"/?auth_error=1");
  const expired=await start();await admin.query("update oauth_transactions set expires_at=now()-interval '1 second' where state=$1",[expired.state]);
  assert.equal((await app.inject({url:`/api/auth/google/callback?code=fake&state=${expired.state}`,headers:{cookie:expired.cookie}})).headers.location,"/?auth_error=1");assert.equal(providerCalls,beforeCalls);
});
test("verified Google login preserves the existing user, household and role; state is single use",async()=>{
  sessionCookie=await login();
  const status=await app.inject({url:"/api/auth/status",headers:{cookie:sessionCookie}});assert.equal(status.headers["cache-control"],"no-store");
  csrf=status.json<{csrfToken:string;needsHousehold:boolean}>().csrfToken;assert.ok(csrf);assert.equal(status.json<{needsHousehold:boolean}>().needsHousehold,false);
  const me=await app.inject({url:"/api/me",headers:{cookie:sessionCookie,"x-dev-user":"attacker@gmail.com"}});assert.equal(me.statusCode,200);
  const data=me.json<{user:{id:string;role:string};household:{id:string}}>();assert.equal(data.user.id,userId);assert.equal(data.household.id,householdId);assert.equal(data.user.role,"owner");
  const stored=await admin.query<{token_hash:string}>("select token_hash from auth_sessions where user_id=$1",[userId]);assert.ok(!stored.rows.some(row=>sessionCookie.includes(row.token_hash)));
});
test("session writes require CSRF and reject cross-origin requests",async()=>{
  assert.equal((await app.inject({method:"POST",url:"/api/members",headers:{cookie:sessionCookie},payload:{fullName:"Blocked"}})).statusCode,403);
  assert.equal((await app.inject({method:"POST",url:"/api/members",headers:{cookie:sessionCookie,"x-csrf-token":csrf,origin:"https://attacker.example"},payload:{fullName:"Blocked"}})).statusCode,403);
  assert.equal((await app.inject({method:"POST",url:"/api/members",headers:{cookie:sessionCookie,"x-csrf-token":csrf,origin:config.google.origin},payload:{fullName:"Google Test Member"}})).statusCode,201);
});
test("logout revokes the session, and expired sessions cannot access records",async()=>{
  assert.equal((await app.inject({method:"POST",url:"/api/auth/logout",headers:{cookie:sessionCookie}})).statusCode,403);
  assert.equal((await app.inject({method:"POST",url:"/api/auth/logout",headers:{cookie:sessionCookie,"x-csrf-token":csrf}})).statusCode,200);
  assert.equal((await app.inject({url:"/api/me",headers:{cookie:sessionCookie}})).statusCode,401);
  const fresh=await login();await admin.query("update auth_sessions set expires_at=now()-interval '1 second' where token_hash=$1",[tokenHash(fresh.split('=')[1]!)]);
  assert.equal((await app.inject({url:"/api/me",headers:{cookie:fresh}})).statusCode,401);
});
test("new Google users can create only their own household without supplying an email or role",async()=>{
  identity={subject:`new-${tag}`,email:`new-${tag}@gmail.com`,name:"New Test User",authoritativeEmail:true};
  const fresh=await login();const status=(await app.inject({url:"/api/auth/status",headers:{cookie:fresh}})).json<{csrfToken:string;needsHousehold:boolean}>();assert.equal(status.needsHousehold,true);
  const headers={cookie:fresh,"x-csrf-token":status.csrfToken};
  assert.equal((await app.inject({method:"POST",url:"/api/households",headers,payload:{name:"New",email:"claimed@example.org"}})).statusCode,400);
  assert.equal((await app.inject({method:"POST",url:"/api/households",headers,payload:{name:"My Google household"}})).statusCode,201);
  assert.equal((await app.inject({method:"POST",url:"/api/households",headers,payload:{name:"Duplicate"}})).statusCode,409);
});
test("an existing email cannot be relinked to a different Google subject",async()=>{
  identity={subject:`replacement-${tag}`,email,name:"Replacement",authoritativeEmail:true};
  const attempt=await start();const res=await app.inject({url:`/api/auth/google/callback?code=fake&state=${attempt.state}`,headers:{cookie:attempt.cookie}});
  assert.equal(res.headers.location,"/?auth_error=1");assert.ok(!res.cookies.some(value=>value.name==="hh_session"));
});

test("an unlinked existing third-party email is not automatically claimed by a Google login",async()=>{
  const thirdParty=`third-${tag}@example.org`;
  await admin.query("select create_household($1,'Third-party owner','Third-party test household','America/New_York','us')",[thirdParty]);
  identity={subject:`third-${tag}`,email:thirdParty,name:"Third-party claimant",authoritativeEmail:false};
  const attempt=await start();const res=await app.inject({url:`/api/auth/google/callback?code=fake&state=${attempt.state}`,headers:{cookie:attempt.cookie}});
  assert.equal(res.headers.location,"/?auth_error=1");assert.ok(!res.cookies.some(value=>value.name==="hh_session"));
  const stored=await admin.query<{google_subject:string|null}>("select google_subject from users where email=$1",[thirdParty]);assert.equal(stored.rows[0]!.google_subject,null);
});
test("HTTPS session configuration marks both login and session cookies Secure",async()=>{
  identity={subject:`google-${tag}`,email,name:"Existing user",authoritativeEmail:true};
  const secure=config.google.secureCookies;config.google.secureCookies=true;
  try {
    const started=await app.inject({url:"/api/auth/google"});const transaction=started.cookies.find(value=>value.name==="hh_oauth")!;assert.ok(transaction.secure);
    const response=await app.inject({url:`/api/auth/google/callback?code=fake&state=${lastTransaction.state}`,headers:{cookie:`hh_oauth=${transaction.value}`}});
    const session=response.cookies.find(value=>value.name==="hh_session");assert.ok(session?.secure);assert.ok(session.httpOnly);
  } finally {config.google.secureCookies=secure;}
});
test("missing OAuth credentials leave Google mode closed without a development bypass",async()=>{
  const client=config.google.clientId;config.google.clientId="";
  try {
    assert.equal((await app.inject({url:"/api/auth/google"})).statusCode,503);
    assert.equal((await app.inject({url:"/api/me",headers:{"x-dev-user":email}})).statusCode,401);
    assert.equal((await app.inject({url:"/api/auth/status"})).json<{configured:boolean}>().configured,false);
  } finally {config.google.clientId=client;}
});
