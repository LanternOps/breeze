import { useState } from 'react';
import {
  View,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
} from 'react-native';
import {
  Button,
  Text,
  TextInput,
  HelperText,
  Surface,
  RadioButton,
  useTheme,
} from 'react-native-paper';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  SERVER_PRESETS,
  isValidServerUrl,
  normalizeServerUrl,
  setServerUrl,
} from '../../services/serverConfig';

type Selection = 'us' | 'eu' | 'custom';

interface Props {
  initialUrl?: string | null;
  onSelected: () => void;
}

function detectInitialSelection(initialUrl: string | null | undefined): Selection {
  if (!initialUrl) return 'us';
  const matched = SERVER_PRESETS.find((p) => p.url === initialUrl);
  return matched ? matched.id : 'custom';
}

export function ServerSelectScreen({ initialUrl, onSelected }: Props) {
  const theme = useTheme();
  const [selection, setSelection] = useState<Selection>(() => detectInitialSelection(initialUrl));
  const [customUrl, setCustomUrl] = useState(() => {
    if (!initialUrl) return '';
    const matched = SERVER_PRESETS.find((p) => p.url === initialUrl);
    return matched ? '' : initialUrl;
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const customValid = selection !== 'custom' || isValidServerUrl(customUrl);
  const showCustomError = selection === 'custom' && customUrl.length > 0 && !customValid;
  const canContinue = selection !== 'custom' || customValid;

  async function handleContinue() {
    setError(null);
    let urlToSave: string;
    if (selection === 'custom') {
      if (!isValidServerUrl(customUrl)) {
        setError('Enter a valid URL (https://your-server.example.com)');
        return;
      }
      urlToSave = normalizeServerUrl(customUrl);
    } else {
      const preset = SERVER_PRESETS.find((p) => p.id === selection);
      if (!preset) return;
      urlToSave = preset.url;
    }

    setSaving(true);
    try {
      await setServerUrl(urlToSave);
      onSelected();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save server URL');
    } finally {
      setSaving(false);
    }
  }

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.keyboardView}
      >
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.header}>
            <Text variant="headlineLarge" style={[styles.title, { color: theme.colors.primary }]}>
              Choose your server
            </Text>
            <Text variant="bodyLarge" style={{ color: theme.colors.onSurfaceVariant }}>
              Select the Breeze region you sign in to
            </Text>
          </View>

          <Surface
            style={[styles.formContainer, { backgroundColor: theme.colors.surface }]}
            elevation={2}
          >
            <RadioButton.Group
              onValueChange={(value) => setSelection(value as Selection)}
              value={selection}
            >
              {SERVER_PRESETS.map((preset) => (
                <RadioButton.Item
                  key={preset.id}
                  value={preset.id}
                  label={preset.label}
                  position="leading"
                  style={styles.radioItem}
                  labelStyle={styles.radioLabel}
                />
              ))}
              <RadioButton.Item
                value="custom"
                label="Custom server"
                position="leading"
                style={styles.radioItem}
                labelStyle={styles.radioLabel}
              />
            </RadioButton.Group>

            {selection !== 'custom' && (
              <Text variant="bodySmall" style={[styles.helper, { color: theme.colors.onSurfaceVariant }]}>
                {SERVER_PRESETS.find((p) => p.id === selection)?.url}
              </Text>
            )}

            {selection === 'custom' && (
              <View style={styles.customWrapper}>
                <TextInput
                  label="Server URL"
                  value={customUrl}
                  onChangeText={setCustomUrl}
                  mode="outlined"
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="url"
                  placeholder="https://breeze.example.com"
                  error={showCustomError}
                />
                <HelperText type={showCustomError ? 'error' : 'info'} visible={true}>
                  {showCustomError
                    ? 'Enter a valid http(s):// URL'
                    : 'Enter the full https:// URL for your Breeze server'}
                </HelperText>
              </View>
            )}

            {error && (
              <HelperText type="error" visible={true}>
                {error}
              </HelperText>
            )}

            <Button
              mode="contained"
              onPress={handleContinue}
              loading={saving}
              disabled={!canContinue || saving}
              style={styles.continueButton}
              contentStyle={styles.buttonContent}
            >
              Continue
            </Button>
          </Surface>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  keyboardView: { flex: 1 },
  scrollContent: {
    flexGrow: 1,
    justifyContent: 'center',
    padding: 24,
  },
  header: { alignItems: 'center', marginBottom: 32 },
  title: { fontWeight: 'bold', marginBottom: 8 },
  formContainer: { padding: 24, borderRadius: 16 },
  radioItem: { paddingVertical: 4 },
  radioLabel: { textAlign: 'left' },
  helper: { marginTop: 8, marginLeft: 16 },
  customWrapper: { marginTop: 12 },
  continueButton: { marginTop: 16 },
  buttonContent: { paddingVertical: 8 },
});
