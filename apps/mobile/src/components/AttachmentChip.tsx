import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';

import { palette, radii, spacing, type } from '../theme';
import type { AttachmentChip as Chip } from '../screens/tickets/attachmentComposer';

interface Props {
  chip: Chip;
  onRetry: (localId: string) => void;
  onRemove: (localId: string) => void;
}

/**
 * One pending attachment in the comment composer.
 *
 * The local file URI is used for the thumbnail rather than the served bytes:
 * the row exists before the upload finishes, and re-fetching a file already on
 * this device would be a round trip for a picture the phone just took.
 */
export function AttachmentChip({ chip, onRetry, onRemove }: Props) {
  const isImage = chip.file.mimeType.startsWith('image/');
  const failed = chip.status === 'failed';

  return (
    <View style={[styles.chip, failed && styles.chipFailed]}>
      {isImage ? (
        <Image
          source={{ uri: chip.file.uri }}
          style={styles.thumb}
          contentFit="cover"
          accessibilityIgnoresInvertColors
        />
      ) : (
        <View style={[styles.thumb, styles.docThumb]}>
          <Text style={styles.docThumbText}>PDF</Text>
        </View>
      )}

      <View style={styles.body}>
        <Text style={styles.name} numberOfLines={1} ellipsizeMode="middle">
          {chip.file.name}
        </Text>
        {chip.status === 'uploading' ? (
          <View style={styles.statusRow}>
            <ActivityIndicator size="small" color={palette.brand.soft} />
            <Text style={styles.statusText}>Uploading…</Text>
          </View>
        ) : null}
        {failed ? <Text style={styles.errorText}>{chip.error}</Text> : null}
      </View>

      <View style={styles.actions}>
        {/* Retry is offered ONLY when the failure can actually succeed on a
            second attempt. A 415 or an over-size file never can, and offering
            it there trains people to tap a button that always fails. */}
        {failed && chip.retryable ? (
          <Pressable
            onPress={() => onRetry(chip.localId)}
            accessibilityRole="button"
            accessibilityLabel={`Retry uploading ${chip.file.name}`}
            style={styles.action}
          >
            <Text style={styles.actionText}>Retry</Text>
          </Pressable>
        ) : null}
        <Pressable
          onPress={() => onRemove(chip.localId)}
          accessibilityRole="button"
          accessibilityLabel={`Remove ${chip.file.name}`}
          style={styles.action}
        >
          <Text style={styles.actionText}>Remove</Text>
        </Pressable>
      </View>
    </View>
  );
}

const THUMB = 40;

const styles = StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing['2'],
    backgroundColor: palette.dark.bg1,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: palette.dark.border,
    padding: spacing['2'],
    marginTop: spacing['2'],
  },
  chipFailed: { borderColor: palette.deny.base },
  thumb: { width: THUMB, height: THUMB, borderRadius: radii.sm, backgroundColor: palette.dark.bg0 },
  docThumb: { alignItems: 'center', justifyContent: 'center' },
  docThumbText: { ...type.metaCaps, color: palette.dark.textMd },
  body: { flex: 1, minWidth: 0 },
  name: { ...type.meta, color: palette.dark.textHi },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: spacing['1'], marginTop: spacing['1'] },
  statusText: { ...type.meta, color: palette.dark.textLo },
  errorText: { ...type.meta, color: palette.deny.base, marginTop: spacing['1'] },
  actions: { flexDirection: 'row', gap: spacing['2'] },
  action: { paddingHorizontal: spacing['2'], paddingVertical: spacing['1'] },
  actionText: { ...type.meta, color: palette.brand.soft },
});
