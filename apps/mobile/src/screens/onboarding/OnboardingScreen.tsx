import { useEffect, useRef, useState } from 'react';
import {
  Dimensions,
  NativeScrollEvent,
  NativeSyntheticEvent,
  Pressable,
  ScrollView,
  Text,
  View,
} from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  palette,
  radii,
  spacing,
  type,
  useApprovalTheme,
} from '../../theme';
import { duration, ease, haptic } from '../../lib/motion';
import { track } from '../../lib/analytics';
import { CountdownRing } from '../approvals/components/CountdownRing';
import { RequesterRow } from '../approvals/components/RequesterRow';
import { ActionHeadline } from '../approvals/components/ActionHeadline';
import { RiskBand } from '../approvals/components/RiskBand';
import { UserMessage } from '../chat/components/UserMessage';
import { AiMessage } from '../chat/components/AiMessage';
import { Hero } from '../systems/components/Hero';
import { IssueRow } from '../systems/components/IssueRow';
import type { Alert } from '../../services/api';
import type { ChatMessage } from '../../store/aiChatSlice';

interface Props {
  onComplete: () => void;
}

const PAGE_COUNT = 3;

export function OnboardingScreen({ onComplete }: Props) {
  const insets = useSafeAreaInsets();
  const theme = useApprovalTheme('dark');
  const scrollRef = useRef<ScrollView>(null);
  const [page, setPage] = useState(0);
  const { width } = Dimensions.get('window');

  function goTo(index: number) {
    const clamped = Math.max(0, Math.min(PAGE_COUNT - 1, index));
    scrollRef.current?.scrollTo({ x: clamped * width, animated: true });
    haptic.tap();
  }

  function handleScroll(e: NativeSyntheticEvent<NativeScrollEvent>) {
    const next = Math.round(e.nativeEvent.contentOffset.x / width);
    if (next !== page) setPage(next);
  }

  function finish(path: 'completed' | 'skipped') {
    haptic.approve();
    track('onboarding_completed', { path });
    onComplete();
  }

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg0 }}>
      <View
        style={{
          position: 'absolute',
          top: insets.top + spacing[3],
          right: spacing[5],
          zIndex: 10,
        }}
      >
        <Pressable onPress={() => finish('skipped')} hitSlop={12} accessibilityLabel="Skip onboarding">
          <Text style={[type.metaCaps, { color: theme.textMd }]}>SKIP</Text>
        </Pressable>
      </View>

      <ScrollView
        ref={scrollRef}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onScroll={handleScroll}
        scrollEventThrottle={16}
        bounces={false}
      >
        <Page width={width}>
          <ApprovalPreview />
          <Copy
            eyebrow="APPROVALS COME TO YOU"
            headline="Approve in one tap."
            body="When the AI agent or your team needs your sign-off, your phone buzzes. Read what's being asked, approve or deny."
          />
        </Page>

        <Page width={width}>
          <ChatPreview />
          <Copy
            eyebrow="ASK THE FLEET"
            headline="Your fleet, in one chat."
            body="Ask Breeze about your devices, alerts, or recent activity. The AI runs the queries and shows you the answer inline."
          />
        </Page>

        <Page width={width}>
          <SystemsPreview />
          <Copy
            eyebrow="STAY GROUNDED"
            headline="Health at a glance."
            body="The Systems tab shows your fleet's status, active issues, and what just happened. Pull to refresh, pushes update silently."
          />
        </Page>
      </ScrollView>

      <View
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: insets.bottom + spacing[5],
          paddingHorizontal: spacing[6],
        }}
      >
        <View
          style={{
            flexDirection: 'row',
            justifyContent: 'center',
            alignItems: 'center',
            gap: spacing[2],
            marginBottom: spacing[6],
          }}
        >
          {Array.from({ length: PAGE_COUNT }).map((_, i) => (
            <Dot key={i} active={i === page} onPress={() => goTo(i)} />
          ))}
        </View>

        {page === PAGE_COUNT - 1 ? (
          <Pressable
            onPress={() => finish('completed')}
            accessibilityLabel="Get started"
            style={({ pressed }) => ({
              backgroundColor: pressed ? palette.brand.deep : palette.brand.base,
              borderRadius: radii.lg,
              paddingVertical: spacing[5],
              alignItems: 'center',
            })}
          >
            <Text
              style={[
                type.bodyMd,
                { color: palette.dark.textHi, letterSpacing: 0.2 },
              ]}
            >
              Get started
            </Text>
          </Pressable>
        ) : (
          // Reserve the same vertical space the button would occupy so dots
          // don't jump when the last page swaps the CTA in.
          <View style={{ height: 24 + spacing[5] * 2 }} />
        )}
      </View>
    </View>
  );
}

function Page({ width, children }: { width: number; children: React.ReactNode }) {
  const insets = useSafeAreaInsets();
  return (
    <View
      style={{
        width,
        flex: 1,
        paddingTop: insets.top + spacing[12],
        paddingBottom: insets.bottom + spacing[20] + spacing[10],
        paddingHorizontal: spacing[6],
        justifyContent: 'center',
      }}
    >
      {children}
    </View>
  );
}

function Copy({
  eyebrow,
  headline,
  body,
}: {
  eyebrow: string;
  headline: string;
  body: string;
}) {
  const theme = useApprovalTheme('dark');
  return (
    <View style={{ marginTop: spacing[10] }}>
      <Text style={[type.metaCaps, { color: palette.brand.soft }]}>{eyebrow}</Text>
      <Text
        style={[
          type.display,
          { color: theme.textHi, marginTop: spacing[3] },
        ]}
      >
        {headline}
      </Text>
      <Text
        style={[
          type.bodyLg,
          { color: theme.textMd, marginTop: spacing[3] },
        ]}
      >
        {body}
      </Text>
    </View>
  );
}

function Dot({ active, onPress }: { active: boolean; onPress: () => void }) {
  // Reanimated width + color transition so the active dot grows and tints
  // brand-teal. Inactive dots stay compact and Surface-3.
  const progress = useSharedValue(active ? 1 : 0);

  useEffect(() => {
    progress.value = withTiming(active ? 1 : 0, {
      duration: duration.base,
      easing: ease,
    });
  }, [active]);

  const style = useAnimatedStyle(() => {
    const w = 6 + progress.value * 18;
    return {
      width: w,
    };
  });

  return (
    <Pressable onPress={onPress} hitSlop={12}>
      <Animated.View
        style={[
          {
            height: 6,
            borderRadius: radii.full,
            backgroundColor: active ? palette.brand.base : palette.dark.bg3,
          },
          style,
        ]}
      />
    </Pressable>
  );
}

// --- Real-component previews --------------------------------------------

// Page 1: a faithful, downscaled mock of ApprovalScreen. Composes the same
// primitives (CountdownRing, RequesterRow, ActionHeadline, RiskBand) plus
// a static visual of the Approve/Deny pair so we don't pull in the
// biometric machinery from the real ApprovalButtons.
function ApprovalPreview() {
  const theme = useApprovalTheme('dark');
  // Push expiresAt 60s out so CountdownRing renders at full and ticks down
  // gently while the user reads. Recompute on each mount via useState.
  const [expiresAt] = useState(() => new Date(Date.now() + 60_000).toISOString());
  const [createdAt] = useState(() => new Date().toISOString());

  return (
    <View
      style={{
        backgroundColor: theme.bg1,
        borderRadius: radii.xl,
        borderWidth: 1,
        borderColor: theme.border,
        // Negative horizontal margin lets the inner components keep their
        // native paddingHorizontal: spacing[6] without doubling up.
        paddingVertical: spacing[5],
        marginHorizontal: spacing[2],
        overflow: 'hidden',
      }}
    >
      <View
        style={{
          alignItems: 'center',
          paddingTop: spacing[2],
        }}
      >
        <CountdownRing expiresAt={expiresAt} size={64} stroke={3} />
      </View>

      <RequesterRow
        clientLabel="Claude · Todd's Mac"
        machineLabel="dahlia-prod-01"
        createdAt={createdAt}
      />

      <ActionHeadline action="Delete 4 devices in Acme Corp" />

      <RiskBand tier="high" summary="Reversible within 30 days" />

      <View
        style={{
          flexDirection: 'row',
          paddingHorizontal: spacing[6],
          gap: spacing[3],
          marginTop: spacing[6],
        }}
      >
        <View
          style={{
            flex: 1,
            paddingVertical: spacing[5],
            borderRadius: radii.lg,
            backgroundColor: theme.bg2,
            alignItems: 'center',
          }}
        >
          <Text style={[type.bodyMd, { color: theme.textHi }]}>Deny</Text>
        </View>
        <View
          style={{
            flex: 1.4,
            paddingVertical: spacing[5],
            borderRadius: radii.lg,
            backgroundColor: theme.approve,
            alignItems: 'center',
          }}
        >
          <Text style={[type.bodyMd, { color: palette.approve.onBase }]}>Approve</Text>
        </View>
      </View>
    </View>
  );
}

// Page 2: real UserMessage + AiMessage, fed a static ChatMessage with one
// in-flight tool event so the ToolIndicator + StreamingPulse render
// naturally. A static composer mock sits below.
function ChatPreview() {
  const theme = useApprovalTheme('dark');

  const aiMessage: Extract<ChatMessage, { role: 'assistant' }> = {
    id: 'onboarding-ai-1',
    role: 'assistant',
    content: 'Here are 4 devices.',
    toolEvents: [
      {
        toolUseId: 'onboarding-tool-1',
        toolName: 'query_devices',
        state: 'started',
      },
    ],
    sentAt: new Date().toISOString(),
    isStreaming: true,
  };

  return (
    <View>
      <View style={{ marginHorizontal: -spacing[6] }}>
        <UserMessage content="Show me devices in Acme Corp" />
        <AiMessage
          message={aiMessage}
          inFlightTool={{ toolUseId: 'onboarding-tool-1', toolName: 'query_devices' }}
        />
      </View>

      {/* Static composer mock — visual stand-in for the real Composer so we
          don't pull in voice/network state during onboarding. */}
      <View
        style={{
          marginTop: spacing[6],
          flexDirection: 'row',
          alignItems: 'center',
          backgroundColor: theme.bg1,
          borderRadius: radii.full,
          borderWidth: 1,
          borderColor: theme.border,
          paddingVertical: spacing[3],
          paddingHorizontal: spacing[5],
        }}
      >
        <Text style={[type.body, { color: theme.textLo, flex: 1 }]}>Ask Breeze.</Text>
        <View
          style={{
            width: 28,
            height: 28,
            borderRadius: radii.full,
            backgroundColor: palette.brand.base,
          }}
        />
      </View>
    </View>
  );
}

// Page 3: real Hero + a couple of IssueRow entries to give the page body.
function SystemsPreview() {
  const theme = useApprovalTheme('dark');

  const issues: Alert[] = [
    {
      id: 'onboarding-alert-1',
      title: 'Disk usage critical on PRINT-01',
      message: 'Disk usage at 96%',
      severity: 'critical',
      type: 'disk',
      deviceName: 'PRINT-01 · Acme Corp',
      acknowledged: false,
      createdAt: new Date(Date.now() - 12 * 60_000).toISOString(),
      updatedAt: new Date(Date.now() - 12 * 60_000).toISOString(),
    },
    {
      id: 'onboarding-alert-2',
      title: 'Backup failed on BACKUP-03',
      message: 'Last successful backup 38 hours ago',
      severity: 'high',
      type: 'backup',
      deviceName: 'BACKUP-03 · Acme Corp',
      acknowledged: false,
      createdAt: new Date(Date.now() - 47 * 60_000).toISOString(),
      updatedAt: new Date(Date.now() - 47 * 60_000).toISOString(),
    },
  ];

  return (
    <View
      style={{
        backgroundColor: theme.bg1,
        borderRadius: radii.xl,
        borderWidth: 1,
        borderColor: theme.border,
        paddingVertical: spacing[5],
        marginHorizontal: spacing[2],
        overflow: 'hidden',
      }}
    >
      {/* Hero already pads horizontally by spacing[6]; the wrapping card
          adds visual containment without doubling padding. */}
      <View style={{ marginHorizontal: -spacing[6] + spacing[2] }}>
        <Hero
          copy="12 issues across 3 organizations."
          segments={{ healthy: 380, warning: 30, critical: 12 }}
          legend="380 online · 42 offline"
          loading={false}
        />
      </View>

      <View
        style={{
          marginTop: spacing[5],
          paddingTop: spacing[2],
          borderTopWidth: 1,
          borderTopColor: theme.border,
          marginHorizontal: -spacing[6] + spacing[2],
        }}
      >
        {issues.map((alert) => (
          <IssueRow key={alert.id} alert={alert} onPress={() => {}} />
        ))}
      </View>
    </View>
  );
}
