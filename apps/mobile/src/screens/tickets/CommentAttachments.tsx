import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';

import { palette, radii, spacing, type } from '../../theme';
import { useAttachmentSource } from '../../lib/useAttachmentSource';
import type { TicketAttachmentMeta } from '../../services/ticketAttachmentContract';

import { formatByteSize, groupCommentAttachments } from './attachmentComposer';

interface Props {
  ticketId: string;
  attachments: TicketAttachmentMeta[] | undefined;
  onOpenImage: (attachment: TicketAttachmentMeta) => void;
  onOpenDocument: (attachment: TicketAttachmentMeta) => void;
}

function Thumbnail({
  ticketId,
  attachment,
  onPress,
}: {
  ticketId: string;
  attachment: TicketAttachmentMeta;
  onPress: () => void;
}) {
  const source = useAttachmentSource(ticketId, attachment.id);
  const [failed, setFailed] = useState(false);

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="imagebutton"
      accessibilityLabel={`Open ${attachment.originalFilename}`}
      style={styles.tile}
    >
      {source && !failed ? (
        <Image
          source={source}
          style={styles.tileImage}
          contentFit="cover"
          // Thumbnails are re-read on every feed render and on every return to
          // the screen; without a disk cache each one is a fresh authenticated
          // round trip over cellular.
          cachePolicy="memory-disk"
          transition={120}
          // Resolving the URL says nothing about whether the BYTES load — a
          // stale token or a deleted attachment fails here, and without this
          // the tile just stays blank forever with no way to tell why.
          onError={() => setFailed(true)}
          accessibilityIgnoresInvertColors
        />
      ) : (
        <View style={[styles.tileImage, styles.tilePlaceholder]}>
          {failed ? <Text style={styles.tileFailed}>!</Text> : null}
        </View>
      )}
    </Pressable>
  );
}

/**
 * A comment's attachments: images as a 3-column grid, documents as named rows.
 *
 * The split matters — a PDF has no thumbnail, and rendering it as a tile reads
 * as a broken image rather than a file.
 */
export function CommentAttachments({
  ticketId,
  attachments,
  onOpenImage,
  onOpenDocument,
}: Props) {
  const { images, documents } = groupCommentAttachments(attachments);
  if (images.length === 0 && documents.length === 0) return null;

  return (
    <View style={styles.container}>
      {images.length > 0 ? (
        <View style={styles.grid}>
          {images.map((attachment) => (
            <Thumbnail
              key={attachment.id}
              ticketId={ticketId}
              attachment={attachment}
              onPress={() => onOpenImage(attachment)}
            />
          ))}
        </View>
      ) : null}

      {documents.map((attachment) => (
        <Pressable
          key={attachment.id}
          onPress={() => onOpenDocument(attachment)}
          accessibilityRole="button"
          accessibilityLabel={`Open ${attachment.originalFilename}`}
          style={styles.docRow}
        >
          <View style={styles.docBadge}>
            <Text style={styles.docBadgeText}>PDF</Text>
          </View>
          <Text style={styles.docName} numberOfLines={1} ellipsizeMode="middle">
            {attachment.originalFilename}
          </Text>
          <Text style={styles.docSize}>{formatByteSize(attachment.byteSize)}</Text>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { marginTop: spacing['2'], gap: spacing['2'] },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing['2'] },
  // Three per row: `flexBasis` in percent minus the gap allowance, so the grid
  // adapts to phone and tablet widths without measuring the container.
  tile: { flexBasis: '31%', aspectRatio: 1 },
  tileImage: { width: '100%', height: '100%', borderRadius: radii.sm, backgroundColor: palette.dark.bg0 },
  tilePlaceholder: {
    borderWidth: 1,
    borderColor: palette.dark.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tileFailed: { ...type.bodyMd, color: palette.dark.textLo },
  docRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing['2'],
    borderWidth: 1,
    borderColor: palette.dark.border,
    borderRadius: radii.sm,
    padding: spacing['2'],
  },
  docBadge: {
    paddingHorizontal: spacing['2'],
    paddingVertical: spacing['1'],
    borderRadius: radii.sm,
    backgroundColor: palette.dark.bg0,
  },
  docBadgeText: { ...type.metaCaps, color: palette.dark.textMd },
  docName: { ...type.meta, color: palette.dark.textHi, flex: 1, minWidth: 0 },
  docSize: { ...type.meta, color: palette.dark.textLo },
});
