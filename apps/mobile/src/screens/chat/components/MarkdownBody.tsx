import { useMemo } from 'react';
import { Text, View } from 'react-native';
import Markdown, { type RenderRules } from 'react-native-markdown-display';

import { useApprovalTheme, fontFamily, radii, spacing } from '../../../theme';
import { parseMarkdownTable } from './markdownTable';

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
      // No table/thead/tr/th/td styles here: tables are rendered entirely by
      // the custom `table` rule below (issue #3119).
    }),
    [theme],
  );

  // Custom table renderer (issue #3119). With mergeStyle={false} the library
  // drops its default layout styles (tr: row direction, th/td: flex 1), so
  // cells collapsed into full-width stacked lines. Rather than restoring the
  // grid — which squeezes 3+ columns into unreadable slivers at phone widths
  // or forces a horizontal scroller nested inside the chat scroll — tables
  // render as stacked rows with the column label repeated per value
  // ("OS: Windows Server"), matching the app's block cards (DeviceCard etc.).
  const tableStyles = useMemo(
    () => ({
      card: {
        borderWidth: 1,
        borderColor: theme.border,
        borderRadius: radii.md,
        marginVertical: spacing[2],
        overflow: 'hidden' as const,
      },
      row: {
        paddingHorizontal: spacing[4],
        paddingVertical: spacing[3],
      },
      rowDivider: {
        borderTopWidth: 1,
        borderTopColor: theme.border,
      },
      line: {
        fontFamily: fontFamily.sans,
        fontSize: 15,
        lineHeight: 22,
        color: theme.textHi,
      },
      label: {
        fontFamily: fontFamily.sansSemiBold,
        color: theme.textMd,
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
      table: (node) => {
        const { labels, rows } = parseMarkdownTable(node);
        // Header-only table: show the header cells as a plain row rather
        // than dropping the content (no labels to pair them with).
        const bodyRows = rows.length > 0 ? rows : labels.length > 0 ? [labels] : [];
        if (bodyRows.length === 0) {
          return null;
        }
        const showLabels = rows.length > 0;
        return (
          <View key={node.key} style={tableStyles.card}>
            {bodyRows.map((cells, rowIndex) => (
              <View
                key={rowIndex}
                style={
                  rowIndex > 0 ? [tableStyles.row, tableStyles.rowDivider] : tableStyles.row
                }
              >
                {cells.map((value, cellIndex) => {
                  const label = showLabels ? labels[cellIndex] : undefined;
                  return (
                    <Text key={cellIndex} style={tableStyles.line}>
                      {label ? <Text style={tableStyles.label}>{label}: </Text> : null}
                      {value}
                    </Text>
                  );
                })}
              </View>
            ))}
          </View>
        );
      },
    }),
    [tableStyles],
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
