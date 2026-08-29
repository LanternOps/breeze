import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAppDispatch, useAppSelector } from '../../store';
import { logout } from '../../store/authSlice';
import { getServerUrl } from '../../services/serverConfig';
import { palette, radii, spacing, type, useApprovalTheme } from '../../theme';
import { buildMfaEnrollmentUrl } from './mfaEnrollmentHandoff';

export function MfaEnrollmentRequiredScreen() {
  const theme = useApprovalTheme('dark');
  const dispatch = useAppDispatch();
  const handoff = useAppSelector((state) => state.auth.mfaEnrollmentRequired);
  if (!handoff) return null;

  async function openWebEnrollment() {
    const server = await getServerUrl();
    if (!server) return;
    const url = buildMfaEnrollmentUrl(server, handoff!.enrollUrl);
    if (!url) return;
    await Linking.openURL(url);
  }

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.bg0 }]}>
      <View style={[styles.card, { backgroundColor: theme.bg1, borderColor: theme.border }]}>
        <Text style={[type.title, { color: theme.textHi, textAlign: 'center' }]}>MFA setup required</Text>
        <Text style={[type.body, { color: theme.textMd, textAlign: 'center' }]}>
          Your administrator requires multi-factor authentication. Complete setup in a web browser before using the mobile app.
        </Text>
        <Pressable testID="mfa-enrollment-open-web" onPress={() => { void openWebEnrollment(); }} style={[styles.primary, { backgroundColor: theme.brand }]}>
          <Text style={[type.bodyMd, { color: palette.dark.textHi }]}>Open web setup</Text>
        </Pressable>
        <Pressable testID="mfa-enrollment-sign-out" onPress={() => dispatch(logout())} style={[styles.secondary, { borderColor: theme.border }]}>
          <Text style={[type.bodyMd, { color: theme.textHi }]}>Sign out</Text>
        </Pressable>
        <Text style={[type.meta, { color: theme.textLo, textAlign: 'center' }]}>If setup is unavailable, contact your administrator.</Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'center', padding: spacing[5] },
  card: { borderWidth: 1, borderRadius: radii.lg, padding: spacing[5], gap: spacing[4] },
  primary: { minHeight: 48, borderRadius: radii.md, alignItems: 'center', justifyContent: 'center' },
  secondary: { minHeight: 48, borderWidth: 1, borderRadius: radii.md, alignItems: 'center', justifyContent: 'center' },
});
