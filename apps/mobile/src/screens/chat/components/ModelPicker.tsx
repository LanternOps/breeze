import { useState } from 'react';
import { Modal, Pressable, ScrollView, Switch, Text, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';

import { useApprovalTheme, palette, radii, spacing, type } from '../../../theme';
import { haptic } from '../../../lib/motion';
import {
  EFFORT_LABELS,
  chosenOffering,
  effectiveChoice,
  optionControls,
  pickerRows,
  showPicker,
  type EffortLevel,
} from '../modelPicker';
import type { ChatModelPicker } from '../useChatModelPicker';

type Theme = ReturnType<typeof useApprovalTheme>;

function Chevron({ color }: { color: string }) {
  return (
    <Svg width={12} height={12} viewBox="0 0 24 24">
      <Path d="M6 9 L12 15 L18 9" stroke={color} strokeWidth={2.25} strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </Svg>
  );
}

/**
 * The composer's model menu (W05; mirrors the web AiModelPicker): a small
 * pill with the model the next message will use, opening a sheet with the
 * offerings and the options the chosen one supports. Renders nothing when
 * there is no menu or choice is locked — the server default then applies.
 */
export function ModelPicker({ picker, disabled }: { picker: ChatModelPicker; disabled?: boolean }) {
  const theme = useApprovalTheme('dark');
  const [open, setOpen] = useState(false);
  const { choices } = picker.state;
  if (!showPicker(choices)) return null;

  const { offeringId, options } = effectiveChoice(picker.state);
  const chosen = chosenOffering(picker.state);
  const rows = pickerRows(choices, offeringId, picker.suggested);
  const controls = optionControls(chosen);
  const summary = [
    chosen?.displayName ?? 'Choose a model',
    options.effort && controls.effort ? EFFORT_LABELS[options.effort] : null,
    options.speed === 'fast' && controls.fast ? 'Fast' : null,
    options.budgetThinking === 'on' && controls.thinking ? 'Thinking' : null,
  ].filter(Boolean).join(' · ');

  return (
    <>
      <View style={{ paddingHorizontal: spacing[4], paddingTop: spacing[2], flexDirection: 'row' }}>
        <Pressable
          onPress={() => { haptic.tap(); setOpen(true); }}
          disabled={disabled}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={`AI model: ${summary}. Change model`}
          testID="ai-model-picker-button"
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: spacing[1],
            paddingHorizontal: spacing[3],
            paddingVertical: spacing[1],
            borderRadius: radii.full,
            backgroundColor: theme.bg2,
            borderWidth: 1,
            borderColor: theme.border,
            opacity: disabled ? 0.5 : 1,
            maxWidth: '100%',
          }}
        >
          <Text style={[type.meta, { color: theme.textMd, flexShrink: 1 }]} numberOfLines={1}>
            {summary}
          </Text>
          <Chevron color={theme.textMd} />
        </Pressable>
      </View>

      <Modal visible={open} transparent animationType="slide" onRequestClose={() => setOpen(false)}>
        <Pressable
          style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end' }}
          onPress={() => setOpen(false)}
        >
          <Pressable
            onPress={(e) => e.stopPropagation()}
            style={{
              backgroundColor: theme.bg1,
              borderTopLeftRadius: radii.xl,
              borderTopRightRadius: radii.xl,
              paddingTop: spacing[5],
              paddingBottom: spacing[10],
              maxHeight: '80%',
            }}
          >
            <View style={{ alignSelf: 'center', width: 36, height: 4, borderRadius: 2, backgroundColor: theme.bg3, marginBottom: spacing[4] }} />
            <Text style={[type.title, { color: theme.textHi, paddingHorizontal: spacing[6] }]}>AI model</Text>
            <Text style={[type.meta, { color: theme.textMd, paddingHorizontal: spacing[6], marginTop: spacing[1] }]}>
              Applies from your next message.
            </Text>

            <ScrollView style={{ marginTop: spacing[4] }} contentContainerStyle={{ paddingHorizontal: spacing[4] }}>
              {rows.map((row) => (
                <Pressable
                  key={row.offeringId}
                  disabled={row.disabled}
                  onPress={() => { haptic.tap(); picker.select(row.offeringId); }}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: row.selected, disabled: row.disabled }}
                  testID={`ai-model-option-${row.offeringId}`}
                  style={{
                    paddingHorizontal: spacing[3],
                    paddingVertical: spacing[3],
                    borderRadius: radii.md,
                    backgroundColor: row.selected ? theme.bg2 : 'transparent',
                    borderWidth: 1,
                    borderColor: row.selected ? palette.brand.deep : 'transparent',
                    opacity: row.disabled ? 0.5 : 1,
                    marginBottom: spacing[1],
                  }}
                >
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing[2], flexWrap: 'wrap' }}>
                    <Text style={[type.bodyMd, { color: theme.textHi }]}>{row.title}</Text>
                    {row.isDefault ? <Text style={[type.meta, { color: theme.textLo }]}>(default)</Text> : null}
                    {row.suggested ? <Text style={[type.metaCaps, { color: theme.brand }]}>SUGGESTED</Text> : null}
                  </View>
                  <Text style={[type.meta, { color: theme.textMd, marginTop: spacing['0.5'] }]}>{row.detail}</Text>
                  {row.gatedNote ? (
                    <Text style={[type.meta, { color: theme.textLo, marginTop: spacing['0.5'] }]}>{row.gatedNote}</Text>
                  ) : null}
                </Pressable>
              ))}

              {controls.effort ? (
                <View style={{ marginTop: spacing[4], paddingHorizontal: spacing[3] }}>
                  <Text style={[type.metaCaps, { color: theme.textLo, marginBottom: spacing[2] }]}>EFFORT</Text>
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2] }}>
                    {([undefined, ...controls.effort] as Array<EffortLevel | undefined>).map((level) => {
                      const active = options.effort === level;
                      return (
                        <Pressable
                          key={level ?? 'default'}
                          onPress={() => { haptic.tap(); picker.setOption('effort', level); }}
                          accessibilityRole="radio"
                          accessibilityState={{ selected: active }}
                          testID={`ai-model-effort-${level ?? 'default'}`}
                          style={{
                            paddingHorizontal: spacing[3],
                            paddingVertical: spacing[2],
                            borderRadius: radii.full,
                            backgroundColor: active ? palette.brand.deep : theme.bg2,
                          }}
                        >
                          <Text style={[type.meta, { color: active ? theme.textHi : theme.textMd }]}>
                            {level ? EFFORT_LABELS[level] : 'Default'}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>
                </View>
              ) : null}

              {controls.fast ? (
                <ToggleRow
                  theme={theme}
                  label={controls.fast.label}
                  value={options.speed === 'fast'}
                  onChange={(on) => picker.setOption('speed', on ? 'fast' : 'standard')}
                  testID="ai-model-fast"
                />
              ) : null}

              {controls.thinking ? (
                <ToggleRow
                  theme={theme}
                  label="Thinking"
                  value={options.budgetThinking === 'on'}
                  onChange={(on) => picker.setOption('budgetThinking', on ? 'on' : 'off')}
                  testID="ai-model-thinking"
                />
              ) : null}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

function ToggleRow({ theme, label, value, onChange, testID }: {
  theme: Theme;
  label: string;
  value: boolean;
  onChange: (on: boolean) => void;
  testID: string;
}) {
  return (
    <View
      testID={testID}
      style={{ flexDirection: 'row', alignItems: 'center', marginTop: spacing[4], paddingHorizontal: spacing[3], minHeight: 44 }}
    >
      <Text style={[type.bodyMd, { color: theme.textHi, flex: 1, marginRight: spacing[3] }]}>{label}</Text>
      <Switch
        value={value}
        onValueChange={onChange}
        trackColor={{ false: theme.bg3, true: palette.brand.deep }}
        thumbColor={value ? palette.brand.base : theme.textMd}
      />
    </View>
  );
}
