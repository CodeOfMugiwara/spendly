import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeSupabaseUrl,
  getSupabaseConfig,
  formatAuthError,
  setSupabaseClient,
  signUpUser,
  signInUser,
  signOutUser,
  requestPasswordReset,
  updateUserPassword,
  resendVerification
} from '../../js/supabase.js';

import { getSpendlyDBName } from '../../js/db.js';

test('normalizeSupabaseUrl strips trailing slashes and /rest/v1 endpoints', () => {
  assert.equal(
    normalizeSupabaseUrl('https://qmvigcbumiumaguwmmbk.supabase.co/rest/v1/'),
    'https://qmvigcbumiumaguwmmbk.supabase.co'
  );
  assert.equal(
    normalizeSupabaseUrl('https://qmvigcbumiumaguwmmbk.supabase.co/rest/v1'),
    'https://qmvigcbumiumaguwmmbk.supabase.co'
  );
  assert.equal(
    normalizeSupabaseUrl('https://qmvigcbumiumaguwmmbk.supabase.co///'),
    'https://qmvigcbumiumaguwmmbk.supabase.co'
  );
  assert.equal(
    normalizeSupabaseUrl('https://qmvigcbumiumaguwmmbk.supabase.co'),
    'https://qmvigcbumiumaguwmmbk.supabase.co'
  );
  assert.equal(normalizeSupabaseUrl(''), '');
  assert.equal(normalizeSupabaseUrl(null), '');
});

test('getSpendlyDBName provides strict local IndexedDB isolation per account', () => {
  assert.equal(getSpendlyDBName(null), 'spendly');
  assert.equal(getSpendlyDBName(''), 'spendly');

  const userA = '00000000-0000-4000-8000-000000000001';
  const userB = '00000000-0000-4000-8000-000000000002';

  const dbA = getSpendlyDBName(userA);
  const dbB = getSpendlyDBName(userB);

  assert.equal(dbA, 'spendly_user_00000000-0000-4000-8000-000000000001');
  assert.equal(dbB, 'spendly_user_00000000-0000-4000-8000-000000000002');
  assert.notEqual(dbA, dbB, 'Account A and Account B have completely separate databases');
  assert.notEqual(dbA, 'spendly', 'User DB is separate from legacy unowned DB');
  assert.notEqual(dbB, 'spendly', 'User DB is separate from legacy unowned DB');

  // Sanitizes special chars
  assert.equal(getSpendlyDBName('user@test.com'), 'spendly_user_user_test_com');
});

test('formatAuthError maps error messages to user-friendly text', () => {
  assert.match(
    formatAuthError(new Error('Invalid login credentials')),
    /Incorrect email or password/i
  );
  assert.match(
    formatAuthError(new Error('Email not confirmed')),
    /Please verify your email/i
  );
  assert.match(
    formatAuthError(new Error('User already registered')),
    /An account with this email already exists/i
  );
  assert.match(
    formatAuthError(new Error('Password should be at least 6 characters')),
    /Password must be at least 6 characters/i
  );
  assert.match(
    formatAuthError(new Error('Too many requests / rate limit exceeded')),
    /Too many attempts/i
  );
  assert.match(
    formatAuthError(new Error('Failed to fetch')),
    /Network connection issue/i
  );
  assert.equal(formatAuthError(new Error('Custom error message')), 'Custom error message');
});

test('signUpUser, signInUser, signOutUser, reset and resend invoke Supabase auth methods', async () => {
  const calls = [];
  const mockClient = {
    auth: {
      signUp: async (args) => {
        calls.push({ method: 'signUp', args });
        return { data: { user: { id: 'u1', email: args.email }, session: null }, error: null };
      },
      signInWithPassword: async (args) => {
        calls.push({ method: 'signInWithPassword', args });
        return { data: { user: { id: 'u1', email: args.email }, session: { access_token: 'tok' } }, error: null };
      },
      signOut: async () => {
        calls.push({ method: 'signOut' });
        return { error: null };
      },
      resetPasswordForEmail: async (email, options) => {
        calls.push({ method: 'resetPasswordForEmail', email, options });
        return { data: {}, error: null };
      },
      updateUser: async (args) => {
        calls.push({ method: 'updateUser', args });
        return { data: { user: { id: 'u1' } }, error: null };
      },
      resend: async (args) => {
        calls.push({ method: 'resend', args });
        return { data: {}, error: null };
      }
    }
  };

  setSupabaseClient(mockClient);

  // Sign up
  const signupRes = await signUpUser({ email: 'new@example.com', password: 'secretpassword123' });
  assert.equal(signupRes.user.email, 'new@example.com');
  assert.equal(calls[0].method, 'signUp');
  assert.equal(calls[0].args.email, 'new@example.com');

  // Sign in
  const signinRes = await signInUser({ email: 'new@example.com', password: 'secretpassword123' });
  assert.equal(signinRes.session.access_token, 'tok');
  assert.equal(calls[1].method, 'signInWithPassword');

  // Sign out
  await signOutUser();
  assert.equal(calls[2].method, 'signOut');

  // Password reset request
  await requestPasswordReset('new@example.com');
  assert.equal(calls[3].method, 'resetPasswordForEmail');
  assert.equal(calls[3].email, 'new@example.com');

  // Password update
  await updateUserPassword('newSecretPassword456');
  assert.equal(calls[4].method, 'updateUser');
  assert.equal(calls[4].args.password, 'newSecretPassword456');

  // Resend verification
  await resendVerification('new@example.com');
  assert.equal(calls[5].method, 'resend');
  assert.equal(calls[5].args.email, 'new@example.com');
});
