/**
 * Supabase client and authentication service for Spendly.
 *
 * Implements a singleton client, configuration validation, persistent sessions,
 * auth state management, and user-facing error formatting.
 */

import { createClient } from './vendor/supabase.js';

let clientInstance = null;

/** Strip trailing `/rest/v1`, `/`, etc. to get the root project URL. */
export function normalizeSupabaseUrl(url) {
  if (!url || typeof url !== 'string') return '';
  return url.trim().replace(/\/rest\/v1\/?$/, '').replace(/\/+$/, '');
}

/** Read configuration from Vite env, globalThis.__ENV__, or process.env. */
export function getSupabaseConfig() {
  const env = (typeof import.meta !== 'undefined' && import.meta?.env)
    ? import.meta.env
    : (globalThis.__ENV__ || (typeof process !== 'undefined' && process.env ? process.env : {}));

  const rawUrl = env.VITE_SUPABASE_URL || globalThis.__VITE_SUPABASE_URL__ || '';
  const rawKey = env.VITE_SUPABASE_PUBLISHABLE_KEY ||
                 env.VITE_SUPABASE_ANON_KEY ||
                 globalThis.__VITE_SUPABASE_PUBLISHABLE_KEY__ ||
                 '';

  return {
    url: normalizeSupabaseUrl(rawUrl),
    publishableKey: String(rawKey || '').trim()
  };
}

/** Check whether valid Supabase configuration is present. */
export function hasSupabaseConfig() {
  const { url, publishableKey } = getSupabaseConfig();
  return Boolean(url && publishableKey);
}

/**
 * Get or initialize the singleton Supabase client instance.
 * Never creates multiple instances.
 */
export function getSupabase() {
  if (clientInstance) return clientInstance;

  const { url, publishableKey } = getSupabaseConfig();
  if (!url || !publishableKey) {
    throw new Error(
      'Supabase configuration is missing. Please set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY in .env.local.'
    );
  }

  clientInstance = createClient(url, publishableKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      storage: globalThis.localStorage,
      storageKey: 'spendly.auth.token'
    }
  });

  return clientInstance;
}

/** For tests: override or inject a mock client. */
export function setSupabaseClient(client) {
  clientInstance = client;
}

/**
 * Register a user with email and password.
 */
export async function signUpUser({ email, password, options = {} }) {
  const supabase = getSupabase();
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      emailRedirectTo: options.emailRedirectTo || origin,
      data: options.data || {}
    }
  });

  if (error) throw error;
  return data;
}

/**
 * Sign in a user with email and password.
 */
export async function signInUser({ email, password }) {
  const supabase = getSupabase();
  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password
  });

  if (error) throw error;
  return data;
}

/**
 * Sign out the currently active user and invalidate their session.
 */
export async function signOutUser() {
  const supabase = getSupabase();
  const { error } = await supabase.auth.signOut();
  if (error) {
    // If offline, still clear local session
    console.warn('Sign out encountered network error, clearing local session:', error);
  }
}

/**
 * Send a password reset email.
 */
export async function requestPasswordReset(email) {
  const supabase = getSupabase();
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const { data, error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${origin}#type=recovery`
  });

  if (error) throw error;
  return data;
}

/**
 * Update the user's password (e.g. after following a recovery link).
 */
export async function updateUserPassword(newPassword) {
  const supabase = getSupabase();
  const { data, error } = await supabase.auth.updateUser({
    password: newPassword
  });

  if (error) throw error;
  return data;
}

/**
 * Resend email confirmation link.
 */
export async function resendVerification(email) {
  const supabase = getSupabase();
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const { data, error } = await supabase.auth.resend({
    type: 'signup',
    email,
    options: {
      emailRedirectTo: origin
    }
  });

  if (error) throw error;
  return data;
}

/**
 * Format auth errors into clear, friendly messages for the user.
 */
export function formatAuthError(error) {
  if (!error) return '';
  const message = error.message || String(error);

  if (/invalid login credentials/i.test(message)) {
    return 'Incorrect email or password. Please check your credentials and try again.';
  }
  if (/email not confirmed/i.test(message)) {
    return 'Please verify your email address before signing in. Check your inbox for the confirmation link.';
  }
  if (/user already registered/i.test(message) || /already exists/i.test(message)) {
    return 'An account with this email already exists. Try signing in or reset your password.';
  }
  if (/password.*(at least|short|length)/i.test(message)) {
    return 'Password must be at least 6 characters.';
  }
  if (/rate limit/i.test(message) || /too many requests/i.test(message)) {
    return 'Too many attempts. Please wait a few moments and try again.';
  }
  if (/network|fetch failed|failed to fetch/i.test(message) || (typeof navigator !== 'undefined' && navigator.onLine === false)) {
    return 'Network connection issue. Please check your internet connection.';
  }
  return message;
}
