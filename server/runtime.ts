import type { Request } from 'express';
import ipaddr from 'ipaddr.js';
import { createApp } from './app.js';
import { supabaseStore } from './supabase.js';
import { verifyTurnstile } from './turnstile.js';
import { TEST_HOSTNAME, TEST_SECRET_KEY, TEST_SITE_KEY } from './turnstile-test-keys.js';

export class ConfigurationError extends Error {}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new ConfigurationError(`Missing required setting: ${name}`);
  return value;
}

// Vercel overwrites this header at its edge. Only the Vercel adapter uses it;
// the ordinary server still requires explicitly configured trusted proxies.
export function vercelClientIp(req: Request): string {
  const ip = req.get('x-vercel-forwarded-for');
  if (!ip || !ipaddr.isValid(ip)) throw new Error('Vercel client address unavailable');
  return ip;
}

export function configuredApp(env = process.env, platform: 'server' | 'vercel' = 'server') {
  const secret = required(env, 'TURNSTILE_SECRET_KEY');
  const hostname = required(env, 'TURNSTILE_HOSTNAME');
  const ipHashSecret = required(env, 'IP_HASH_SECRET');
  if (ipHashSecret.length < 32) throw new ConfigurationError('IP_HASH_SECRET must have at least 32 characters');
  const allowedOrigin = required(env, 'APP_ORIGIN');
  let origin: URL;
  try { origin = new URL(allowedOrigin); }
  catch { throw new ConfigurationError('APP_ORIGIN must be a complete website origin'); }
  if (!['https:', 'http:'].includes(origin.protocol) || origin.origin !== allowedOrigin || origin.hostname !== hostname) {
    throw new ConfigurationError('APP_ORIGIN must contain only the scheme and TURNSTILE_HOSTNAME, with an optional port');
  }
  // Test sites only: with TURNSTILE_DEPLOYMENT_TESTING=true, this deployment's own Vercel addresses
  // (VERCEL_URL and VERCEL_BRANCH_URL, set by Vercel) use Cloudflare's test keys, so the form works
  // there too. Keep Vercel Authentication on for those addresses, so only signed-in team members can
  // open them. Never set it on the school's live project.
  const testHosts = env.TURNSTILE_DEPLOYMENT_TESTING === 'true'
    ? [env.VERCEL_URL, env.VERCEL_BRANCH_URL].filter((host): host is string => Boolean(host) && host !== origin.host)
    : [];
  return createApp(supabaseStore(required(env, 'SUPABASE_URL'), env.SUPABASE_SECRET_KEY || required(env, 'SUPABASE_SERVICE_ROLE_KEY'), env.DATABASE_URL, env.DATABASE_SSL_CA),
    (token, ip, test) => test ? verifyTurnstile(TEST_SECRET_KEY, TEST_HOSTNAME, token, ip, null) : verifyTurnstile(secret, hostname, token, ip), {
      siteKey: required(env, 'TURNSTILE_SITE_KEY'), ipHashSecret, allowedOrigin,
      testHosts, testSiteKey: testHosts.length ? TEST_SITE_KEY : undefined,
      trustProxy: platform === 'server' ? env.TRUSTED_PROXIES?.split(',').map(value => value.trim()).filter(Boolean) : undefined,
      clientIp: platform === 'vercel' ? vercelClientIp : undefined,
    });
}
