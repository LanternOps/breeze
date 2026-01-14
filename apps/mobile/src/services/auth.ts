import * as SecureStore from 'expo-secure-store';
import type { User } from './api';

const TOKEN_KEY = 'breeze_auth_token';
const USER_KEY = 'breeze_user';
const BIOMETRIC_ENABLED_KEY = 'breeze_biometric_enabled';

/**
 * Store the authentication token securely
 */
export async function storeToken(token: string): Promise<void> {
  try {
    await SecureStore.setItemAsync(TOKEN_KEY, token, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
  } catch (error) {
    console.error('Error storing token:', error);
    throw new Error('Failed to store authentication token');
  }
}

/**
 * Retrieve the stored authentication token
 */
export async function getStoredToken(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(TOKEN_KEY);
  } catch (error) {
    console.error('Error retrieving token:', error);
    return null;
  }
}

/**
 * Remove the stored authentication token
 */
export async function removeToken(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(TOKEN_KEY);
  } catch (error) {
    console.error('Error removing token:', error);
  }
}

/**
 * Store user data securely
 */
export async function storeUser(user: User): Promise<void> {
  try {
    await SecureStore.setItemAsync(USER_KEY, JSON.stringify(user), {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
  } catch (error) {
    console.error('Error storing user:', error);
    throw new Error('Failed to store user data');
  }
}

/**
 * Retrieve the stored user data
 */
export async function getStoredUser(): Promise<User | null> {
  try {
    const userData = await SecureStore.getItemAsync(USER_KEY);
    if (userData) {
      return JSON.parse(userData) as User;
    }
    return null;
  } catch (error) {
    console.error('Error retrieving user:', error);
    return null;
  }
}

/**
 * Remove the stored user data
 */
export async function removeUser(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(USER_KEY);
  } catch (error) {
    console.error('Error removing user:', error);
  }
}

/**
 * Clear all authentication data
 */
export async function clearAuthData(): Promise<void> {
  await Promise.all([
    removeToken(),
    removeUser(),
  ]);
}

/**
 * Check if user is authenticated (has valid token)
 */
export async function isAuthenticated(): Promise<boolean> {
  const token = await getStoredToken();
  return !!token;
}

/**
 * Store the biometric preference
 */
export async function setBiometricPreference(enabled: boolean): Promise<void> {
  try {
    await SecureStore.setItemAsync(BIOMETRIC_ENABLED_KEY, enabled ? 'true' : 'false');
  } catch (error) {
    console.error('Error storing biometric preference:', error);
  }
}

/**
 * Get the biometric preference
 */
export async function getBiometricPreference(): Promise<boolean> {
  try {
    const value = await SecureStore.getItemAsync(BIOMETRIC_ENABLED_KEY);
    return value === 'true';
  } catch (error) {
    console.error('Error retrieving biometric preference:', error);
    return false;
  }
}
