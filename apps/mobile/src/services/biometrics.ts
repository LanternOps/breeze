import * as LocalAuthentication from 'expo-local-authentication';
import * as SecureStore from 'expo-secure-store';

const BIOMETRIC_ENABLED_KEY = 'breeze_biometric_enabled';

/**
 * Check if biometric authentication is available on the device
 */
export async function checkBiometricAvailability(): Promise<boolean> {
  try {
    // Check if hardware supports biometrics
    const compatible = await LocalAuthentication.hasHardwareAsync();
    if (!compatible) {
      return false;
    }

    // Check if biometrics are enrolled
    const enrolled = await LocalAuthentication.isEnrolledAsync();
    return enrolled;
  } catch (error) {
    console.error('Error checking biometric availability:', error);
    return false;
  }
}

/**
 * Get the available biometric types on the device
 */
export async function getBiometricTypes(): Promise<LocalAuthentication.AuthenticationType[]> {
  try {
    return await LocalAuthentication.supportedAuthenticationTypesAsync();
  } catch (error) {
    console.error('Error getting biometric types:', error);
    return [];
  }
}

/**
 * Get a human-readable name for the available biometric type
 */
export async function getBiometricTypeName(): Promise<string> {
  const types = await getBiometricTypes();

  if (types.includes(LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION)) {
    return 'Face ID';
  }

  if (types.includes(LocalAuthentication.AuthenticationType.FINGERPRINT)) {
    return 'Fingerprint';
  }

  if (types.includes(LocalAuthentication.AuthenticationType.IRIS)) {
    return 'Iris';
  }

  return 'Biometrics';
}

/**
 * Authenticate using biometrics
 */
export async function authenticateWithBiometrics(
  promptMessage?: string
): Promise<boolean> {
  try {
    const biometricName = await getBiometricTypeName();

    const result = await LocalAuthentication.authenticateAsync({
      promptMessage: promptMessage || `Authenticate with ${biometricName}`,
      cancelLabel: 'Cancel',
      fallbackLabel: 'Use Passcode',
      disableDeviceFallback: false,
    });

    if (result.success) {
      return true;
    }

    if (result.error === 'user_cancel') {
      console.log('User cancelled biometric authentication');
    } else if (result.error === 'not_enrolled') {
      console.log('No biometrics enrolled');
    } else if (result.error === 'lockout') {
      console.log('Biometric authentication locked out');
    } else {
      console.log('Biometric authentication failed:', result.error);
    }

    return false;
  } catch (error) {
    console.error('Error during biometric authentication:', error);
    return false;
  }
}

/**
 * Check if biometric authentication is enabled by the user
 */
export async function isBiometricEnabled(): Promise<boolean> {
  try {
    const value = await SecureStore.getItemAsync(BIOMETRIC_ENABLED_KEY);
    return value === 'true';
  } catch (error) {
    console.error('Error checking biometric enabled status:', error);
    return false;
  }
}

/**
 * Enable or disable biometric authentication
 */
export async function setBiometricEnabled(enabled: boolean): Promise<void> {
  try {
    if (enabled) {
      // Verify biometrics are available before enabling
      const available = await checkBiometricAvailability();
      if (!available) {
        throw new Error('Biometric authentication is not available on this device');
      }

      // Prompt user to authenticate before enabling
      const authenticated = await authenticateWithBiometrics(
        'Authenticate to enable biometric login'
      );

      if (!authenticated) {
        throw new Error('Biometric authentication required to enable this feature');
      }
    }

    await SecureStore.setItemAsync(BIOMETRIC_ENABLED_KEY, enabled ? 'true' : 'false');
  } catch (error) {
    console.error('Error setting biometric enabled status:', error);
    throw error;
  }
}

/**
 * Authenticate with biometrics if enabled, otherwise return true
 */
export async function authenticateIfEnabled(): Promise<boolean> {
  try {
    const enabled = await isBiometricEnabled();
    if (!enabled) {
      return true; // Skip if not enabled
    }

    const available = await checkBiometricAvailability();
    if (!available) {
      return true; // Skip if not available
    }

    return await authenticateWithBiometrics('Authenticate to continue');
  } catch (error) {
    console.error('Error during conditional biometric auth:', error);
    return false;
  }
}

/**
 * Get the security level of the device
 */
export async function getSecurityLevel(): Promise<LocalAuthentication.SecurityLevel> {
  try {
    return await LocalAuthentication.getEnrolledLevelAsync();
  } catch (error) {
    console.error('Error getting security level:', error);
    return LocalAuthentication.SecurityLevel.NONE;
  }
}
