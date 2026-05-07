import { useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  SERVER_PRESETS,
  isValidServerUrl,
  normalizeServerUrl,
  setServerUrl,
} from '../../services/serverConfig';
import { useApprovalTheme, palette, radii, spacing, type } from '../../theme';
import { Spinner } from '../../components/Spinner';
import { haptic } from '../../lib/motion';

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

function CheckGlyph({ color }: { color: string }) {
  return (
    <Svg width={18} height={18} viewBox="0 0 24 24">
      <Path
        d="M5 12 L10 17 L19 7"
        stroke={color}
        strokeWidth={2.25}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </Svg>
  );
}

export function ServerSelectScreen({ initialUrl, onSelected }: Props) {
  const theme = useApprovalTheme('dark');
  const [selection, setSelection] = useState<Selection>(() =>
    detectInitialSelection(initialUrl),
  );
  const [customUrl, setCustomUrl] = useState(() => {
    if (!initialUrl) return '';
    const matched = SERVER_PRESETS.find((p) => p.url === initialUrl);
    return matched ? '' : initialUrl;
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const customValid = selection !== 'custom' || isValidServerUrl(customUrl);
  const showCustomError =
    selection === 'custom' && customUrl.length > 0 && !customValid;
  const canContinue = selection !== 'custom' || customValid;

  async function handleContinue() {
    setError(null);
    let urlToSave: string;
    if (selection === 'custom') {
      if (!isValidServerUrl(customUrl)) {
        setError('Enter a valid URL like https://your-server.example.com');
        return;
      }
      urlToSave = normalizeServerUrl(customUrl);
    } else {
      const preset = SERVER_PRESETS.find((p) => p.id === selection);
      if (!preset) return;
      urlToSave = preset.url;
    }

    haptic.tap();
    setSaving(true);
    try {
      await setServerUrl(urlToSave);
      onSelected();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save server URL.');
    } finally {
      setSaving(false);
    }
  }

  function selectOption(next: Selection) {
    haptic.tap();
    setSelection(next);
  }

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.bg0 }]}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.keyboardView}
      >
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.header}>
            <Text style={[type.title, { color: theme.textHi }]}>
              Choose your server
            </Text>
            <Text
              style={[
                type.body,
                { color: theme.textMd, marginTop: spacing[2] },
              ]}
            >
              Pick the Breeze region you sign in to.
            </Text>
          </View>

          <View
            style={[
              styles.card,
              { backgroundColor: theme.bg1, borderColor: theme.border },
            ]}
          >
            {SERVER_PRESETS.map((preset) => {
              const selected = selection === preset.id;
              return (
                <Pressable
                  key={preset.id}
                  onPress={() => selectOption(preset.id)}
                  style={({ pressed }) => [
                    styles.optionRow,
                    {
                      backgroundColor: theme.bg2,
                      borderColor: selected ? theme.brand : theme.bg2,
                      opacity: pressed ? 0.85 : 1,
                    },
                  ]}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={[type.bodyMd, { color: theme.textHi }]}>
                      {preset.label}
                    </Text>
                    <Text
                      style={[
                        type.meta,
                        { color: theme.textLo, marginTop: spacing[1] },
                      ]}
                    >
                      {preset.url}
                    </Text>
                  </View>
                  {selected && <CheckGlyph color={theme.brand} />}
                </Pressable>
              );
            })}

            <Pressable
              onPress={() => selectOption('custom')}
              style={({ pressed }) => [
                styles.optionRow,
                {
                  backgroundColor: theme.bg2,
                  borderColor: selection === 'custom' ? theme.brand : theme.bg2,
                  opacity: pressed ? 0.85 : 1,
                },
              ]}
            >
              <View style={{ flex: 1 }}>
                <Text style={[type.bodyMd, { color: theme.textHi }]}>
                  Custom server
                </Text>
                <Text
                  style={[
                    type.meta,
                    { color: theme.textLo, marginTop: spacing[1] },
                  ]}
                >
                  Self-hosted or other region
                </Text>
              </View>
              {selection === 'custom' && <CheckGlyph color={theme.brand} />}
            </Pressable>

            {selection === 'custom' && (
              <View style={{ marginTop: spacing[4] }}>
                <Text style={[type.metaCaps, { color: theme.textLo }]}>
                  SERVER URL
                </Text>
                <View
                  style={[
                    styles.inputWrap,
                    {
                      backgroundColor: theme.bg2,
                      borderColor: showCustomError ? palette.deny.base : theme.bg2,
                    },
                  ]}
                >
                  <TextInput
                    value={customUrl}
                    onChangeText={setCustomUrl}
                    autoCapitalize="none"
                    autoCorrect={false}
                    spellCheck={false}
                    keyboardType="url"
                    placeholder="https://breeze.example.com"
                    placeholderTextColor={theme.textLo}
                    style={[
                      type.body,
                      {
                        color: theme.textHi,
                        padding: spacing[4],
                        minHeight: 48,
                        flex: 1,
                      },
                    ]}
                  />
                </View>
                <Text
                  style={[
                    type.meta,
                    {
                      color: showCustomError ? palette.deny.base : theme.textLo,
                      marginTop: spacing[2],
                    },
                  ]}
                >
                  {showCustomError
                    ? 'Enter a valid http(s):// URL.'
                    : 'Use the full https:// URL for your Breeze server.'}
                </Text>
              </View>
            )}

            {error ? (
              <View
                style={[
                  styles.errorBlock,
                  {
                    backgroundColor: palette.deny.wash,
                    borderColor: palette.deny.base,
                  },
                ]}
              >
                <Text style={[type.meta, { color: theme.textHi }]}>{error}</Text>
              </View>
            ) : null}

            <Pressable
              onPress={handleContinue}
              disabled={!canContinue || saving}
              style={({ pressed }) => [
                styles.primaryButton,
                {
                  backgroundColor: theme.brand,
                  opacity:
                    !canContinue || saving ? 0.5 : pressed ? 0.85 : 1,
                },
              ]}
            >
              {saving ? (
                <Spinner size={18} color={palette.dark.textHi} />
              ) : (
                <Text style={[type.bodyMd, { color: palette.dark.textHi }]}>
                  Continue
                </Text>
              )}
            </Pressable>
          </View>
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
    padding: spacing[6],
  },
  header: {
    alignItems: 'center',
    marginBottom: spacing[8],
  },
  card: {
    padding: spacing[6],
    borderRadius: radii.lg,
    borderWidth: 1,
  },
  optionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: spacing[4],
    borderRadius: radii.md,
    borderWidth: 1.5,
    marginBottom: spacing[3],
  },
  inputWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: radii.md,
    marginTop: spacing[2],
    borderWidth: 1,
  },
  errorBlock: {
    marginTop: spacing[4],
    padding: spacing[3],
    borderRadius: radii.md,
    borderWidth: 1,
  },
  primaryButton: {
    marginTop: spacing[6],
    paddingVertical: spacing[5],
    borderRadius: radii.lg,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
