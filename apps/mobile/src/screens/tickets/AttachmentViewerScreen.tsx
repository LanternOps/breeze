import { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import type { RouteProp } from '@react-navigation/native';
import { useRoute } from '@react-navigation/native';
import { Image } from 'expo-image';

import { palette, radii, spacing, type } from '../../theme';
import { openAttachmentExternally } from '../../services/ticketAttachments';
import { AttachmentUploadError } from '../../services/ticketAttachmentContract';
import { useAttachmentSource } from '../../lib/useAttachmentSource';
import { reportInternalError } from '../../lib/errorReporting';
import type { TicketsStackParamList } from '../../navigation/MainNavigator';

import { viewerMode } from './attachmentComposer';

type ViewerRoute = RouteProp<TicketsStackParamList, 'AttachmentViewer'>;

/**
 * Full-screen attachment viewer, presented as a modal.
 *
 * Images render inline through `expo-image` with the authenticated headers —
 * the content route is never a presigned URL, so a bare `uri` would 401 and
 * show an empty frame with no error. Anything else (a PDF) is downloaded to the
 * cache and handed to the OS share sheet, because React Native has no PDF view
 * and the system browser cannot send our Authorization header.
 */
export function AttachmentViewerScreen() {
  const route = useRoute<ViewerRoute>();
  const { ticketId, attachmentId, contentType, filename } = route.params;

  const mode = viewerMode(contentType);
  const source = useAttachmentSource(ticketId, attachmentId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [imageFailed, setImageFailed] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);

  const openExternally = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await openAttachmentExternally(ticketId, attachmentId, filename, contentType);
    } catch (err: unknown) {
      reportInternalError(err, 'ticket-attachment-open');
      setError(
        err instanceof AttachmentUploadError ? err.message : 'Could not open this file.'
      );
    } finally {
      setBusy(false);
    }
  }, [busy, ticketId, attachmentId, filename, contentType]);

  return (
    <View style={styles.screen}>
      {mode === 'image' ? (
        imageFailed ? (
          // Without this branch a failed byte fetch leaves the spinner running
          // forever: `source` is set (the URL resolved fine), but `expo-image`
          // renders nothing and reports the failure only through `onError`.
          <View style={styles.docPane}>
            <Text style={styles.docHint}>Could not load this photo.</Text>
            <Pressable
              onPress={() => {
                setImageFailed(false);
                // Remount the Image so it refetches rather than serving the
                // failure it already cached for this source.
                setLoadAttempt((n) => n + 1);
              }}
              accessibilityRole="button"
              style={styles.button}
            >
              <Text style={styles.buttonText}>Try again</Text>
            </Pressable>
          </View>
        ) : source ? (
          <Image
            key={loadAttempt}
            source={source}
            style={styles.image}
            contentFit="contain"
            cachePolicy="memory-disk"
            onError={() => setImageFailed(true)}
            accessibilityLabel={filename}
            accessibilityIgnoresInvertColors
          />
        ) : (
          <ActivityIndicator color={palette.brand.soft} />
        )
      ) : (
        <View style={styles.docPane}>
          <Text style={styles.docName} numberOfLines={2} ellipsizeMode="middle">
            {filename}
          </Text>
          <Text style={styles.docHint}>
            PDFs open in another app on this device.
          </Text>
          <Pressable
            onPress={() => void openExternally()}
            disabled={busy}
            accessibilityRole="button"
            accessibilityState={{ disabled: busy }}
            style={[styles.button, busy && styles.buttonDisabled]}
          >
            <Text style={styles.buttonText}>{busy ? 'Opening…' : 'Open'}</Text>
          </Pressable>
          {error ? <Text style={styles.error}>{error}</Text> : null}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: palette.dark.bg0,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing['4'],
  },
  image: { width: '100%', height: '100%' },
  docPane: { alignItems: 'center', gap: spacing['3'] },
  docName: { ...type.title, color: palette.dark.textHi, textAlign: 'center' },
  docHint: { ...type.meta, color: palette.dark.textLo, textAlign: 'center' },
  button: {
    paddingHorizontal: spacing['6'],
    paddingVertical: spacing['3'],
    borderRadius: radii.md,
    backgroundColor: palette.brand.base,
  },
  buttonDisabled: { opacity: 0.5 },
  buttonText: { ...type.bodyMd, color: palette.dark.textHi },
  error: { ...type.meta, color: palette.deny.base, textAlign: 'center' },
});
