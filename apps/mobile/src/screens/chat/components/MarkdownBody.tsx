import { useMemo } from 'react';
import Markdown, { type RenderRules } from 'react-native-markdown-display';

import { useApprovalTheme, fontFamily, radii, spacing } from '../../../theme';

interface Props {
  content: string;
}

// Markdown renderer themed to DESIGN.md tokens.
// - Body text: Geist Regular 16/24, Text High.
// - Inline code + fenced code: GeistMono on Surface 2 with rounded.md corners.
// - Links: Brand Teal, no underline (the color is the affordance).
// - Headings: stepped down from Display so they don't compete with the
//   approval-card register elsewhere in the app.
// - HR rules suppressed per the brief — they read as visual gunk on small screens.
export function MarkdownBody({ content }: Props) {
  const theme = useApprovalTheme('dark');

  // The library expects a flat StyleSheet-like object keyed by AST node type.
  const styles = useMemo(
    () => ({
      body: {
        color: theme.textHi,
        fontFamily: fontFamily.sans,
        fontSize: 16,
        lineHeight: 24,
      },
      paragraph: {
        marginTop: 0,
        marginBottom: spacing[3],
      },
      strong: {
        fontFamily: fontFamily.sansSemiBold,
      },
      em: {
        fontStyle: 'italic' as const,
      },
      s: {
        textDecorationLine: 'line-through' as const,
        color: theme.textMd,
      },
      link: {
        color: theme.brand,
      },
      heading1: {
        fontFamily: fontFamily.sansSemiBold,
        fontSize: 22,
        lineHeight: 28,
        letterSpacing: -0.2,
        color: theme.textHi,
        marginTop: spacing[2],
        marginBottom: spacing[3],
      },
      heading2: {
        fontFamily: fontFamily.sansSemiBold,
        fontSize: 19,
        lineHeight: 26,
        letterSpacing: -0.2,
        color: theme.textHi,
        marginTop: spacing[2],
        marginBottom: spacing[3],
      },
      heading3: {
        fontFamily: fontFamily.sansSemiBold,
        fontSize: 17,
        lineHeight: 24,
        color: theme.textHi,
        marginTop: spacing[2],
        marginBottom: spacing[2],
      },
      heading4: {
        fontFamily: fontFamily.sansMedium,
        fontSize: 16,
        lineHeight: 24,
        color: theme.textHi,
        marginTop: spacing[2],
        marginBottom: spacing[2],
      },
      heading5: {
        fontFamily: fontFamily.sansMedium,
        fontSize: 15,
        lineHeight: 22,
        color: theme.textHi,
        marginTop: spacing[2],
        marginBottom: spacing[1],
      },
      heading6: {
        fontFamily: fontFamily.sansSemiBold,
        fontSize: 11,
        lineHeight: 14,
        letterSpacing: 1.0,
        color: theme.textLo,
        marginTop: spacing[2],
        marginBottom: spacing[1],
        textTransform: 'uppercase' as const,
      },
      bullet_list: {
        marginVertical: spacing[2],
      },
      ordered_list: {
        marginVertical: spacing[2],
      },
      list_item: {
        marginBottom: spacing[1],
        flexDirection: 'row' as const,
      },
      bullet_list_icon: {
        color: theme.textMd,
        marginRight: spacing[2],
      },
      ordered_list_icon: {
        color: theme.textMd,
        marginRight: spacing[2],
      },
      blockquote: {
        backgroundColor: theme.bg2,
        borderRadius: radii.md,
        paddingHorizontal: spacing[4],
        paddingVertical: spacing[3],
        marginVertical: spacing[2],
      },
      code_inline: {
        fontFamily: fontFamily.mono,
        fontSize: 14,
        lineHeight: 22,
        color: theme.textHi,
        backgroundColor: theme.bg2,
        paddingHorizontal: 6,
        paddingVertical: 1,
        borderRadius: radii.sm,
      },
      code_block: {
        fontFamily: fontFamily.mono,
        fontSize: 14,
        lineHeight: 22,
        color: theme.textHi,
        backgroundColor: theme.bg2,
        padding: spacing[4],
        borderRadius: radii.md,
        marginVertical: spacing[2],
      },
      fence: {
        fontFamily: fontFamily.mono,
        fontSize: 14,
        lineHeight: 22,
        color: theme.textHi,
        backgroundColor: theme.bg2,
        padding: spacing[4],
        borderRadius: radii.md,
        marginVertical: spacing[2],
      },
      hr: {
        // Suppressed — see brief. Width 0 collapses the rule entirely.
        height: 0,
        backgroundColor: 'transparent',
      },
      table: {
        borderColor: theme.border,
        borderWidth: 1,
        borderRadius: radii.md,
        marginVertical: spacing[2],
      },
      thead: {
        backgroundColor: theme.bg2,
      },
      th: {
        padding: spacing[3],
        fontFamily: fontFamily.sansSemiBold,
        color: theme.textHi,
      },
      td: {
        padding: spacing[3],
        color: theme.textHi,
      },
      tr: {
        borderBottomColor: theme.border,
        borderBottomWidth: 1,
      },
    }),
    [theme],
  );

  // Suppress markdown HR entirely: the rule above zeroes its size, and we
  // also override the renderer to return null in case the library shows a
  // non-zero default.
  const rules: RenderRules = useMemo(
    () => ({
      hr: () => null,
    }),
    [],
  );

  return (
    <Markdown
      style={styles}
      rules={rules}
      mergeStyle={false}
      onLinkPress={() => true}
    >
      {content}
    </Markdown>
  );
}
